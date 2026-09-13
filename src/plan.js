import { createHash } from 'node:crypto';

/** Approval binds to these fields. Change any of them and the plan id changes. */
const SINGLE_MATERIAL = ['customer_id', 'charge_id', 'duplicate_of', 'amount', 'currency', 'action'];

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export function hashPlan(plan) {
  const material = plan.action === 'refund_batch_full'
    ? [plan.customer_id, plan.kept_charge_id, plan.action, plan.total_amount,
      (plan.refunds || []).map(({ charge_id, amount, currency, duplicate_of }) =>
        [charge_id, amount, currency, duplicate_of])]
    : SINGLE_MATERIAL.map((k) => plan[k]);
  const digest = createHash('sha256').update(JSON.stringify(material)).digest('hex');
  // Existing persisted plans used 16 hex characters; retain verification only
  // for those records while all newly built plans use the full digest.
  return 'wpl_' + (typeof plan.plan_id === 'string' && plan.plan_id.length === 20 ? digest.slice(0, 16) : digest);
}

export const planRefunds = (plan) => plan.action === 'refund_batch_full'
  ? plan.refunds
  : [{ charge_id: plan.charge_id, amount: plan.amount, currency: plan.currency, duplicate_of: plan.duplicate_of }];

export function buildPlan(fields) {
  const created = new Date();
  const plan = {
    ...fields,
    action: 'refund_full',
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + APPROVAL_TTL_MS).toISOString(),
  };
  plan.plan_id = hashPlan(plan);
  return plan;
}

export function buildBatchPlan(fields) {
  const created = new Date();
  const refunds = (fields.refunds || []).map(r => ({
    charge_id: r.charge_id,
    amount: r.amount,
    currency: r.currency,
    duplicate_of: r.duplicate_of,
  }));
  if (refunds.length < 2) throw new Error('batch plan requires at least two refunds');
  const plan = {
    ...fields,
    action: 'refund_batch_full',
    refunds,
    total_amount: refunds.reduce((sum, r) => sum + r.amount, 0),
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + APPROVAL_TTL_MS).toISOString(),
  };
  plan.plan_id = hashPlan(plan);
  return plan;
}

export const isExpired = (plan) => !Number.isFinite(Date.parse(plan.expires_at)) || Date.now() >= Date.parse(plan.expires_at);

export function renewPlan(plan) {
  const created = new Date();
  const renewed = { ...plan, created_at: created.toISOString(), expires_at: new Date(created.getTime() + APPROVAL_TTL_MS).toISOString() };
  renewed.plan_id = hashPlan(renewed);
  return renewed;
}

export function secondsLeft(plan) {
  return Math.max(0, Math.round((new Date(plan.expires_at) - new Date()) / 1000));
}
