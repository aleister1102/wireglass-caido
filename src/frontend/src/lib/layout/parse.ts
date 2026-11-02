import { kindOf, validateJson, type JsonKind } from "../json";
import type { FieldDef, Layout, RecordDisplay } from "./types";

export type LayoutErrorCode =
  | "short-frame"
  | "noncanonical-length"
  | "uuid-length"
  | "record-length"
  | "payload-length"
  | "expect-mismatch"
  | "trailing-bytes"
  | "reject-record"
  | "invalid-json";

/** `byteOffset` is a position in the original frame bytes, never a text index. */
export type LayoutFrameError = { code: LayoutErrorCode; message: string; byteOffset: number };

export type FieldFact = { name: string; offset: number; length: number; value: number; display: string };

export type RecordFact = {
  index: number;
  offset: number;
  type: number;
  name?: string;
  display: RecordDisplay;
  length: number;
  text: string;
};

export type LayoutFrame = {
  header: FieldFact[];
  records: RecordFact[];
  payloadLength: number;
  payload?: { text: string; value: unknown; kind: JsonKind };
};

export type LayoutFrameResult = { ok: true; frame: LayoutFrame } | { ok: false; error: LayoutFrameError };

class Failure {
  constructor(readonly error: LayoutFrameError) {}
}

function fail(code: LayoutErrorCode, byteOffset: number, message: string): never {
  throw new Failure({ code, byteOffset, message });
}

const SIZE: Record<FieldDef["type"], number> = { u8: 1, u16: 2, u32: 4, i32: 4 };

/** Parses the exact frame bytes in the order of epic section 6. Structure errors come before payload text. */
export function parseLayoutFrame(layout: Layout, bytes: Uint8Array): LayoutFrameResult {
  try {
    return { ok: true, frame: parseFrame(layout, bytes) };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, error: error.error };
    throw error;
  }
}

function parseFrame(layout: Layout, bytes: Uint8Array): LayoutFrame {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const take = (n: number, what: string): number => {
    const remaining = bytes.length - pos;
    if (n > remaining) fail("short-frame", pos, `${what} needs ${n} byte(s); ${remaining} remain`);
    const start = pos;
    pos += n;
    return start;
  };

  // Step 1: fields. Expect mismatches are remembered and raised in step 3.
  const values = new Map<string, number>();
  const header: FieldFact[] = [];
  let expectFailure: LayoutFrameError | undefined;
  for (const field of layout.fields) {
    const length = SIZE[field.type];
    const start = take(length, `field ${field.name}`);
    const value = readField(view, start, field);
    values.set(field.name, value);
    const display = displayField(layout, field, value, length);
    header.push({ name: field.name, offset: start, length, value, display });
    if (field.expect !== undefined && value !== field.expect && expectFailure === undefined) {
      expectFailure = { code: "expect-mismatch", byteOffset: start, message: `${field.name} expected ${field.expect}, found ${display}` };
    }
  }

  // Steps 1-2: records, with the grammar checked per record.
  const records: RecordFact[] = [];
  let reject: LayoutFrameError | undefined;
  if (layout.records) {
    const count = values.get(layout.records.countField) ?? 0;
    for (let index = 0; index < count; index++) {
      const start = take(1, `record ${index} type`);
      const type = view.getUint8(start);
      const lengthAt = take(1, `record ${index} length`);
      let length = view.getUint8(lengthAt);
      if (length === 255) {
        const escaped = take(2, `record ${index} escaped length`);
        length = view.getUint16(escaped, false);
        if (length < 255) fail("noncanonical-length", lengthAt, `record ${index} uses the escape for length ${length}, below 255`);
      }
      const valueStart = take(length, `record ${index} value`);
      const value = bytes.subarray(valueStart, valueStart + length);
      const def = layout.records.types.get(type);
      if (def?.display === "uuid" && length !== 16) fail("uuid-length", start, `record ${index} (${def.name}) is ${length} byte(s); uuid needs 16`);
      if (def?.length !== undefined && length !== def.length) {
        fail("record-length", start, `record ${index} (${def.name}) is ${length} byte(s); the layout declares ${def.length}`);
      }
      if (def?.rejectPayload !== undefined && reject === undefined) {
        reject = { code: "reject-record", byteOffset: start, message: def.rejectPayload };
      }
      const display = def?.display ?? "hex";
      records.push({ index, offset: start, type, name: def?.name, display, length, text: displayRecord(display, value) });
    }
  }

  // Step 3: the payload must fit, then expect mismatches are reported.
  const declared = layout.payload ? (values.get(layout.payload.lengthField) ?? 0) : 0;
  const remaining = bytes.length - pos;
  if (declared > remaining) fail("payload-length", pos, `payload declares ${declared} byte(s); ${remaining} remain`);
  if (expectFailure) throw new Failure(expectFailure);

  // Step 4: nothing may follow the payload.
  const payloadStart = pos;
  const end = pos + declared;
  if (end !== bytes.length) fail("trailing-bytes", end, `${bytes.length - end} byte(s) follow the payload`);

  // Step 5: reject records stop the frame before its payload text is read.
  if (reject) throw new Failure(reject);

  // Step 6: strict UTF-8, then JSON.
  if (declared === 0) return { header, records, payloadLength: 0 };
  const body = bytes.subarray(payloadStart, end);
  const invalid = firstInvalidUtf8(body);
  if (invalid >= 0) fail("invalid-json", payloadStart + invalid, "The payload is not valid UTF-8");
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
  const validation = validateJson(text);
  if (!validation.ok) {
    fail("invalid-json", payloadStart + utf8Length(text.slice(0, validation.offset)), validation.message);
  }
  return { header, records, payloadLength: declared, payload: { text, value: validation.value, kind: kindOf(validation.value) } };
}

