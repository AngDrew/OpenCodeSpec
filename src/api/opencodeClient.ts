// OpenCode API Client for VS Code Extension
// Uses the official OpenCode SDK (v2) to talk to `opencode serve`.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const OPENCODE_BASE_URL = 'http://127.0.0.1:4096';

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMessage {
  info: any;
  parts: any[];
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  /**
   * Agent classification from the OpenCode server.
   * - primary: selectable “mode” agents (e.g. build/plan)
   * - subagent: internal agents (e.g. title/summary/compaction)
   */
  mode?: 'subagent' | 'primary' | 'all';
  hidden?: boolean;
  model?: string;
  variant?: string;
}

export interface CommandInfo {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: 'command' | 'mcp' | 'skill';
  template: string;
  subtask?: boolean;
  hints?: string[];
}

export interface Config {
  agent?: {
    [key: string]: {
      model?: string;
      description?: string;
      disable?: boolean;
      variant?: string;
      mode?: 'subagent' | 'primary' | 'all';
      hidden?: boolean;
    };
  };
  model?: string;
  default_agent?: string;
}

export interface ConfigProvidersPayload {
  providers: Array<any>;
  default: Record<string, string>;
}

export interface ProviderListPayload {
  all: Array<any>;
  default?: Record<string, string>;
  connected?: string[];
}

export interface PromptRequest {
  parts: Array<{ type: 'text'; text: string }>;
  agent?: string;
  messageID?: string;
  variant?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
}

export interface CommandRequest {
  command: string;
  arguments: string;
  agent?: string;
  model?: string;
  variant?: string;
}

type SseEvent = { type: string; properties?: any };

export class OpenCodeClient {
  private baseUrl: string;
  private directory?: string;
  private _sdkClientPromise?: Promise<any>;

  constructor(baseUrl: string = OPENCODE_BASE_URL, opts?: { directory?: string }) {
    this.baseUrl = baseUrl;
    this.directory = opts?.directory;
  }

  setDirectory(directory?: string) {
    this.directory = directory;
    // Force re-create SDK client so x-opencode-directory header updates.
    this._sdkClientPromise = undefined;
  }

  private async _getSdkClient(): Promise<any> {
    if (!this._sdkClientPromise) {
      this._sdkClientPromise = (async () => {
        // SDK is ESM; use dynamic import from our CJS build.
        const mod = await import('@opencode-ai/sdk/v2/client');
        const createOpencodeClient = mod.createOpencodeClient as (config: any) => any;
        return createOpencodeClient({
          baseUrl: this.baseUrl,
          directory: this.directory,
        });
      })();
    }

    return this._sdkClientPromise;
  }

  async startServer(opts?: {
    hostname?: string;
    port?: number;
    timeout?: number;
    logLevel?: string;
    /** Optional absolute path to `opencode` binary. */
    binaryPath?: string;
  }): Promise<{ url: string; close: () => void }> {
    const normalizeLogLevel = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const v = value.trim();
      if (!v) return undefined;
      const upper = v.toUpperCase();
      if (upper === 'DEBUG' || upper === 'INFO' || upper === 'WARN' || upper === 'ERROR') {
        return upper;
      }
      return undefined;
    };

    const options = {
      hostname: opts?.hostname,
      port: opts?.port,
      timeout: opts?.timeout,
      config: normalizeLogLevel(opts?.logLevel) ? { logLevel: normalizeLogLevel(opts?.logLevel) } : undefined,
    };

