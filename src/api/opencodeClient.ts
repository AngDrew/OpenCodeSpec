// OpenCode API Client for VS Code Extension
// Uses the official OpenCode SDK (v2) to talk to `opencode serve`.

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
  model?: string;
}

export interface Config {
  agent?: {
    [key: string]: {
      model?: string;
      description?: string;
      disable?: boolean;
    };
  };
  model?: string;
}

export interface ConfigProvidersPayload {
  providers: Array<any>;
  default: Record<string, string>;
}

export interface PromptRequest {
  parts: Array<{ type: 'text'; text: string }>;
  agent?: string;
  messageID?: string;
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

  async startServer(opts?: { hostname?: string; port?: number; timeout?: number; logLevel?: string }): Promise<{ url: string; close: () => void }> {
    const mod = await import('@opencode-ai/sdk/v2/server');
    const createOpencodeServer = mod.createOpencodeServer as (options: any) => Promise<{ url: string; close: () => void }>;
    return createOpencodeServer({
      hostname: opts?.hostname,
      port: opts?.port,
      timeout: opts?.timeout,
      config: opts?.logLevel ? { logLevel: opts.logLevel } : undefined,
    });
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
      model: a.model ? `${a.model.providerID}/${a.model.modelID}` : undefined,
    }));
  }

  async getConfig(): Promise<Config> {
    const client = await this._getSdkClient();
    // Both /config and /global/config exist; /config supports directory scoping.
    const cfg = await client.config.get({ directory: this.directory }, this._dataOptions());
    return cfg as Config;
  }

  async getConfigProviders(): Promise<ConfigProvidersPayload> {
    const client = await this._getSdkClient();
    const result = await client.config.providers({ directory: this.directory }, this._dataOptions());
    return result as ConfigProvidersPayload;
  }

  async prompt(sessionId: string, request: PromptRequest): Promise<{ text: string; raw: any; assistantMessageId?: string }> {
    const client = await this._getSdkClient();
    // In SDK, session.prompt() maps to POST /session/{sessionID}/message
    const result = await client.session.prompt({
      sessionID: sessionId,
      directory: this.directory,
      messageID: request.messageID,
      agent: request.agent,
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

  async promptAsync(sessionId: string, request: PromptRequest): Promise<void> {
    const client = await this._getSdkClient();
    // In SDK, session.promptAsync() maps to POST /session/{sessionID}/prompt_async
    await client.session.promptAsync({
      sessionID: sessionId,
      directory: this.directory,
      messageID: request.messageID,
      agent: request.agent,
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
