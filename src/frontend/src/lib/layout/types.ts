/** Layout file format v1 (ws-utils-caido-fmn sections 1-5). Shapes are validated by validateLayoutText. */

export type FieldType = "u8" | "u16" | "u32" | "i32";
export type Endian = "be" | "le";
export type RecordDisplay = "hex" | "uuid" | "uint";

export interface FieldDef {
  readonly name: string;
  readonly type: FieldType;
  /** Required for u16, u32 and i32; forbidden for u8. */
  readonly endian?: Endian;
  /** Exact expected value; a mismatch is an expect-mismatch decode error, never a guess. */
  readonly expect?: number;
  /** Name of a table in Layout.tables. */
  readonly lookup?: string;
}

export interface LookupTable {
  readonly id: string;
  /** Keyed by the integer value (prototype-safe). The stored string is the display name. */
  readonly entries: ReadonlyMap<number, string>;
}

export interface RecordTypeDef {
  /** Record type byte, 0-255. */
  readonly type: number;
  readonly name: string;
  readonly display: RecordDisplay;
  readonly length?: number;
  readonly rejectPayload?: string;
}

export interface RecordsDef {
  /** Name of an earlier unsigned field (u8, u16 or u32) whose value is the record count. */
  readonly countField: string;
  readonly length: "u8-escape-u16";
  /** Keyed by record type byte (prototype-safe). Record types not declared here are shown as hex, not errors. */
  readonly types: ReadonlyMap<number, RecordTypeDef>;
}

export interface PayloadDef {
  /** Name of a u32 field whose value is the payload length in bytes. */
  readonly lengthField: string;
}

export interface Layout {
  readonly format: 1;
  readonly id: string;
  readonly name: string;
  /** The layout's own revision; separate from format. */
  readonly version: number;
  readonly fields: readonly FieldDef[];
  /** Keyed by field name (prototype-safe). */
  readonly fieldsByName: ReadonlyMap<string, FieldDef>;
  readonly records?: RecordsDef;
  readonly payload?: PayloadDef;
  /** Keyed by table ID (prototype-safe). */
  readonly tables: ReadonlyMap<string, LookupTable>;
}

export type LayoutIssueCode =
  | "file-too-large"
  | "invalid-json"
  | "duplicate-key"
  | "depth-exceeded"
  | "unknown-key"
  | "invalid-file";

export interface LayoutIssue {
  readonly code: LayoutIssueCode;
  /** RFC 6901 JSON pointer to the failing item; "" for the whole file. */
  readonly pointer: string;
  readonly message: string;
  /** UTF-16 index into the text, for syntax errors only. */
  readonly offset?: number;
}

export type LayoutValidation = { readonly ok: true; readonly layout: Layout } | { readonly ok: false; readonly issues: readonly LayoutIssue[] };
