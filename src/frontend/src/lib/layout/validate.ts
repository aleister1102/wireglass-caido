import { printParseErrorCode, visit, type JSONPath } from "jsonc-parser";
import {
  MAX_FIELDS,
  MAX_FILE_BYTES,
  MAX_IDENTIFIER_LENGTH,
  MAX_JSON_DEPTH,
  MAX_LABEL_LENGTH,
  MAX_LAYOUT_ENTRIES,
  MAX_LAYOUT_ID_LENGTH,
  MAX_RECORD_LENGTH,
  MAX_RECORD_TYPE,
  MAX_REJECT_PAYLOAD_LENGTH,
  MAX_TABLE_ENTRIES,
  MAX_TABLES,
} from "./limits";
import type {
  Endian,
  FieldDef,
  FieldType,
  Layout,
  LayoutIssue,
  LayoutValidation,
  LookupTable,
  PayloadDef,
  RecordDisplay,
  RecordsDef,
  RecordTypeDef,
} from "./types";

type Json = Record<string, unknown>;
type Path = readonly (string | number)[];

/** Strict JSON: comments and trailing commas are syntax errors. */
const STRICT = { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false };

const ROOT_KEYS = ["format", "id", "name", "version", "fields", "records", "payload", "tables"] as const;
const ROOT_REQUIRED = ["format", "id", "name", "version", "fields"] as const;
const FIELD_KEYS = ["name", "type", "endian", "expect", "lookup"] as const;
const RECORDS_KEYS = ["countField", "length", "types"] as const;
const RECORD_TYPE_KEYS = ["type", "name", "display", "length", "rejectPayload"] as const;
const PAYLOAD_KEYS = ["lengthField"] as const;
const TABLE_KEYS = ["id", "entries"] as const;
const ENTRY_KEYS = ["value", "name"] as const;

const FIELD_TYPES = ["u8", "u16", "u32", "i32"] as const;
const ENDIANS = ["be", "le"] as const;
const DISPLAYS = ["hex", "uuid", "uint"] as const;

/** Value ranges per field type. */
const RANGE: Record<FieldType, readonly [number, number]> = {
  u8: [0, 255],
  u16: [0, 65_535],
  u32: [0, 4_294_967_295],
  i32: [-2_147_483_648, 2_147_483_647],
};

/** Reserved layout IDs (spec section 1). A layout's mode is always layout:<id>. */
const RESERVED_LAYOUT_IDS = new Set(["auto", "raw", "json", "socketio", "lz4", "hex", "layout"]);
/** Names rejected for fields, lookup tables and record types (bead fmn.2 design: own-key safe names). */
const OWN_KEY_NAMES = new Set(["__proto__", "constructor", "toString"]);
/** Field names and table IDs (spec section 2 and 5). */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Layout ID (spec section 1); length is checked separately against MAX_LAYOUT_ID_LENGTH. */
const LAYOUT_ID = /^[a-z][a-z0-9-]*$/;

const encoder = new TextEncoder();

/** Thrown from a visitor callback to stop the strict scan at the first structural problem. */
class ScanStop {
  readonly issue: LayoutIssue;
  constructor(issue: LayoutIssue) {
    this.issue = issue;
  }
}

