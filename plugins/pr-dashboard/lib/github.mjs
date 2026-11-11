/** Read-only GitHub REST adapter. All external text remains untrusted plain data.
 * request is supplied by the host and owns authentication; this module never reads secrets.
 * REST contracts: docs.github.com/en/rest/{search/search,checks/runs,commits/statuses,
 * actions/workflow-runs,actions/workflow-jobs}. No logs/archive redirects are followed.
 */
const API = 'https://api.github.com';
const PER_PAGE = 100;
const FAILURES = new Set(['failure', 'error', 'timed_out', 'action_required', 'cancelled', 'stale', 'startup_failure']);
const PENDING = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested', 'expected']);
const MAX_ANNOTATION_CHECKS = 6;
const MAX_JOB_RUNS = 4;

export class GitHubError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    Object.assign(this, details);
  }
}

function invalid(message) { throw new GitHubError('INVALID_ARGUMENT', message); }
function identifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value) || value === '.' || value === '..') invalid(`Invalid ${name}`);
  return encodeURIComponent(value);
}
function positive(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) invalid(`Invalid ${name}`);
  return value;
}
function repoPath({ owner, repo }) { return `/repos/${identifier(owner, 'owner')}/${identifier(repo, 'repo')}`; }
function shaValue(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/i.test(value)) invalid('Invalid commit SHA');
  return value;
}
function header(headers, name) {
  if (headers && typeof headers.get === 'function') return headers.get(name);
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
}
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function total(value) {
  const result = count(value);
  if (result === null) throw new GitHubError('INVALID_RESPONSE', 'Missing GitHub total_count');
  return result;
}
function text(value) { return typeof value === 'string' ? value : ''; }
function bridgeMessage(response) {
  // Match known host conditions, but never echo arbitrary transport messages:
  // they may contain private URLs, credential labels or lower-level diagnostics.
  const message = text(response?.message);
  const code = text(response?.errorCode);
  if (/gh auth login|未检测到本机\s*gh\s*登录|尚未配置备用 Personal Access Token/i.test(message)) {
    return '未检测到可用的 GitHub 登录。请先在本机运行 gh auth login，或在 Cindy「插件」的本插件详情页配置备用 PAT，然后重新刷新。';
  }
  if (/尚未批准|安装身份待确认/.test(message)) return 'Cindy 尚未批准本插件或安装身份待确认。请在插件详情检查安装状态和权限后重新刷新。';
  if (/大响应通道正忙/.test(message)) return 'Cindy 正在读取其他大响应，请稍后重新刷新。';
  if (/TIMEOUT|ETIMEDOUT/i.test(code) || /请求超时|连接超时/.test(message)) return '连接 GitHub 超时，请检查网络后重新刷新。';
  if (/PERMISSION_DENIED|NETWORK_DENIED/i.test(code)) return 'Cindy 未允许此次 GitHub 请求，请在插件详情检查启用状态和网络权限后重试。';
  return 'Cindy 未能完成 GitHub 请求，请检查网络连接和插件状态后重试。若尚未连接 GitHub，请先运行 gh auth login，或在插件详情配置备用 PAT。';
}
function httpMessage(code, status) {
  if (code === 'RATE_LIMITED') return 'GitHub 请求过于频繁，请等待限流恢复后重新刷新。';
  if (code === 'UNAUTHORIZED') return 'GitHub 登录已失效或凭证无效。请重新运行 gh auth login，或在插件详情更新备用 PAT，然后刷新。';
  if (code === 'FORBIDDEN') return 'GitHub 拒绝访问。请检查该账号的仓库访问权限、组织 SSO 授权及所需读取权限，然后重试。';
  if (code === 'NOT_FOUND') return '未找到该 GitHub 资源，或当前账号没有访问权限。请确认仓库、PR 和登录账号。';
  if (status >= 500) return `GitHub 服务暂时不可用（HTTP ${status}），请稍后重试。`;
  return `GitHub 请求失败（HTTP ${status}），请检查所选资源后重试。`;
}
function webUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}
function pagination({ page, perPage, length, totalCount = null, headers, cap = Infinity }) {
  const link = header(headers, 'link');
  const linkedNext = typeof link === 'string' && /;\s*rel\s*=\s*"?next"?/i.test(link);
  const hasMore = page * perPage < cap && (linkedNext || (totalCount !== null ? page * perPage < totalCount : length === perPage));
  return { page, perPage, totalCount, hasMore, nextPage: hasMore ? page + 1 : null };
}
function summaryError(error, source) {
  return { source, code: error?.code || 'UNKNOWN_ERROR', message: error?.message || 'Request failed',
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(error?.retryAfter ? { retryAfter: error.retryAfter } : {}),
    ...(error?.rateLimitReset ? { rateLimitReset: error.rateLimitReset } : {}) };
}
function array(value, key) {
  const result = key ? value?.[key] : value;
  if (!Array.isArray(result)) throw new GitHubError('INVALID_RESPONSE', `Expected ${key || 'an array'} in GitHub response`);
  return result;
}
function ciState(status, conclusion) {
  if (PENDING.has(status)) return 'pending';
  const result = conclusion || status;
  if (FAILURES.has(result)) return result === 'cancelled' ? 'cancelled' : 'failure';
  if (result === 'success') return 'success';
  if (result === 'neutral' || result === 'skipped') return result;
  return 'unknown';
}
function checkItem(item) {
  return { id: item.id, name: text(item.name), status: text(item.status), conclusion: item.conclusion ?? null,
    state: ciState(item.status, item.conclusion), url: webUrl(item.html_url) || webUrl(item.details_url),
    startedAt: item.started_at ?? null, completedAt: item.completed_at ?? null,
    app: text(item.app?.slug), annotationCount: count(item.output?.annotations_count),
    output: { title: text(item.output?.title), summary: text(item.output?.summary), text: text(item.output?.text) } };
}
function statusItem(item) {
  return { id: item.id, name: text(item.context), context: text(item.context), state: ciState(item.state),
    status: text(item.state), description: text(item.description), url: webUrl(item.target_url),
    createdAt: item.created_at ?? null, updatedAt: item.updated_at ?? null };
}
function aggregateCI(checks, statuses, partial, combinedState) {
  const states = [...checks, ...statuses].map(item => item.state);
  if (states.some(state => state === 'failure' || state === 'cancelled') || combinedState === 'failure') return 'failure';
  // Missing pages or a failed endpoint must never turn observed successes into a green badge.
  if (partial || states.includes('unknown')) return 'unknown';
  if (states.length === 0) return 'no_checks';
  if (states.includes('pending') || (statuses.length > 0 && combinedState === 'pending')) return 'pending';
  if (states.every(state => state === 'success')) return 'success';
  // Neutral/skipped are preserved on each item; they are not evidence that CI passed.
  return 'unknown';
}
function searchItem(item) {
  let owner, repo;
  try {
    const u = new URL(item.repository_url);
    const match = u.origin === API && /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (match) [, owner, repo] = match;
  } catch { /* Bad server item is rejected below rather than producing a bogus API target. */ }
  if (!owner || !repo || !item.pull_request || !Number.isSafeInteger(item.number)) throw new GitHubError('INVALID_RESPONSE', 'Search returned an invalid pull request');
  return { id: item.id, owner, repo, number: item.number, title: text(item.title), url: webUrl(item.html_url),
    state: text(item.state), draft: item.draft === true, author: text(item.user?.login),
    updatedAt: item.updated_at ?? null, createdAt: item.created_at ?? null,
    labels: Array.isArray(item.labels) ? item.labels.map(label => text(label?.name)).filter(Boolean) : [] };
}