function readField(view: DataView, at: number, field: FieldDef): number {
  const little = field.endian === "le";
  switch (field.type) {
    case "u8":
      return view.getUint8(at);
    case "u16":
      return view.getUint16(at, little);
    case "u32":
      return view.getUint32(at, little);
    case "i32":
      return view.getInt32(at, little);
  }
}

/** Decimal, then the unsigned bytes in hex; a lookup hit adds the table's name in front. */
function displayField(layout: Layout, field: FieldDef, value: number, length: number): string {
  const unsigned = value < 0 ? value + 2 ** 32 : value;
  const hex = `0x${unsigned.toString(16).padStart(length * 2, "0")}`;
  const name = field.lookup === undefined ? undefined : layout.tables.get(field.lookup)?.entries.get(value);
  return name === undefined ? `${value} (${hex})` : `${name} (${value}, ${hex})`;
}

function displayRecord(display: RecordDisplay, value: Uint8Array): string {
  const hex = Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
  if (display === "uuid") return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  if (display === "uint") {
    let n = 0;
    for (const b of value) n = n * 256 + b;
    return `${n} (0x${hex})`;
  }
  return hex;
}

/** Index of the first byte that starts an invalid UTF-8 sequence, or -1 when the bytes are valid. */
function firstInvalidUtf8(b: Uint8Array): number {
  let i = 0;
  while (i < b.length) {
    const lead = b[i] ?? 0;
    if (lead < 0x80) {
      i++;
      continue;
    }
    const extra = lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : -1;
    if (extra < 0) return i;
    let cp = lead & (0x3f >> extra);
    for (let k = 1; k <= extra; k++) {
      const next = b[i + k];
      if (next === undefined || (next & 0xc0) !== 0x80) return i;
      cp = cp * 64 + (next & 0x3f);
    }
    const min = extra === 1 ? 0x80 : extra === 2 ? 0x800 : 0x10000;
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += extra + 1;
  }
  return -1;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
