import type { EditorView } from "@codemirror/view";
import type { StreamWsMessageMeta } from "@caido/sdk-frontend/src/types/types/websocket";

export type MessageSnapshot = {
  messageId: string;
  editId: string;
  direction: StreamWsMessageMeta["head"]["direction"];
  format: StreamWsMessageMeta["head"]["format"];
  length: number;
  createdAt: Date;
  content: string;
};

export function snapshotMessage(message: StreamWsMessageMeta, view: Pick<EditorView, "state">): MessageSnapshot {
  return {
    messageId: message.id,
    editId: message.head.id,
    direction: message.head.direction,
    format: message.head.format,
    length: message.head.length,
    createdAt: message.head.createdAt,
    content: view.state.doc.toString(),
  };
}

/** Text frames, and binary frames for decoders that read the frame bytes. */
export function isInspectable(message: StreamWsMessageMeta): boolean {
  return message.head.format === "TEXT" || message.head.format === "BINARY";
}

// Caido's WS History labels head.direction SERVER as "To Server" and CLIENT as "To Client".
const DIRECTION_LABELS: Record<MessageSnapshot["direction"], string> = {
  SERVER: "To server",
  CLIENT: "To client",
};

export function directionLabel(direction: MessageSnapshot["direction"]): string {
  return DIRECTION_LABELS[direction];
}
