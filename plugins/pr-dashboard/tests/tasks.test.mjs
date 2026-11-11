import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskManager } from '../lib/tasks.mjs';

/* Unit contract tests through the exported manager, using an in-memory host/store.
 * Protect taskSlot/pluginTaskService idempotency, revision, permission and /kv persistence.
 * This plugin has no prior task tests. Minimal failure: a host accepts a send but loses its ACK;
 * a second manager must replay the exact payload, not start a second task or change revision.
 * No network, model calls, timers or app data. Run: node --test tests/tasks.test.mjs.
 * Observed standalone runtime: 201 ms runner / 1.06 s command wall time (2026-11-11).
 */
const clone = value => structuredClone(value);
const err = (code, message = code) => Object.assign(new Error(message), { code });
const sha = 'a'.repeat(40);
const input = (extra = {}) => ({ login: 'Alice', owner: 'Acme', repo: 'Project', number: 12,
  diagnostics: { pullRequest: { headSha: sha, title: 'Fix build' }, ci: { state: 'failure', checks: [{ name: 'test', conclusion: 'failure' }] }, annotations: [], jobs: [] }, ...extra });
const key = 'alice|acme/project#12';

function fixture(initial = {}) {
  let data = clone(initial), updateCount = 0, failAt = -1, counter = 0, revision = 4;
  const records = new Map(), runs = new Map();
  const calls = { create: [], get: [], send: [], getRun: [] };
  const hooks = {};
  const store = {
    async read() { return clone(data); },
    async update(fn) {
      updateCount++;
      if (updateCount === failAt) throw err('TEST_STORAGE_FAILURE');
      const draft = clone(data); await fn(draft); data = draft; return clone(data);
    },
  };
  const tasks = {
    async capabilities() { return { operations: ['create', 'get', 'send', 'getRun'] }; },
    async create(payload) {
      calls.create.push(clone(payload));
      assert.ok(Object.values(data.tasks || {}).some(record => JSON.stringify(record.pending?.payload) === JSON.stringify(payload)), 'persist create before delivery');
      if (hooks.create) return hooks.create(payload);
      if (!records.has(payload.requestKey)) records.set(payload.requestKey, { taskId: `task-${records.size + 1}`, status: 'active', revision });
      return clone(records.get(payload.requestKey));
    },
    async get(payload) { calls.get.push(clone(payload)); return hooks.get ? hooks.get(payload) : { taskId: payload.taskId, revision, status: 'active' }; },
    async send(payload) {
      calls.send.push(clone(payload));
      assert.ok(Object.values(data.tasks || {}).some(record => JSON.stringify(record.pending?.payload) === JSON.stringify(payload)), 'persist exact send before delivery');
      if (hooks.send) return hooks.send(payload);
      const existing = [...runs.values()].find(run => run.requestKey === payload.requestKey);
      if (existing) return clone(existing);
      const run = { taskId: payload.taskId, runId: `run-${runs.size + 1}`, status: 'queued', requestKey: payload.requestKey };
      runs.set(run.runId, run); return clone(run);
    },
    async getRun(payload) { calls.getRun.push(clone(payload)); return hooks.getRun ? hooks.getRun(payload) : clone(runs.get(payload.runId)); },
  };
  const manager = () => createTaskManager({ tasks, store, id: () => `request-${++counter}` });
  return { tasks, store, calls, hooks, runs, manager, data: () => clone(data), failAt: value => { failAt = value; }, updates: () => updateCount, revision: value => { revision = value; } };
}

test('double click creates one independent task, persists before sending, and drops delivered prompt', async () => {
  const f = fixture({ settings: { refresh: 'manual' } }), m = f.manager();
  const [a, b] = await Promise.all([m.diagnose(input()), m.diagnose(input())]);
  assert.deepEqual(a, b); assert.equal(a.status, 'queued'); assert.equal(a.pending, false);
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.send.length, 1);
  assert.equal(f.data().tasks[key].pending, undefined); assert.deepEqual(f.data().settings, { refresh: 'manual' });
  assert.deepEqual(Object.keys(f.calls.create[0]).sort(), ['requestKey', 'title']);
  assert.deepEqual(Object.keys(f.calls.send[0]).sort(), ['expectedRevision', 'requestKey', 'taskId', 'text']);
  await m.diagnose(input()); assert.equal(f.calls.send.length, 1, 'queued task is not sent another message');
});

