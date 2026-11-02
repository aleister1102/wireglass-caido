import type { Jq } from "jq-wasm/inline";
import { JQ_INPUT_MAX_BYTES, JQ_OUTPUT_MAX_BYTES, type JqOutcome } from "./contract";

const encoder = new TextEncoder();

export function executeJq(jq: Jq, input: string, query: string): JqOutcome {
  const inputBytes = encoder.encode(input).byteLength;
  if (inputBytes > JQ_INPUT_MAX_BYTES) return { status: "limit", limit: "input", bytes: inputBytes, maxBytes: JQ_INPUT_MAX_BYTES };
  const start = performance.now();
  let result;
  try {
    result = jq.raw(input, query);
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const outputBytes = encoder.encode(result.stdout).byteLength + encoder.encode(result.stderr).byteLength;
  if (outputBytes > JQ_OUTPUT_MAX_BYTES) return { status: "limit", limit: "output", bytes: outputBytes, maxBytes: JQ_OUTPUT_MAX_BYTES };
  return { status: "ok", exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: performance.now() - start };
}
