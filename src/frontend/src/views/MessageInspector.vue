<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch, type PropType } from "vue";
import type { Caido } from "@caido/sdk-frontend";
import type { EditorView } from "@codemirror/view";
import type { StreamWsMessageMeta } from "@caido/sdk-frontend/src/types/types/websocket";
import CodeView from "../components/CodeView.vue";
import JqPanel from "../components/JqPanel.vue";
import { directionLabel, snapshotMessage } from "../lib/messageContent";
import { DECODER_MODES, decodeLayoutFrame, decodeText, labelFor, layoutMode, payloadOf, type Decoded } from "../lib/decode";
import { decodeLz4Frame, readFrameBytes } from "../lib/lz4";
import { hexDump, hexString } from "../lib/hex";
import { useLayoutRegistry, type LayoutSummary } from "../lib/layout/registry";
import { PRESETS, PRESET_LABELS, useSession, type DecoderChoice, type Preset } from "../lib/session";
import { defaultPreset, describeDecoded, payloadCopyText, presetAvailable, renderPreset, type HexState } from "../lib/view";
import { copyText } from "../lib/clipboard";
import { createJqRunner } from "../lib/jq/runner";
import { createJqWorker } from "../lib/jq/createWorker";

const props = defineProps({
  sdk: { type: Object as PropType<Caido>, required: true },
  message: { type: Object as PropType<StreamWsMessageMeta>, required: true },
  view: { type: Object as PropType<EditorView>, required: true },
});

const session = useSession();
const registry = useLayoutRegistry();
const runner = createJqRunner(() => createJqWorker(props.sdk));

const snapshot = computed(() => snapshotMessage(props.message, props.view));
const scope = computed(() => ({ streamId: props.message.streamId, direction: props.message.head.direction }));
const choice = computed<DecoderChoice>(() => session.decoderFor(scope.value));
const builtinMode = computed(() => (choice.value.kind === "builtin" ? choice.value.mode : undefined));
const selectionKey = computed(() => `${props.message.streamId}:${props.message.id}:${props.message.head.id}`);

// The catalog and settings change the registry outside this view, so the inspector mirrors it.
const layouts = shallowRef<LayoutSummary[]>(registry.list());
onBeforeUnmount(registry.subscribe(() => (layouts.value = registry.list())));

const decoderValue = computed(() => (choice.value.kind === "builtin" ? choice.value.mode : layoutMode(choice.value.layoutId)));
const decoderOptions = computed(() => {
  const options = DECODER_MODES.map((mode) => ({ value: mode as string, label: labelFor(mode) }));
  for (const layout of layouts.value) {
    const value = layoutMode(layout.id);
    options.push({ value, label: labelFor(value, layout.name) });
  }
  if (choice.value.kind === "layout" && !layouts.value.some((layout) => layoutMode(layout.id) === decoderValue.value)) {
    options.push({ value: decoderValue.value, label: `${labelFor(decoderValue.value)} (removed)` });
  }
  return options;
});

function choose(value: string) {
  const mode = DECODER_MODES.find((candidate) => candidate === value);
  if (mode !== undefined) {
    session.setDecoder(scope.value, { kind: "builtin", mode });
    return;
  }
  const layout = layouts.value.find((candidate) => layoutMode(candidate.id) === value);
  if (layout) session.setDecoder(scope.value, { kind: "layout", layoutId: layout.id, layoutRevision: layout.revision });
}

// The LZ4 decoder reads the frame bytes from Caido, so its result arrives asynchronously.
const lz4 = shallowRef<{ key: string; decoded: Decoded }>();
watch(
  [selectionKey, builtinMode],
  async ([key, mode]) => {
    if (mode !== "lz4") {
      lz4.value = undefined;
      return;
    }
    if (lz4.value?.key === key) return;
    const isCurrent = () => key === selectionKey.value && builtinMode.value === "lz4";
    const decoded = await decodeLz4Frame(props.sdk, props.message.head.id, isCurrent);
    if (decoded && isCurrent()) lz4.value = { key, decoded };
  },
  { immediate: true },
);

