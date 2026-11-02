/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { loadJq } from "jq-wasm";
import { JQ_MEMORY_INITIAL_PAGES, JQ_MEMORY_MAXIMUM_PAGES } from "../contract";
import { executeJq } from "../execute";
import { WASM_PAGE_BYTES, setMemoryPages } from "../wasmMemory";

const jqWasm = async () => new Uint8Array(await readFile(createRequire(import.meta.url).resolve("jq-wasm/jq.wasm")));

describe("setMemoryPages", () => {
  it("sets the initial memory of jq.wasm", async () => {
    const patched = setMemoryPages(await jqWasm(), 512, 1024);
    const exported = WebAssembly.Module.exports(new WebAssembly.Module(patched)).find((e) => e.kind === "memory");
    expect(exported).toBeDefined();
    let memory: WebAssembly.Memory | undefined;
    await loadJq({
      instantiateWasm: (imports, onSuccess) => {
        void WebAssembly.instantiate(patched, imports).then(({ instance, module }) => {
          memory = instance.exports[exported!.name] as WebAssembly.Memory;
          onSuccess(instance, module);
        });
      },
    });
    expect(memory!.buffer.byteLength).toBe(512 * WASM_PAGE_BYTES);
  });

  it("lets jq process a 30 MB payload that exceeds the stock 256 MiB heap", async () => {
    const wasm = setMemoryPages(await jqWasm(), JQ_MEMORY_INITIAL_PAGES, JQ_MEMORY_MAXIMUM_PAGES);
    const jq = await loadJq({ wasmBinary: wasm });
    const item = JSON.stringify({ note: "x".repeat(40), tags: ["a", "b"] });
    const count = Math.ceil(30_000_000 / (item.length + 1));
    const input = `[${Array(count).fill(item).join(",")}]`;
    expect(executeJq(jq, input, "length")).toMatchObject({ status: "ok", exitCode: 0, stdout: String(count) });
  }, 30_000);

  it("rejects a module without memory", () => {
    expect(() => setMemoryPages(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), 1, 2)).toThrow("defines no memory");
  });
});
