// Local fixture host for UI review. It does not contact GitHub or any AI service.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
let kv = {};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (url.pathname === '/wake') return json({ state: 'running' });
    if (url.pathname === '/kv') {
      if (req.method === 'PUT') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('Too large'); }
        kv = JSON.parse(body); res.statusCode = 204; return res.end();
      }
      return json(kv);
    }
    if (url.pathname === '/secrets') return json([{ key: 'github_token', saved: false, hostSource: 'gh-cli', hostAvailable: true }]);
    if (url.pathname.startsWith('/secrets/')) { res.statusCode = 403; return res.end('Preview does not accept credentials'); }
    if (url.pathname === '/dev/host.html') kv = {};
    const requested = url.pathname === '/' ? '/dev/preview.html' : url.pathname;
    const file = path.resolve(root, '.' + requested);
    if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
    const body = await readFile(file);
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 404; res.end('Not found'); }
});
server.listen(4318, '127.0.0.1', () => process.stdout.write('Fixture preview: http://127.0.0.1:4318\n'));
