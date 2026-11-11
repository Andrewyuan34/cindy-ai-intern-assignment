import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, createRequestHandler } from '../lib/controller.mjs';
import { createTaskManager } from '../lib/tasks.mjs';
import { createRpc } from '../lib/rpc.mjs';

/* Unit contract: a recent user click may focus an already-known task, without another
 * authentication/network round trip consuming its gesture lifetime. Existing tests cover
 * diagnosis delivery, not this navigation action or the context projection. Minimal failure:
 * replay one navigation message, delay /wake past 2.5 s, or request a task with pending text.
 * All production entry points use memory fakes; no app, network, storage or real sleep.
 * Standalone observed runtime: 189 ms runner / 1.58 s command wall time (2026-11-11).
 */
const pr = { owner: 'Acme', repo: 'Project', number: 12 };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function controllerFixture({ openTaskView, time = 10000 } = {}) {
  const calls = [];
  const note = (name, value) => async () => { calls.push(name); return value; };
  const controller = createController({
    now: () => time,
    openTaskView,
    api: { getViewer: note('auth', { login: 'Alice' }), getDiagnostics: note('network', {}) },
    taskManager: {
      capabilities: note('capabilities', { available: true, reason: '' }),
      diagnose: note('diagnose', { taskId: 'task-1', runId: 'run-1', status: 'completed', pending: false }),
      statuses: note('statuses', {}),
    },
  });
  return { controller, calls, async seed() { await controller.dispatch('diagnose', pr); calls.length = 0; } };
}

test('opening a known diagnosis immediately asks the host to focus its cached task', async () => {
  const opened = [], gate = deferred();
  const f = controllerFixture({ openTaskView: value => { opened.push(value); return gate.promise; } });
  await f.seed();
  const pending = f.controller.dispatch('openDiagnosis', { ...pr, expiresAt: 12500 });
  assert.deepEqual(opened, [{ sessionId: 'task-1', focus: true }], 'host call must happen before an extra asynchronous round trip');
  assert.deepEqual(f.calls, [], 'navigation may not authenticate, read CI or query task status');
  gate.resolve({ ok: true, focusRequested: true, sessionId: 'task-1' });
  assert.deepEqual(await pending, { taskId: 'task-1', focusRequested: true });
});

test('expired, excessive and malformed click deadlines are rejected without reaching the host', async () => {
  const opened = [];
  const f = controllerFixture({ openTaskView: value => { opened.push(value); return { ok: true, focusRequested: true, sessionId: 'task-1' }; } });
  await f.seed();
  for (const expiresAt of [9999, 10000, 12501, undefined, null, '12500', NaN, Infinity]) {
    await assert.rejects(f.controller.dispatch('openDiagnosis', { ...pr, expiresAt }));
  }
  assert.deepEqual(opened, []); assert.deepEqual(f.calls, []);
});

test('missing cached task and unsupported host do not fall back to task or network lookups', async () => {
  const opened = [];
  const missing = controllerFixture({ openTaskView: value => { opened.push(value); } });
  await assert.rejects(missing.controller.dispatch('openDiagnosis', { ...pr, expiresAt: 12500 }));
  assert.deepEqual(opened, []); assert.deepEqual(missing.calls, []);
  const unsupported = controllerFixture(); await unsupported.seed();
  await assert.rejects(unsupported.controller.dispatch('openDiagnosis', { ...pr, expiresAt: 12500 }));
  assert.deepEqual(unsupported.calls, []);
});

test('host focus responses must affirm success, focus and the same task identity', async () => {
  for (const response of [undefined, { ok: false, focusRequested: true, sessionId: 'task-1' },
    { ok: true, focusRequested: false, sessionId: 'task-1' }, { ok: true, focusRequested: true, sessionId: 'other-task' }]) {
    const f = controllerFixture({ openTaskView: async () => response }); await f.seed();
    await assert.rejects(f.controller.dispatch('openDiagnosis', { ...pr, expiresAt: 12500 }));
    assert.deepEqual(f.calls, []);
  }
});

test('duplicate transport IDs focus the task once and replay the same response', async () => {
  const opened = [], responses = [], gate = deferred();
  const f = controllerFixture({ openTaskView: value => { opened.push(value); return gate.promise; } });
  await f.seed();
  const handle = createRequestHandler({ dispatch: f.controller.dispatch, respond: response => responses.push(response) });
  const request = { kind: 'request', id: 'navigation-1', action: 'openDiagnosis', payload: { ...pr, expiresAt: 12500 } };
  handle(request); handle(structuredClone(request)); await flush();
  assert.equal(opened.length, 1); assert.equal(responses.length, 0);
  gate.resolve({ ok: true, focusRequested: true, sessionId: 'task-1' }); await flush();
  assert.equal(responses.length, 2); assert.deepEqual(responses[0], responses[1]);
  assert.equal(responses[0].ok, true); assert.deepEqual(responses[0].data, { taskId: 'task-1', focusRequested: true });
  handle(request); await flush(); assert.equal(opened.length, 1); assert.equal(responses.length, 3);
  assert.deepEqual(f.calls, []);
});

