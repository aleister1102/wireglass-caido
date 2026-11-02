# jq-wasm limits

Wireglass runs jq through `jq-wasm` 3.0.0-jq-1.8.2 in a Web Worker. This page records the measurements behind the limits in `src/frontend/src/lib/jq/contract.ts`.

## Memory

The stock `jq.wasm` declares 256 initial and 4096 maximum pages (256 MiB), and the Emscripten JavaScript refuses heap growth past 256 MiB (`getHeapMax`). jq needs about 10-20 times the input size, so stock jq-wasm aborts between 16 MB and 30 MB of input.

Wireglass ships the unmodified `jq.wasm` as a plugin asset. The worker rewrites the module's memory section (`src/frontend/src/lib/jq/wasmMemory.ts`) to 32,768 initial pages (2 GiB) and 65,536 maximum pages, then loads it with the documented `wasmBinary` option. Because the heap starts at 2 GiB, the 256 MiB growth check is never reached. Browsers commit the memory as jq touches it.

`patches/jq-wasm@3.0.0-jq-1.8.2.patch` removes the default `new URL("./build/jq.wasm", import.meta.url)` loader from the browser entry. Vite otherwise inlines the 0.9 MB module into the worker as base64, and a relative URL cannot resolve against the worker's `blob:` URL.

## Measurements

Measured with Bun 1.4.4 on an Apple Silicon Mac, calling `jq-wasm` directly.

|Case|Stock 256 MiB|2 GiB initial memory|
|---|---|---|
|`.items\|length`, 16 MB input|669 ms|322 ms|
|`.items\|length`, 30 MB input|WebAssembly abort|627 ms|
|`.`, 50 MB input|WebAssembly abort|2,749 ms, 94 MB output|
|`.items\|length`, 100 MB input|WebAssembly abort|2,046 ms|
|`.`, 100 MB input|WebAssembly abort|5,742 ms, 187 MB output|

Other checks:

|Case|Result|
|---|---|
|`test("b")` on `"abc"`|`true`: regular expressions work, so Oniguruma is compiled in|
|`.` on `100000000000000000001`|Printed unchanged: decNumber keeps large integers exact|
|Object with a duplicate key|jq keeps the last value|

## Limits

|Limit|Value|Reason|
|---|---|---|
|`JQ_INPUT_MAX_BYTES`|100,000,000 bytes|Largest measured input that completed with 2 GiB memory|
|`JQ_OUTPUT_MAX_BYTES`|200,000,000 bytes|Covers the measured 187 MB identity output of a 100 MB input; the result view renders only its visible lines|
|`JQ_TIMEOUT_MS`|15,000 ms|More than twice the slowest measured accepted input|

When a limit stops a run, the jq panel names the limit and the measured size. A timeout or a cancel terminates the worker and frees its memory, and the next run starts a new one.
