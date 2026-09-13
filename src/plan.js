import { createHash } from 'node:crypto';

/** Approval binds to these fields. Change any of them and the plan id changes. */
const MATERIAL = ['customer_id', 'charge_id', 'duplicate_of', 'amount', 'currency', 'action'];

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export function hashPlan(plan) {
  const material = MATERIAL.map((k) => plan[k]);
  return 'wpl_' + createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
}

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

export const isExpired = (plan) => new Date() > new Date(plan.expires_at);

export function secondsLeft(plan) {
  return Math.max(0, Math.round((new Date(plan.expires_at) - new Date()) / 1000));
}
