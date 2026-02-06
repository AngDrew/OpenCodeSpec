# Research Notes

## Content Index

This folder contains short, repo-specific notes about OpenCode (upstream behavior + SDK/API details) used while building this VS Code extension.

- `opencode-architecture.md`: High-level map of OpenCode components (commands, skills, OpenSpec workflow, SDK/plugin pieces).
- `opencode-config-v2.md`: How to fetch resolved v2 config and correctly list/filter configured providers/models and primary agents.
- `opencode-context-window-counting.md`: Upstream token/context usage math (what fields are summed; implications for our context indicator).
- `opencode-sdk-js.md`: Overview of `@opencode-ai/sdk` (resources, streaming/SSE, session chat flow, error model) for extension integration.
- `opencode-title-generation.md`: Upstream title-agent behavior and why title updates should avoid creating assistant chat messages.
- `opencode-serve-doc.md`: What `opencode serve` exposes (server behavior + major REST endpoints + SDK usage patterns).
- `fission-ai-openspec.md`: Deep dive into upstream OpenSpec (Fission-AI/OpenSpec) workflows, delta specs, schema system, CLI, and tool adapters.


## Rules

- always update this when you add new md file in this research folder.