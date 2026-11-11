import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController, createRequestHandler } from '../lib/controller.mjs';
import { createStore } from '../lib/store.mjs';

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const baseItem = { owner: 'owner', repo: 'repo', number: 1, title: 'Fix CI' };
function setup(overrides = {}) {
  const api = {
    getViewer: async () => ({ login: 'alice' }),
    listPullRequests: async () => ({ items: [{ ...baseItem }], totalCount: 1, hasMore: false }),
    getPullRequest: async input => ({ ...input, headSha: 'a'.repeat(40) }),
    getCI: async () => ({ state: 'success', checks: [], statuses: [] }),
    getDiagnostics: async () => ({ pullRequest: { headSha: 'a'.repeat(40) } }),
    ...overrides,
  };
  const taskManager = {
    capabilities: async () => ({ available: true }), statuses: async () => ({}),
    diagnose: async () => ({ taskId: 'task-1', status: 'queued' }),
  };
  return { api, taskManager, controller: createController({ api, taskManager, now: () => 123 }) };
}
test('refresh loads a current SHA and marks missing CI unknown instead of green', async () => {
  const { controller } = setup({ getCI: async () => { throw new Error('Permission denied'); } });
  const state = await controller.dispatch('refresh', { kind: 'authored' });
  assert.equal(state.lists.authored.items[0].ci.state, 'unknown');
  assert.equal(state.lists.authored.updatedAt, 123);
  assert.equal(state.lists.authored.loading, false);
});
test('concurrent focus and open events share a refresh and load more appends', async () => {
  const gate = defer(); let calls = 0;
  const { controller } = setup({ listPullRequests: async ({ page }) => {
    calls++; await gate.promise;
    return { items: [{ ...baseItem, number: page }], totalCount: 2, hasMore: page === 1 };
  } });
  const first = controller.dispatch('refresh', { kind: 'authored' });
  const second = controller.dispatch('refresh', { kind: 'authored' });
  gate.resolve(); await Promise.all([first, second]); assert.equal(calls, 1);
  const state = await controller.dispatch('loadMore', { kind: 'authored' });
  assert.deepEqual(state.lists.authored.items.map(item => item.number), [1, 2]);
  assert.equal(calls, 2);
});
test('changing account clears stale list and keeps task mapping scoped to viewer', async () => {
  const { controller, api, taskManager } = setup();
  taskManager.statuses = async () => ({ 'alice|owner/repo#1': { taskId: 'alice-task' }, 'bob|owner/repo#1': { taskId: 'bob-task' } });
  await controller.dispatch('refresh', { kind: 'authored' });
  assert.equal(controller.snapshot().diagnoses['owner/repo#1'].taskId, 'alice-task');
  api.getViewer = async () => ({ login: 'bob' });
  const state = await controller.dispatch('refresh', { kind: 'review' });
  assert.equal(state.lists.authored.items.length, 0);
  assert.equal(state.diagnoses['owner/repo#1'].taskId, 'bob-task');
});
test('old in-flight authentication cannot overwrite settings change', async () => {
  const old = defer();
  const { controller, api } = setup({ getViewer: () => old.promise });
  const first = controller.dispatch('refresh', { kind: 'authored' });
  api.getViewer = async () => ({ login: 'bob' });
  await controller.dispatch('configChanged');
  old.resolve({ login: 'alice' }); await first;
  assert.equal(controller.snapshot().viewer.login, 'bob');
});
test('diagnosis failures stay visible; repeated clicks share one submission', async () => {
  const gate = defer(); let sends = 0;
  const { controller, taskManager } = setup();
  taskManager.diagnose = async () => { sends++; await gate.promise; throw new Error('Model unavailable'); };
  const first = controller.dispatch('diagnose', baseItem);
  const second = controller.dispatch('diagnose', baseItem);
  gate.resolve(); await Promise.allSettled([first, second]);
  assert.equal(sends, 1);
  assert.equal(controller.snapshot().diagnoses['owner/repo#1'].error, 'Model unavailable');
});
test('late diagnosis from an old account cannot overwrite a new account', async () => {
  const gate = defer(); const started = defer();
  const { controller, api, taskManager } = setup();
  await controller.dispatch('refresh', { kind: 'authored' });
  taskManager.diagnose = async ({ login }) => {
    if (login === 'alice') { started.resolve(); await gate.promise; throw new Error('old account failed'); }
    return { taskId: 'bob-task', status: 'queued' };
  };
  const old = controller.dispatch('diagnose', baseItem);
  await started.promise;
  api.getViewer = async () => ({ login: 'bob' });
  await controller.dispatch('configChanged');
  await controller.dispatch('diagnose', baseItem);
  gate.resolve(); await assert.rejects(old);
  assert.equal(controller.snapshot().diagnoses['owner/repo#1'].taskId, 'bob-task');
  assert.equal(controller.snapshot().diagnoses['owner/repo#1'].error, null);
});
test('late task status read cannot restore a previous account mapping', async () => {
  const gate = defer(); const started = defer();
  const { controller, api, taskManager } = setup();
  await controller.dispatch('refresh', { kind: 'authored' });
  taskManager.statuses = async () => { started.resolve(); return gate.promise; };
  const old = controller.dispatch('snapshot'); await started.promise;
  taskManager.statuses = async () => ({});
  api.getViewer = async () => ({ login: 'bob' });
  await controller.dispatch('configChanged');
  gate.resolve({ 'alice|owner/repo#1': { taskId: 'alice-task' } }); await old;
  assert.equal(controller.snapshot().viewer.login, 'bob');
  assert.deepEqual(controller.snapshot().diagnoses, {});
});
test('broadcast retries execute once; changed payload with same ID is refused', async () => {
  const gate = defer(); const responses = []; let sends = 0;
  const handle = createRequestHandler({ dispatch: async () => { sends++; await gate.promise; return 'accepted'; }, respond: value => responses.push(value) });
  const request = { kind: 'request', id: 'one', action: 'diagnose', payload: baseItem };
  handle(request); handle(request); handle({ ...request, payload: { ...baseItem, number: 2 } });
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1); assert.equal(responses.filter(r => r.ok).length, 2);
  assert.equal(responses.filter(r => !r.ok).length, 1);
});
test('KV serializes whole-object writers and preserves unrelated keys', async () => {
  let disk = { preferences: { example: true } };
  const store = createStore({ fetch: async (url, options) => {
    if (options) { disk = JSON.parse(options.body); return { status: 204 }; }
    return { ok: true, json: async () => structuredClone(disk) };
  } });
  await Promise.all([store.update(d => { d.a = 1; }), store.update(d => { d.b = 2; })]);
  assert.deepEqual(disk, { preferences: { example: true }, a: 1, b: 2 });
});
test('KV read failure does not overwrite data; byte budget rejects before PUT', async () => {
  let writes = 0;
  const store = createStore({ fetch: async (url, options) => { if (options) writes++; return { ok: false }; } });
  await assert.rejects(store.update(d => { d.a = 1; })); assert.equal(writes, 0);
  const full = createStore({ fetch: async (url, options) => {
    if (options) writes++;
    return { ok: true, json: async () => ({}) };
  } });
  await assert.rejects(full.update(d => { d.a = '中'.repeat(23000); }), /存储上限/);
  assert.equal(writes, 0);
});
