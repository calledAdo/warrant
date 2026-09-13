/**
 * Local stand-in for the Arga Slack twin, for exercising S4 without spending a
 * twin run. Mirrors the twin behaviour verified on 2026-09-12/13:
 *   - auth.test, chat.postMessage, chat.update, conversations.list
 *   - chat.update rate-limited to 1 call per WINDOW seconds:
 *     HTTP 429, {"ok":false,"error":"ratelimited"}, Retry-After header
 *
 * This is a test double, not Arga. Demo recordings use the real twin.
 *
 *   MOCK_SLACK_WINDOW=6 node verify/mock-slack.mjs     # listens on :4020
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_SLACK_PORT || 4020);
const WINDOW = Number(process.env.MOCK_SLACK_WINDOW || 6);
const channel = { id: 'CMOCK000001', name: 'billing-approvals' };
const messages = new Map();
let updates = [];

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    const method = req.url.replace(/^\/api\//, '').split('?')[0];

    if (method === 'auth.test') return send(res, 200, { ok: true, user: 'mock-twin-bot', team: 'Mock Workspace' });
    if (method === 'conversations.list') return send(res, 200, { ok: true, channels: [channel] });

    if (method === 'chat.postMessage') {
      const ts = (Date.now() / 1000).toFixed(6);
      messages.set(ts, { text: body.text, blocks: body.blocks });
      return send(res, 200, { ok: true, channel: channel.id, ts });
    }

    if (method === 'chat.update') {
      const now = Date.now();
      updates = updates.filter((t) => now - t < WINDOW * 1000);
      if (updates.length >= 1) {
        const retry = Math.ceil((WINDOW * 1000 - (now - updates[0])) / 1000);
        return send(res, 429, { ok: false, error: 'ratelimited' }, { 'Retry-After': String(retry) });
      }
      if (!messages.has(body.ts)) return send(res, 200, { ok: false, error: 'message_not_found' });
      updates.push(now);
      messages.set(body.ts, { text: body.text, blocks: body.blocks });
      return send(res, 200, { ok: true, channel: channel.id, ts: body.ts });
    }

    send(res, 200, { ok: false, error: 'unknown_method' });
  });
}).listen(PORT, () => console.log(`mock slack twin on :${PORT} (chat.update limit 1/${WINDOW}s)`));