/** RFC 6901 JSON pointer. */
export function jsonPointer(path: Path): string {
  return path.map((segment) => "/" + String(segment).replace(/~/g, "~0").replace(/\//g, "~1")).join("");
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional<T>(object: Json, key: string, read: (value: unknown) => T | undefined): T | undefined {
  return hasOwn(object, key) ? read(object[key]) : undefined;
}

/** Size check by byte length, usable before reading (File.size). */
export function checkLayoutFileSize(size: number): LayoutIssue | null {
  if (size <= MAX_FILE_BYTES) return null;
  return { code: "file-too-large", pointer: "", message: `file is ${size} bytes; the limit is ${MAX_FILE_BYTES}` };
}

/** Strict UTF-8 decode of a layout file. Invalid bytes fail; a BOM is kept so that it fails JSON. */
export function decodeLayoutBytes(bytes: Uint8Array): { ok: true; text: string } | { ok: false; issue: LayoutIssue } {
  const tooLarge = checkLayoutFileSize(bytes.byteLength);
  if (tooLarge) return { ok: false, issue: tooLarge };
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { ok: false, issue: { code: "invalid-json", pointer: "", message: "file is not valid UTF-8" } };
  }
}

/** Validates layout file text. Evaluates no code and generates no schema at runtime. */
export function validateLayoutText(text: string): LayoutValidation {
  const tooLarge = checkLayoutFileSize(encoder.encode(text).byteLength);
  if (tooLarge) return { ok: false, issues: [tooLarge] };

  const structural = scanStructure(text);
  if (structural) return { ok: false, issues: [structural] };

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    return { ok: false, issues: [{ code: "invalid-json", pointer: "", message }] };
  }
  return validateRoot(root);
}

/** Syntax, duplicate keys and nesting depth in one jsonc pass; stops at the first problem. */
function scanStructure(text: string): LayoutIssue | null {
  // One entry per open container; objects hold their seen keys, arrays hold null.
  const open: Array<Set<string> | null> = [];
  const enter = (path: () => JSONPath) => {
    if (open.length >= MAX_JSON_DEPTH) {
      throw new ScanStop({
        code: "depth-exceeded",
        pointer: jsonPointer(path()),
        message: `JSON nesting is deeper than ${MAX_JSON_DEPTH} levels`,
      });
    }
  };
  try {
    visit(
      text,
      {
        onObjectBegin: (_offset, _length, _line, _column, path) => {
          enter(path);
          open.push(new Set<string>());
        },
        onObjectProperty: (property, offset, _length, _line, _column, path) => {
          const keys = open[open.length - 1];
          if (!keys) return;
          if (keys.has(property)) {
            throw new ScanStop({
              code: "duplicate-key",
              pointer: jsonPointer([...path(), property]),
              message: `duplicate key "${property}"`,
              offset,
            });
          }
          keys.add(property);
        },
        onObjectEnd: () => {
          open.pop();
        },
        onArrayBegin: (_offset, _length, _line, _column, path) => {
          enter(path);
          open.push(null);
        },
        onArrayEnd: () => {
          open.pop();
        },
        onError: (code, offset) => {
          throw new ScanStop({ code: "invalid-json", pointer: "", message: printParseErrorCode(code), offset });
        },
      },
      STRICT,
    );
  } catch (error) {
    if (error instanceof ScanStop) return error.issue;
    throw error;
  }
  return null;
}

/** Collects issues. Readers return undefined on failure; a layout is built only when no issue was recorded. */
class Checker {
  readonly issues: LayoutIssue[] = [];

  invalid(path: Path, message: string): void {
    this.issues.push({ code: "invalid-file", pointer: jsonPointer(path), message });
  }

  unknownKeys(object: Json, path: Path, allowed: readonly string[]): void {
    for (const key of Object.keys(object)) {
      if (!allowed.includes(key)) {
        this.issues.push({ code: "unknown-key", pointer: jsonPointer([...path, key]), message: `unknown key "${key}"` });
      }
    }
  }

  required(object: Json, path: Path, keys: readonly string[]): void {
    for (const key of keys) {
      if (!hasOwn(object, key)) this.invalid(path, `missing required key "${key}"`);
    }
  }

  get count(): number {
    return this.issues.length;
  }
}

function readInteger(
  c: Checker,
  value: unknown,
  path: Path,
  what: string,
  range?: readonly [number, number],
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    c.invalid(path, `${what} must be an integer`);
    return undefined;
  }
  if (range && (value < range[0] || value > range[1])) {
    c.invalid(path, `${what} must be from ${range[0]} to ${range[1]}`);
    return undefined;
  }
  return value;
}

