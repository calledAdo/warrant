import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRun, investigate, approve, decline, execute, resume, runs, journalFor, recoverRuns } from './run.js';
import { resetRuns } from './runstate.js';
import { listIssues, issuesForRun } from './lemma-issues.js';
import { secondsLeft } from './plan.js';
import * as stripe from './adapters/stripe.js';
import { reset as resetJournal } from './journal.js';
import { dashboardUrlFor, tracingEnabled, currentRelease } from './trace.js';
import * as complaints from './complaints.js';
import { createSimulatedPayment } from './simulation.js';
import { ensureS1Demo, prepareS1Demo, getS1Demo } from './demo.js';
import { sqliteProviderEnabled } from './demo-store.js';
import {
  submitRefundRequest, investigateRefundRequest, approveRefundRequest,
  executeApprovedRefund, declineRefundRequest,
} from './application.js';

const PORT = process.env.PORT || 3000;
const integratedS1Demo = process.env.WARRANT_DEMO === 's1' && !sqliteProviderEnabled();
const page = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const MAX_BODY_BYTES = 16 * 1024;
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      d += c;
      if (Buffer.byteLength(d) > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
      }
    });
    req.on('end', () => { if (tooLarge) return; try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(page('index.html'));
    }
    if (p === '/simulation' || p === '/simulation.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(page('simulation.html'));
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
      const { complaint, run } = await submitRefundRequest({ email, body });
      json(res, 200, { id: complaint.id });
      investigateRefundRequest(run).catch(() => {});
      return;
    }

    if (p === '/api/simulation/payment' && req.method === 'POST') {
      return json(res, 200, await createSimulatedPayment());
    }

    if (p === '/api/complaints' && req.method === 'GET') {
      const rows = complaints.all().map((c) => {
        const run = c.run_id ? runs.get(c.run_id) : null;
        return {
          id: c.id, created_at: c.created_at, email: c.email, body: c.body,
          customer_name: c.customer_name, customer_id: c.customer_id,
          run_id: c.run_id, status: run?.status ?? (c.run_id ? 'unavailable' : 'received'),
          outcome: run?.finding?.outcome ?? null, hold: run?.hold ?? null,
          amount: run?.plan?.total_amount ?? run?.plan?.amount ?? null,
          currency: run?.plan?.refunds?.[0]?.currency ?? run?.plan?.currency ?? 'usd',
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

    if (p === '/api/lemma/issues' && req.method === 'GET') {
      return json(res, 200, await listIssues({ force: url.searchParams.get('refresh') === 'true' }));
    }
    const li = p.match(/^\/api\/runs\/([^/]+)\/lemma$/);
    if (li && req.method === 'GET') {
      const run = runs.get(li[1]);
      if (!run) return json(res, 404, { error: 'no such run' });
      return json(res, 200, await issuesForRun(run));
    }

    if (p === '/api/config') {
      return json(res, 200, {
        tracing: tracingEnabled,
        release: currentRelease,
        twin: Boolean(process.env.SLACK_API_URL),
        slackApi: sqliteProviderEnabled() ? 'sqlite' : (process.env.SLACK_API_URL || 'https://slack.com'),
        repo: sqliteProviderEnabled() ? null : process.env.GITHUB_REPO,
        engine: 'langgraph',
        model: process.env.LLM_MODE === 'rules' ? 'rules engine' : (process.env.OPENAI_MODEL || 'rules engine'),
        provider: sqliteProviderEnabled() ? 'sqlite' : 'live',
        demo: integratedS1Demo ? 's1' : null,
      });
    }

    if (p === '/api/demo' && req.method === 'GET') {
      return json(res, 200, getS1Demo());
    }
    if (p === '/api/demo/reset' && req.method === 'POST') {
      if ([...runs.values()].some(run => run.busy)) return json(res, 409, { error: 'Cannot reset while a run is active.' });
      if (sqliteProviderEnabled()) return json(res, 200, prepareS1Demo());
      const { prepareIntegratedS1Demo } = await import('./demo-live.js');
      return json(res, 200, await prepareIntegratedS1Demo());
    }

    if (p === '/api/fixtures') {
      if (sqliteProviderEnabled()) {
        const demo = getS1Demo();
        return json(res, 200, { scenarios: [{
          scenario: 's1',
          label: 'Northwind - billed twice',
          report: 'We were billed twice for September.',
          customer_id: demo.customer?.id,
          email: demo.customer?.email,
          expect: 'refund',
          charges: demo.charges,
        }] });
      }
      const f = 'fixtures/current.json';
      const fixtures = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { scenarios: [] };
      if (integratedS1Demo) fixtures.scenarios = (fixtures.scenarios || []).filter(item => item.scenario === 's1');
      return json(res, 200, fixtures);
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
      const run = approveRefundRequest({ runId: ap[1], planId: plan_id, approver });
      json(res, 200, { ok: true });
      executeApprovedRefund(run).catch(() => {});
      return;
    }

    const dc = p.match(/^\/api\/decline\/(.+)$/);
    if (dc && req.method === 'POST') {
      const { approver, reason } = await readBody(req);
      json(res, 200, { ok: true });
      declineRefundRequest({ runId: dc[1], approver, reason }).catch((e) => {
        const run = runs.get(dc[1]);
        if (!run) return;
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
      return json(res, 200, { plan_id: planId, operations: journalFor(run?.id || planId) });
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
      if ([...runs.values()].some(run => run.busy)) return json(res, 409, { error: 'Cannot reset while a run is active.' });
      if (sqliteProviderEnabled()) return json(res, 200, prepareS1Demo());
      if (integratedS1Demo) {
        const { prepareIntegratedS1Demo } = await import('./demo-live.js');
        return json(res, 200, await prepareIntegratedS1Demo());
      }
      resetJournal();
      complaints.reset();
      resetRuns();
      return json(res, 200, { ok: true });
    }

    res.writeHead(404).end('not found');
  } catch (e) {
    if (!res.headersSent) json(res, e.statusCode || 500, { error: e.message });
  }
});

await recoverRuns();
if (sqliteProviderEnabled()) ensureS1Demo();

server.listen(PORT, () => {
  console.log(`\n  Warrant console  http://localhost:${PORT}`);
  console.log(`  tracing: ${tracingEnabled ? 'on · ' + currentRelease : 'off'}`);
  console.log(`  provider: ${sqliteProviderEnabled() ? 'sqlite demo · S1' : integratedS1Demo ? 'live demo · S1' : 'live'}`);
  console.log(`  records: ${sqliteProviderEnabled() ? 'sqlite demo' : process.env.SLACK_API_URL ? 'Slack twin ' + process.env.SLACK_API_URL : 'GitHub + Slack'}\n`);
});
