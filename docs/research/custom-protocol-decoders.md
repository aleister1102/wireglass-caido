# Custom protocol decoders: config vs scripts vs jq (research)

Status: research only. No code, tests, builds, or commits. Source reads only.
Scope: how a user could define their own WebSocket protocol decoders (Wireshark-dissector-like) inside the Caido plugin, with native Caido settings UI (the pattern used by crayon-caido). Covers settings UI APIs, persistence, per-project and per-connection state, and whether user-supplied code can be denied network, host SDK, DOM, storage, or CPU.

Companion doc: `docs/research/websocket-extension-feasibility.md` (WS viewer, view-mode API, payload access). This doc does not repeat that analysis.

Method: shallow clone of `caido/sdk-js` tag `v0.59.0` (commit `da6c666d0b69d3e40e6211d5bdfadaed07d95d2d`). Permalinks below use `https://github.com/caido/sdk-js/blob/v0.59.0/`. Typings were read, not runtime behavior. Runtime claims are marked as such.

Labels used below: **[SRC]** = stated in primary source (typings, docs, or upstream code). **[INF]** = inference from source. **[PROP]** = proposal for this project, not verified.

---

## 1. Constraints (from the user)

- Users define custom protocol decoders for WebSocket messages.
- Config or script extensibility is requested. Research only at this stage.
- Settings live in native Caido settings (not a separate app).
- Already approved elsewhere: read-only WS inspector; original bytes never modified; JSON-first Auto mode plus explicit decoder modes; own jq-wasm with explicit Run; four view presets.
- The user approved the 14-ticket v1 plan after this investigation started. Custom decoder implementation is deferred; saved settings and temporary viewer choices are separate concepts.

---

## 2. Settings UI: what the SDK supports

**[SRC]** The frontend SDK exposes one settings entry point: `sdk.settings.addToSlot(...)`.

- `SettingsSDK = { addToSlot }` only. `packages/sdk-frontend/src/types/sdks/settings.d.ts` L7-22.
- Slot constant `SettingsSlot.PluginsSection = "plugins-section"`. `packages/sdk-frontend/src/types/types/settings.d.ts` L6-11.
- Plugin content is a `Custom` entry with a name and a `ComponentDefinition` (a Vue component plus optional props and events). Same file L17-22. `ComponentDefinition` is at `packages/sdk-frontend/src/types/types/utils.d.ts` L57-61.

**[SRC]** There is no declarative settings schema API. No field types, no validation, no generated form. Custom UI = Vue component. Any "config" format is therefore something the plugin author builds inside a Vue form.

**[INF]** A "config-only" decoder UI is still a custom Vue component. The native part is the slot placement, not the form generation.

---

## 3. Persistence: what the SDK offers

| Store | Surface | What the typings say | Source |
| --- | --- | --- | --- |
| Backend KV | `sdk.kv` (backend) | `define(key, {exportable?})`, `get`, `set`, `del`, `on("set"\|"delete")`. Values must be JSON. `exportable` doc: "Usually this should be true for keys that are settings that you would want to transfer between Caido instances." | `packages/sdk-backend/src/typing.d.ts` L46-67 (KVValue, exportable), L74-128 (KVSDK), L392 (`kv: KVSDK`) |
| Frontend KV | `sdk.kv` (frontend) | "Plugin package data shared across frontend and backend surfaces of the same plugin package. Not per-user; separate from StorageSDK." Same define/get/set/del/on shape. | `packages/sdk-frontend/src/types/sdks/kv.d.ts` L9-25 (exportable, scope), L26-68 (KVSDK) |
| Frontend storage | `sdk.storage` (frontend) | `get`, `set`, `onChange`. Doc says "frontend-plugin storage". No durability or scope described. | `packages/sdk-frontend/src/types/sdks/storage.d.ts` L3-22 |
| Backend sqlite | `sdk.meta.db()` | "sqlite ... stored in Caido Data ... per plugin". | `packages/sdk-backend/src/typing.d.ts` ~L305-312 |
| Backend assets dir | `sdk.meta.assetsPath()` | "You shouldn't write anything there, as the contents can be reset at any time." Read-only in intent. | same file, ~L300-306 |
| Workflow state | Workflows | "On-demand", no persistence between runs. | https://developer.caido.io/plugins/concepts/workflow.html |

