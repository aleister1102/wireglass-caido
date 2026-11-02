<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, type PropType } from "vue";
import type { Caido } from "@caido/sdk-frontend";
import { escapeLayoutText, type LayoutIssue } from "../lib/layout";
import type { CatalogView, EntryView, LayoutCatalog, LayoutFile, StagedChange } from "../lib/layout/catalog";

const props = defineProps({
  // Injected by the SDK into every custom settings component.
  sdk: { type: Object as PropType<Caido>, required: true },
  catalog: { type: Object as PropType<LayoutCatalog>, required: true },
});

const view = shallowRef<CatalogView>(props.catalog.view());
const staged = shallowRef<StagedChange | null>(null);
const stagedIssues = shallowRef<readonly LayoutIssue[]>([]);
/** Index of the valid entry whose removal scope is being chosen. */
const choosingScope = ref<number | null>(null);
const error = ref("");
const busy = ref(false);
const installInput = ref<HTMLInputElement | null>(null);
const importInput = ref<HTMLInputElement | null>(null);

const shown = (value: string) => escapeLayoutText(value);
const removeDetail =
  "Selections that use this layout show: layout unavailable (removed or replaced): choose a decoder. No selection falls back to Auto.";

let unsubscribe: (() => void) | undefined;
onMounted(() => {
  unsubscribe = props.catalog.subscribe(() => (view.value = props.catalog.view()));
  view.value = props.catalog.view();
});
onBeforeUnmount(() => unsubscribe?.());

function clearStaged() {
  staged.value = null;
  stagedIssues.value = [];
}

async function stage(kind: "install" | "import", file: LayoutFile | undefined) {
  if (!file) return;
  busy.value = true;
  error.value = "";
  const result = kind === "install" ? await props.catalog.stageFile(file) : await props.catalog.stageImport(file);
  busy.value = false;
  if (result.ok) {
    staged.value = result.change;
    stagedIssues.value = [];
  } else {
    staged.value = null;
    stagedIssues.value = result.issues;
  }
}

async function onInstallPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  await stage("install", file);
}

async function onImportPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  await stage("import", file);
}

/** The button the user clicks is the confirmation; replacing an entry is only reached through it. */
async function confirmStaged() {
  if (!staged.value) return;
  busy.value = true;
  const result = await props.catalog.commit(staged.value, { confirmed: true });
  busy.value = false;
  if (result.ok) {
    clearStaged();
    error.value = "";
  } else {
    error.value = result.error;
  }
}

async function removeEntry(entry: EntryView) {
  busy.value = true;
  const result = await props.catalog.remove(entry);
  busy.value = false;
  choosingScope.value = null;
  error.value = result.ok ? "" : result.error;
}

