# WebSocket inspection

Terms for understanding captured WebSocket traffic in Caido.

## Language

**Captured message**:
The message content and metadata recorded by Caido for a WebSocket connection.

**Original**:
The captured message content before any decoding, formatting, or querying.
_Avoid_: Repaired original

**Protocol envelope**:
The protocol-defined framing and routing information surrounding a payload, such as a Socket.IO packet type and namespace.

**Payload**:
The data carried inside a protocol envelope, or the complete message content when no envelope is present. A Socket.IO event payload includes the event name and all arguments.

**Decoder mode**:
The selected rule for interpreting message content: Auto, Raw, JSON, Socket.IO, LZ4 block (BE size), or an installed layout (`layout:<id>`).

**Layout add-on**:
A JSON file that describes one binary frame format. Wireglass reads it as data and runs no code from it. After you install it in Caido settings, its layout appears in the Decoder menu.
_Avoid_: Script, plugin

**Layout**:
The definition inside a layout add-on: its fields, records, payload, and tables. Each installed layout has an ID, a name, and a version.

**Layout catalog**:
The installed layouts, kept in Caido's plugin storage. Export saves them to `wireglass-layouts.json`. Import adds them, or replaces entries with the same ID.

**Reject payload**:
Text in a layout record that stops a frame before its payload is read. Wireglass shows the text as the error and does not decrypt.

**View preset**:
A combined formatting and line-layout choice: Original, Wrapped original, Pretty JSON, Compact JSON, or Hex.

**Query result**:
The output produced by running jq against a decoded JSON payload, separate from the captured message.
