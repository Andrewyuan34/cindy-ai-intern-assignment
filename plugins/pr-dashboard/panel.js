import { createRpc } from './lib/rpc.mjs';
import { icon } from './lib/icons.mjs';

const $ = (id) => document.getElementById(id);
const EMPTY_LIST = { items: [], totalCount: null, loading: false, hasMore: false };
const AUTO_REFRESH_GAP_MS = 30000;
let snapshot = { viewer: null, lists: {}, diagnoses: {}, taskSupport: { available: false } };
let activeKind = 'authored';
let hydrated = false;
let ready = false;
let lastAutoRefresh = -Infinity;
let localError = '';
const operations = new Set();
const localDiagnoses = new Map();
const openDetails = new Set();
const openMenus = new Set();
const openingTasks = new Set();
const navigationErrors = new Map();
const ACTIVE_DIAGNOSES = new Set(['queued', 'running', 'stopping']);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function errorText(error) {
  if (typeof error === 'string') return error;
  return error?.message || '';
}

function githubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

function link(label, url, className) {
  const safe = githubUrl(url);
  const element = node(safe ? 'a' : 'span', className, label);
  if (safe) {
    element.href = safe;
    element.rel = 'noopener noreferrer';
  }
  return element;
}

function acceptSnapshot(data) {
  if (!data || typeof data !== 'object' || !data.lists) return;
  if (snapshot.viewer?.login?.toLowerCase() !== data.viewer?.login?.toLowerCase()) {
    localDiagnoses.clear();
    navigationErrors.clear();
    openDetails.clear();
    openMenus.clear();
  }
  snapshot = data;
  if (!hydrated && ['authored', 'review'].includes(data.activeKind)) activeKind = data.activeKind;
  hydrated = true;
  for (const key of localDiagnoses.keys()) {
    if (data.diagnoses?.[key]) localDiagnoses.delete(key);
  }
  render();
}

const rpc = createRpc({ onSnapshot: acceptSnapshot });

function shortTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const day = date.toLocaleDateString('zh-CN', { ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }), month: 'numeric', day: 'numeric' });
  return `${day} ${time}`;
}

function focusMark(element, key) {
  element.dataset.focusKey = key;
  return element;
}

function restoreCardFocus(previous, key) {
  if (!key || previous?.isConnected || !document.hasFocus()) return;
  const target = [...$('pr-list').querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === key);
  if (!target) return;
  const menu = target.closest('.pr-more');
  const destination = menu && !menu.open ? menu.querySelector('summary') : target.disabled ? target.closest('.pr-card') : target;
  destination?.focus({ preventScroll: true });
}

function ciState(value) {
  const state = String(value || '').toLowerCase();
  if (state === 'loading') return ['pending', '读取中', 'loader-circle'];
  if (['success', 'passed', 'pass'].includes(state)) return ['success', '检查通过', 'circle-check'];
  if (['failure', 'failed', 'error', 'timed_out', 'action_required', 'startup_failure'].includes(state)) return ['failure', '检查失败', 'circle-x'];
  if (['pending', 'queued', 'in_progress', 'running', 'waiting', 'requested'].includes(state)) return ['pending', '检查中', 'clock-3'];
  if (['none', 'no_checks', 'empty'].includes(state)) return ['', '暂无检查', 'circle-minus'];
  if (['cancelled', 'canceled'].includes(state)) return ['', '已取消', 'circle-minus'];
  if (['neutral', 'skipped'].includes(state)) return ['', '已结束', 'circle-minus'];
  return ['unknown', '状态未知', 'circle-alert'];
}

function checkLabel(check) {
  const raw = check?.conclusion || check?.status || check?.state;
  const labels = { success: '通过', failure: '失败', error: '错误', pending: '等待', queued: '排队', in_progress: '进行中', completed: '已结束', cancelled: '已取消', canceled: '已取消', skipped: '已跳过', neutral: '中性', timed_out: '超时', action_required: '需处理', waiting: '等待' };
  return labels[String(raw || '').toLowerCase()] || (raw ? String(raw) : '未知');
}

