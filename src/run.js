/**
 * Orchestration. Emits step events for the console and drives Lemma tracing.
 *
 * Two executions per case, linked by threadId:
 *   warrant.investigate  — read, judge, write case, post proposal (or refuse)
 *   warrant.execute      — verify, refund, verify, update case, update slack
 */
import { EventEmitter } from 'node:events';
import * as stripe from './adapters/stripe.js';
import * as github from './adapters/github.js';
import * as slack from './adapters/slack.js';
import { assembleCase, caseBody } from './agent.js';
import { buildPlan, hashPlan, isExpired } from './plan.js';
import { withJournal, recordApproval, getApproval, opsForPlan } from './journal.js';
import { lemma } from './trace.js';

export const runs = new Map();

class Run extends EventEmitter {
  constructor(id, report, customerId) {
    super();
    this.id = id;
    this.report = report;
    this.customerId = customerId;
    this.steps = [];
    this.plan = null;
    this.slackRef = null;
    this.caseNumber = null;
    this.status = 'running';
    this.pending = [];
  }
  /** Tag the most recent attempt as journal-skipped (no external write happened). */
  markSkipped(key) {
    const s = this.steps.find((x) => x.key === key);
    const at = s?.attempts?.[s.attempts.length - 1];
    if (at) at.skipped = true;
  }
  step(key, label, state, detail) {
    const existing = this.steps.find((s) => s.key === key);
    const s = existing || { key, label };
    const prev = s.state;
    s.state = state;
    if (detail !== undefined) s.detail = detail;

    // Timing drives the waterfall. Each activation is a separate attempt, so a
    // resumed step renders as a second segment rather than moving the first.
    s.attempts ??= [];
    if (state === 'active' && prev !== 'active') {
      const at = { startedAt: Date.now(), endedAt: null, state: 'active' };
      s.attempts.push(at);
      s.startedAt = s.attempts[0].startedAt;
      this.t0 ??= at.startedAt;
    }
    if (['done', 'failed', 'refused'].includes(state)) {
      const at = s.attempts[s.attempts.length - 1];
      if (at && !at.endedAt) {
        at.endedAt = Date.now();
        at.state = state;
        at.durationMs = at.endedAt - at.startedAt;
      }
      s.endedAt = at?.endedAt ?? s.endedAt;
      s.durationMs = s.attempts.reduce((n, a) => n + (a.durationMs || 0), 0);
      s.retried = s.attempts.length > 1;
    }
    if (!existing) this.steps.push(s);
    this.emit('update', this.snapshot());
  }
  snapshot() {
    return {
      id: this.id,
      status: this.status,
      t0: this.t0 ?? null,
      traceId: this.traceId ?? null,
      finding: this.finding ?? null,
      llm: this.llm ?? null,
      guard: this.guard ?? null,
      incidents: this.incidentsSeen ?? null,
      execTraceId: this.execTraceId ?? null,
      now: Date.now(),
      steps: this.steps,
      plan: this.plan,
      caseNumber: this.caseNumber,
      pending: this.pending,
      customerId: this.customerId,
      report: this.report,
      declineReason: this.declineReason ?? null,
      caseUrl: this.caseUrl ?? null,
    };
  }
}

const STEPS_INVESTIGATE = [
  ['read_charges', 'read charges'],
  ['read_incidents', 'search incidents'],
  ['assemble', 'assemble case'],
  ['write_case', 'write case'],
  ['post_proposal', 'post to slack'],
];

export function createRun(report, customerId) {
  const id = 'run_' + Math.random().toString(36).slice(2, 10);
  const run = new Run(id, report, customerId);
  runs.set(id, run);
  for (const [k, l] of STEPS_INVESTIGATE) run.step(k, l, 'idle');
  return run;
}

