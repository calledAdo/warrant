import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import { serveFrontend } from '../src/frontend.js';

test('production frontend serves both routes and immutable assets, with safe method and path handling', async () => {
  const server = createServer((req, res) => { if (!serveFrontend(req, res, new URL(req.url, 'http://localhost').pathname)) res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/', '/admin', '/admin.html', '/index.html']) {
      const response = await fetch(base + path); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/html/);
      assert.match(await response.text(), /assets\/index-/); assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    }
    const asset = readdirSync(new URL('../dist/client/assets', import.meta.url)).find(file => file.endsWith('.js'));
    const script = await fetch(`${base}/assets/${asset}`); assert.equal(script.status, 200); assert.match(script.headers.get('cache-control'), /immutable/); assert.match(script.headers.get('content-type'), /javascript/);
    const head = await fetch(base + '/', { method: 'HEAD' }); assert.equal(await head.text(), ''); assert.ok(Number(head.headers.get('content-length')) > 0);
    assert.equal((await fetch(base + '/admin', { method: 'POST' })).status, 405);
    for (const path of ['/assets/missing.js', '/assets/%2e%2e/.env', '/.env', '/src/server.js', '/package.json', '/app.css']) assert.equal((await fetch(base + path)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
