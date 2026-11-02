<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { jsonHighlight } from "../lib/jsonLanguage";

const props = defineProps<{
  text: string;
  /** Document offset where JSON starts; null shows plain text. */
  jsonFrom: number | null;
  wrap: boolean;
}>();

const host = ref<HTMLElement>();
let view: EditorView | undefined;

const theme = EditorView.theme(
  {
    "&": { color: "#edeae8", backgroundColor: "transparent", fontSize: "12.6px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "Menlo, Monaco, Consolas, monospace", lineHeight: "1.4", overflow: "visible" },
    ".cm-content": { padding: "4px 0" },
    ".cm-line": { padding: "0 10.5px" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgb(255 255 255 / 0.15)" },
  },
  { dark: true },
);

function createState(): EditorState {
  const extensions: Extension[] = [EditorState.readOnly.of(true), theme];
  if (props.wrap) extensions.push(EditorView.lineWrapping);
  if (props.jsonFrom !== null) extensions.push(jsonHighlight(props.jsonFrom));
  return EditorState.create({ doc: props.text, extensions });
}

onMounted(() => {
  view = new EditorView({ state: createState(), parent: host.value! });
});

watch(
  () => [props.text, props.jsonFrom, props.wrap],
  () => view?.setState(createState()),
);

onBeforeUnmount(() => view?.destroy());
</script>

<template>
  <div ref="host" class="wg-code" />
</template>

<style scoped>
.wg-code {
  user-select: text;
}
</style>
