// Isolated browser-test server. Never imports the payment workflow or credentials.
import { createServer } from 'node:http';
import { serveFrontend } from '../src/frontend.js';

let scenario = 'review';
let failure = null;
let actions = [];
let reports = [];
let runs = {};
let customer = {};
const listeners = new Map();
const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const read = async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body || '{}'); };

function reset(name = 'review', options = {}) {
  scenario = name; failure = options.failure || null; actions = [];
  for (const group of listeners.values()) for (const response of group) response.end();
  listeners.clear();
  const date = new Date();
  const plan = { plan_id: 'wpl_test_exact_plan', amount: 4900, currency: 'usd', charge_id: 'ch_duplicate_123456789', duplicate_of: 'ch_original_123456789', customer_id: 'cus_northwind', action: 'refund_full', created_at: date.toISOString(), expires_at: new Date(date.getTime() + (name === 'expired' ? -60000 : name === 'expiring' ? 3000 : 900000)).toISOString() };
  const finding = { verdict: 'duplicate', charge_to_refund: plan.charge_id, duplicate_of: plan.duplicate_of, grounds: 'Two successful $49.00 charges were made one minute apart for the same subscription. Both charges have the same description, and incident #12 confirms a billing retry during this window.', missing_evidence: '', uncertainty: 'The incident supports the duplicate, but the root cause has not yet been closed by engineering.', evidence: [{ source: 'stripe', id: plan.duplicate_of, detail: '$49.00 USD · Monthly subscription · Sep 13, 10:24 AM' }, { source: 'stripe', id: plan.charge_id, detail: '$49.00 USD · Monthly subscription · Sep 13, 10:25 AM' }, { source: 'github', id: '#12', detail: 'Billing retry created duplicate subscription charges.' }] };
  const steps = ['read_charges', 'read_incidents', 'assemble', 'write_case', 'post_proposal'].map((key, i) => ({ key, label: ['Read customer charges', 'Check incident records', 'Assess the evidence', 'Write investigation case', 'Notify billing team'][i], state: 'done', durationMs: [220, 480, 2100, 550, 190][i], detail: '', attempts: [] }));
  const base = { id: 'run_northwind', status: 'awaiting_approval', plan, finding, steps, llm: { rules: false, model: 'gpt-oss-120b', ms: 2100, inTok: 930, outTok: 240 }, guard: { overridden: false }, incidents: [{ number: 12, title: 'Billing retry created duplicate subscription charges' }], caseNumber: 42, caseUrl: 'https://github.com/example/billing/issues/42', pending: [], approver: null, declineReason: null, error: null, engine: { framework: 'langgraph', next: ['human_review'], checkpoints: 8, interrupted: true }, expiresIn: 900 };
  runs = { run_northwind: structuredClone(base), run_harbor: { ...structuredClone(base), id: 'run_harbor', status: 'refused', plan: null, finding: { verdict: 'not_duplicate', grounds: 'These charges are for different services: a subscription and a usage add-on.', missing_evidence: 'The amounts and descriptions do not match.', uncertainty: 'none', evidence: [{ source: 'stripe', id: 'ch_harbor_plan', detail: '$49.00 USD · Monthly subscription' }, { source: 'stripe', id: 'ch_harbor_usage', detail: '$73.00 USD · Usage add-on' }] }, incidents: [], caseNumber: 43, caseUrl: 'https://github.com/example/billing/issues/43' } };
  reports = [
    { id: 'C-NORTH', customer_name: 'Northwind Studio', email: 'billing@northwind.test', body: 'We were charged twice for our September subscription. Both charges are for $49 and appeared a minute apart. Could you take a look?', customer_id: 'cus_northwind', created_at: new Date(date - 12 * 60000).toISOString(), run_id: 'run_northwind', amount: 4900, currency: 'usd' },
    { id: 'C-HARBR', customer_name: 'Harbor & Co.', email: 'ap@harbor.test', body: 'There are two charges on our account this month. Can you check if one of them is a duplicate?', customer_id: 'cus_harbor', created_at: new Date(date - 45 * 60000).toISOString(), run_id: 'run_harbor', amount: null, currency: 'usd' },
  ];
  if (name === 'empty' || name === 'queue_error') reports = [];
  if (name === 'partial') { base.status = 'partial'; runs.run_northwind.status = 'partial'; runs.run_northwind.pending = [{ step: 'update_slack', error: 'Slack temporarily rate limited the update.' }]; }
  if (name === 'complete') runs.run_northwind.status = 'complete';
  if (name === 'error') { runs.run_northwind.status = 'error'; runs.run_northwind.error = 'Stripe could not be reached. Review the journal before retrying.'; }
  if (name === 'same_status') { runs.run_harbor = { ...structuredClone(base), id: 'run_harbor', plan: { ...plan, plan_id: 'wpl_harbor_exact', amount: 7300, charge_id: 'ch_harbor_duplicate' }, finding: { ...finding, grounds: 'Harbor evidence only. Two matching usage charges were recorded.' } }; reports[1].amount = 7300; }
  customer = { id: 'C-TEST1', created_at: date.toISOString(), email: 'billing@northwind.test', customer_name: 'Northwind Studio', body: 'Two $49 charges appeared on my statement.', stage: name === 'customer_complete' ? 4 : 2, stage_label: name === 'customer_complete' ? 'Resolved' : 'Investigating', note: 'Checking your billing history and our incident records.', outcome: name === 'customer_complete' ? { kind: 'refund', amount: 4900, currency: 'usd', text: 'We found a duplicate charge and refunded it in full.' } : null };
}
reset();
function broadcast(id) { for (const res of listeners.get(id) || []) res.write(`data: ${JSON.stringify(runs[id])}\n\n`); }

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); const path = url.pathname;
  try {
    if (path === '/__test/scenario') { const body = await read(req); reset(body.name, body); return reply(res, 200, { ok: true }); }
    if (path === '/__test/actions') return reply(res, 200, { actions });
    if (path === '/__test/update') { const body = await read(req); Object.assign(runs[body.id], body.patch); broadcast(body.id); return reply(res, 200, { ok: true }); }
    if (serveFrontend(req, res, path)) return;
    if (path === '/api/config') return reply(res, 200, { tracing: true, twin: true, repo: 'example/billing', model: 'gpt-oss-120b', engine: 'langgraph' });
    if (path === '/api/complaints' && req.method === 'GET') return reply(res, scenario === 'queue_error' ? 503 : 200, scenario === 'queue_error' ? { error: 'The queue is temporarily unavailable.' } : { complaints: reports.map(c => ({ ...c, status: runs[c.run_id]?.status || 'received' })) });
    if (path === '/api/complaints' && req.method === 'POST') {
      const body = await read(req); actions.push({ action: 'report', ...body });
      if (failure === 'report') { failure = null; return reply(res, 503, { error: 'The billing service is temporarily unavailable. Please try again.' }); }
      customer.email = body.email; customer.body = body.body;
      return reply(res, 200, { id: customer.id });
    }
    if (path.startsWith('/api/complaints/')) return path.endsWith('C-TEST1') ? reply(res, 200, customer) : reply(res, 404, { error: 'No complaint with that reference.' });
    const id = path.split('/').at(-1);
    if (path.startsWith('/api/events/')) {
      if (scenario === 'missing_run') return reply(res, 404, { error: 'no such run' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const group = listeners.get(id) || new Set(); group.add(res); listeners.set(id, group);
      broadcast(id); const timer = setInterval(() => res.write(': keepalive\n\n'), 1000);
      req.on('close', () => { clearInterval(timer); group.delete(res); }); return;
    }
    if (path.startsWith('/api/runs/')) return reply(res, scenario === 'missing_run' ? 404 : 200, scenario === 'missing_run' ? { error: 'no such run' } : runs[id]);
    if (path.startsWith('/api/journal/')) return reply(res, 200, { operations: ['partial', 'complete'].includes(runs[id]?.status) ? [{ op_key: `${id}:refund`, step: 'refund', status: 'succeeded', created_at: new Date().toISOString(), error: null, result: '{"id":"re_verified"}' }] : [] });
    if (path.startsWith('/api/tracelinks/')) return reply(res, 200, { investigate: 'https://platform.uselemma.ai/trace/investigate', execute: runs[id]?.status === 'complete' ? 'https://platform.uselemma.ai/trace/execute' : null });
    const action = path.match(/^\/api\/(approve|decline|resume)\//)?.[1];
    if (action) {
      const body = await read(req); actions.push({ action, run_id: id, ...body });
      if (failure === action) { failure = null; return reply(res, 409, { error: 'The plan changed since it was shown. Review the current proposal.' }); }
      if (action === 'approve' && body.plan_id !== runs[id].plan.plan_id) return reply(res, 409, { error: 'plan changed since it was shown' });
      runs[id].status = action === 'decline' ? 'declined' : 'complete'; runs[id].approver = body.approver; runs[id].declineReason = body.reason; runs[id].pending = [];
      reply(res, 200, { ok: true }); setTimeout(() => broadcast(id), 40); return;
    }
    reply(res, 404, { error: 'Unknown test route' });
  } catch (error) { reply(res, 500, { error: error.message }); }
}).listen(4173, '127.0.0.1', () => console.log('Isolated UI fixtures on http://127.0.0.1:4173'));
