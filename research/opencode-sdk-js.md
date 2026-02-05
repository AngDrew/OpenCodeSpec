# opencode-sdk-js (TypeScript SDK) - Capabilities for Extension Chat Integration

Repo: `https://github.com/anomalyco/opencode-sdk-js` (published as `@opencode-ai/sdk`)

This SDK is a generated (Stainless) TypeScript/JavaScript client for the Opencode REST API. It targets a *local* Opencode server by default (`http://localhost:54321`) and exposes a small set of high-level resources (session, event stream, file/find helpers, config/app metadata) that are enough to build a “chat UI” (e.g. VS Code extension) that delegates conversation execution and tool-running to Opencode.

## What you need (extension-side)

- A running Opencode server (default base URL: `http://localhost:54321`).
- A `fetch` implementation available in the extension runtime.
  - Node 20 has global `fetch`.
  - If your extension host doesn’t provide `fetch`, pass one via `new Opencode({ fetch })` (e.g. from `undici`).
- A way to select `providerID` + `modelID` (you can query them from the server via `client.app.providers()` and/or `client.app.modes()`).
- For live UI updates: consume the SSE event stream (`client.event.list()`), and/or poll `client.session.messages(sessionId)`.

## Package/runtime notes

- NPM: `npm install @opencode-ai/sdk`
- Package metadata (from `package.json`):
  - Name: `@opencode-ai/sdk`
  - Version (main branch at time of research): `0.1.0-alpha.21`
  - `type`: `commonjs`
  - Exports both ESM and CJS via `exports` map.
- Stated supported runtimes (README): modern browsers, Node.js 20+, Deno, Bun, CF Workers, Vercel Edge, Jest (node env), Nitro.
- Streaming is implemented by parsing `fetch()` response bodies; if your environment’s `fetch` doesn’t provide a streaming `body`, SSE won’t work.

## Client construction

Entry point exports (from `src/index.ts`):

```ts
import Opencode from '@opencode-ai/sdk';

const client = new Opencode({
  baseURL: 'http://localhost:54321',
  // fetch, timeout, maxRetries, defaultHeaders/defaultQuery, logLevel/logger
});
```

Key `ClientOptions` (from `src/client.ts`):

- `baseURL?: string | null` (defaults to `process.env.OPENCODE_BASE_URL`, else `http://localhost:54321`)
- `timeout?: number` (default 60s)
- `maxRetries?: number` (default 2)
- `fetch?: Fetch` (optional override)
- `fetchOptions?: RequestInit` (merged into requests)
- `defaultHeaders?: HeadersLike`
- `defaultQuery?: Record<string, string | undefined>`
- `logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'off'` (also via `process.env.OPENCODE_LOG`)
- `logger?: Logger` (defaults to `globalThis.console`)

Useful methods:

- `client.withOptions(partial)` to clone with overrides.
- Low-level HTTP verbs for undocumented endpoints: `client.get/post/put/patch/delete(path, opts)`.

## Request options (per-call)

Every resource call accepts `RequestOptions` (from `src/internal/request-options.ts`), including:

- `query?: object | null`
- `body?: unknown`
- `headers?: HeadersLike`
- `timeout?: number`
- `maxRetries?: number`
- `signal?: AbortSignal`
- `stream?: boolean` (enables SSE parsing into `Stream<T>`)

The SDK returns `APIPromise<T>` from most methods; it is a `Promise` subclass with extras:

- `.asResponse()` -> raw `Response`
- `.withResponse()` -> `{ data, response }`

## Resources/endpoints exposed

The SDK exposes these resources on the client (from `src/client.ts` and `api.md`):

- `client.app` (app metadata + providers/modes + logging)
- `client.config` (read server config)
- `client.session` (create sessions, chat, list messages, revert/share/summarize)
- `client.event` (SSE event stream for updates)
- `client.file` (read file content, get file status)
- `client.find` (file search, symbol search, text search)
- `client.tui` (server-side TUI integration helpers)

### App

From `src/resources/app.ts`:

- `client.app.get()` -> `App`
  - includes `path.{cwd,root,config,data,state}`, `hostname`, `git`, `time.initialized?`
- `client.app.init()` -> `boolean`
- `client.app.modes()` -> `Mode[]`
  - `Mode` includes `name`, `tools` map, optional `model { providerID, modelID }`, optional `prompt`, `temperature`
- `client.app.providers()` -> `{ default: Record<string,string>; providers: Provider[] }`
  - `Provider` includes `id`, `name`, `env[]`, `models` map