test('unknown create ACK survives restart and repeats the original request and diagnostic facts', async () => {
  const f = fixture();
  f.hooks.create = async () => { throw err('DELIVERY_UNCERTAIN'); };
  assert.equal((await f.manager().diagnose(input())).pending, true);
  const persisted = f.data().tasks[key].pending;
  delete f.hooks.create;
  const result = await f.manager().diagnose(input({ diagnostics: { pullRequest: { headSha: 'b'.repeat(40) } } }));
  assert.equal(result.status, 'queued'); assert.deepEqual(f.calls.create[0], f.calls.create[1]);
  assert.equal(f.calls.send[0].text, persisted.sendDraft.text);
});

test('unknown send ACK replays exact expectedRevision, key and payload across restart', async () => {
  const f = fixture();
  f.hooks.send = async () => { throw err('DELIVERY_UNCERTAIN'); };
  const first = await f.manager().diagnose(input());
  assert.equal(first.status, 'reconciling'); assert.equal(first.pending, true);
  const original = clone(f.calls.send[0]); f.revision(99); delete f.hooks.send;
  const result = await f.manager().diagnose(input({ diagnostics: { pullRequest: { headSha: 'b'.repeat(40) } } }));
  assert.equal(result.status, 'queued'); assert.deepEqual(f.calls.send[1], original);
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.get.length, 1);
});

test('a completed task is reused with fresh revision and each account has its own mapping', async () => {
  const f = fixture(), m = f.manager();
  const a = await m.diagnose(input()); f.runs.get(a.runId).status = 'completed'; f.revision(9);
  const b = await m.diagnose(input());
  assert.equal(a.taskId, b.taskId); assert.notEqual(a.runId, b.runId);
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.send[1].expectedRevision, 9);
  await m.diagnose(input({ login: 'ALICE', owner: 'ACME', repo: 'PROJECT' })); assert.equal(f.calls.create.length, 1);
  await m.diagnose(input({ login: 'Bob' })); assert.equal(f.calls.create.length, 2);
  assert.ok(f.data().tasks['bob|acme/project#12']);
});

test('stable panel action ID survives main restart after completed delivery; a new action starts a new analysis', async () => {
  const f = fixture(); const request = input({ actionId: 'panel-action-1' });
  const first = await f.manager().diagnose(request);
  f.runs.get(first.runId).status = 'completed'; await f.manager().statuses();
  const replayed = await f.manager().diagnose(request);
  assert.equal(replayed.runId, first.runId); assert.equal(replayed.status, 'completed');
  assert.equal(f.calls.send.length, 1); assert.equal(f.data().tasks[key].actionId, 'panel-action-1');
  const next = await f.manager().diagnose(input({ actionId: 'panel-action-2' }));
  assert.notEqual(next.runId, first.runId); assert.equal(f.calls.create.length, 1); assert.equal(f.calls.send.length, 2);
});

test('a definite revision conflict refreshes once, never recreates, and preserves the message key', async () => {
  const f = fixture();
  f.hooks.send = async payload => {
    if (f.calls.send.length === 1) { f.revision(5); throw err('REVISION_CONFLICT'); }
    return { runId: 'accepted', taskId: payload.taskId, status: 'running' };
  };
  const result = await f.manager().diagnose(input());
  assert.equal(result.status, 'running'); assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.send[1].expectedRevision, 5);
  assert.equal(f.calls.send[0].requestKey, f.calls.send[1].requestKey);
  assert.equal(f.calls.send[0].text, f.calls.send[1].text);
});

