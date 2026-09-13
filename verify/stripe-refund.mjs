/**
 * Settles the central assumption of the Warrant plan:
 *
 *   1. Can we manufacture a duplicate-charge fixture cheaply?      (2 confirmed PaymentIntents)
 *   2. Is the refund a single call with an unambiguous readback?   (charge.refunded / amount_refunded)
 *   3. Does Idempotency-Key actually prevent a double refund?      (replay with SAME key)
 *   4. What happens with a DIFFERENT key?                          (<- the finding that matters)
 *
 * Run:  npm run verify:stripe
 * Costs: nothing. Test mode only. The script refuses a live key.
 */
import 'dotenv/config';
import Stripe from 'stripe';

const KEY = process.env.STRIPE_SECRET_KEY;
const AMOUNT = 4900;           // $49.00
const CURRENCY = 'usd';

const log = (...a) => console.log(...a);
const pass = (m) => log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m) => log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const note = (m) => log(`  \x1b[33mNOTE\x1b[0m  ${m}`);
const head = (m) => log(`\n\x1b[1m${m}\x1b[0m`);

if (!KEY || !KEY.startsWith('sk_test_')) {
  console.error('\nSTRIPE_SECRET_KEY must be set and must start with sk_test_.');
  console.error('Copy .env.example to .env and paste a TEST mode key.\n');
  process.exit(1);
}

const stripe = new Stripe(KEY);
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  (ok ? pass : fail)(`${name}${detail ? ` — ${detail}` : ''}`);
};

/** Create a confirmed, succeeded charge. This is one half of the duplicate fixture. */
async function makeCharge(customer, description) {
  const pi = await stripe.paymentIntents.create({
    amount: AMOUNT,
    currency: CURRENCY,
    customer,
    description,
    payment_method: 'pm_card_visa',
    confirm: true,
    // Card only, and never bounce to a redirect flow — keeps this a single call.
    payment_method_types: ['card'],
  });
  return pi;
}

