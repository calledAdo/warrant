import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const url = process.env.ZETARIS_REST_URL;
const headers = {
  Authorization: 'Bearer ' + process.env.ZETARIS_API_KEY,
  'X-Org-ID': process.env.ZETARIS_ORG_ID ?? '1',
  'Content-Type': 'application/json',
};

async function runSql(sql, note) {
  const res = await fetch(url + '/sql-editor/sqls/run', {
    method: 'POST',
    headers: { ...headers, 'X-Request-ID': randomUUID() },
    body: JSON.stringify({ queryId: randomUUID(), sql, source: 'SqlEditor', limit: 10 }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  console.log(note, '→', res.status);
  if (body.error) console.log('  error:', body.error);
  if (body.data) console.log('  rows:', body.data.length);
  return body;
}

// 1. Create database `warrant` in Postgres (already done via docker exec)
// 2. Create evidence tables in that database
console.log('=== Creating evidence tables in warrant database ===');

await runSql(`
  CREATE TABLE IF NOT EXISTS warrant.billing_history (
    id BIGSERIAL PRIMARY KEY,
    customer_id TEXT NOT NULL,
    stripe_charge_id TEXT UNIQUE NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    refunded BOOLEAN NOT NULL DEFAULT FALSE,
    refund_id TEXT,
    refunded_at TIMESTAMPTZ,
    description TEXT,
    metadata JSONB
  )
`, 'billing_history');

await runSql(`
  CREATE INDEX IF NOT EXISTS idx_billing_customer ON warrant.billing_history (customer_id, created_at DESC)
`, 'billing_history index');

await runSql(`
  CREATE TABLE IF NOT EXISTS warrant.engineering_incidents (
    id BIGSERIAL PRIMARY KEY,
    github_issue_number INTEGER UNIQUE NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    labels TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ,
    body TEXT,
    assignees TEXT[] NOT NULL DEFAULT '{}'
  )
`, 'engineering_incidents');

await runSql(`
  CREATE TABLE IF NOT EXISTS warrant.case_history (
    id BIGSERIAL PRIMARY KEY,
    case_id TEXT UNIQUE NOT NULL,
    customer_id TEXT NOT NULL,
    complaint_text TEXT NOT NULL,
    finding TEXT NOT NULL,
    finding_reason TEXT,
    proposal JSONB,
    approver_decision TEXT,
    approver_reason TEXT,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`, 'case_history');

await runSql(`
  CREATE INDEX IF NOT EXISTS idx_case_customer ON warrant.case_history (customer_id, created_at DESC)
`, 'case_history index');

console.log('=== Registering Zetaris sources ===');

// Register sources - we'll use the admin API
// For now, let's test a query against the warrant database through Zetaris
const test = await runSql('SELECT COUNT(*) FROM warrant.billing_history', 'test query');
console.log('Test query result:', test.data);

