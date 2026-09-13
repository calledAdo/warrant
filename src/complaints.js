/**
 * Complaints are the customer-facing object. A complaint owns a run; the run
 * owns the investigation. The customer sees the complaint's plain-language
 * state; the admin sees the run underneath it.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/warrant.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS complaints (
    id          TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    email       TEXT NOT NULL,
    body        TEXT NOT NULL,
    customer_id TEXT,
    customer_name TEXT,
    run_id      TEXT
  );
`);

const now = () => new Date().toISOString();
const rid = () => 'C-' + Math.random().toString(36).slice(2, 7).toUpperCase();

export function create({ email, body, customer }) {
  const id = rid();
  db.prepare(
    'INSERT INTO complaints (id, created_at, email, body, customer_id, customer_name) VALUES (?,?,?,?,?,?)'
  ).run(id, now(), email, body, customer?.id ?? null, customer?.name ?? null);
  return get(id);
}

export const get = (id) => db.prepare('SELECT * FROM complaints WHERE id = ?').get(id) ?? null;

export const all = () =>
  db.prepare('SELECT * FROM complaints ORDER BY created_at DESC LIMIT 50').all();

export function attachRun(id, runId) {
  db.prepare('UPDATE complaints SET run_id = ? WHERE id = ?').run(runId, id);
}

export const reset = () => db.exec('DELETE FROM complaints;');

/**
 * What the customer is allowed to see. Never provider ids, never the model's
 * reasoning, never the plan hash — only where their complaint has got to.
 */
export function customerView(c, run) {
  const s = run?.status ?? 'received';
  const stage = {
    received:           { step: 1, label: 'Received',        note: 'We have your report.' },
    running:            { step: 2, label: 'Investigating',   note: 'Checking your billing history and our incident records.' },
    awaiting_approval:  { step: 3, label: 'Under Review',    note: 'Our billing team is reviewing a proposed correction.' },
    approved:           { step: 3, label: 'Under Review',    note: 'Approved. Applying the correction now.' },
    executing:          { step: 3, label: 'Under Review',    note: 'Applying the correction now.' },
    complete:           { step: 4, label: 'Resolved',        note: 'A refund has been issued and verified.' },
    partial:            { step: 4, label: 'Resolved',        note: 'Your refund has been issued. We are finishing our internal records.' },
    declined:           { step: 4, label: 'Closed',          note: 'Our billing team reviewed this and did not issue a refund.' },
    refused:            { step: 4, label: 'Closed',          note: 'We reviewed your charges and did not find a duplicate.' },
    error:              { step: 2, label: 'Investigating',   note: 'Still working on this one.' },
  }[s] ?? { step: 1, label: 'Received', note: 'We have your report.' };

  const out = {
    id: c.id,
    created_at: c.created_at,
    email: c.email,
    body: c.body,
    customer_name: c.customer_name,
    stage: stage.step,
    stage_label: stage.label,
    note: stage.note,
    outcome: null,
  };

  if (s === 'complete' || s === 'partial') {
    out.outcome = {
      kind: 'refund',
      amount: run.plan?.amount ?? null,
      currency: run.plan?.currency ?? 'usd',
      text: 'We found a duplicate charge and refunded it in full.',
    };
  }
  if (s === 'declined') {
    out.outcome = { kind: 'no_action', text: 'A member of our billing team reviewed the evidence and decided not to issue a refund. Nothing has been changed.' };
  }
  if (s === 'refused') {
    out.outcome = {
      kind: 'no_action',
      text: run?.finding?.missing_evidence
        ? 'Your charges are for different services, so neither is a duplicate. Nothing has been changed.'
        : 'We did not find a duplicate charge. Nothing has been changed.',
    };
  }
  return out;
}