function readOneOf<T extends string>(
  c: Checker,
  value: unknown,
  path: Path,
  options: readonly T[],
  what: string,
): T | undefined {
  if (typeof value === "string" && (options as readonly string[]).includes(value)) return value as T;
  c.invalid(path, `${what} must be one of ${options.join(", ")}`);
  return undefined;
}

/** Display text: 1 to max characters (code points). Control and bidi characters are accepted and escaped on display (epic section 8). */
function readText(c: Checker, value: unknown, path: Path, max: number, what: string): string | undefined {
  if (typeof value !== "string") {
    c.invalid(path, `${what} must be a string`);
    return undefined;
  }
  const length = [...value].length;
  if (length < 1 || length > max) {
    c.invalid(path, `${what} must be 1 to ${max} characters`);
    return undefined;
  }
  return value;
}

/** Own-key names: stored in Maps, but still rejected so no name can be mistaken for an object prototype key. */
function isOwnKeyName(value: string): boolean {
  return OWN_KEY_NAMES.has(value);
}

/** Field name, lookup reference or table ID: ASCII identifier of at most 64 UTF-16 code units. */
function readIdentifier(c: Checker, value: unknown, path: Path, what: string): string | undefined {
  if (typeof value !== "string" || value.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER.test(value)) {
    c.invalid(path, `${what} must match ^[A-Za-z][A-Za-z0-9_]* and be at most ${MAX_IDENTIFIER_LENGTH} characters`);
    return undefined;
  }
  if (isOwnKeyName(value)) {
    c.invalid(path, `${what} "${value}" is a reserved object key name`);
    return undefined;
  }
  return value;
}

function readLayoutId(c: Checker, value: unknown, path: Path): string | undefined {
  if (typeof value !== "string" || value.length > MAX_LAYOUT_ID_LENGTH || !LAYOUT_ID.test(value)) {
    c.invalid(path, `id must match ^[a-z][a-z0-9-]* and be at most ${MAX_LAYOUT_ID_LENGTH} characters`);
    return undefined;
  }
  if (RESERVED_LAYOUT_IDS.has(value)) {
    c.invalid(path, `id "${value}" is reserved`);
    return undefined;
  }
  return value;
}

function readFieldRef(
  c: Checker,
  value: unknown,
  path: Path,
  fields: ReadonlyMap<string, FieldDef>,
  allowed: readonly FieldType[],
  what: string,
): string | undefined {
  if (typeof value !== "string") {
    c.invalid(path, `${what} must name a field`);
    return undefined;
  }
  const field = fields.get(value);
  if (!field) {
    c.invalid(path, `${what} names no declared field "${value}"`);
    return undefined;
  }
  if (!allowed.includes(field.type)) {
    c.invalid(path, `${what} must name a ${allowed.join(", ")} field; "${value}" is ${field.type}`);
    return undefined;
  }
  return value;
}

function readField(c: Checker, item: unknown, path: Path, names: Set<string>): FieldDef | undefined {
  const before = c.count;
  if (!isObject(item)) {
    c.invalid(path, "field must be an object");
    return undefined;
  }
  c.unknownKeys(item, path, FIELD_KEYS);
  c.required(item, path, ["name", "type"]);

  const name = optional(item, "name", (value) => readIdentifier(c, value, [...path, "name"], "field name"));
  if (name !== undefined) {
    if (names.has(name)) c.invalid([...path, "name"], `duplicate field name "${name}"`);
    names.add(name);
  }
  const type = optional(item, "type", (value) => readOneOf(c, value, [...path, "type"], FIELD_TYPES, "type"));

  const hasEndian = hasOwn(item, "endian");
  if (type === "u8" && hasEndian) c.invalid([...path, "endian"], "endian is not allowed for u8");
  if (type !== undefined && type !== "u8" && !hasEndian) c.invalid(path, "endian is required for u16, u32 and i32");
  const endian = hasEndian ? readOneOf<Endian>(c, item["endian"], [...path, "endian"], ENDIANS, "endian") : undefined;

  const expect = hasOwn(item, "expect")
    ? readInteger(c, item["expect"], [...path, "expect"], "expect", type ? RANGE[type] : undefined)
    : undefined;
  const lookup = optional(item, "lookup", (value) => readIdentifier(c, value, [...path, "lookup"], "lookup table"));

  if (c.count !== before || name === undefined || type === undefined) return undefined;
  return { name, type, endian, expect, lookup };
}