test('permission rejection does not send or replace the task; unsupported hosts fail capability detection', async () => {
  const f = fixture(); f.hooks.create = async () => { throw err('PERMISSION_DENIED'); };
  await assert.rejects(f.manager().diagnose(input()), { code: 'PERMISSION_DENIED' });
  assert.equal(f.calls.send.length, 0); assert.equal(f.data().tasks[key].pending.phase, 'create');
  f.tasks.getRun = undefined;
  assert.equal((await f.manager().capabilities()).available, false);
  await assert.rejects(f.manager().diagnose(input()), { code: 'TASKS_UNAVAILABLE' });
  assert.equal(f.calls.create.length, 1);
});

test('unavailable model is a definite failure with recovery guidance and keeps the original creation key', async () => {
  const f = fixture();
  f.hooks.create = async () => { throw err('ROUTE_UNAVAILABLE'); };
  await assert.rejects(f.manager().diagnose(input()), error => error.code === 'ROUTE_UNAVAILABLE' && /选择可用模型/.test(error.message));
  assert.equal(f.data().tasks[key].status, 'failed'); assert.equal(f.calls.send.length, 0);
  const pending = clone(f.data().tasks[key].pending);
  delete f.hooks.create;
  const result = await f.manager().diagnose(input());
  assert.equal(result.status, 'queued'); assert.deepEqual(f.calls.create[0], f.calls.create[1]);
  assert.equal(f.calls.send[0].requestKey, pending.sendDraft.requestKey);
});

test('known send rejection retains the exact request and task without claiming an unknown receipt', async () => {
  for (const code of ['ROUTE_UNAVAILABLE', 'IDEMPOTENCY_CONFLICT', 'INVALID_REQUEST', 'INVALID_INVOCATION', 'STALE_REVISION']) {
    const f = fixture();
    f.hooks.send = async () => { throw err(code); };
    await assert.rejects(f.manager().diagnose(input()), { code });
    const stored = f.data().tasks[key];
    assert.equal(stored.status, 'failed'); assert.equal(stored.taskId, 'task-1');
    assert.deepEqual(stored.pending.payload, f.calls.send[0]);
    assert.doesNotMatch(stored.reason, /回执尚未确认/);
    if (code === 'ROUTE_UNAVAILABLE') assert.match(stored.reason, /任务列表打开该任务并选择可用模型/);
    if (code === 'IDEMPOTENCY_CONFLICT') assert.match(stored.reason, /已停止派发/);
    await assert.rejects(f.manager().diagnose(input()), { code });
    assert.equal(f.calls.create.length, 1); assert.deepEqual(f.calls.send[0], f.calls.send[1]);
  }
});

test('storage failure prevents side effects at every preflight; post-send failure keeps a replayable receipt', async () => {
  for (const failAt of [1, 2, 3, 4]) {
    const f = fixture(); f.failAt(failAt);
    await assert.rejects(f.manager().diagnose(input()), { code: 'TEST_STORAGE_FAILURE' });
    assert.equal(f.calls.send.length, failAt === 4 ? 1 : 0);
    assert.equal(f.calls.create.length, failAt === 1 ? 0 : 1);
    if (failAt === 4) {
      f.failAt(-1); const result = await f.manager().diagnose(input());
      assert.deepEqual(f.calls.send[0], f.calls.send[1]); assert.equal(result.runId, 'run-1');
      assert.equal(f.runs.size, 1);
    }
  }
});

test('returned failed and reconciling runs are not reported as successful delivery', async () => {
  for (const status of ['failed', 'reconciling']) {
    const f = fixture();
    f.hooks.send = async payload => ({ taskId: payload.taskId, runId: 'special', status, error: 'dispatch failed' });
    const result = await f.manager().diagnose(input());
    assert.equal(result.status, status); assert.ok(result.reason);
    assert.equal(result.pending, status === 'reconciling');
    if (status === 'reconciling') {
      await f.manager().diagnose(input()); assert.deepEqual(f.calls.send[0], f.calls.send[1]);
    }
  }
});

