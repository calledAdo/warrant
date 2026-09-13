import Stripe from 'stripe';
import {
  sqliteProviderEnabled, findDemoCustomerByEmail, getDemoCustomer, getDemoCharge,
  listDemoCharges, refundDemoCharge,
} from '../demo-store.js';

let _client;
const client = () => {
  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new Error('Warrant requires a Stripe test-mode key');
  return (_client ??= new Stripe(process.env.STRIPE_SECRET_KEY));
};

const billingKeys = (c) => {
  const metadata = c.metadata || {};
  const value = x => typeof x === 'string' && x.trim() ? x.trim() : null;
  const invoice = value(typeof c.invoice === 'string' ? c.invoice : c.invoice?.id);
  const paymentIntent = typeof c.payment_intent === 'object' ? c.payment_intent : null;
  return [
    invoice && `invoice:${invoice}`,
    value(metadata.order_id) && `order:${value(metadata.order_id)}`,
    value(metadata.checkout_session_id) && `checkout:${value(metadata.checkout_session_id)}`,
    value(metadata.invoice_id) && `invoice:${value(metadata.invoice_id)}`,
    value(paymentIntent?.metadata?.order_id) && `order:${value(paymentIntent.metadata.order_id)}`,
  ].filter(Boolean);
};

const toCharge = (c) => ({
  id: c.id, customer: c.customer, amount: c.amount, currency: c.currency,
  description: c.description, status: c.status, created: c.created,
  created_iso: new Date(c.created * 1000).toISOString(), refunded: c.refunded,
  amount_refunded: c.amount_refunded, billing_keys: billingKeys(c),
});

export async function listCharges(customerId, limit = 20) {
  if (sqliteProviderEnabled()) return listDemoCharges(customerId, { limit }).charges;
  const res = await client().charges.list({ customer: customerId, limit });
  return res.data.map(toCharge);
}

export async function getCharge(chargeId) {
  if (sqliteProviderEnabled()) return getDemoCharge(chargeId);
  const c = await client().charges.retrieve(chargeId);
  return toCharge(c);
}

export async function getCustomer(customerId) {
  if (sqliteProviderEnabled()) return getDemoCustomer(customerId);
  const c = await client().customers.retrieve(customerId);
  return { id: c.id, name: c.name, email: c.email };
}

/**
 * Full refund only. Partial refunds stack silently across different
 * idempotency keys — verified 2026-09-12, see PLAN.md. The idempotency key is
 * the journal's op_key, so a retry of the same approved plan reuses it.
 */
export async function refundFull(chargeId, amount, idempotencyKey) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('refund amount must be a positive integer');
  if (sqliteProviderEnabled()) return refundDemoCharge(chargeId, amount, idempotencyKey);
  let r;
  try {
    r = await client().refunds.create(
    { charge: chargeId, amount, reason: 'duplicate' },
    { idempotencyKey }
    );
  } catch(error) {
    error.definitiveRejection = error.statusCode >= 400 && error.statusCode < 500 && ![408,409].includes(error.statusCode);
    throw error;
  }
  const result = { id: r.id, status: r.status, amount: r.amount, charge: r.charge };
  if (result.amount !== amount || result.charge !== chargeId || result.status !== 'succeeded') {
    throw new Error('refund provider response did not match the approved operation');
  }
  return result;
}

/** Customers arrive by email, not by id — the console never picks for them. */
export async function findCustomerByEmail(email) {
  if (sqliteProviderEnabled()) return findDemoCustomerByEmail(email);
  const res = await client().customers.list({ email: email.trim().toLowerCase(), limit: 1 });
  const c = res.data[0];
  return c ? { id: c.id, name: c.name, email: c.email } : null;
}

/** Hard limits the model cannot change. */
export const CHARGE_SEARCH = { maxPerCall: 10, maxLookbackDays: 365 };

/**
 * One page of THIS customer's charges, newest first. The customer id is
 * supplied by code from the email match, never by the model. `cursor` pages
 * older (a charge id, so same-second charges page correctly); optional date
 * bounds narrow the window but can never reach past the lookback limit.
 */
export async function searchCharges(customerId, { cursor, created_after, created_before, limit } = {}) {
  if (sqliteProviderEnabled()) return listDemoCharges(customerId, { cursor, created_after, created_before, limit });
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
