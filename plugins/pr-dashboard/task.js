import { createRpc } from './lib/rpc.mjs';

const $ = id => document.getElementById(id);
const rpc = createRpc();
const taskId = new URLSearchParams(location.search).get('session');

async function loadContext() {
  $('retry-context').disabled = true;
  $('retry-context').hidden = true;
  $('context-error').hidden = true;
  $('context-loading').hidden = false;
  $('task-context').hidden = true;
  try {
    if (!taskId || !/^[A-Za-z0-9-]{1,64}$/.test(taskId)) throw new Error('未取得任务编号，请从“我的 PR 看板”重新打开诊断。');
    const context = await rpc.request('diagnosisContext', { taskId });
    if (!context) throw new Error('未找到此任务的 PR 关联。你仍可在任务主对话中查看已有内容。');
    if (context.taskId !== taskId || typeof context.owner !== 'string' || !/^[a-z\d][a-z\d-]{0,99}$/i.test(context.owner) ||
        typeof context.repo !== 'string' || !/^[\w.-]{1,100}$/.test(context.repo) || ['.', '..'].includes(context.repo) ||
        !Number.isSafeInteger(context.number) || context.number <= 0) {
      throw new Error('此任务的 PR 关联无效，请返回看板重新打开。');
    }
    const label = `${context.owner}/${context.repo}#${context.number}`;
    $('pr-title').textContent = label;
    $('pr-account').textContent = typeof context.login === 'string' ? `发起诊断时的 GitHub 账号：@${context.login}` : '';
    // Use a normal same-frame link: Cindy handles HTTPS via its external-link gate.
    $('pr-link').href = `https://github.com/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}/pull/${context.number}`;
    document.title = `CI 诊断 · ${label}`;
    $('task-context').hidden = false;
  } catch (error) {
    $('context-error').textContent = String(error?.message || '暂时无法读取任务关联，请重试。').slice(0, 500);
    $('context-error').hidden = false;
    $('retry-context').hidden = false;
  } finally {
    $('context-loading').hidden = true;
    $('retry-context').disabled = false;
  }
}

$('retry-context').addEventListener('click', () => { void loadContext(); });
window.addEventListener('pagehide', () => rpc.close(), { once: true });
void loadContext();
