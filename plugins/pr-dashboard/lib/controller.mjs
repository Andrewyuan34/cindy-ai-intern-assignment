const kinds = ['authored', 'review'];
const blankList = () => ({ items: [], totalCount: null, page: 0, hasMore: false, loading: false, error: null, updatedAt: null, incomplete: false });
export const prKey = ({ owner, repo, number }) => `${owner}/${repo}#${number}`.toLowerCase();
const errorText = error => String(error?.message || '操作失败，请重试。').slice(0, 500);

export function createController({ api, taskManager, openTaskView, onChange = () => {}, now = () => Date.now() }) {
  let generation = 0;
  let authPending;
  const pendingRefresh = new Map();
  const pendingDiagnosis = new Map();
  const state = {
    viewer: null, activeKind: 'authored',
    lists: { authored: blankList(), review: blankList() },
    taskSupport: { available: false, reason: '正在检查任务接口…' },
    diagnoses: {}, error: null,
  };
  const snapshot = () => structuredClone(state);
  const publish = () => onChange(snapshot());
  function checkKind(kind) {
    if (!kinds.includes(kind)) throw new Error('请选择“我创建的”或“待我审阅”。');
  }
  async function authenticate() {
    const startedAt = generation;
    if (!authPending) {
      const pending = api.getViewer().finally(() => { if (authPending === pending) authPending = null; });
      authPending = pending;
    }
    const viewer = await authPending;
    if (startedAt !== generation) throw new Error('账号配置已变化，请重新刷新。');
    if (state.viewer && state.viewer.login.toLowerCase() !== viewer.login.toLowerCase()) {
      generation++;
      state.lists = { authored: blankList(), review: blankList() };
      state.diagnoses = {};
      pendingDiagnosis.clear();
    }
    state.viewer = viewer;
    state.error = null;
    return viewer;
  }
  async function updateTaskStatuses() {
    const version = generation;
    const login = state.viewer?.login.toLowerCase();
    const support = await taskManager.capabilities();
    if (version !== generation) return;
    state.taskSupport = support;
    if (!login) return;
    const statuses = await taskManager.statuses();
    if (version !== generation || state.viewer?.login.toLowerCase() !== login) return;
    const prefix = `${login}|`;
    for (const [key, value] of Object.entries(statuses)) {
      if (key.startsWith(prefix)) {
        const keyWithoutLogin = key.slice(prefix.length);
        state.diagnoses[keyWithoutLogin] = { ...value, busy: pendingDiagnosis.has(keyWithoutLogin), error: value.reason || null };
      }
    }
  }
  async function hydrate(items, kind, version) {
    let index = 0;
    async function worker() {
      while (index < items.length) {
        const item = items[index++];
        if (version !== generation) return;
        try {
          const pr = await api.getPullRequest(item);
          const ci = await api.getCI({ owner: item.owner, repo: item.repo, sha: pr.headSha });
          if (version !== generation) return;
          Object.assign(item, pr, { ci });
        } catch (error) {
          if (version !== generation) return;
          item.ci = { state: 'unknown', partial: true, errors: [{ message: errorText(error) }] };
        }
        publish();
      }
    }
    await Promise.all([worker(), worker()]);
  }
  function refresh({ kind = state.activeKind, reason = 'manual', more = false } = {}) {
    checkKind(kind);
    state.activeKind = kind;
    if (pendingRefresh.has(kind)) return pendingRefresh.get(kind);
    const operation = (async () => {
      let list = state.lists[kind];
      list.loading = true;
      list.error = null;
      publish();
      let version = generation;
      try {
        const viewer = await authenticate();
        version = generation;
        list = state.lists[kind];
        list.loading = true;
        const page = more && list.hasMore ? list.page + 1 : 1;
        const result = await api.listPullRequests({ login: viewer.login, kind, page });
        if (version !== generation) return snapshot();
        const items = result.items.map(item => ({ ...item, ci: { state: 'loading', checks: [], statuses: [] } }));
        list.items = page === 1 ? items : [...list.items.filter(old => !items.some(item => prKey(item) === prKey(old))), ...items];
        Object.assign(list, { page, totalCount: result.totalCount, hasMore: result.hasMore, incomplete: result.incomplete || result.searchLimitReached, error: null });
        publish();
        await hydrate(items, kind, version);
        if (version === generation) {
          list.updatedAt = now();
          // Run status is updated on the same user event, never by a polling timer.
          try { await updateTaskStatuses(); } catch (error) { if (version === generation) state.error = errorText(error); }
        }
      } catch (error) {
        if (version === generation) {
          list.error = errorText(error);
          if (!state.viewer) state.error = list.error;
        }
      } finally {
        if (version === generation) { list.loading = false; publish(); }
      }
      return snapshot();
    })();
    pendingRefresh.set(kind, operation);
    operation.finally(() => { if (pendingRefresh.get(kind) === operation) pendingRefresh.delete(kind); });
    return operation;
  }
  function diagnose(input) {
    const key = prKey(input);
    if (pendingDiagnosis.has(key)) return pendingDiagnosis.get(key);
    let version = generation;
    const clickedLogin = state.viewer?.login;
    const operation = (async () => {
      state.diagnoses[key] = { ...state.diagnoses[key], busy: true, error: null };
      publish();
      try {
        const viewer = await authenticate();
        if (clickedLogin && clickedLogin.toLowerCase() !== viewer.login.toLowerCase()) throw new Error('GitHub 账号已变化，请重新选择 PR。');
        version = generation;
        const support = await taskManager.capabilities();
        if (version !== generation) throw new Error('账号配置已变化，请重新选择 PR。');
        state.taskSupport = support;
        if (!support.available) throw new Error(support.reason);
        const diagnostics = await api.getDiagnostics(input);
        if (version !== generation) throw new Error('GitHub 账号已变化，请重新选择 PR。');
        const result = await taskManager.diagnose({ ...input, login: viewer.login, diagnostics });
        if (version === generation) state.diagnoses[key] = { ...result, busy: false, error: result.reason || null };
        return result;
      } catch (error) {
        if (version === generation) state.diagnoses[key] = { ...state.diagnoses[key], busy: false, error: errorText(error) };
        throw error;
      } finally { publish(); }
    })();
    pendingDiagnosis.set(key, operation);
    operation.finally(() => { if (pendingDiagnosis.get(key) === operation) pendingDiagnosis.delete(key); }).catch(() => {});
    return operation;
  }
  async function openDiagnosis(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('打开诊断的请求无效，请重新点击。');
    // This deadline limits delayed transport; only the host can grant a real gesture.
    const remaining = payload.expiresAt - now();
    if (!Number.isSafeInteger(payload.expiresAt) || remaining <= 0 || remaining > 2500) {
      throw new Error('此次点击已过期，请再次点击“查看诊断”。');
    }
    if (typeof payload.owner !== 'string' || !/^[a-z\d][a-z\d-]{0,99}$/i.test(payload.owner) ||
        typeof payload.repo !== 'string' || !/^[\w.-]{1,100}$/.test(payload.repo) || ['.', '..'].includes(payload.repo) ||
        !Number.isSafeInteger(payload.number) || payload.number <= 0) {
      throw new Error('PR 信息无效，请刷新后重试。');
    }
    const taskId = state.diagnoses[prKey(payload)]?.taskId;
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(taskId)) {
      throw new Error('尚未取得此 PR 的诊断任务，请刷新看板后重试。');
    }
    if (typeof openTaskView !== 'function') throw new Error('当前 Cindy 不支持打开诊断任务，请更新后重试。');
    // Keep this path free of GitHub/status/storage requests: the host gesture lasts 3s.
    const result = await openTaskView({ sessionId: taskId, focus: true });
    if (result?.ok !== true) {
      const text = result?.errorCode === 'HOST_NOT_READY'
        ? 'Cindy 任务窗口尚未就绪，请再次点击“查看诊断”。'
        : '未能切换到诊断任务，请再次点击“查看诊断”。';
      throw new Error(text);
    }
    if (result.focusRequested !== true || result.sessionId !== taskId) {
      throw new Error('Cindy 未确认切换到此诊断任务，请更新 Cindy 后重试。');
    }
    return { taskId, focusRequested: true };
  }
  async function dispatch(action, payload = {}) {
    if (action === 'openDiagnosis') return openDiagnosis(payload);
    if (action === 'diagnosisContext') return taskManager.contextForTask(payload.taskId);
    if (action === 'snapshot') {
      const version = generation;
      try { await updateTaskStatuses(); } catch (error) { if (version === generation) state.error = errorText(error); }
      return snapshot();
    }
    if (action === 'refresh') return refresh(payload);
    if (action === 'loadMore') {
      checkKind(payload.kind);
      if (!state.lists[payload.kind].hasMore) return snapshot();
      return refresh({ ...payload, more: true });
    }
    if (action === 'diagnose') return diagnose(payload);
    if (action === 'configChanged') {
      generation++;
      authPending = null;
      pendingRefresh.clear();
      pendingDiagnosis.clear();
      state.viewer = null;
      state.lists = { authored: blankList(), review: blankList() };
      state.diagnoses = {};
      publish();
      return refresh({ kind: state.activeKind });
    }
    throw new Error('不支持的操作。');
  }
  return { snapshot, dispatch };
}

