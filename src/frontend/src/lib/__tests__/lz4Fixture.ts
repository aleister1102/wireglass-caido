import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as glue from "lz4-wasm/lz4_wasm_bg.js";

const wasmPath = createRequire(import.meta.url).resolve("lz4-wasm/lz4_wasm_bg.wasm");
export const lz4WasmBytes = () => new Uint8Array(readFileSync(wasmPath));
export const lz4Module = new WebAssembly.Module(lz4WasmBytes());

/** Frame bytes: 4-byte big-endian decompressed size, then one raw LZ4 block. */
export function sizedBlock(content: string | Uint8Array): Uint8Array {
  glue.__wbg_set_wasm(new WebAssembly.Instance(lz4Module, { "./lz4_wasm_bg.js": glue }).exports);
  const packed = glue.compress(typeof content === "string" ? new TextEncoder().encode(content) : content);
  const view = new DataView(packed.buffer, packed.byteOffset, 4);
  view.setUint32(0, view.getUint32(0, true), false);
  return packed;
}

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The string the frontend SDK returns for a `Blob`: UTF-8 text, each invalid byte `b` as `U+DC00 + b`. */
export function sdkBlob(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; ) {
    const width = [1, 2, 3, 4].find((n) => {
      try {
        strict.decode(bytes.subarray(i, i + n));
        return i + n <= bytes.length;
      } catch {
        return false;
      }
    });
    text += width ? strict.decode(bytes.subarray(i, i + width)) : String.fromCharCode(0xdc00 + bytes[i]!);
    i += width ?? 1;
  }
  return text;
}
