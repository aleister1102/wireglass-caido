# Layout file format (v1)

Developer note. User steps are in the wiki (Layout add-ons). The code is in `src/frontend/src/lib/layout/`: `validate.ts` checks the file, `parse.ts` reads frames and formats fields for display, `limits.ts` holds the caps, and `catalog.ts` stores installed layouts.

A layout file is JSON that describes one binary frame format. Wireglass reads the file as data. It runs no code from it and decrypts nothing.

## Top-level keys

Only these keys are allowed. Unknown keys and duplicate keys are rejected.

| Key | Required | Notes |
|---|---|---|
| `format` | yes | Must be `1`. |
| `id` | yes | Layout ID: `^[a-z][a-z0-9-]*$`, at most 48 characters. |
| `name` | yes | Label, at most 80 characters. |
| `version` | yes | Integer, at least 1. |
| `fields` | yes | Read in order from byte 0. |
| `records` | no | Record section. Without it, the frame has no records. |
| `payload` | no | Names the payload length field. Without it, the frame has no payload. |
| `tables` | no | Lookup tables. |

The IDs `auto`, `raw`, `json`, `socketio`, `lz4`, `hex`, and `layout` are reserved. The names `__proto__`, `constructor`, and `toString` are reserved for fields, lookup tables, and record types.

## Fields

Each field has:

- `name`: identifier `^[A-Za-z][A-Za-z0-9_]*`, at most 64 UTF-16 code units.
- `type`: `u8`, `u16`, `u32`, or `i32`.
- `endian`: `be` or `le`. Required for `u16`, `u32`, and `i32`. Not allowed for `u8`.
- `expect` (optional): integer the field must equal. Must fit the field's range.
- `lookup` (optional): ID of a table in `tables`.

A layout has at most 64 fields.

## Records

`records` has:

- `countField`: name of the field that holds the record count. Type `u8`, `u16`, or `u32`.
- `length`: must be `"u8-escape-u16"`.
- `types`: list of record types.

Each record on the wire is:

1. `type`: one byte.
2. `length`: one byte. If the byte is `255`, the next two bytes (big-endian) hold the length. A length below 255 that uses the escape is `noncanonical-length`.
3. `value`: `length` bytes.

Each entry in `types` has:

- `type`: integer 0 to 255. Each type appears once.
- `name`: optional label, at most 80 characters.
- `display`: `hex`, `uuid`, or `uint`. Default `hex`.
- `length`: optional. Required for `uuid` (must be 16) and `uint` (1 to 4). When set, the record value must have exactly this length.
- `rejectPayload`: optional text, at most 200 characters.

## Payload

`payload.lengthField` names a field that holds the payload byte count. The field must be `u32`. The payload is the bytes after the fields and records. A payload length of 0 gives no payload text. Otherwise the bytes must be UTF-8 JSON. The payload must end the frame: extra bytes are a `trailing-bytes` error.

## Lookup tables

`tables` is a list of `{ id, entries }`. Each entry is `{ value, name }`.

- Table IDs use the identifier rule and are unique.
- Values are unique within one table.
- A table has at most 4096 entries. A layout has at most 16384 entries in total across all tables.
- A layout has at most 64 tables.
- Every entry value must fit the range of each field that uses the table.

## Display

- `hex`: lowercase hex, no prefix.
- `uuid`: lowercase hex in 8-4-4-4-12 groups.
- `uint`: unsigned value shown as `n (0xhex)`.
- Unknown record type: lowercase hex.
- Field with a lookup: a hit shows `name (value, 0xhex)`. A miss shows `value (0xhex)`. Fields without a lookup show the value and its hex.

## Limits

| Limit | Value |
|---|---|
| File size | 1,048,576 bytes |
| JSON nesting depth | 16 |
| Fields per layout | 64 |
| Tables per layout | 64 |
| Entries per table | 4096 |
| Entries per layout | 16384 |
| Field, record, and table IDs and field names | 64 UTF-16 code units |
| Layout ID | 48 characters |
| Labels (layout name, record name, table entry name) | 80 characters |
| `rejectPayload` | 200 characters |
| Record type | 0 to 255 |
| Record value length | at most 65535 bytes |

## Parse order

`parse.ts` checks a frame in this order. The first failure stops the frame.

1. **Fields and records.** Read the fixed fields. Read the record count from `countField`. For each record, read the type and length, then the value. Check canonical length, UUID length, and the declared record length. Note the first record whose type has `rejectPayload`.
2. **Payload fit.** The declared payload length must fit the bytes that remain (`payload-length`).
3. **Expect.** Each field with `expect` must match (`expect-mismatch`).
4. **Trailing bytes.** No bytes may follow the payload (`trailing-bytes`).
5. **Reject record.** If step 1 noted a record with `rejectPayload`, stop with that text (`reject-record`). The payload text is not read.
6. **Payload text.** If the payload length is above 0, decode it as strict UTF-8, then parse it as JSON (`invalid-json`).

Step 2 runs before step 3, and step 5 runs after steps 2 to 4. A frame with a reject record and a bad payload length reports the length error.

## Error classes

Frame errors (`parse.ts`):

| Code | Meaning |
|---|---|
| `short-frame` | The frame ends before a field or record is complete. |
| `noncanonical-length` | A record length below 255 uses the 255 escape. |
| `uuid-length` | A UUID record is not 16 bytes. |
| `record-length` | A record's length does not match its declared `length`. |
| `payload-length` | The payload length does not fit the frame. |
| `expect-mismatch` | A field with `expect` has another value. |
| `trailing-bytes` | Bytes follow the payload. |
| `reject-record` | A record with `rejectPayload` is present. The text is the message. |
| `invalid-json` | The payload is not strict UTF-8 JSON. |

Each frame error carries the byte offset where it was found. The footer shows it as `<message> at byte N`.

`record-length` is in the code. The design note for the epic does not list it in its error section.

File errors (`validate.ts`): `file-too-large`, `invalid-json`, `duplicate-key`, `depth-exceeded`, `unknown-key`, and `invalid-file`. Each names the JSON path of the item. A file with any error is not installed, and the installed catalog does not change.

## Field references

`records.countField` and `payload.lengthField` each name a declared field of the allowed type. The records and payload come after all fields in the frame, so the named field is always read first. An unknown name, or a field of the wrong type, is rejected at its JSON path.

## Example: Capital.com CP header

`examples/layouts/capitalcom-cp.layout.json` describes a CP header. It is built from synthetic fixtures and is not a capture of live traffic.

- Fields: `magic` (`u16` big-endian, expect `17232`), `version` (`u8`, expect `1`), `destination` (`i32` big-endian, lookup `cp_destinations`), `payloadLength` (`u32` big-endian), `correlationId` (`u32` big-endian), `tlvCount` (`u8`).
- Records: count from `tlvCount`, `u8-escape-u16` lengths. Type `0` is a 16-byte UUID named "request uuid". Type `6` ("encryption", length 1) and type `13` ("encryptedAesKey") carry `rejectPayload` text. A frame with either record stops with that text, and its payload is not read.
- Payload: length from `payloadLength`.
- Table `cp_destinations` maps four values to names: `ping` (3441010), `country.getAll.v2` (-183853945), `global.settings` (1092358670), and `static.config.get` (-1760482774).

This note does not claim the direction of any CP message.
