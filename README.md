# Wireglass

Wireglass is a read-only WebSocket message inspector for Caido. It adds a **Wireglass** view mode to WS History and WebSocket Replay that shows the captured message without changing it.

## Build

```sh
bun install
bun run build
```

The build writes `dist/plugin_package.zip`. Install it in Caido from **Plugins → Install package**.

## Documentation

- [Packaging and release](docs/release.md)
- [jq limits](docs/research/jq-wasm-limits.md)
- [Live acceptance run](docs/research/live-acceptance.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

MIT
