# Research Notes: opencode-vscode-extension

Repository analyzed: `https://github.com/saffron-health/opencode-vscode-extension` (main branch)

## What this extension is

This is a VS Code sidebar extension that embeds an OpenCode chat UI in a webview and talks to a local OpenCode server through `@opencode-ai/sdk/v2`.

Main implementation files:
- `.tmp-opencode-vscode-extension/src/extension.ts`
- `.tmp-opencode-vscode-extension/src/OpenCodeService.ts`
- `.tmp-opencode-vscode-extension/src/OpenCodeViewProvider.ts`
- `.tmp-opencode-vscode-extension/src/webview/hooks/useOpenCode.tsx`
- `.tmp-opencode-vscode-extension/src/webview/state/sync.tsx`

## Architecture (high-level)

```text
VS Code Extension Host
  - activates extension
  - starts OpenCode server via SDK createOpencode()
  - exposes webview + message bridge
  - proxies HTTP + SSE for webview

Webview (SolidJS)
  - creates SDK client with server URL from host
  - sends prompt/session/permission API calls
  - receives SSE stream via host proxy
  - keeps UI state in Sync store

OpenCode Server (localhost random port)
  - session/message/permission endpoints
  - /event SSE stream
```

## Base connection between extension and OpenCode

This is the key connection path you asked for.

1. Extension activation creates service and initializes OpenCode:
   - `.tmp-opencode-vscode-extension/src/extension.ts:24`
   - `.tmp-opencode-vscode-extension/src/extension.ts:30`

2. Service starts OpenCode server through SDK:
   - `.tmp-opencode-vscode-extension/src/OpenCodeService.ts:1`
   - `.tmp-opencode-vscode-extension/src/OpenCodeService.ts:58`
   - Host/port are `127.0.0.1` + ephemeral (`port: 0`), timeout 15s.

3. Service scopes server to workspace by temporarily `chdir` into workspace root before `createOpencode()`:
   - `.tmp-opencode-vscode-extension/src/OpenCodeService.ts:30`
   - `.tmp-opencode-vscode-extension/src/OpenCodeService.ts:52`

4. Host sends server URL to webview during `ready -> init` handshake:
   - `.tmp-opencode-vscode-extension/src/OpenCodeViewProvider.ts:129`
   - `.tmp-opencode-vscode-extension/src/OpenCodeViewProvider.ts:149`
   - Includes `serverUrl`, `workspaceRoot`, current session metadata.

5. Webview builds SDK client from host-provided URL:
   - `.tmp-opencode-vscode-extension/src/webview/hooks/useOpenCode.tsx:89`
   - Uses `createOpencodeClient({ baseUrl, fetch: proxyFetch, directory })`.

6. Webview calls SDK methods directly (session create/list/prompt/messages/permission):
   - `.tmp-opencode-vscode-extension/src/webview/hooks/useOpenCode.tsx:214`
   - `.tmp-opencode-vscode-extension/src/webview/hooks/useOpenCode.tsx:219`
   - `.tmp-opencode-vscode-extension/src/webview/hooks/useOpenCode.tsx:224`

7. Because webview networking is constrained, host proxies requests:
   - HTTP proxy: `.tmp-opencode-vscode-extension/src/webview/utils/proxyFetch.ts`
   - SSE proxy: `.tmp-opencode-vscode-extension/src/webview/utils/proxyEventSource.ts`
   - Host handlers: `.tmp-opencode-vscode-extension/src/OpenCodeViewProvider.ts:292` and `.tmp-opencode-vscode-extension/src/OpenCodeViewProvider.ts:183`
   - Strict origin checks enforce proxy target == OpenCode server origin.

## Runtime flow

### Startup
- `activate()` creates `OpenCodeService`, calls `initialize(workspaceRoot)`, then registers webview provider.
- Webview loads HTML from extension and sends `{ type: 'ready' }`.
- Host replies with init payload containing `serverUrl` and workspace context.

### Message send flow
- User submits in webview `App.tsx`.
- `useOpenCode.sendPrompt()` reads model from config and calls `client.session.prompt(...)`.
- UI sets thinking state locally and clears via `session.idle` / `session.error` events.

### Realtime updates
- `sync.tsx` starts SSE subscription through `subscribeToEvents()`.
- Events are batched every 30ms and applied to a normalized store (`message`, `part`, `permission`, `sessionStatus`).
- Message/part handlers live in `.tmp-opencode-vscode-extension/src/webview/state/eventHandlers.ts`.

## Functionality inventory

Implemented:
- Multi-session management + session switcher.
- Prompt sending and response streaming.
- Tool-call rendering (`read/edit/grep/glob/bash/list/webfetch/task/todo` etc).
- Permission prompts with `once/always/reject`.
- Agent switching and persistence to extension `globalState`.
- Queueing messages while generation is in progress.
- Editing previous user message by revert + resend.
- Context usage ring and file-change summary.
- Editor selection to prompt attachment via command `opencode.addSelectionToPrompt`.

## Usability assessment

Strengths:
- Good resilience layer for SSE (`SseClient` has reconnect, backoff, Last-Event-ID, retry parsing).
- Thoughtful UX on long-running generations (thinking state, queue, cancel, inline errors).
- Security-aware transport proxying (origin checks + constrained CSP connect-src).

Weaknesses / gaps:
- README is partially stale (mentions React, older architecture), but code is SolidJS and newer direct-SDK-in-webview model.
- Some UI rough edges remain (for example one permission component still uses emoji icon).
- E2E permission tests are skipped by default because they depend on model behavior.

## Practical “base connection” template to reuse

If you only want the essential extension↔OpenCode wiring, the minimum pattern is:

1) Extension host:
- start server with `createOpencode({ hostname: '127.0.0.1', port: 0 })`
- keep `server.url`
- send `{ type: 'init', serverUrl, workspaceRoot }` to webview on `ready`

2) Webview:
- on `init`, create SDK client with `createOpencodeClient({ baseUrl: serverUrl, directory: workspaceRoot })`
- call `client.session.*` and `client.permission.*`
- subscribe to `/event` stream and map events into UI store

3) Bridge/proxy (recommended in VS Code webview):
- proxy fetch + SSE through extension host
- reject non-OpenCode origins
- pass workspace context via directory query/header
