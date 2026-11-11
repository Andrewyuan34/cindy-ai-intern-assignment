import { test } from 'node:test';
import assert from 'node:assert/strict';

test('cold entry registers immediately and delivers an early tool call after modules load', { timeout: 2000 }, async () => {
  const originalChannel = globalThis.BroadcastChannel;
  const originalCindy = globalThis.cindy;
  let listener;
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  const requests = [];
  globalThis.BroadcastChannel = class { addEventListener() {} postMessage() {} };
  globalThis.cindy = {
    onHostMessage(fn) { listener = fn; },
    async fetch(request) {
      requests.push(request);
      return { ok: true, status: 200, body: JSON.stringify(new URL(request.url).pathname === '/user'
        ? { login: 'example', id: 1 }
        : { total_count: 0, incomplete_results: false, items: [] }) };
    },
    send(message) { resolveResult(message); },
  };
  try {
    await import('../main.js');
    assert.equal(typeof listener, 'function', 'host listener must exist before asynchronous imports finish');
    listener({ type: 'tool-call', tool: 'list_my_prs', callId: 'host-call-1', args: { kind: 'review', page: 1 } });
    const response = await result;
    assert.equal(response.ok, true);
    assert.equal(response.callId, 'host-call-1');
    assert.equal(response.result.totalCount, 0);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.callId === 'host-call-1'));
  } finally {
    globalThis.BroadcastChannel = originalChannel;
    if (originalCindy === undefined) delete globalThis.cindy; else globalThis.cindy = originalCindy;
  }
});
