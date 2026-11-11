import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpc } from '../lib/rpc.mjs';

const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function setup(t, { wake, onPost, timeoutMs } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const channels = [];
  const wakes = [];
  const originalChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = class {
    constructor(name) {
      assert.equal(name, 'cindy-pr-dashboard-v1');
      this.posts = [];
      this.closed = false;
      channels.push(this);
    }
    addEventListener(name, listener) {
      assert.equal(name, 'message');
      this.listener = listener;
    }
    postMessage(message) {
      assert.equal(this.closed, false, 'must not post after channel close');
      this.posts.push(structuredClone(message));
      onPost?.(this, message);
    }
    receive(message) { this.listener({ data: message }); }
    close() { this.closed = true; }
  };
  t.after(() => { globalThis.BroadcastChannel = originalChannel; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/wake');
    assert.ok(options.signal instanceof AbortSignal);
    wakes.push({ url, signal: options.signal });
    return wake ? wake() : { ok: true, json: async () => ({ state: 'running' }) };
  });
  const rpc = createRpc({ timeoutMs });
  t.after(() => rpc.close());
  return { rpc, channel: channels[0], wakes, tick: (ms) => t.mock.timers.tick(ms) };
}

test('wake HTTP, network, invalid JSON and inactive-state failures never post a request', async (t) => {
  const cases = [
    ['HTTP error', async () => ({ ok: false, status: 503 })],
    ['network error', async () => { throw new Error('fixture offline'); }],
    ['invalid JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('fixture invalid JSON'); } })],
    ['disabled plugin', async () => ({ ok: true, json: async () => ({ state: 'off' }) })],
    ['fused plugin', async () => ({ ok: true, json: async () => ({ state: 'fused' }) })],
    ['unknown state', async () => ({ ok: true, json: async () => ({ state: 'unknown' }) })],
  ];
  for (const [name, wake] of cases) {
    await t.test(name, async (t) => {
      const { rpc, channel, wakes, tick } = setup(t, { wake });
      await assert.rejects(rpc.request('refresh', { kind: 'authored', reason: 'open' }));
      tick(120000);
      assert.equal(channel.posts.length, 0);
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0].signal.aborted, true);
    });
  }
});

test('cold main misses two messages then receives the same id and payload on its third attempt', async (t) => {
  const { rpc, channel, wakes, tick } = setup(t, {
    wake: async () => ({ ok: true, json: async () => ({ state: 'starting' }) }),
    onPost(channel, request) {
      if (channel.posts.length === 3) channel.receive({ kind: 'response', id: request.id, ok: true, data: { accepted: true } });
    },
  });
  const payload = { owner: 'Owner', repo: 'repo', number: 3 };
  const response = rpc.request('diagnose', payload);
  assert.equal(channel.posts.length, 0, 'wait for successful wake before posting');
  await flushMicrotasks();
  assert.equal(channel.posts.length, 1);
  tick(500);
  assert.equal(channel.posts.length, 2);
  tick(500);
  assert.deepEqual(await response, { accepted: true });
  assert.equal(new Set(channel.posts.map(message => message.id)).size, 1);
  for (const message of channel.posts) {
    assert.equal(message.kind, 'request');
    assert.equal(message.action, 'diagnose');
    assert.deepEqual(message.payload, payload);
  }
  tick(120000);
  assert.equal(channel.posts.length, 3, 'settled response cancels retries and deadline');
  assert.equal(wakes.length, 1, 'transport retries do not repeatedly wake the host');
});

test('pending registration accepts an immediate synchronous reply', async (t) => {
  const { rpc, channel, tick } = setup(t, {
    onPost(channel, request) { channel.receive({ kind: 'response', id: request.id, ok: true, data: 'ready' }); },
  });
  assert.equal(await rpc.request('snapshot'), 'ready');
  tick(120000);
  assert.equal(channel.posts.length, 1);
});

test('close rejects pending work and cancels retransmission', async (t) => {
  const { rpc, channel, wakes, tick } = setup(t);
  const pending = rpc.request('snapshot');
  const rejection = assert.rejects(pending, /页面连接已关闭/);
  await flushMicrotasks();
  assert.equal(channel.posts.length, 1);
  rpc.close();
  await rejection;
  tick(120000);
  assert.equal(channel.posts.length, 1);
  assert.equal(channel.closed, true);
  assert.equal(wakes[0].signal.aborted, true);
  await assert.rejects(rpc.request('snapshot'), /页面连接已关闭/);
});

test('timeout rejects work, aborts wake and prevents any later retransmission', async (t) => {
  const { rpc, channel, wakes, tick } = setup(t, { timeoutMs: 1000 });
  const pending = rpc.request('snapshot');
  const rejection = assert.rejects(pending, /响应超时/);
  await flushMicrotasks();
  tick(500);
  assert.equal(channel.posts.length, 2);
  tick(500);
  await rejection;
  const sent = channel.posts.length;
  tick(120000);
  assert.equal(channel.posts.length, sent);
  assert.equal(wakes[0].signal.aborted, true);
});

test('a late successful wake cannot post after close or timeout', async (t) => {
  for (const ending of ['close', 'timeout']) {
    await t.test(ending, async (t) => {
      let resolveWake;
      const gate = new Promise(resolve => { resolveWake = resolve; });
      const { rpc, channel, wakes, tick } = setup(t, { wake: () => gate, timeoutMs: 1000 });
      const pending = rpc.request('snapshot');
      const rejection = assert.rejects(pending, ending === 'close' ? /页面连接已关闭/ : /响应超时/);
      if (ending === 'close') rpc.close(); else tick(1000);
      await rejection;
      resolveWake({ ok: true, json: async () => ({ state: 'running' }) });
      await flushMicrotasks();
      tick(120000);
      assert.equal(channel.posts.length, 0);
      assert.equal(wakes[0].signal.aborted, true);
    });
  }
});