**[SRC] Per-project settings API: none.** The only project surface in the frontend is `onCurrentProjectChange`. `packages/sdk-frontend/src/types/sdks/projects.d.ts` L7-23. Backend has `events.onProjectChange(project | null)`, "asynchronously and cannot modify the project", and the project can be null. `packages/sdk-backend/src/typing.d.ts` L220-240.

**[INF] Per-project decoder sets** must be built by the plugin: store a map keyed by project id in KV or sqlite, and read the current project from the events above. No built-in scoping.

**[SRC] Signing is not a settings mechanism.** Store signing is Ed25519 for store downloads only. https://developer.caido.io/plugins/concepts/signing.html

**Durability caveat [SRC/INF]:** The typings do not state what survives a Caido restart, a plugin reload, or a project switch for KV or storage. `meta.db()` is documented as "stored in Caido Data". KV and frontend storage are not documented as durable or non-durable. **Verify with a probe plugin before relying on any of them** (see section 9).

---

## 4. Persistence split: durable decoder config vs temporary per-connection mode

**[PROP]** Two classes of state, stored differently:

1. **Decoder definitions** (protocol name, match rules, field map or script text, version). Long-lived, user-authored, should survive restarts and be exportable.
   - Store in backend KV with `exportable: true` (matches the doc's stated use case), or in `meta.db()` if KV durability is not confirmed by the probe.
   - Scope per project only if needed; key as `project:<id>:decoder:<name>`, plus a global namespace. Project switch via `onProjectChange`.
   - Import/export via Caido's own export mechanism for exportable KV (not verified in this pass; confirm before claiming).

2. **Per-connection mode choices** (which decoder is active for this stream, which preset is shown). Short-lived, tied to one WS stream id.
   - Keep in frontend memory (component state or a `Map<streamId, mode>`). Key by `StreamWsMessageMeta.streamId` from the view-mode `when` / props (`packages/sdk-frontend/src/types/types/websocket.d.ts` L11-24).
   - Do not write per-stream mode to durable storage. Clearing it on reload is the expected behavior.
   - Auto mode (JSON-first) is stateless and needs no storage.

**[INF] Crayon's pattern is the opposite of what this split needs** (see section 6): it persists a global settings object in backend memory only.

---

## 5. Decoder execution options

Each option is evaluated against: runs without network, host SDK, DOM, storage access; CPU stop; memory cap; where it runs.

### 5a. Declarative config (no user code)

- Examples: field offset/length, endianness, delimiter split, JSON path, enum map, base64/hex.
- Config limits users to implemented operations rather than arbitrary code. The interpreter still needs validation, resource limits, and controls on any operations that can access external capabilities.
- Limit: expressiveness. Supported framing operations must have explicit contracts; a configuration format does not make arbitrary parsing safe by itself.
- **[PROP]** Consider a typed, validated configuration schema when this future feature is designed. Coverage of custom protocols has not been measured.

### 5b. jq extraction (own jq-wasm, explicit Run)

- **[SRC/fact]** `jq-wasm` on npm: version `3.0.0-jq-1.8.2`, license MIT, Node >= 20, unpacked size about 4.08 MB, Emscripten build. Repo https://github.com/owenthereal/jq-wasm. Source: https://registry.npmjs.org/jq-wasm (readme and metadata).
- `jq-wasm` API: `loadJq()` returns a synchronous handle (`json`, `first`, `raw`, `stream`). Source: npm readme above.
- `jq-web` 0.6.2 (ISC) is an older Emscripten build. `node-jq` (MIT) wraps a native jq binary and is not browser-usable. Not preferred.
- **[INF]** jq itself has no network or DOM API. Its risks are CPU (infinite loops via recursion or `repeat`/`while`-style filters) and memory (large outputs). The `jq-wasm` handle is **synchronous**, so a call blocks its thread. A blocked main thread cannot be stopped by the page.
- **[PROP]** Run jq inside a Worker (section 5c) so the main thread can terminate it. Do not call `jq-wasm` synchronously on the UI thread for user filters.
- jq is the right tool for "extract fields from JSON" and similar. Not a security boundary by itself.

### 5c. JavaScript in a browser Worker (frontend)

- **[SRC]** Frontend plugin code runs "inside the browser or electron" with runtime status WIP. https://developer.caido.io/plugins/concepts/runtime.html
- **[SRC, MDN]** Workers "can make network requests using the fetch() or XMLHttpRequest APIs", can use WebSockets and IndexedDB, and cannot touch the DOM. Workers are not governed by the creating document's CSP by default; the CSP must be set on the worker script response. https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers (sections "Functions and classes available to workers" and "Content security policy").
- **[SRC, MDN]** `worker.terminate()` immediately stops a running worker. https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate and the Using web workers page (same URL).
- **[INF] Deny capabilities:**
  - Network: a Worker does not deny it by default. The cited MDN page distinguishes response-delivered CSP from blob/data workers that inherit the creator's CSP. Verify the actual Caido worker policy before making isolation claims.
  - Host SDK / DOM: DOM is not present in a Worker (MDN). Host SDK is not reachable from a Worker unless the plugin passes it via `postMessage` (the plugin controls that). Good.
  - Storage: IndexedDB and similar are available in a Worker per MDN. Deny not provided by Worker.
  - CPU: `terminate()` is the only hard stop. Use a time budget on the main thread and terminate and restart the worker.
  - Memory: no cap in the Worker API.
- **[INF] Worker is not a sandbox.** It is a thread. Anything the page can reach from its origin, the worker can usually reach too, subject to the origin's network policy.

### 5d. Iframe with sandbox (frontend, stronger isolation candidate)

- **[SRC, MDN]** The `sandbox` attribute restricts an embedded document. Combining `allow-scripts` and `allow-same-origin` is "strongly discouraged", because it lets the embedded document remove the sandbox. https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe (sandbox section).
- **[INF]** Without `allow-same-origin`, the iframe gets an opaque origin: no access to the parent's storage, cookies, or DOM. A CSP on the iframe's `srcdoc` (meta tag) could block `connect-src`. Message passing via `postMessage` is the only channel.
- **[PROP]** An opaque-origin iframe is one candidate for restricting origin access. Runtime support, all network channels, message validation, and reliable CPU interruption remain unverified. It is not yet an accepted script host.

### 5e. JavaScript in the backend (QuickJS)

- **[SRC]** Backend JS runs in QuickJS (bellard), ES2023. Modules: `child_process`, `sqlite`, `buffer`, `fs`, `net`, `os`, `path`, `crypto` (partial). https://developer.caido.io/plugins/concepts/runtime.html
- **[SRC]** `quickjs-types` exposes `net.connect()` and an llrt tree with `child_process`, `fs`, `net`, `https`, `dns`. Typings path: `quickjs-types/src/llrt/` and `quickjs-types/src/caido/net.d.ts`, in the same clone.
- **[SRC]** Backend QuickJS has known limits per the crayon README (no `console.info`). See section 6.
- **[INF] Deny capabilities:** A user script in the backend runs in the plugin's single QuickJS runtime. The SDK offers no API to create a separate realm or to strip modules for one script. The plugin would have to implement its own sandbox (for example by not exposing imports), which is not verified to be feasible. **Treat backend user scripts as full plugin code.** Do not run untrusted decoder scripts there.
- **[SRC, C API]** The bellard `quickjs.h` exposes `JS_SetInterruptHandler` (L964-965), `JS_SetMemoryLimit` (L372), `JS_SetMaxStackSize` (L375). Source: https://raw.githubusercontent.com/bellard/quickjs/master/quickjs.h. **[SRC]** `quickjs-types` in the SDK exposes **no** interrupt, memory-limit, or CPU-timeout API (grep of `quickjs-types/` found only request timeouts in `requests.d.ts` and `timers.d.ts`). So the plugin cannot set these limits from JS.
- **[INF] CPU stop:** no SDK-level stop for a runaway backend script. Not acceptable for user code.

### 5f. Summary

| Option | Where | Deny network | Deny SDK | Deny DOM | Deny storage | Stop CPU | Memory cap | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Declarative config | interpreter | depends on operations | depends on operations | depends on operations | depends on operations | requires limits | requires limits | Candidate |
| jq (jq-wasm) | Worker | no | yes (no SDK in Worker) | yes (no DOM) | no | `terminate()` | none | Good for JSON extract, inside Worker |
| JS Worker | frontend Worker | no (CSP unverified) | by message passing only | yes (no DOM) | no | `terminate()` | none | Not a sandbox |
| JS iframe sandbox | frontend iframe | candidate (CSP, unverified) | requires host-message controls | parent DOM restricted | parent storage restricted | not demonstrated | none shown | Candidate, unverified |
| JS backend | QuickJS | no | no | n/a | no | none via SDK | none via SDK | Reject for user code |

---

## 6. Crayon-caido reference source

Repo: https://github.com/aleister1102/crayon-caido.
- `manifest.json` names author `insomnia1102`; `package.json` declares license `ISC`.
- A root LICENSE file was not found in this inspection. Licensing for code reuse was not fully reviewed; use the observed integration pattern without copying implementation.

Settings and persistence, verified in source (raw files at HEAD; commit SHA not captured due to API rate limit):
- Frontend registers a native settings entry: `sdk.settings.addToSlot("plugins-section", { type: "Custom", name: "Crayon", definition: { component: Configuration } })`. `src/frontend/index.ts` L44-48. This is the pattern this project would use.
- Frontend Vue component calls backend RPC `getSettings` / `setSettings` via `api.register`. Backend `src/backend/index.ts` L110-125.
- **Backend persistence is in-memory only.** `let persistedSettings` L85 ("in-memory fallback persistence"). `readSettings` L183-190 returns `persistedSettings` or defaults, with comment "No durable storage available in this SDK version; fall back to defaults". `writeSettings` L192-194 assigns the module variable. `getSettings` caches in `cachedSettings` L164-170.
- Crayon does **not** use `sdk.kv` or `sdk.meta.db()`, although both exist in v0.59.0 typings. The "no durable storage" comment predates or ignores these APIs (their SDK version is "0.55+" per README). **[INF]** After backend restart, settings revert to defaults.
- Auto mode uses `setInterval` (L206) to poll requests. README: "Persistence: fallback to in-memory persistence when durable storage is unavailable." Also README L52: "No `console.info`... (QuickJS backend limitation)".

**Takeaway [INF]:** Crayon source demonstrates how it registers the native settings slot. This research did not run Crayon, and its in-memory settings implementation does not establish restart durability. The probe in section 9 is needed.

---

## 7. Proposals (not verified; for discussion)

- **[PROP] P1. Authoring choices:** compare validated configuration, jq-based extraction, and isolated user scripts when the future feature is designed. None is selected for implementation.
- **[PROP] P2. Decoder contract:** define stable decoder IDs, explicit matching inputs, validated payload/metadata output, diagnostics, and text-range highlighting. Do not accept arbitrary HTML from decoder output.
- **[PROP] P3. Storage:** measure restart/project-switch behavior before selecting KV, frontend storage, or a database. Choose one recorded storage contract rather than a runtime fallback chain.
- **[PROP] P4. Execution budget:** derive input, output, memory, and execution limits from measurements and requirements. Demonstrate interruption of CPU-bound code before accepting a script host; reloading an iframe is not proven to interrupt it reliably.
- **[PROP] P5. Original content:** decoders produce read-only derived views. The native view's EditorView and the declared GraphQL `websocketMessageEdit` query are candidate input sources; the first v1 ticket verifies which contract to use.
- **[PROP] P6. Trust model:** distinguish capability restrictions from execution limits. Keep user code out of the host page and backend plugin runtime unless a separate isolation design has been verified.

---

## 8. Risks and open questions

1. **Durability of KV and frontend storage** across Caido restart, plugin reload, and project switch. Unknown from typings.
2. **Whether Caido's plugin host allows an iframe** inside a view-mode or settings component, and whether `sandbox` and `srcdoc` CSP are honored.
3. **Whether `EditorView` in `MessageViewModePropsInternal`** exposes the selected message content. Both EditorView access and the declared GraphQL `websocketMessageEdit` query require runtime verification before choosing the input source.
4. **Backend eval capability:** whether QuickJS in the plugin runtime allows `eval` or `new Function`. Not checked; relevant only if backend JS is considered (currently rejected).
5. **Worker CSP** for blob or inline workers in Caido: unverified.
6. **Licensing of reference code:** complete a license review before copying Crayon implementation.
7. **Versions:** typings are at `v0.59.0`. The parent session separately observed local Caido 0.59.0; runtime behavior was not tested by this research.

---

## 9. Verification plan (research checks, no code in this pass)

Probe plugins are out of scope for this research task. Each check below proves or disproves a claim above:

1. **KV durability:** a throwaway backend plugin in `/tmp` sets `exportable: true` KV and `meta.db()` values, restarts Caido, and reads them back. Repeat after a project switch.
2. **Frontend storage durability:** same as (1) for `sdk.storage` and frontend `sdk.kv`.
3. **Iframe sandbox:** a frontend view-mode component mounts `<iframe sandbox="allow-scripts" srcdoc="...">` with a CSP meta blocking `connect-src`; attempt `fetch` and read `parent.document`.
4. **Worker terminate:** a Worker running an infinite loop is terminated from the main thread within the budget.
5. **Backend eval:** test `eval` availability in the backend runtime (only if the team wants a backend option).

---

## 10. Sources

Primary, verified this pass (SDK tag `v0.59.0`, commit `da6c666d0b69d3e40e6211d5bdfadaed07d95d2d`, clone at `/tmp/research-sdk-js-2`):
- https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/sdks/settings.d.ts (L7-22)
- https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/types/settings.d.ts (L6-22)
- https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/types/utils.d.ts (L57-61)
- https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/sdks/kv.d.ts (L9-68)
- https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/sdks/storage.d.ts (L3-22)
- https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/sdks/projects.d.ts (L7-23)
- https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/sdks/websocket.d.ts (L6-12)
- https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/types/websocket.d.ts (L11-55)
- https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-frontend/src/types/__generated__/graphql-sdk.d.ts (L3244-3247, L4402-4407, L4425-4433)
- https://github.com/caido/sdk-js/blob/v0.59.0/packages/sdk-backend/src/typing.d.ts (L46-128, L220-240, ~L300-312, L392)
- https://developer.caido.io/plugins/concepts/runtime.html
- https://developer.caido.io/plugins/concepts/workflow.html
- https://developer.caido.io/plugins/concepts/signing.html
- https://developer.caido.io/plugins/concepts/package.html
- https://developer.caido.io/plugins/reference/config.html
- https://raw.githubusercontent.com/bellard/quickjs/master/quickjs.h (L372-375, L964-965)
- https://registry.npmjs.org/jq-wasm (readme, metadata)
- https://github.com/owenthereal/jq-wasm
- https://registry.npmjs.org/jq-web, https://registry.npmjs.org/node-jq (metadata)
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers
- https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe

Reference implementation:
- https://github.com/aleister1102/crayon-caido (raw files: `src/backend/index.ts`, `src/frontend/index.ts`, `README.md`, `manifest.json`, `package.json`)

Companion: `docs/research/websocket-extension-feasibility.md`.
