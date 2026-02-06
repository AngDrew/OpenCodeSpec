import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeClient } from '../api/opencodeClient';
import { OpenCodeConnectionRuntime, OpenCodeServerHandle } from './connectionRuntime';

class StubOpenCodeClient extends OpenCodeClient {
  private _queuedHandle?: OpenCodeServerHandle;
  private _queuedError?: Error;

  queueHandle(handle: OpenCodeServerHandle) {
    this._queuedHandle = handle;
  }

  queueError(error: Error) {
    this._queuedError = error;
  }

  override async startServer(): Promise<OpenCodeServerHandle> {
    if (this._queuedError) {
      const error = this._queuedError;
      this._queuedError = undefined;
      throw error;
    }

    if (!this._queuedHandle) {
      throw new Error('No queued server handle');
    }

    const handle = this._queuedHandle;
    this._queuedHandle = undefined;
    return handle;
  }
}

function createHandle(url: string, onClose?: () => void): OpenCodeServerHandle {
  return {
    url,
    close: () => {
      onClose?.();
    },
  };
}

test('initialize: runtime starts disconnected without a fixed server URL', () => {
  const runtime = new OpenCodeConnectionRuntime({
    workspaceRoot: 'D:/workspace/project',
  });

  assert.equal(runtime.workspaceRoot, 'D:/workspace/project');
  assert.equal(runtime.currentServerUrl, '');
  assert.equal(runtime.isReady, false);
  assert.equal(runtime.serverHandle, undefined);
});

test('start: startServerWithRuntime sets server handle and URL', async () => {
  const runtime = new OpenCodeConnectionRuntime({
    workspaceRoot: 'D:/workspace/project',
  });
  const client = new StubOpenCodeClient('http://127.0.0.1:4096');
  const startedHandle = createHandle('http://127.0.0.1:4100');

  client.queueHandle(startedHandle);
  const returnedHandle = await client.startServerWithRuntime(runtime);

  assert.equal(returnedHandle, startedHandle);
  assert.equal(runtime.serverHandle, startedHandle);
  assert.equal(runtime.currentServerUrl, 'http://127.0.0.1:4100');
  assert.equal(runtime.isReady, false);
});

test('stop: stopServerWithRuntime closes handle and clears runtime readiness', () => {
  const runtime = new OpenCodeConnectionRuntime({
    initialServerUrl: 'http://127.0.0.1:4100',
  });
  const client = new StubOpenCodeClient('http://127.0.0.1:4096');
  let closeCalls = 0;

  runtime.setServerHandle(createHandle('http://127.0.0.1:4100', () => {
    closeCalls += 1;
  }));
  runtime.setReady(true);

  const stopped = client.stopServerWithRuntime(runtime);

  assert.equal(stopped, true);
  assert.equal(closeCalls, 1);
  assert.equal(runtime.serverHandle, undefined);
  assert.equal(runtime.isReady, false);
});

test('reconnect: runtime can transition from stop to a new started server', async () => {
  const runtime = new OpenCodeConnectionRuntime();
  const client = new StubOpenCodeClient('http://127.0.0.1:4096');
  let firstClosed = 0;

  const firstHandle = createHandle('http://127.0.0.1:4100', () => {
    firstClosed += 1;
  });
  client.queueHandle(firstHandle);
  await client.startServerWithRuntime(runtime);
  runtime.setReady(true);

  const stopped = client.stopServerWithRuntime(runtime);
  assert.equal(stopped, true);
  assert.equal(firstClosed, 1);
  assert.equal(runtime.isReady, false);

  const secondHandle = createHandle('http://127.0.0.1:4200');
  client.queueHandle(secondHandle);
  await client.startServerWithRuntime(runtime);

  assert.equal(runtime.serverHandle, secondHandle);
  assert.equal(runtime.currentServerUrl, 'http://127.0.0.1:4200');
});

test('error: start failure leaves existing runtime state unchanged', async () => {
  const runtime = new OpenCodeConnectionRuntime({
    initialServerUrl: 'http://127.0.0.1:4100',
  });
  const client = new StubOpenCodeClient('http://127.0.0.1:4096');
  const existingHandle = createHandle('http://127.0.0.1:4100');

  runtime.setServerHandle(existingHandle);
  runtime.setReady(true);
  client.queueError(new Error('simulated startup failure'));

  await assert.rejects(() => client.startServerWithRuntime(runtime), /simulated startup failure/);
  assert.equal(runtime.serverHandle, existingHandle);
  assert.equal(runtime.currentServerUrl, 'http://127.0.0.1:4100');
  assert.equal(runtime.isReady, true);
});

test('error: stop still clears runtime when handle.close throws', () => {
  const runtime = new OpenCodeConnectionRuntime({
    initialServerUrl: 'http://127.0.0.1:4100',
  });
  const client = new StubOpenCodeClient('http://127.0.0.1:4096');

  runtime.setServerHandle({
    url: 'http://127.0.0.1:4100',
    close: () => {
      throw new Error('close failed');
    },
  });
  runtime.setReady(true);

  const stopped = client.stopServerWithRuntime(runtime);

  assert.equal(stopped, true);
  assert.equal(runtime.serverHandle, undefined);
  assert.equal(runtime.isReady, false);
});