/** One slot per declared field (undefined for a failed slot) so later issues keep their array index. */
function readFields(c: Checker, value: unknown, path: Path): (FieldDef | undefined)[] | undefined {
  if (!Array.isArray(value)) {
    c.invalid(path, "fields must be an array");
    return undefined;
  }
  if (value.length < 1 || value.length > MAX_FIELDS) {
    c.invalid(path, `fields must have 1 to ${MAX_FIELDS} items`);
    return undefined;
  }
  const names = new Set<string>();
  return value.map((item, index) => readField(c, item, [...path, index], names));
}

interface RawEntry {
  readonly value: number;
  readonly name: string;
  readonly index: number;
}

interface RawTable {
  readonly id: string;
  readonly index: number;
  readonly entries: readonly RawEntry[];
}

function readTables(c: Checker, value: unknown, path: Path): RawTable[] | undefined {
  if (!Array.isArray(value)) {
    c.invalid(path, "tables must be an array");
    return undefined;
  }
  if (value.length > MAX_TABLES) {
    c.invalid(path, `tables must have at most ${MAX_TABLES} items`);
    return undefined;
  }
  const ids = new Set<string>();
  const tables: RawTable[] = [];
  let totalEntries = 0;

  value.forEach((item, index) => {
    const tablePath = [...path, index];
    if (!isObject(item)) {
      c.invalid(tablePath, "table must be an object");
      return;
    }
    c.unknownKeys(item, tablePath, TABLE_KEYS);
    c.required(item, tablePath, TABLE_KEYS);

    const id = optional(item, "id", (raw) => readIdentifier(c, raw, [...tablePath, "id"], "table id"));
    if (id !== undefined) {
      if (ids.has(id)) c.invalid([...tablePath, "id"], `duplicate table id "${id}"`);
      ids.add(id);
    }
    const entries = optional(item, "entries", (raw) => readEntries(c, raw, [...tablePath, "entries"]));
    if (entries !== undefined) totalEntries += entries.length;
    if (id !== undefined && entries !== undefined) tables.push({ id, index, entries });
  });

  if (totalEntries > MAX_LAYOUT_ENTRIES) {
    c.invalid(path, `a layout may have at most ${MAX_LAYOUT_ENTRIES} lookup entries in total`);
  }
  return tables;
}

function readEntries(c: Checker, value: unknown, path: Path): RawEntry[] | undefined {
  if (!Array.isArray(value)) {
    c.invalid(path, "entries must be an array");
    return undefined;
  }
  if (value.length > MAX_TABLE_ENTRIES) {
    c.invalid(path, `a table may have at most ${MAX_TABLE_ENTRIES} entries`);
    return undefined;
  }
  const values = new Set<number>();
  const entries: RawEntry[] = [];
  value.forEach((item, index) => {
    const entryPath = [...path, index];
    if (!isObject(item)) {
      c.invalid(entryPath, "entry must be an object");
      return;
    }
    c.unknownKeys(item, entryPath, ENTRY_KEYS);
    c.required(item, entryPath, ENTRY_KEYS);
    const entryValue = optional(item, "value", (raw) => readInteger(c, raw, [...entryPath, "value"], "value"));
    if (entryValue !== undefined) {
      if (values.has(entryValue)) c.invalid([...entryPath, "value"], `duplicate lookup value ${entryValue}`);
      values.add(entryValue);
    }
    const name = optional(item, "name", (raw) =>
      readText(c, raw, [...entryPath, "name"], MAX_LABEL_LENGTH, "entry name"),
    );
    if (entryValue !== undefined && name !== undefined) entries.push({ value: entryValue, name, index });
  });
  return entries;
}