// Layout decoders read the exact frame bytes once per selection; the decode itself runs against the current registry.
type FrameRead = { kind: "ok"; bytes: Uint8Array } | { kind: "error"; message: string };
const layoutActive = computed(() => choice.value.kind === "layout");
const frame = shallowRef<{ key: string; read: FrameRead }>();
watch(
  [selectionKey, layoutActive],
  async ([key, active]) => {
    if (!active) {
      frame.value = undefined;
      return;
    }
    if (frame.value?.key === key) return;
    let read: FrameRead;
    try {
      read = { kind: "ok", bytes: await readFrameBytes(props.sdk, props.message.head.id) };
    } catch (error) {
      read = { kind: "error", message: `Could not read the frame bytes: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (key === selectionKey.value && layoutActive.value) frame.value = { key, read };
  },
  { immediate: true },
);

/** A layout choice decodes only against the layout it was made for; a removed or replaced layout is unavailable. */
function decodeLayoutChoice(current: Extract<DecoderChoice, { kind: "layout" }>): Decoded {
  const mode = layoutMode(current.layoutId);
  const summary = layouts.value.find((layout) => layout.id === current.layoutId);
  const layout = registry.get(current.layoutId);
  if (!summary || !layout || summary.revision !== current.layoutRevision) return { kind: "unavailable", mode };
  const read = frame.value?.key === selectionKey.value ? frame.value.read : undefined;
  if (!read) return { kind: "pending", mode };
  if (read.kind === "error") return { kind: "error", mode, decoder: mode, message: read.message };
  return decodeLayoutFrame(layout, current.layoutRevision, read.bytes);
}

const decoded = computed<Decoded>(() => {
  const current = choice.value;
  if (current.kind === "layout") return decodeLayoutChoice(current);
  if (current.mode !== "lz4") return decodeText(snapshot.value.content, current.mode, snapshot.value.format);
  return lz4.value?.key === selectionKey.value ? lz4.value.decoded : { kind: "pending", mode: "lz4" };
});
const payload = computed(() => payloadOf(decoded.value));
const activePreset = computed<Preset>(() => session.preset.value ?? defaultPreset(decoded.value));

const hex = shallowRef<{ key: string; state: HexState }>();
watch(
  [selectionKey, activePreset],
  async ([key, preset]) => {
    if (preset !== "hex") {
      hex.value = undefined;
      return;
    }
    if (hex.value?.key === key) return;
    let state: HexState;
    try {
      const bytes = await readFrameBytes(props.sdk, props.message.head.id);
      state = { kind: "ok", text: hexDump(bytes), plain: hexString(bytes) };
    } catch (error) {
      state = { kind: "error", message: `Could not read the frame bytes: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (key === selectionKey.value && activePreset.value === "hex") hex.value = { key, state };
  },
  { immediate: true },
);
const hexState = computed<HexState>(() => (hex.value?.key === selectionKey.value ? hex.value.state : { kind: "pending" }));
const rendered = computed(() => renderPreset(snapshot.value.content, decoded.value, activePreset.value, hexState.value));
const facts = computed(() => describeDecoded(snapshot.value.content, decoded.value));

const copied = ref<"" | "original" | "payload" | "hex" | "failed">("");
watch(selectionKey, () => (copied.value = ""));

function choosePreset(preset: Preset) {
  if (presetAvailable(decoded.value, preset)) session.preset.value = preset;
}

async function copyOriginal() {
  copied.value = (await copyText(snapshot.value.content)) ? "original" : "failed";
}

async function copyPayload() {
  const text = payloadCopyText(decoded.value, activePreset.value);
  if (text === undefined) return;
  copied.value = (await copyText(text)) ? "payload" : "failed";
}

async function copyHex() {
  const state = hexState.value;
  if (state.kind !== "ok") return;
  copied.value = (await copyText(state.plain)) ? "hex" : "failed";
}
</script>

<template>
  <div class="wireglass-inspector" data-testid="wireglass-inspector">
    <header class="wg-header">
      <div class="wg-segmented" role="group" aria-label="View">
        <button
          v-for="preset in PRESETS"
          :key="preset"
          type="button"
          :data-testid="`wireglass-preset-${preset}`"
          :class="{ active: activePreset === preset }"
          :aria-pressed="activePreset === preset"
          :disabled="!presetAvailable(decoded, preset)"
          :title="presetAvailable(decoded, preset) ? '' : 'Needs a decoded JSON payload'"
          @click="choosePreset(preset)"
        >
          {{ PRESET_LABELS[preset] }}
        </button>
      </div>
      <label class="wg-select" title="Applies to messages in this direction on this stream until you switch project or reload Caido">
        <span class="wg-select-label">Decoder</span>
        <select :value="decoderValue" data-testid="wireglass-decoder" aria-label="Decoder for this direction" @change="choose(($event.target as HTMLSelectElement).value)">
          <option v-for="option in decoderOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <div class="wg-actions">
        <span class="wg-copied" data-testid="wireglass-copied" aria-live="polite">{{
          copied === "original" ? "Original copied" : copied === "payload" ? "Payload copied" : copied === "hex" ? "Hex copied" : copied === "failed" ? "Copy failed" : ""
        }}</span>
        <button type="button" class="wg-button" data-testid="wireglass-copy-original" @click="copyOriginal">Copy original</button>
        <button type="button" class="wg-button" data-testid="wireglass-copy-payload" :disabled="!payload" @click="copyPayload">Copy payload</button>
        <button
          v-if="activePreset === 'hex'"
          type="button"
          class="wg-button"
          data-testid="wireglass-copy-hex"
          title="Copies the frame bytes as one hex string"
          :disabled="hexState.kind !== 'ok'"
          @click="copyHex"
        >
          Copy hex
        </button>
      </div>
    </header>

    <div class="wg-content">
      <CodeView v-if="rendered.available" data-testid="wireglass-content" :text="rendered.text" :json-from="rendered.jsonFrom" :wrap="rendered.wrap" />
      <p v-else class="wg-unavailable" data-testid="wireglass-unavailable">{{ rendered.reason }}</p>
    </div>

    <JqPanel :runner="runner" :input="payload?.text" :selection-key="selectionKey" />

    <footer class="wg-footer" data-testid="wireglass-meta">
      <span data-testid="wireglass-direction">{{ directionLabel(snapshot.direction) }}</span>
      <span data-testid="wireglass-format">{{ snapshot.format }}</span>
      <span data-testid="wireglass-length">{{ snapshot.length }} bytes</span>
      <span v-for="fact in facts" :key="fact.key" :data-testid="`wireglass-fact-${fact.key}`" :class="{ 'wg-error': fact.key === 'error' }">
        <span class="wg-fact-label">{{ fact.label }}</span> {{ fact.value }}
      </span>
    </footer>
  </div>
</template>

<style scoped>
.wireglass-inspector {
  --wg-fg: #edeae8;
  --wg-fg-muted: rgb(255 255 255 / 0.6);
  --wg-fg-strong: rgb(255 255 255 / 0.8);
  --wg-surface: #25272d;
  --wg-surface-active: #3a3d45;
  --wg-border: #484c56;
  --wg-outline: #616161;
  --wg-primary: rgb(205 50 81 / 0.8);
  --wg-radius: 5.25px;
  --wg-mono: Menlo, Monaco, Consolas, monospace;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  color: var(--wg-fg);
  font-size: 14px;
}
.wg-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  min-height: 42px;
  padding: 0 7px;
}
.wg-segmented {
  display: inline-flex;
  border-radius: var(--wg-radius);
  overflow: hidden;
  background: var(--wg-surface);
}
.wg-segmented button {
  height: 30px;
  padding: 0 14px;
  border: 0;
  background: var(--wg-surface);
  color: var(--wg-fg-muted);
  font: inherit;
  cursor: pointer;
}
.wg-segmented button.active {
  background: var(--wg-surface-active);
  color: var(--wg-fg-strong);
}
.wg-segmented button:hover:not(:disabled):not(.active) {
  color: var(--wg-fg-strong);
}
.wg-select {
  display: inline-flex;
  align-items: center;
  height: 30px;
  border: 1px solid var(--wg-outline);
  border-radius: var(--wg-radius);
  color: #ababab;
}
.wg-select-label {
  padding: 0 4px 0 10.5px;
}
.wg-select select {
  height: 100%;
  padding: 0 7px;
  border: 0;
  background: transparent;
  color: var(--wg-fg);
  font: inherit;
  cursor: pointer;
}
.wg-select select option {
  background: var(--wg-surface);
}
.wg-actions {
  display: inline-flex;
  align-items: center;
  gap: 3.5px;
  margin-left: auto;
}
.wg-copied {
  margin-right: 4px;
  font-size: 12.25px;
  color: var(--wg-fg-muted);
}
.wg-content {
  flex: 1;
  min-height: 8em;
  overflow: auto;
}
.wg-unavailable {
  margin: 0;
  padding: 10.5px;
  color: var(--wg-fg-muted);
}
.wg-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
  min-height: 30px;
  padding: 4px 10.5px;
  font-size: 12.25px;
  color: #d1d5db;
}
.wg-footer > span + span::before {
  content: "|";
  margin: 0 7px;
  color: var(--wg-fg-muted);
}
.wg-fact-label {
  color: var(--wg-fg-muted);
}
.wg-error {
  color: #f28b82;
}
:deep(.wg-button) {
  height: 26.5px;
  padding: 0 10.5px;
  border: 1px solid var(--wg-border);
  border-radius: var(--wg-radius);
  background: var(--wg-surface);
  color: #c7c7c7;
  font: inherit;
  font-size: 12.25px;
  cursor: pointer;
}
:deep(.wg-button:hover:not(:disabled)) {
  color: var(--wg-fg);
  border-color: var(--wg-outline);
}
:deep(.wg-button.wg-primary) {
  height: 32px;
  border-color: var(--wg-primary);
  background: var(--wg-primary);
  color: var(--wg-fg);
  font-size: 14px;
}
:deep(button:disabled) {
  opacity: 0.45;
  cursor: not-allowed;
}
:deep(button:focus-visible),
:deep(select:focus-visible),
:deep(input:focus-visible) {
  outline: 1px solid var(--wg-fg-muted);
  outline-offset: 1px;
}
</style>
