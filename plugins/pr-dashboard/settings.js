import { createRpc } from './lib/rpc.mjs';

const $ = (id) => document.getElementById(id);
const SECRET_KEY = 'github_token';
const rpc = createRpc();
let saved = false;
let busy = false;

function status(text, isError = false) {
  $('settings-message').textContent = text;
  $('settings-message').className = isError ? 'error-message' : 'notice';
  $('settings-message').hidden = !text;
}

function setBusy(value) {
  busy = value;
  $('save-token').disabled = value;
  $('remove-token').disabled = value || !saved;
  $('github-token').disabled = value;
}

async function loadStatus() {
  const response = await fetch('/secrets');
  if (!response.ok) throw new Error(`无法读取凭据状态（HTTP ${response.status}）。`);
  const values = await response.json();
  if (!Array.isArray(values)) throw new Error('宿主返回的凭据状态格式异常。');
  const item = values.find((value) => value?.key === SECRET_KEY);
  saved = item?.saved === true;
  const hostAvailable = item?.hostSource === 'gh-cli' && item?.hostAvailable === true;
  const managedSetup = item?.hostManagedSetup === true;
  const intro = '优先复用 Cindy 管理的本机 GitHub 登录。已有可用登录即可使用，无需另外填写 Token。';
  $('settings-intro').textContent = !hostAvailable && !managedSetup
    ? `${intro} 当前宿主未提供页面登录入口，可在本机终端运行 gh auth login，或使用下方备用 Token。`
    : intro;
  const parts = [];
  if (hostAvailable) parts.push('本机 GitHub 登录可用，将优先使用。');
  else parts.push('尚未检测到可用的本机 GitHub 登录。');
  if (saved) parts.push(`备用 Token 已保存${typeof item.tail === 'string' && item.tail ? `（尾号 ${item.tail.slice(-4)}）` : ''}。`);
  else parts.push('未保存备用 Token。');
  $('connection-status').textContent = parts.join(' ');
  $('github-token').placeholder = saved ? '粘贴新 Token 以更换备用凭据' : '粘贴 GitHub Token';
  if (!hostAvailable && saved) $('pat-section').open = true;
  setBusy(busy);
}

async function notifyConfigChanged(successText) {
  try {
    await rpc.request('configChanged');
    status(successText);
  } catch {
    status(`${successText} 看板尚未确认配置更新，请返回看板手动刷新。`, true);
  }
}

$('token-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  let value = $('github-token').value.trim();
  if (!value) { status('请先粘贴备用 Token。', true); return; }
  setBusy(true);
  status('正在安全保存…');
  try {
    const request = fetch(`/secrets/${SECRET_KEY}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
    $('github-token').value = '';
    value = '';
    const response = await request;
    if (response.status !== 204) throw new Error(`保存未完成（HTTP ${response.status}），请重新输入后重试。`);
    saved = true;
    try { await loadStatus(); }
    catch { $('connection-status').textContent = '备用 Token 已保存；暂时无法刷新本机登录状态。'; }
    await notifyConfigChanged('备用 Token 已保存；实际访问权限将在读取 PR 时验证。');
  } catch (error) { status(error?.message || '保存未完成，请重试。', true); }
  finally { value = ''; $('github-token').value = ''; setBusy(false); }
});

$('remove-token').addEventListener('click', async () => {
  if (busy || !saved) return;
  setBusy(true);
  status('正在移除备用 Token…');
  try {
    const response = await fetch(`/secrets/${SECRET_KEY}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`移除未完成（HTTP ${response.status}）。`);
    saved = false;
    try { await loadStatus(); }
    catch { $('connection-status').textContent = '备用 Token 已移除；暂时无法刷新本机登录状态。'; }
    await notifyConfigChanged('备用 Token 已移除。本机 GitHub 登录仍由 Cindy 管理。');
  } catch (error) { status(error?.message || '移除未完成，请重试。', true); }
  finally { setBusy(false); }
});

window.addEventListener('pagehide', () => rpc.close(), { once: true });
try { await loadStatus(); }
catch (error) { status(error?.message || '无法读取凭据状态。', true); $('connection-status').textContent = '连接状态暂时不可用。'; }
