import { decodeLz4Bytes, decodeText } from "../decode";
import { blobBytes, decompressSizedBlock, readFrameBytes } from "../lz4";
import { describeDecoded, renderPreset } from "../view";
import { lz4Module, lz4WasmBytes, sdkBlob, sizedBlock } from "./lz4Fixture";

const JSON_TEXT = '{"status":"OK","correlationId":"83","payload":{"data":[{"name":{"vi":"Vàng","ja":"金"}}],"totalCount":7761}}';

const withSize = (frame: Uint8Array, size: number) => {
  const copy = frame.slice();
  new DataView(copy.buffer).setUint32(0, size, false);
  return copy;
};

describe("decompressSizedBlock", () => {
  it("reads the big-endian size prefix and decompresses the block exactly", async () => {
    const frame = sizedBlock(JSON_TEXT);
    expect(new DataView(frame.buffer).getUint32(0, false)).toBe(new TextEncoder().encode(JSON_TEXT).length);
    const result = await decompressSizedBlock(lz4Module, frame);
    expect(result.ok && new TextDecoder().decode(result.bytes)).toBe(JSON_TEXT);
  });

  it("reports a size prefix that does not match the block", async () => {
    const frame = sizedBlock(JSON_TEXT);
    const size = new DataView(frame.buffer).getUint32(0, false);
    for (const declared of [size - 3, size + 3]) {
      const result = await decompressSizedBlock(lz4Module, withSize(frame, declared));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain(`declared ${declared} bytes`);
    }
  });

  it("reports truncated blocks and frames shorter than the prefix", async () => {
    const frame = sizedBlock(JSON_TEXT);
    expect((await decompressSizedBlock(lz4Module, frame.slice(0, frame.length - 5))).ok).toBe(false);
    expect(await decompressSizedBlock(lz4Module, frame.slice(0, 3))).toEqual({ ok: false, message: "The frame has 3 byte(s); the size prefix needs 4" });
  });

  it("recovers after a declared size the decoder cannot allocate", async () => {
    const frame = sizedBlock(JSON_TEXT);
    expect((await decompressSizedBlock(lz4Module, withSize(frame, 0xffffffff))).ok).toBe(false);
    expect((await decompressSizedBlock(lz4Module, frame)).ok).toBe(true);
  });
});

describe("decodeLz4Bytes", () => {
  it("returns the decompressed JSON as the payload", async () => {
    const frame = sizedBlock(JSON_TEXT);
    const decoded = decodeLz4Bytes(frame.length, await decompressSizedBlock(lz4Module, frame));
    expect(decoded).toMatchObject({ kind: "lz4", frameBytes: frame.length, size: new TextEncoder().encode(JSON_TEXT).length, payload: { text: JSON_TEXT, offset: 0, kind: "object" } });
    expect(describeDecoded("garbled", decoded).map((f) => f.value)).toEqual(["LZ4 block (BE size)", `${frame.length} bytes`, `${new TextEncoder().encode(JSON_TEXT).length} bytes`]);
  });

  it("keeps the original text and does not mark a payload inside it", async () => {
    const frame = sizedBlock(JSON_TEXT);
    const decoded = decodeLz4Bytes(frame.length, await decompressSizedBlock(lz4Module, frame));
    expect(renderPreset("garbled", decoded, "wrapped")).toEqual({ available: true, wrap: true, text: "garbled", jsonFrom: null });
    expect(renderPreset("garbled", decoded, "compact")).toMatchObject({ available: true, text: JSON_TEXT });
  });

  it("reports invalid UTF-8 and invalid JSON after decompression", async () => {
    const binary = sizedBlock(new Uint8Array([0x7b, 0xff, 0x7d]));
    expect(decodeLz4Bytes(binary.length, await decompressSizedBlock(lz4Module, binary))).toMatchObject({ kind: "error", decoder: "lz4", message: "The decompressed bytes are not valid UTF-8" });
    const text = sizedBlock("Vàng, not json");
    const decoded = decodeLz4Bytes(text.length, await decompressSizedBlock(lz4Module, text));
    expect(decoded).toMatchObject({ kind: "error", decoder: "lz4" });
    expect(describeDecoded("garbled", decoded).find((f) => f.key === "error")?.value).toMatch(/^The decompressed text is not valid JSON: .* at character 1$/);
  });
});

