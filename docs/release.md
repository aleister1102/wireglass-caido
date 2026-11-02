# Packaging and release

## Package layout

`bun run build` writes `dist/plugin_package.zip`:

|Path|Content|
|---|---|
|`manifest.json`|Plugin manifest at the archive root|
|`README.md`|Project readme|
|`wireglass-frontend/index.js`, `index.css`|Inspector bundle. Vue, `@codemirror/view`, `@codemirror/state`, `@codemirror/language`, `@lezer/common`, `@lezer/highlight`, and `@lezer/lr` are external and come from Caido.|
|`wireglass-frontend/assets/jq.worker.js`|jq Web Worker (jq-wasm JavaScript only)|
|`wireglass-frontend/assets/jq.wasm`|Unmodified jq-wasm module; the worker raises its memory at load time, see `docs/research/jq-wasm-limits.md`|
|`wireglass-frontend/assets/lz4_wasm_bg.wasm`|lz4-wasm module for the LZ4 decoder. Its JavaScript glue is in `index.js`, changed by `patches/lz4-wasm@0.9.2.patch` so the frontend can instantiate the module itself.|
|`wireglass-frontend/assets/THIRD_PARTY_NOTICES.md`|Licenses of bundled components|

The worker file name is fixed by `vite.worker.rollupOptions.output.entryFileNames` in `caido.config.ts`, and the frontend loads the worker and `jq.wasm` from `sdk.assets`. Keep the version in `package.json` and `caido.config.ts` equal; the release reads it from the packaged `manifest.json`.

## Signing

The release signs the exact archive with an Ed25519 key:

```sh
openssl pkeyutl -sign -inkey private_key.pem -out plugin_package.zip.sig -rawin -in plugin_package.zip
```

To check signing locally, use a throwaway key outside the repository:

```sh
S=/tmp/wireglass-sign
mkdir -p "$S" && cp dist/plugin_package.zip "$S/" && cd "$S"
openssl genpkey -algorithm ed25519 -out key.pem
openssl pkey -in key.pem -pubout -out pub.pem
openssl pkeyutl -sign -inkey key.pem -out plugin_package.zip.sig -rawin -in plugin_package.zip
openssl pkeyutl -verify -pubin -inkey pub.pem -rawin -in plugin_package.zip -sigfile plugin_package.zip.sig
cp plugin_package.zip mutated.zip && printf 'x' >> mutated.zip
openssl pkeyutl -verify -pubin -inkey pub.pem -rawin -in mutated.zip -sigfile plugin_package.zip.sig
```

Result on 2026-10-30 with OpenSSL 4.1.0: the signature is 64 bytes, the unchanged archive prints `Signature Verified Successfully`, and the mutated archive prints `Signature Verification Failure` with exit code 1.

## Release workflow

`.github/workflows/release.yml` runs only by manual dispatch on `main`. It installs with `bun install --frozen-lockfile`, runs the typecheck and tests, builds, signs with the `PRIVATE_KEY` secret, reads the version from the packaged manifest, and publishes `plugin_package.zip` and `plugin_package.zip.sig` through `caido/action-release@v1` with `immutableCreate: true`.

A maintainer must do these steps; the workflow does not do them:

- Add the production Ed25519 key as the `PRIVATE_KEY` repository secret.
- Push the release commit to `main`.
- Start the workflow from the Actions tab.

Validate the workflow file with `actionlint .github/workflows/release.yml`.