async function main() {
  head('0. Fixture — a customer and two identical charges');

  const customer = await stripe.customers.create({
    name: 'Northwind Trading Co.',
    email: 'billing@northwind.test',
    metadata: { warrant_fixture: 'S1_duplicate' },
  });
  log(`  customer: ${customer.id}`);

  const t0 = Date.now();
  const piA = await makeCharge(customer.id, 'Invoice SEP-2026 — Pro plan');
  const piB = await makeCharge(customer.id, 'Invoice SEP-2026 — Pro plan');
  const fixtureMs = Date.now() - t0;

  const chargeA = piA.latest_charge;
  const chargeB = piB.latest_charge;

  record(
    'Two confirmed PaymentIntents in one call each',
    piA.status === 'succeeded' && piB.status === 'succeeded',
    `${piA.status} / ${piB.status}, ${fixtureMs}ms total`
  );
  record('latest_charge present on both', Boolean(chargeA && chargeB), `${chargeA} / ${chargeB}`);
  log(`  duplicate pair: ${piA.id} (${chargeA})  +  ${piB.id} (${chargeB})`);

  head('1. The agent reads back what it would investigate');

  const listed = await stripe.charges.list({ customer: customer.id, limit: 10 });
  const sameAmount = listed.data.filter((c) => c.amount === AMOUNT && c.status === 'succeeded');
  record(
    'charges.list surfaces the duplicate pair',
    sameAmount.length === 2,
    `${sameAmount.length} succeeded charges at ${AMOUNT} ${CURRENCY}`
  );
  const gapSeconds = Math.abs(sameAmount[0].created - sameAmount[1].created);
  log(`  created ${gapSeconds}s apart — the signal the agent reasons over`);

  head('2. The remedy — one refund of charge B');

  const approvedPlanId = `warrant_${customer.id}_${chargeB}_refund`;
  const refund1 = await stripe.refunds.create(
    { charge: chargeB, reason: 'duplicate' },
    { idempotencyKey: approvedPlanId }
  );
  record('Refund created', refund1.status === 'succeeded', `${refund1.id} ${refund1.status} ${refund1.amount}`);

  let chargeBState = await stripe.charges.retrieve(chargeB);
  record(
    'Readback is unambiguous',
    chargeBState.refunded === true && chargeBState.amount_refunded === AMOUNT,
    `refunded=${chargeBState.refunded} amount_refunded=${chargeBState.amount_refunded}`
  );

  head('3. Replay with the SAME idempotency key');

  const refund2 = await stripe.refunds.create(
    { charge: chargeB, reason: 'duplicate' },
    { idempotencyKey: approvedPlanId }
  );
  record(
    'Same key returns the original refund, does not create a second',
    refund2.id === refund1.id,
    `${refund2.id} === ${refund1.id}`
  );

  chargeBState = await stripe.charges.retrieve(chargeB);
  record(
    'amount_refunded did not move',
    chargeBState.amount_refunded === AMOUNT,
    `amount_refunded=${chargeBState.amount_refunded}`
  );

  head('4. Replay with a DIFFERENT idempotency key — the case that matters');

  let secondRefundHappened = false;
  let secondRefundDetail = '';
  try {
    const refund3 = await stripe.refunds.create(
      { charge: chargeB, reason: 'duplicate' },
      { idempotencyKey: `${approvedPlanId}_retry_by_a_bug` }
    );
    secondRefundHappened = refund3.status === 'succeeded';
    secondRefundDetail = `${refund3.id} ${refund3.status} ${refund3.amount}`;
  } catch (err) {
    secondRefundDetail = `rejected: ${err.code || err.type} — ${err.message}`;
  }

  chargeBState = await stripe.charges.retrieve(chargeB);
  log(`  after attempt: amount_refunded=${chargeBState.amount_refunded} of ${chargeBState.amount}`);
  log(`  ${secondRefundDetail}`);

  if (secondRefundHappened) {
    note('Stripe ALLOWED a second refund on a different key.');
    note('=> The idempotency key alone does NOT protect you. Your journal must.');
  } else {
    note('Stripe REJECTED the over-refund itself (charge fully refunded).');
    note('=> Stripe is a backstop, but still journal: it only protects the FULL-refund case.');
  }
  record(
    'Behaviour on different-key replay is now KNOWN (either answer is fine — it drives the design)',
    true,
    secondRefundHappened ? 'second refund succeeded' : 'second refund blocked by Stripe'
  );

  head('5. Refusal case fixture (S2) — two legitimately distinct charges');

  const customer2 = await stripe.customers.create({
    name: 'Harbor Logistics LLC',
    email: 'ap@harbor.test',
    metadata: { warrant_fixture: 'S2_not_duplicate' },
  });
  const piC = await makeCharge(customer2.id, 'Invoice SEP-2026 — Pro plan');
  const piD = await stripe.paymentIntents.create({
    amount: 7300,
    currency: CURRENCY,
    customer: customer2.id,
    description: 'Invoice SEP-2026 — overage, 480 extra seats',
    payment_method: 'pm_card_visa',
    confirm: true,
    payment_method_types: ['card'],
  });
  record(
    'S2 fixture builds too',
    piC.status === 'succeeded' && piD.status === 'succeeded',
    `${piC.amount} and ${piD.amount} — different amounts, different reasons`
  );
  log(`  customer: ${customer2.id}  (the agent must REFUSE to refund either)`);

  head('Summary');
  const failed = results.filter((r) => !r.ok);
  for (const r of results) log(`  ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.name}`);
  log(`\n  ${results.length - failed.length}/${results.length} checks passed`);

  log('\n  Fixture IDs for reuse on Sunday:');
  log(`    S1 duplicate   customer=${customer.id}  keep=${chargeA}  refund=${chargeB}`);
  log(`    S2 distinct    customer=${customer2.id}`);

  if (failed.length) {
    log('\n  \x1b[31mThe refund plan has a problem. Read the failures above before committing.\x1b[0m\n');
    process.exit(1);
  }
  log('\n  \x1b[32mThe Stripe path holds. Refund remedy is viable.\x1b[0m\n');
}

main().catch((err) => {
  console.error('\n\x1b[31mUNEXPECTED ERROR\x1b[0m');
  console.error(`  ${err.type || err.name}: ${err.message}`);
  if (err.raw?.param) console.error(`  param: ${err.raw.param}`);
  console.error('\n  This is itself a finding. If it is a parameter error, the API shape');
  console.error('  differs from the plan and the script needs fixing before Sunday.\n');
  process.exit(1);
});