// Register the promise synchronously, before any network or task side effect.
export function createRequestHandler({ dispatch, respond, maxCompleted = 64 }) {
  const receipts = new Map();
  return function handle(message) {
    if (message?.kind !== 'request' || typeof message.id !== 'string' || message.id.length > 128 || typeof message.action !== 'string') return;
    const signature = JSON.stringify([message.action, message.payload || {}]);
    const existing = receipts.get(message.id);
    if (existing) {
      if (existing.signature !== signature) {
        respond({ kind: 'response', id: message.id, ok: false, error: '重复请求的内容发生了变化，请重新操作。' });
      } else existing.promise.then(respond);
      return;
    }
    const receipt = { signature, complete: false };
    const payload = message.action === 'diagnose' ? { ...message.payload, actionId: message.id } : message.payload;
    receipt.promise = Promise.resolve().then(() => dispatch(message.action, payload)).then(
      data => ({ kind: 'response', id: message.id, ok: true, data }),
      error => ({ kind: 'response', id: message.id, ok: false, error: errorText(error) }),
    );
    receipts.set(message.id, receipt);
    receipt.promise.then(response => {
      receipt.complete = true;
      respond(response);
      let completed = [...receipts.values()].filter(value => value.complete).length;
      for (const [id, value] of receipts) {
        if (completed <= maxCompleted) break;
        if (value.complete) { receipts.delete(id); completed--; }
      }
    });
  };
}
