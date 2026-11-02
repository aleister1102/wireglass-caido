// Limits come from measurements recorded in docs/research/jq-wasm-limits.md.
export const JQ_INPUT_MAX_BYTES = 100_000_000;
export const JQ_OUTPUT_MAX_BYTES = 200_000_000;
export const JQ_TIMEOUT_MS = 15_000;
/** Initial jq-wasm memory: 2 GiB. jq-wasm refuses to grow its heap past 256 MiB, so this is the usable size. */
export const JQ_MEMORY_INITIAL_PAGES = 32_768;
export const JQ_MEMORY_MAXIMUM_PAGES = 65_536;

/** First message to a new worker: the unmodified jq.wasm module bytes. */
export type JqInit = { wasm: ArrayBuffer };

export type JqRequest = { id: number; input: string; query: string };

export type JqOutcome =
  | { status: "ok"; exitCode: number; stdout: string; stderr: string; durationMs: number }
  | { status: "cancelled" }
  | { status: "timeout"; limitMs: number }
  | { status: "limit"; limit: "input" | "output"; bytes: number; maxBytes: number }
  | { status: "error"; message: string };

export type JqResponse = { id: number; outcome: JqOutcome };
