<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type PropType } from "vue";
import CodeView from "./CodeView.vue";
import { splitJsonSequence } from "../lib/json";
import type { JqOutcome } from "../lib/jq/contract";
import type { JqRunner } from "../lib/jq/runner";
import { copyText } from "../lib/clipboard";

const props = defineProps({
  runner: { type: Object as PropType<JqRunner>, required: true },
  /** Complete decoded JSON payload, or undefined when the message has none. */
  input: { type: String as PropType<string | undefined>, default: undefined },
  /** Identity of the selected message; a change cancels the run and clears its result. */
  selectionKey: { type: String, required: true },
});

const query = ref(".");
const running = ref(false);
const outcome = ref<JqOutcome | null>(null);
const copied = ref<"" | "ok" | "failed">("");
let runSeq = 0;

async function run() {
  if (props.input === undefined) return;
  const token = ++runSeq;
  running.value = true;
  outcome.value = null;
  copied.value = "";
  const result = await props.runner.run(props.input, query.value);
  if (token !== runSeq) return;
  running.value = false;
  outcome.value = result;
}

function cancel() {
  props.runner.cancel();
}

watch(
  () => [props.selectionKey, props.input],
  () => {
    runSeq++;
    props.runner.cancel();
    running.value = false;
    outcome.value = null;
    copied.value = "";
  },
);

onBeforeUnmount(() => props.runner.dispose());

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void run();
  }
}

const stdoutView = computed(() => {
  const o = outcome.value;
  if (o?.status !== "ok" || o.stdout === "") return null;
  return { text: o.stdout, jsonFrom: splitJsonSequence(o.stdout) === null ? null : 0 };
});

const status = computed(() => {
  const o = outcome.value;
  if (running.value) return "Running…";
  if (!o) return "";
  switch (o.status) {
    case "ok":
      return `Exit ${o.exitCode} | ${o.durationMs.toFixed(0)} ms${o.stdout === "" ? " | No output" : ""}`;
    case "cancelled":
      return "Cancelled";
    case "timeout":
      return `Stopped after the ${o.limitMs / 1000} s time limit`;
    case "limit":
      return `${o.limit === "input" ? "Payload" : "Output"} is ${o.bytes} bytes; the limit is ${o.maxBytes} bytes`;
    case "error":
      return `jq failed: ${o.message}`;
  }
});

async function copyResult() {
  const o = outcome.value;
  if (o?.status !== "ok") return;
  copied.value = (await copyText(o.stdout)) ? "ok" : "failed";
}
</script>

<template>
  <section class="wg-jq" data-testid="wireglass-jq">
    <div class="wg-jq-bar">
      <div class="wg-jq-field">
        <span class="wg-jq-addon">jq</span>
        <input
          v-model="query"
          class="wg-jq-input"
          data-testid="wireglass-jq-query"
          spellcheck="false"
          aria-label="jq filter"
          :disabled="input === undefined"
          :placeholder="input === undefined ? 'This message has no JSON payload to query' : 'Filter, for example .[1]'"
          @keydown="onKeydown"
        />
      </div>
      <button v-if="!running" type="button" class="wg-button wg-primary" data-testid="wireglass-jq-run" :disabled="input === undefined" title="Run (Ctrl/Cmd+Enter)" @click="run">Run</button>
      <button v-else type="button" class="wg-button wg-primary" data-testid="wireglass-jq-cancel" @click="cancel">Cancel</button>
    </div>
    <div v-if="outcome || running" class="wg-jq-result">
      <div v-if="outcome?.status === 'ok'" class="wg-jq-out">
        <CodeView v-if="stdoutView" data-testid="wireglass-jq-stdout" :text="stdoutView.text" :json-from="stdoutView.jsonFrom" :wrap="true" />
        <pre v-if="outcome.stderr" class="wg-jq-stderr" data-testid="wireglass-jq-stderr">{{ outcome.stderr }}</pre>
      </div>
      <div class="wg-jq-status-row">
        <span class="wg-jq-status" data-testid="wireglass-jq-status">{{ status }}</span>
        <button type="button" class="wg-button" data-testid="wireglass-jq-copy" :disabled="outcome?.status !== 'ok'" @click="copyResult">
          {{ copied === "ok" ? "Result copied" : copied === "failed" ? "Copy failed" : "Copy result" }}
        </button>
      </div>
    </div>
    <span v-else class="wg-jq-status" hidden data-testid="wireglass-jq-status">{{ status }}</span>
  </section>
</template>

<style scoped>
.wg-jq {
  display: flex;
  flex-direction: column;
  max-height: 45%;
  flex-shrink: 0;
  border-top: 1px solid var(--wg-border);
}
.wg-jq-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px;
}
.wg-jq-field {
  display: flex;
  flex: 1;
  min-width: 8rem;
  height: 32px;
  border: 1px solid var(--wg-border);
  border-radius: var(--wg-radius);
  background: var(--wg-surface);
  overflow: hidden;
}
.wg-jq-addon {
  display: inline-flex;
  align-items: center;
  padding: 0 10.5px;
  border-right: 1px solid var(--wg-border);
  color: var(--wg-fg-muted);
}
.wg-jq-input {
  flex: 1;
  min-width: 0;
  padding: 0 10.5px;
  border: 0;
  background: transparent;
  color: var(--wg-fg-strong);
  font-family: var(--wg-mono);
  font-size: 12.6px;
}
.wg-jq-input:focus-visible {
  outline: none;
}
.wg-jq-field:focus-within {
  border-color: var(--wg-outline);
}
.wg-jq-result {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.wg-jq-out {
  overflow: auto;
  min-height: 4em;
}
.wg-jq-stderr {
  margin: 0;
  padding: 4px 10.5px;
  white-space: pre-wrap;
  color: #f28b82;
  font-family: var(--wg-mono);
  font-size: 12.6px;
}
.wg-jq-status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  padding: 4px 7px 7px 10.5px;
}
.wg-jq-status {
  font-size: 12.25px;
  color: var(--wg-fg-muted);
}
</style>
