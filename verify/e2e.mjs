/**
 * End-to-end rehearsal of every scenario, headless. Run before the demo to
 * confirm the whole pipeline still works after a change.
 *
 *   node verify/e2e.mjs
 *   node verify/e2e.mjs --scenario=s1
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRun, investigate, approve, execute, resume, replay } from '../src/run.js';
import { reset, opsForPlan } from '../src/journal.js';
import * as stripe from '../src/adapters/stripe.js';

const head = (m) => console.log(`\n\x1b[1m\x1b[44m  ${m}  \x1b[0m`);
const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m) => { console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); failures.push(m); };
const info = (m) => console.log(`        ${m}`);
const failures = [];
const scenarioArg = process.argv.find((arg) => arg.startsWith('--scenario='));
const scenario = scenarioArg?.slice('--scenario='.length);
const supportedScenarios = new Set(['s1', 's2', 's3', 's4', 's6']);
if (scenario && !supportedScenarios.has(scenario)) {
  throw new Error(`unknown scenario: ${scenario}`);
}

const fx = JSON.parse(readFileSync('fixtures/current.json', 'utf8')).scenarios;
const get = (s) => fx.find((f) => f.scenario === s);

const steps = (run) => run.steps.map((s) => `${s.key}:${s.state}`).join(' ');

async function s1() {
  head('S1 — genuine duplicate, should refund');
  const f = get('s1');
  const run = createRun(f.report, f.customer_id);
  await investigate(run);
  info(steps(run));

  run.status === 'awaiting_approval' ? pass('proposed and awaiting approval')
    : fail(`status ${run.status} — model=${run.llm?.model} guard=${JSON.stringify(run.guard?.reason)} missing="${run.finding?.missing_evidence}"`);
  run.plan ? pass(`plan ${run.plan.plan_id} · refund ${run.plan.charge_id}`) : fail('no plan');
  run.caseNumber ? pass(`case #${run.caseNumber} written`) : fail('no case');
  if (!run.plan) return null;

  approve(run);
  await execute(run);
  info(steps(run));

  run.status === 'complete' ? pass('status complete') : fail(`status ${run.status} pending=${JSON.stringify(run.pending)}`);
  const ch = await stripe.getCharge(run.plan.charge_id);
  ch.amount_refunded === run.plan.amount
    ? pass(`amount_refunded=${ch.amount_refunded} verified against Stripe`)
    : fail(`amount_refunded=${ch.amount_refunded} expected ${run.plan.amount}`);

  const other = await stripe.getCharge(run.plan.duplicate_of);
  other.amount_refunded === 0 ? pass('the legitimate charge was NOT touched') : fail('legitimate charge was refunded!');
  return run;
}

async function s2() {
  head('S2 — not a duplicate, must refuse');
  const f = get('s2');
  const run = createRun(f.report, f.customer_id);
  await investigate(run);
  info(steps(run));

  run.status === 'refused' ? pass('REFUSED') : fail(`status ${run.status} — should have refused`);
  !run.plan ? pass('no plan built — nothing to approve') : fail('a plan was built for a non-duplicate!');
  run.caseNumber ? pass(`case #${run.caseNumber} written anyway`) : fail('no case written on refusal');
  run.finding?.missing_evidence
    ? pass(`states what is missing: "${run.finding.missing_evidence.slice(0, 70)}..."`)
    : fail('no missing_evidence stated');

  const charges = await stripe.listCharges(f.customer_id);
  charges.every((c) => c.amount_refunded === 0)
    ? pass('no money moved')
    : fail('a refund happened on the refusal case!');
  return run;
}

async function s3(s1run) {
  head('S3 — replay must not refund twice');
  if (!s1run) return fail('skipped, S1 produced no run');
  const before = await stripe.getCharge(s1run.plan.charge_id);

  // Fork the LangGraph thread from the checkpoint taken just before the refund
  // node and run forward again. The graph re-enters refund; the journal must
  // stop it from moving money a second time.
  await replay(s1run);
  const after = await stripe.getCharge(s1run.plan.charge_id);
  s1run.engine?.checkpoints ? pass(`replayed from LangGraph history (${s1run.engine.checkpoints} checkpoints)`) : info('no checkpoint count');

  after.amount_refunded === before.amount_refunded
    ? pass(`amount_refunded unchanged at ${after.amount_refunded}`)
    : fail(`amount_refunded moved ${before.amount_refunded} -> ${after.amount_refunded}`);

  const ops = opsForPlan(s1run.plan.plan_id).filter((o) => o.step === 'refund');
  ops.length === 1 ? pass('journal holds exactly one refund operation') : fail(`${ops.length} refund ops`);

  const refundStep = s1run.steps.find((s) => s.key === 'refund');
  /already done/.test(refundStep?.detail || '')
    ? pass(`executor reported: "${refundStep.detail}"`)
    : fail(`replay did not hit the journal — refund detail: ${refundStep?.detail}`);
}

async function s4() {
  head('S4 — Slack fails after the refund, then resume');
  if (!process.env.SLACK_API_URL) {
    fail('S4 explicitly requested but SLACK_API_URL is not set');
    info('SLACK_API_URL not set — provision an Arga twin to run S4:');
    info('  arga twin-runs create --twins slack --ttl 10 --scenario-prompt "..." --wait --json');
    return;
  }
  // S1 already refunded its duplicate, so S4 needs a fresh one.
  execFileSync('node', ['fixtures/build.mjs', '--scenario', 's1'], { stdio: 'ignore' });
  const f = JSON.parse(readFileSync('fixtures/current.json', 'utf8')).scenarios.find((x) => x.scenario === 's1');
  const run = createRun(f.report, f.customer_id);
  await investigate(run);
  if (!run.plan) return fail(`no plan for S4 — status ${run.status}, missing="${run.finding?.missing_evidence}"`);
  approve(run);

  // Arm the NATIVE Arga rate limit by consuming its single allowed call.
  // The fault is Arga's; we only ensure the quota is saturated when the
  // executor reaches chat.update. Verified 2026-09-13.
  const slack = await import('../src/adapters/slack.js');
  const decoy = await slack.raw('chat.postMessage', { channel: process.env.SLACK_CHANNEL || 'billing-approvals', text: 'arming rate limit' });
  await slack.raw('chat.update', { channel: decoy.channel, ts: decoy.ts, text: 'saturate' }).catch(() => {});
  info('native rate limit armed');

  await execute(run);
  info(steps(run));

  const pendingSlack = run.pending.some((p) => p.step === 'update_slack');
  pendingSlack ? pass('update_slack pending, refund preserved') : fail(`S4 did not exercise the expected failure; pending: ${JSON.stringify(run.pending)}`);

  const ch = await stripe.getCharge(run.plan.charge_id);
  ch.amount_refunded === run.plan.amount ? pass('refund NOT rolled back') : fail('refund was lost');

  if (pendingSlack) {
    const wait = (run.pending[0].retryAfter || 60) + 2;
    info(`waiting ${wait}s for the rate-limit window...`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    await resume(run);
    run.status === 'complete' ? pass('resume completed the pending step') : fail(`after resume: ${run.status}`);
    const ch2 = await stripe.getCharge(run.plan.charge_id);
    ch2.amount_refunded === run.plan.amount ? pass('refund still exactly once after resume') : fail('refund changed on resume');
  }
}

async function s6() {
  head('S6 — duplicate buried under 22 newer charges; the agent must page back');
  execFileSync('node', ['fixtures/build.mjs', '--scenario', 's6'], { stdio: 'ignore' });
  const f = JSON.parse(readFileSync('fixtures/current.json', 'utf8')).scenarios.find((x) => x.scenario === 's6');
  const flat = await stripe.listCharges(f.customer_id, 20);
  const pairIds = f.charges.map((c) => c.id);
  !pairIds.every((id) => flat.some((c) => c.id === id))
    ? pass('a flat "last 20 charges" fetch would NOT contain the duplicate')
    : fail('fixture broken: the pair is within the first 20');

  const run = createRun(f.report, f.customer_id);
  await investigate(run);
  const pages = run.searches.filter((x) => x.tool === 'search_charges').length;
  info(`searches: ${run.searches.map((x) => `${x.tool}${x.args?.cursor ? '(page)' : ''}`).join(' → ')}`);
  !run.llm?.rules ? pass(`the model decided (${run.llm?.model}, ${run.llm?.turns} turns)`) : fail('fell back to the rules engine');
  pages >= 3 ? pass(`paged back through ${pages} charge searches, ${run.charges.length} charges seen`) : fail(`only ${pages} charge searches`);
  run.status === 'awaiting_approval' ? pass('proposed a refund') : fail(`status ${run.status} — ${run.finding?.missing_evidence}`);
  run.finding?.charge_to_refund === f.charges[1].id && run.finding?.duplicate_of === f.charges[0].id
    ? pass('refund targets the later charge of the buried pair') : fail(`wrong charges: refund=${run.finding?.charge_to_refund}`);
}

console.log(`\n  mode: ${process.env.LLM_MODE === 'rules' || !process.env.OPENAI_API_KEY ? 'RULES ENGINE' : 'LLM'}`);
console.log(`  slack: ${process.env.SLACK_API_URL ? 'TWIN' : 'real'}`);
reset();

let run1 = null;
if (!scenario || ['s1', 's3'].includes(scenario)) run1 = await s1();
if (!scenario || scenario === 's2') await s2();
if (!scenario || scenario === 's3') await s3(run1);
if (scenario === 's4' || (!scenario && process.argv.includes('--s4'))) await s4();
else if (!scenario) info('S4 skipped; explicit --s4 required.');
if (scenario === 's6' || (!scenario && !process.argv.includes('--skip-s6'))) await s6();

console.log(`\n\x1b[1m  ${failures.length ? '\x1b[31m' + failures.length + ' FAILURE(S)' : '\x1b[32mALL SCENARIOS PASSED'}\x1b[0m\n`);
process.exit(failures.length ? 1 : 0);