test('status refresh isolates individual failures and cannot clear a new unresolved send', async () => {
  const f = fixture(), m = f.manager();
  const a = await m.diagnose(input()); const b = await m.diagnose(input({ number: 13 }));
  f.hooks.getRun = async ({ runId }) => { if (runId === a.runId) throw err('HOST_NOT_READY'); return { ...f.runs.get(runId), status: 'completed' }; };
  const statuses = await m.statuses();
  assert.ok(statuses[key].reason); assert.equal(statuses['alice|acme/project#13'].status, 'completed');
  assert.equal(f.calls.send.length, 2);
  delete f.hooks.getRun; f.runs.get(a.runId).status = 'completed';
  f.hooks.send = async () => { throw err('DELIVERY_UNCERTAIN'); };
  await m.diagnose(input());
  const pending = clone(f.data().tasks[key].pending);
  assert.equal(f.data().tasks[key].runId, undefined);
  await m.statuses(); assert.deepEqual(f.data().tasks[key].pending, pending);
  assert.ok(b.runId);
});

test('diagnostic message keeps current SHA and nested failed steps/annotations within 8 KiB', async () => {
  const f = fixture(); const request = input();
  request.diagnostics.jobs = [{ name: 'workflow', items: [{ name: 'linux', conclusion: 'failure', steps: [{ name: 'Install', number: 1, conclusion: 'success' }, { name: 'Run tests', number: 2, conclusion: 'failure' }] }] }];
  request.diagnostics.annotations = [{ name: 'lint', items: [{ path: 'src/a.js', startLine: 7, message: 'lint failed', level: 'failure' }] }];
  request.diagnostics.jobs[0].items.unshift(...Array.from({ length: 8 }, () => ({ name: 'passed', conclusion: 'success', steps: [] })));
  await f.manager().diagnose(request);
  const text = f.calls.send[0].text;
  assert.match(text, /只读诊断/); assert.match(text, /不可信的外部数据/); assert.match(text, /Run tests/); assert.match(text, /lint failed/); assert.ok(text.includes(sha));
  assert.ok(!text.includes('Install'));
  const large = input({ number: 14 }); large.diagnostics.annotations = [{ items: Array.from({ length: 50 }, () => ({ message: '错'.repeat(2000), path: '路径'.repeat(300) })) }];
  await f.manager().diagnose(large);
  assert.ok(Buffer.byteLength(f.calls.send[1].text) <= 8192); assert.match(f.calls.send[1].text, /"truncated":true/);
});

test('invalid diagnostics and full KV reject before creation without overwriting existing records', async () => {
  const f = fixture({ settings: { existing: 'x'.repeat(65500) } }); const original = f.data();
  await assert.rejects(f.manager().diagnose(input()), { code: 'STORAGE_LIMIT' });
  assert.equal(f.calls.create.length, 0); assert.deepEqual(f.data(), original);
  const g = fixture();
  await assert.rejects(g.manager().diagnose(input({ diagnostics: {} })), { code: 'MISSING_HEAD_SHA' });
  assert.equal(g.calls.create.length, 0);
});

test('individual text fields and nested list limits disclose truncation even below 8 KiB', async () => {
  for (const kind of ['text', 'steps', 'errors']) {
    const f = fixture(); const request = input();
    if (kind === 'text') request.diagnostics.ci.checks[0].output = { summary: 'x'.repeat(251) };
    if (kind === 'steps') request.diagnostics.jobs = [{ items: [{ name: 'test', conclusion: 'failure', steps: Array.from({ length: 7 }, () => ({ name: 'failed', conclusion: 'failure' })) }] }];
    if (kind === 'errors') request.diagnostics.errors = Array.from({ length: 5 }, () => ({ message: 'unavailable' }));
    await f.manager().diagnose(request);
    const text = f.calls.send[0].text;
    assert.ok(Buffer.byteLength(text) < 8192); assert.match(text, /"truncated":true/);
  }
});

test('archived or deleted existing task is not silently replaced', async () => {
  const f = fixture(), m = f.manager(); const a = await m.diagnose(input());
  f.runs.get(a.runId).status = 'completed'; f.hooks.get = async () => ({ taskId: a.taskId, status: 'archived', revision: 9 });
  await assert.rejects(m.diagnose(input()), { code: 'TASK_BUSY' });
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.send.length, 1);
  assert.equal(f.data().tasks[key].taskId, a.taskId);
});
