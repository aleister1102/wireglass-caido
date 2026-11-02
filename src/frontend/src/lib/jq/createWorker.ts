import type { Caido } from "@caido/sdk-frontend";
import type { JqInit } from "./contract";
import type { WorkerLike } from "./runner";

export const JQ_WORKER_ASSET = "jq.worker.js";
export const JQ_WASM_ASSET = "jq.wasm";

async function startWorker(worker: WorkerLike, wasm: ArrayBuffer): Promise<WorkerLike> {
  const init: JqInit = { wasm };
  worker.postMessage(init, [wasm]);
  return worker;
}

/** Loads the packaged worker and jq.wasm assets; only a Vite dev server (`import.meta.env.DEV`) uses the source files. */
export async function createJqWorker(sdk: Caido): Promise<WorkerLike> {
  if (import.meta.env.DEV) {
    const { default: wasmUrl } = await import("jq-wasm/jq.wasm?url");
    const wasm = await (await fetch(wasmUrl)).arrayBuffer();
    return startWorker(new Worker(new URL("./jq.worker.ts", import.meta.url), { type: "module" }) as WorkerLike, wasm);
  }
  const [script, wasm] = await Promise.all([sdk.assets.get(JQ_WORKER_ASSET).then((a) => a.asString()), sdk.assets.get(JQ_WASM_ASSET).then((a) => a.asArrayBuffer())]);
  const url = URL.createObjectURL(new Blob([script], { type: "application/javascript" }));
  try {
    return startWorker(new Worker(url) as WorkerLike, wasm);
  } finally {
    URL.revokeObjectURL(url);
  }
}
