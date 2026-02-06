export interface OpenCodeServerHandle {
  url: string;
  close: () => void;
}

interface OpenCodeConnectionRuntimeOptions {
  workspaceRoot?: string;
  initialServerUrl?: string;
}

export class OpenCodeConnectionRuntime {
  private _serverHandle?: OpenCodeServerHandle;
  private _isReady: boolean = false;
  private _currentServerUrl: string;
  private _workspaceRoot?: string;

  constructor(options?: OpenCodeConnectionRuntimeOptions) {
    this._workspaceRoot = options?.workspaceRoot;
    // Keep empty until we have an explicit endpoint from persisted state,
    // a user-selected URL, or a started local server.
    this._currentServerUrl = typeof options?.initialServerUrl === 'string'
      ? options.initialServerUrl.trim()
      : '';
  }

  get serverHandle(): OpenCodeServerHandle | undefined {
    return this._serverHandle;
  }

  setServerHandle(serverHandle?: OpenCodeServerHandle) {
    this._serverHandle = serverHandle;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  setReady(isReady: boolean) {
    this._isReady = isReady;
  }

  get currentServerUrl(): string {
    return this._currentServerUrl;
  }

  setCurrentServerUrl(serverUrl: string) {
    this._currentServerUrl = typeof serverUrl === 'string' ? serverUrl.trim() : '';
  }

  get workspaceRoot(): string | undefined {
    return this._workspaceRoot;
  }
}