function renderCi(ci = {}, key) {
  if (!ci || typeof ci !== 'object') ci = {};
  const details = node('div', 'ci-details');
  details.id = `ci-${encodeURIComponent(key)}`;
  details.hidden = !openDetails.has(key);
  const summary = focusMark(node('button', 'ci-toggle'), `${key}:ci`);
  summary.type = 'button';
  summary.setAttribute('aria-expanded', String(!details.hidden));
  summary.setAttribute('aria-controls', details.id);
  let [tone, label, symbol] = ciState(ci.state);
  if (ci.partial) {
    label = tone === 'failure' ? '检查失败 · 不完整' : '检查信息不全';
    if (tone !== 'failure') { tone = 'warning'; symbol = 'triangle-alert'; }
  }
  const badge = node('span', `ci-badge ${tone}`);
  badge.append(icon(symbol, ci.state === 'loading' ? 'is-spinning' : ''), node('span', '', label));
  summary.append(badge, icon('chevron-down', 'ci-chevron'));
  summary.title = '展开或收起检查明细';
  summary.addEventListener('click', () => {
    details.hidden = !details.hidden;
    summary.setAttribute('aria-expanded', String(!details.hidden));
    if (!details.hidden) openDetails.add(key); else openDetails.delete(key);
  });
  const checks = Array.isArray(ci.checks) ? ci.checks : [];
  const statuses = Array.isArray(ci.statuses) ? ci.statuses : [];
  const entries = [...checks, ...statuses].filter((entry) => entry && typeof entry === 'object');
  if (entries.length) {
    const list = node('ul', 'ci-items');
    for (const [index, check] of entries.entries()) {
      const row = node('li', 'ci-item');
      const checkLink = link(check.name || check.context || '未命名检查', check.html_url || check.details_url || check.detailsUrl || check.target_url || check.targetUrl || check.url);
      focusMark(checkLink, `${key}:check:${check.id ?? check.context ?? check.name ?? index}`);
      row.append(checkLink, node('span', 'ci-item-state', checkLabel(check)));
      list.append(row);
    }
    details.append(list);
  } else {
    details.append(node('p', 'ci-note', ci.state === 'loading' ? '正在读取最新提交的检查。' : '最新提交暂无可展示的检查明细。'));
  }
  if (ci.partial) details.append(node('p', 'ci-note', '检查信息不完整，当前状态可能尚未包含全部结果。'));
  const errors = Array.isArray(ci.errors) ? ci.errors : ci.errors ? [ci.errors] : [];
  for (const error of errors) {
    const text = errorText(error);
    if (text) details.append(node('p', 'ci-note', text));
  }
  return { summary, details };
}

function renderDiagnosis(record) {
  if (!record) return null;
  let text = '';
  if (record.busy) return null;
  else if (record.taskId) {
    if (record.error || record.reason) text = errorText(record.error || record.reason);
    else if (['needs_input', 'failed', 'interrupted', 'cancelled', 'canceled', 'reconciling'].includes(record.status)) text = `诊断${diagnosisStatus(record.status)}`;
    else return null;
  } else if (record.error) text = errorText(record.error) || '诊断请求未完成。';
  else if (record.status) text = `诊断状态：${diagnosisStatus(record.status)}`;
  else return null;
  const element = node('p', `diagnosis${record.error || record.reason || record.status === 'failed' ? ' is-error' : record.status === 'needs_input' || record.pending ? ' is-warning' : ''}`, text);
  element.setAttribute('role', 'status');
  return element;
}

function diagnosisStatus(value) {
  const labels = { created: '已创建', queued: '等待执行', pending: '等待执行', running: '正在执行', stopping: '正在停止', reconciling: '回执待确认', interrupted: '已中断', completed: '已完成', succeeded: '已完成', failed: '执行失败', cancelled: '已取消', canceled: '已取消', needs_input: '需要你的输入' };
  return labels[String(value).toLowerCase()] || String(value);
}

