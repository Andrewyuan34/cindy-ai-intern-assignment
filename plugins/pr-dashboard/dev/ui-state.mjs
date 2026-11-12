// Development-only visual scenarios. No GitHub requests, model calls or runtime packages.
const CHANNEL = 'cindy-pr-dashboard-v1';
const HELP = {
  normal: '四张卡分别展示失败、通过、运行中和暂无检查。点击分析后手动刷新，可查看完成态并重新分析；导航仅模拟回执。',
  loading: '固定在列表更新与检查读取中，不会自动结束。切换场景或点击“重置当前场景”退出。',
  partial: '固定模拟一个检查端点返回 403：保留已读证据，同时显示信息不完整；已观察到的失败仍为失败。',
  'auth-error': '固定模拟 GitHub 登录失效，检视连接引导与可操作的错误说明；刷新不会隐藏错误。',
  needs_input: '人工构造 needs_input，仅用于检查提示、菜单和布局；不代表当前 Cindy 任务接口已支持或自动检测此状态。',
  'handoff-error': '固定展示已有任务交接失败与未创建任务的失败。保留权限原因及重试入口；点击重试仍返回同一模拟错误。',
};
const rows = [
  [42, '修复插件重启后的任务关联', 'cindy-example', 'failure'],
  [39, '完善深色主题下的设置页', 'cindy-example', 'success'],
  [28, '增加 PR 检查结果的分页提示', 'pr-dashboard', 'pending'],
  [17, '更新贡献指南与开发环境说明', 'docs', 'no_checks'],
];
const copy = value => structuredClone(value);
const keyOf = item => `${item.owner}/${item.repo}#${item.number}`.toLowerCase();

export function scenarioSnapshot(scenario, now = Date.now()) {
  const items = rows.map(([number, title, repo, state]) => ({
    owner: 'example', repo, number, title, author: 'example', draft: number === 17,
    url: `https://github.com/example/${repo}/pull/${number}`,
    headSha: 'a'.repeat(38) + String(number),
    ci: { state, partial: false, errors: [], statuses: [], checks: state === 'no_checks' ? [] : [{
      id: number, name: 'test / node-22', state, status: state === 'pending' ? 'in_progress' : 'completed',
      conclusion: state === 'pending' ? null : state,
      url: `https://github.com/example/${repo}/actions/runs/${number}`,
    }] },
  }));
  const list = entries => ({ items: entries, totalCount: entries.length, page: 1, hasMore: false, loading: false, error: null, updatedAt: now, incomplete: false });
  const state = { viewer: { login: 'example' }, activeKind: 'authored', lists: { authored: list(items), review: list([copy(items[0])]) }, taskSupport: { available: true, reason: '' }, diagnoses: {}, error: null };
  if (scenario === 'loading') {
    for (const value of Object.values(state.lists)) {
      value.loading = true;
      value.updatedAt = null;
      for (const item of value.items) item.ci = { state: 'loading', checks: [], statuses: [], errors: [], partial: false };
    }
  } else if (scenario === 'partial') {
    for (const value of Object.values(state.lists)) for (const item of value.items.slice(0, 2)) {
      item.ci.partial = true;
      if (item.ci.state !== 'failure') item.ci.state = 'unknown';
      item.ci.errors = [{ source: 'statuses', code: 'FORBIDDEN', status: 403, message: '无法读取提交状态（403）。请检查 GitHub 仓库权限或组织授权；当前结果不完整。' }];
    }
  } else if (scenario === 'auth-error') {
    state.viewer = null;
    state.error = 'GitHub 登录已失效，请在插件设置中重新连接，或更新备用 PAT 后刷新。';
    for (const kind of ['authored', 'review']) state.lists[kind] = { ...list([]), totalCount: null, updatedAt: null, error: state.error };
  } else if (scenario === 'needs_input') {
    state.diagnoses[keyOf(items[0])] = { taskId: 'demo-task-42', runId: 'demo-run-42', busy: false, pending: false, status: 'needs_input', reason: '需要你在诊断任务中处理请求。（仅界面模拟）' };
  } else if (scenario === 'handoff-error') {
    state.diagnoses[keyOf(items[0])] = { taskId: 'demo-task-42', busy: false, pending: true, status: 'failed', error: 'Cindy 未允许此次任务操作。请检查插件与任务权限；原任务关联已保留。' };
    state.diagnoses[keyOf(items[1])] = { busy: false, pending: true, status: 'failed', error: '诊断任务尚未创建：插件任务能力未获批准，请在 Cindy 中处理授权后重试。' };
  }
  return state;
}

function announce(type, details = {}) {
  if (typeof window !== 'undefined' && parent !== window) {
    parent.postMessage({ type, ...details }, parent.location.origin);
  }
}

