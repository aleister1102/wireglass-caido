# WebSocket extension feasibility: Caido and Burp (research)

Status: research only. No code, builds, tests, or commits.
Scope: a read-only, inspection-only WebSocket viewer. v1 targets Socket.IO; this revision also evaluates other WebSocket framings and narrows the adapter roadmap.

## 1. Constraints (from Main)

- v1 is inspection-only. Raw bytes are never modified; no silent repairs.
- Views are combined presets (e.g. "Raw", "Socket.IO decoded"), not independent wrap/format toggles.

## 2. Live observation (Main's report, not verified here)

Main reported the headless browser at `http://127.0.0.1:8080` shows Caido footer v0.59.0 with a "WS History" nav label. I did not drive the browser. Public WS History docs: https://docs.caido.io/app/quickstart/ws_history.html

## 3. Caido: API availability (typings at tag v0.59.0)

Method: shallow clone of `caido/sdk-js`, tag `v0.59.0` = commit `da6c666d0b69d3e40e6211d5bdfadaed07d95d2d`. Permalinks below use that tag. Only typings were read; runtime behavior is unprobed.

| Capability | Typed surface (permalink) | Notes |
|---|---|---|
| Custom WS message view mode | `sdk.websocket.addMessageViewMode(options)` ([sdks/websocket.d.ts#L6-L12](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/sdks/websocket.d.ts#L6-L12); exposed as `websocket` in [sdks/index.d.ts#L187-L189](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/sdks/index.d.ts#L187-L189)) | `when?(message)` runs per message ([types/websocket.d.ts#L42-L55](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/types/websocket.d.ts#L42-L55)). |
| Replay WS view mode | `sdk.replay.addWebsocketMessageViewMode(options)` ([sdks/replay.d.ts#L187-L190](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/sdks/replay.d.ts#L187-L190)) | Same options type. |
| Message metadata given to `when` | `StreamWsMessageMeta` = `{id, streamId, head{id, length, direction: "CLIENT"\|"SERVER", format: "BINARY"\|"CLOSE"\|"PING"\|"PONG"\|"TEXT", createdAt}}` ([types/websocket.d.ts#L14-L24](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/types/websocket.d.ts#L14-L24)) | **No payload.** `when` can gate only on `format`, `direction`, `length`, and time. |
| View props | `MessageViewModePropsInternal = {message: StreamWsMessageMeta, view: EditorView}` ([types/websocket.d.ts#L29-L32](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/types/websocket.d.ts#L29-L32)) | Typing does not say what text `view` holds for a message. Unverified. |
| Full payload (GraphQL) | `QueryRoot.streamWsMessageEdit` / `streamWsMessage` ([graphql-sdk.d.ts#L3244-L3247](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/__generated__/graphql-sdk.d.ts#L3244-L3247)); `StreamWsMessageEdit.raw: Blob` ([#L4425-L4433](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/__generated__/graphql-sdk.d.ts#L4425-L4433)) | A fetch is available. Whether it is needed depends on what `view` already shows (see §7). |
| WS selection | No selection field in `WebsocketPageContext` ([types/websocket.d.ts#L7-L9](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/types/websocket.d.ts#L7-L9)); `sdk.websocket` exposes only `addMessageViewMode` ([sdks/websocket.d.ts#L6-L12](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/sdks/websocket.d.ts#L6-L12)) | Whether a view receives the selected message or every row is unverified. |
| WS send | `sendReplayTaskMessage` mutation ([graphql-sdk.d.ts#L2300](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/__generated__/graphql-sdk.d.ts#L2300), input at [#L4095-L4104](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/__generated__/graphql-sdk.d.ts#L4095-L4104)) | Replay tasks only. v1 would not call it. |
| Backend WS hooks | Backend typings expose HTTP `onUpstream` only ([sdk-backend/src/typing.d.ts#L264-L268](https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-backend/src/typing.d.ts#L264-L268)) | No WS event hook found in typings. |
| Menus | No WS row/context menu type found in `types/menu.d.ts` | Unverified beyond typings. |

Version history (SDK package versions from `git tag --contains`, not app release numbers): `addMessageViewMode` introduced in `8aa95d7` (v0.55.4-beta.2); `addWebsocketMessageViewMode` in `9798e3e` (v0.57.1-beta.14). All are in the v0.59.0 typings.

Public docs lag the typings: the WebSocket reference page documents only `WebsocketPageContext` (https://developer.caido.io/plugins/reference/sdks/frontend/websockets.html); the view-mode guide covers HTTP only (https://developer.caido.io/plugins/guides/view_modes.html). Release note: https://www.caido.io/blog/2026-06-05-release-v0-57-0.

### 3a. Caido store and ecosystem search

- `caido/store` `plugin_packages.json` (main): 84 plugins. License values: MIT, GPL-3.0, CC0-1.0. Keyword scan of name/description/repo fields for websocket, socket.io, stomp, json-rpc, graphql-ws: 0 hits.
- Code search for `addMessageViewMode` / `addWebsocketMessageViewMode` found only `caido/sdk-js` `replay.d.ts`. No third-party usage found.
- `caido-community` code search for "websocket" returned SDK, devtools, and dev-tooling repos, not WS extensions. Example of an HTTP-only view-mode plugin: `caido-community/panes` (MIT).
- Search was not exhaustive (code search and metadata only). No Caido WS-specific plugin found.

## 4. Burp: API availability (Montoya, javadoc 2026.7)

Verified from `portswigger.github.io/burp-extensions-montoya-api/javadoc`:

- `WebSockets`: `registerWebSocketCreatedHandler`, `createWebSocket(HttpService, String)`, `createWebSocket(HttpRequest)`.
- `WebSocketCreatedHandler.handleWebSocketCreated(WebSocketCreated)`: fires for WebSockets created by any Burp tool; provides `webSocket()`, `upgradeRequest()`, `toolSource()`.
- `WebSocket`: `sendTextMessage`, `sendBinaryMessage`, `close`, `registerMessageHandler(MessageHandler)`.
- `MessageHandler`: `handleTextMessage(TextMessage)`, `handleBinaryMessage(BinaryMessage)`, `default onClose()`. `TextMessage.payload()`, `direction()`.
- Proxy package `burp.api.montoya.proxy.websocket`: `ProxyWebSocketCreationHandler`, `ProxyMessageHandler` (`handleTextMessageReceived`, `handleTextMessageToBeSent`, binary equivalents), `InterceptedTextMessage`, `InterceptedBinaryMessage`.

Not verified: Montoya version that introduced each type; whether the WebSocket history tab can host a custom viewer (`Editor` javadoc mentions `WebSocketMessageEditor`, API unread); exact pass-through factory names.

## 5. Existing WebSocket tools

### 5a. Socket Sleuth (Burp BApp, Snyk)

- Repo: `github.com/portswigger/socket-sleuth`, commit `0317651bce7d82207d8fb2635a97be66e4d9dbd5` (clone read at this SHA). License: Apache-2.0 (`LICENCE`).
- Workflows: WS history tab; interception rules; Match & Replace on WS messages (direction BIDIRECTIONAL / CLIENT_TO_SERVER / SERVER_TO_CLIENT; string/regex/hex); JSON-RPC Intruder (auto-detect method from the `method` key, Sniper, simple-list and numeric payloads); AutoRepeater (copy source WS messages to a target socket for authorization testing). README says binary frames are unsupported.
- Socket.IO detection: `src/main/java/SocketIODetector.java:27` uses `^0\{.*"sid"\s*:\s*".+".*\}` on messages. This is prefix/regex sniffing. Do not copy this detection approach.
- JSON-RPC: `src/main/java/JsonRpcUtils.java:101` requires only `has("method")` for request detection. `isValidJSONRPCResponse` (line 21) checks `jsonrpc == "2.0"`, id, and exactly one of result/error. `isMethodDetected` (line 48ff) treats error codes -32601, 400, 404 or "method not found" as evidence (lines 71-73). This is heuristic; treat as an example, not a spec.
- Correction to earlier draft: Socket Sleuth is not "not Socket.IO-specific" in code; it contains a Socket.IO handshake detector.

### 5b. WebSocket Turbo Intruder (PortSwigger BApp)

- Repo: `github.com/portswigger/websocket-turbo-intruder`, commit `322b3c073049ab6f9b01efb60005e723aa7e5aa6`. License: MIT (`LICENSE`, "Copyright (c) 2024 Hannah-PortSwigger").
- Workflow: right-click a WS message > Extensions > "Send to WebSocket Turbo Intruder". The highlighted text is replaced by `%s`. A Python script calls `queue_websockets(upgrade_request, message)`, `websocket_connection.create(req, Engine.TURBO|THREADED|BURP)`, `queue()`, `queueWithComment`, with hooks `handle_outgoing_message` and `handle_incoming_message`. Middleware mode exposes an HTTP POST endpoint that routes requests through a WebSocket.
- No Socket.IO, STOMP, JSON-RPC, or SignalR decoder found (grep over `.java` and `.py`, excluding tests).
- Useful as: an example of a Montoya WS message workflow and a reference for an "attack script" surface. Not a viewer.

## 6. Wire facts from primary specs

Each entry gives the envelope (framing) and what the JSON payload means. Framing is decoded by the adapter; payload semantics are a separate layer.

### 6a. Socket.IO v5 over Engine.IO v4 (verified in v1 research)

Sources: `github.com/socketio/socket.io-protocol` v5 (`socket.io-protocol/v5-current.md`); Engine.IO v4 at https://socket.io/docs/v4/engine-io-protocol/.

- Engine.IO envelope: packet type digit 0 open, 1 close, 2 ping, 3 pong, 4 message, 5 upgrade, 6 noop. Over WebSocket, each packet is one frame. Message packets begin with `4`.
- Open payload is JSON: `sid`, `upgrades`, `pingInterval`, `pingTimeout`, `maxPayload`.
- Socket.IO packet inside an Engine.IO message: `<type>[<#binary>-][<namespace>,][<ack id>][JSON]`. Types: 0 CONNECT, 1 DISCONNECT, 2 EVENT, 3 ACK, 4 CONNECT_ERROR, 5 BINARY_EVENT, 6 BINARY_ACK.
- Spec examples (verbatim): `2["foo"]`; `2/admin,["bar"]`; `51-["baz",{"_placeholder":true,"num":0}]` followed by a binary frame; `42/admin,1["tellme"]`.
- v5 vs v4: default namespace is not implicit; CONNECT may carry a payload and the server replies with a socket `sid` distinct from the Engine.IO `sid`; CONNECT_ERROR payload is an object.
- The Socket.IO JSON is the payload semantics (event name plus arguments). The `4` / type digits / namespace / ack id are the envelope.

### 6b. graphql-transport-ws (GraphQL over WebSocket)

Source: `github.com/enisdenjo/graphql-ws` `PROTOCOL.md` (master). Subprotocol: `graphql-transport-ws` (line 10; handshake at line 186).

- Every message is JSON with a `type` field: `connection_init` (client, optional payload), `connection_ack`, `ping` / `pong`, `subscribe` (with `id`), `next` (with `id`), `error` (with `id`), `complete` (with `id`).
- Close codes include 4408, 4429, 4403.
- Envelope: the `type` plus `id` routing. Payload semantics: the subscribe payload (query, variables, operationName), next payload (`data`/`errors`). GraphQL query text is semantics, not framing.

### 6c. JSON-RPC 2.0 over WebSocket

Source: https://www.jsonrpc.org/specification (saved text in `/tmp/ws-jsonrpc.txt`).

- The spec does not define WebSocket framing. Its JSON values include request objects, notifications (no `id`), responses (`result` XOR `error`), and batch arrays. Mapping these values to WebSocket messages requires an application contract.
- `params` is a by-position array or by-name object.
- Payload semantics: `method`, `params`, `id`, `result`, `error`. The JSON-RPC structure is a JSON payload spec, not an envelope.

### 6d. STOMP 1.2 over WebSocket

Source: https://stomp.github.io/stomp-specification-1.2.html (saved as `/tmp/ws-stomp12.txt`).

- Frame: command line, `header:value` lines, blank line, body, NULL octet (0x00). Header escapes and `content-length` are defined. Heart-beat negotiation is defined.
- The spec states the protocol is text-based and also allows binary bodies. It does not name a WebSocket subprotocol token in the text. Do not treat a specific token such as `v12.stomp` as confirmed by this spec.
- One WebSocket message may hold one or more STOMP frames. Frame boundaries are the NULL octet, not the WebSocket frame. Binary bodies use content-length.
- Envelope: frame command and headers. Payload semantics: body interpreted according to `content-type`.

### 6e. SignalR hub protocol (JSON and MessagePack)

Source: `dotnet/aspnetcore` `src/SignalR/docs/specs/HubProtocol.md` and `TransportProtocols.md` (saved as `/tmp/ws-spec-HubProtocol.md.txt`, `/tmp/ws-spec-TransportProtocols.md.txt`).

- Handshake: the first client message is always JSON `{protocol, version: 1}` (HubProtocol.md line 37).
- JSON protocol: each message is terminated by `0x1E` (record separator) (line 315). Split on `0x1E`; the JSON is payload semantics.
- MessagePack protocol: each message is preceded by a `[Length]` VarInt of 1-5 bytes, LSB-first with a continuation bit (lines 1022-1031). The MessagePack body is payload semantics.
- Transport: WebSocket transport supports Text and Binary transfer formats (TransportProtocols.md). Frame type (Text vs Binary) is part of envelope.

### 6f. MessagePack and Protobuf

- MessagePack spec (`github.com/msgpack/msgpack` `spec.md`, saved as `/tmp/ws-spec-msgpack.txt`): self-describing binary format (types for nil, bool, int, str, bin, array, map, ext, timestamp ext -1). It has no framing; a stream or message boundary comes from the transport or an outer envelope (see SignalR above).
- Protobuf encoding (https://protobuf.dev/programming-guides/encoding/, saved as `/tmp/ws-pb.txt`): records are `(field_number << 3) | wire_type`. Wire types: 0 VARINT, 1 I64, 2 LEN, 3 SGROUP, 4 EGROUP, 5 I32. The doc states the encoded form does not carry field names or types; decoding to named fields requires the `.proto` schema.
- Implication: MessagePack can be decoded without a schema. Protobuf needs a user-supplied schema for named fields; without it, only field numbers and wire types are decodable.

## 7. Payload semantics vs envelope decoders

- Envelope decoders split the wire into units and identify type/routing: Engine.IO digits, Socket.IO type digits, STOMP frames (NULL-terminated), SignalR records (0x1E or VarInt length), graphql-transport-ws `type` (JSON envelope).
- Payload semantics interpret the body: Socket.IO event JSON, JSON-RPC request/response, GraphQL operation, STOMP body by content-type, MessagePack/Protobuf values.
- A JSON-RPC or GraphQL message is valid JSON with its own schema; it is not a transport envelope. Treat it as a payload decoder that runs on a JSON body.
- Do not merge envelope and payload into one "format" enum. Each adapter declares its envelope decoder and an optional payload decoder.

## 8. Detection policy (no prefix sniffing)

- Approved product choice: Auto, Raw, JSON, and Socket.IO decoder modes, with connection-level overrides. Raw skips parsing. Auto validates complete input against the supported grammars and leaves ambiguous protocol identity unresolved rather than guessing.
- Metadata gating in `when`: Caido `when` can use `format`, `direction`, `length` only (types at §3). Use it to avoid showing a view on binary or control frames, not to identify a protocol.
- Grammar validation inside the decoder: if the selected grammar does not parse, show a parse error with the raw bytes unchanged. Never hide raw.
- Do not infer the protocol from a leading byte or regex on the handshake. Socket Sleuth's `SocketIODetector` regex is an example of what to avoid.
- Auto is in scope for v1. The exact precedence and ambiguity behavior must be specified before implementation; explicit decoder selection resolves ambiguous cases.

## 9. Corrections to the earlier draft

- Candidate 1 said `when` would limit to text frames that "start with a Socket.IO-looking prefix". This is wrong: `when` receives no payload, so it cannot test a prefix. Also, prefix matching is excluded by §8. Candidate 1 is restated in §10.
- "Needs one GraphQL `websocketMessageEdit` fetch per row" was stated as necessary. Not proven. If `view: EditorView` already contains the message text, no GraphQL fetch is needed. The fetch is one alternative if it does not. Both are unverified.
- "No WS selection API: a view must work per row, not on a selected message" was stated as established. Only the absence of a selection field in the 0.59.0 typings is verified. Whether the view receives the selected message or each row is unverified.
- Socket Sleuth: earlier draft said "Not Socket.IO-specific". The repo contains a Socket.IO handshake detector (§5a). Its detection method is not recommended.
- jq license: scout's report said GPLv3. Verified: jq upstream (`jqlang/jq` main, commit `ac35c7d`) `COPYING` is MIT for jq and CC BY 3.0 for docs; README says "released under the MIT License". `jq-wasm` (npm `3.0.0-jq-1.8.2`, GitHub `owenthereal/jq-wasm`) is MIT. `jq-web` (npm) is ISC. GPLv3 claim is incorrect for these packages.

## 10. Narrow adapter roadmap

Phase 0 (runtime probes, before any code design depends on them):
- Caido v0.59.0: register `addMessageViewMode` and `addWebsocketMessageViewMode`; record what `view` contains for a text message (text present or not). Determine whether the declared GraphQL `websocketMessageEdit` query is needed.

Phase 1: native Caido message inspector; plain JSON and Engine.IO/Socket.IO v5 text decoding; independent jq-wasm worker; complete decoded JSON payload as jq input; Original, Wrapped original, Pretty JSON, and Compact JSON presets. Raw data stays unchanged, with no silent repair. Binary attachment reconstruction is not included in this proposed text scope.

Phase 2: JSON-RPC 2.0 payload decoder, selected by explicit preset (e.g. "JSON-RPC" view), validating the JSON-RPC structure per §6c.

Phase 3: graphql-transport-ws envelope decoder (explicit preset), with payload fields shown as JSON.

Deferred (no design yet): STOMP (frame splitter on NULL octet, binary bodies via content-length); SignalR JSON (split on 0x1E) and MessagePack (VarInt length, library needed); Protobuf (requires user-supplied `.proto`, out of scope without schema input).

Dependencies: prefer an existing, vetted library over hand-written parsers where a license allows it (user preference). Candidate licenses still to check per library: `socket.io-parser`, `@stomp/stompjs`, `graphql-ws`, MessagePack libraries.

## 11. Risks and open questions

- Runtime: confirm `addMessageViewMode` and `addWebsocketMessageViewMode` register and render on v0.59.0. Only typings were read.
- Caido `view: EditorView`: what text it shows per message; whether a GraphQL fetch is needed.
- Per-row vs selected message: unverified.
- Performance: per-row fetches on large streams, if needed.
- Burp: custom tab feasibility and the Montoya version that introduced each WS type.
- Plugin sandboxing, permissions, and distribution license terms for Caido and Burp: not researched.
- Search for Caido WS plugins was metadata and code search only; not exhaustive.

## 12. Sources

- Caido SDK, tag `v0.59.0` (commit `da6c666d0b69d3e40e6211d5bdfadaed07d95d2d`): permalinks in §3. Files: `packages/sdk-frontend/src/types/{sdks/websocket.d.ts,types/websocket.d.ts,sdks/replay.d.ts,sdks/index.d.ts,__generated__/graphql-sdk.d.ts}`, `packages/sdk-backend/src/typing.d.ts`.
- Caido store: `github.com/caido/store` `plugin_packages.json` (main).
- Caido docs: https://docs.caido.io/app/quickstart/ws_history.html ; https://developer.caido.io/plugins/reference/sdks/frontend/websockets.html ; https://developer.caido.io/plugins/guides/view_modes.html ; release https://www.caido.io/blog/2026-06-05-release-v0-57-0
- Socket Sleuth: `github.com/portswigger/socket-sleuth` `0317651bce7d82207d8fb2635a97be66e4d9dbd5` (`LICENCE`, `src/main/java/SocketIODetector.java`, `src/main/java/JsonRpcUtils.java`). BApp: https://portswigger.net/bappstore/42bda36c7fab496a87313943df698668
- WebSocket Turbo Intruder: `github.com/portswigger/websocket-turbo-intruder` `322b3c073049ab6f9b01efb60005e723aa7e5aa6` (`LICENSE`, `src/main/java/attack/AttackScriptExecutor.java`).
- Socket.IO v5 protocol: `github.com/socketio/socket.io-protocol` (`v5-current.md`); Engine.IO v4: https://socket.io/docs/v4/engine-io-protocol/
- graphql-transport-ws: `github.com/enisdenjo/graphql-ws` `PROTOCOL.md`
- JSON-RPC 2.0: https://www.jsonrpc.org/specification
- STOMP 1.2: https://stomp.github.io/stomp-specification-1.2.html
- SignalR: `github.com/dotnet/aspnetcore` `src/SignalR/docs/specs/HubProtocol.md`, `TransportProtocols.md`
- MessagePack spec: `github.com/msgpack/msgpack` `spec.md`
- Protobuf encoding: https://protobuf.dev/programming-guides/encoding/
- jq: `github.com/jqlang/jq` `COPYING`, `README.md` (commit `ac35c7d`, 2026-10-25); `owenthereal/jq-wasm` `LICENSE`; npm `jq-wasm` 3.0.0-jq-1.8.2; npm `jq-web` (ISC)
- Burp Montoya javadoc 2026.7: https://portswigger.github.io/burp-extensions-montoya-api/javadoc/burp/api/montoya/websocket/WebSockets.html ; `.../websocket/WebSocket.html` ; `.../websocket/MessageHandler.html` ; `.../websocket/WebSocketCreatedHandler.html` ; `.../websocket/WebSocketCreated.html` ; `.../websocket/TextMessage.html` ; `.../proxy/websocket/package-summary.html` ; `.../proxy/websocket/ProxyMessageHandler.html`
