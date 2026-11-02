import { compactJson, prettyJson } from "./json";
import { isLayoutMode, labelFor, payloadOf, payloadOffsetInOriginal, type Decoded } from "./decode";
import { escapeLayoutText } from "./layout/display";
import type { Preset } from "./session";

export type PresetView =
  | { available: true; text: string; jsonFrom: number | null; wrap: boolean }
  | { available: false; reason: string };

/** Exact frame bytes for the Hex preset, read from Caido when that preset is shown. */
export type HexState = { kind: "pending" } | { kind: "ok"; text: string; plain: string } | { kind: "error"; message: string };

export const LAYOUT_UNAVAILABLE_TEXT = "layout unavailable (removed or replaced): choose a decoder";

export function presetAvailable(decoded: Decoded, preset: Preset): boolean {
  return preset === "original" || preset === "wrapped" || preset === "hex" || payloadOf(decoded) !== undefined;
}

/** Preset shown before the user chooses one: Pretty JSON when there is a JSON payload. */
export function defaultPreset(decoded: Decoded): Preset {
  return payloadOf(decoded) === undefined ? "wrapped" : "pretty";
}

export function renderPreset(original: string, decoded: Decoded, preset: Preset, hex?: HexState): PresetView {
  const payload = payloadOf(decoded);
  if (preset === "hex") {
    if (hex?.kind === "ok") return { available: true, wrap: false, text: hex.text, jsonFrom: null };
    return { available: false, reason: hex?.kind === "error" ? hex.message : "Reading the frame bytes…" };
  }
  if (preset === "original" || preset === "wrapped") {
    return { available: true, wrap: preset === "wrapped", text: original, jsonFrom: payloadOffsetInOriginal(decoded) };
  }
  if (decoded.kind === "pending") return { available: false, reason: "Reading the frame bytes…" };
  if (decoded.kind === "unavailable") return { available: false, reason: LAYOUT_UNAVAILABLE_TEXT };
  if (!payload) return { available: false, reason: "This message has no decoded JSON payload. Choose a decoder that finds one, or use an original preset." };
  if (preset === "pretty") return { available: true, wrap: true, text: prettyJson(payload.text), jsonFrom: 0 };
  return { available: true, wrap: false, text: compactJson(payload.text), jsonFrom: 0 };
}

/** Payload text as the current preset presents it; undefined when there is no payload. */
export function payloadCopyText(decoded: Decoded, preset: Preset): string | undefined {
  const payload = payloadOf(decoded);
  if (!payload) return undefined;
  if (preset === "pretty") return prettyJson(payload.text);
  if (preset === "compact") return compactJson(payload.text);
  return payload.text;
}

const RAW_REASONS: Record<Extract<Decoded, { kind: "raw" }>["reason"], string> = {
  chosen: "Raw (not parsed)",
  "no-format": "Auto: no supported format; shown as raw text",
  "binary-frame": "Auto: binary frame, not parsed; choose a decoder",
};

export type Fact = { key: string; label: string; value: string };

/** Layout text is shown escaped; built-in text is already fixed by this app. */
function layoutSafe(value: string): string {
  return escapeLayoutText(value);
}

export function describeDecoded(text: string, decoded: Decoded): Fact[] {
  switch (decoded.kind) {
    case "raw":
      return [{ key: "decoder", label: "Decoder", value: RAW_REASONS[decoded.reason] }];
    case "pending":
      return [{ key: "decoder", label: "Decoder", value: `${labelFor(decoded.mode)}: reading frame bytes` }];
    case "unavailable":
      return [
        { key: "decoder", label: "Decoder", value: labelFor(decoded.mode) },
        { key: "unavailable", label: "Layout", value: LAYOUT_UNAVAILABLE_TEXT },
      ];
    case "error": {
      const message = isLayoutMode(decoded.decoder) ? layoutSafe(decoded.message) : decoded.message;
      const at =
        decoded.byteOffset !== undefined
          ? ` at byte ${decoded.byteOffset}`
          : decoded.offset !== undefined
            ? ` at character ${[...text.slice(0, decoded.offset)].length + 1}`
            : "";
      return [
        { key: "decoder", label: "Decoder", value: labelFor(decoded.decoder, decoded.layoutName) },
        { key: "error", label: "Error", value: `${message}${at}` },
      ];
    }
    case "layout": {
      const facts: Fact[] = [
        { key: "decoder", label: "Decoder", value: labelFor(decoded.mode, decoded.layoutName) },
        { key: "frame", label: "Frame", value: `${decoded.frameByteRange.length} bytes` },
      ];
      for (const field of decoded.header) {
        facts.push({ key: `field:${field.name}`, label: layoutSafe(field.name), value: layoutSafe(field.display) });
      }
      for (const record of decoded.records) {
        const name = record.name === undefined ? "type not in layout" : layoutSafe(record.name);
        facts.push({
          key: `record:${record.index}`,
          label: `Record ${record.index}`,
          value: `${name}, type ${record.type}, ${record.length} byte(s): ${record.text}`,
        });
      }
      facts.push({ key: "payload", label: "Payload", value: `${decoded.payloadLength} byte(s)` });
      return facts;
    }
    case "lz4":
      return [
        { key: "decoder", label: "Decoder", value: labelFor("lz4") },
        { key: "frame", label: "Frame", value: `${decoded.frameBytes} bytes` },
        { key: "decompressed", label: "Decompressed", value: `${decoded.size} bytes` },
      ];
    case "json":
      return [{ key: "decoder", label: "Decoder", value: decoded.mode === "auto" ? "Auto: JSON" : "JSON" }];
    case "socketio": {
      const { packet } = decoded;
      const facts: Fact[] = [
        { key: "decoder", label: "Decoder", value: decoded.mode === "auto" ? "Auto: Socket.IO" : "Socket.IO" },
        { key: "engine", label: "Engine.IO", value: packet.type },
      ];
      if (packet.data !== undefined) facts.push({ key: "data", label: "Data", value: packet.data });
      const socket = packet.socket;
      if (socket) {
        facts.push({ key: "packet", label: "Packet", value: socket.type }, { key: "namespace", label: "Namespace", value: socket.namespace });
        if (socket.eventName !== undefined) facts.push({ key: "event", label: "Event", value: socket.eventName });
        if (socket.ackId !== undefined) facts.push({ key: "ack", label: "Ack ID", value: socket.ackId });
        if (socket.attachments !== undefined) {
          facts.push({
            key: "attachments",
            label: "Attachments",
            value: `${socket.attachments} binary attachment(s) declared, ${socket.placeholders ?? 0} placeholder(s) found. Attachments arrive in separate frames; Wireglass does not reconstruct them.`,
          });
        }
      }
      return facts;
    }
  }
}
