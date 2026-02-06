## Why

The current extension-to-OpenCode connection is functional but inconsistent: it mixes fixed URL assumptions, custom transport behaviors, and state handling patterns that drift from a proven OpenCode client architecture. Refactoring now reduces connection fragility, makes streaming and permissions more reliable, and gives us a clean base for future features.

## What Changes

- Replace ad-hoc server/bootstrap assumptions with a consistent OpenCode server lifecycle managed by the extension host.
- Standardize host-to-webview initialization so the webview receives authoritative runtime connection context (`serverUrl`, workspace directory, and session defaults).
- Align webview API usage around the OpenCode SDK client with explicit host transport proxying for HTTP and SSE, including strict same-origin guards.
- Adopt a normalized event-driven sync flow for sessions, messages, message parts, and permission prompts, including reconnect and bootstrap behavior.
- Refactor chat panel responsibilities so connection, transport, and UI orchestration have clearer boundaries and fewer cross-cutting side effects.
- Add focused validation coverage for connection startup, SSE resilience/reconnect, and session bootstrap/switching behavior.

## Capabilities

### New Capabilities
- `extension-opencode-connection-lifecycle`: Define how the extension host starts/stops OpenCode, resolves workspace scope, and exposes connection metadata to the webview.
- `webview-opencode-realtime-sync`: Define how the webview initializes SDK connectivity, consumes realtime events, and keeps UI state consistent across streaming, reconnects, and session changes.

### Modified Capabilities
- None.

## Impact

- Extension host: `src/extension.ts`, `src/chat/chatPanel.ts`, `src/api/opencodeClient.ts`.
- Webview transport/state: `src/webview/chat.js`, `src/webview/chat.css`.
- Runtime behavior: server startup/shutdown, init handshake, event subscription/reconnect, session bootstrap/switching, permission/state synchronization.
- Test surface: connection lifecycle and realtime update flows in integration/e2e-oriented coverage.
