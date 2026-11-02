// WebAssembly binary format: https://webassembly.github.io/spec/core/binary/modules.html#memory-section
const MEMORY_SECTION = 5;
const HAS_MAX = 0x01;
export const WASM_PAGE_BYTES = 65_536;

function encodeU32(value: number): number[] {
  const out: number[] = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

class Reader {
  constructor(
    readonly bytes: Uint8Array,
    public pos: number,
  ) {}

  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.bytes[this.pos++];
      if (byte === undefined) throw new Error("Truncated WebAssembly module");
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  }
}

/**
 * Returns a copy of `module` whose single defined memory has the given initial and maximum page counts.
 * Emscripten caps heap growth in JavaScript, so raising the initial size is what lets the module use more memory.
 */
export function setMemoryPages(module: Uint8Array, initialPages: number, maximumPages: number): Uint8Array {
  const reader = new Reader(module, 8);
  while (reader.pos < module.length) {
    const sectionStart = reader.pos;
    const id = module[reader.pos++];
    const size = reader.u32();
    const sectionEnd = reader.pos + size;
    if (id !== MEMORY_SECTION) {
      reader.pos = sectionEnd;
      continue;
    }
    const count = reader.u32();
    if (count !== 1) throw new Error(`Expected one memory, found ${count}`);
    const flags = module[reader.pos++]!;
    if ((flags & ~HAS_MAX) !== 0) throw new Error(`Unsupported memory flags ${flags}`);
    reader.u32();
    if (flags & HAS_MAX) reader.u32();
    const body = [...encodeU32(1), flags | HAS_MAX, ...encodeU32(initialPages), ...encodeU32(maximumPages)];
    const tail = module.subarray(reader.pos, sectionEnd);
    const header = [MEMORY_SECTION, ...encodeU32(body.length + tail.length)];
    const out = new Uint8Array(sectionStart + header.length + body.length + tail.length + (module.length - sectionEnd));
    out.set(module.subarray(0, sectionStart));
    let at = sectionStart;
    out.set(header, at);
    at += header.length;
    out.set(body, at);
    at += body.length;
    out.set(tail, at);
    at += tail.length;
    out.set(module.subarray(sectionEnd), at);
    return out;
  }
  throw new Error("WebAssembly module defines no memory");
}
