# Plan: Fix Streaming Continuity + Session/History Sync

This plan implements two improvements in the VS Code extension:

1) Continuous streaming doesn't stop at tool-calls.
2) Full session/history sync with OpenCode Web + CLI on the same server/port.

The root issue today is that the extension treats `step-finish` as the end of generation and also only processes SSE events while `_isGenerating` is true. OpenCode's own clients keep listening to events continuously and use session/message completion signals (not `step-finish`) to decide when a response is done.

## Goals

- Streaming continues through tool-call steps until the assistant message is actually complete.
- Extension can reload and display the current session history (persisted on the OpenCode server).
- Extension stays in sync with activity from other clients (CLI/web) for the same directory + session.

## Non-goals (for this change)

- Full OpenCode web UI replication (session list sidebar, multi-project browsing, sharing, etc.).
- Implementing new tools/skills/commands beyond rendering and sync.
- Fixing repo ESLint v9 flat-config issue (unless needed for compilation).

## Current Behavior (Problems)

- `src/chat/chatPanel.ts` ends streaming on `part.type === 'step-finish'`.
  - Tool execution frequently produces an intermediate `step-finish` such as `reason: tool-calls`.
  - The final text often arrives after that, so the extension stops early.
- `src/chat/chatPanel.ts` ignores all events when `_isGenerating` is false.
  - This prevents the extension from reflecting message updates from other clients.
- No persisted `sessionID` and no history loading.
  - The extension is effectively "ephemeral UI" rather than a stateful client.

## Design Overview

OpenCode server state model (relevant):

- Sessions are persisted: `session -> messages -> parts`.
- Realtime updates are broadcast via SSE events:
  - `message.updated` (message info, includes assistant completion time)
  - `message.part.updated` (parts and optional text delta)
  - `session.status` (busy/idle/retry)
  - `session.error`

To behave like OpenCode web/CLI:

- Always subscribe to events (not only during generation).
- Render messages by messageID + parts by partID.
- End "streaming" UI based on session/message completion signals:
  - Prefer `session.status` -> `idle` for the current session.
  - Also accept `message.updated` for assistant message with `time.completed`.
  - Do NOT treat `step-finish` as completion.

## Implementation Steps

### Phase A: Continuous Streaming (Do not stop at tool-calls)

1) Stop using `step-finish` as the "done" signal.
   - In `src/chat/chatPanel.ts`, remove the block that sets `_isGenerating = false` inside the `pType === 'step-finish'` handler.
   - Still forward `stepUpdate` to the UI (so you can see tool-call steps), but don't end.

2) Track "current generation" using session/message state.
   - Maintain:
     - `_currentSessionId` (already)
     - `_activeAssistantMessageId` (already, but currently set only after `prompt()` returns)
     - `_isGenerating` (already)
   - Update `_activeAssistantMessageId` earlier when possible:
     - When receiving `message.updated` for the current session and role=assistant, set `_activeAssistantMessageId` if it matches the latest assistant message in response to the current user send.

3) End streaming on reliable completion signals.
   - Listen for `session.status` events:
     - When status transitions to `busy`, consider generation started.
     - When status transitions to `idle` for `_currentSessionId`, end the streaming UI.
   - Also listen for `message.updated`:
     - If it is the active assistant message and includes `time.completed`, end streaming UI.
   - Keep `session.idle` as a fallback only (it is deprecated in OpenCode types).

4) Reduce/avoid `replaceStreaming` overwrites.
   - Today we call `prompt()` and then `replaceStreaming` with `result.text`.
   - With correct event streaming, `result.text` becomes redundant and can overwrite partial+rich output.
   - Plan: keep the HTTP response as a fallback only if we haven't received any text part updates after N ms.

Acceptance criteria for Phase A:

- A prompt that triggers tools shows `tool` updates and then continues streaming assistant text after tool completion.
- No early cut-off after `Step finished (tool-calls)`.
- Stop button still works (session abort), and the UI exits streaming state.

### Phase B: Full Session/History Sync (Web + CLI)

5) Persist session identity and reload on startup.
   - Add extension state storage:
     - Persist `{ url, directory, sessionId }` in `workspaceState` keyed by directory.
   - On connect / view resolve:
     - If a saved `sessionId` exists, validate it with `session.get`.
     - If invalid/missing, create a new session and persist.

6) Load message history for the active session.
   - Add SDK wrappers in `src/api/opencodeClient.ts`:
     - `getSession(sessionId)`
     - `listSessions(...)` (optional, for future)
     - `getSessionMessages(sessionId, { limit? })` calling `session.messages`.
   - In `src/chat/chatPanel.ts`, add `_loadSessionHistory()`:
     - Fetch messages+parts for the active session.
     - Send a single webview message like `{ type: 'setHistory', sessionId, messages: [...] }`.

7) Render history in the webview reliably.
   - Update `src/webview/chat.js` to support:
     - `setHistory`: clears existing DOM and renders messages in order.
     - Stable DOM mapping keyed by `messageID`:
       - So that subsequent `message.part.updated` can update the correct message.
   - Render strategy:
     - For each message, create the bubble once.
     - Append/update based on parts:
       - `text`: bubble text
       - `reasoning`: Thinking block
       - `tool`: tool rows
       - `step-start`/`step-finish`: step rows
       - `patch`: patch rows

8) Keep SSE subscription alive and process events even when not generating.
   - In `src/chat/chatPanel.ts`:
     - Remove the early return `if (!this._isGenerating) return;`.
     - Filter by directory/session in events:
       - Keep the existing `part.sessionID === _currentSessionId` checks.
     - Handle `message.updated`:
       - When message belongs to `_currentSessionId`, update/create message in UI.
     - Handle `message.part.updated`:
       - Update the correct message bubble by `part.messageID` (not only the currently streaming message).

9) Make cross-client sync observable.
   - When another client (CLI/web) sends a message to the same session:
     - The extension view updates without requiring a manual refresh.
   - If another client uses a different session, we will not auto-switch, but the history for the current session remains consistent.

10) Add "New Chat" workflow.
   - Add a webview button or command (minimal UI):
     - Creates a new session, persists it, clears chat, loads empty history.
   - This matches OpenCode's session model and gives deterministic sync behavior.

Acceptance criteria for Phase B:

- Closing and reopening VS Code restores the previous session and shows full history.
- Opening `http://localhost:4096` shows the same session content when you are viewing the same directory/project.
- Actions from CLI/web in the same session appear in the extension via SSE (message updates/parts).

## Notes / Known Pitfalls

- Directory scoping must match between clients.
  - CLI uses its process cwd; extension uses VS Code workspace folder.
  - If those are different paths, sessions will not appear in the other client.
  - Recommended UX: show the active directory in the connection/status UI (later enhancement).

- Events and completion:
  - `step-finish` is a *step boundary*, not a *message completion* boundary.
  - Prefer `session.status` idle and/or assistant `message.updated` with `time.completed`.

- Performance:
  - When always listening to SSE, coalescing updates (like the official web app does) may become necessary later.
  - For now, we can keep it simple and only coalesce high-frequency `text` deltas if needed.

## Verification Checklist

- `npm run compile` passes.
- Manual:
  - Prompt that triggers tool-calls continues streaming to final text.
  - Restart VS Code: history restored.
  - Send message from CLI into same session: extension updates.
  - Send message from extension: web UI shows it (same directory).
