/** C0, DEL, C1, ALM, ZWSP..RLM, bidi embeddings and overrides, isolates (epic section 8 list). */
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** Layout text is shown as text only; control and bidi characters appear as \u{XXXX} escapes. */
export function escapeLayoutText(value: string): string {
  return value.replace(CONTROL_OR_BIDI, (ch) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}
