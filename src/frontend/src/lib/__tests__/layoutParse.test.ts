// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLayoutFrame } from "../layout/parse";
import { validateLayoutText } from "../layout/validate";
import type { Layout } from "../layout/types";

// Bytes are built from the epic's hex segments. `z(n)` is n zero bytes.
const h = (hex: string) => Uint8Array.from(hex.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? []);
const z = (n: number) => new Uint8Array(n);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const UUID_RECORD = cat(h("0010"), z(16));
const JSON_BODY = h("7b226e756d6265724f66506f70756c6172223a357d");

// P1: header, one uuid record, no payload.
const P1 = cat(h("435001" + "00348172" + "00000000" + "00000001" + "01"), UUID_RECORD);
// P2: header with payloadLength 21, one uuid record, a JSON payload.
const P2 = cat(h("435001" + "f50a9c87" + "00000015" + "00000002" + "01"), UUID_RECORD, JSON_BODY);
// E1: record 6 is a reject record; the frame carries 4 undecodable payload bytes.
const E1 = cat(h("435001" + "00348172" + "00000004" + "00000001" + "02"), UUID_RECORD, h("060100"), h("fffefdfc"));
// E2: record 13 with an escaped 256-byte length; payloadLength 0.
const E2 = cat(
  h("435001" + "00348172" + "00000000" + "00000001" + "04"),
  UUID_RECORD,
  h("060100"),
  h("0c00"),
  h("0dff0100"),
  z(256),
);

function loadExample(): Layout {
  const url = new URL("../../../../../examples/layouts/capitalcom-cp.layout.json", import.meta.url);
  const result = validateLayoutText(readFileSync(url, "utf8"));
  if (!result.ok) throw new Error("example layout does not validate");
  return result.layout;
}

const layout = loadExample();
const HEADER_TLV1 = h("435001" + "00348172" + "00000000" + "00000001" + "01");

describe("parseLayoutFrame fixtures", () => {
  it("parses P1 with a uuid record and no payload", () => {
    const result = parseLayoutFrame(layout, P1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.header.map((field) => field.name)).toEqual([
      "magic",
      "version",
      "destination",
      "payloadLength",
      "correlationId",
      "tlvCount",
    ]);
    expect(result.frame.records).toEqual([
      expect.objectContaining({ index: 0, offset: 16, type: 0, name: "request uuid", display: "uuid", length: 16 }),
    ]);
    expect(result.frame.payloadLength).toBe(0);
    expect(result.frame.payload).toBeUndefined();
  });

  it("parses P2 and keeps the JSON payload kind from the parsed value", () => {
    const result = parseLayoutFrame(layout, P2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.payload).toEqual({ text: '{"numberOfPopular":5}', value: { numberOfPopular: 5 }, kind: "object" });
    expect(result.frame.header.find((field) => field.name === "destination")?.display).toContain("country.getAll.v2");
  });

  it("rejects E1 at the reject record before reading its payload as text", () => {
    expect(parseLayoutFrame(layout, E1)).toEqual({
      ok: false,
      error: { code: "reject-record", byteOffset: 34, message: expect.stringContaining("Encrypted request (record 6)") },
    });
  });

  it("rejects E2 at its first reject record (record 6); record 13 is later", () => {
    expect(parseLayoutFrame(layout, E2)).toEqual({
      ok: false,
      error: { code: "reject-record", byteOffset: 34, message: expect.stringContaining("record 6") },
    });
  });
});

describe("parseLayoutFrame error classes", () => {
  it("reports a short header with the offset where the next field starts", () => {
    expect(parseLayoutFrame(layout, P1.slice(0, 5))).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "short-frame", byteOffset: 3 }),
    });
  });

  it("reports a record length escape that is not canonical", () => {
    const frame = cat(HEADER_TLV1, h("00ff000a"), z(10));
    expect(parseLayoutFrame(layout, frame)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "noncanonical-length", byteOffset: 17 }),
    });
  });

  it("reports a uuid record with the wrong length", () => {
    const frame = cat(HEADER_TLV1, h("000f"), z(15));
    expect(parseLayoutFrame(layout, frame)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "uuid-length", byteOffset: 16 }),
    });
  });

  it("reports a fixed-length record that declares a different length", () => {
    const frame = cat(HEADER_TLV1, h("060200"), z(2));
    expect(parseLayoutFrame(layout, frame)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "record-length", byteOffset: 16 }),
    });
  });

  it("reports a fixed field whose expected value does not match", () => {
    const bad = Uint8Array.from(P1);
    bad[2] = 0x51;
    expect(parseLayoutFrame(layout, bad)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "expect-mismatch", byteOffset: 2 }),
    });
  });

  it("reports a payload that declares more bytes than remain", () => {
    const frame = h("435001" + "00348172" + "00000009" + "00000001" + "00");
    expect(parseLayoutFrame(layout, frame)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "payload-length", byteOffset: 16 }),
    });
  });

  it("reports bytes that follow the declared payload", () => {
    const frame = cat(h("435001" + "00348172" + "00000001" + "00000001" + "00"), h("7b7d"));
    expect(parseLayoutFrame(layout, frame)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "trailing-bytes", byteOffset: 17 }),
    });
  });

  it("reports invalid UTF-8 in the payload at the first bad byte", () => {
    const frame = cat(h("435001" + "00348172" + "00000002" + "00000001" + "00"), h("41ff"));
    expect(parseLayoutFrame(layout, frame)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid-json", byteOffset: 17 }),
    });
  });

  it("reports invalid JSON with a byte offset inside the original frame", () => {
    const frame = cat(h("435001" + "00348172" + "00000003" + "00000001" + "00"), h("7b7d7b"));
    const result = parseLayoutFrame(layout, frame);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid-json");
    expect(result.error.byteOffset).toBeGreaterThanOrEqual(16);
    expect(result.error.byteOffset).toBeLessThanOrEqual(frame.length);
  });
});