export async function investigate(run) {
  const threadId = `case-${run.customerId}`;

  await lemma.trace(
    { name: 'warrant.investigate', input: run.report, threadId, metadata: { customer_id: run.customerId } },
    async (trace) => {
      run.traceId = trace.id;

      // 1. Stripe
      run.step('read_charges', 'read charges', 'active');
      const customer = await stripe.getCustomer(run.customerId);
      const charges = await stripe.listCharges(run.customerId);
      trace.recordTool({ name: 'stripe.list_charges', input: { customer: run.customerId }, output: { count: charges.length } });
      run.step('read_charges', 'read charges', 'done',
        `${charges.length} charges · ${charges.map((c) => '$' + (c.amount / 100).toFixed(2)).join(', ')}`);
      run.customer = customer;
      run.charges = charges;
      run.emit('update', run.snapshot());

      // 2. GitHub
      run.step('read_incidents', 'search incidents', 'active');
      const incidents = await github.findIncidents();
      trace.recordTool({ name: 'github.find_incidents', input: { repo: process.env.GITHUB_REPO }, output: { found: incidents.length } });
      run.incidentsSeen = incidents.map((i) => ({ number: i.number, title: i.title, url: i.url }));
      run.step('read_incidents', 'search incidents', 'done',
        incidents.length ? `#${incidents[0].number} ${incidents[0].title.slice(0, 48)}` : 'none found');

      // 3. Model
      run.step('assemble', 'assemble case', 'active');
      const out = await assembleCase({ report: run.report, customer, charges, incidents });
      const f = out.parsed;
      trace.recordGeneration({
        name: 'assemble-case', model: out.model,
        input: [{ role: 'user', content: run.report }],
        output: JSON.stringify(f), usage: out.usage, durationMs: out.durationMs,
      });
      run.finding = f;
      run.guard = out.guard ? { overridden: out.guard.overridden, reason: out.guard.reason ?? null } : null;
      trace.recordSpan({
        name: 'duplicate-rule-check',
        input: { model_verdict: out.guard?.finding?.model_verdict ?? f.verdict },
        output: run.guard ?? { overridden: false },
      });
      run.llm = { model: out.model, ms: out.durationMs, inTok: out.usage?.inputTokens ?? 0, outTok: out.usage?.outputTokens ?? 0, rules: Boolean(out.rulesMode) };
      run.step('assemble', 'assemble case', f.verdict === 'duplicate' ? 'done' : 'refused',
        f.verdict === 'duplicate' ? f.grounds : f.missing_evidence);

      // 4. GitHub case — written either way
      run.step('write_case', 'write case', 'active');
      const title = f.verdict === 'duplicate'
        ? `Investigation: duplicate charge — ${customer.name}`
        : `Investigation: no duplicate found — ${customer.name}`;
      const created = await github.createCase({
        title, body: caseBody({ report: run.report, customer, charges, incidents, finding: f }),
      });
      trace.recordTool({ name: 'github.create_case', input: { title }, output: created });
      run.caseNumber = created.number;
      run.caseUrl = created.url;
      run.step('write_case', 'write case', 'done', `#${created.number}`);

      // 5. Slack
      run.step('post_proposal', 'post to slack', 'active');
      if (f.verdict === 'insufficient_evidence') {
        const posted = await slack.postRefusal(created.number, customer.name, f.missing_evidence, created.url);
        trace.recordTool({ name: 'slack.post_refusal', input: { case: created.number }, output: { ts: posted.ts } });
        run.slackRef = posted;
        run.step('post_proposal', 'post to slack', 'done', 'refusal posted — nothing requested');
        run.status = 'refused';
        run.emit('update', run.snapshot());
        return { verdict: 'insufficient_evidence', case: created.number };
      }

      const refund = charges.find((c) => c.id === f.charge_to_refund);
      const plan = buildPlan({
        case_id: created.number,
        customer_id: customer.id,
        customer_name: customer.name,
        charge_id: f.charge_to_refund,
        duplicate_of: f.duplicate_of,
        amount: refund.amount,
        currency: refund.currency,
        grounds: f.grounds,
        evidence: f.evidence,
      });
      run.plan = plan;

      const approveUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/approve/${plan.plan_id}`;
      const posted = await slack.postProposal(plan, approveUrl);
      trace.recordTool({ name: 'slack.post_proposal', input: { plan_id: plan.plan_id }, output: { ts: posted.ts } });
      run.slackRef = posted;
      run.step('post_proposal', 'post to slack', 'done', `awaiting approval · plan ${plan.plan_id}`);
      run.status = 'awaiting_approval';
      run.emit('update', run.snapshot());
      return { verdict: 'duplicate', plan_id: plan.plan_id };
    }
  );

  return run.snapshot();
}

export function approve(run, approver = 'ops@warrant.test') {
  if (!run.plan) throw new Error('no plan to approve');
  recordApproval(run.plan, approver);
  run.approver = approver;
  run.status = 'approved';
  run.emit('update', run.snapshot());
  return getApproval(run.plan.plan_id);
}

export function decline(run, approver = 'ops@warrant.test', reason = '') {
  if (!run.plan) throw new Error('no plan to decline');
  run.approver = approver;
  run.declineReason = reason;
  run.status = 'declined';
  run.emit('update', run.snapshot());
}

const EXEC_STEPS = [
  ['verify_charge', 'verify charge'],
  ['refund', 'refund'],
  ['verify_refund', 'verify refund'],
  ['update_case', 'update case'],
  ['update_slack', 'update slack'],
];

export async function execute(run) {
  const plan = run.plan;
  const approval = getApproval(plan.plan_id);
  if (!approval) throw new Error('not_approved');

  for (const [k, l] of EXEC_STEPS) if (!run.steps.find((s) => s.key === k)) run.step(k, l, 'idle');
  run.status = 'executing';
  run.pending = [];

  await lemma.trace(
    { name: 'warrant.execute', input: plan, threadId: `case-${run.customerId}`, metadata: { plan_id: plan.plan_id } },
    async (trace) => {
      run.execTraceId = trace.id;
      // G2, G3
      if (hashPlan(plan) !== approval.plan_id) throw new Error('plan_mismatch');
      if (isExpired(plan)) throw new Error('approval_expired');

      // G1 — full refunds only
      run.step('verify_charge', 'verify charge', 'active');
      const charge = await stripe.getCharge(plan.charge_id);
      trace.recordTool({ name: 'stripe.get_charge', input: { id: plan.charge_id }, output: charge });
      if (charge.amount !== plan.amount) throw new Error('amount_mismatch');
      if (charge.currency !== plan.currency) throw new Error('currency_mismatch');
      run.step('verify_charge', 'verify charge', 'done', `$${(charge.amount / 100).toFixed(2)} matches plan`);

      // G4, G5 — journalled, idempotency key = op_key
      run.step('refund', 'refund', 'active');
      const opKey = `${plan.plan_id}:refund`;
      const j = await withJournal(opKey, { planId: plan.plan_id, step: 'refund', request: plan }, (key) => {
        const t = trace.startTool({ name: 'stripe.refund', input: { charge: plan.charge_id, key } });
        return stripe.refundFull(plan.charge_id, key).then(
          (r) => { t.end({ output: r }); return r; },
          (e) => { t.end({ error: e }); throw e; }
        );
      });
      if (j.uncertain) throw new Error('uncertain_refund_state — inspect Stripe before retrying');
      const refund = j.result;
      run.step('refund', 'refund', 'done', j.skipped ? `already done — ${refund.id} (no second refund)` : `${refund.id}`);
      if (j.skipped) run.markSkipped('refund');

      // G6 — assert amount_refunded, never the `refunded` flag
      run.step('verify_refund', 'verify refund', 'active');
      const after = await stripe.getCharge(plan.charge_id);
      trace.recordTool({ name: 'stripe.verify_refund', input: { id: plan.charge_id }, output: after });
      if (after.amount_refunded !== plan.amount) throw new Error('refund_not_verified');
      run.step('verify_refund', 'verify refund', 'done', `amount_refunded=${after.amount_refunded} ✓`);

      // G9 — from here, failures are reported, never rolled back
      const steps = [
        ['update_case', 'update case', () =>
          github.comment(plan.case_id,
            `Refund \`${refund.id}\` applied and verified.\n\n` +
            `- \`amount_refunded\` = ${after.amount_refunded} (expected ${plan.amount})\n` +
            `- approved by ${approval.approver} at ${approval.approved_at}\n` +
            `- plan \`${plan.plan_id}\``)],
        ['update_slack', 'update slack', () =>
          slack.updateApplied(run.slackRef.channel, run.slackRef.ts, plan, refund, approval.approver)],
      ];

      for (const [key, label, fn] of steps) {
        run.step(key, label, 'active');
        try {
          const r = await withJournal(`${plan.plan_id}:${key}`, { planId: plan.plan_id, step: key }, (k) => {
            const t = trace.startTool({ name: key, input: { plan_id: plan.plan_id } });
            return fn().then(
              (v) => { t.end({ output: v }); return v; },
              (e) => { t.end({ error: e }); throw e; }
            );
          });
          run.step(key, label, 'done', r.skipped ? 'already done — skipped' : 'ok');
          if (r.skipped) run.markSkipped(key);
        } catch (e) {
          run.pending.push({ step: key, error: e.message, retryAfter: e.retryAfter });
          run.step(key, label, 'failed', e.message);
        }
      }

      trace.recordSpan({
        name: 'evaluate-final-state',
        output: { status: run.pending.length ? 'partial' : 'complete', pending: run.pending.map((p) => p.step) },
      });

      run.status = run.pending.length ? 'partial' : 'complete';
      run.emit('update', run.snapshot());
      return { status: run.status, pending: run.pending };
    }
  );

  return run.snapshot();
}

/** Resume re-enters execute(). The journal makes completed steps no-ops. */
export async function resume(run) {
  return execute(run);
}

export const journalFor = (planId) => opsForPlan(planId);
