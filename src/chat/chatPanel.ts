import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { getNonce } from './utils';
import { OpenCodeClient } from '../api/opencodeClient';
import type { PromptRequest } from '../api/opencodeClient';
import type { Session } from '../api/opencodeClient';

interface ConnectionHistory {
  url: string;
  lastConnected: number;
}

interface SessionPrefs {
  agent?: string;
  model?: string;
  variant?: string;
}

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'opencode.chatView';
  private static readonly _sessionStateKeyPrefix = 'opencodeChat.sessionState:';
  
  private _view?: vscode.WebviewView;
  private _client: OpenCodeClient;
  private _currentSessionId?: string;
  private _isConnected: boolean = false;
  private _currentUrl: string = 'http://127.0.0.1:4096';
  private _connectionHistory: ConnectionHistory[] = [];
  private _workspaceDirectory?: string;
  private _eventAbortController?: AbortController;
  private _isServerStartedByExtension: boolean = false;
  private _serverHandle?: { url: string; close: () => void };
  private _activeAssistantMessageId?: string;
  private _isGenerating: boolean = false;
  private _generationSeq: number = 0;
  private _generationStartedAt: number = 0;
  private _generationHasSeenBusy: boolean = false;
  private _hasReceivedTextPartUpdate: boolean = false;
  private _suppressTextPartUpdates: boolean = false;
  private _generationSafetyTimer?: ReturnType<typeof setTimeout>;
  private _isRestoringSession: boolean = false;
  private _isLoadingHistory: boolean = false;
  private _hasRenderedInitialHistory: boolean = false;
  private _lastHistorySessionId?: string;
  private _pendingHistorySessionId?: string;
  private _historyReloadTimer?: ReturnType<typeof setTimeout>;
  private _hasBoundStreamingMessageId: boolean = false;
  private _modelContextLimitById: Map<string, number> = new Map();
  private _defaultModelContextLimit?: number;
  private _lastContextUsedTokens?: number;
  private _lastContextMaxTokens?: number;
  private _currentModel?: string;
  private _currentVariant?: string;
  private _currentAgent?: string;
  private _sessionPrefsByUrl: Record<string, Record<string, SessionPrefs>> = {};
  private _sessionsReloadTimer?: ReturnType<typeof setTimeout>;
  private _sessionsListLimit: number = 100;
  private _titleRenameAttemptedSessions: Set<string> = new Set();
  private _titleRenameInFlightSessions: Set<string> = new Set();
  private _titleRenamePendingSessions: Set<string> = new Set();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
  ) {
    this._workspaceDirectory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this._client = new OpenCodeClient(this._currentUrl, { directory: this._workspaceDirectory });
    this._loadConnectionHistory();
    this._restorePersistedSessionState();
  }

  private _getSessionStateKey(): string {
    const dir = this._workspaceDirectory || 'global';
    return `${ChatPanelProvider._sessionStateKeyPrefix}${encodeURIComponent(dir)}`;
  }

  private _restorePersistedSessionState() {
    try {
      const key = this._getSessionStateKey();
      const stored = this._context.workspaceState.get(key) as any;
      if (!stored || typeof stored !== 'object') return;
      if (typeof stored.url === 'string' && stored.url.length > 0) {
        this._currentUrl = stored.url;
      }
      // Intentionally do not restore the previous session ID.
      // Default behavior should start a fresh session on startup.
      this._currentSessionId = undefined;
      if (stored.sessionPrefsByUrl && typeof stored.sessionPrefsByUrl === 'object') {
        this._sessionPrefsByUrl = stored.sessionPrefsByUrl as Record<string, Record<string, SessionPrefs>>;
      }
      // Recreate client so baseUrl reflects restored url.
      this._client = new OpenCodeClient(this._currentUrl, { directory: this._workspaceDirectory });
    } catch {
      // noop
    }
  }

  private async _persistSessionState() {
    try {
      const key = this._getSessionStateKey();
      await this._context.workspaceState.update(key, {
        url: this._currentUrl,
        directory: this._workspaceDirectory,
        sessionId: this._currentSessionId,
        sessionPrefsByUrl: this._sessionPrefsByUrl,
      });
    } catch {
      // noop
    }
  }

  private _getPrefsStoreForUrl(url: string): Record<string, SessionPrefs> {
    const key = url || 'default';
    if (!this._sessionPrefsByUrl[key]) {
      this._sessionPrefsByUrl[key] = {};
    }
    return this._sessionPrefsByUrl[key];
  }

  private _getSessionPrefs(url: string, sessionId: string): SessionPrefs | undefined {
    if (!url || !sessionId) return undefined;
    const byId = this._sessionPrefsByUrl?.[url];
    const prefs = byId ? byId[sessionId] : undefined;
    if (!prefs || typeof prefs !== 'object') return undefined;
    return prefs;
  }

  private _recordSessionPrefs(url: string, sessionId: string, patch: SessionPrefs) {
    if (!url || !sessionId) return;
    const byId = this._getPrefsStoreForUrl(url);
    const prev = byId[sessionId] && typeof byId[sessionId] === 'object' ? byId[sessionId] : {};
    byId[sessionId] = {
      ...prev,
      ...patch,
    };
    void this._persistSessionState();
  }

  private _isPlaceholderSessionTitle(title: unknown): boolean {
    if (typeof title !== 'string') return true;
    const normalized = title.trim().toLowerCase();
    if (!normalized) return true;
    return normalized === 'chat session' || normalized === 'new session';
  }

  private _buildSessionTitleFromInput(input: string): string | undefined {
    const compact = String(input || '').replace(/\s+/g, ' ').trim();
    if (!compact) return undefined;

    const withoutPrefix = compact.startsWith('/') ? compact.slice(1).trim() : compact;
    const sanitized = withoutPrefix.replace(/["':]/g, '').trim();
    const base = sanitized || withoutPrefix;
    if (!base) return undefined;

    const maxLen = 50;
    return base.length > maxLen ? base.slice(0, maxLen).trimEnd() : base;
  }

  private async _maybeRenameSessionFromFirstInput(sessionId: string, userInput: string) {
    if (!sessionId) return;
    if (!this._titleRenamePendingSessions.has(sessionId)) return;
    if (this._titleRenameAttemptedSessions.has(sessionId)) return;
    if (this._titleRenameInFlightSessions.has(sessionId)) return;

    const nextTitle = this._buildSessionTitleFromInput(userInput);
    if (!nextTitle) {
      this._titleRenamePendingSessions.delete(sessionId);
      this._titleRenameAttemptedSessions.add(sessionId);
      return;
    }

    this._titleRenameInFlightSessions.add(sessionId);
    try {
      const session = await this._client.getSession(sessionId);

      const currentTitle = typeof session?.title === 'string' ? session.title.trim() : '';
      if (!this._isPlaceholderSessionTitle(currentTitle)) {
        this._titleRenamePendingSessions.delete(sessionId);
        this._titleRenameAttemptedSessions.add(sessionId);
        return;
      }

      if (currentTitle === nextTitle) {
        this._titleRenamePendingSessions.delete(sessionId);
        this._titleRenameAttemptedSessions.add(sessionId);
        return;
      }

      await this._client.updateSession(sessionId, { title: nextTitle });
      this._titleRenamePendingSessions.delete(sessionId);
      this._titleRenameAttemptedSessions.add(sessionId);
      this._scheduleSessionsReload('background title rename');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[OpenCode] Background title rename skipped:', msg);
      this._titleRenameAttemptedSessions.add(sessionId);
    } finally {
      this._titleRenameInFlightSessions.delete(sessionId);
    }
  }

  private _getSessionSortTimestamp(session: Session): number {
    const s = session as any;
    const t = s?.time;
    if (t && typeof t.updated === 'number' && Number.isFinite(t.updated)) return t.updated;
    if (t && typeof t.created === 'number' && Number.isFinite(t.created)) return t.created;

    const parsed = Date.parse(String(s?.updatedAt || s?.createdAt || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async _ensureActiveSession(opts?: { preferLatest?: boolean }): Promise<string> {
    if (this._isRestoringSession) {
      // Avoid re-entrancy; return best effort.
      if (this._currentSessionId) return this._currentSessionId;
    }

    const preferLatest = opts?.preferLatest === true;

    this._isRestoringSession = true;
    try {
      const candidate = this._currentSessionId;
      let isCandidateValid = false;
      if (candidate && String(candidate).trim().length > 0) {
        try {
          await this._client.getSession(candidate);
          isCandidateValid = true;
          if (!preferLatest) {
            await this._persistSessionState();
            return candidate;
          }
        } catch {
          // Invalid or missing on server; fall through to create.
        }
      }

      if (preferLatest) {
        try {
          const sessions = await this._client.listSessions({
            limit: Math.max(this._sessionsListLimit, 100),
          });
          const latest = (sessions || [])
            .filter((s) => s && typeof (s as any).id === 'string' && String((s as any).id).trim().length > 0)
            .sort((a, b) => {
              const at = this._getSessionSortTimestamp(a as Session);
              const bt = this._getSessionSortTimestamp(b as Session);
              if (at !== bt) return bt - at;
              return String((a as any).id).localeCompare(String((b as any).id));
            })[0];

          if (latest && typeof latest.id === 'string') {
            this._currentSessionId = latest.id;
            console.log('[OpenCode] Using latest server session:', latest.id);
            await this._persistSessionState();
            return latest.id;
          }
        } catch {
          // noop
        }

        if (isCandidateValid && candidate) {
          this._currentSessionId = candidate;
          await this._persistSessionState();
          return candidate;
        }
      }

      const created = await this._client.createSession({});
      this._currentSessionId = created.id;
      this._titleRenamePendingSessions.add(created.id);
      console.log('[OpenCode] Using session:', created.id);
      this._view?.webview.postMessage({
        type: 'sessionCreated',
        sessionId: created.id,
      });
      await this._persistSessionState();
      return created.id;
    } finally {
      this._isRestoringSession = false;
    }
  }

  private _scheduleSessionsReload(reason: string) {
    if (!this._isConnected) return;
    if (!this._view) return;
    if (this._sessionsReloadTimer) return;

    this._sessionsReloadTimer = setTimeout(() => {
      this._sessionsReloadTimer = undefined;
      if (!this._isConnected) return;
      void this._handleGetSessions();
    }, 250);

    if (reason) {
      console.log('[OpenCode] Scheduling sessions reload:', reason);
    }
  }

  private async _loadSessionHistory(sessionId?: string) {
    if (!this._view) return;
    if (!this._isConnected) return;
    const sid = sessionId ?? this._currentSessionId;
    if (!sid) return;
    if (this._isLoadingHistory) {
      this._pendingHistorySessionId = sid;
      return;
    }

    this._isLoadingHistory = true;
    try {
      const messages = await this._client.getSessionMessages(sid);
      this._view.webview.postMessage({
        type: 'setHistory',
        sessionId: sid,
        messages,
      });

      // Best-effort: update context indicator based on the last assistant message.
      try {
        const lastAssistant = [...(messages || [])].reverse().find((m: any) => m?.info?.role === 'assistant');
        if (lastAssistant?.info) {
          this._updateContextIndicatorFromMessage(lastAssistant.info);
        }
      } catch {
        // noop
      }

      this._hasRenderedInitialHistory = true;
      this._lastHistorySessionId = sid;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[OpenCode] Failed to load session history:', msg);
    } finally {
      this._isLoadingHistory = false;

      const pending = this._pendingHistorySessionId;
      this._pendingHistorySessionId = undefined;
      if (pending && pending !== sid && this._isConnected) {
        // Load the latest requested session after the current one.
        void this._loadSessionHistory(pending);
      } else if (pending && pending === sid && this._isConnected) {
        // If we coalesced multiple requests for the same session, run once more.
        void this._loadSessionHistory(sid);
      }
    }
  }

  private async _handleNewChat() {
    if (!this._isConnected) return;

    const session = await this._client.createSession({});
    this._currentSessionId = session.id;
    this._titleRenamePendingSessions.add(session.id);
    this._activeAssistantMessageId = undefined;
    this._hasRenderedInitialHistory = false;
    this._lastHistorySessionId = undefined;
    await this._persistSessionState();

    this._view?.webview.postMessage({
      type: 'sessionCreated',
      sessionId: session.id,
    });

    await this._loadSessionHistory(session.id);
  }

  private _loadConnectionHistory() {
    // Load from extension state or default
    this._connectionHistory = [
      { url: 'http://127.0.0.1:4096', lastConnected: Date.now() },
      { url: 'http://localhost:4096', lastConnected: Date.now() - 86400000 },
    ];
  }

  private _saveConnectionHistory() {
    // Persist to extension state
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage':
          if (!this._isConnected) {
            this._view?.webview.postMessage({
              type: 'error',
              message: 'Not connected to OpenCode server. Please check connection.'
            });
            return;
          }
          if (typeof data.model === 'string') {
            this._setCurrentModel(data.model);
          }
          if (typeof data.variant === 'string') {
            const v = data.variant.trim();
            this._currentVariant = v.length > 0 ? v : undefined;
          }
          await this._handleSendMessage(data.text, data.agent);
          break;
        case 'newChat':
          if (this._isConnected) {
            await this._handleNewChat();
          }
          break;
        case 'getAgents':
          if (this._isConnected) {
            await this._handleGetAgents();
          }
          break;
        case 'getModels':
          if (this._isConnected) {
            await this._handleGetModels();
          }
          break;
        case 'getSessions':
          if (this._isConnected) {
            // Allow the webview to request a larger page size (best-effort pagination).
            try {
              const reqLimit = typeof (data as any)?.limit === 'number' ? (data as any).limit : undefined;
              if (typeof reqLimit === 'number' && Number.isFinite(reqLimit) && reqLimit > 0) {
                const next = Math.max(10, Math.min(Math.floor(reqLimit), 500));
                this._sessionsListLimit = next;
              }
            } catch {
              // noop
            }
            await this._handleGetSessions();
          }
          break;
        // Model/agent selection now happens inside the webview (palette UI).
        case 'getCommands':
          if (this._isConnected) {
            await this._handleGetCommands();
          }
          break;
        case 'createSession':
          if (this._isConnected) {
            await this._handleCreateSession();
          }
          break;
        case 'changeSession':
          if (this._isConnected && typeof (data as any).sessionId === 'string') {
            await this._handleChangeSession(String((data as any).sessionId));
          }
          break;
        case 'sessionListPage':
          if (this._isConnected) {
            try {
              const delta = typeof (data as any)?.delta === 'number' ? (data as any).delta : 0;
              const next = this._sessionsListLimit + (Number.isFinite(delta) ? delta : 0);
              this._sessionsListLimit = Math.max(10, Math.min(next, 500));
            } catch {
              // noop
            }
            await this._handleGetSessions();
          }
          break;
        case 'healthCheck':
          await this._handleHealthCheck();
          break;
        case 'sendCommand':
          if (!this._isConnected) {
            this._view?.webview.postMessage({
              type: 'error',
              message: 'Not connected to OpenCode server. Please check connection.'
            });
            return;
          }
          if (typeof data.model === 'string') {
            this._setCurrentModel(data.model);
          }
          if (typeof data.variant === 'string') {
            const v = data.variant.trim();
            this._currentVariant = v.length > 0 ? v : undefined;
          }
          await this._handleSendCommand(data.command, data.arguments, data.agent);
          break;
        case 'stopGeneration':
          if (this._isConnected) {
            await this._handleStopGeneration();
          }
          break;
        case 'openConnectionDialog':
          await this._handleOpenConnectionDialog();
          break;
        case 'connectToUrl':
          await this._handleConnectToUrl(data.url);
          break;
        case 'startServer':
          await this.startLocalServer();
          break;
        case 'stopServer':
          await this.stopLocalServer();
          break;
        case 'modeChanged':
          if (typeof (data as any).mode === 'string') {
            const m = String((data as any).mode).trim();
            this._currentAgent = m.length > 0 ? m : undefined;
          }
          if (this._currentUrl && this._currentSessionId) {
            this._recordSessionPrefs(this._currentUrl, this._currentSessionId, { agent: this._currentAgent });
          }
          break;
        case 'modelChanged':
          if (typeof data.model === 'string') {
            this._setCurrentModel(data.model);
          }
          if (this._currentUrl && this._currentSessionId) {
            this._recordSessionPrefs(this._currentUrl, this._currentSessionId, { model: this._currentModel });
          }
          break;
        case 'variantChanged':
          if (typeof data.variant === 'string') {
            const v = data.variant.trim();
            this._currentVariant = v.length > 0 ? v : undefined;
          }
          if (this._currentUrl && this._currentSessionId) {
            this._recordSessionPrefs(this._currentUrl, this._currentSessionId, { variant: this._currentVariant });
          }
          break;
        case 'showContextInfo':
          if (typeof this._lastContextUsedTokens === 'number' && typeof this._lastContextMaxTokens === 'number') {
            const pct = Math.min(Math.round((this._lastContextUsedTokens / this._lastContextMaxTokens) * 100), 100);
            void vscode.window.showInformationMessage(
              `Context window: ${this._lastContextUsedTokens.toLocaleString()} / ${this._lastContextMaxTokens.toLocaleString()} tokens (${pct}%)`
            );
          } else {
            void vscode.window.showInformationMessage('Context window usage is not available yet. Send a message first.');
          }
          break;
      }
    });

    // Initial health check
    this._handleHealthCheck();
  }

  public sendMessage(text: string) {
    if (this._view && this._isConnected) {
      this._view.webview.postMessage({ type: 'externalMessage', text });
    }
  }

  public async startLocalServer() {
    await this._handleStartServer();
  }

  public async stopLocalServer() {
    await this._handleStopServer();
  }

  private async _handleConnectToUrl(url: string) {
    this._currentUrl = url;
    this._client = new OpenCodeClient(url, { directory: this._workspaceDirectory });
    this._currentSessionId = undefined;
    this._hasRenderedInitialHistory = false;
    this._lastHistorySessionId = undefined;
    this._modelContextLimitById.clear();
    this._defaultModelContextLimit = undefined;
    this._lastContextUsedTokens = undefined;
    this._lastContextMaxTokens = undefined;
    this._setCurrentModel(undefined);
    this._currentVariant = undefined;
    this._currentAgent = undefined;
    this._titleRenameAttemptedSessions.clear();
    this._titleRenameInFlightSessions.clear();
    this._titleRenamePendingSessions.clear();
    
    // Update history
    const existingIndex = this._connectionHistory.findIndex(h => h.url === url);
    if (existingIndex >= 0) {
      this._connectionHistory[existingIndex].lastConnected = Date.now();
    } else {
      this._connectionHistory.unshift({ url, lastConnected: Date.now() });
    }
    // Keep only last 10
    this._connectionHistory = this._connectionHistory.slice(0, 10);
    this._saveConnectionHistory();
    
    // Check health with error display
    await this._handleHealthCheck(true);
  }

  private async _handleGetSessions() {
    try {
      const sessions = await this._client.listSessions({ limit: this._sessionsListLimit });
      const list = (sessions || [])
        .filter((s) => s && typeof (s as any).id === 'string')
        .sort((a, b) => {
          const at = (a as any)?.time && typeof (a as any).time.updated === 'number'
            ? (a as any).time.updated
            : (a as any)?.time && typeof (a as any).time.created === 'number'
              ? (a as any).time.created
              : Date.parse(String((a as any).updatedAt || (a as any).createdAt || ''));
          const bt = (b as any)?.time && typeof (b as any).time.updated === 'number'
            ? (b as any).time.updated
            : (b as any)?.time && typeof (b as any).time.created === 'number'
              ? (b as any).time.created
              : Date.parse(String((b as any).updatedAt || (b as any).createdAt || ''));
          if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
          return String((a as any).id).localeCompare(String((b as any).id));
        });

      this._view?.webview.postMessage({
        type: 'sessionsList',
        sessions: list,
        currentSessionId: this._currentSessionId,
        limit: this._sessionsListLimit,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[OpenCode] Failed to list sessions:', msg);
      this._view?.webview.postMessage({
        type: 'sessionsList',
        sessions: [],
        currentSessionId: this._currentSessionId,
        limit: this._sessionsListLimit,
      });
    }
  }

  private async _handleChangeSession(sessionIdRaw: string) {
    if (!this._isConnected) return;

    const sessionId = String(sessionIdRaw || '').trim();
    if (!sessionId) return;

    // End UI streaming immediately; do not attempt to abort on the server.
    this._endStreamingUI('session switch');

    const prevSessionId = this._currentSessionId || (await this._ensureActiveSession());
    const prevPrefs: SessionPrefs = {
      agent: this._currentAgent,
      model: this._currentModel,
      variant: this._currentVariant,
    };
    if (this._currentUrl && prevSessionId) {
      this._recordSessionPrefs(this._currentUrl, prevSessionId, prevPrefs);
    }

    this._currentSessionId = sessionId;
    this._activeAssistantMessageId = undefined;
    this._hasRenderedInitialHistory = false;
    this._lastHistorySessionId = undefined;
    this._pendingHistorySessionId = undefined;

    // Prefer stored prefs for the target session; otherwise inherit from the previous session.
    const stored = this._currentUrl ? this._getSessionPrefs(this._currentUrl, sessionId) : undefined;
    const next = stored || prevPrefs;
    if (next.agent && typeof next.agent === 'string' && next.agent.trim().length > 0) {
      this._currentAgent = next.agent.trim();
    }
    if (next.model && typeof next.model === 'string' && next.model.trim().length > 0) {
      this._setCurrentModel(next.model);
    }
    if (typeof next.variant === 'string') {
      const v = next.variant.trim();
      this._currentVariant = v.length > 0 ? v : undefined;
    }

    if (this._currentUrl) {
      this._recordSessionPrefs(this._currentUrl, sessionId, {
        agent: this._currentAgent,
        model: this._currentModel,
        variant: this._currentVariant,
      });
    }

    this._view?.webview.postMessage({
      type: 'defaults',
      agent: this._currentAgent,
      model: this._currentModel,
      variant: this._currentVariant,
    });

    this._lastContextUsedTokens = undefined;
    this._lastContextMaxTokens = undefined;
    this._view?.webview.postMessage({ type: 'contextUpdate', usedTokens: 0, maxTokens: 1 });

    await this._persistSessionState();
    await this._loadSessionHistory(sessionId);
    void this._handleGetSessions();
  }

  // Agent/model selection is handled inside the webview (picker palette).

  private _normalizeModelSelectionId(modelId: unknown): string | undefined {
    if (typeof modelId !== 'string') return undefined;
    const trimmed = modelId.trim();
    if (!trimmed) return undefined;

    const slash = trimmed.indexOf('/');
    if (slash <= 0 || slash >= trimmed.length - 1) {
      return trimmed;
    }

    const providerID = trimmed.slice(0, slash).trim();
    const rawModelID = trimmed.slice(slash + 1).trim();
    if (!providerID || !rawModelID) return trimmed;

    const prefix = `${providerID}/`;
    const modelID = rawModelID.startsWith(prefix)
      ? rawModelID.slice(prefix.length)
      : rawModelID;
    if (!modelID) return trimmed;

    return `${providerID}/${modelID}`;
  }

  private _toModelOverride(modelId: unknown): { providerID: string; modelID: string } | undefined {
    const normalized = this._normalizeModelSelectionId(modelId);
    if (!normalized) return undefined;

    const slash = normalized.indexOf('/');
    if (slash <= 0 || slash >= normalized.length - 1) return undefined;

    return {
      providerID: normalized.slice(0, slash),
      modelID: normalized.slice(slash + 1),
    };
  }

  private _setCurrentModel(modelId: unknown) {
    this._currentModel = this._normalizeModelSelectionId(modelId);
  }

  private _toModelSelectionId(modelRef: unknown): string | undefined {
    if (typeof modelRef === 'string') {
      return this._normalizeModelSelectionId(modelRef);
    }

    if (!modelRef || typeof modelRef !== 'object') return undefined;
    const providerID = typeof (modelRef as any).providerID === 'string'
      ? String((modelRef as any).providerID).trim()
      : '';
    const modelID = typeof (modelRef as any).modelID === 'string'
      ? String((modelRef as any).modelID).trim()
      : '';
    if (!providerID || !modelID) return undefined;
    return this._normalizeModelSelectionId(`${providerID}/${modelID}`);
  }

  private _getScopedConfigModel(cfg: unknown, scopeId: string): string | undefined {
    if (!cfg || typeof cfg !== 'object' || !scopeId) return undefined;

    const cfgAny = cfg as any;
    const fromAgent = cfgAny?.agent && typeof cfgAny.agent === 'object'
      ? cfgAny.agent[scopeId]?.model
      : undefined;
    const fromMode = cfgAny?.mode && typeof cfgAny.mode === 'object'
      ? cfgAny.mode[scopeId]?.model
      : undefined;

    return this._toModelSelectionId(fromAgent) || this._toModelSelectionId(fromMode);
  }

  private _resolveModelFromProviderDefaults(defaults: unknown): string | undefined {
    if (!defaults || typeof defaults !== 'object') return undefined;

    const entries = Object.entries(defaults as Record<string, unknown>)
      .filter(([providerID, modelID]) => {
        if (typeof providerID !== 'string' || providerID.trim().length === 0) return false;
        if (typeof modelID !== 'string' || modelID.trim().length === 0) return false;
        return true;
      })
      .map(([providerID, modelID]) => [providerID.trim(), String(modelID).trim()] as const);

    if (entries.length === 0) return undefined;

    // If a model is already selected, prefer the default for that provider.
    const current = this._toModelOverride(this._currentModel);
    if (current) {
      const match = entries.find(([providerID]) => providerID === current.providerID);
      if (match) {
        return this._normalizeModelSelectionId(`${match[0]}/${match[1]}`);
      }
    }

    // If there is only one configured provider default, this is unambiguous.
    if (entries.length === 1) {
      const [providerID, modelID] = entries[0];
      return this._normalizeModelSelectionId(`${providerID}/${modelID}`);
    }

    return undefined;
  }

  private async _getProviderDefaultModel(): Promise<string | undefined> {
    try {
      const payload = await this._client.getConfigProviders();
      return this._resolveModelFromProviderDefaults(payload?.default);
    } catch {
      return undefined;
    }
  }


  private async _loadModelContextLimits() {
    try {
      const payload = await this._client.getConfigProviders();
      const providers = payload?.providers;
      if (Array.isArray(providers)) {
        for (const provider of providers) {
          const providerID = typeof provider?.id === 'string' ? provider.id : undefined;
          const models = provider?.models;
          if (!providerID || !models || typeof models !== 'object') continue;
          for (const [modelKey, model] of Object.entries(models)) {
            const limit = (model as any)?.limit;
            const ctx = typeof limit?.context === 'number' ? limit.context : undefined;
            if (typeof ctx !== 'number' || !Number.isFinite(ctx) || ctx <= 0) continue;

            // Server returns a map keyed by modelID; AssistantMessage uses (providerID, modelID).
            // Some SDK shapes also include `model.id`; set both to be resilient.
            if (typeof modelKey === 'string' && modelKey.length > 0) {
              const idFromKey = this._normalizeModelSelectionId(`${providerID}/${modelKey}`);
              if (idFromKey) {
                this._modelContextLimitById.set(idFromKey, ctx);
              }
            }
            const modelID = typeof (model as any)?.id === 'string' ? (model as any).id : undefined;
            if (modelID && modelID.length > 0) {
              const idFromModel = this._normalizeModelSelectionId(`${providerID}/${modelID}`);
              if (idFromModel) {
                this._modelContextLimitById.set(idFromModel, ctx);
              }
            }
          }
        }
      }

      // Best-effort default (used when we can't identify model for a message).
      const defaults = payload?.default;
      if (defaults && typeof defaults === 'object') {
        const entries = Object.entries(defaults as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string' && (v as string).length > 0) as Array<[string, string]>;
        // If there is exactly one default provider->model mapping, use it.
        if (entries.length === 1) {
          const [providerID, modelID] = entries[0];
          const defaultModelKey = this._normalizeModelSelectionId(`${providerID}/${modelID}`);
          const lim = defaultModelKey ? this._modelContextLimitById.get(defaultModelKey) : undefined;
          if (typeof lim === 'number') {
            this._defaultModelContextLimit = lim;
          }
        }
      }
    } catch {
      // noop
    }
  }

  private _updateContextIndicatorFromMessage(info: any) {
    if (!this._view) return;
    if (!info || typeof info !== 'object') return;
    if (info.role !== 'assistant') return;

    // Token usage is per-message and provider-dependent.
    // Upstream OpenCode UI counts context usage as the sum of all reported token components
    // (input + output + reasoning + cache.read + cache.write) for the most recent assistant
    // message with token info.
    const tokens = (info as any).tokens ?? (info as any)?.metadata?.assistant?.tokens;
    if (!tokens || typeof tokens !== 'object') return;

    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const input = num((tokens as any).input);
    const output = num((tokens as any).output);
    const reasoning = num((tokens as any).reasoning);
    const cacheRead = num((tokens as any)?.cache?.read);
    const cacheWrite = num((tokens as any)?.cache?.write);

    const usedTokens = input + output + reasoning + cacheRead + cacheWrite;
    if (!Number.isFinite(usedTokens) || usedTokens <= 0) return;

    const providerID = typeof (info as any).providerID === 'string'
      ? (info as any).providerID
      : (typeof (info as any)?.metadata?.assistant?.providerID === 'string' ? (info as any).metadata.assistant.providerID : undefined);
    const modelID = typeof (info as any).modelID === 'string'
      ? (info as any).modelID
      : (typeof (info as any)?.metadata?.assistant?.modelID === 'string' ? (info as any).metadata.assistant.modelID : undefined);
    const lookupKey = (providerID && modelID)
      ? this._normalizeModelSelectionId(`${providerID}/${modelID}`)
      : undefined;
    const maxTokens = lookupKey
      ? this._modelContextLimitById.get(lookupKey)
      : this._defaultModelContextLimit;
    if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) return;

    // Avoid spamming UI with identical updates.
    if (this._lastContextUsedTokens === usedTokens && this._lastContextMaxTokens === maxTokens) return;
    this._lastContextUsedTokens = usedTokens;
    this._lastContextMaxTokens = maxTokens;

    this._view.webview.postMessage({
      type: 'contextUpdate',
      usedTokens,
      maxTokens,
    });
  }

  private async _handleStartServer() {
    if (this._serverHandle) {
      vscode.window.showInformationMessage(`OpenCode server already running at ${this._serverHandle.url}`);
      await this._handleConnectToUrl(this._serverHandle.url);
      return;
    }

    // Try to start using the official SDK (Pattern 1, optional path).
    // If opencode is not installed globally or not on PATH, this will fail.
    try {
      // Pass a binary hint for macOS when VS Code doesn't inherit the user's PATH.
      const binHint = process.platform === 'darwin'
        ? path.join(os.homedir(), '.opencode', 'bin', 'opencode')
        : undefined;
      const handle = await this._client.startServer({ hostname: '127.0.0.1', port: 4096, timeout: 10000, logLevel: 'info', binaryPath: binHint });
      this._serverHandle = handle;
      this._isServerStartedByExtension = true;
      await this._handleConnectToUrl(handle.url);
      vscode.window.showInformationMessage(`Started OpenCode server at ${handle.url}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Failed to start OpenCode server: ${msg}. Make sure the 'opencode' CLI is installed and on PATH.`,
        'Show Install Hint'
      ).then((sel) => {
        if (sel === 'Show Install Hint') {
          vscode.window.showInformationMessage(`Install: npm install -g opencode, then run: opencode serve --port 4096`);
        }
      });
    }
  }

  private async _handleStopServer() {
    if (!this._serverHandle) {
      vscode.window.showInformationMessage('No OpenCode server started by this extension.');
      return;
    }

    try {
      this._serverHandle.close();
    } catch {
      // noop
    }
    this._serverHandle = undefined;
    this._isServerStartedByExtension = false;
    this._stopEventStream();
    this._isConnected = false;
    this._view?.webview.postMessage({
      type: 'healthStatus',
      status: 'disconnected',
      url: this._currentUrl,
      isConnected: false
    });

    vscode.window.showInformationMessage('Stopped OpenCode server.');
  }

  private _stopEventStream() {
    try {
      this._eventAbortController?.abort();
    } catch {
      // noop
    }
    this._eventAbortController = undefined;
  }

  private _endStreamingUI(reason: string) {
    if (!this._isGenerating) return;
    this._isGenerating = false;
    this._activeAssistantMessageId = undefined;
    this._hasReceivedTextPartUpdate = false;
    this._suppressTextPartUpdates = false;
    this._generationHasSeenBusy = false;
    this._hasBoundStreamingMessageId = false;
    if (this._generationSafetyTimer) {
      clearTimeout(this._generationSafetyTimer);
      this._generationSafetyTimer = undefined;
    }
    this._view?.webview.postMessage({ type: 'endStreaming' });
    console.log('[OpenCode] Streaming ended', {
      reason,
      sessionID: this._currentSessionId,
    });
  }

  private _ensureEventStream() {
    if (!this._isConnected) return;
    if (this._eventAbortController) return;

    const controller = new AbortController();
    this._eventAbortController = controller;

    void this._client.subscribeEvents((evt) => {
      // Stream assistant deltas to the webview.
      // The server emits message.part.updated with a delta for incremental text.
      if (!this._view) return;
      if (!evt || typeof evt.type !== 'string') return;

      if (evt.type === 'session.status') {
        const sessionID = evt.properties?.sessionID;
        if (!sessionID || sessionID !== this._currentSessionId) return;
        const status = evt.properties?.status;
        if (typeof status === 'string') {
          if (status === 'busy' && this._isGenerating) {
            this._generationHasSeenBusy = true;
          }
          if (status === 'idle') {
            // Reliable completion signal once a generation actually started.
            if (!this._isGenerating) return;
            const elapsedMs = Date.now() - this._generationStartedAt;
            if (this._generationHasSeenBusy || elapsedMs > 1200) {
              this._endStreamingUI('session.status idle');
            }
          }
          // Note: we intentionally do not flip UI to streaming on `busy` here,
          // because the webview needs a `startStreaming` event to create a bubble.
        }
      }

      if (evt.type === 'session.updated' || evt.type === 'session.created' || evt.type === 'session.deleted') {
        // Session titles are updated by the server in the background (uses `small_model`).
        // Refresh the session list so the webview session picker stays current.
        this._scheduleSessionsReload(evt.type);
      }

      if (evt.type === 'message.updated') {
        const info = evt.properties?.info;
        const sessionID = info?.sessionID;
        if (!sessionID || sessionID !== this._currentSessionId) return;

        const role = info?.role;
        const messageID = info?.id;
        if (role === 'assistant' && typeof messageID === 'string' && messageID.length > 0) {
          if (!this._activeAssistantMessageId) {
            // Set as early as possible so part streaming filters correctly.
            this._activeAssistantMessageId = messageID;
          }

          if (this._isGenerating && this._activeAssistantMessageId && !this._hasBoundStreamingMessageId) {
            this._hasBoundStreamingMessageId = true;
            this._view.webview.postMessage({
              type: 'bindStreaming',
              messageID: this._activeAssistantMessageId,
            });
          }

          const isActive = this._activeAssistantMessageId === messageID;
          const completed = info?.time?.completed;
          if (isActive && completed) {
            this._endStreamingUI('message.updated time.completed');
          }
        }

        // Update context indicator when token usage becomes available.
        this._updateContextIndicatorFromMessage(info);

        // If history is already rendered, refresh it when messages change outside of our
        // current streaming bubble (e.g., CLI/web client). Keep it best-effort and
        // avoid spamming during active generation.
        if (!this._isGenerating && this._hasRenderedInitialHistory && this._currentSessionId) {
          if (!this._historyReloadTimer) {
            this._historyReloadTimer = setTimeout(() => {
              this._historyReloadTimer = undefined;
              if (!this._currentSessionId || !this._isConnected) return;
              void this._loadSessionHistory(this._currentSessionId);
            }, 300);
          }
        }
      }

      // Surface tool activity and other non-text parts in the UI
      if (evt.type === 'message.part.updated') {
        const part = evt.properties?.part;
        const delta = evt.properties?.delta;
        if (!part || part.sessionID !== this._currentSessionId) return;

        // Route updates either to the streaming bubble (active generation) or to history bubbles.
        if (this._isGenerating && this._activeAssistantMessageId && part.messageID !== this._activeAssistantMessageId) {
          return;
        }

        if (!this._isGenerating) {
          // Update the correct message bubble by messageID.
          this._view.webview.postMessage({
            type: 'partUpdate',
            messageID: part.messageID,
            part,
            delta,
          });
          return;
        }

        const pType = part.type;
        if (pType === 'text') {
          if (this._isGenerating && this._suppressTextPartUpdates) {
            return;
          }
          if (typeof delta === 'string' && delta.length > 0) {
            if (this._isGenerating) {
              this._hasReceivedTextPartUpdate = true;
              this._view.webview.postMessage({ type: 'streamChunk', content: delta });
            }
          } else if (typeof part.text === 'string' && part.text.length > 0) {
            // Fallback: some servers may send full part text.
            if (this._isGenerating) {
              this._hasReceivedTextPartUpdate = true;
              this._view.webview.postMessage({ type: 'replaceStreaming', content: part.text });
            }
          }
        }

        if (pType === 'reasoning') {
          if (this._isGenerating) {
            if (typeof delta === 'string' && delta.length > 0) {
              this._view.webview.postMessage({ type: 'thinkingDelta', text: delta });
            } else {
              this._view.webview.postMessage({ type: 'thinkingUpdate', text: part.text || '' });
            }
          }
        }

        if (pType === 'tool') {
          if (this._isGenerating) {
            this._view.webview.postMessage({
              type: 'toolUpdate',
              tool: part.tool,
              callID: part.callID,
              state: part.state,
            });
          }
        }

        if (pType === 'patch') {
          if (this._isGenerating) {
            this._view.webview.postMessage({
              type: 'patchUpdate',
              hash: part.hash,
              files: part.files,
            });
          }
        }

        if (pType === 'step-start') {
          if (this._isGenerating) {
            this._view.webview.postMessage({
              type: 'stepUpdate',
              phase: 'start',
              snapshot: part.snapshot,
            });
          }
        }

        if (pType === 'step-finish') {
          if (this._isGenerating) {
            this._view.webview.postMessage({
              type: 'stepUpdate',
              phase: 'finish',
              reason: part.reason,
              cost: part.cost,
              tokens: part.tokens,
            });
          }
        }
      }

      if (evt.type === 'session.idle') {
        const sessionID = evt.properties?.sessionID;
        if (sessionID && sessionID === this._currentSessionId) {
          // Deprecated completion signal (fallback only).
          if (!this._isGenerating) return;
          const elapsedMs = Date.now() - this._generationStartedAt;
          if (this._generationHasSeenBusy || elapsedMs > 1200) {
            this._endStreamingUI('session.idle (fallback)');
          }
        }
      }

      if (evt.type === 'session.error') {
        const sessionID = evt.properties?.sessionID;
        if (sessionID && sessionID !== this._currentSessionId) return;
        const err = evt.properties?.error;
        const msg = err?.message || err?.error || (typeof err === 'string' ? err : 'Unknown session error');
        this._view.webview.postMessage({ type: 'error', message: msg });
        this._endStreamingUI('session.error');
      }
    }, { signal: controller.signal }).catch((err) => {
      // If connection drops, allow re-creation on next health check.
      console.warn('[OpenCode] Event stream stopped:', err);
      if (this._eventAbortController === controller) {
        this._eventAbortController = undefined;
      }
    });
  }

  private async _handleOpenConnectionDialog() {
    const items = this._connectionHistory.map(h => ({
      label: h.url,
      description: h.url === this._currentUrl ? 'Current Server' : undefined,
      url: h.url
    }));
    
    const selected = await vscode.window.showQuickPick(
      [
        { label: '$(server) Start local server (127.0.0.1:4096)', description: 'Start opencode serve and connect', url: 'start-local' },
        ...items,
        { label: '$(add) Add new server...', url: 'new' }
      ],
      {
        placeHolder: 'Select OpenCode server or add new',
        title: 'OpenCode Server Connection'
      }
    );
    
    if (selected) {
      if (selected.url === 'start-local') {
        await this.startLocalServer();
        return;
      }
      if (selected.url === 'new') {
        const input = await vscode.window.showInputBox({
          prompt: 'Enter OpenCode server URL or port (e.g., http://localhost:4096 or just 4096)',
          placeHolder: 'http://127.0.0.1:4096',
          value: this._currentUrl,
          validateInput: (value) => {
            if (!value) {
              return 'Please enter a valid URL or port number';
            }
            // Allow port numbers (just digits)
            if (/^\d+$/.test(value)) {
              const port = parseInt(value);
              if (port < 1 || port > 65535) {
                return 'Port must be between 1 and 65535';
              }
              return null;
            }
            // Allow URLs starting with http
            if (!value.startsWith('http')) {
              return 'Please enter a valid URL starting with http:// or https://, or just a port number';
            }
            return null;
          }
        });
        
        if (input) {
          // Convert port number to full URL
          let url = input;
          if (/^\d+$/.test(input)) {
            url = `http://127.0.0.1:${input}`;
          }
          await this._handleConnectToUrl(url);
        }
      } else {
        await this._handleConnectToUrl(selected.url);
      }
    }
  }

  private async _handleSendMessage(text: string, agent?: string) {
    const sessionId = await this._ensureActiveSession();
    this._currentSessionId = sessionId;
    void this._maybeRenameSessionFromFirstInput(sessionId, text);

    try {
      this._view?.webview.postMessage({
        type: 'addMessage',
        role: 'user',
        content: text,
        agent
      });

      this._view?.webview.postMessage({
        type: 'startStreaming',
        agent
      });

      // Ensure we have a live event stream for incremental output.
      this._ensureEventStream();

      // Kick off the prompt. Keep a non-stream fallback by reading returned text.
      // If SSE already streamed deltas, replace content to avoid duplicates.
      this._isGenerating = true;
      this._activeAssistantMessageId = undefined;
      this._hasReceivedTextPartUpdate = false;
      this._suppressTextPartUpdates = false;
      this._hasBoundStreamingMessageId = false;
      this._generationSeq += 1;
      const generationSeq = this._generationSeq;
      this._generationStartedAt = Date.now();
      this._generationHasSeenBusy = false;
      if (this._generationSafetyTimer) {
        clearTimeout(this._generationSafetyTimer);
        this._generationSafetyTimer = undefined;
      }
      console.log('[OpenCode] Sending prompt', {
        sessionID: this._currentSessionId,
        agent,
      });

      const request: PromptRequest = {
        parts: [{ type: 'text', text }],
        agent,
      };

      // Pass model override when available. Server expects (providerID, modelID).
      const model = this._toModelOverride(this._currentModel);
      if (model) {
        request.model = model;
      }

      if (typeof this._currentVariant === 'string' && this._currentVariant.trim().length > 0) {
        request.variant = this._currentVariant;
      }

      const result = await this._client.prompt(this._currentSessionId!, request);

      // Bind event filtering to the actual assistant message id.
      if (result.assistantMessageId) {
        this._activeAssistantMessageId = result.assistantMessageId;
        if (!this._hasBoundStreamingMessageId) {
          this._hasBoundStreamingMessageId = true;
          this._view?.webview.postMessage({
            type: 'bindStreaming',
            messageID: result.assistantMessageId,
          });
        }
      }

      // HTTP response is fallback only: if we haven't seen any text part updates
      // within N ms, use the returned text to avoid an empty UI.
      const fallbackAfterMs = 1200;
      const elapsed = Date.now() - this._generationStartedAt;
      const delay = Math.max(fallbackAfterMs - elapsed, 0);
      if (result.text) {
        setTimeout(() => {
          if (this._generationSeq !== generationSeq) return;
          if (!this._isGenerating) return;
          if (this._hasReceivedTextPartUpdate) return;
          this._suppressTextPartUpdates = true;
          this._hasReceivedTextPartUpdate = true;
          this._view?.webview.postMessage({ type: 'replaceStreaming', content: result.text });
        }, delay);
      }

      // Safety timeout: avoid permanently stuck streaming if no completion events arrive.
      this._generationSafetyTimer = setTimeout(() => {
        this._endStreamingUI('safety-timeout');
      }, 300000);

    } catch (error) {
      this._view?.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
      this._endStreamingUI('prompt error');
    }
  }

  private async _handleGetAgents() {
    try {
      const agentsRaw = await this._client.listAgents();

      // Only expose primary agents as selectable "modes" in the UI.
      // The server also returns internal/subagents (title, summary, compaction, etc.).
      let agents = agentsRaw;
      try {
        const cfg = await this._client.getConfig();
        agents = (agentsRaw || [])
          .filter((a) => {
            if (!a || !a.id) return false;
            if (a.mode && a.mode !== 'primary') return false;
            if (a.hidden === true) return false;

            const agentCfg = (cfg as any)?.agent && typeof (cfg as any).agent === 'object'
              ? (cfg as any).agent[a.id]
              : undefined;
            if (agentCfg && agentCfg.disable === true) return false;
            if (agentCfg && agentCfg.hidden === true) return false;
            if (agentCfg && typeof agentCfg.mode === 'string' && agentCfg.mode.length > 0 && agentCfg.mode !== 'primary') {
              return false;
            }
            return true;
          })
          .map((a) => ({
            ...a,
            // Ensure mode is stable for the webview.
            mode: 'primary' as const,
          }));
      } catch {
        // If config isn't available, still hide non-primary agents.
        agents = (agentsRaw || []).filter((a) => {
          if (!a || !a.id) return false;
          if (a.mode && a.mode !== 'primary') return false;
          if (a.hidden === true) return false;
          return true;
        });
      }

      let defaultAgentId: string | undefined;
      let defaultAgentModel: string | undefined;
      let defaultAgentVariant: string | undefined;

      // Sync default agent + its model/variant from server config.
      try {
        let cfg: any;
        try {
          cfg = await this._client.getConfig();
        } catch {
          cfg = undefined;
        }

        // Merge global config as a fallback (in some setups, defaults live there).
        if (!cfg || typeof cfg !== 'object') {
          try {
            cfg = await this._client.getGlobalConfig();
          } catch {
            cfg = undefined;
          }
        }

        const cfgDefaultAgent = (cfg && typeof (cfg as any).default_agent === 'string')
          ? String((cfg as any).default_agent).trim()
          : '';
        const candidateAgent = cfgDefaultAgent
          || (typeof this._currentAgent === 'string' && this._currentAgent.trim().length > 0 ? this._currentAgent.trim() : 'build');
        const found = agents.find((a) => a && a.id === candidateAgent) || agents.find((a) => a && a.id) || undefined;
        if (found && found.id) {
          defaultAgentId = found.id;

          const agentCfg = (cfg as any)?.agent && typeof (cfg as any).agent === 'object'
            ? (cfg as any).agent[defaultAgentId]
            : undefined;
          const modeCfg = (cfg as any)?.mode && typeof (cfg as any).mode === 'object'
            ? (cfg as any).mode[defaultAgentId]
            : undefined;
          const cfgModel = this._toModelSelectionId((cfg as any)?.model);
          const cfgAgentModel = this._getScopedConfigModel(cfg, defaultAgentId);
          const cfgAgentVariant = agentCfg && typeof agentCfg.variant === 'string'
            ? agentCfg.variant.trim()
            : (modeCfg && typeof modeCfg.variant === 'string' ? modeCfg.variant.trim() : '');

          // Keep model/variant resolution in sync with OpenCode config precedence.
          // model: config.model -> config.agent[default].model -> agent.model -> provider default
          // variant: config.agent[default].variant -> agent.variant
          defaultAgentModel = cfgModel;
          if (!defaultAgentModel && cfgAgentModel) {
            defaultAgentModel = cfgAgentModel;
          }
          if (!defaultAgentModel) {
            defaultAgentModel = this._toModelSelectionId(found.model);
          }
          if (!defaultAgentModel) {
            defaultAgentModel = await this._getProviderDefaultModel();
          }

          defaultAgentVariant = cfgAgentVariant.length > 0
            ? cfgAgentVariant
            : (typeof (found as any).variant === 'string' && String((found as any).variant).trim().length > 0
              ? String((found as any).variant).trim()
              : undefined);
        }
      } catch {
        // noop
      }

      // Update our internal defaults for outgoing messages.
      if (defaultAgentId) {
        this._currentAgent = defaultAgentId;
      }
      if (defaultAgentModel) {
        this._setCurrentModel(defaultAgentModel);
      }
      if (defaultAgentVariant) {
        this._currentVariant = defaultAgentVariant;
      }

      this._view?.webview.postMessage({
        type: 'agentsList',
        agents,
        defaultAgentId,
      });

      // Send a separate defaults message so the webview can set all three fields at once.
      if (defaultAgentId || defaultAgentModel || defaultAgentVariant) {
        this._view?.webview.postMessage({
          type: 'defaults',
          agent: defaultAgentId,
          model: defaultAgentModel,
          variant: defaultAgentVariant,
        });
      }
    } catch (error) {
      const agents = [
        { id: 'build', name: 'Build', description: 'Code implementation and edits' },
        { id: 'plan', name: 'Plan', description: 'Architecture and planning' },
        { id: 'explore', name: 'Explore', description: 'Research and exploration' }
      ];
      this._view?.webview.postMessage({
        type: 'agentsList',
        agents
      });
    }
  }

  private async _handleCreateSession() {
    try {
      const session = await this._client.createSession({});
      // Server enforces session IDs starting with "ses".
      this._currentSessionId = session.id;
      this._titleRenamePendingSessions.add(session.id);
      console.log('[OpenCode] Created session:', session.id);
      await this._persistSessionState();
      this._view?.webview.postMessage({
        type: 'sessionCreated',
        sessionId: session.id
      });
    } catch (error) {
      console.error('Failed to create session:', error);
      throw error;
    }
  }

  private async _handleHealthCheck(showError: boolean = false) {
    try {
      console.log(`[OpenCode] Checking health at ${this._currentUrl}`);
      const health = await this._client.health();
      console.log(`[OpenCode] Health check result:`, health);
      this._isConnected = health.healthy === true;
      this._view?.webview.postMessage({
        type: 'healthStatus',
        status: health.healthy ? 'ok' : 'error',
        url: this._currentUrl,
        isConnected: this._isConnected
      });
      
      if (this._isConnected) {
        this._ensureEventStream();

        // Load provider/model limits early so history/context rendering can use it.
        await this._loadModelContextLimits();

        // Restore or create a session, then load its history.
        const sessionId = await this._ensureActiveSession();
        if (!this._hasRenderedInitialHistory || this._lastHistorySessionId !== sessionId) {
          await this._loadSessionHistory(sessionId);
        }
        await this._handleGetAgents();
        await this._handleGetModels();
        await this._handleGetSessions();
        await this._handleGetCommands();
        if (showError) {
          vscode.window.showInformationMessage(`Connected to OpenCode server at ${this._currentUrl}`);
        }
      } else {
        this._stopEventStream();
        this._lastContextUsedTokens = undefined;
        this._lastContextMaxTokens = undefined;
        this._view?.webview.postMessage({ type: 'contextUpdate', usedTokens: 0, maxTokens: 1 });
      }
    } catch (error) {
      console.error(`[OpenCode] Health check failed:`, error);
      this._isConnected = false;
      this._stopEventStream();
      this._lastContextUsedTokens = undefined;
      this._lastContextMaxTokens = undefined;
      this._view?.webview.postMessage({
        type: 'healthStatus',
        status: 'disconnected',
        url: this._currentUrl,
        isConnected: false
      });

      this._view?.webview.postMessage({ type: 'contextUpdate', usedTokens: 0, maxTokens: 1 });
      
      // Show error notification if this was a manual connection attempt
      if (showError) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(
          `Failed to connect to ${this._currentUrl}: ${errorMessage}`,
          'Retry',
          'Open DevTools'
        ).then(selection => {
          if (selection === 'Retry') {
            this._handleHealthCheck(true);
          } else if (selection === 'Open DevTools') {
            vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
          }
        });
      }
    }
  }

  private async _handleGetModels() {
    try {
      const payload = await this._getModelsPayload();
      this._view?.webview.postMessage({
        type: 'modelsList',
        models: payload.models,
        defaultModelId: payload.defaultModelId,
      });
    } catch {
      this._view?.webview.postMessage({ type: 'modelsList', models: [] });
    }
  }

  private async _getModelsPayload(): Promise<{ models: Array<{ id: string; name: string; description?: string; variants?: Record<string, any> }>; defaultModelId?: string }> {
    let configModel: string | undefined;
    let agentModel: string | undefined;
    let resolvedAgentModel: string | undefined;
    let providerDefaultModel: string | undefined;
    try {
      let cfg: any;
      try {
        cfg = await this._client.getConfig();
      } catch {
        cfg = undefined;
      }

      if (!cfg || typeof cfg !== 'object') {
        try {
          cfg = await this._client.getGlobalConfig();
        } catch {
          cfg = undefined;
        }
      }

      configModel = this._toModelSelectionId((cfg as any)?.model);

      // If global model is not set, fall back to default agent's configured model.
      const defaultAgent = (cfg && typeof (cfg as any).default_agent === 'string')
        ? String((cfg as any).default_agent).trim()
        : ((cfg && typeof (cfg as any).default_mode === 'string') ? String((cfg as any).default_mode).trim() : '');

      const candidateAgentIds = [
        defaultAgent,
        typeof this._currentAgent === 'string' ? this._currentAgent.trim() : '',
        'build',
      ].filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);

      for (const agentId of candidateAgentIds) {
        const scopedModel = this._getScopedConfigModel(cfg, agentId);
        if (scopedModel) {
          agentModel = scopedModel;
          break;
        }
      }

      // Fallback to the resolved model emitted by /agent when config doesn't pin one.
      if (!agentModel && candidateAgentIds.length > 0) {
        try {
          const agents = await this._client.listAgents();
          for (const agentId of candidateAgentIds) {
            const found = (agents || []).find((a) => a && a.id === agentId);
            if (found && typeof found.model === 'string' && found.model.trim().length > 0) {
              resolvedAgentModel = this._normalizeModelSelectionId(found.model);
              break;
            }
          }
        } catch {
          // noop
        }
      }

      providerDefaultModel = await this._getProviderDefaultModel();
    } catch {
      // noop
    }

    let models = await this._getAllModels();

    const candidates = [
      configModel,
      agentModel,
      resolvedAgentModel,
      providerDefaultModel,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    let defaultModelId = candidates.find((candidate) => models.some((m) => m.id === candidate));

    // If OpenCode resolved a default model that's absent from provider inventory,
    // include it so the picker doesn't fall back to an unrelated first item.
    if (!defaultModelId && candidates.length > 0) {
      const fallback = candidates[0];
      const modelName = fallback.split('/').pop() || fallback;
      models = [...models, { id: fallback, name: modelName, description: 'Configured model' }];
      defaultModelId = fallback;
    }

    return { models, defaultModelId };
  }

  private async _getAllModels(): Promise<Array<{ id: string; name: string; description?: string; variants?: Record<string, any> }>> {
    const byId = new Map<string, { id: string; name: string; description?: string; variants?: Record<string, any> }>();

    // Source A: /config/providers (configured providers + their model inventories)
    try {
      const payload = await this._client.getConfigProviders();
      const providers = payload?.providers;
      if (Array.isArray(providers)) {
        for (const provider of providers) {
          const providerID = typeof provider?.id === 'string' ? provider.id : undefined;
          const models = provider?.models;
          if (!providerID || !models || typeof models !== 'object') continue;

          for (const [modelKey, model] of Object.entries(models)) {
            const modelID = typeof (model as any)?.id === 'string'
              ? (model as any).id
              : (typeof modelKey === 'string' ? modelKey : undefined);
            if (!modelID) continue;

            const id = this._normalizeModelSelectionId(`${providerID}/${modelID}`);
            if (!id) continue;
            const nameRaw = (model as any)?.name;
            const name = typeof nameRaw === 'string' && nameRaw.trim().length > 0
              ? nameRaw
              : (modelID.split('/').pop() || modelID);
            const descriptionRaw = (model as any)?.description;
            const description = typeof descriptionRaw === 'string' && descriptionRaw.trim().length > 0
              ? descriptionRaw
              : undefined;

            const variantsRaw = (model as any)?.variants;
            const variants = variantsRaw && typeof variantsRaw === 'object' ? (variantsRaw as Record<string, any>) : undefined;

            byId.set(id, { id, name, description, variants });
          }
        }
      }
    } catch {
      // Ignore; we can still try other endpoints.
    }

    // Source B intentionally omitted: /provider often returns the entire model registry
    // (potentially thousands of models). For UI pickers, we only want models that
    // are configured/enabled for the user's project, which /config/providers provides.

    // Source C: config-derived model references as a fallback.
    try {
      const config = await this._client.getConfig();
      const agentScopes = config.agent && typeof config.agent === 'object' ? config.agent : {};
      const modeScopes = (config as any)?.mode && typeof (config as any).mode === 'object' ? (config as any).mode : {};

      const cfgModelId = this._toModelSelectionId((config as any)?.model);
      if (cfgModelId) {
        const id = cfgModelId;
        if (id && !byId.has(id)) {
          const modelName = id.split('/').pop() || id;
          byId.set(id, { id, name: modelName, description: 'Default model' });
        }
      }

      const scopedEntries = [...Object.entries(agentScopes), ...Object.entries(modeScopes)];
      Object.entries(Object.fromEntries(scopedEntries)).forEach(([scopeId, scopeConfig]) => {
        const id = this._toModelSelectionId((scopeConfig as any)?.model);
        if (!id) return;
        if (byId.has(id)) return;
        const modelName = id.split('/').pop() || id;
        byId.set(id, { id, name: modelName, description: `Used by ${scopeId} mode` });
      });
    } catch {
      // noop
    }

    let models = Array.from(byId.values());
    // No hardcoded fallback model here; if server exposes no models, return empty.

    models.sort((a, b) => {
      const ap = a.id.includes('/') ? a.id.split('/')[0] : '';
      const bp = b.id.includes('/') ? b.id.split('/')[0] : '';
      if (ap !== bp) return ap.localeCompare(bp);
      return a.name.localeCompare(b.name);
    });

    return models;
  }

  private async _handleGetCommands() {
    try {
      const commands = await this._client.listCommands();
      this._view?.webview.postMessage({
        type: 'commandsList',
        commands,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[OpenCode] Failed to list commands:', msg);
      this._view?.webview.postMessage({
        type: 'commandsList',
        commands: [],
      });
    }
  }

  private async _handleSendCommand(command: string, args?: string, agent?: string) {
    const sessionId = await this._ensureActiveSession();
    this._currentSessionId = sessionId;

    const cmdName = typeof command === 'string' ? command.trim().replace(/^\//, '') : '';
    const cmdArgs = typeof args === 'string' ? args : '';
    if (!cmdName) {
      this._view?.webview.postMessage({ type: 'error', message: 'Missing command name.' });
      return;
    }

    const userText = `/${cmdName}${cmdArgs ? ` ${cmdArgs}` : ''}`;
    void this._maybeRenameSessionFromFirstInput(sessionId, userText);

    try {
      this._view?.webview.postMessage({
        type: 'addMessage',
        role: 'user',
        content: userText,
        agent,
      });

      this._view?.webview.postMessage({
        type: 'startStreaming',
        agent,
      });

      this._ensureEventStream();

      this._isGenerating = true;
      this._activeAssistantMessageId = undefined;
      this._hasReceivedTextPartUpdate = false;
      this._suppressTextPartUpdates = false;
      this._hasBoundStreamingMessageId = false;
      this._generationSeq += 1;
      const generationSeq = this._generationSeq;
      this._generationStartedAt = Date.now();
      this._generationHasSeenBusy = false;
      if (this._generationSafetyTimer) {
        clearTimeout(this._generationSafetyTimer);
        this._generationSafetyTimer = undefined;
      }

      console.log('[OpenCode] Sending command', {
        sessionID: this._currentSessionId,
        command: cmdName,
        agent,
      });

      const result = await this._client.sendCommand(this._currentSessionId!, {
        command: cmdName,
        arguments: cmdArgs,
        agent,
        model: this._normalizeModelSelectionId(this._currentModel),
        variant: this._currentVariant,
      });

      if (result.assistantMessageId) {
        this._activeAssistantMessageId = result.assistantMessageId;
        if (!this._hasBoundStreamingMessageId) {
          this._hasBoundStreamingMessageId = true;
          this._view?.webview.postMessage({
            type: 'bindStreaming',
            messageID: result.assistantMessageId,
          });
        }
      }

      const fallbackAfterMs = 1200;
      const elapsed = Date.now() - this._generationStartedAt;
      const delay = Math.max(fallbackAfterMs - elapsed, 0);
      if (result.text) {
        setTimeout(() => {
          if (this._generationSeq !== generationSeq) return;
          if (!this._isGenerating) return;
          if (this._hasReceivedTextPartUpdate) return;
          this._suppressTextPartUpdates = true;
          this._hasReceivedTextPartUpdate = true;
          this._view?.webview.postMessage({ type: 'replaceStreaming', content: result.text });
        }, delay);
      }

      this._generationSafetyTimer = setTimeout(() => {
        this._endStreamingUI('safety-timeout');
      }, 300000);
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      this._endStreamingUI('command error');
    }
  }

  private async _handleStopGeneration() {
    if (this._currentSessionId) {
      // End UI streaming immediately; abort is best-effort.
      this._endStreamingUI('user stop');
      try {
        await this._client.abortSession(this._currentSessionId);
      } catch (error) {
        console.error('Failed to abort session:', error);
      }
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'chat.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'chat.css')
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleUri}" rel="stylesheet">
        <link href="${codiconsUri}" rel="stylesheet">
        <title>OpenCodeSpec Chat</title>
        <style>
          .icon-svg {
            width: 16px;
            height: 16px;
            display: inline-block;
            vertical-align: middle;
          }
          .icon-svg svg {
            width: 100%;
            height: 100%;
            fill: currentColor;
          }
        </style>
      </head>
      <body>
        <div id="chat-container">

          <div id="messages-container">
            <div id="welcome-message" style="display: none;">
              <h2>Welcome to OpenCodeSpec Chat</h2>
              <p>Your AI assistant powered by OpenCode</p>
            </div>
            <div id="messages"></div>
          </div>
          
          <div id="input-container">
            <div class="input-wrapper" id="input-wrapper">
              <textarea 
                id="message-input" 
                placeholder='Ask anything... "What is the tech stack of this project?"'
                rows="1"
                disabled
              ></textarea>
              <div class="input-footer">
                <div class="selectors-row">
                  <div class="mode-selector">
                    <button id="mode-picker" class="selector-btn" type="button" disabled aria-label="Select agent" title="Agent (Ctrl+. to cycle)">
                      <span class="selector-label" id="mode-label">Build</span>
                      <span class="icon-svg"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M3.146 5.646a.5.5 0 0 1 .708 0L8 9.793l4.146-4.147a.5.5 0 0 1 .708.708l-4.5 4.5a.5.5 0 0 1-.708 0l-4.5-4.5a.5.5 0 0 1 0-.708z"/></svg></span>
                    </button>
                  </div>
                   <span class="separator">|</span>
                   <div class="model-selector">
                      <button id="model-picker" class="selector-btn" type="button" disabled aria-label="Select model" title="Model (Ctrl+' to search)">
                        <span class="selector-label" id="model-label">Model</span>
                        <span class="icon-svg"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M3.146 5.646a.5.5 0 0 1 .708 0L8 9.793l4.146-4.147a.5.5 0 0 1 .708.708l-4.5 4.5a.5.5 0 0 1-.708 0l-4.5-4.5a.5.5 0 0 1 0-.708z"/></svg></span>
                      </button>
                   </div>

                   <div class="variant-selector">
                      <button id="variant-picker" class="selector-btn" type="button" disabled aria-label="Select variant" title="Model variant (Ctrl+Shift+D to cycle)">
                        <span class="selector-label" id="variant-label">Variant</span>
                        <span class="icon-svg"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M3.146 5.646a.5.5 0 0 1 .708 0L8 9.793l4.146-4.147a.5.5 0 0 1 .708.708l-4.5 4.5a.5.5 0 0 1-.708 0l-4.5-4.5a.5.5 0 0 1 0-.708z"/></svg></span>
                      </button>
                   </div>
                  </div>
                <div class="input-actions">
                  <div class="context-indicator" id="context-indicator" title="Context window usage">
                    <svg viewBox="0 0 24 24" class="context-ring">
                      <circle class="context-ring-bg" cx="12" cy="12" r="10"/>
                      <circle class="context-ring-fill" cx="12" cy="12" r="10" stroke-dasharray="62.8" stroke-dashoffset="62.8"/>
                    </svg>
                  </div>
                  <button id="session-picker" class="icon-btn" title="Switch session" aria-label="Switch session">
                    <span class="icon-svg"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 2.75A.75.75 0 0 1 2.75 2h10.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V3.5h-9v9h1.75a.75.75 0 0 1 0 1.5h-2.5A.75.75 0 0 1 2 13.25V2.75z"/><path fill="currentColor" d="M6.5 6.75A.75.75 0 0 1 7.25 6h6.0a.75.75 0 0 1 .75.75v6.5a.75.75 0 0 1-.75.75h-6.0a.75.75 0 0 1-.75-.75v-6.5zm1.5.75v5h4.5v-5H8z"/></svg></span>
                  </button>
                  <button id="new-chat-btn" class="icon-btn" title="New chat">
                    <span class="icon-svg"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 1.5a.5.5 0 0 1 .5.5v5.5H14a.5.5 0 0 1 0 1H8.5V14a.5.5 0 0 1-1 0V8.5H2a.5.5 0 0 1 0-1h5.5V2a.5.5 0 0 1 .5-.5z"/></svg></span>
                  </button>
                  <button id="send-btn" class="send-btn" title="Send (Cmd+Enter)" disabled>
                    <span class="icon-svg"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M6 3.5a.5.5 0 0 1 .5-.5h8a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 0-1 0v2A1.5 1.5 0 0 0 6.5 14h8a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 2h-8A1.5 1.5 0 0 0 5 3.5v2a.5.5 0 0 0 1 0v-2z"/><path fill="currentColor" d="M11.854 8.354a.5.5 0 0 0 0-.708l-3-3a.5.5 0 1 0-.708.708L10.293 7.5H1.5a.5.5 0 0 0 0 1h8.793l-2.147 2.146a.5.5 0 0 0 .708.708l3-3z"/></svg></span>
                  </button>
                  <button id="stop-btn" class="stop-btn hidden" title="Stop generation">
                    <span class="icon-svg"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M5 3.5h6A1.5 1.5 0 0 1 12.5 5v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 11V5A1.5 1.5 0 0 1 5 3.5z"/></svg></span>
                  </button>
                </div>
              </div>
            </div>
          </div>
          
          <div id="connection-bar" class="disconnected">
            <div class="connection-status" id="connection-status">
              <span class="status-dot"></span>
              <span class="status-text">disconnected</span>
            </div>
          </div>

          <div id="slash-palette" class="slash-palette hidden" aria-hidden="true">
            <div class="slash-panel" role="listbox" aria-label="OpenCode commands">
              <div class="slash-head">
                <span class="slash-title">Commands</span>
                <span class="slash-meta" id="slash-meta"></span>
                <span class="slash-tip">Esc to close</span>
              </div>
              <div id="slash-list" class="slash-list"></div>
            </div>
          </div>

          <div id="picker-palette" class="picker-palette hidden" aria-hidden="true">
            <div class="picker-panel" role="dialog" aria-label="Select" aria-modal="true">
              <div class="picker-head">
                <div class="picker-head-row">
                  <span class="picker-title" id="picker-title">Select</span>
                  <span class="picker-meta" id="picker-meta"></span>
                  <span class="picker-tip">Esc to close</span>
                </div>
                <input id="picker-input" class="picker-input" type="text" spellcheck="false" placeholder="Type to search" />
              </div>
              <div id="picker-list" class="picker-list" role="listbox" aria-label="Results"></div>
            </div>
          </div>
        </div>
        
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }
}
