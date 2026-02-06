# OpenCode v2: Fetching User Config + Filtering Agents/Models

This repo's VS Code extension talks to a running `opencode serve` via the official SDK `@opencode-ai/sdk/v2/client`.

The behavior of model/agent pickers depends heavily on which endpoints are used:

- `/config` and `/config/providers` reflect the *resolved user configuration* (global + project `.opencode/opencode.jsonc`, plus defaults).
- `/provider` returns the *full provider registry* (often thousands of models) and is not appropriate for a “configured models” picker.
- `/agent` returns all agents (primary + internal subagents like `summary`, `title`, etc.). You must filter by agent `mode` and config disable flags.

The extension should use the config-scoped endpoints first to match what the OpenCode TUI/CLI considers “active”.

## SDK entrypoint (v2)

The extension constructs a v2 client like this:

```ts
const mod = await import('@opencode-ai/sdk/v2/client');
const client = mod.createOpencodeClient({
  baseUrl: 'http://127.0.0.1:4096',
  directory: '/abs/path/to/workspace', // sets x-opencode-directory header
});
```

Passing `directory` causes the SDK to send an `x-opencode-directory` header (URL-encoded only if non-ASCII).
This scopes `/config`, `/agent`, `/command`, etc. to the correct project.

## Fetch the resolved user config

Use:

- `client.config.get({ directory })` -> `GET /config`

This returns a resolved `Config` object that includes (non-exhaustive):

- `default_agent?: string` (fallback should be `build`)
- `model?: string` (format: `provider/model`)
- `agent?: Record<string, AgentConfig>`
  - `AgentConfig.model?: string`
  - `AgentConfig.variant?: string`
  - `AgentConfig.disable?: boolean`
  - `AgentConfig.mode?: 'primary' | 'subagent' | 'all'`
- `enabled_providers?: string[]` / `disabled_providers?: string[]`
- `provider?: Record<string, ProviderConfig>` (may include model overrides, variant disabling, allowlists/denylists)

If you need to debug which config file is being used, fetch paths:

- `client.path.get({ directory })` -> `GET /path`

It returns a `Path` object containing the OpenCode `config` directory path (plus `state`, `worktree`, etc.).

## Model inventory: configured vs full catalog

There are two similar-looking endpoints with very different semantics:

1) Config-scoped provider inventory:

- `client.config.providers({ directory })` -> `GET /config/providers`

Returns:

```ts
{
  providers: Provider[]; // providers loaded/allowed by config
  default: Record<string, string>; // providerID -> default modelID
}
```

This is the right source for a picker that should show “~70ish models” (i.e., the models OpenCode considers enabled/configured).

2) Full provider registry:

- `client.provider.list({ directory })` -> `GET /provider`

Returns:

```ts
{
  all: ProviderRegistryEntry[]; // huge: may contain thousands of models
  default: Record<string, string>;
  connected: string[];
}
```

This is useful for diagnostics and exploration, but not for a default UI model list.
Using it for the picker is what causes “model list shows ~2400 models”.

## Agent list: primary vs internal subagents

The agent endpoint:

- `client.app.agents({ directory })` -> `GET /agent`

Returns `Agent[]` where each agent includes:

- `name: string`
- `mode: 'primary' | 'subagent' | 'all'`
- `hidden?: boolean`
- `model?: { providerID, modelID }`
- `variant?: string`

OpenCode returns internal agents too (`summary`, `title`, `compaction`, etc.).
For an interactive “mode/agent picker” you typically want only:

- `agent.mode === 'primary'`
- AND `agent.hidden !== true`
- AND `config.agent?.[agentName]?.disable !== true`

This matches the expectation: only `build` and `plan` are selectable in normal setups.

## Defaults: model + variant

Recommended default resolution for the UI:

1) Determine default agent:

- `defaultAgent = config.default_agent || 'build'` (only if it exists in the filtered agent list)

2) Determine default model:

- Prefer `config.model` if set
- Else prefer `config.agent?.[defaultAgent]?.model`
- Else fall back to the `model` resolved on the `Agent` object returned from `/agent`

3) Determine default variant:

- Prefer `config.agent?.[defaultAgent]?.variant`
- Else use `Agent.variant` from `/agent` if present
- Else empty string (meaning “server default variant”)

Important UI detail: if you apply the variant default *before* the model list (and its variant list) is loaded, some UIs will overwrite the selection back to default. Ensure model inventory exists before validating/applying the variant.