export function createGitHubClient({ request }) {
  if (typeof request !== 'function') invalid('request must be a function');
  let active = 0;
  const queue = [];
  async function limited(fn) {
    if (active >= 2) await new Promise(resolve => queue.push(resolve));
    else active += 1;
    try { return await fn(); }
    finally { const next = queue.shift(); if (next) next(); else active -= 1; }
  }
  async function get(path, query = {}) {
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return limited(async () => {
      let response;
      try { response = await request({ url: url.href, method: 'GET', as: 'text', timeoutMs: 30000,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }); }
      catch { throw new GitHubError('BRIDGE_ERROR', '连接 GitHub 失败，请检查网络连接和插件启用状态后重新刷新。'); }
      if (response?.ok !== true) throw new GitHubError('BRIDGE_ERROR', bridgeMessage(response),
        { bridgeCode: typeof response?.errorCode === 'string' ? response.errorCode : null });
      const status = response.status;
      if (!Number.isInteger(status)) throw new GitHubError('INVALID_RESPONSE', 'Cindy 返回的 GitHub 响应缺少 HTTP 状态，请重新刷新。');
      const details = { status, retryAfter: header(response.headers, 'retry-after'), rateLimitReset: header(response.headers, 'x-ratelimit-reset') };
      if (status < 200 || status >= 300) {
        const rateLimited = status === 429 || (status === 403 && (header(response.headers, 'x-ratelimit-remaining') === '0' || details.retryAfter));
        const code = rateLimited ? 'RATE_LIMITED' : status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
        throw new GitHubError(code, httpMessage(code, status), { ...details, truncated: response.truncated === true });
      }
      if (response.truncated === true) throw new GitHubError('TRUNCATED_RESPONSE', 'GitHub 响应超过宿主大小限制，内容已截断，当前结果不完整。请在 GitHub 查看完整结果。', details);
      if (typeof response.body !== 'string') throw new GitHubError('INVALID_RESPONSE', 'GitHub 未返回预期的 JSON 文本，请重新刷新。', details);
      let data;
      try { data = JSON.parse(response.body); }
      catch { throw new GitHubError('INVALID_JSON', 'GitHub 响应不是有效 JSON，请检查网络或代理后重新刷新。', details); }
      return { data, headers: response.headers || {} };
    });
  }

  async function getViewer() {
    const { data } = await get('/user');
    if (!data || typeof data.login !== 'string' || !data.login) throw new GitHubError('INVALID_RESPONSE', 'Missing GitHub viewer login');
    return { login: data.login, id: data.id, avatarUrl: webUrl(data.avatar_url), url: webUrl(data.html_url) };
  }
  async function listPullRequests({ login, kind, page = 1, perPage = 20 }) {
    identifier(login, 'login'); positive(page, 'page'); positive(perPage, 'perPage', 100);
    if (!['authored', 'review'].includes(kind)) invalid('kind must be authored or review');
    if ((page - 1) * perPage >= 1000) invalid('GitHub search exposes at most 1000 results');
    const { data, headers } = await get('/search/issues', { q: `is:pr is:open ${kind === 'authored' ? 'author' : 'review-requested'}:${login}`, sort: 'updated', order: 'desc', per_page: perPage, page });
    const items = array(data, 'items').map(searchItem);
    const totalCount = count(data.total_count);
    if (totalCount === null || typeof data.incomplete_results !== 'boolean') throw new GitHubError('INVALID_RESPONSE', 'Missing GitHub search completeness metadata');
    return { items, ...pagination({ page, perPage, length: items.length, totalCount, headers, cap: 1000 }),
      incomplete: data.incomplete_results, searchLimitReached: totalCount > 1000 };
  }
  async function getPullRequest({ owner, repo, number }) {
    const path = repoPath({ owner, repo }); positive(number, 'pull request number');
    const { data } = await get(`${path}/pulls/${number}`);
    if (data?.number !== number || typeof data.head?.sha !== 'string') throw new GitHubError('INVALID_RESPONSE', 'Missing pull request identity or head SHA');
    shaValue(data.head.sha);
    return { owner, repo, number, id: data.id, title: text(data.title), url: webUrl(data.html_url),
      state: text(data.state), draft: data.draft === true, author: text(data.user?.login),
      headSha: data.head.sha, headRef: text(data.head.ref), headRepo: text(data.head.repo?.full_name),
      baseRef: text(data.base?.ref), body: text(data.body), updatedAt: data.updated_at ?? null,
      merged: data.merged === true, mergeable: typeof data.mergeable === 'boolean' ? data.mergeable : null,
      mergeableState: text(data.mergeable_state), mergeCommitSha: data.merge_commit_sha ?? null,
      additions: count(data.additions), deletions: count(data.deletions), changedFiles: count(data.changed_files) };
  }
  async function getCI({ owner, repo, sha, checkPage = 1, statusPage = 1 }) {
    const base = repoPath({ owner, repo }); shaValue(sha); positive(checkPage, 'checkPage'); positive(statusPage, 'statusPage');
    const results = await Promise.allSettled([
      get(`${base}/commits/${sha}/check-runs`, { filter: 'latest', per_page: PER_PAGE, page: checkPage }),
      get(`${base}/commits/${sha}/status`, { per_page: PER_PAGE, page: statusPage }),
    ]);
    const errors = []; let checks = [], statuses = [], combinedState = null;
    const pages = { checks: null, statuses: null };
    for (let i = 0; i < results.length; i += 1) {
      const name = i === 0 ? 'checks' : 'statuses';
      const result = results[i];
      if (result.status === 'rejected') { errors.push(summaryError(result.reason, name)); continue; }
      try {
        const { data, headers } = result.value;
        const items = array(data, i === 0 ? 'check_runs' : 'statuses');
        const totalCount = total(data.total_count);
        if (i === 1 && !['success', 'pending', 'failure'].includes(data.state)) throw new GitHubError('INVALID_RESPONSE', 'Missing combined commit status');
        pages[name] = pagination({ page: i === 0 ? checkPage : statusPage, perPage: PER_PAGE, length: items.length, totalCount, headers });
        if (i === 0) checks = items.map(checkItem);
        else { statuses = items.map(statusItem); combinedState = data.state ?? null; }
      } catch (error) { errors.push(summaryError(error, name)); }
    }
    const partial = errors.length > 0 || Object.values(pages).some(page => page?.hasMore || page?.page > 1);
    return { sha, state: aggregateCI(checks, statuses, partial, combinedState), checks, statuses, errors, partial, pagination: pages };
  }
  async function getDiagnostics({ owner, repo, number }) {
    const pullRequest = await getPullRequest({ owner, repo, number });
    const ci = await getCI({ owner, repo, sha: pullRequest.headSha });
    const base = repoPath({ owner, repo });
    const errors = [...ci.errors]; const annotations = [], jobs = [];
    const failedChecks = ci.checks.filter(item => item.state === 'failure' || item.state === 'cancelled');
    const chosenChecks = failedChecks.slice(0, MAX_ANNOTATION_CHECKS);
    const pages = { workflows: null, annotations: [], jobs: [] };
    let omittedRuns = 0;
    const annotationWork = chosenChecks.map(async check => {
      try {
        positive(check.id, 'check run id');
        const { data, headers } = await get(`${base}/check-runs/${check.id}/annotations`, { per_page: PER_PAGE, page: 1 });
        const items = array(data).map(item => ({ path: text(item.path), startLine: item.start_line ?? null,
          endLine: item.end_line ?? null, level: text(item.annotation_level), title: text(item.title),
          message: text(item.message), rawDetails: text(item.raw_details) }));
        const page = pagination({ page: 1, perPage: PER_PAGE, length: items.length, totalCount: check.annotationCount, headers });
        annotations.push({ checkRunId: check.id, name: check.name, items, pagination: page });
        pages.annotations.push({ checkRunId: check.id, ...page });
      } catch (error) { errors.push(summaryError(error, `annotations:${check.id}`)); }
    });
    const actionsWork = (async () => {
      try {
        const { data, headers } = await get(`${base}/actions/runs`, { head_sha: pullRequest.headSha, per_page: PER_PAGE, page: 1 });
        const runs = array(data, 'workflow_runs');
        pages.workflows = pagination({ page: 1, perPage: PER_PAGE, length: runs.length, totalCount: total(data.total_count), headers });
        // The newest run for a workflow/event supersedes earlier attempts on the same head.
        const latest = new Map();
        for (const run of [...runs].sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || '') || b.id - a.id)) {
          if (run.head_sha !== pullRequest.headSha) continue;
          const key = `${run.workflow_id ?? run.id}:${run.event ?? ''}`;
          if (!latest.has(key)) latest.set(key, run);
        }
        const failed = [...latest.values()].filter(run => FAILURES.has(run.conclusion));
        omittedRuns = Math.max(0, failed.length - MAX_JOB_RUNS);
        await Promise.all(failed.slice(0, MAX_JOB_RUNS).map(async run => {
          try {
            positive(run.id, 'workflow run id');
            const result = await get(`${base}/actions/runs/${run.id}/jobs`, { filter: 'latest', per_page: PER_PAGE, page: 1 });
            const items = array(result.data, 'jobs').map(job => ({ id: job.id, name: text(job.name),
              status: text(job.status), conclusion: job.conclusion ?? null, url: webUrl(job.html_url),
              startedAt: job.started_at ?? null, completedAt: job.completed_at ?? null,
              steps: Array.isArray(job.steps) ? job.steps.map(step => ({ name: text(step.name), number: step.number,
                status: text(step.status), conclusion: step.conclusion ?? null, startedAt: step.started_at ?? null, completedAt: step.completed_at ?? null })) : [] }));
            const page = pagination({ page: 1, perPage: PER_PAGE, length: items.length, totalCount: total(result.data.total_count), headers: result.headers });
            jobs.push({ runId: run.id, name: text(run.name), url: webUrl(run.html_url), items, pagination: page });
            pages.jobs.push({ runId: run.id, ...page });
          } catch (error) { errors.push(summaryError(error, `jobs:${run.id}`)); }
        }));
      } catch (error) { errors.push(summaryError(error, 'workflows')); }
    })();
    await Promise.all([...annotationWork, actionsWork]);
    annotations.sort((a, b) => a.checkRunId - b.checkRunId); jobs.sort((a, b) => a.runId - b.runId);
    const omitted = { annotationChecks: Math.max(0, failedChecks.length - MAX_ANNOTATION_CHECKS), workflowRuns: omittedRuns };
    const partial = ci.partial || errors.length > 0 || Object.values(omitted).some(Boolean) ||
      pages.workflows?.hasMore === true || [...pages.annotations, ...pages.jobs].some(page => page.hasMore);
    return { pullRequest, ci, annotations, jobs, errors, partial, pagination: pages, omitted,
      limits: { annotationChecks: MAX_ANNOTATION_CHECKS, workflowRuns: MAX_JOB_RUNS, itemsPerPage: PER_PAGE } };
  }
  return { getViewer, listPullRequests, getPullRequest, getCI, getDiagnostics };
}
