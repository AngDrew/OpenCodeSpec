# OpenCode title generation behavior

This repo integrates with `opencode serve` via `@opencode-ai/sdk/v2`.

## Key behavior (upstream)

Upstream OpenCode generates session titles using a dedicated `title` agent.

- It runs on the first user message (`len(msgs) == 0`) and updates `session.Title` directly.
- It does **not** create an assistant message in the chat history for title generation.
- The prompt contract for `title` is short, single-line, no quotes/colons, <= 50 characters.

## Why this matters for the VS Code extension

If the extension tries to generate a title by calling the normal session message endpoint ("prompt") against the active chat session, the server may create a real assistant message ("Quick greeting") and it can interfere with the UI's streaming state.

To avoid polluting chat history and breaking streaming, title generation should be:

- performed in the background
- isolated from the active session's streaming / message binding
- applied by updating the session title via `session.update`

## References (upstream)

- `internal/llm/agent/agent.go`: `generateTitle(...)` updates `session.Title` and saves, triggered when the first message is processed.
- `internal/llm/prompt/title.go`: title prompt rules (<= 50 chars, one line, no quotes/colons).
