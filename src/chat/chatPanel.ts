import * as vscode from 'vscode';
import { getNonce } from './utils';
import { OpenCodeClient } from '../api/opencodeClient';

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'opencode.chatView';
  
  private _view?: vscode.WebviewView;
  private _client: OpenCodeClient;
  private _currentSessionId?: string;

  constructor(private readonly _extensionUri: vscode.Uri) {
    this._client = new OpenCodeClient();
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
          await this._handleSendMessage(data.text, data.agent);
          break;
        case 'getAgents':
          await this._handleGetAgents();
          break;
        case 'createSession':
          await this._handleCreateSession();
          break;
        case 'healthCheck':
          await this._handleHealthCheck();
          break;
      }
    });

    // Initialize session
    this._handleCreateSession();
  }

  public sendMessage(text: string) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'externalMessage', text });
    }
  }

  private async _handleSendMessage(text: string, agent?: string) {
    if (!this._currentSessionId) {
      await this._handleCreateSession();
    }

    try {
      // Add user message to UI
      this._view?.webview.postMessage({
        type: 'addMessage',
        role: 'user',
        content: text,
        agent
      });

      // Start assistant message
      this._view?.webview.postMessage({
        type: 'startStreaming',
        agent
      });

      // Stream response from OpenCode
      await this._client.streamPrompt(
        this._currentSessionId!,
        { parts: [{ type: 'text', text }], agent },
        (event) => {
          this._view?.webview.postMessage({
            type: 'streamChunk',
            content: event.data
          });
        },
        (error) => {
          this._view?.webview.postMessage({
            type: 'error',
            message: error.message
          });
        }
      );

      // End streaming
      this._view?.webview.postMessage({ type: 'endStreaming' });

    } catch (error) {
      this._view?.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
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
      // Fallback to default agents if API fails
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
      this._currentSessionId = session.id;
      this._view?.webview.postMessage({
        type: 'sessionCreated',
        sessionId: session.id
      });
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  }

  private async _handleHealthCheck() {
    try {
      const health = await this._client.health();
      this._view?.webview.postMessage({
        type: 'healthStatus',
        status: health.status
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'healthStatus',
        status: 'disconnected'
      });
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
        <title>OpenCode Chat</title>
      </head>
      <body>
        <div id="chat-container">
          <div id="header">
            <div id="agent-selector">
              <select id="agent-dropdown">
                <option value="">Loading agents...</option>
              </select>
              <div id="connection-status" class="disconnected"></div>
            </div>
            <button id="new-chat-btn" class="icon-btn" title="New Chat">
              <i class="codicon codicon-add"></i>
            </button>
          </div>
          
          <div id="messages-container">
            <div id="welcome-message">
              <h2>Welcome to OpenCode Chat</h2>
              <p>Your AI assistant powered by OpenCode</p>
              <div class="suggestions">
                <button class="suggestion" data-text="Explain this code">Explain this code</button>
                <button class="suggestion" data-text="How do I fix this error?">How do I fix this error?</button>
                <button class="suggestion" data-text="Refactor this function">Refactor this function</button>
              </div>
            </div>
            <div id="messages"></div>
          </div>
          
          <div id="input-container">
            <textarea 
              id="message-input" 
              placeholder="Ask OpenCode anything... (Cmd+Enter to send)"
              rows="1"
            ></textarea>
            <button id="send-btn" class="icon-btn" title="Send">
              <i class="codicon codicon-send"></i>
            </button>
          </div>
        </div>
        
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }
}
