# AGENTS.md

This repo is a VS Code extension (TypeScript) that provides an OpenCode-backed chat panel.
This file is for agentic coding agents working inside `D:\projects\js\OpenCodeSpec`.

## Rules

- if you are researching using tools like context7 or grep_app or opensrc from external sources repository, dont forget to put the research insight into the @research/ folder. it will deepen your understanding abuot the library we are using.

## Repo Map

- `research/` opencode dependency research result. documentation and source of truth. when working with opencode, access this directory treat it as knowledge graph
- `src/` extension source (TypeScript) + webview assets
- `src/webview/` shipped webview JS/CSS (plain JS/CSS; not TypeScript)
- `out/` compiled output from `tsc` (do not edit by hand)
- `.opencode/` OpenCode config + skills (not part of the extension build)

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