function renderCard(item) {
  const key = `${item.owner}/${item.repo}#${item.number}`.toLowerCase();
  const card = focusMark(node('article', 'pr-card'), `${key}:card`);
  card.tabIndex = -1;
  const head = node('div', 'pr-head');
  const content = node('div', 'pr-content');
  const meta = node('div', 'pr-meta');
  const repoPath = `${encodeURIComponent(item.owner || '')}/${encodeURIComponent(item.repo || '')}`;
  meta.append(focusMark(link(`${item.owner}/${item.repo}`, `https://github.com/${repoPath}`, 'repo-link'), `${key}:repo`), node('span', 'pr-number', `#${item.number}`));
  const heading = node('h2', 'pr-title');
  heading.append(focusMark(link(item.title || '未命名拉取请求', item.url), `${key}:title`));
  heading.firstChild.title = item.title || '未命名拉取请求';
  const author = typeof item.author === 'string' ? item.author : item.author?.login;
  if (activeKind === 'review' && author) meta.append(node('span', 'pr-author', `@${author}`));
  if (item.draft) meta.append(node('span', 'draft-badge', '草稿'));
  content.append(heading, meta);
  head.append(icon(item.draft ? 'git-pull-request-draft' : 'git-pull-request', 'pr-icon'), content);
  const footer = node('div', 'pr-footer');
  const ci = renderCi(item.ci, key);
  footer.append(ci.summary);
  const diagnosis = localDiagnoses.get(key) || snapshot.diagnoses?.[key];
  const busy = Boolean(diagnosis?.busy) || ACTIVE_DIAGNOSES.has(diagnosis?.status);
  const retry = diagnosis?.pending || diagnosis?.status === 'reconciling';
  const actions = node('div', 'pr-actions');
  if (diagnosis?.taskId && !retry) {
    const view = focusMark(node('button', 'view-button'), `${key}:view`);
    const opening = openingTasks.has(key);
    view.append(icon(opening || busy ? 'loader-circle' : 'message-square-text', opening || busy ? 'is-spinning' : ''), node('span', '', opening ? '正在打开' : busy ? '分析中' : '查看诊断'));
    view.type = 'button';
    view.disabled = opening;
    view.title = busy ? '打开任务，查看分析进度' : '打开此 PR 的诊断任务';
    view.addEventListener('click', () => { void openDiagnosis(item, key); });
    actions.append(view);
  }
  const label = diagnosis?.busy ? '正在交接' : busy ? '分析中' : retry ? '重试交接' : diagnosis?.taskId ? '重新分析' : '分析 CI';
  const secondary = diagnosis?.taskId && !retry;
  const button = focusMark(node('button', secondary ? 'menu-action' : 'analyze-button'), `${key}:analyze`);
  button.append(icon(busy ? 'loader-circle' : diagnosis?.taskId || retry ? 'rotate-ccw' : 'scan-search', busy ? 'is-spinning' : ''), node('span', '', label));
  button.type = 'button';
  button.disabled = busy || snapshot.taskSupport?.available !== true;
  button.title = snapshot.taskSupport?.available === true ? '将此 PR 交给 AI 诊断' : snapshot.taskSupport?.reason || '当前宿主尚未确认支持诊断任务';
  button.addEventListener('click', () => { closeMenus(); void diagnose(item, key); });
  const more = node('details', 'pr-more');
  more.dataset.prKey = key;
  more.open = openMenus.has(key);
  const moreToggle = focusMark(node('summary', 'icon-button'), `${key}:more`);
  moreToggle.title = '更多操作';
  moreToggle.setAttribute('aria-label', `PR #${item.number} 的更多操作`);
  moreToggle.append(icon('ellipsis-vertical'));
  moreToggle.addEventListener('click', (event) => {
    event.preventDefault();
    const next = !more.open;
    closeMenus();
    more.open = next;
    if (next) openMenus.add(key);
  });
  const menu = node('div', 'more-actions');
  if (secondary) menu.append(button); else actions.append(button);
  if (diagnosis?.taskId && retry) {
    const view = focusMark(node('button', 'menu-action'), `${key}:view`);
    view.type = 'button';
    view.disabled = openingTasks.has(key);
    view.append(icon('message-square-text'), node('span', '', '查看诊断'));
    view.addEventListener('click', () => { closeMenus(); void openDiagnosis(item, key); });
    menu.append(view);
  }
  const external = focusMark(link('', item.url, 'menu-action'), `${key}:external`);
  external.append(icon('external-link'), node('span', '', '在 GitHub 打开'));
  external.addEventListener('click', () => closeMenus());
  menu.append(external);
  more.append(moreToggle, menu);
  head.append(more);
  footer.append(actions);
  card.append(head, footer, ci.details);
  const status = renderDiagnosis(diagnosis);
  if (status) card.append(status);
  if (navigationErrors.has(key)) card.append(node('p', 'diagnosis is-error', navigationErrors.get(key)));
  return card;
}

