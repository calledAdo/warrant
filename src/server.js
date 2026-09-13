import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRun, investigate, approve, decline, execute, resume, runs, journalFor } from './run.js';
import { secondsLeft } from './plan.js';
import * as stripe from './adapters/stripe.js';
import { reset as resetJournal } from './journal.js';
import { dashboardUrlFor, tracingEnabled, currentRelease } from './trace.js';
import * as complaints from './complaints.js';

const PORT = process.env.PORT || 3000;
const page = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(page('index.html'));
    }
    if (p === '/admin' || p === '/admin.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(page('admin.html'));
    }
    if (p === '/app.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end(page('app.css'));
    }

    // ---- complaints ----------------------------------------------------
    if (p === '/api/complaints' && req.method === 'POST') {
      const { email, body } = await readBody(req);
      if (!email || !body) return json(res, 400, { error: 'Email and description are required.' });
      if (String(body).length > 2000) {
        return json(res, 400, { error: 'Please keep the description under 2,000 characters.' });
      }
      const customer = await stripe.findCustomerByEmail(email).catch(() => null);
      if (!customer) {
        return json(res, 404, {
          error: 'We could not find an account for that email address. Check the address and try again.',
        });
      }
      const c = complaints.create({ email, body, customer });
      const run = createRun(body, customer.id);
      complaints.attachRun(c.id, run.id);
      json(res, 200, { id: c.id });
      investigate(run).catch((e) => {
        run.status = 'error'; run.error = e.message; run.emit('update', run.snapshot());
      });
      return;
    }

    if (p === '/api/complaints' && req.method === 'GET') {
      const rows = complaints.all().map((c) => {
        const run = c.run_id ? runs.get(c.run_id) : null;
        return {
          id: c.id, created_at: c.created_at, email: c.email, body: c.body,
          customer_name: c.customer_name, customer_id: c.customer_id,
          run_id: c.run_id, status: run?.status ?? 'received',
          amount: run?.plan?.amount ?? null, currency: run?.plan?.currency ?? 'usd',
        };
      });
      return json(res, 200, { complaints: rows });
    }

    const cm = p.match(/^\/api\/complaints\/([^/]+)$/);
    if (cm) {
      const c = complaints.get(cm[1]);
      if (!c) return json(res, 404, { error: 'No complaint with that reference.' });
      const run = c.run_id ? runs.get(c.run_id) : null;
      return json(res, 200, { ...complaints.customerView(c, run), run_id: c.run_id });
    }

    if (p === '/api/config') {
      return json(res, 200, {
        tracing: tracingEnabled,
        release: currentRelease,
        twin: Boolean(process.env.SLACK_API_URL),
        slackApi: process.env.SLACK_API_URL || 'https://slack.com',
        repo: process.env.GITHUB_REPO,
        model: process.env.LLM_MODE === 'rules' ? 'rules engine' : (process.env.OPENAI_MODEL || 'rules engine'),
      });
    }

    if (p === '/api/fixtures') {
      const f = 'fixtures/current.json';
      return json(res, 200, existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { scenarios: [] });
    }

    if (p === '/api/investigate' && req.method === 'POST') {
      const { report, customer_id } = await readBody(req);
      if (!customer_id) return json(res, 400, { error: 'customer_id required' });
      const run = createRun(report || 'Customer reports a duplicate charge.', customer_id);
      json(res, 200, { run_id: run.id });
      investigate(run).catch((e) => {
        run.status = 'error';
        run.error = e.message;
        run.step('assemble', 'assemble case', 'failed', e.message);
        run.emit('update', run.snapshot());
      });
      return;
    }

    const sse = p.match(/^\/api\/events\/(.+)$/);
    if (sse) {
      const run = runs.get(sse[1]);
      if (!run) return json(res, 404, { error: 'no such run' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (s) => res.write(`data: ${JSON.stringify({ ...s, expiresIn: s.plan ? secondsLeft(s.plan) : null })}\n\n`);
      send(run.snapshot());
      const on = (s) => send(s);
      run.on('update', on);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { run.off('update', on); clearInterval(ka); });
      return;
    }

    // Addressed by RUN id, not plan id: plan_id is a deterministic hash of the
    // material fields, so two runs over the same fixture share one. Approval
    // still binds to the plan hash (checked in execute); this only picks the
    // run the operator is actually looking at.
    const ap = p.match(/^\/api\/approve\/(.+)$/);
    if (ap && req.method === 'POST') {
      const { approver, plan_id } = await readBody(req);
      const run = runs.get(ap[1]);
      if (!run) return json(res, 404, { error: 'no such run' });
      if (!run.plan) return json(res, 409, { error: 'run has no plan' });
      if (plan_id && run.plan.plan_id !== plan_id) {
        return json(res, 409, { error: 'plan changed since it was shown' });
      }
      approve(run, approver || 'ops@warrant.test');
      json(res, 200, { ok: true });
      execute(run).catch((e) => {
        run.status = 'error';
        run.error = e.message;
        run.emit('update', run.snapshot());
      });
      return;
    }

    const dc = p.match(/^\/api\/decline\/(.+)$/);
    if (dc && req.method === 'POST') {
      const { approver, reason } = await readBody(req);
      const run = runs.get(dc[1]);
      if (!run?.plan) return json(res, 404, { error: 'no plan on that run' });
      if (run.status !== 'awaiting_approval') return json(res, 409, { error: 'not awaiting a decision' });
      json(res, 200, { ok: true });
      decline(run, approver || 'ops@warrant.test', reason).catch((e) => {
        run.pending = [{ step: 'decline', error: e.message }];
        run.emit('update', run.snapshot());
      });
      return;
    }

    // Full run snapshot for the admin investigation view.
    const rn = p.match(/^\/api\/runs\/(.+)$/);
    if (rn) {
      const run = runs.get(rn[1]);
      if (!run) return json(res, 404, { error: 'no such run' });
      return json(res, 200, { ...run.snapshot(), expiresIn: run.plan ? secondsLeft(run.plan) : null });
    }

    const rs = p.match(/^\/api\/resume\/(.+)$/);
    if (rs && req.method === 'POST') {
      const run = runs.get(rs[1]);
      if (!run) return json(res, 404, { error: 'no such run' });
      json(res, 200, { ok: true });
      resume(run).catch((e) => { run.status = 'error'; run.error = e.message; run.emit('update', run.snapshot()); });
      return;
    }

    const st = p.match(/^\/api\/state\/(.+)$/);
    if (st) {
      const charges = await stripe.listCharges(st[1]).catch(() => []);
      return json(res, 200, { charges });
    }

    // Journal for a RUN (by run id) — the reliability artifact the console shows.
    const jr = p.match(/^\/api\/journal\/(.+)$/);
    if (jr) {
      const run = runs.get(jr[1]);
      const planId = run?.plan?.plan_id || jr[1];
      return json(res, 200, { plan_id: planId, operations: journalFor(planId) });
    }

    const tr = p.match(/^\/api\/trace\/(.+)$/);
    if (tr) return json(res, 200, (await dashboardUrlFor(tr[1])) || { url: null });

    // Resolve a run's two trace ids to deep links, so the console can send a
    // judge straight to the trace instead of the dashboard index.
    const tl = p.match(/^\/api\/tracelinks\/(.+)$/);
    if (tl) {
      const run = runs.get(tl[1]);
      if (!run) return json(res, 404, { error: 'no such run' });
      const [inv, exe] = await Promise.all([
        dashboardUrlFor(run.traceId), dashboardUrlFor(run.execTraceId),
      ]);
      return json(res, 200, { investigate: inv?.url || null, execute: exe?.url || null });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      resetJournal();
      complaints.reset();
      runs.clear();
      return json(res, 200, { ok: true });
    }

    res.writeHead(404).end('not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Warrant console  http://localhost:${PORT}`);
  console.log(`  tracing: ${tracingEnabled ? 'on · ' + currentRelease : 'off'}`);
  console.log(`  slack:   ${process.env.SLACK_API_URL ? 'TWIN ' + process.env.SLACK_API_URL : 'real'}\n`);
});
