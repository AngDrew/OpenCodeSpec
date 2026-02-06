## 1. Host Connection Lifecycle Foundations

- [x] 1.1 Introduce a host-side connection runtime abstraction to own server handle, readiness, current server URL, and workspace scope.
- [x] 1.2 Refactor extension activation (`src/extension.ts`) to initialize the connection runtime once and provide it to chat/webview orchestration.
- [x] 1.3 Update local server start/stop flows in `src/chat/chatPanel.ts` and `src/api/opencodeClient.ts` to use the runtime abstraction consistently.
- [x] 1.4 Ensure server shutdown clears active streaming subscriptions and stale readiness/session state.

## 2. Host-Webview Contract and Transport Hardening

- [x] 2.1 Define a typed canonical init payload for host->webview bootstrap (`ready`, `serverUrl`, `workspaceRoot`, session defaults/context).
- [x] 2.2 Refactor webview-ready handshake so init payload is always emitted from a single path.
- [x] 2.3 Consolidate proxy fetch and SSE entrypoints in host code with strict origin checks against active OpenCode server URL.
- [x] 2.4 Standardize host->webview connection status/error messages for connected, reconnecting, disconnected, and failed states.

## 3. Realtime Sync and Session Consistency

- [x] 3.1 Normalize webview sync state structures for session/message/part/permission/status updates and document update ordering assumptions.
- [x] 3.2 Apply batched processing for high-frequency realtime events so UI state remains deterministic under streaming load.
- [x] 3.3 Refactor session switching to clear in-flight generation state before bootstrapping selected session history.
- [x] 3.4 Ensure bootstrap reconciliation loads selected-session messages/permissions/status before draining buffered realtime events.

## 4. Validation and Regression Coverage

- [x] 4.1 Add/adjust tests for host connection lifecycle transitions (initialize, start, stop, reconnect/error transitions).
- [x] 4.2 Add/adjust tests for proxy security boundary behavior (allow active origin, reject non-active origin for HTTP and SSE).
- [x] 4.3 Add/adjust tests for session bootstrap/switching consistency during active generation and after reconnect.
- [x] 4.4 Add/adjust tests for permission and session-error recovery ensuring prompt flow remains usable after failures.

## 5. Cleanup and Compatibility Reduction

- [x] 5.1 Remove duplicate or legacy bootstrap/transport branches once canonical init and proxy paths are verified.
- [x] 5.2 Remove obsolete connection assumptions (fixed URL defaults where inappropriate) and update inline docs/comments.
- [x] 5.3 Update contributor-facing documentation to reflect the new extension<->OpenCode connection architecture and troubleshooting flow.
