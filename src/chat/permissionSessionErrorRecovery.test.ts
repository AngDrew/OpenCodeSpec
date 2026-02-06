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
  role?: string;
  content?: string;
  message?: string;
  [key: string]: unknown;
}

interface EventPayload {
  type: string;
  properties?: Record<string, unknown>;
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

test('permission failure recovery keeps prompt flow usable for the next prompt', async () => {
  const { provider, postedMessages } = createProvider();
  let promptCalls = 0;

  provider._ensureActiveSession = async () => 'ses-permission';
  provider._maybeRenameSessionFromFirstInput = () => undefined;
  provider._ensureEventStream = () => undefined;
  provider._client = {
    prompt: async () => {
      promptCalls += 1;
      if (promptCalls === 1) {
        throw new Error('Permission denied by policy');
      }

      return {
        text: 'recovered response',
        assistantMessageId: 'msg-recovered',
      };
    },
  };

  await provider._handleSendMessage('first prompt');

  assert.equal(promptCalls, 1);
  assert.equal(provider._isGenerating, false);
  assert.equal(postedMessages.filter((message: PostedMessage) => message.type === 'error').length, 1);
  const firstError = postedMessages.find((message: PostedMessage) => message.type === 'error');
  assert.ok(firstError);
  assert.match(String(firstError.message), /permission denied/i);
  assert.equal(postedMessages.filter((message: PostedMessage) => message.type === 'endStreaming').length, 1);

  await provider._handleSendMessage('second prompt');

  assert.equal(promptCalls, 2);
  assert.equal(postedMessages.filter((message: PostedMessage) => message.type === 'startStreaming').length, 2);
  const userContents = postedMessages
    .filter((message: PostedMessage) => message.type === 'addMessage' && message.role === 'user')
    .map((message: PostedMessage) => String(message.content));
  assert.deepEqual(userContents.slice(-2), ['first prompt', 'second prompt']);

  provider._endStreamingUI('test cleanup');
  assert.equal(provider._isGenerating, false);
});

test('session error recovery keeps prompt flow usable after stream failure', async () => {
  const { provider, postedMessages } = createProvider();
  let promptCalls = 0;
  let emitEvent: ((event: EventPayload) => void) | undefined;

  provider._ensureActiveSession = async () => 'ses-stream';
  provider._maybeRenameSessionFromFirstInput = () => undefined;
  provider._client = {
    prompt: async () => {
      promptCalls += 1;
      return {
        text: '',
        assistantMessageId: `msg-${promptCalls}`,
      };
    },
    subscribeEvents: async (onEvent: (event: EventPayload) => void) => {
      emitEvent = onEvent;
      return new Promise<void>(() => {
        // Keep subscription active for explicit event injection in test.
      });
    },
  };

  await provider._handleSendMessage('first stream prompt');

  assert.equal(promptCalls, 1);
  assert.equal(typeof emitEvent, 'function');
  assert.equal(provider._isGenerating, true);

  emitEvent?.({
    type: 'session.error',
    properties: {
      sessionID: 'ses-stream',
      error: { message: 'session failed' },
    },
  });

  assert.equal(provider._isGenerating, false);
  const sessionErrors = postedMessages
    .filter((message: PostedMessage) => message.type === 'error')
    .map((message: PostedMessage) => String(message.message));
  assert.ok(sessionErrors.some((message: string) => message.includes('session failed')));

  await provider._handleSendMessage('second stream prompt');

  assert.equal(promptCalls, 2);
  assert.equal(postedMessages.filter((message: PostedMessage) => message.type === 'startStreaming').length, 2);

  emitEvent?.({
    type: 'session.error',
    properties: {
      sessionID: 'ses-stream',
      error: { message: 'second session failure for cleanup' },
    },
  });

  assert.equal(provider._isGenerating, false);
  const userContents = postedMessages
    .filter((message: PostedMessage) => message.type === 'addMessage' && message.role === 'user')
    .map((message: PostedMessage) => String(message.content));
  assert.deepEqual(userContents.slice(-2), ['first stream prompt', 'second stream prompt']);
});
