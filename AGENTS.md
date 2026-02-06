# AGENTS.md

This repo is a VS Code extension (TypeScript) that provides an OpenCode-backed chat panel.
This file is for agentic coding agents working inside `D:\projects\js\OpenCodeSpec`.

## Rules

- if you are researching using tools: `context7` or `grep_app` or `opensrc` from external sources repository, always put the research insight into the @research/ folder. it will deepen your knowledge! which is good!

## Repo Map

- read as needed! `research/`. to improve your knowledge! check the `research/AGENTS.md` it contains knowledge indexes. dont read everything, just read necessarily
  - when you might want to do a research (read `## How to Research`)
- `src/` extension source (TypeScript) + webview assets
- `src/webview/` shipped webview JS/CSS (plain JS/CSS; not TypeScript)
- `out/` compiled output from `tsc` (do not edit by hand)
- `.opencode/` OpenCode config + skills (not part of the extension build)

## Extension <-> OpenCode Connection Architecture (Contributor Notes)

The extension now uses a host-first connection model with a single runtime authority.

- Runtime owner: `src/connection/connectionRuntime.ts`
  - Tracks `serverHandle`, `isReady`, `currentServerUrl`, and workspace scope.
- Activation wiring: `src/extension.ts`
  - Creates one `OpenCodeConnectionRuntime` and passes it to `ChatPanelProvider`.
- Lifecycle + orchestration: `src/chat/chatPanel.ts`
  - Connect/start/stop flows mutate runtime-backed state.
  - Webview bootstrap always uses canonical `initState` payload with `ready`, `serverUrl`, `workspaceRoot`, plus session defaults/context.
  - Connection status events to webview are normalized as: `connected`, `reconnecting`, `disconnected`, `failed`.
- Server control helpers: `src/api/opencodeClient.ts`
  - `startServerWithRuntime(...)` and `stopServerWithRuntime(...)` keep runtime/server state aligned.
- Transport boundary: host-proxied HTTP + SSE in `src/chat/chatPanel.ts`
  - Proxy requests are allowed only when target origin matches the active OpenCode server origin.

### Troubleshooting Flow (Contributor)

Use this order when debugging extension-to-server issues.

1. Verify runtime source of truth
   - Confirm `currentServerUrl` is set on connect/start and cleared/readiness reset on stop.
   - Check `startServerWithRuntime(...)` / `stopServerWithRuntime(...)` usage before adding any new connection path.

2. Verify host->webview bootstrap contract
   - Ensure webview triggers `webviewReady` and host responds via canonical `initState` payload.
   - Avoid introducing alternate bootstrap messages that bypass `initState` semantics.

3. Verify transport proxy origin guard
   - If proxy calls fail, inspect origin mismatch errors (non-active origin is intentionally blocked).
   - Keep webview network access routed through host proxy handlers, not direct arbitrary fetch/EventSource.

4. Verify realtime/status behavior
   - Check `healthStatus` transitions (`reconnecting` then `connected` after recovery).
   - Confirm SSE interruptions trigger reconnect flow and health check revalidation.

5. Verify local server startup assumptions
   - If start fails, ensure `opencode` CLI is installed and discoverable in extension host environment.
   - On Windows/macOS, PATH mismatch is common when VS Code was opened before shell profile updates.

When adding new connection features, preserve this architecture: host-managed lifecycle, canonical init contract, strict proxy boundary, and deterministic status signaling.
  
## How to Research

**Important Notes** Make sure research/.md file size at max 200 lines each. to prevent confussion!
After research make .md files in research/ folder, then pour your research there, then update the research/AGENTS.md

- using skills: `librarian` skill: delegate `explore` agent to use, dont use librarian skill directly. it will bloating our precious resource
- using tools: 
  - internal repository:
    - delegate `explore` agent to explore our codes. you may delegate multiple `explore` agents like as much as you want. go wild! explore everything want to know! be curious! be hungry!
  - external repository: 
    - you might want to choose one of them: `context7` or `grep_app` or `opensrc`
      - **context7**: Get the latest documentation and code. pulls up-to-date, version-specific documentation and code examples straight from the source
      - **grep_app**: Effortlessly search for code, files, and paths across a million GitHub repositories
      - **opensrc**: Automates the process of fetching package source code so you can reference it when needed

### Research Template