describe("readFrameBytes", () => {
  it("reads exact bytes from Caido's message edit, including bytes that are not valid UTF-8", async () => {
    const bytes = new Uint8Array([0, 0, 0x53, 0x41, 0xff, 0x80, 0x7b]);
    const websocketMessageEdit = vi.fn(async () => ({ streamWsMessageEdit: { raw: sdkBlob(bytes) } }));
    expect(await readFrameBytes({ graphql: { websocketMessageEdit } } as never, "7")).toEqual(bytes);
    expect(websocketMessageEdit).toHaveBeenCalledWith({ id: "7" });
  });
});

describe("decodeText on binary frames", () => {
  it("Auto does not parse Caido's text of a binary frame; explicit decoders still do", () => {
    expect(decodeText('{"a":1}', "auto", "BINARY")).toEqual({ kind: "raw", mode: "auto", reason: "binary-frame" });
    expect(decodeText('{"a":1}', "json", "BINARY").kind).toBe("json");
    expect(decodeText('{"a":1}', "auto", "TEXT").kind).toBe("json");
  });
});

describe("blobBytes", () => {
  it("restores invalid bytes the SDK kept as U+DC00 + byte, and encodes the rest as UTF-8", () => {
    expect(blobBytes("\u0000\uDCA3\uDCF6]{\"vi\":\"Vàng\",\"ja\":\"金😀\"}")).toEqual(
      Uint8Array.from([0, 0xa3, 0xf6, ...new TextEncoder().encode(']{"vi":"Vàng","ja":"金😀"}')]),
    );
  });
});

describe("blobBytes round trips", () => {
  it.each([
    ["an escaped byte after a 4-byte character", [0xf0, 0x9f, 0x98, 0x80, 0xff]],
    ["a truncated 4-byte sequence before ASCII", [0xf0, 0x9f, 0x98, 0x41]],
    ["a byte order mark inside the frame", [0x7b, 0xef, 0xbb, 0xbf, 0x7d]],
  ])("%s", (_name, bytes) => {
    expect(blobBytes(sdkBlob(Uint8Array.from(bytes)))).toEqual(Uint8Array.from(bytes));
  });
});

describe("LZ4 limits", () => {
  it("rejects a size prefix larger than the block can hold without decompressing", async () => {
    const frame = withSize(sizedBlock("{}"), 0x7fffffff);
    const result = await decompressSizedBlock(lz4Module, frame);
    expect(result).toEqual({ ok: false, message: `The size prefix declares ${0x7fffffff} bytes; a ${frame.length - 4} byte LZ4 block holds at most ${(frame.length - 4) * 255}` });
  });

  it("keeps a leading byte order mark so the JSON check reports it", async () => {
    const frame = sizedBlock(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
    expect(decodeLz4Bytes(frame.length, await decompressSizedBlock(lz4Module, frame))).toMatchObject({ kind: "error", decoder: "lz4" });
  });
});

describe("decodeLz4Frame", () => {
  const frame = sizedBlock('{"a":1}');
  const sdkWith = (assets: () => Promise<unknown>, raw: string | null = sdkBlob(frame)) =>
    ({
      assets: { get: vi.fn(assets) },
      graphql: { websocketMessageEdit: async () => ({ streamWsMessageEdit: raw === null ? null : { raw } }) },
    }) as never;
  const wasm = async () => ({ asArrayBuffer: async () => lz4WasmBytes().buffer });

  it("reports a failed decoder load and loads again on the next call", async () => {
    vi.resetModules();
    const { decodeLz4Frame } = await import("../lz4");
    const failing = sdkWith(async () => {
      throw new Error("asset missing");
    });
    expect(await decodeLz4Frame(failing, "1")).toEqual({ kind: "error", mode: "lz4", decoder: "lz4", message: "Could not load the LZ4 decoder: asset missing" });
    expect(await decodeLz4Frame(sdkWith(wasm), "1")).toMatchObject({ kind: "lz4", payload: { text: '{"a":1}' } });
  });

  it("reports a missing message edit", async () => {
    const { decodeLz4Frame } = await import("../lz4");
    expect(await decodeLz4Frame(sdkWith(wasm, null), "9")).toMatchObject({ kind: "error", message: "Could not read the frame bytes: Caido returned no message edit 9" });
  });

  it("skips decompression when the message is no longer selected", async () => {
    const { decodeLz4Frame } = await import("../lz4");
    expect(await decodeLz4Frame(sdkWith(wasm), "1", () => false)).toBeUndefined();
  });
});