function render() {
  const previouslyFocused = document.activeElement;
  const focusKey = previouslyFocused?.dataset?.focusKey;
  const list = snapshot.lists?.[activeKind] || EMPTY_LIST;
  const items = Array.isArray(list.items) ? list.items.filter((item) => item && typeof item === 'object') : [];
  const loading = !ready || Boolean(list.loading) || operations.has(activeKind);
  const currentError = localError || errorText(list.error) || errorText(snapshot.error);
  $('viewer').textContent = snapshot.viewer?.login ? `@${snapshot.viewer.login}` : hydrated ? '尚未连接 GitHub · 请在插件设置中登录' : '正在连接 GitHub…';
  $('viewer').parentElement.classList.toggle('is-connected', Boolean(snapshot.viewer?.login));
  for (const kind of ['authored', 'review']) {
    const tab = $(`tab-${kind}`);
    const selected = activeKind === kind;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const count = snapshot.lists?.[kind]?.totalCount;
    $(`count-${kind}`).textContent = Number.isFinite(count) ? String(count) : '—';
  }
  $('refresh').disabled = loading;
  $('refresh').classList.toggle('is-loading', loading);
  $('list-summary').textContent = loading ? (items.length ? '正在更新…' : '正在读取…') : `已显示 ${items.length} 条${Number.isFinite(list.totalCount) ? ` / 共 ${list.totalCount} 条` : ''}`;
  const time = shortTime(list.updatedAt);
  $('updated-at').textContent = loading && items.length ? '更新中…' : time ? `更新于 ${time}` : '';
  $('updated-at').title = time ? `上次成功更新：${time}` : '';
  if (time) $('updated-at').dateTime = new Date(list.updatedAt).toISOString();
  else $('updated-at').removeAttribute('datetime');
  $('error').textContent = currentError;
  $('error').hidden = !currentError;
  const notices = [];
  if (list.incomplete) notices.push('GitHub 返回的结果不完整，可稍后刷新。');
  if (snapshot.taskSupport?.available === false && snapshot.taskSupport.reason) notices.push(snapshot.taskSupport.reason);
  $('notice').textContent = notices.join(' ');
  $('notice').hidden = notices.length === 0;
  const container = $('pr-list');
  container.setAttribute('aria-labelledby', `tab-${activeKind}`);
  container.setAttribute('aria-busy', String(loading));
  if (items.length) container.replaceChildren(...items.map(renderCard));
  else {
    const empty = node('div', 'empty-state');
    const title = loading ? '正在读取拉取请求' : currentError ? '列表暂时不可用' : !snapshot.viewer ? '先连接 GitHub' : activeKind === 'authored' ? '没有打开的拉取请求' : '暂时没有待评审请求';
    empty.append(icon(loading ? 'loader-circle' : currentError ? 'circle-alert' : 'inbox', loading ? 'empty-icon is-spinning' : 'empty-icon'), node('strong', '', title));
    if (!loading && !currentError && !snapshot.viewer) empty.append(node('p', '', '请在插件设置中连接 GitHub。'));
    container.replaceChildren(empty);
  }
  $('load-more').hidden = !list.hasMore;
  $('load-more').disabled = loading;
  $('load-more').textContent = loading ? '正在加载…' : '加载更多';
  restoreCardFocus(previouslyFocused, focusKey);
}

async function refresh(reason, manual = false) {
  if (!ready || operations.has(activeKind)) return;
  if (!manual) {
    if (document.visibilityState === 'hidden' || Date.now() - lastAutoRefresh < AUTO_REFRESH_GAP_MS) return;
    lastAutoRefresh = Date.now();
  }
  const kind = activeKind;
  operations.add(kind);
  localError = '';
  render();
  try { acceptSnapshot(await rpc.request('refresh', { kind, reason })); }
  catch (error) { localError = errorText(error) || '刷新未完成。'; }
  finally { operations.delete(kind); render(); }
}

