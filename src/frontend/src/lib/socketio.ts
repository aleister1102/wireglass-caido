import { kindOf, validateJson, type JsonKind } from "./json";

// Engine.IO v4 and Socket.IO v5 text grammar:
// https://socket.io/docs/v4/engine-io-protocol/ and socket.io-protocol v5-current.md

export const ENGINE_TYPES = ["open", "close", "ping", "pong", "message", "upgrade", "noop"] as const;
export type EngineType = (typeof ENGINE_TYPES)[number];

export const SOCKET_TYPES = ["CONNECT", "DISCONNECT", "EVENT", "ACK", "CONNECT_ERROR", "BINARY_EVENT", "BINARY_ACK"] as const;
export type SocketType = (typeof SOCKET_TYPES)[number];

export type JsonSlice = { text: string; offset: number; kind: JsonKind };

type Parsed = { slice: JsonSlice; value: unknown };

export type SocketPacket = {
  type: SocketType;
  namespace: string;
  ackId?: string;
  attachments?: number;
  placeholders?: number;
  eventName?: string;
  payload?: JsonSlice;
};

export type EnginePacket = {
  type: EngineType;
  /** Text after the type digit for packets other than `message` (for example `probe`). */
  data?: string;
  /** JSON handshake of an `open` packet. */
  handshake?: JsonSlice;
  socket?: SocketPacket;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string; offset: number };

function fail<T>(message: string, offset: number): ParseResult<T> {
  return { ok: false, message, offset };
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function jsonAt(text: string, offset: number): ParseResult<Parsed> {
  const body = text.slice(offset);
  const validation = validateJson(body);
  if (!validation.ok) return fail(`Invalid JSON payload: ${validation.message}`, offset + validation.offset);
  return { ok: true, value: { slice: { text: body, offset, kind: kindOf(validation.value) }, value: validation.value } };
}

function isPlaceholder(value: object): boolean {
  const keys = Object.keys(value);
  if (keys.length !== 2) return false;
  const record = value as Record<string, unknown>;
  return record._placeholder === true && typeof record.num === "number";
}

function countPlaceholders(root: unknown): number {
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
    } else if (isPlaceholder(value)) {
      count += 1;
    } else {
      for (const key in value) stack.push((value as Record<string, unknown>)[key]);
    }
  }
  return count;
}

export function parseSocketPacket(text: string, base = 0): ParseResult<SocketPacket> {
  let i = 0;
  const typeIndex = Number(text[i]);
  if (!isDigit(text[i]) || typeIndex > 6) return fail("Expected a Socket.IO packet type digit 0-6", base);
  const type = SOCKET_TYPES[typeIndex]!;
  i += 1;
  const packet: SocketPacket = { type, namespace: "/" };

  if (type === "BINARY_EVENT" || type === "BINARY_ACK") {
    const start = i;
    while (isDigit(text[i])) i += 1;
    if (i === start || text[i] !== "-") return fail("Expected attachment count followed by '-'", base + i);
    packet.attachments = Number(text.slice(start, i));
    i += 1;
  }

  if (text[i] === "/") {
    const comma = text.indexOf(",", i);
    if (comma === -1) return fail("Namespace must end with ','", base + text.length);
    packet.namespace = text.slice(i, comma);
    i = comma + 1;
  }

  if (isDigit(text[i])) {
    const start = i;
    while (isDigit(text[i])) i += 1;
    packet.ackId = text.slice(start, i);
  }

  const hasPayload = i < text.length;
  let payload: JsonSlice | undefined;
  let value: unknown;
  if (hasPayload) {
    const parsed = jsonAt(text, i);
    if (!parsed.ok) return fail(parsed.message, base + parsed.offset);
    payload = { ...parsed.value.slice, offset: base + parsed.value.slice.offset };
    value = parsed.value.value;
    packet.payload = payload;
  }

  const kind = payload?.kind;
  switch (type) {
    case "CONNECT":
      if (payload && kind !== "object") return fail("CONNECT payload must be an object", base + i);
      if (packet.ackId) return fail("CONNECT does not take an acknowledgment ID", base + i);
      break;
    case "DISCONNECT":
      if (payload || packet.ackId) return fail("DISCONNECT has no payload or acknowledgment ID", base + i);
      break;
    case "CONNECT_ERROR":
      if (kind !== "object") return fail("CONNECT_ERROR payload must be an object", base + i);
      break;
    case "EVENT":
    case "BINARY_EVENT": {
      if (kind !== "array") return fail(`${type} payload must be an array`, base + i);
      const first = (value as unknown[])[0];
      if (typeof first !== "string") return fail(`${type} payload must start with the event name string`, base + i);
      packet.eventName = first;
      break;
    }
    case "ACK":
    case "BINARY_ACK":
      if (!packet.ackId) return fail(`${type} requires an acknowledgment ID`, base + i);
      if (kind !== "array") return fail(`${type} payload must be an array`, base + i);
      break;
  }
  if (packet.attachments !== undefined && payload) {
    packet.placeholders = countPlaceholders(value);
  }
  return { ok: true, value: packet };
}

export function parseEnginePacket(text: string): ParseResult<EnginePacket> {
  const typeIndex = Number(text[0]);
  if (!isDigit(text[0]) || typeIndex > 6) return fail("Expected an Engine.IO packet type digit 0-6", 0);
  const type = ENGINE_TYPES[typeIndex]!;
  const rest = text.slice(1);

  switch (type) {
    case "open": {
      const handshake = jsonAt(text, 1);
      if (!handshake.ok) return fail(handshake.message, handshake.offset);
      if (handshake.value.slice.kind !== "object") return fail("open handshake must be an object", 1);
      return { ok: true, value: { type, handshake: handshake.value.slice } };
    }
    case "message": {
      const socket = parseSocketPacket(rest, 1);
      if (!socket.ok) return socket;
      return { ok: true, value: { type, socket: socket.value } };
    }
    case "ping":
    case "pong":
      if (rest !== "" && rest !== "probe") return fail(`${type} carries no data other than 'probe'`, 1);
      return { ok: true, value: rest ? { type, data: rest } : { type } };
    default:
      if (rest !== "") return fail(`${type} packet carries no data`, 1);
      return { ok: true, value: { type } };
  }
}