export async function startFixtureHost(scenario) {
  if (!Object.hasOwn(HELP, scenario)) throw new Error('Unknown preview scenario');
  if (scenario === 'normal') {
    await import('./host.js');
    await import('../main.js');
    announce('pr-preview-ready', { scenario });
    return null;
  }
  const state = scenarioSnapshot(scenario);
  const channel = new BroadcastChannel(CHANNEL);
  const receipts = new Map();
  channel.addEventListener('message', ({ data: request }) => {
    if (request?.kind !== 'request' || typeof request.id !== 'string') return;
    if (receipts.has(request.id)) { channel.postMessage(copy(receipts.get(request.id))); return; }
    const response = { kind: 'response', id: request.id, ok: true };
    const payload = request.payload || {};
    if (['snapshot', 'refresh', 'loadMore', 'configChanged'].includes(request.action)) {
      if (['authored', 'review'].includes(payload.kind)) state.activeKind = payload.kind;
      response.data = copy(state);
    } else if (request.action === 'diagnose') {
      const record = state.diagnoses[keyOf(payload)];
      if (scenario === 'needs_input' && record) response.data = copy(record);
      else { response.ok = false; response.error = record?.error || '此场景固定展示当前状态；请切换“正常”场景体验模拟分析与重新分析。'; }
    } else if (request.action === 'openDiagnosis') {
      const record = state.diagnoses[keyOf(payload)];
      if (record?.taskId) {
        response.data = { taskId: record.taskId, focusRequested: true };
        announce('pr-preview-navigation', { taskId: record.taskId });
      } else { response.ok = false; response.error = '此模拟场景尚未创建诊断任务。'; }
    } else { response.ok = false; response.error = '此固定场景不执行该操作。'; }
    receipts.set(request.id, copy(response));
    if (receipts.size > 64) receipts.delete(receipts.keys().next().value);
    channel.postMessage(response);
  });
  announce('pr-preview-ready', { scenario });
  return channel;
}

function mountPreview() {
  const scene = document.getElementById('scenario');
  const width = document.getElementById('panel-width');
  const panel = document.getElementById('panel');
  const settings = document.getElementById('settings');
  const status = document.getElementById('preview-status');
  const hostContainer = document.getElementById('fixture-host');
  const params = new URLSearchParams(location.search);
  if (Object.hasOwn(HELP, params.get('scenario'))) scene.value = params.get('scenario');
  if (['320', '360', '420', '530'].includes(params.get('width'))) width.value = params.get('width');
  let generation = 0;
  let host;
  function saveOptions() {
    const url = new URL(location.href);
    url.searchParams.set('scenario', scene.value);
    url.searchParams.set('width', width.value);
    history.replaceState(null, '', url);
    document.documentElement.style.setProperty('--preview-width', `${width.value}px`);
  }
  async function reset() {
    const current = ++generation;
    saveOptions();
    document.getElementById('scenario-help').textContent = HELP[scene.value];
    status.textContent = '正在准备模拟宿主…';
    panel.src = 'about:blank';
    settings.src = 'about:blank';
    hostContainer.replaceChildren();
    host = null;
    try {
      // This endpoint belongs to the local fixture server; no real plugin KV is used.
      const resetResult = await fetch('/kv', { method: 'PUT', body: '{}' });
      if (resetResult.status !== 204) throw new Error('模拟存储重置失败，请确认正在使用本地预览服务器。');
      if (current !== generation) return;
      host = document.createElement('iframe');
      host.title = '模拟宿主';
      host.srcdoc = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">import { startFixtureHost } from '/dev/ui-state.mjs'; startFixtureHost(${JSON.stringify(scene.value)}).catch(error => parent.postMessage({type:'pr-preview-error',message:error.message}, parent.location.origin));<\/script></body></html>`;
      hostContainer.append(host);
    } catch (error) { if (current === generation) status.textContent = error.message; }
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== host?.contentWindow) return;
    if (event.data?.type === 'pr-preview-ready') {
      panel.src = `/panel.html?demo=${encodeURIComponent(scene.value)}`;
      settings.src = '/settings.html';
      status.textContent = scene.value === 'normal'
        ? '当前使用模拟 API 与任务；所有 PR 和结果均为演示数据。'
        : '固定界面样例：不会自动完成，也不会发出真实请求。';
    } else if (event.data?.type === 'pr-preview-navigation') {
      status.textContent = '已模拟接收“查看诊断”请求。本地预览不切换 Cindy 任务，原生导航须在 Cindy 中验证。';
    } else if (event.data?.type === 'pr-preview-error') status.textContent = `模拟宿主启动失败：${event.data.message}`;
  });
  scene.addEventListener('change', () => { void reset(); });
  width.addEventListener('change', saveOptions);
  document.getElementById('reset-scene').addEventListener('click', () => { void reset(); });
  void reset();
}

if (typeof document !== 'undefined' && document.getElementById('scenario')) mountPreview();