async function loadMore() {
  const kind = activeKind;
  if (operations.has(kind)) return;
  operations.add(kind);
  localError = '';
  render();
  try { acceptSnapshot(await rpc.request('loadMore', { kind })); }
  catch (error) { localError = errorText(error) || '加载未完成。'; }
  finally { operations.delete(kind); render(); }
}

async function diagnose(item, key) {
  const previous = localDiagnoses.get(key) || snapshot.diagnoses?.[key] || {};
  if (previous.busy || ACTIVE_DIAGNOSES.has(previous.status)) return;
  const login = snapshot.viewer?.login;
  navigationErrors.delete(key);
  localDiagnoses.set(key, { ...previous, busy: true, error: null });
  render();
  try {
    const result = await rpc.request('diagnose', { owner: item.owner, repo: item.repo, number: item.number });
    if (snapshot.viewer?.login !== login) return;
    if (result?.lists) acceptSnapshot(result);
    else if (result?.taskId || result?.status || result?.error) localDiagnoses.set(key, { ...result, error: result.error || result.reason, busy: false });
    else if (!snapshot.diagnoses?.[key]?.taskId) localDiagnoses.set(key, { busy: false, error: '未收到任务编号，尚不能确认诊断任务已创建。' });
    else localDiagnoses.delete(key);
  } catch (error) { if (snapshot.viewer?.login === login) localDiagnoses.set(key, { ...previous, busy: false, error: errorText(error) || '诊断请求未完成。' }); }
  render();
}

async function openDiagnosis(item, key) {
  if (openingTasks.has(key)) return;
  const login = snapshot.viewer?.login;
  openingTasks.add(key);
  navigationErrors.delete(key);
  // Send immediately from the click; RPC owns the short navigation deadline.
  const request = rpc.request('openDiagnosis', { owner: item.owner, repo: item.repo, number: item.number });
  render();
  try {
    const result = await request;
    if (!result?.taskId || result.focusRequested !== true) throw new Error('Cindy 尚未确认打开诊断。');
  } catch (error) {
    if (snapshot.viewer?.login === login) navigationErrors.set(key, `${errorText(error) || '未能打开诊断。'} 请再次点击“查看诊断”；也可在 Cindy 任务列表找到此 PR 的 CI 诊断。`);
  } finally { openingTasks.delete(key); render(); }
}

function selectKind(kind) {
  if (kind === activeKind) return;
  activeKind = kind;
  closeMenus();
  localError = '';
  render();
  // Selecting an uncached list is a user action, independent of focus deduping.
  if (!snapshot.lists?.[kind]?.updatedAt) void refresh('tab', true);
}
function closeMenus(restoreFocus = false) {
  for (const menu of document.querySelectorAll('.pr-more[open]')) {
    menu.open = false;
    if (restoreFocus && menu.contains(document.activeElement)) menu.querySelector('summary')?.focus({ preventScroll: true });
  }
  openMenus.clear();
}
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.pr-more')) closeMenus();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openMenus.size) { event.preventDefault(); closeMenus(true); }
});
document.addEventListener('focusin', (event) => {
  if (!event.target.closest('.pr-more')) closeMenus();
});
for (const kind of ['authored', 'review']) {
  $(`tab-${kind}`).addEventListener('click', () => selectKind(kind));
  $(`tab-${kind}`).addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 'authored' : event.key === 'End' ? 'review' : kind === 'authored' ? 'review' : 'authored';
    selectKind(target);
    $(`tab-${target}`).focus();
  });
}
$('refresh').addEventListener('click', () => { void refresh('manual', true); });
$('refresh').replaceChildren(icon('refresh-cw'));
$('load-more').addEventListener('click', () => { void loadMore(); });
let foregroundTimer;
function foregroundRefresh(reason) {
  // Let the click that focused the panel finish before replacing card nodes.
  clearTimeout(foregroundTimer);
  foregroundTimer = setTimeout(() => { void refresh(reason); }, 200);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') foregroundRefresh('visible');
});
window.addEventListener('focus', () => foregroundRefresh('focus'));
window.addEventListener('pagehide', () => { clearTimeout(foregroundTimer); rpc.close(); }, { once: true });

render();
try { acceptSnapshot(await rpc.request('snapshot')); }
catch (error) { localError = errorText(error) || '无法读取插件状态。'; render(); }
ready = true;
void refresh('open');