- `client.app.log({ level, message, service, extra? })` -> `boolean`

Extension usage:

- Use `app.providers()` to populate a model picker.
- Use `app.modes()` to show “modes” and tool toggles that map to `session.chat({ mode, tools })`.

### Config

From `src/resources/config.ts`:

- `client.config.get()` -> `Config`
  - includes `mode` config, `provider` overrides, `mcp` server configs, `instructions`, `theme`, `username`, etc.

Extension usage:

- Read server-side configuration to mirror defaults in your UI.
- `Config.provider.*.options` hints that provider API keys/base URLs may be configured server-side (not via SDK auth headers).

### Session (core for extension chat)

From `src/resources/session.ts`:

Endpoints:

- `client.session.create()` -> `Session`
- `client.session.list()` -> `Session[]`
- `client.session.delete(id)` -> `boolean`
- `client.session.abort(id)` -> `boolean`
- `client.session.messages(id)` -> `Array<{ info: Message; parts: Part[] }>`
- `client.session.chat(id, params)` -> `AssistantMessage`
- `client.session.init(id, { messageID, providerID, modelID })` -> `boolean`
- `client.session.summarize(id, { providerID, modelID })` -> `boolean`
- `client.session.revert(id, { messageID, partID? })` -> `Session`
- `client.session.unrevert(id)` -> `Session`
- `client.session.share(id)` / `client.session.unshare(id)` -> `Session`

Key request payload: `SessionChatParams`

```ts
type SessionChatParams = {
  providerID: string;
  modelID: string;
  parts: Array<TextPartInput | FilePartInput>;
  messageID?: string;   // optional client-specified message id
  mode?: string;        // optional mode name
  system?: string;      // optional system prompt override
  tools?: Record<string, boolean>; // tool enable/disable map
};
```

Message model highlights:

- `Message = UserMessage | AssistantMessage`
- `Part` union includes:
  - `text` (`TextPart`) + `file` (`FilePart`) + `tool` (`ToolPart`)
  - `step-start` / `step-finish` (useful for UI “thinking / tool-running” indicators)
  - `snapshot` (string payload)
  - `patch` (references `files[]`, `hash`, etc.)

For an extension chat UI, you typically:

1. `create()` a session
2. `chat()` with `parts: [{ type: 'text', text: '...' }]`
3. Subscribe to `event.list()` to stream updates and incremental parts
4. Render `messages(sessionId)` for the “current truth” of the conversation state

File attachments:

- To send a file as input, include a `FilePartInput`:
  - `{ type: 'file', url, mime, filename?, source? }`
- `source` can be a `FileSource` or `SymbolSource`, which includes the extracted `text` ranges.

### Event stream (SSE) (core for live updates)

From `src/resources/event.ts`:

- `client.event.list()` -> `APIPromise<Stream<EventListResponse>>`

`Stream<T>` (from `src/core/streaming.ts`) is an `AsyncIterable`. Cancel by breaking or calling `stream.controller.abort()`.

Important event types (union `EventListResponse`):

- `message.updated` (properties: `{ info: Message }`)
- `message.removed` (properties: `{ messageID, sessionID }`)
- `message.part.updated` (properties: `{ part: Part }`)
- `message.part.removed` (properties: `{ messageID, partID }`)
- `session.updated` / `session.deleted`
- `session.idle` / `session.error`
- `file.edited` / `file.watcher.updated`
- `lsp.client.diagnostics`
- `permission.updated`
- `installation.updated`
- `ide.installed`
- `storage.write`

Extension usage:

- Use `message.part.updated` as the primary “incremental render” trigger.
- Use `session.error` to surface provider auth and unknown errors.
- Filter events by `sessionID` where present (some events are global).

### File

From `src/resources/file.ts`:

- `client.file.read({ path })` -> `{ content: string; type: 'raw' | 'patch' }`
- `client.file.status()` -> `Array<{ path, status: 'added'|'deleted'|'modified', added, removed }>`

Extension usage:

- Implement “open referenced file” / “show patch” UX.
- Use `file.status()` to show workspace change summary (e.g. post-tool-run).

### Find

From `src/resources/find.ts`:

- `client.find.files({ query })` -> `string[]`
- `client.find.symbols({ query })` -> `Symbol[]` (LSP-like location)
- `client.find.text({ pattern })` -> match list (includes `line_number`, `submatches`, etc.)

Extension usage:

- Provide quick navigation/search UI powered by the server’s view of the workspace.

### Tui

From `src/resources/tui.ts`:

- `client.tui.appendPrompt({ text })` -> `boolean`
- `client.tui.openHelp()` -> `boolean`

Extension usage:

- If you want to integrate with an existing running Opencode TUI instance, these endpoints look intended for that.

## Streaming implementation details (what your extension needs to support)

`client.event.list()` sets `stream: true` and expects the server to respond with SSE.

The SDK parses SSE frames by reading `response.body` and splitting on double newlines; each `data:` field is expected to contain JSON for an `EventListResponse`.

Implications for VS Code extensions:

- Ensure your `fetch` returns a WHATWG `ReadableStream` body.
- Ensure `ReadableStream` exists globally; Node 20 provides it.
- If you polyfill `fetch`, prefer one that supports streaming (e.g. undici).

## Error handling model

Errors are thrown as subclasses of `Opencode.APIError` (from `src/core/error.ts`):

- `BadRequestError` (400)
- `AuthenticationError` (401)
- `PermissionDeniedError` (403)
- `NotFoundError` (404)
- `ConflictError` (409)
- `UnprocessableEntityError` (422)
- `RateLimitError` (429)
- `InternalServerError` (>=500)
- `APIConnectionError` / `APIConnectionTimeoutError`
- `APIUserAbortError` (if you abort via signal)

Extension usage:

- Catch `Opencode.APIError` to display `status`, `headers`, and normalized message.
- For auth/provider issues, you may also see structured errors in `session.error` events and in `AssistantMessage.error`.

## Practical “extension chat” flow (recommended)

1) Connect + sanity check

```ts
import Opencode from '@opencode-ai/sdk';

const client = new Opencode({
  baseURL: process.env.OPENCODE_BASE_URL ?? 'http://localhost:54321',
  logLevel: 'warn',
});

await client.app.get(); // verify server reachable
```

2) Choose model/provider

```ts
const { providers, default: defaults } = await client.app.providers();
// pick providerID + modelID (e.g. defaults?.something), then:
```

3) Start a session and subscribe to events

```ts
const session = await client.session.create();

const events = await client.event.list();
// Keep a map of messageID -> parts for UI.
for await (const ev of events) {
  if (ev.type === 'message.part.updated') {
    const part = ev.properties.part;
    if (part.sessionID !== session.id) continue;
    // update UI incrementally
  }
}
```

4) Send a user prompt

```ts
await client.session.chat(session.id, {
  providerID,
  modelID,
  parts: [{ type: 'text', text: userText }],
  // mode, system, tools optional
});
```

5) Refresh full transcript when needed

```ts
const transcript = await client.session.messages(session.id);
```

## Gaps / things not in the SDK

- No explicit API key / Authorization header mechanism is documented in this SDK.
  - That strongly suggests Opencode is expected to run locally and manage provider auth/config internally.
  - You *can* still send custom headers using `defaultHeaders` or per-request `headers` if your deployment requires it.
- No “chat-completions”-style endpoint; the chat entrypoint is `POST /session/{id}/message`.

## Reference: API surface index

The SDK’s human-readable API index is shipped in-repo as `api.md`:

- `GET /event` -> `client.event.list()` (SSE stream)
- `GET /app` -> `client.app.get()`
- `POST /app/init` -> `client.app.init()`
- `POST /log` -> `client.app.log()`
- `GET /mode` -> `client.app.modes()`
- `GET /config/providers` -> `client.app.providers()`
- `GET /config` -> `client.config.get()`
- `POST /session` -> `client.session.create()`
- `GET /session` -> `client.session.list()`
- `DELETE /session/{id}` -> `client.session.delete()`
- `POST /session/{id}/abort` -> `client.session.abort()`
- `POST /session/{id}/message` -> `client.session.chat()`
- `GET /session/{id}/message` -> `client.session.messages()`
- `POST /session/{id}/init` -> `client.session.init()`
- `POST /session/{id}/summarize` -> `client.session.summarize()`
- `POST /session/{id}/revert` -> `client.session.revert()`
- `POST /session/{id}/unrevert` -> `client.session.unrevert()`
- `POST /session/{id}/share` -> `client.session.share()`
- `DELETE /session/{id}/share` -> `client.session.unshare()`
- `GET /file` -> `client.file.read()`
- `GET /file/status` -> `client.file.status()`
- `GET /find/file` -> `client.find.files()`
- `GET /find/symbol` -> `client.find.symbols()`
- `GET /find` -> `client.find.text()`
- `POST /tui/append-prompt` -> `client.tui.appendPrompt()`
- `POST /tui/open-help` -> `client.tui.openHelp()`