> # Research Notes
> 
> ## Content Index
> 
> - `opencode-architecture.md`: High-level map of OpenCode components (commands, skills, OpenSpec workflow, SDK/plugin pieces).
> 
> ## Rules
> 
> - always update this when you add new md file in this research folder.
> - make sure .md file size at max 200 lines each. to prevent confussion

## Setup

Uses npm (has `package-lock.json`).

```bash
npm ci
```

## Build / Lint / Test

### Build

```bash
npm run compile
```

Watch mode (wired to `.vscode/tasks.json`):

```bash
npm run watch
```

Debug configs (see `.vscode/launch.json`):

- `Run Extension` (preLaunch: watch)
- `Extension Tests` (expects tests at `out/test/suite/index`)

### Lint

```bash
npm run lint
```

Known issue: ESLint v9 is installed, but there is no `eslint.config.*` (flat config),
so lint currently fails. If a change needs linting, add `eslint.config.js|mjs|cjs`
or update lint tooling.

### Tests

```bash
npm test
```

Notes:

- `npm test` runs `vscode-test` (from `@vscode/test-cli`).
- `pretest` runs `compile` + `lint`, so tests are currently blocked by the ESLint config issue.
- There is no `.vscode-test.*` config file in the repo, and no checked-in test suite under `src/test`.

If you add tests, also add:

- `.vscode-test.js` (or run with `--config path/to/.vscode-test.js`)
- a compiled test entrypoint (typically `out/test/suite/index`)

### Run A Single Test (When Tests Exist)

Mocha-style filters are supported:

```bash
npm test -- -g "Health check"
```

Run a specific compiled test file (depends on your `.vscode-test.js` setup):

```bash
npm test -- --run out/test/suite/someFile.test.js
```

Show all runner options:

```bash
npx vscode-test --help
```

## TypeScript + Module Model

- `tsconfig.json`: `strict: true`, `module: Node16`, `moduleResolution: Node16`, `target: ES2022`.
- Some deps are ESM-only; the extension uses dynamic `import()` in CJS output (see `src/api/opencodeClient.ts`).

## Code Style (Follow Existing `src/` Patterns)

### Formatting

- Indent: 2 spaces
- Quotes: single quotes in TS/JS
- Semicolons: keep
- Prefer trailing commas where already used
- Avoid drive-by reformatting (no Prettier config in this repo)

### Imports

- VS Code API: `import * as vscode from 'vscode';`
- Use explicit relative paths (`./chat/chatPanel`, not barrel imports unless the repo already uses them)
- Keep imports tidy (no unused imports; TypeScript `strict` compile must stay clean)

### Types

- Prefer `unknown` at boundaries, then narrow; avoid leaking `any`.
- Define interfaces/types for cross-boundary data:
  - extension host <-> webview `postMessage` payloads
  - OpenCode API/SDK response shapes
- Localized `any` is OK for SDK shims, but keep it contained and documented in code.

### Naming

- Classes: `PascalCase`; methods/functions: `camelCase`
- Booleans: `is/has/should` prefix
- Private members/methods: this repo often uses a leading underscore (`_view`, `_handleHealthCheck`); keep that convention.

### Error Handling

- Wrap network and async UX boundaries in `try/catch`.
- Convert unknown errors with `error instanceof Error ? error.message : String(error)`.
- Prefer actionable user messages via `vscode.window.showErrorMessage`, and UI updates via `webview.postMessage`.
- Silent catches only for best-effort cleanup (e.g., aborting a controller, closing a handle).

### Logging

- Keep logs concise; avoid noisy per-delta logs.
- When adding new logs, prefix consistently (recommended: `[OpenCode]`).

## Webview Rules

- CSP must remain strict; use nonces (see `getNonce()` in `src/chat/utils.ts`).
- Only load local assets via `webview.asWebviewUri()`.
- Treat webview content as untrusted:
  - escape before `innerHTML` (see `escapeHtml()` in `src/webview/chat.js`)
  - sanitize carefully if adding richer markdown/HTML features
- Do not introduce `unsafe-eval`.

## OpenCode Agent Config (Repo-Specific)

- OpenCode config: `.opencode/opencode.jsonc`.
- Agents include `build`, `plan`, `explore`; some are configured with restricted permissions
  (e.g., `plan` denies edits and asks for bash). Respect those intents when running under OpenCode.

## Cursor / Copilot Rules

- No `.cursor/rules/` or `.cursorrules` found.
- No `.github/copilot-instructions.md` found.

If these files are added later, treat them as higher-priority repo policy and update this doc.
