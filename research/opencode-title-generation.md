# OpenCode title generation behavior

This repo integrates with `opencode serve` via `@opencode-ai/sdk/v2`.

## Key behavior (upstream)

Upstream OpenCode generates session titles using a dedicated `title` agent.

- It runs on the first user turn (`step === 1`) and only if the session has a default title (`Session.isDefaultTitle`).
- It does **not** create an assistant message in the chat history for title generation.
- The title prompt rules are concise and enforce clean, short titles.

### Important implementation detail (why our extension didn't rename)

OpenCode's server-side auto-rename only triggers when the session title matches OpenCode's default-title format.

- Default titles are generated server-side as:
  - `New session - <ISO timestamp>`
  - `Child session - <ISO timestamp>`
- If a client creates sessions with a custom title (ex: `Chat Session`), `Session.isDefaultTitle(...)` is false,
  so auto-rename is skipped.

Therefore, to mirror TUI/web/desktop behavior, clients should create new sessions without overriding `title`.

## Why this matters for the VS Code extension

If the extension tries to generate a title by calling the normal session message endpoint ("prompt") against the active chat session, the server may create a real assistant message ("Quick greeting") and it can interfere with the UI's streaming state.

To avoid polluting chat history and breaking streaming, title generation should be:

- performed in the background
- isolated from the active session's streaming / message binding
- applied by updating the session title via `session.update`

## References (upstream)

- `packages/opencode/src/session/index.ts`
  - `createDefaultTitle(...)`
  - `isDefaultTitle(...)`
- `packages/opencode/src/session/prompt.ts`
  - `ensureTitle(...)` is called at first step and bails unless `Session.isDefaultTitle(session.title)`
  - successful generation updates session title via `Session.update(..., { touch: false })`
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - TUI creates sessions with `session.create({})` (no custom title override).
