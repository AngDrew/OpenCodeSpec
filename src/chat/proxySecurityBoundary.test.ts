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

function createProvider(activeServerUrl = 'http://127.0.0.1:4096') {
  const runtime = new OpenCodeConnectionRuntime({
    workspaceRoot: 'D:/workspace/project',
    initialServerUrl: activeServerUrl,
  });
  const extensionContext = {
    workspaceState: {
      get: () => undefined,
      update: async () => undefined,
    },
  };

  const provider = new ChatPanelProvider({}, extensionContext, runtime) as any;
  const postedMessages: Array<Record<string, unknown>> = [];
  provider._view = {
    webview: {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
        return true;
      },
    },
  };

  return { provider, postedMessages };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for expected message.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('proxy HTTP allows requests targeting the active OpenCode origin', async () => {
  const { provider, postedMessages } = createProvider('http://127.0.0.1:4096');
  const previousFetch = (globalThis as any).fetch;
  const calls: Array<{ url: string; init: unknown }> = [];

  (globalThis as any).fetch = async (url: string, init: unknown) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{"ok":true}',
      headers: {
        forEach: (cb: (value: string, key: string) => void) => {
          cb('application/json', 'content-type');
        },
      },
    };
  };

  try {
    await provider._handleProxyFetch({
      type: 'proxyFetch',
      id: 'http-allow',
      url: 'http://127.0.0.1:4096/api/ping',
      method: 'GET',
    });
  } finally {
    (globalThis as any).fetch = previousFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4096/api/ping');

  const result = postedMessages.find((message) => message.type === 'proxyFetchResult');
  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
});

test('proxy HTTP rejects requests targeting non-active origins', async () => {
  const { provider, postedMessages } = createProvider('http://127.0.0.1:4096');
  const previousFetch = (globalThis as any).fetch;
  let fetchCalls = 0;

  (globalThis as any).fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch should not be called for blocked origin');
  };

  try {
    await provider._handleProxyFetch({
      type: 'proxyFetch',
      id: 'http-block',
      url: 'http://localhost:5000/private',
      method: 'GET',
    });
  } finally {
    (globalThis as any).fetch = previousFetch;
  }

  assert.equal(fetchCalls, 0);
  const result = postedMessages.find((message) => message.type === 'proxyFetchResult');
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /Host proxy blocked origin/);
});

test('proxy SSE allows subscriptions targeting the active OpenCode origin', async () => {
  const { provider, postedMessages } = createProvider('http://127.0.0.1:4096');
  const previousFetch = (globalThis as any).fetch;
  const calls: string[] = [];
  const encoder = new TextEncoder();

  (globalThis as any).fetch = async (url: string) => {
    calls.push(url);

    const chunks = [
      encoder.encode('event: message\nid: evt-1\ndata: {"kind":"hello"}\n\n'),
    ];

    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            const value = chunks.shift();
            if (!value) {
              return { done: true, value: undefined };
            }
            return { done: false, value };
          },
        }),
      },
    };
  };

  try {
    provider._handleProxySseSubscribe({
      type: 'proxySseSubscribe',
      id: 'sse-allow',
      url: 'http://127.0.0.1:4096/event',
    });

    await waitFor(() => postedMessages.some((message) => message.type === 'proxySseClosed'));
  } finally {
    (globalThis as any).fetch = previousFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'http://127.0.0.1:4096/event');

  const sseEvent = postedMessages.find((message) => message.type === 'proxySseEvent');
  assert.ok(sseEvent);
  assert.equal(sseEvent.id, 'sse-allow');
  assert.equal(sseEvent.event, 'message');
  assert.equal(sseEvent.eventID, 'evt-1');
  assert.equal(sseEvent.data, '{"kind":"hello"}');
});

test('proxy SSE rejects subscriptions targeting non-active origins', async () => {
  const { provider, postedMessages } = createProvider('http://127.0.0.1:4096');
  const previousFetch = (globalThis as any).fetch;
  let fetchCalls = 0;

  (globalThis as any).fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch should not be called for blocked origin');
  };

  try {
    provider._handleProxySseSubscribe({
      type: 'proxySseSubscribe',
      id: 'sse-block',
      url: 'http://localhost:5000/event',
    });
  } finally {
    (globalThis as any).fetch = previousFetch;
  }

  assert.equal(fetchCalls, 0);

  const errorMessage = postedMessages.find((message) => message.type === 'proxySseError');
  assert.ok(errorMessage);
  assert.equal(errorMessage.id, 'sse-block');
  assert.match(String(errorMessage.error), /Host proxy blocked origin/);

  const closedMessage = postedMessages.find((message) => message.type === 'proxySseClosed');
  assert.ok(closedMessage);
  assert.equal(closedMessage.id, 'sse-block');
});
