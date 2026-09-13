/**
 * ONE-SHOT Arga Slack twin probe. The twin lives ~10 minutes, so this answers
 * every open question in a single run. Do not iterate against a live twin.
 *
 *   SLACK_API_URL=<twin-url> SLACK_BOT_TOKEN=<twin-token> node verify/twin-slack.mjs
 *
 * Questions it answers:
 *   Q1  Does auth.test work on the twin?
 *   Q2  Is chat.postMessage real, or a stub?
 *   Q3  Is chat.update real, and does it preserve ts?          <- the approval UX
 *   Q4  Does a seeded rate limit actually fire?                <- S4 depends on this
 *   Q5  What does the failure look like — HTTP 429? ok:false? Retry-After?
 *   Q6  Is admin/config readable for assertions?
 *
 * Writes verify/out/twin-report.json so the findings survive the twin dying.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = (process.env.SLACK_API_URL || '').replace(/\/$/, '');
const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = process.env.TWIN_CHANNEL || 'general';

if (!BASE || !TOKEN) {
  console.error('\nSLACK_API_URL and SLACK_BOT_TOKEN must both be set.\n');
  process.exit(1);
}

const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m  ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const findings = { base: BASE, at: new Date().toISOString(), questions: {} };

/** Raw call so we can inspect status, headers and stub markers — the SDK hides these. */
async function call(method, body = {}) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  let json = {};
  try { json = await res.json(); } catch {}
  return {
    status: res.status,
    ok: json.ok === true,
    error: json.error,
    stub: res.headers.get('x-twin-stub') === 'true' || json._twin_stub === true,
    warning: json._twin_warning,
    retryAfter: res.headers.get('retry-after'),
    json,
  };
}

const stubCheck = (label, r) => {
  if (r.stub) { fail(`${label} is STUBBED — do not build on it. ${r.warning || ''}`); return false; }
  pass(`${label} is real (no stub markers)`);
  return true;
};

async function main() {
  console.log(`\n  twin: ${BASE}`);

  head('Q1 — auth.test');
  const auth = await call('auth.test');
  if (auth.ok) pass(`authenticated: user=${auth.json.user} team=${auth.json.team}`);
  else fail(`auth failed: ${auth.error} (HTTP ${auth.status})`);
  findings.questions.auth = { ok: auth.ok, stub: auth.stub, body: auth.json };
  if (!auth.ok) { save(); process.exit(1); }

  head('Q2 — chat.postMessage');
  const posted = await call('chat.postMessage', {
    channel: CHANNEL,
    text: 'Refund proposed: $49.00 — Northwind Trading Co.',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Refund proposed — awaiting approval' } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: '*Amount*\n$49.00 USD' },
        { type: 'mrkdwn', text: '*Charge*\n`ch_test`' },
      ] },
    ],
  });
  if (posted.ok) pass(`posted ts=${posted.json.ts} channel=${posted.json.channel}`);
  else fail(`postMessage failed: ${posted.error} (HTTP ${posted.status})`);
  const postReal = stubCheck('chat.postMessage', posted);
  findings.questions.postMessage = { ok: posted.ok, stub: posted.stub, ts: posted.json.ts, error: posted.error };

  head('Q3 — chat.update preserves ts');
  let updateReal = false;
  if (posted.ok) {
    const upd = await call('chat.update', {
      channel: posted.json.channel,
      ts: posted.json.ts,
      text: 'Refund applied and verified.',
    });
    if (upd.ok) {
      pass(`updated; ts ${upd.json.ts === posted.json.ts ? 'unchanged — correct' : 'CHANGED — approval UX breaks'}`);
    } else fail(`update failed: ${upd.error}`);
    updateReal = stubCheck('chat.update', upd);
    findings.questions.update = { ok: upd.ok, stub: upd.stub, tsPreserved: upd.json.ts === posted.json.ts, error: upd.error };
  } else note('skipped — nothing to update');

  head('Q4/Q5 — rate limit behaviour (S4 depends on this)');
  let limited = null;
  for (let i = 1; i <= 12; i++) {
    const r = await call('chat.update', {
      channel: posted.json.channel, ts: posted.json.ts, text: `probe ${i}`,
    });
    if (!r.ok && (r.status === 429 || r.error === 'ratelimited' || r.error === 'rate_limited')) {
      limited = { attempt: i, status: r.status, error: r.error, retryAfter: r.retryAfter };
      break;
    }
    if (!r.ok) { note(`call ${i} failed for another reason: ${r.error} (HTTP ${r.status})`); break; }
  }
  if (limited) {
    pass(`rate limited on call ${limited.attempt}`);
    console.log(`        HTTP ${limited.status} · error=${limited.error} · Retry-After=${limited.retryAfter ?? '(none)'}`);
    note('S4 can use a NATIVE Arga fault. Seed the limit tighter so it fires on the first update.');
  } else {
    fail('no rate limit fired in 12 calls');
    note('S4 must use a labelled SIMULATED_FAULT in the adapter. Say so in the brief.');
  }
  findings.questions.rateLimit = limited ?? { fired: false, attempts: 12 };

  head('Q6 — admin endpoints (for assertions)');
  const admin = await fetch(`${BASE}/admin/config`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (admin.ok) {
    const cfg = await admin.json().catch(() => ({}));
    pass(`GET /admin/config readable (${Object.keys(cfg).join(', ').slice(0, 80)})`);
    findings.questions.admin = { ok: true, keys: Object.keys(cfg) };
  } else {
    note(`GET /admin/config -> HTTP ${admin.status} — assert via the API instead`);
    findings.questions.admin = { ok: false, status: admin.status };
  }

  head('VERDICT');
  const usable = posted.ok && postReal && updateReal;
  console.log(`  Slack twin usable for the approval flow: ${usable ? '\x1b[32mYES\x1b[0m' : '\x1b[31mNO\x1b[0m'}`);
  console.log(`  S4 native fault available:                ${limited ? '\x1b[32mYES\x1b[0m' : '\x1b[33mNO — use labelled simulated fault\x1b[0m'}`);
  findings.verdict = { usable, nativeFault: Boolean(limited) };
  save();
}

function save() {
  mkdirSync('verify/out', { recursive: true });
  writeFileSync('verify/out/twin-report.json', JSON.stringify(findings, null, 2));
  console.log('\n  saved verify/out/twin-report.json (survives the twin expiring)\n');
}

main().catch((e) => { console.error(`\n\x1b[31m${e.message}\x1b[0m`); save(); process.exit(1); });
