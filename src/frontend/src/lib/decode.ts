import type { StreamWsMessageMeta } from "@caido/sdk-frontend/src/types/types/websocket";
import { kindOf, validateJson } from "./json";
import type { Lz4Result } from "./lz4";
import { escapeLayoutText } from "./layout/display";
import { parseLayoutFrame, type FieldFact, type LayoutErrorCode, type RecordFact } from "./layout/parse";
import type { Layout } from "./layout/types";
import { parseEnginePacket, type EnginePacket, type JsonSlice } from "./socketio";

export const DECODER_MODES = ["auto", "raw", "json", "socketio", "lz4"] as const;
export type BuiltinMode = (typeof DECODER_MODES)[number];
/** A registry layout's mode, always namespaced so an ID cannot shadow a built-in mode. */
export type LayoutMode = `layout:${string}`;
export type DecoderMode = BuiltinMode | LayoutMode;
/** Decoders that read Caido's message text. The LZ4 and layout decoders read the frame bytes instead. */
export type TextDecoderMode = Exclude<BuiltinMode, "lz4">;

const BUILTIN_LABELS: Record<BuiltinMode, string> = {
  auto: "Auto",
  raw: "Raw",
  json: "JSON",
  socketio: "Socket.IO",
  lz4: "LZ4 block (BE size)",
};

export function layoutMode(id: string): LayoutMode {
  return `layout:${id}`;
}

export function isLayoutMode(mode: DecoderMode): mode is LayoutMode {
  return mode.startsWith("layout:");
}

/** `layoutName` is the registry name; layout text is escaped for display here. */
export function labelFor(mode: DecoderMode, layoutName?: string): string {
  if (!isLayoutMode(mode)) return BUILTIN_LABELS[mode];
  return `Layout: ${escapeLayoutText(layoutName ?? mode.slice("layout:".length))}`;
}

export type FrameByteRange = { start: number; length: number };

/**
 * Result of decoding one message. `payload` is the complete JSON value that presets and jq use.
 * For JSON and Socket.IO it is an exact slice of the original text starting at `payload.offset`;
 * for LZ4 and layouts it is the decoded text, which does not appear in the original.
 */
export type Decoded =
  | { kind: "raw"; mode: DecoderMode; reason: "chosen" | "no-format" | "binary-frame" }
  | { kind: "json"; mode: DecoderMode; payload: JsonSlice }
  | { kind: "socketio"; mode: DecoderMode; packet: EnginePacket; payload?: JsonSlice }
  | { kind: "lz4"; mode: "lz4"; frameBytes: number; size: number; payload: JsonSlice }
  | {
      kind: "layout";
      mode: LayoutMode;
      layoutId: string;
      layoutName: string;
      /** The registry revision of the layout when it was chosen; a mismatch makes the choice unavailable. */
      layoutRevision: number;
      header: FieldFact[];
      records: RecordFact[];
      payloadLength: number;
      payload?: JsonSlice;
      frameByteRange: FrameByteRange;
    }
  | { kind: "pending"; mode: DecoderMode }
  /** A layout choice whose layout was removed or replaced. Nothing falls back to Auto. */
  | { kind: "unavailable"; mode: LayoutMode }
  /**
   * `offset` is a UTF-16 index into the original text (JSON and Socket.IO). `byteOffset` is a byte
   * position in the original frame (layouts only). Neither is used as the other.
   */
  | {
      kind: "error";
      mode: DecoderMode;
      decoder: DecoderMode;
      message: string;
      offset?: number;
      byteOffset?: number;
      code?: LayoutErrorCode;
      layoutName?: string;
    };

function decodeJson(text: string, mode: DecoderMode): Decoded {
  const validation = validateJson(text);
  if (!validation.ok) return { kind: "error", mode, decoder: "json", message: validation.message, offset: validation.offset };
  return { kind: "json", mode, payload: { text, offset: 0, kind: kindOf(validation.value) } };
}

function decodeSocketIo(text: string, mode: DecoderMode): Decoded {
  const parsed = parseEnginePacket(text);
  if (!parsed.ok) return { kind: "error", mode, decoder: "socketio", message: parsed.message, offset: parsed.offset };
  const packet = parsed.value;
  const payload = packet.socket?.payload ?? packet.handshake;
  return payload ? { kind: "socketio", mode, packet, payload } : { kind: "socketio", mode, packet };
}

export function decode(text: string, mode: TextDecoderMode): Decoded {
  switch (mode) {
    case "raw":
      return { kind: "raw", mode, reason: "chosen" };
    case "json":
      return decodeJson(text, mode);
    case "socketio":
      return decodeSocketIo(text, mode);
    case "auto": {
      const json = decodeJson(text, mode);
      if (json.kind === "json") return json;
      const socket = decodeSocketIo(text, mode);
      if (socket.kind === "socketio" && socket.packet.type === "message" && socket.packet.socket?.type === "EVENT") return socket;
      return { kind: "raw", mode, reason: "no-format" };
    }
  }
}

/** Caido's text for a BINARY frame is not guaranteed to equal its bytes, so Auto does not parse it. */
export function decodeText(text: string, mode: TextDecoderMode, format: StreamWsMessageMeta["head"]["format"]): Decoded {
  if (mode === "auto" && format === "BINARY") return { kind: "raw", mode, reason: "binary-frame" };
  return decode(text, mode);
}

/** Decodes the exact frame bytes with a registry layout. `layoutRevision` is the revision the choice was made against. */
export function decodeLayoutFrame(layout: Layout, layoutRevision: number, bytes: Uint8Array): Decoded {
  const mode = layoutMode(layout.id);
  const result = parseLayoutFrame(layout, bytes);
  if (!result.ok) {
    const { code, message, byteOffset } = result.error;
    return { kind: "error", mode, decoder: mode, layoutName: layout.name, code, message, byteOffset };
  }
  const { frame } = result;
  const payload = frame.payload ? { text: frame.payload.text, offset: 0, kind: frame.payload.kind } : undefined;
  return {
    kind: "layout",
    mode,
    layoutId: layout.id,
    layoutName: layout.name,
    layoutRevision,
    header: frame.header,
    records: frame.records,
    payloadLength: frame.payloadLength,
    payload,
    frameByteRange: { start: 0, length: bytes.length },
  };
}

export function decodeLz4Bytes(frameBytes: number, result: Lz4Result): Decoded {
  const error = (message: string): Decoded => ({ kind: "error", mode: "lz4", decoder: "lz4", message });
  if (!result.ok) return error(result.message);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.bytes);
  } catch {
    return error("The decompressed bytes are not valid UTF-8");
  }
  const validation = validateJson(text);
  if (!validation.ok) {
    return error(`The decompressed text is not valid JSON: ${validation.message} at character ${[...text.slice(0, validation.offset)].length + 1}`);
  }
  return { kind: "lz4", mode: "lz4", frameBytes, size: result.bytes.length, payload: { text, offset: 0, kind: kindOf(validation.value) } };
}

export function payloadOf(decoded: Decoded): JsonSlice | undefined {
  return decoded.kind === "json" || decoded.kind === "socketio" || decoded.kind === "lz4" || decoded.kind === "layout" ? decoded.payload : undefined;
}

/** Where the payload starts inside the original text, or null when the original does not contain it. */
export function payloadOffsetInOriginal(decoded: Decoded): number | null {
  return decoded.kind === "json" || decoded.kind === "socketio" ? (decoded.payload?.offset ?? null) : null;
}
