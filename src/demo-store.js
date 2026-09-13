import { randomUUID } from 'node:crypto';
import { db } from './storage.js';

export const sqliteProviderEnabled = () => process.env.WARRANT_PROVIDER === 'sqlite';

db.exec(`
CREATE TABLE IF NOT EXISTS demo_customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS demo_charges (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, amount INTEGER NOT NULL,
  currency TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
  created INTEGER NOT NULL, amount_refunded INTEGER NOT NULL DEFAULT 0,
  refund_id TEXT, billing_keys TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS demo_charges_customer_created
  ON demo_charges(customer_id, created DESC, id DESC);
CREATE TABLE IF NOT EXISTS demo_incidents (
  number INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL, url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS demo_cases (
  number INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
  labels TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS demo_case_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_number INTEGER NOT NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS demo_notifications (
  ts TEXT PRIMARY KEY, channel TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
`);

const chargeView = row => row && ({
  id: row.id,
  customer: row.customer_id,
  amount: row.amount,
  currency: row.currency,
  description: row.description,
  status: row.status,
  created: row.created,
  created_iso: new Date(row.created * 1000).toISOString(),
  refunded: row.amount_refunded === row.amount,
  amount_refunded: row.amount_refunded,
  billing_keys: JSON.parse(row.billing_keys || '[]'),
});

export function resetDemoProvider() {
  db.exec(`DELETE FROM demo_notifications; DELETE FROM demo_case_comments;
    DELETE FROM demo_cases; DELETE FROM demo_incidents; DELETE FROM demo_charges;
    DELETE FROM demo_customers; DELETE FROM sqlite_sequence
    WHERE name IN ('demo_incidents','demo_cases','demo_case_comments');`);
}

export function seedS1Provider() {
  const existing = db.prepare('SELECT id FROM demo_customers WHERE email=?').get('billing@northwind.test');
  if (existing) return demoStatus();
  const now = Math.floor(Date.now() / 1000);
  const customer = { id: 'cus_demo_northwind', name: 'Northwind Trading Co.', email: 'billing@northwind.test' };
  db.prepare('INSERT INTO demo_customers VALUES (?,?,?)').run(customer.id, customer.name, customer.email);
  const insert = db.prepare(`INSERT INTO demo_charges
    (id,customer_id,amount,currency,description,status,created,amount_refunded,billing_keys)
    VALUES (?,?,?,?,?,'succeeded',?,0,'[]')`);
  insert.run('ch_demo_northwind_01', customer.id, 4900, 'usd', 'Invoice SEP-2026 - Pro plan', now - 61);
  insert.run('ch_demo_northwind_02', customer.id, 4900, 'usd', 'Invoice SEP-2026 - Pro plan', now - 18);
  const createdAt = new Date((now - 120) * 1000).toISOString();
  db.prepare('INSERT INTO demo_incidents (title,body,created_at,url) VALUES (?,?,?,?)').run(
    'Billing retry duplicated successful payments',
    'The invoice retry worker re-submitted payments that had already succeeded. Symptom: two identical succeeded charges seconds apart.',
    createdAt,
    '/admin#incident-1',
  );
  return demoStatus();
}

export function demoStatus() {
  const customer = db.prepare('SELECT * FROM demo_customers WHERE email=?').get('billing@northwind.test') || null;
  const charges = customer
    ? db.prepare('SELECT * FROM demo_charges WHERE customer_id=? ORDER BY created,id').all(customer.id).map(chargeView)
    : [];
  return { mode: 'sqlite', scenario: 's1', customer, charges };
}

export const findDemoCustomerByEmail = email => {
  const row = db.prepare('SELECT * FROM demo_customers WHERE lower(email)=lower(?)').get(String(email).trim());
  return row || null;
};
export const getDemoCustomer = id => db.prepare('SELECT * FROM demo_customers WHERE id=?').get(id) || null;
export const getDemoCharge = id => chargeView(db.prepare('SELECT * FROM demo_charges WHERE id=?').get(id));

