/* Cindy loads entry as a classic script. Modules are same-origin package files. */
(async () => {
  const channel = new BroadcastChannel('cindy-pr-dashboard-v1');
  const earlyCalls = [];
  let handleTool;
  // Register synchronously: a cold host may dispatch before dynamic imports finish.
  cindy.onHostMessage(message => {
    if (message.type !== 'tool-call') return;
    if (handleTool) void handleTool(message); else earlyCalls.push(message);
  });
  try {
    const [{ createGitHubClient }, { createStore }, { createTaskManager }, { createController, createRequestHandler }] = await Promise.all([
      import('./lib/github.mjs'), import('./lib/store.mjs'), import('./lib/tasks.mjs'), import('./lib/controller.mjs'),
    ]);
    let inFlight = 0;
    const queue = [];
    async function request(options) {
      if (inFlight >= 2) await new Promise(resolve => queue.push(resolve)); else inFlight++;
      try { return await cindy.fetch(options); }
      finally { const next = queue.shift(); if (next) next(); else inFlight--; }
    }
    const api = createGitHubClient({ request });
    const taskManager = createTaskManager({ tasks: cindy.tasks, store: createStore(), id: () => crypto.randomUUID() });
    const controller = createController({
      api, taskManager,
      openTaskView: typeof cindy.taskView === 'function' ? request => cindy.taskView(request) : undefined,
      onChange: data => channel.postMessage({ kind: 'snapshot', data }),
    });
    const handle = createRequestHandler({ dispatch: controller.dispatch, respond: message => channel.postMessage(message) });
    channel.addEventListener('message', event => handle(event.data));
    handleTool = async message => {
      try {
        const scoped = createGitHubClient({ request: options => request({ ...options, callId: message.callId }) });
        let result;
        if (message.tool === 'list_my_prs') {
          const viewer = await scoped.getViewer();
          result = await scoped.listPullRequests({ login: viewer.login, kind: message.args?.kind || 'authored', page: message.args?.page || 1 });
        } else if (message.tool === 'get_pr_ci') {
          result = await scoped.getDiagnostics(message.args || {});
        } else throw new Error('未知工具，请使用 list_my_prs 或 get_pr_ci。');
        cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result });
      } catch (error) {
        cindy.send({ type: 'tool-result', callId: message.callId, ok: false, message: String(error.message || '读取失败，请重试。').slice(0, 500) });
      }
    };
    for (const message of earlyCalls.splice(0)) void handleTool(message);
  } catch {
    // Keep the UI actionable even if an incompatible host cannot load a module.
    channel.addEventListener('message', event => {
      if (event.data?.kind === 'request') channel.postMessage({ kind: 'response', id: event.data.id, ok: false, error: '插件启动失败，请检查 Cindy 版本和插件文件是否完整。' });
    });
    handleTool = message => cindy.send({ type: 'tool-result', callId: message.callId, ok: false, message: '插件启动失败，请检查 Cindy 版本和插件文件是否完整。' });
    for (const message of earlyCalls.splice(0)) void handleTool(message);
  }
})();
