const CHANNEL_NAME = 'cindy-pr-dashboard-v1';
const REQUEST_TIMEOUT_MS = 120000;
const NAVIGATION_TIMEOUT_MS = 2500;

export function createRpc({ onSnapshot, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const pending = new Map();
  let closed = false;

  function settle(id, value, error) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    clearTimeout(entry.retryTimer);
    entry.wakeController.abort();
    if (error) entry.reject(error); else entry.resolve(value);
  }

  channel.addEventListener('message', ({ data: message }) => {
    if (!message || typeof message !== 'object') return;
    if (message.kind === 'snapshot') {
      onSnapshot?.(message.data);
      return;
    }
    if (message.kind !== 'response' || typeof message.id !== 'string') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.ok === true) settle(message.id, message.data);
    else {
      const detail = message.error;
      const text = typeof detail === 'string' ? detail : detail?.message;
      settle(message.id, undefined, new Error(text || '操作未完成，请重试。'));
    }
  });

  function request(action, payload = {}) {
    if (closed) return Promise.reject(new Error('页面连接已关闭。'));
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const navigation = action === 'openDiagnosis';
    const requestTimeout = Math.min(navigation ? NAVIGATION_TIMEOUT_MS : REQUEST_TIMEOUT_MS, Math.max(1000, timeoutMs));
    const expiresAt = Date.now() + requestTimeout;
    const message = { kind: 'request', id, action, payload: navigation ? { ...payload, expiresAt } : payload };
    const timeoutError = () => new Error(navigation
      ? '此次点击已过期，请再次点击“查看诊断”。'
      : '等待插件响应超时。请检查 Cindy 运行状态后重试。');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(id, undefined, timeoutError());
      }, requestTimeout);
      const wakeController = new AbortController();
      // Register before waking/posting: a warm main page can answer immediately.
      pending.set(id, { resolve, reject, timer, retryTimer: null, wakeController });
      const post = () => {
        if (!pending.has(id) || closed) return;
        if (navigation && Date.now() >= expiresAt) {
          settle(id, undefined, timeoutError());
          return;
        }
        try { channel.postMessage(message); }
        catch (error) {
          settle(id, undefined, error);
          return;
        }
        const entry = pending.get(id);
        if (entry) entry.retryTimer = setTimeout(post, 500);
      };
      // The host returns starting/running before main's channel necessarily
      // exists. Retry transport with the SAME id; main deduplicates execution.
      void fetch('/wake', { signal: wakeController.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`无法唤醒插件（HTTP ${response.status}）。`);
        const result = await response.json();
        if (!['starting', 'running'].includes(result?.state)) {
          const reason = result?.state === 'off' ? '插件尚未启用，请先在插件详情页启用。'
            : result?.state === 'fused' ? '插件因连续失败已暂停，请在插件详情页重新加载。'
              : '插件未能启动，请在插件详情页检查运行状态。';
          throw new Error(reason);
        }
        post();
      }).catch((error) => {
        if (pending.has(id)) settle(id, undefined, new Error(error?.message || '无法唤醒插件，请检查 Cindy 运行状态。'));
      });
    });
  }

  function close() {
    closed = true;
    channel.close();
    for (const id of pending.keys()) settle(id, undefined, new Error('页面连接已关闭。'));
  }
  return { request, close };
}
