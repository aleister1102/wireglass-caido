# Caido WebSocket view mode: runtime behavior (Caido 0.59.0)

Checked on 2026-10-30 against local Caido 0.59.0 with `@caido/sdk-frontend` 0.59.0, in a dedicated `wireglass-dev` project with synthetic traffic only.

## Registration

- `sdk.websocket.addMessageViewMode` and `sdk.replay.addWebsocketMessageViewMode` both register at runtime.
- A registered mode does not appear by default. The user enables it once from the **+** button next to **Raw**, in the **Available message view modes** dialog. After that, a **Wireglass** tab appears beside **Raw**.
- The enabled state survived an uninstall and reinstall of the plugin package.
- `when` runs only after the mode is enabled. It received `{type: "StreamWsMessageMeta", id, streamId, head: {id, length, direction, format, createdAt}}`; no payload.

## Message content

- `props.view.state.doc.toString()` holds the message text. For all ten synthetic messages (plain JSON with a 20-digit number and duplicate keys, a Socket.IO event, Unicode with an emoji, plain text, malformed JSON), the shown text equaled the UTF-8 decode of `streamWsMessageEdit(id).raw` from GraphQL.
- A GraphQL fetch is not needed for text frames.
- Selecting another message updates the `message` and `view` props on the mounted component; the view showed the new content each time.

## Direction

`head.direction` names the receiver. Caido shows `SERVER` as "To Server" and `CLIENT` as "To Client", in both WS History and Replay.

## Replay

In a WebSocket Replay session (connect, send a message, select it), the same component rendered the sent message unchanged after the mode was enabled in Replay's own **+** dialog.

## Reproduce

1. `bun run build`, then install `dist/plugin_package.zip` from **Plugins → Install Package**.
2. Run `bun /tmp/wireglass-traffic.ts`-style traffic: a local echo server and a client that connects through the Caido proxy at `127.0.0.1:8080`.
3. In WS History, select a message, enable **Wireglass** from **+**, and open the **Wireglass** tab.
