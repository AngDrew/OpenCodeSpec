# Research Notes Index

This folder contains short, repo-specific notes about OpenCode (upstream behavior + SDK/API details) used while building this VS Code extension.

- `research/opencode-architecture.md`: High-level map of OpenCode components (commands, skills, OpenSpec workflow, SDK/plugin pieces).
- `research/opencode-config-v2.md`: How to fetch resolved v2 config and correctly list/filter configured providers/models and primary agents.
- `research/opencode-context-window-counting.md`: Upstream token/context usage math (what fields are summed; implications for our context indicator).
- `research/opencode-sdk-js.md`: Overview of `@opencode-ai/sdk` (resources, streaming/SSE, session chat flow, error model) for extension integration.
- `research/opencode-serve-doc.md`: What `opencode serve` exposes (server behavior + major REST endpoints + SDK usage patterns).