    const isSpawnNotFound = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes('ENOENT') && msg.toLowerCase().includes('opencode');
    };

    try {
      const mod = await import('@opencode-ai/sdk/v2/server');
      const createOpencodeServer = mod.createOpencodeServer as (o: any) => Promise<{ url: string; close: () => void }>;
      return await createOpencodeServer(options);
    } catch (err) {
      if (!isSpawnNotFound(err)) {
        throw err;
      }

      // VS Code extension host on macOS often doesn't inherit the user's shell PATH.
      // Fall back to common install locations so we can still start `opencode serve`.
      const tried: string[] = [];
      const home = os.homedir();
      const isWin = process.platform === 'win32';
      const exe = isWin ? 'opencode.exe' : 'opencode';

      const candidates = [
        opts?.binaryPath,
        process.env.OPENCODE_BIN,
        process.env.OPENCODE_PATH,
        path.join(home, '.opencode', 'bin', exe),
        path.join(home, '.local', 'bin', exe),
        // Common system paths (best-effort).
        ...(isWin ? [] : ['/opt/homebrew/bin/opencode', '/usr/local/bin/opencode', '/usr/bin/opencode']),
      ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

      const existing = candidates.filter((p) => {
        try {
          return fs.existsSync(p) && !fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      });

      const spawnServerWithBin = async (binPath: string) => {
        const args = [
          'serve',
          `--hostname=${options.hostname ?? '127.0.0.1'}`,
          `--port=${options.port ?? 4096}`,
        ];
        if ((options as any)?.config?.logLevel) {
          args.push(`--log-level=${(options as any).config.logLevel}`);
        }

        const proc = spawn(binPath, args, {
          env: {
            ...process.env,
            OPENCODE_CONFIG_CONTENT: JSON.stringify((options as any)?.config ?? {}),
          },
        });

        const url = await new Promise<string>((resolve, reject) => {
          const timeoutMs = typeof options.timeout === 'number' ? options.timeout : 5000;
          const id = setTimeout(() => {
            reject(new Error(`Timeout waiting for server to start after ${timeoutMs}ms`));
          }, timeoutMs);

          let output = '';
          const onChunk = (chunk: any) => {
            output += chunk?.toString?.() ?? String(chunk);
            const lines = output.split('\n');
            for (const line of lines) {
              if (line.startsWith('opencode server listening')) {
                const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
                if (!match) {
                  clearTimeout(id);
                  reject(new Error(`Failed to parse server url from output: ${line}`));
                  return;
                }
                clearTimeout(id);
                resolve(match[1]);
                return;
              }
            }
          };

          proc.stdout?.on('data', onChunk);
          proc.stderr?.on('data', onChunk);

          proc.on('exit', (code) => {
            clearTimeout(id);
            let msg = `Server exited with code ${code}`;
            if (output.trim()) msg += `\nServer output: ${output}`;
            reject(new Error(msg));
          });
          proc.on('error', (e) => {
            clearTimeout(id);
            reject(e);
          });
        });

        return {
          url,
          close() {
            proc.kill();
          },
        };
      };

      for (const bin of existing) {
        tried.push(bin);
        try {
          return await spawnServerWithBin(bin);
        } catch {
          // Try next candidate.
        }
      }

      const msg = err instanceof Error ? err.message : String(err);
      const hint = tried.length > 0
        ? `Tried: ${tried.join(', ')}`
        : 'No opencode binary candidates found.';
      throw new Error(`${msg}\n${hint}`);
    }
  }

  private _dataOptions(extra?: Record<string, any>): Record<string, any> {
    return { responseStyle: 'data', ...(extra ?? {}) };
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    const client = await this._getSdkClient();

    const parse = (raw: any): { healthy: boolean; version: string } | undefined => {
      const value = raw?.data ?? raw;
      if (!value) return undefined;

      if (typeof value.healthy === 'boolean') {
        return {
          healthy: value.healthy,
          version: typeof value.version === 'string' ? value.version : '',
        };
      }

      // Legacy/alternate shapes we've seen in the wild.
      if (typeof value.ok === 'boolean') {
        return {
          healthy: value.ok,
          version: typeof value.version === 'string' ? value.version : '',
        };
      }
      if (typeof value.status === 'string') {
        const status = value.status.toLowerCase();
        if (status === 'ok' || status === 'healthy') {
          return { healthy: true, version: typeof value.version === 'string' ? value.version : '' };
        }
        if (status === 'error' || status === 'unhealthy') {
          return { healthy: false, version: typeof value.version === 'string' ? value.version : '' };
        }
      }

      return undefined;
    };

    const tryFallback = async (): Promise<{ healthy: boolean; version: string } | undefined> => {
      const fetchImpl = (globalThis as any)?.fetch as undefined | ((...args: any[]) => Promise<any>);
      if (typeof fetchImpl !== 'function') return undefined;

      const headers: Record<string, string> = {};
      if (this.directory) {
        const isNonASCII = /[^\x00-\x7F]/.test(this.directory);
        const encodedDirectory = isNonASCII ? encodeURIComponent(this.directory) : this.directory;
        headers['x-opencode-directory'] = encodedDirectory;
      }

      const candidates = ['/health', '/global/health'];
      for (const path of candidates) {
        let url: URL;
        try {
          url = new URL(path, this.baseUrl);
        } catch {
          continue;
        }

        try {
          const res = await fetchImpl(url.toString(), {
            method: 'GET',
            headers: Object.keys(headers).length ? headers : undefined,
          });

          if (!res?.ok) continue;

          const text = typeof res.text === 'function' ? await res.text() : '';
          if (!text) {
            // If endpoint exists and returns 200 with an empty body, treat as reachable.
            return { healthy: true, version: '' };
          }

          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            json = text;
          }

          const parsed = parse(json);
          if (parsed) return parsed;
          if (typeof json === 'string' && json.trim().toLowerCase() === 'ok') {
            return { healthy: true, version: '' };
          }
        } catch {
          // Try next candidate.
        }
      }

      return undefined;
    };

    // NOTE: global.health() takes only an options object (no parameters arg).
    // Use throwOnError so connection errors are surfaced properly.
    let raw: any;
    try {
      raw = await client.global.health(this._dataOptions({ throwOnError: true }));
    } catch (err) {
      const fallback = await tryFallback();
      if (fallback) return fallback;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to reach OpenCode server at ${this.baseUrl}: ${msg}`);
    }

    const parsed = parse(raw);
    if (parsed) return parsed;

    const fallback = await tryFallback();
    if (fallback) return fallback;

    throw new Error(`Unexpected health response from OpenCode server at ${this.baseUrl}`);
  }

  async createSession(request?: { title?: string }): Promise<Session> {
    const client = await this._getSdkClient();
    const result = await client.session.create({
      directory: this.directory,
      title: request?.title,
    }, this._dataOptions());
    return result as Session;
  }

  async getSession(sessionId: string): Promise<Session> {
    const client = await this._getSdkClient();
    const opts = this._dataOptions();

    const calls: Array<() => Promise<any>> = [];
    if (client?.session?.get) {
      calls.push(() => client.session.get({ sessionID: sessionId, directory: this.directory }, opts));
      calls.push(() => client.session.get({ sessionID: sessionId }, opts));
      calls.push(() => client.session.get(sessionId, opts));
    }
    if (client?.session?.retrieve) {
      calls.push(() => client.session.retrieve({ sessionID: sessionId, directory: this.directory }, opts));
      calls.push(() => client.session.retrieve({ sessionID: sessionId }, opts));
      calls.push(() => client.session.retrieve(sessionId, opts));
    }

    let lastErr: unknown;
    for (const fn of calls) {
      try {
        const raw = await fn();
        const value = raw?.data ?? raw;
        if (value && typeof value.id === 'string') {
          return value as Session;
        }
        return raw as Session;
      } catch (err) {
        lastErr = err;
      }
    }

    throw (lastErr instanceof Error ? lastErr : new Error('Failed to get session'));
  }

  async listSessions(): Promise<Session[]> {
    const client = await this._getSdkClient();
    const opts = this._dataOptions();

    const calls: Array<() => Promise<any>> = [];
    if (client?.session?.list) {
      calls.push(() => client.session.list({ directory: this.directory }, opts));
      calls.push(() => client.session.list({ directory: this.directory }));
      calls.push(() => client.session.list(opts));
      calls.push(() => client.session.list());
    }

    let lastErr: unknown;
    for (const fn of calls) {
      try {
        const raw = await fn();
        const value = raw?.data ?? raw;
        if (Array.isArray(value)) {
          return value as Session[];
        }
        if (Array.isArray(raw)) {
          return raw as Session[];
        }
      } catch (err) {
        lastErr = err;
      }
    }

    throw (lastErr instanceof Error ? lastErr : new Error('Failed to list sessions'));
  }

  async getSessionMessages(sessionId: string, request?: { limit?: number }): Promise<SessionMessage[]> {
    const client = await this._getSdkClient();
    const opts = this._dataOptions();

    const calls: Array<() => Promise<any>> = [];
    if (client?.session?.messages) {
      calls.push(() => client.session.messages({ sessionID: sessionId, directory: this.directory, limit: request?.limit }, opts));
      calls.push(() => client.session.messages({ sessionID: sessionId, directory: this.directory }, opts));
      calls.push(() => client.session.messages({ sessionID: sessionId }, opts));
      calls.push(() => client.session.messages(sessionId, opts));
      calls.push(() => client.session.messages({ sessionID: sessionId, directory: this.directory, limit: request?.limit }));
      calls.push(() => client.session.messages({ sessionID: sessionId, directory: this.directory }));
      calls.push(() => client.session.messages({ sessionID: sessionId }));
      calls.push(() => client.session.messages(sessionId));
    }

    let lastErr: unknown;
    for (const fn of calls) {
      try {
        const raw = await fn();
        const value = raw?.data ?? raw;
        if (Array.isArray(value)) {
          return value as SessionMessage[];
        }
        if (Array.isArray(raw)) {
          return raw as SessionMessage[];
        }
      } catch (err) {
        lastErr = err;
      }
    }

    throw (lastErr instanceof Error ? lastErr : new Error('Failed to get session messages'));
  }

  async abortSession(sessionId: string): Promise<void> {
    const client = await this._getSdkClient();
    await client.session.abort({ sessionID: sessionId, directory: this.directory }, this._dataOptions());
  }

  async listAgents(): Promise<Agent[]> {
    const client = await this._getSdkClient();
    const agents = await client.app.agents({ directory: this.directory }, this._dataOptions());
    return (agents as any[]).map((a) => ({
      id: a.name,
      name: a.name,
      description: a.description,
      mode: (a && typeof a.mode === 'string') ? a.mode : undefined,
      hidden: (a && typeof a.hidden === 'boolean') ? a.hidden : undefined,
      model: a.model ? `${a.model.providerID}/${a.model.modelID}` : undefined,
      variant: typeof a.variant === 'string' ? a.variant : undefined,
    }));
  }

  async listCommands(): Promise<CommandInfo[]> {
    const client = await this._getSdkClient();
    const result = await client.command.list({ directory: this.directory }, this._dataOptions());
    const value = result?.data ?? result;
    return Array.isArray(value) ? (value as CommandInfo[]) : [];
  }

  async getConfig(): Promise<Config> {
    const client = await this._getSdkClient();
    // Both /config and /global/config exist; /config supports directory scoping.
    const cfg = await client.config.get({ directory: this.directory }, this._dataOptions());
    return cfg as Config;
  }

  async getGlobalConfig(): Promise<Config> {
    const client = await this._getSdkClient();
    const cfg = await client.global.config.get(this._dataOptions());
    return cfg as Config;
  }

  async getConfigProviders(): Promise<ConfigProvidersPayload> {
    const client = await this._getSdkClient();
    const result = await client.config.providers({ directory: this.directory }, this._dataOptions());
    return result as ConfigProvidersPayload;
  }

  async listProviders(): Promise<ProviderListPayload> {
    const client = await this._getSdkClient();
    const result = await client.provider.list({ directory: this.directory }, this._dataOptions());
    const value = result?.data ?? result;
    return value as ProviderListPayload;
  }

  async prompt(sessionId: string, request: PromptRequest): Promise<{ text: string; raw: any; assistantMessageId?: string }> {
    const client = await this._getSdkClient();
    // In SDK, session.prompt() maps to POST /session/{sessionID}/message
    const result = await client.session.prompt({
      sessionID: sessionId,
      directory: this.directory,
      messageID: request.messageID,
      agent: request.agent,
      model: request.model,
      variant: request.variant,
      parts: request.parts,
    }, this._dataOptions());

    const parts = (result?.parts ?? []) as any[];
    const text = parts
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');

    const assistantMessageId = result?.info?.id;
    return { text, raw: result, assistantMessageId };
  }

  async sendCommand(sessionId: string, request: CommandRequest): Promise<{ text: string; raw: any; assistantMessageId?: string }> {
    const client = await this._getSdkClient();
    const result = await client.session.command({
      sessionID: sessionId,
      directory: this.directory,
      agent: request.agent,
      model: request.model,
      variant: request.variant,
      command: request.command,
      arguments: request.arguments,
    }, this._dataOptions());

    const parts = (result?.parts ?? []) as any[];
    const text = parts
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');

    const assistantMessageId = result?.info?.id;
    return { text, raw: result, assistantMessageId };
  }

  async promptAsync(sessionId: string, request: PromptRequest): Promise<void> {
    const client = await this._getSdkClient();
    // In SDK, session.promptAsync() maps to POST /session/{sessionID}/prompt_async
    await client.session.promptAsync({
      sessionID: sessionId,
      directory: this.directory,
      messageID: request.messageID,
      agent: request.agent,
      model: request.model,
      variant: request.variant,
      parts: request.parts,
    }, this._dataOptions());
  }

  async subscribeEvents(onEvent: (evt: SseEvent) => void, opts?: { signal?: AbortSignal }): Promise<void> {
    const client = await this._getSdkClient();
    const sse = await client.event.subscribe(
      { directory: this.directory },
      opts?.signal ? { signal: opts.signal } : undefined
    );
    for await (const evt of sse.stream as AsyncIterable<any>) {
      if (opts?.signal?.aborted) {
        break;
      }
      onEvent(evt as SseEvent);
    }
  }
}