function readRecordType(c: Checker, item: unknown, path: Path, seen: Set<number>): RecordTypeDef | undefined {
  const before = c.count;
  if (!isObject(item)) {
    c.invalid(path, "record type must be an object");
    return undefined;
  }
  c.unknownKeys(item, path, RECORD_TYPE_KEYS);
  c.required(item, path, ["type", "name", "display"]);

  const type = optional(item, "type", (raw) =>
    readInteger(c, raw, [...path, "type"], "type", [0, MAX_RECORD_TYPE]),
  );
  if (type !== undefined) {
    if (seen.has(type)) c.invalid([...path, "type"], `duplicate record type ${type}`);
    seen.add(type);
  }
  const name = optional(item, "name", (raw) => readText(c, raw, [...path, "name"], MAX_LABEL_LENGTH, "record name"));
  if (name !== undefined && isOwnKeyName(name)) {
    c.invalid([...path, "name"], `record name "${name}" is a reserved object key name`);
  }
  const display = optional(item, "display", (raw) =>
    readOneOf<RecordDisplay>(c, raw, [...path, "display"], DISPLAYS, "display"),
  );
  const length = hasOwn(item, "length")
    ? readInteger(c, item["length"], [...path, "length"], "length", [0, MAX_RECORD_LENGTH])
    : undefined;

  if (display === "uuid") {
    if (!hasOwn(item, "length")) c.invalid(path, "display uuid requires length 16");
    else if (length !== undefined && length !== 16) c.invalid([...path, "length"], "display uuid requires length 16");
  }
  if (display === "uint") {
    if (!hasOwn(item, "length")) c.invalid(path, "display uint requires length 1 to 4");
    else if (length !== undefined && (length < 1 || length > 4)) {
      c.invalid([...path, "length"], "display uint requires length 1 to 4");
    }
  }
  const rejectPayload = hasOwn(item, "rejectPayload")
    ? readText(c, item["rejectPayload"], [...path, "rejectPayload"], MAX_REJECT_PAYLOAD_LENGTH, "rejectPayload")
    : undefined;

  if (c.count !== before || type === undefined || name === undefined || display === undefined) return undefined;
  return { type, name, display, length, rejectPayload };
}

function readRecordTypes(c: Checker, value: unknown, path: Path): RecordTypeDef[] | undefined {
  if (!Array.isArray(value)) {
    c.invalid(path, "types must be an array");
    return undefined;
  }
  const seen = new Set<number>();
  const defs = value.map((item, index) => readRecordType(c, item, [...path, index], seen));
  const out: RecordTypeDef[] = [];
  for (const def of defs) if (def) out.push(def);
  return out.length === defs.length ? out : undefined;
}

function readRecords(
  c: Checker,
  value: unknown,
  path: Path,
  fields: ReadonlyMap<string, FieldDef>,
): RecordsDef | undefined {
  const before = c.count;
  if (!isObject(value)) {
    c.invalid(path, "records must be an object");
    return undefined;
  }
  c.unknownKeys(value, path, RECORDS_KEYS);
  c.required(value, path, RECORDS_KEYS);

  const countField = optional(value, "countField", (raw) =>
    readFieldRef(c, raw, [...path, "countField"], fields, ["u8", "u16", "u32"], "countField"),
  );
  if (hasOwn(value, "length") && value["length"] !== "u8-escape-u16") {
    c.invalid([...path, "length"], 'length must be "u8-escape-u16"');
  }
  const types = optional(value, "types", (raw) => readRecordTypes(c, raw, [...path, "types"]));

  if (c.count !== before || countField === undefined || types === undefined) return undefined;
  return {
    countField,
    length: "u8-escape-u16",
    types: new Map(types.map((type) => [type.type, type] as const)),
  };
}