export function listDemoCharges(customerId, { cursor, created_after, created_before, limit = 10 } = {}) {
  let rows = db.prepare('SELECT * FROM demo_charges WHERE customer_id=? ORDER BY created DESC,id DESC').all(customerId);
  const after = created_after ? Date.parse(created_after) / 1000 : NaN;
  const before = created_before ? Date.parse(created_before) / 1000 : NaN;
  if (Number.isFinite(after)) rows = rows.filter(row => row.created >= after);
  if (Number.isFinite(before)) rows = rows.filter(row => row.created < before);
  if (cursor) {
    const index = rows.findIndex(row => row.id === cursor);
    rows = index < 0 ? [] : rows.slice(index + 1);
  }
  const size = Math.max(1, Math.min(10, Number(limit) || 10));
  const page = rows.slice(0, size).map(chargeView);
  return {
    charges: page,
    has_more: rows.length > size,
    next_cursor: rows.length > size ? page.at(-1)?.id || null : null,
    window: {
      from: Number.isFinite(after) ? new Date(after * 1000).toISOString().slice(0, 10) : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10),
      to: Number.isFinite(before) ? new Date(before * 1000).toISOString().slice(0, 10) : 'now',
    },
  };
}

export function refundDemoCharge(chargeId, amount) {
  const charge = getDemoCharge(chargeId);
  if (!charge) throw Object.assign(new Error('charge not found'), { definitiveRejection: true });
  if (charge.status !== 'succeeded' || charge.amount_refunded > 0 || charge.amount !== amount) {
    throw Object.assign(new Error('charge is not eligible for this full refund'), { definitiveRejection: true });
  }
  const id = `re_demo_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  db.prepare('UPDATE demo_charges SET amount_refunded=?,refund_id=? WHERE id=? AND amount_refunded=0')
    .run(amount, id, chargeId);
  return { id, status: 'succeeded', amount, charge: chargeId };
}

const incidentView = row => ({
  number: row.number, title: row.title, body: row.body, created_iso: row.created_at, url: row.url,
  coverage_start_iso: null, coverage_end_iso: null, billing_keys: [],
});
export const demoIncidents = () =>
  db.prepare('SELECT * FROM demo_incidents ORDER BY created_at DESC').all().map(incidentView);

export function createDemoCase({ title, body, labels }) {
  const result = db.prepare('INSERT INTO demo_cases (title,body,labels,created_at) VALUES (?,?,?,?)')
    .run(title, body, JSON.stringify(labels || ['billing-case']), new Date().toISOString());
  return { number: Number(result.lastInsertRowid), url: `/admin#case-${result.lastInsertRowid}` };
}
export function updateDemoCase(number, body) {
  db.prepare('UPDATE demo_cases SET body=? WHERE number=?').run(body, number);
  return { number: Number(number), url: `/admin#case-${number}` };
}
export function commentDemoCase(number, body) {
  const result = db.prepare('INSERT INTO demo_case_comments (case_number,body,created_at) VALUES (?,?,?)')
    .run(number, body, new Date().toISOString());
  return { id: Number(result.lastInsertRowid), url: `/admin#case-${number}` };
}
export function getDemoCase(number) {
  const row = db.prepare('SELECT * FROM demo_cases WHERE number=?').get(number);
  return row ? { number: row.number, title: row.title, body: row.body, url: `/admin#case-${number}`, state: 'open' } : null;
}

export function createDemoNotification(kind, payload) {
  const ts = String(Date.now() / 1000);
  const channel = 'demo-billing-approvals';
  db.prepare('INSERT INTO demo_notifications VALUES (?,?,?,?,?)')
    .run(ts, channel, kind, JSON.stringify(payload), new Date().toISOString());
  return { ts, channel };
}
export function updateDemoNotification(channel, ts, kind, payload) {
  db.prepare('UPDATE demo_notifications SET kind=?,payload=?,updated_at=? WHERE channel=? AND ts=?')
    .run(kind, JSON.stringify(payload), new Date().toISOString(), channel, ts);
  return { ts };
}
