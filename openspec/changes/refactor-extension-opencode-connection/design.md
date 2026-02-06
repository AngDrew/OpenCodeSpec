## Context

The extension currently mixes multiple connection patterns: a default fixed base URL, optional local server start/stop commands, and chat-panel-level orchestration for lifecycle, streaming, session state, and UI coordination. The result is a broad host component (`src/chat/chatPanel.ts`) with transport, state, and view responsibilities interleaved.

Our reference architecture (`research/opencode-vscode-extension-architecture.md`) demonstrates a more robust split:
- host owns OpenCode server lifecycle and secure transport proxying,
- webview initializes from host-provided runtime context,
- realtime updates flow through a normalized event sync layer.

Constraints:
- Keep VS Code webview CSP strict and avoid broad network access.
- Preserve existing user-visible features (sessions, streaming, command/prompt flows, stop/cancel).
- Minimize regressions by incremental refactor instead of full rewrite.

## Goals / Non-Goals

**Goals:**
- Establish a single authoritative connection lifecycle in extension host code.
- Define and enforce a stable host↔webview init/transport contract.
- Normalize realtime sync behavior for sessions/messages/parts/permissions.
- Reduce coupling by separating lifecycle, transport proxy, and UI orchestration concerns.
- Add validation coverage for startup, reconnect, and session bootstrap/switch behavior.

**Non-Goals:**
- Full UI redesign or migration away from current webview rendering stack.
- Replacing OpenCode SDK usage with custom HTTP protocol.
- Introducing multi-workspace/multi-root orchestration beyond current single-workspace assumptions.
- Solving every historical chat-panel cleanup item unrelated to connection/sync behavior.

## Decisions

1. **Decision: Host-managed connection runtime object**
   - We will introduce a connection runtime abstraction in host code that owns:
     - server handle (started by extension vs external URL),
     - workspace directory scoping,
     - current server URL and readiness state.
   - Rationale: centralizing lifecycle removes duplicated state transitions spread across command handlers.
   - Alternatives considered:
     - Keep lifecycle in `ChatPanelProvider` as-is: rejected due to growing complexity and side effects.
     - Move lifecycle fully to webview: rejected due to VS Code sandbox/network constraints and trust boundary concerns.

2. **Decision: Explicit init contract from host to webview**
   - On webview ready, host will always emit a canonical init payload containing at least: `ready`, `serverUrl`, `workspaceRoot`, session defaults, and current session context.
   - Rationale: prevents partial bootstrap paths and race conditions where webview guesses connection state.
   - Alternatives considered:
     - Lazy per-feature messages (`getAgents`, `getSessions`, etc.) only: rejected because it fragments startup state and increases race windows.

3. **Decision: Keep host transport proxy with strict origin guard**
   - Webview API calls and SSE will continue to route through host proxy adapters with server-origin enforcement.
   - Rationale: preserves CSP posture and provides a controlled chokepoint for abort/reconnect/error handling.
   - Alternatives considered:
     - Direct webview fetch/SSE to localhost only: rejected because it weakens control and complicates consistent behavior across VS Code environments.

4. **Decision: Normalize realtime sync as event-driven store updates**
   - Session/message/part/permission updates will be applied to normalized store structures; event bursts will be batched.
   - Rationale: deterministic rendering and easier reconciliation for session switching/reconnect.
   - Alternatives considered:
     - Continue with ad-hoc per-message mutations spread in handlers: rejected due to hard-to-reason ordering bugs.

5. **Decision: Incremental refactor path with compatibility shims**
   - We will preserve current user commands and message types initially, then collapse legacy/duplicate paths once parity is verified.
   - Rationale: safer rollout and easier rollback.
   - Alternatives considered:
     - Big-bang rewrite: rejected as too risky for streaming/session behavior.

## Risks / Trade-offs

- **[Risk] Initialization contract mismatch between host and webview during transition** -> **Mitigation:** introduce typed message schema and temporary backward-compatible parsing.
- **[Risk] Reconnect behavior regressions under intermittent server availability** -> **Mitigation:** keep resilient SSE client behavior, add reconnect/status test coverage.
- **[Risk] Session switching races with in-flight generation** -> **Mitigation:** explicit in-flight reset protocol on session change and deterministic bootstrap sequencing.
- **[Risk] Increased short-term complexity while compatibility shims exist** -> **Mitigation:** time-box shim removal tasks and track completion in tasks artifact.
- **[Trade-off] Maintaining host proxy adds implementation overhead** -> **Mitigation:** accept overhead for stronger security/control boundaries.

## Migration Plan

1. Introduce typed connection runtime and init payload contract in host layer without changing UI behavior.
2. Route existing webview bootstrap through the new init path; preserve legacy message handling as fallback.
3. Consolidate transport proxy handling and remove duplicate fetch/SSE call paths.
4. Normalize session/message/part/permission store update flow and gate with targeted tests.
5. Remove compatibility shims once parity checks pass.

Rollback strategy:
- Keep feature-flag-like fallback path for legacy bootstrap during migration.
- If regressions appear, switch to previous message/bootstrap path while retaining non-breaking host lifecycle improvements.

## Open Questions

- Should local server start use ephemeral ports only, or preserve explicit fixed-port mode for advanced users?
- Which existing webview message types can be deprecated immediately versus staged removal?
- Do we standardize on one testing layer (unit + integration) for connection flow, or continue mixed host/webview test entrypoints?
