/**
 * The operation journal. Intent is written BEFORE every external write and the
 * result after, so a crash mid-write is detectable rather than silent.
 *
 * node:sqlite is built into Node 22+ — no dependency, no native build.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/warrant.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS operations (
    op_key       TEXT PRIMARY KEY,
    plan_id      TEXT NOT NULL,
    step         TEXT NOT NULL,
    status       TEXT NOT NULL,
    request      TEXT,
    result       TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS approvals (
    plan_id     TEXT PRIMARY KEY,
    plan        TEXT NOT NULL,
    approver    TEXT NOT NULL,
    approved_at TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();

export function getOp(opKey) {
  return db.prepare('SELECT * FROM operations WHERE op_key = ?').get(opKey);
}

export function opsForPlan(planId) {
  return db.prepare('SELECT * FROM operations WHERE plan_id = ? ORDER BY created_at').all(planId);
}

/**
 * Three outcomes:
 *   { skipped, result }  already succeeded — do not repeat the write
 *   { uncertain: true }  intent recorded but no result. We do NOT know whether
 *                        it landed. Inspect the provider; never retry blind.
 *   { result }           performed now
 */
export async function withJournal(opKey, { planId, step, request }, fn) {
  const existing = getOp(opKey);

  if (existing?.status === 'succeeded') {
    return { skipped: true, result: JSON.parse(existing.result || 'null') };
  }
  if (existing?.status === 'intended') {
    return { uncertain: true, opKey };
  }

  if (existing) {
    db.prepare('UPDATE operations SET status=?, error=NULL, created_at=? WHERE op_key=?')
      .run('intended', now(), opKey);
  } else {
    db.prepare(
      'INSERT INTO operations (op_key, plan_id, step, status, request, created_at) VALUES (?,?,?,?,?,?)'
    ).run(opKey, planId, step, 'intended', JSON.stringify(request ?? null), now());
  }

  try {
    const result = await fn(opKey);
    db.prepare('UPDATE operations SET status=?, result=?, completed_at=? WHERE op_key=?')
      .run('succeeded', JSON.stringify(result ?? null), now(), opKey);
    return { result };
  } catch (error) {
    db.prepare('UPDATE operations SET status=?, error=?, completed_at=? WHERE op_key=?')
      .run('failed', String(error.message || error), now(), opKey);
    throw error;
  }
}

export function recordApproval(plan, approver) {
  db.prepare('INSERT OR REPLACE INTO approvals (plan_id, plan, approver, approved_at) VALUES (?,?,?,?)')
    .run(plan.plan_id, JSON.stringify(plan), approver, now());
  return { plan_id: plan.plan_id, approver, approved_at: now() };
}

export function getApproval(planId) {
  const row = db.prepare('SELECT * FROM approvals WHERE plan_id = ?').get(planId);
  return row ? { ...row, plan: JSON.parse(row.plan) } : null;
}

/** Demo helper — wipe the journal between takes. Never used in the flow. */
export function reset() {
  db.exec('DELETE FROM operations; DELETE FROM approvals;');
}
