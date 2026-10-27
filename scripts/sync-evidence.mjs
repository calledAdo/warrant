/**
 * Feeds Warrant's evidence into the local Zetaris sources (read-only wrt
 * external apps; bounded test-mode calls only).
 *
 *   1. Stripe test-mode billing snapshot -> SeaweedFS lotline/warrant/stripe/...
 *   2. GitHub incident snapshot          -> SeaweedFS lotline/warrant/github/...
 *   3. Warrant's own case history (SQLite) -> Postgres `warrant`.wr_cases
 *   4. Demo data -> Postgres `warrant` tables for Zetaris (billing_history, engineering_incidents, case_history)
 *
 * Source selection follows WARRANT_PROVIDER: `live` reads real Stripe test
 * mode + GitHub (only lists, nothing written); `sqlite` reads the local demo
 * store. Run before npm run setup:zetaris, and again (evidence:sync) whenever
 * newly closed Warrant cases or Stripe charges should appear in Zetaris.
 */
import 'dotenv/config';
import { S3 } from '@aws-sdk/client-s3';
import pg from 'pg';
import { db } from '../src/storage.js';
import { sqliteProviderEnabled } from '../src/demo-store.js';

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(1); } return v; };
const s3 = new S3({ endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: need('S3_ACCESS_KEY'), secretAccessKey: need('S3_SECRET_KEY') } });
// Snapshots are JSON arrays: Zetaris reads a JSON file as one document, so JSON Lines would be one row.
const put = async (key, body) => { await s3.putObject({ Bucket: 'lotline', Key: key, Body: body }); console.log(`s3a://lotline/${key}: uploaded`); };
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };

const toChargeRow = (c) => ({
  id: c.id,
  customer_id: c.customer,
  amount: c.amount,
  currency: c.currency,
  description: c.description ?? null,
  status: c.status,
  created: c.created,
  amount_refunded: c.amount_refunded ?? 0,
  billing_keys: (c.billing_keys ?? []).join(','),
});
const toIncidentRow = (i) => ({
  number: i.number,
  title: i.title,
  body: i.body ?? '',
  created_at: i.created_iso,
  coverage_start: i.coverage_start_iso ?? null,
  coverage_end: i.coverage_end_iso ?? null,
  billing_keys: (i.billing_keys ?? []).join(','),
});

function demoSnapshot() {
  const customers = db.prepare('SELECT * FROM demo_customers').all().map((r) => ({ id: r.id, name: r.name, email: r.email }));
  const charges = db.prepare('SELECT * FROM demo_charges ORDER BY created DESC LIMIT 100').all().map((r) => ({
    id: r.id, customer: r.customer_id, amount: r.amount, currency: r.currency,
    description: r.description, status: r.status, created: r.created,
    amount_refunded: r.amount_refunded, refunded: r.amount_refunded === r.amount,
    billing_keys: JSON.parse(r.billing_keys || '[]'),
  }));
  const incidents = db.prepare('SELECT * FROM demo_incidents ORDER BY created_at DESC LIMIT 50').all()
    .map((r) => ({ number: r.number, title: r.title, body: r.body, created_iso: r.created_at, url: r.url, billing_keys: [] }));
  return { charges, customers, incidents };
}

