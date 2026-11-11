// Optional read-only adapter smoke test. gh performs authentication itself;
// neither this script nor the plugin reads an access token.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitHubClient } from '../lib/github.mjs';
const exec = promisify(execFile);
const api = createGitHubClient({ request: async ({ url }) => {
  const target = new URL(url);
  if (target.origin !== 'https://api.github.com') throw new Error('Unexpected API origin');
  try {
    const { stdout } = await exec('gh', ['api', target.pathname + target.search,
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return { ok: true, status: 200, headers: {}, body: stdout };
  } catch { return { ok: false, errorCode: 'GH_READ_FAILED' }; }
} });
const viewer = await api.getViewer();
const summary = { login: viewer.login, mode: 'read-only gh adapter; not Cindy runtime', lists: {} };
let sample;
for (const kind of ['authored', 'review']) {
  const list = await api.listPullRequests({ login: viewer.login, kind });
  summary.lists[kind] = { total: list.totalCount, loaded: list.items.length, incomplete: list.incomplete };
  sample ||= list.items[0];
}
if (sample) {
  const pr = await api.getPullRequest(sample);
  const ci = await api.getCI({ ...sample, sha: pr.headSha });
  summary.ci = { state: ci.state, checks: ci.checks.length, statuses: ci.statuses.length, partial: ci.partial };
} else summary.ci = { tested: false, reason: 'No open PR in the two lists' };
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
