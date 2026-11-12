(() => {
  const sha = 'a'.repeat(40);
  const demoRuns = new Map();
  const fixtures = [
    { number: 42, title: '修复插件重启后的任务关联', repo: 'cindy-example', conclusion: 'failure' },
    { number: 39, title: '完善深色主题下的设置页', repo: 'cindy-example', conclusion: 'success' },
    { number: 28, title: '增加 PR 检查结果的分页提示', repo: 'pr-dashboard', conclusion: null },
    { number: 17, title: '更新贡献指南与开发环境说明', repo: 'docs', conclusion: 'none', draft: true },
  ];
  function pr(item) { return { ...item, number: item.number, title: item.title, html_url: `https://github.com/example/${item.repo}/pull/${item.number}`, state: 'open', user: { login: 'example' }, head: { sha: sha.slice(0, 38) + String(item.number).padStart(2, '0'), ref: 'fix/example' }, base: { ref: 'main' }, body: '演示 PR；这不是用户仓库的数据。' }; }
  globalThis.cindy = {
    async fetch({ url }) {
      const u = new URL(url); let data;
      if (u.pathname === '/user') data = { login: 'example', id: 1 };
      else if (u.pathname === '/search/issues') {
        const items = u.searchParams.get('q').includes('review-requested') ? fixtures.slice(0, 1) : fixtures;
        data = { total_count: items.length, incomplete_results: false, items: items.map(item => ({ ...pr(item), repository_url: `https://api.github.com/repos/example/${item.repo}`, pull_request: {} })) };
      } else if (/\/pulls\/\d+$/.test(u.pathname)) data = pr(fixtures.find(item => item.number === Number(u.pathname.split('/').at(-1))));
      else if (u.pathname.endsWith('/check-runs')) {
        const item = fixtures.find(item => u.pathname.includes(pr(item).head.sha));
        data = { total_count: item.conclusion === 'none' ? 0 : 1, check_runs: item.conclusion === 'none' ? [] : [{ id: item.number, name: 'test / node-22', status: item.conclusion ? 'completed' : 'in_progress', conclusion: item.conclusion, output: { title: item.conclusion === 'failure' ? '1 test failed' : '', summary: '演示检查摘要', annotations_count: item.conclusion === 'failure' ? 1 : 0 } }] };
      } else if (u.pathname.endsWith('/status')) data = { state: 'pending', total_count: 0, statuses: [] };
      else if (u.pathname.endsWith('/annotations')) data = [{ path: 'tests/tasks.test.mjs', start_line: 17, annotation_level: 'failure', message: 'Expected one task; received two.（演示）' }];
      else if (u.pathname.endsWith('/actions/runs')) data = { total_count: 0, workflow_runs: [] };
      else return { ok: true, status: 404, body: '{}' };
      return { ok: true, status: 200, headers: {}, body: JSON.stringify(data) };
    },
    tasks: {
      async capabilities() { return { operations: ['create','get','send','getRun'], experimental: true }; },
      async create({ requestKey, title }) { return { taskId: `demo-${requestKey}`, title, status: 'active', revision: 1 }; },
      async get({ taskId }) { return { taskId, status: 'active', revision: 1 }; },
      async send({ taskId, requestKey }) {
        const run = { taskId, runId: `demo-${requestKey}`, status: 'queued' };
        demoRuns.set(run.runId, run);
        return run;
      },
      async getRun({ runId }) {
        const run = demoRuns.get(runId);
        if (!run) throw new Error('演示宿主已重载，请重新打开预览以清除临时状态。');
        return { ...run, status: 'completed' };
      },
    },
    async taskView({ sessionId, focus }) {
      if (!sessionId || focus !== true) return { ok: false, errorCode: 'INVALID_REQUEST' };
      if (parent !== window) parent.postMessage({ type: 'pr-preview-navigation', taskId: sessionId }, parent.location.origin);
      return { ok: true, sessionId, focusRequested: true };
    },
    onHostMessage() {}, send() {},
  };
})();
