import { JQ_TIMEOUT_MS, type JqOutcome, type JqResponse } from "./contract";

export type WorkerLike = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<JqResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

type Active = { id: number; resolve: (outcome: JqOutcome) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Runs one jq query at a time. A new run or cancel() terminates the worker, so a stale query
 * cannot keep running or deliver output for an older request.
 */
export function createJqRunner(createWorker: () => Promise<WorkerLike>, timeoutMs = JQ_TIMEOUT_MS) {
  let worker: Promise<WorkerLike> | null = null;
  let active: Active | null = null;
  let nextId = 0;

  const dispose = () => {
    const pending = worker;
    worker = null;
    void pending?.then((w) => w.terminate(), () => undefined);
  };

  const settle = (id: number, outcome: JqOutcome, terminate: boolean) => {
    if (!active || active.id !== id) return;
    clearTimeout(active.timer);
    const { resolve } = active;
    active = null;
    if (terminate) dispose();
    resolve(outcome);
  };

  const ensureWorker = () => {
    worker ??= createWorker().then((w) => {
      w.onmessage = (event) => settle(event.data.id, event.data.outcome, event.data.outcome.status === "error");
      w.onerror = (event) => {
        if (active) settle(active.id, { status: "error", message: `Worker error: ${event.message}` }, true);
      };
      return w;
    });
    return worker;
  };

  return {
    run(input: string, query: string): Promise<JqOutcome> {
      this.cancel();
      const id = ++nextId;
      return new Promise<JqOutcome>((resolve) => {
        const timer = setTimeout(() => settle(id, { status: "timeout", limitMs: timeoutMs }, true), timeoutMs);
        active = { id, resolve, timer };
        ensureWorker().then(
          (w) => {
            if (active?.id === id) w.postMessage({ id, input, query });
          },
          (error: unknown) => settle(id, { status: "error", message: `Could not start jq worker: ${String(error)}` }, true),
        );
      });
    },
    cancel() {
      if (active) settle(active.id, { status: "cancelled" }, true);
    },
    dispose() {
      this.cancel();
      dispose();
    },
    get running() {
      return active !== null;
    },
  };
}

export type JqRunner = ReturnType<typeof createJqRunner>;
