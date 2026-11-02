import { defineConfig } from "@caido-community/dev";
import vue from "@vitejs/plugin-vue";

const RUNTIME_MODULES = new Set(["@codemirror/view", "@codemirror/state", "@codemirror/language", "@lezer/common", "@lezer/highlight", "@lezer/lr"]);

export default defineConfig({
  id: "wireglass",
  name: "Wireglass",
  description: "Read-only WebSocket message inspector",
  version: "0.1.0",
  author: {
    name: "insomnia1102",
    email: "marucube35@gmail.com",
    url: "https://github.com/aleister1102/wireglass-caido",
  },
  plugins: [
    {
      kind: "frontend",
      id: "wireglass-frontend",
      name: "Wireglass",
      root: "./src/frontend",
      // Worker chunk emitted with a stable name by vite.worker.rollupOptions below; jq.wasm is
      // patched and loaded by the worker (see src/frontend/src/lib/jq/jq.worker.ts). The lz4 wasm
      // is compiled on the main thread by src/frontend/src/lib/lz4.ts.
      assets: [
        "./src/frontend/dist/jq.worker.js",
        "./node_modules/jq-wasm/dist/build/jq.wasm",
        "./node_modules/lz4-wasm/lz4_wasm_bg.wasm",
        "./THIRD_PARTY_NOTICES.md",
      ],
      vite: {
        plugins: [vue()],
        // jq-wasm must take its browser path even though Caido exposes process.versions.node.
        define: {
          "process.type": '"renderer"',
        },
        worker: {
          format: "iife",
          rollupOptions: {
            output: {
              entryFileNames: "jq.worker.js",
            },
          },
        },
        build: {
          rollupOptions: {
            // Caido's import map provides these at runtime; bundling second copies breaks Vue
            // reactivity and CodeMirror/lezer identity checks (tags, facets, state fields).
            external: (id: string) =>
              id === "vue" || id.startsWith("vue/") || id.includes("/node_modules/vue/") || RUNTIME_MODULES.has(id),
          },
        },
      },
    },
  ],
});
