import Stripe from 'stripe';

let _client;
const client = () => (_client ??= new Stripe(process.env.STRIPE_SECRET_KEY));

export async function listCharges(customerId, limit = 20) {
  const res = await client().charges.list({ customer: customerId, limit });
  return res.data.map((c) => ({
    id: c.id,
    amount: c.amount,
    currency: c.currency,
    description: c.description,
    status: c.status,
    created: c.created,
    created_iso: new Date(c.created * 1000).toISOString(),
    refunded: c.refunded,
    amount_refunded: c.amount_refunded,
  }));
}

export async function getCharge(chargeId) {
  const c = await client().charges.retrieve(chargeId);
  return {
    id: c.id,
    amount: c.amount,
    currency: c.currency,
    description: c.description,
    status: c.status,
    refunded: c.refunded,
    amount_refunded: c.amount_refunded,
  };
}

export async function getCustomer(customerId) {
  const c = await client().customers.retrieve(customerId);
  return { id: c.id, name: c.name, email: c.email };
}

/**
 * Full refund only. Partial refunds stack silently across different
 * idempotency keys — verified 2026-09-12, see PLAN.md. The idempotency key is
 * the journal's op_key, so a retry of the same approved plan reuses it.
 */
export async function refundFull(chargeId, idempotencyKey) {
  const r = await client().refunds.create(
    { charge: chargeId, reason: 'duplicate' },
    { idempotencyKey }
  );
  return { id: r.id, status: r.status, amount: r.amount, charge: r.charge };
}

/** Customers arrive by email, not by id — the console never picks for them. */
export async function findCustomerByEmail(email) {
  const res = await client().customers.list({ email: email.trim().toLowerCase(), limit: 1 });
  const c = res.data[0];
  return c ? { id: c.id, name: c.name, email: c.email } : null;
}

/** Hard limits the model cannot change. */
export const CHARGE_SEARCH = { maxPerCall: 10, maxLookbackDays: 365 };

const toCharge = (c) => ({
  id: c.id,
  amount: c.amount,
  currency: c.currency,
  description: c.description,
  status: c.status,
  created: c.created,
  created_iso: new Date(c.created * 1000).toISOString(),
  refunded: c.refunded,
  amount_refunded: c.amount_refunded,
});

/**
 * One page of THIS customer's charges, newest first. The customer id is
 * supplied by code from the email match, never by the model. `cursor` pages
 * older (a charge id, so same-second charges page correctly); optional date
 * bounds narrow the window but can never reach past the lookback limit.
 */
export async function searchCharges(customerId, { cursor, created_after, created_before, limit } = {}) {
  const floor = Math.floor(Date.now() / 1000) - CHARGE_SEARCH.maxLookbackDays * 86400;
  const parse = (d) => (d ? Math.floor(Date.parse(d) / 1000) : NaN);
  const gte = Math.max(floor, Number.isFinite(parse(created_after)) ? parse(created_after) : floor);
  const created = { gte };
  if (Number.isFinite(parse(created_before))) created.lt = parse(created_before);

  const params = {
    customer: customerId,
    limit: Math.max(1, Math.min(CHARGE_SEARCH.maxPerCall, Number(limit) || CHARGE_SEARCH.maxPerCall)),
    created,
  };
  if (cursor && /^ch_[A-Za-z0-9]+$/.test(cursor)) params.starting_after = cursor;

  const res = await client().charges.list(params);
  const charges = res.data.map(toCharge);
  return {
    charges,
    has_more: res.has_more,
    next_cursor: res.has_more && charges.length ? charges[charges.length - 1].id : null,
    window: { from: new Date(gte * 1000).toISOString().slice(0, 10), to: created.lt ? new Date(created.lt * 1000).toISOString().slice(0, 10) : 'now' },
  };
}