function readPayload(
  c: Checker,
  value: unknown,
  path: Path,
  fields: ReadonlyMap<string, FieldDef>,
): PayloadDef | undefined {
  const before = c.count;
  if (!isObject(value)) {
    c.invalid(path, "payload must be an object");
    return undefined;
  }
  c.unknownKeys(value, path, PAYLOAD_KEYS);
  c.required(value, path, PAYLOAD_KEYS);
  const lengthField = optional(value, "lengthField", (raw) =>
    readFieldRef(c, raw, [...path, "lengthField"], fields, ["u32"], "lengthField"),
  );
  if (c.count !== before || lengthField === undefined) return undefined;
  return { lengthField };
}

/** Each lookup must name an existing table, and every entry must fit the range of each field that uses it. */
function checkLookups(
  c: Checker,
  fields: readonly (FieldDef | undefined)[],
  tables: readonly RawTable[],
): void {
  const byId = new Map(tables.map((table) => [table.id, table] as const));
  fields.forEach((field, fieldIndex) => {
    if (!field || field.lookup === undefined) return;
    const table = byId.get(field.lookup);
    if (!table) {
      c.invalid(["fields", fieldIndex, "lookup"], `no table with id "${field.lookup}"`);
      return;
    }
    const [low, high] = RANGE[field.type];
    for (const entry of table.entries) {
      if (entry.value < low || entry.value > high) {
        c.invalid(
          ["tables", table.index, "entries", entry.index, "value"],
          `value ${entry.value} is outside ${field.type}, the range of field "${field.name}"`,
        );
      }
    }
  });
}

function validateRoot(root: unknown): LayoutValidation {
  if (!isObject(root)) {
    return { ok: false, issues: [{ code: "invalid-file", pointer: "", message: "layout must be a JSON object" }] };
  }
  const c = new Checker();
  c.unknownKeys(root, [], ROOT_KEYS);
  c.required(root, [], ROOT_REQUIRED);

  let formatOk = false;
  if (hasOwn(root, "format")) {
    if (root["format"] === 1) formatOk = true;
    else c.invalid(["format"], "format must be 1");
  }
  const id = optional(root, "id", (raw) => readLayoutId(c, raw, ["id"]));
  const name = optional(root, "name", (raw) => readText(c, raw, ["name"], MAX_LABEL_LENGTH, "name"));
  const version = optional(root, "version", (raw) =>
    readInteger(c, raw, ["version"], "version", [1, Number.MAX_SAFE_INTEGER]),
  );
  const fieldSlots = optional(root, "fields", (raw) => readFields(c, raw, ["fields"]));

  const fieldsByName = new Map<string, FieldDef>();
  for (const field of fieldSlots ?? []) if (field) fieldsByName.set(field.name, field);

  const tables = hasOwn(root, "tables") ? optional(root, "tables", (raw) => readTables(c, raw, ["tables"])) : [];
  const records = optional(root, "records", (raw) => readRecords(c, raw, ["records"], fieldsByName));
  const payload = optional(root, "payload", (raw) => readPayload(c, raw, ["payload"], fieldsByName));

  if (fieldSlots && tables) checkLookups(c, fieldSlots, tables);

  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  if (!formatOk || id === undefined || name === undefined || version === undefined || !fieldSlots || !tables) {
    return { ok: false, issues: [{ code: "invalid-file", pointer: "", message: "layout is incomplete" }] };
  }

  const fields = fieldSlots.filter((field): field is FieldDef => field !== undefined);
  const layoutTables = new Map<string, LookupTable>(
    tables.map((table) => [
      table.id,
      { id: table.id, entries: new Map(table.entries.map((entry) => [entry.value, entry.name] as const)) },
    ] as const),
  );
  const layout: Layout = {
    format: 1,
    id,
    name,
    version,
    fields,
    fieldsByName,
    records,
    payload,
    tables: layoutTables,
  };
  return { ok: true, layout };
}