async function liveSnapshot() {
  const { default: Stripe } = await import('stripe');
  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new Error('live evidence snapshot requires a Stripe TEST-MODE key');
  const client = new Stripe(process.env.STRIPE_SECRET_KEY);
  // Bounded reads only: newest 100 charges of the past year, up to 10 customers.
  const createdFloor = Math.floor(Date.now() / 1000) - 365 * 86400;
  const chargeRes = await client.charges.list({ limit: 100, created: { gte: createdFloor } });
  const customerIds = [...new Set(chargeRes.data.map((c) => c.customer).filter(Boolean))].slice(0, 10);
  const customers = [];
  for (const id of customerIds) {
    const c = await client.customers.retrieve(id).catch(() => null);
    if (c) customers.push({ id: c.id, name: c.name, email: c.email });
  }
  const charges = chargeRes.data.map((c) => ({
    id: c.id,
    customer: c.customer,
    amount: c.amount,
    currency: c.currency,
    description: c.description ?? null,
    status: c.status,
    created: c.created,
    amount_refunded: c.amount_refunded ?? 0,
    refunded: c.refunded,
    billing_keys: [
      typeof c.invoice === 'string' ? `invoice:${c.invoice}` : c.invoice?.id ? `invoice:${c.invoice.id}` : null,
      c.metadata?.order_id ? `order:${c.metadata.order_id}` : null,
      c.metadata?.checkout_session_id ? `checkout:${c.metadata.checkout_session_id}` : null,
    ].filter(Boolean),
  }));
  const incidents = [];
  const REPO = process.env.GITHUB_REPO;
  if (REPO && process.env.GITHUB_TOKEN) {
    for (let page = 1; page <= 2; page++) {
      const res = await fetch(`https://api.github.com/repos/${REPO}/issues?labels=incident&state=all&per_page=50&page=${page}`, {
        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      }).then((r) => r.json()).catch(() => []);
      const list = Array.isArray(res) ? res : [];
      for (const i of list) incidents.push({ number: i.number, title: i.title, body: (i.body || '').slice(0, 900), created_iso: i.created_at, url: i.html_url, billing_keys: [] });
      if (list.length < 50) break;
    }
  }
  return { charges, customers, incidents };
}

async function syncZetarisTables(charges, customers, incidents) {
  const client = new pg.Client({ host: '127.0.0.1', port: 55433, database: 'warrant', user: need('WARRANT_DB_USER'), password: need('WARRANT_DB_PASSWORD') });
  await client.connect();

  // Sync billing_history
  let billingSynced = 0;
  for (const c of charges) {
    const createdAt = new Date(c.created * 1000).toISOString();
    const metadata = c.billing_keys && c.billing_keys.length ? JSON.stringify({ billing_keys: c.billing_keys }) : '{}';
    await client.query(
      `INSERT INTO billing_history (customer_id, stripe_charge_id, amount, currency, status, created_at, refunded, refund_id, refunded_at, description, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (stripe_charge_id) DO UPDATE SET
         customer_id = EXCLUDED.customer_id,
         amount = EXCLUDED.amount,
         currency = EXCLUDED.currency,
         status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         refunded = EXCLUDED.refunded,
         refund_id = EXCLUDED.refund_id,
         refunded_at = EXCLUDED.refunded_at,
         description = EXCLUDED.description,
         metadata = EXCLUDED.metadata`,
      [c.customer, c.id, c.amount, c.currency, c.status, createdAt, c.refunded, c.amount_refunded === c.amount ? `re_${c.id}` : null, c.refunded ? createdAt : null, c.description, metadata]
    );
    billingSynced++;
  }
  console.log(`postgres warrant.billing_history: ${billingSynced} row(s) synced`);

  // Sync engineering_incidents
  let incidentSynced = 0;
  for (const i of incidents) {
    await client.query(
      `INSERT INTO engineering_incidents (github_issue_number, title, state, labels, created_at, closed_at, body, assignees)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (github_issue_number) DO UPDATE SET
         title = EXCLUDED.title,
         state = EXCLUDED.state,
         labels = EXCLUDED.labels,
         created_at = EXCLUDED.created_at,
         closed_at = EXCLUDED.closed_at,
         body = EXCLUDED.body,
         assignees = EXCLUDED.assignees`,
      [i.number, i.title, 'open', '{}', i.created_iso, null, i.body, '{}']
    );
    incidentSynced++;
  }
  console.log(`postgres warrant.engineering_incidents: ${incidentSynced} row(s) synced`);

  // Sync case_history from complaint/runs
  const complaintRows = db.prepare('SELECT * FROM complaints ORDER BY created_at').all();
  const runRows = Object.fromEntries(db.prepare('SELECT * FROM runs').all().map((r) => [r.id, safeParse(r.state)]));
  let caseSynced = 0;
  for (const c of complaintRows) {
    const run = c.run_id ? runRows[c.run_id] : null;
    const findingReason = run?.finding?.grounds ?? null;
    const proposal = run?.plan ? JSON.stringify(run.plan) : null;
    const approverDecision = run?.approver ? (run?.declineReason ? 'decline' : 'approve') : null;
    const approverReason = run?.declineReason ?? null;
    const decidedAt = run?.approver ? new Date().toISOString() : null;
    await client.query(
      `INSERT INTO case_history (case_id, customer_id, complaint_text, finding, finding_reason, proposal, approver_decision, approver_reason, decided_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (case_id) DO UPDATE SET
         customer_id = EXCLUDED.customer_id,
         complaint_text = EXCLUDED.complaint_text,
         finding = EXCLUDED.finding,
         finding_reason = EXCLUDED.finding_reason,
         proposal = EXCLUDED.proposal,
         approver_decision = EXCLUDED.approver_decision,
         approver_reason = EXCLUDED.approver_reason,
         decided_at = EXCLUDED.decided_at,
         created_at = EXCLUDED.created_at`,
      [`${c.id}:${c.run_id ?? 'none'}`, c.email, c.email, run?.finding?.verdict ?? 'insufficient_evidence', findingReason, proposal, approverDecision, approverReason, decidedAt, c.created_at]
    );
    caseSynced++;
  }
  console.log(`postgres warrant.case_history: ${caseSynced} row(s) synced`);

  await client.end();
}