function exportCatalog() {
  const blob = new Blob([props.catalog.exportText()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "wireglass-layouts.json";
  link.click();
  URL.revokeObjectURL(url);
}

function describeIssue(issue: LayoutIssue) {
  return `${shown(issue.pointer || "/")}: ${shown(issue.message)}`;
}
</script>

<template>
  <section class="wg-layouts">
    <header>
      <h2 class="wg-title">Layouts</h2>
      <p class="wg-muted">
        Layouts describe custom frame formats. They are stored once per Caido instance, not per project. A layout is used only when you
        choose it in the message inspector.
      </p>
    </header>

    <div class="wg-row-actions">
      <button class="wg-button" :disabled="busy || !view.ready" @click="installInput?.click()">Install layout…</button>
      <button class="wg-button" :disabled="busy || !view.ready" @click="importInput?.click()">Import catalog…</button>
      <button class="wg-button" :disabled="busy || !view.ready" @click="exportCatalog">Export catalog</button>
      <input ref="installInput" class="wg-hidden" type="file" accept=".json,application/json" @change="onInstallPicked" />
      <input ref="importInput" class="wg-hidden" type="file" accept=".json,application/json" @change="onImportPicked" />
    </div>

    <p v-if="view.readError" class="wg-error" role="alert">
      The stored catalog could not be read: {{ shown(view.readError) }}. Changes are blocked until storage works.
    </p>
    <p v-if="view.envelopeError" class="wg-error" role="alert">{{ view.envelopeError }}</p>
    <p v-if="error" class="wg-error" role="alert">{{ shown(error) }}</p>

    <div v-if="stagedIssues.length" class="wg-panel" role="alert">
      <p class="wg-error">Not installed. Nothing changed.</p>
      <ul class="wg-issues">
        <li v-for="(issue, i) in stagedIssues" :key="i">{{ describeIssue(issue) }}</li>
      </ul>
      <div class="wg-row-actions">
        <button class="wg-button" @click="clearStaged">Dismiss</button>
      </div>
    </div>

    <div v-if="staged" class="wg-panel">
      <p v-if="staged.kind === 'install'">Install this layout?</p>
      <p v-else>Import {{ staged.items.length }} layout(s). Entries with the same ID are replaced; other installed layouts stay.</p>
      <ul class="wg-list">
        <li v-for="item in staged.items" :key="item.layout.id">
          <span class="wg-name">{{ shown(item.layout.name) }}</span>
          <span class="wg-muted">{{ shown(item.layout.id) }} · v{{ item.layout.version }}</span>
          <span v-if="item.replaces" class="wg-replace">
            Replaces {{ shown(item.replaces.name) }} v{{ item.replaces.version }} with v{{ item.layout.version }}. The old definition is lost.
          </span>
        </li>
      </ul>
      <div class="wg-row-actions">
        <button class="wg-button wg-primary" :disabled="busy" @click="confirmStaged">
          {{ staged.items.some((item) => item.replaces) ? "Replace" : "Install" }}
        </button>
        <button class="wg-button" :disabled="busy" @click="clearStaged">Cancel</button>
      </div>
    </div>

    <div class="wg-panel">
      <h3 class="wg-subtitle">Installed</h3>
      <p v-if="view.ready && view.entries.length === 0" class="wg-muted">No layouts installed.</p>
      <ul class="wg-list">
        <li v-for="entry in view.entries" :key="entry.index">
          <template v-if="entry.status === 'valid'">
            <div class="wg-entry-head">
              <span class="wg-name">{{ shown(entry.name) }}</span>
              <span class="wg-muted">{{ shown(entry.id) }} · v{{ entry.version }}</span>
              <button class="wg-button wg-end" :disabled="busy" @click="choosingScope = choosingScope === entry.index ? null : entry.index">
                Remove…
              </button>
            </div>
            <div v-if="choosingScope === entry.index" class="wg-remove">
              <span class="wg-muted">{{ removeDetail }}</span>
              <button class="wg-button" :disabled="busy" @click="removeEntry(entry)">Remove definition</button>
              <button class="wg-button" @click="choosingScope = null">Cancel</button>
            </div>
          </template>
          <template v-else>
            <div class="wg-entry-head">
              <span class="wg-error">Entry {{ entry.index }} is invalid{{ entry.id ? `: ${shown(entry.id)}` : "" }}</span>
              <button class="wg-button wg-end" :disabled="busy" @click="removeEntry(entry)">Remove entry</button>
            </div>
            <ul class="wg-issues">
              <li v-for="(issue, i) in entry.issues" :key="i">{{ describeIssue(issue) }}</li>
            </ul>
          </template>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.wg-layouts {
  --wg-fg: #edeae8;
  --wg-fg-muted: rgb(255 255 255 / 0.6);
  --wg-fg-strong: rgb(255 255 255 / 0.8);
  --wg-surface: #25272d;
  --wg-border: #484c56;
  --wg-outline: #616161;
  --wg-primary: rgb(205 50 81 / 0.8);
  --wg-radius: 5.25px;
  --wg-mono: Menlo, Monaco, Consolas, monospace;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  color: var(--wg-fg);
  font-size: 14px;
}
.wg-title {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 600;
}
.wg-subtitle {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}
.wg-muted {
  color: var(--wg-fg-muted);
  font-size: 12.25px;
}
.wg-row-actions,
.wg-entry-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}
.wg-end {
  margin-left: auto;
}
.wg-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10.5px;
  border: 1px solid var(--wg-border);
  border-radius: var(--wg-radius);
  background: var(--wg-surface);
}
.wg-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wg-list li {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--wg-border);
}
.wg-list li:last-child {
  border-bottom: 0;
}
.wg-name {
  font-weight: 600;
}
.wg-replace {
  font-size: 12.25px;
}
.wg-remove,
.wg-scope {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  font-size: 12.25px;
}
.wg-issues {
  margin: 0;
  padding-left: 18px;
  font-family: var(--wg-mono);
  font-size: 12.25px;
  color: var(--wg-fg-muted);
  overflow-wrap: anywhere;
}
.wg-error {
  margin: 0;
  color: #f28b82;
}
.wg-hidden {
  display: none;
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
:deep(button:focus-visible) {
  outline: 1px solid var(--wg-fg-muted);
  outline-offset: 1px;
}
</style>
