import type { Caido } from "@caido/sdk-frontend";
import * as glue from "lz4-wasm/lz4_wasm_bg.js";
import { decodeLz4Bytes, type Decoded } from "./decode";

export const LZ4_WASM_ASSET = "lz4_wasm_bg.wasm";

export type Lz4Result = { ok: true; bytes: Uint8Array } | { ok: false; message: string };

/** LZ4 cannot expand one compressed byte to more than 255 bytes. */
const MAX_RATIO = 255;

/** Decompresses a frame laid out as a 4-byte big-endian decompressed size followed by one raw LZ4 block. */
export async function decompressSizedBlock(module: WebAssembly.Module, frame: Uint8Array): Promise<Lz4Result> {
  if (frame.length < 4) return { ok: false, message: `The frame has ${frame.length} byte(s); the size prefix needs 4` };
  const size = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  const limit = (frame.length - 4) * MAX_RATIO;
  if (size > limit) return { ok: false, message: `The size prefix declares ${size} bytes; a ${frame.length - 4} byte LZ4 block holds at most ${limit}` };
  // lz4_flex reads the size prefix as little-endian.
  const input = new Uint8Array(frame.length);
  new DataView(input.buffer).setUint32(0, size, true);
  input.set(frame.subarray(4), 4);
  // A fresh instance per frame frees its memory afterwards and is unaffected by an earlier trap.
  const instance = await WebAssembly.instantiate(module, { "./lz4_wasm_bg.js": glue });
  glue.__wbg_set_wasm(instance.exports);
  try {
    return { ok: true, bytes: glue.decompress(input) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `LZ4 block could not be decompressed to the declared ${size} bytes: ${reason}` };
  }
}

let compiled: Promise<WebAssembly.Module> | undefined;

/** Compiles the packaged lz4 wasm once; a failed load is retried on the next call. */
export function loadLz4Module(sdk: Caido): Promise<WebAssembly.Module> {
  compiled ??= (async () => WebAssembly.compile(await (await sdk.assets.get(LZ4_WASM_ASSET)).asArrayBuffer()))().catch((error: unknown) => {
    compiled = undefined;
    throw error;
  });
  return compiled;
}

const encoder = new TextEncoder();

/**
 * The frontend SDK decodes `Blob` as UTF-8 and keeps each invalid byte `b` as the lone surrogate
 * `U+DC00 + b`. Valid UTF-8 never yields a lone surrogate, so the bytes can be restored exactly.
 */
export function blobBytes(text: string): Uint8Array {
  // A UTF-16 unit encodes to at most 3 UTF-8 bytes.
  const out = new Uint8Array(text.length * 3);
  let n = 0;
  let run = 0;
  const flush = (end: number) => {
    if (run < end) n += encoder.encodeInto(text.slice(run, end), out.subarray(n)).written;
  };
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    }
    if (unit >= 0xdc80 && unit <= 0xdcff) {
      flush(i);
      out[n++] = unit - 0xdc00;
      run = i + 1;
    }
  }
  flush(text.length);
  return out.slice(0, n);
}

/** Exact frame bytes of one message edit, read from Caido rather than from the editor text. */
export async function readFrameBytes(sdk: Caido, editId: string): Promise<Uint8Array> {
  const result = await sdk.graphql.websocketMessageEdit({ id: editId });
  const raw = result.streamWsMessageEdit?.raw;
  if (raw === undefined) throw new Error(`Caido returned no message edit ${editId}`);
  return blobBytes(raw);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const failure = (message: string): Decoded => ({ kind: "error", mode: "lz4", decoder: "lz4", message });

/** Returns undefined when `isCurrent` turns false before decompression starts. */
export async function decodeLz4Frame(sdk: Caido, editId: string, isCurrent: () => boolean = () => true): Promise<Decoded | undefined> {
  const [module, frame] = await Promise.allSettled([loadLz4Module(sdk), readFrameBytes(sdk, editId)]);
  if (module.status === "rejected") return failure(`Could not load the LZ4 decoder: ${errorText(module.reason)}`);
  if (frame.status === "rejected") return failure(`Could not read the frame bytes: ${errorText(frame.reason)}`);
  if (!isCurrent()) return undefined;
  try {
    return decodeLz4Bytes(frame.value.length, await decompressSizedBlock(module.value, frame.value));
  } catch (error) {
    return failure(`Could not start the LZ4 decoder: ${errorText(error)}`);
  }
}