async function syncCaseHistory() {
  const client = new pg.Client({ host: '127.0.0.1', port: 55433, database: 'warrant', user: need('WARRANT_DB_USER'), password: need('WARRANT_DB_PASSWORD') });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS wr_cases (
    case_id TEXT PRIMARY KEY, run_id TEXT, complaint_id TEXT,
    customer_email TEXT, customer_name TEXT, created_at TEXT,
    status TEXT, outcome TEXT, verdict TEXT, decision TEXT, approver TEXT,
    decline_reason TEXT, grounds TEXT,
    updated_at TEXT NOT NULL DEFAULT (now()::text))`);
  const complaintRows = db.prepare('SELECT * FROM complaints ORDER BY created_at').all();
  const runRows = Object.fromEntries(db.prepare('SELECT * FROM runs').all().map((r) => [r.id, safeParse(r.state)]));
  let synced = 0;
  for (const c of complaintRows) {
    const run = c.run_id ? runRows[c.run_id] : null;
    await client.query(
      `INSERT INTO wr_cases (case_id, run_id, complaint_id, customer_email, customer_name, created_at, status, outcome, verdict, decision, approver, decline_reason, grounds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (case_id) DO UPDATE SET
         status = EXCLUDED.status, outcome = EXCLUDED.outcome, verdict = EXCLUDED.verdict,
         decision = EXCLUDED.decision, approver = EXCLUDED.approver,
         decline_reason = EXCLUDED.decline_reason, grounds = EXCLUDED.grounds,
         updated_at = now()::text`,
      [`${c.id}:${c.run_id ?? 'none'}`, c.run_id ?? null, c.id, c.email, c.customer_name ?? null, c.created_at,
        run?.status ?? null, run?.finding?.outcome ?? null, run?.finding?.verdict ?? null,
        run?.approver ? (run?.declineReason ? 'decline' : 'approve') : null,
        run?.approver ?? null, run?.declineReason ?? null, run?.finding?.grounds ?? null],
    );
    synced++;
  }
  const count = await client.query('SELECT count(*) AS n FROM wr_cases');
  console.log(`postgres warrant.wr_cases: ${synced} row(s) synced, ${count.rows[0].n} total`);
  await client.end();
}

await (async () => {
  const { charges, customers, incidents } = sqliteProviderEnabled() ? demoSnapshot() : await liveSnapshot();
  await put('warrant/stripe/charges/part-0000.json', JSON.stringify(charges.map(toChargeRow)));
  await put('warrant/stripe/customers/part-0000.json', JSON.stringify(customers));
  await put('warrant/github/incidents/part-0000.json', JSON.stringify(incidents.map(toIncidentRow)));
  console.log(`snapshots: ${charges.length} charge(s), ${customers.length} customer(s), ${incidents.length} incident(s)`);
  await syncZetarisTables(charges, customers, incidents);
  await syncCaseHistory();
})().catch((e) => { console.error(e.message); process.exit(1); });