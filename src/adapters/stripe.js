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
