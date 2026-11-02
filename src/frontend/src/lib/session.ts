import { reactive, ref } from "vue";
import type { StreamWsMessageMeta } from "@caido/sdk-frontend/src/types/types/websocket";
import type { BuiltinMode } from "./decode";

export const PRESETS = ["original", "wrapped", "pretty", "compact", "hex"] as const;
export type Preset = (typeof PRESETS)[number];

export const PRESET_LABELS: Record<Preset, string> = {
  original: "Original",
  wrapped: "Wrapped original",
  pretty: "Pretty JSON",
  compact: "Compact JSON",
  hex: "Hex",
};

/** One message direction of one stream; CLIENT and SERVER on one stream choose independently. */
export type DecoderScope = { streamId: string; direction: StreamWsMessageMeta["head"]["direction"] };

/**
 * `layoutRevision` is the layout's registry revision when it was chosen. A later install or replace
 * changes the revision, and a removed layout is missing; both make the choice unavailable, never Auto.
 */
export type DecoderChoice = { kind: "builtin"; mode: BuiltinMode } | { kind: "layout"; layoutId: string; layoutRevision: number };

const AUTO: DecoderChoice = { kind: "builtin", mode: "auto" };

/**
 * In-memory viewer state. Decoder choices are keyed by project, stream and direction and are dropped
 * when the project changes; nothing is persisted, so a reload clears them.
 */
export function createSession() {
  const projectId = ref<string | undefined>(undefined);
  const choices = reactive(new Map<string, DecoderChoice>());
  /** The preset the user chose this session; null until they choose one. */
  const preset = ref<Preset | null>(null);

  const keyOf = (scope: DecoderScope) => JSON.stringify([projectId.value ?? null, scope.streamId, scope.direction]);

  return {
    projectId,
    preset,
    decoderFor(scope: DecoderScope): DecoderChoice {
      return choices.get(keyOf(scope)) ?? AUTO;
    },
    setDecoder(scope: DecoderScope, choice: DecoderChoice) {
      const key = keyOf(scope);
      if (choice.kind === "builtin" && choice.mode === "auto") choices.delete(key);
      else choices.set(key, choice);
    },
    changeProject(id: string | undefined) {
      projectId.value = id;
      choices.clear();
    },
    overrideCount: () => choices.size,
  };
}

export type Session = ReturnType<typeof createSession>;

let current: Session | null = null;

export function useSession(): Session {
  current ??= createSession();
  return current;
}
