/**
 * Builds a scenario's starting state in the Stripe sandbox and GitHub repo.
 * Run before each demo take — S1 refunds a charge, so it can't be replayed
 * against the same customer.
 *
 *   node fixtures/build.mjs --scenario s1
 *   node fixtures/build.mjs --scenario s2
 *   node fixtures/build.mjs --all
 *
 * Writes fixtures/current.json, which the console reads to populate its
 * one-click report buttons.
 */
import 'dotenv/config';
import Stripe from 'stripe';
import { writeFileSync, mkdirSync } from 'node:fs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const GH = { token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPO };

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i === -1 ? d : process.argv[i + 1] ?? true;
};
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

/** Every seeded record is tagged, so nothing here can be mistaken for real data. */
const FIXTURE_TAG = { warrant_fixture: 'true', warrant_seeded_at: new Date().toISOString() };

async function charge(customer, amount, description) {
  const pi = await stripe.paymentIntents.create({
    amount, currency: 'usd', customer, description,
    payment_method: 'pm_card_visa', confirm: true, payment_method_types: ['card'],
    metadata: FIXTURE_TAG,
  });
  return { id: pi.latest_charge, amount, description, created: pi.created };
}

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GH.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.json()).message}`);
  return res.json();
}

/** S1 — a genuine duplicate, corroborated by an incident. The agent should act. */
async function s1() {
  head('S1 — Northwind: genuine duplicate');
  const customer = await stripe.customers.create({
    name: 'Northwind Trading Co. (SEEDED FIXTURE)',
    email: 'billing@northwind.test',
    metadata: { ...FIXTURE_TAG, scenario: 's1' },
  });
  const a = await charge(customer.id, 4900, 'Invoice SEP-2026 — Pro plan');
  const b = await charge(customer.id, 4900, 'Invoice SEP-2026 — Pro plan');
  ok(`customer ${customer.id}`);
  ok(`two charges ${a.id} / ${b.id} — $49.00 each, ${b.created - a.created}s apart`);

  const incident = await gh(`/repos/${GH.repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: `Billing: retry loop double-submitted invoices on ${new Date().toISOString().slice(0, 10)}`,
      body:
        'The invoice retry worker re-submitted PaymentIntents that had already succeeded.\n\n' +
        'Window: today, ~7 minutes. Symptom: two identical succeeded charges, seconds apart.\n\n' +
        '_Seeded fixture — not a real incident._',
      labels: ['incident', 'billing'],
    }),
  });
  ok(`corroborating incident #${incident.number}`);

  return {
    scenario: 's1',
    label: 'Northwind — billed twice',
    report: '"We were billed twice for September." — Northwind Trading Co.',
    customer_id: customer.id,
    expect: 'refund',
    charges: [a, b],
    incident: incident.number,
  };
}

/** S2 — two legitimate charges. The agent must refuse. This is the demo. */
async function s2() {
  head('S2 — Harbor: NOT a duplicate (the refusal case)');
  const customer = await stripe.customers.create({
    name: 'Harbor Logistics LLC (SEEDED FIXTURE)',
    email: 'ap@harbor.test',
    metadata: { ...FIXTURE_TAG, scenario: 's2' },
  });
  const a = await charge(customer.id, 4900, 'Invoice SEP-2026 — Pro plan');
  const b = await charge(customer.id, 7300, 'Invoice SEP-2026 — overage, 480 extra seats');
  ok(`customer ${customer.id}`);
  ok(`$49.00 and $73.00 — different amounts, different services`);
  ok('no corroborating incident seeded — the agent has nothing to stand on');

  return {
    scenario: 's2',
    label: 'Harbor — billed twice',
    report: '"We were billed twice for September." — Harbor Logistics LLC',
    customer_id: customer.id,
    expect: 'refuse',
    charges: [a, b],
    incident: null,
  };
}

const BUILDERS = { s1, s2 };

async function main() {
  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
    console.error('\nSTRIPE_SECRET_KEY must be a sk_test_ key.\n');
    process.exit(1);
  }

  const which = arg('all', false) ? ['s1', 's2'] : [arg('scenario', 's1')];
  const built = [];
  for (const s of which) {
    if (!BUILDERS[s]) { console.error(`unknown scenario: ${s}`); process.exit(1); }
    built.push(await BUILDERS[s]());
  }

  mkdirSync('fixtures', { recursive: true });
  writeFileSync('fixtures/current.json', JSON.stringify({ built_at: new Date().toISOString(), scenarios: built }, null, 2));

  head('Ready');
  for (const b of built) {
    console.log(`  ${b.scenario}  ${b.customer_id}  expect: ${b.expect.toUpperCase()}`);
  }
  console.log('\n  fixtures/current.json written — the console reads this for its report buttons.\n');
}

main().catch((e) => { console.error(`\n\x1b[31m${e.message}\x1b[0m\n`); process.exit(1); });
