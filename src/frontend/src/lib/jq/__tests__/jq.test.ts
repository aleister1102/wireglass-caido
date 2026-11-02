import { loadJq, type Jq } from "jq-wasm/inline";
import { executeJq } from "../execute";
import { createJqRunner, type WorkerLike } from "../runner";
import { JQ_INPUT_MAX_BYTES, JQ_OUTPUT_MAX_BYTES, type JqRequest } from "../contract";

let jq: Jq;
beforeAll(async () => {
  jq = await loadJq();
});

describe("executeJq with jq-wasm", () => {
  const payload = '["event",{"n":12345678901234567890,"msg":"x"}]';

  it("receives the complete payload: .[0] is the event name, .[1] the first argument", () => {
    expect(executeJq(jq, payload, ".[0], .[1].n")).toMatchObject({ status: "ok", exitCode: 0, stdout: '"event"\n12345678901234567890' });
  });

  it("returns empty output for empty results", () => {
    expect(executeJq(jq, payload, "empty")).toMatchObject({ status: "ok", stdout: "" });
  });

  it("reports compile and runtime errors on stderr", () => {
    expect(executeJq(jq, payload, ". | foo")).toMatchObject({ status: "ok", exitCode: 3 });
    const runtime = executeJq(jq, payload, 'error("boom")');
    expect(runtime.status === "ok" && runtime.stderr).toContain("boom");
  });

  it("enforces the input limit", () => {
    const big = JSON.stringify("x".repeat(JQ_INPUT_MAX_BYTES));
    expect(executeJq(jq, big, ".")).toMatchObject({ status: "limit", limit: "input" });
  });

  it("counts the input limit in bytes, not characters", () => {
    const text = JSON.stringify("é".repeat(JQ_INPUT_MAX_BYTES / 2));
    expect(text.length).toBeLessThan(JQ_INPUT_MAX_BYTES);
    expect(executeJq(jq, text, ".")).toMatchObject({ status: "limit", limit: "input" });
  });

  it("enforces the output limit", () => {
    const fake = { raw: () => ({ stdout: "x".repeat(JQ_OUTPUT_MAX_BYTES), stderr: "x", exitCode: 0 }) } as unknown as Jq;
    expect(executeJq(fake, "1", ".")).toMatchObject({ status: "limit", limit: "output", bytes: JQ_OUTPUT_MAX_BYTES + 1 });
  });

  it("reports a jq abort as an error", () => {
    const fake = { raw: () => { throw new Error("Aborted()"); } } as unknown as Jq;
    expect(executeJq(fake, "1", ".")).toEqual({ status: "error", message: "Aborted()" });
  });
});

/** Worker double that runs the real executeJq asynchronously, or never answers when `hang` is set. */
function fakeWorker(options: { hang?: boolean } = {}) {
  const created: Array<WorkerLike & { terminated: boolean }> = [];
  const factory = async () => {
    const worker: WorkerLike & { terminated: boolean } = {
      terminated: false,
      onmessage: null,
      onerror: null,
      postMessage(message) {
        const { id, input, query } = message as JqRequest;
        if (options.hang) return;
        setTimeout(() => {
          if (!worker.terminated) worker.onmessage?.({ data: { id, outcome: executeJq(jq, input, query) } } as MessageEvent);
        }, 5);
      },
      terminate() {
        worker.terminated = true;
      },
    };
    created.push(worker);
    return worker;
  };
  return { factory, created };
}

describe("createJqRunner", () => {
  it("runs a query and reuses the worker", async () => {
    const { factory, created } = fakeWorker();
    const runner = createJqRunner(factory);
    expect(await runner.run("[1,2]", ".[0]")).toMatchObject({ status: "ok", stdout: "1" });
    expect(await runner.run("[1,2]", ".[1]")).toMatchObject({ status: "ok", stdout: "2" });
    expect(created).toHaveLength(1);
  });

  it("cancels and terminates the worker", async () => {
    const { factory, created } = fakeWorker({ hang: true });
    const runner = createJqRunner(factory);
    const pending = runner.run("[1]", ".");
    await Promise.resolve();
    runner.cancel();
    expect(await pending).toEqual({ status: "cancelled" });
    await Promise.resolve();
    expect(created[0]?.terminated).toBe(true);
  });

  it("times out", async () => {
    const { factory } = fakeWorker({ hang: true });
    const runner = createJqRunner(factory, 20);
    expect(await runner.run("[1]", ".")).toEqual({ status: "timeout", limitMs: 20 });
  });

  it("a newer run cancels the older one so stale output is never delivered", async () => {
    const { factory } = fakeWorker();
    const runner = createJqRunner(factory);
    const first = runner.run('{"a":1}', ".a");
    const second = runner.run('{"b":2}', ".b");
    expect(await first).toEqual({ status: "cancelled" });
    expect(await second).toMatchObject({ status: "ok", stdout: "2" });
  });

  it("replaces the worker after it reports an error", async () => {
    const created: WorkerLike[] = [];
    const factory = async () => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(message) {
          const { id } = message as JqRequest;
          setTimeout(() => worker.onmessage?.({ data: { id, outcome: created.length === 1 ? { status: "error", message: "Aborted()" } : executeJq(jq, "[1]", ".[0]") } } as MessageEvent), 1);
        },
        terminate: vi.fn(),
      };
      created.push(worker);
      return worker;
    };
    const runner = createJqRunner(factory);
    expect(await runner.run("[1]", ".")).toEqual({ status: "error", message: "Aborted()" });
    expect(created[0]!.terminate).toHaveBeenCalled();
    expect(await runner.run("[1]", ".[0]")).toMatchObject({ status: "ok", stdout: "1" });
    expect(created).toHaveLength(2);
  });
});
