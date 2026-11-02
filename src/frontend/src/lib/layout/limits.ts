/**
 * Proposed format policy from ws-utils-caido-fmn section 8. These are chosen support and resource
 * limits, not measured performance. They become immutable when the spec is approved; a change needs
 * a new spec revision.
 */
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_JSON_DEPTH = 16;
export const MAX_FIELDS = 64;
export const MAX_TABLES = 64;
export const MAX_TABLE_ENTRIES = 4096;
export const MAX_LAYOUT_ENTRIES = 16_384;
/** Field names and table IDs, in UTF-16 code units (spec section 8). */
export const MAX_IDENTIFIER_LENGTH = 64;
/** Layout ID, in characters (also matched by the section 1 pattern). */
export const MAX_LAYOUT_ID_LENGTH = 48;
/** Display labels (layout name, field and record names, entry names), in characters (code points). */
export const MAX_LABEL_LENGTH = 80;
/** rejectPayload text, in characters (code points). */
export const MAX_REJECT_PAYLOAD_LENGTH = 200;
export const MAX_RECORD_TYPE = 255;
/** Derived, not a policy constant: the u8-escape-u16 length grammar tops out at a u16. */
export const MAX_RECORD_LENGTH = 65_535;
