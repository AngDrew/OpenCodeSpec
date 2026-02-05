import * as vscode from 'vscode';
import { getNonce } from './utils';
import { OpenCodeClient } from '../api/opencodeClient';

interface ConnectionHistory {
  url: string;
  lastConnected: number;
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
      if (typeof stored.sessionId === 'string' && stored.sessionId.length > 0) {
        this._currentSessionId = stored.sessionId;
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
      });
    } catch {
      // noop
    }
  }

  private async _ensureActiveSession(): Promise<string> {
    if (this._isRestoringSession) {
      // Avoid re-entrancy; return best effort.
      if (this._currentSessionId) return this._currentSessionId;
    }

    this._isRestoringSession = true;
    try {
      const candidate = this._currentSessionId;
      if (candidate && String(candidate).startsWith('ses')) {
        try {
          await this._client.getSession(candidate);
          await this._persistSessionState();
          return candidate;
        } catch {
          // Invalid or missing on server; fall through to create.
        }
      }

      const created = await this._client.createSession({ title: 'Chat Session' });
      this._currentSessionId = created.id;
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

    const session = await this._client.createSession({ title: 'Chat Session' });
    this._currentSessionId = session.id;
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
        case 'createSession':
          if (this._isConnected) {
            await this._handleCreateSession();
          }
          break;
        case 'healthCheck':
          await this._handleHealthCheck();
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
          break;
        case 'modelChanged':
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
              this._modelContextLimitById.set(`${providerID}/${modelKey}`, ctx);
            }
            const modelID = typeof (model as any)?.id === 'string' ? (model as any).id : undefined;
            if (modelID && modelID.length > 0) {
              this._modelContextLimitById.set(`${providerID}/${modelID}`, ctx);
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
          const lim = this._modelContextLimitById.get(`${providerID}/${modelID}`);
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

    const tokens = info.tokens;
    const input = typeof tokens?.input === 'number' ? tokens.input : undefined;
    if (typeof input !== 'number') return;

    // Best proxy for current context usage: the prompt size for the last assistant generation.
    // OpenCode reports per-message token usage where `input` reflects the full context window
    // consumed to generate this assistant message.
    const usedTokens = input;
    if (!Number.isFinite(usedTokens) || usedTokens < 0) return;

    const providerID = typeof info.providerID === 'string' ? info.providerID : undefined;
    const modelID = typeof info.modelID === 'string' ? info.modelID : undefined;
    const maxTokens = (providerID && modelID)
      ? this._modelContextLimitById.get(`${providerID}/${modelID}`)
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
      const handle = await this._client.startServer({ hostname: '127.0.0.1', port: 4096, timeout: 10000, logLevel: 'info' });
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
        ...items,
        { label: '$(add) Add new server...', url: 'new' }
      ],
      {
        placeHolder: 'Select OpenCode server or add new',
        title: 'OpenCode Server Connection'
      }
    );
    
    if (selected) {
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

      const result = await this._client.prompt(this._currentSessionId!, {
        parts: [{ type: 'text', text }],
        agent,
      });

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
      const agents = await this._client.listAgents();
      this._view?.webview.postMessage({
        type: 'agentsList',
        agents
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'agentsList',
        agents: [
          { id: 'build', name: 'Build', description: 'Code implementation and edits' },
          { id: 'plan', name: 'Plan', description: 'Architecture and planning' },
          { id: 'explore', name: 'Explore', description: 'Research and exploration' }
        ]
      });
    }
  }

  private async _handleCreateSession() {
    try {
      const session = await this._client.createSession({ title: 'Chat Session' });
      // Server enforces session IDs starting with "ses".
      this._currentSessionId = session.id;
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
      const config = await this._client.getConfig();
      const agents = config.agent || {};
      
      const models: Array<{ id: string; name: string; description?: string }> = [];
      const seenModels = new Set<string>();
      
      Object.entries(agents).forEach(([agentId, agentConfig]) => {
        if (agentConfig?.model && !seenModels.has(agentConfig.model)) {
          seenModels.add(agentConfig.model);
          const modelName = agentConfig.model.split('/').pop() || agentConfig.model;
          models.push({
            id: agentConfig.model,
            name: modelName,
            description: `Used by ${agentId} agent`
          });
        }
      });
      
      if (config.model && !seenModels.has(config.model)) {
        const modelName = config.model.split('/').pop() || config.model;
        models.unshift({
          id: config.model,
          name: modelName,
          description: 'Default model'
        });
      }
      
      if (models.length === 0) {
        models.push(
          { id: 'kimi-for-coding/k2p5', name: 'Kimi K2.5', description: 'Default coding model' }
        );
      }
      
      this._view?.webview.postMessage({
        type: 'modelsList',
        models
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'modelsList',
        models: [
          { id: 'kimi-for-coding/k2p5', name: 'Kimi K2.5', description: 'Default coding model' }
        ]
      });
    }
  }

  private async _handleStopGeneration() {
    if (this._currentSessionId) {
      if (!this._currentSessionId.startsWith('ses')) {
        console.warn('[OpenCode] Refusing to abort: invalid session id', this._currentSessionId);
        this._endStreamingUI('abort refused (invalid session id)');
        return;
      }

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
                    <select id="mode-dropdown" disabled>
                      <option value="build">Build</option>
                      <option value="plan">Plan</option>
                      <option value="explore">Explore</option>
                    </select>
                    <span class="icon-svg"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M3.146 5.646a.5.5 0 0 1 .708 0L8 9.793l4.146-4.147a.5.5 0 0 1 .708.708l-4.5 4.5a.5.5 0 0 1-.708 0l-4.5-4.5a.5.5 0 0 1 0-.708z"/></svg></span>
                  </div>
                   <span class="separator">|</span>
                   <div class="model-selector">
                     <select id="model-dropdown" disabled>
                       <option value="">Kimi K2.5</option>
                     </select>
                     <span class="icon-svg"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M3.146 5.646a.5.5 0 0 1 .708 0L8 9.793l4.146-4.147a.5.5 0 0 1 .708.708l-4.5 4.5a.5.5 0 0 1-.708 0l-4.5-4.5a.5.5 0 0 1 0-.708z"/></svg></span>
                   </div>
                 </div>
                <div class="input-actions">
                  <div class="context-indicator" id="context-indicator" title="Context window usage">
                    <svg viewBox="0 0 24 24" class="context-ring">
                      <circle class="context-ring-bg" cx="12" cy="12" r="10"/>
                      <circle class="context-ring-fill" cx="12" cy="12" r="10" stroke-dasharray="62.8" stroke-dashoffset="62.8"/>
                    </svg>
                  </div>
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
        </div>
        
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }
}
