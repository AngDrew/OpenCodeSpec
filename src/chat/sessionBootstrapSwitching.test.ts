import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';
import { OpenCodeConnectionRuntime } from '../connection/connectionRuntime';

type ChatPanelProviderCtor = new (
  extensionUri: unknown,
  context: unknown,
  connectionRuntime: OpenCodeConnectionRuntime,
) => unknown;

function loadChatPanelProvider(): ChatPanelProviderCtor {
  const moduleLoader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;

  moduleLoader._load = (request: string, parent: unknown, isMain: boolean) => {
    if (request === 'vscode') {
      return {
        window: {
          showErrorMessage: () => undefined,
          showWarningMessage: () => undefined,
          showInformationMessage: () => undefined,
        },
        commands: {
          executeCommand: () => Promise.resolve(undefined),
        },
        workspace: {
          workspaceFolders: [],
        },
        Uri: {
          joinPath: (...parts: unknown[]) => ({ parts }),
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./chatPanel') as { ChatPanelProvider: ChatPanelProviderCtor };
    return mod.ChatPanelProvider;
  } finally {
    moduleLoader._load = originalLoad;
  }
}

const ChatPanelProvider = loadChatPanelProvider();

interface PostedMessage {
  type?: string;
  [key: string]: unknown;
}

function createProvider() {
  const runtime = new OpenCodeConnectionRuntime({
    workspaceRoot: 'D:/workspace/project',
    initialServerUrl: 'http://127.0.0.1:4096',
  });
  runtime.setReady(true);

  const extensionContext = {
    workspaceState: {
      get: () => undefined,
      update: async () => undefined,
    },
  };

  const provider = new ChatPanelProvider({}, extensionContext, runtime) as any;
  const postedMessages: PostedMessage[] = [];
  provider._view = {
    webview: {
      postMessage: (message: PostedMessage) => {
        postedMessages.push(message);
        return true;
      },
    },
  };

  return { provider, postedMessages };
}

test('session switch clears active generation before selected history bootstrap', async () => {
  const { provider, postedMessages } = createProvider();
  const historyLoads: string[] = [];

  provider._client = {
    getSessionMessages: async (sessionId: string) => {
      historyLoads.push(sessionId);
      return [
        {
          info: {
            id: 'msg-ses-new-1',
            role: 'assistant',
            sessionID: sessionId,
          },
          parts: [{ type: 'text', text: 'hello from new session' }],
        },
      ];
    },
    listSessions: async () => [],
  };

  provider._currentSessionId = 'ses-old';
  provider._isGenerating = true;
  provider._activeAssistantMessageId = 'msg-old-assistant';

  await provider._handleChangeSession('ses-new');

  assert.equal(provider._currentSessionId, 'ses-new');
  assert.equal(provider._isGenerating, false);
  assert.equal(provider._activeAssistantMessageId, undefined);
  assert.deepEqual(historyLoads, ['ses-new']);

  const endStreamingIndex = postedMessages.findIndex((message) => message.type === 'endStreaming');
  const setHistoryIndex = postedMessages.findIndex((message) => message.type === 'setHistory');
  assert.notEqual(endStreamingIndex, -1);
  assert.notEqual(setHistoryIndex, -1);
  assert.ok(endStreamingIndex < setHistoryIndex);

  const setHistory = postedMessages[setHistoryIndex] as { sessionId: string; messages: Array<{ info: { id: string } }> };
  assert.equal(setHistory.sessionId, 'ses-new');
  assert.equal(Array.isArray(setHistory.messages), true);
  assert.equal(setHistory.messages[0]?.info?.id, 'msg-ses-new-1');
});

test('reconnect health check keeps selected session bootstrap consistent', async () => {
  const { provider, postedMessages } = createProvider();
  const loadedSessions: string[] = [];
  let ensureEventStreamCalls = 0;

  provider._client = {
    health: async () => ({ healthy: true, version: 'test' }),
  };

  provider._currentSessionId = 'ses-selected';
  provider._hasRenderedInitialHistory = false;
  provider._lastHistorySessionId = undefined;

  provider._ensureEventStream = () => {
    ensureEventStreamCalls += 1;
  };
  provider._loadModelContextLimits = async () => undefined;
  provider._ensureActiveSession = async () => 'ses-selected';
  provider._loadSessionHistory = async (sessionId: string) => {
    loadedSessions.push(sessionId);
  };
  provider._handleGetAgents = async () => undefined;
  provider._handleGetModels = async () => undefined;
  provider._handleGetSessions = async () => undefined;
  provider._handleGetCommands = async () => undefined;

  await provider._handleHealthCheck(false);

  assert.equal(ensureEventStreamCalls, 1);
  assert.deepEqual(loadedSessions, ['ses-selected']);

  const healthStatuses = postedMessages
    .filter((message) => message.type === 'healthStatus')
    .map((message) => String(message.status));
  assert.deepEqual(healthStatuses.slice(0, 2), ['reconnecting', 'connected']);

  const initState = [...postedMessages].reverse().find((message) => message.type === 'initState') as
    | { payload?: { ready?: boolean; sessionContext?: { sessionId?: string } } }
    | undefined;
  assert.ok(initState);
  assert.equal(initState?.payload?.ready, true);
  assert.equal(initState?.payload?.sessionContext?.sessionId, 'ses-selected');
});
