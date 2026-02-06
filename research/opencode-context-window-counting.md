# OpenCode Context Window / Token Counting

This note documents how the upstream OpenCode UI ("web" app + TUI) computes the
"context window usage" indicator, and how the server defines token fields.

Why this exists: our VS Code extension shows a context-ring indicator, and the
current implementation likely undercounts.

## Upstream UI: what it counts

In upstream OpenCode (repo: `github.com/sst/opencode`, also mirrored as
`github.com/anomalyco/opencode`), the context usage indicator is computed from
the *last assistant message* that has non-zero token usage.

It uses:

`total = input + output + reasoning + cache.read + cache.write`

and displays:

`percentage = round(total / model.limit.context * 100)`

References:

- `github.com/sst/opencode/packages/app/src/components/session-context-usage.tsx`
  - computes `total` as `x.tokens.input + x.tokens.output + x.tokens.reasoning + x.tokens.cache.read + x.tokens.cache.write`
  - computes `percentage` against `model.limit.context`

- `github.com/sst/opencode/packages/opencode/src/cli/cmd/tui/routes/session/header.tsx`
  - computes `total` with the same sum
  - appends `%` using `model.limit.context`

So, upstream does NOT treat `tokens.input` as "the whole context window" by
itself; it treats it as one component of the total.

## Server semantics: what `tokens.*` mean

The server normalizes token usage into a structured shape:

```
tokens: {
  input: number,
  output: number,
  reasoning: number,
  cache: { read: number, write: number }
}
```

In `github.com/sst/opencode/packages/opencode/src/session/index.ts`, the
`getUsage()` helper builds this `tokens` object.

Notable behavior:

- `tokens.input` is an *adjusted* prompt token count.
  - For some providers (Anthropic/Bedrock), OpenCode treats cached tokens as
    separately reported and adjusts `input` so it excludes cache read/write.
  - That means `tokens.input` alone is intentionally *not* "everything".

- `tokens.cache.read` and `tokens.cache.write` are tracked separately.

This makes the upstream UI's "sum of all components" approach consistent with
how the server reports usage.

Reference:

- `github.com/sst/opencode/packages/opencode/src/session/index.ts` (function `getUsage`)

## Compaction / overflow logic is related but not identical

Auto-compaction (summarization) is triggered based on an overflow check that is
slightly different from the UI indicator.

In `github.com/sst/opencode/packages/opencode/src/session/compaction.ts`:

- `count = tokens.input + tokens.cache.read + tokens.output`
- `usable = model.limit.input || (model.limit.context - outputLimit)`
- overflow when `count > usable`

This is important context: the "context usage ring" is a UI display using
`total / limit.context`, while compaction uses a more conservative "usable
input" calculation.

References:

- `github.com/sst/opencode/packages/opencode/src/session/compaction.ts` (function `isOverflow`)

## Implication for this VS Code extension

In this repo, the context indicator is updated in:

- `src/chat/chatPanel.ts` (method `_updateContextIndicatorFromMessage`)

The current logic uses only `info.tokens.input` as `usedTokens`.

Based on upstream behavior, the closer match is:

`usedTokens = input + output + reasoning + cache.read + cache.write`

and then compare against the model context limit (server returns
`model.limit.context` via `/config/providers`).