test('task context is a read-only, bounded projection of the matching version-1 KV record', async () => {
  const original = { settings: { privateSetting: 'private-setting' }, tasks: {
    'alice|acme/project#12': { version: 1, taskId: 'task-1', runId: 'run-1', status: 'reconciling', reason: 'waiting',
      arbitrary: 'must-not-leak', pending: { phase: 'send', payload: { text: 'private-prompt', requestKey: 'private-key' } } },
    'alice|acme/old#3': { version: 2, taskId: 'future-task', status: 'completed' },
  } };
  let reads = 0, writes = 0, hostCalls = 0;
  const host = new Proxy({}, { get() { return () => { hostCalls++; throw new Error('host access forbidden'); }; } });
  const manager = createTaskManager({ tasks: host, store: {
    read: async () => { reads++; return structuredClone(original); },
    update: async () => { writes++; throw new Error('write forbidden'); },
  } });
  const context = await manager.contextForTask('task-1');
  assert.equal(context.taskId, 'task-1'); assert.equal(context.login, 'alice');
  assert.equal(context.owner, 'acme'); assert.equal(context.repo, 'project'); assert.equal(context.number, 12);
  assert.equal(context.url, 'https://github.com/acme/project/pull/12');
  assert.equal(typeof context.title, 'string'); assert.ok(context.title.length > 0);
  assert.equal(context.status, 'reconciling'); assert.equal(context.runId, 'run-1');
  assert.equal(context.pending, true); assert.equal(context.reason, 'waiting');
  assert.deepEqual(Object.keys(context).sort(), ['taskId', 'login', 'owner', 'repo', 'number', 'url', 'title', 'status', 'runId', 'pending', 'reason'].sort());
  assert.doesNotMatch(JSON.stringify(context), /private-prompt|private-key|must-not-leak|private-setting/);
  assert.equal(await manager.contextForTask('unknown-task'), null);
  assert.equal(await manager.contextForTask('future-task'), null);
  assert.equal(reads, 3); assert.equal(writes, 0); assert.equal(hostCalls, 0);
});

test('invalid task identities are rejected before KV is read', async () => {
  let reads = 0;
  const manager = createTaskManager({ tasks: {}, store: { read: async () => { reads++; return {}; }, update: async () => assert.fail('no writes') } });
  for (const taskId of ['', null, 17, {}, 'a/b', 'a b', '_task', 'x'.repeat(65)]) await assert.rejects(async () => manager.contextForTask(taskId));
  assert.equal(reads, 0);
});

function rpcFixture(t, { wake } = {}) {
  let now = 10000, nextTimer = 0;
  const timers = new Map(), channels = [], wakes = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, delay = 0) => {
    const id = ++nextTimer; timers.set(id, { at: now + Number(delay), fn }); return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => { timers.delete(id); });
  const originalChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = class {
    constructor() { this.posts = []; channels.push(this); }
    addEventListener(name, listener) { assert.equal(name, 'message'); this.listener = listener; }
    postMessage(value) { this.posts.push({ at: now, message: structuredClone(value) }); }
    receive(value) { this.listener({ data: value }); }
    close() {}
  };
  t.after(() => { globalThis.BroadcastChannel = originalChannel; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/wake'); wakes.push(options.signal);
    return wake ? wake() : { ok: true, json: async () => ({ state: 'running' }) };
  });
  const rpc = createRpc(); t.after(() => rpc.close());
  function tick(ms) {
    const end = now + ms;
    for (;;) {
      const entry = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) break;
      const [id, timer] = entry; timers.delete(id); now = timer.at; timer.fn();
    }
    now = end;
  }
  return { rpc, channel: channels[0], wakes, tick };
}

test('navigation transport supplies its own 2.5 s deadline and retries only the same bounded request', async t => {
  const { rpc, channel, wakes, tick } = rpcFixture(t);
  const payload = { ...pr, expiresAt: 999999 };
  const pending = rpc.request('openDiagnosis', payload);
  const rejected = assert.rejects(pending, /再次点击/);
  await flush();
  for (let step = 0; step < 4; step++) tick(500);
  assert.deepEqual(channel.posts.map(post => post.at), [10000, 10500, 11000, 11500, 12000]);
  assert.equal(new Set(channel.posts.map(post => post.message.id)).size, 1);
  for (const { message } of channel.posts) assert.deepEqual(message.payload, { ...pr, expiresAt: 12500 });
  assert.equal(payload.expiresAt, 999999, 'caller payload is not mutated');
  tick(500); await rejected;
  tick(120000); assert.equal(channel.posts.length, 5); assert.equal(wakes.length, 1); assert.equal(wakes[0].aborted, true);
});

test('navigation that expires while wake is pending never reaches the channel', async t => {
  const gate = deferred(); const { rpc, channel, wakes, tick } = rpcFixture(t, { wake: () => gate.promise });
  const pending = rpc.request('openDiagnosis', pr); const rejected = assert.rejects(pending, /再次点击/);
  tick(2500); await rejected; assert.equal(wakes[0].aborted, true);
  gate.resolve({ ok: true, json: async () => ({ state: 'running' }) }); await flush();
  tick(120000); assert.deepEqual(channel.posts, []);
});

test('non-navigation RPC retains its 120 s timeout and original payload', async t => {
  const { rpc, channel, tick } = rpcFixture(t);
  let settled = false;
  const pending = rpc.request('refresh', { kind: 'authored' });
  pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending);
  await flush(); tick(2500); await flush(); assert.equal(settled, false);
  assert.deepEqual(channel.posts[0].message.payload, { kind: 'authored' });
  tick(117499); await flush(); assert.equal(settled, false);
  tick(1); await rejected; assert.equal(settled, true);
});
