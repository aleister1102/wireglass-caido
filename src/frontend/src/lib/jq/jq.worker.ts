import { loadJq, type Jq } from "jq-wasm";
import { JQ_MEMORY_INITIAL_PAGES, JQ_MEMORY_MAXIMUM_PAGES, type JqInit, type JqRequest, type JqResponse } from "./contract";
import { executeJq } from "./execute";
import { setMemoryPages } from "./wasmMemory";

let wasm: Uint8Array | null = null;
let jq: Promise<Jq> | null = null;

self.onmessage = async (event: MessageEvent<JqInit | JqRequest>) => {
  if ("wasm" in event.data) {
    wasm = setMemoryPages(new Uint8Array(event.data.wasm), JQ_MEMORY_INITIAL_PAGES, JQ_MEMORY_MAXIMUM_PAGES);
    return;
  }
  const { id, input, query } = event.data;
  let response: JqResponse;
  try {
    if (!wasm) throw new Error("jq worker received a query before jq.wasm");
    jq ??= loadJq({ wasmBinary: wasm });
    response = { id, outcome: executeJq(await jq, input, query) };
  } catch (error) {
    jq = null;
    response = { id, outcome: { status: "error", message: error instanceof Error ? error.message : String(error) } };
  }
  self.postMessage(response);
};
