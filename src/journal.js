/**
 * The operation journal. Intent is written BEFORE every external write and the
 * result after, so a crash mid-write is detectable rather than silent.
 *
 * node:sqlite is built into Node 22+ — no dependency, no native build.
 */
import { db } from './storage.js';

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

if (!db.prepare('PRAGMA table_info(operations)').all().some(c => c.name === 'run_id')) db.exec('ALTER TABLE operations ADD COLUMN run_id TEXT;');
db.exec(`CREATE TABLE IF NOT EXISTS run_approvals (
 run_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, plan TEXT NOT NULL, approver TEXT NOT NULL, approved_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operation_reconciliations (
 id INTEGER PRIMARY KEY, op_key TEXT NOT NULL, status TEXT NOT NULL, result TEXT, note TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_operation_refs (
 run_id TEXT NOT NULL, op_key TEXT NOT NULL, referenced_at TEXT NOT NULL, PRIMARY KEY(run_id,op_key));`);
db.exec(`CREATE INDEX IF NOT EXISTS operations_run_created ON operations(run_id,created_at);
CREATE INDEX IF NOT EXISTS operations_plan_created ON operations(plan_id,created_at);
CREATE INDEX IF NOT EXISTS operation_refs_run ON run_operation_refs(run_id,op_key);`);

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
export async function withJournal(opKey, { planId, runId = null, step, request }, fn) {
  const existing = getOp(opKey);

  if (existing?.status === 'succeeded') {
    if (runId && existing.run_id !== runId) db.prepare('INSERT OR IGNORE INTO run_operation_refs VALUES (?,?,?)').run(runId, opKey, now());
    return { skipped: true, result: JSON.parse(existing.result || 'null') };
  }
  if (['intended', 'uncertain'].includes(existing?.status)) {
    return { uncertain: true, opKey };
  }

  if (existing) {
    const claimed = db.prepare("UPDATE operations SET status='intended', result=NULL, error=NULL, completed_at=NULL, created_at=? WHERE op_key=? AND status='failed'")
      .run(now(), opKey);
    if (!claimed.changes) return { uncertain: true, opKey };
  } else {
    const claimed = db.prepare(
      'INSERT OR IGNORE INTO operations (op_key, plan_id, step, status, request, created_at, run_id) VALUES (?,?,?,?,?,?,?)'
    ).run(opKey, planId, step, 'intended', JSON.stringify(request ?? null), now(), runId);
    if (!claimed.changes) return { uncertain: true, opKey };
  }

  try {
    const result = await fn(opKey);
    db.prepare('UPDATE operations SET status=?, result=?, completed_at=? WHERE op_key=?')
      .run('succeeded', JSON.stringify(result ?? null), now(), opKey);
    return { result };
  } catch (error) {
    db.prepare('UPDATE operations SET status=?, error=?, completed_at=? WHERE op_key=?')
      .run(error.definitiveRejection ? 'failed' : 'uncertain', String(error.message || error), now(), opKey);
    throw error;
  }
}

export function recordApproval(plan, approver, runId = null) {
  if (runId) {
    db.prepare('INSERT OR REPLACE INTO run_approvals VALUES (?,?,?,?,?)').run(runId, plan.plan_id, JSON.stringify(plan), approver, now());
    return getApproval(plan.plan_id, runId);
  }
  db.prepare('INSERT OR REPLACE INTO approvals (plan_id, plan, approver, approved_at) VALUES (?,?,?,?)')
    .run(plan.plan_id, JSON.stringify(plan), approver, now());
  return { plan_id: plan.plan_id, approver, approved_at: now() };
}

export function getApproval(planId, runId = null) {
  const row = runId
    ? db.prepare('SELECT * FROM run_approvals WHERE run_id=? AND plan_id=?').get(runId, planId)
    : db.prepare('SELECT * FROM approvals WHERE plan_id = ?').get(planId);
  return row ? { ...row, plan: JSON.parse(row.plan) } : null;
}

/** Demo helper — wipe the journal between takes. Never used in the flow. */
export function reset() {
  db.exec('DELETE FROM operations; DELETE FROM approvals; DELETE FROM run_approvals; DELETE FROM operation_reconciliations; DELETE FROM run_operation_refs;');
}

export const refundKey = (plan, item = null) => `refund_full:${item?.charge_id || plan.charge_id}`;
export const refundOperation = (plan, item = null) => getOp(refundKey(plan, item))
  || (!item && plan.action !== 'refund_batch_full' ? getOp(`${plan.plan_id}:refund`) : null);
export function opsForRun(run) {
  const refundKeys = run.plan?.action === 'refund_batch_full'
    ? new Set(run.plan.refunds.map(item => refundKey(run.plan, item))) : null;
  return db.prepare('SELECT * FROM operations WHERE run_id=? OR op_key=? OR (run_id IS NULL AND plan_id=?) OR EXISTS (SELECT 1 FROM run_operation_refs r WHERE r.run_id=? AND r.op_key=operations.op_key) ORDER BY created_at')
    .all(run.id, run.plan && !refundKeys ? refundKey(run.plan) : '', run.plan?.plan_id || run.id, run.id)
    .filter(op => !refundKeys || op.run_id === run.id || refundKeys.has(op.op_key) || op.plan_id === run.plan.plan_id);
}

/** Operator reconciliation after inspecting the provider; never changes provider state. */
export function reconcileOperation(opKey, { status, result, note }) {
  const op = getOp(opKey);
  if (!op || !['uncertain','intended'].includes(op.status)) throw new Error('operation is not awaiting reconciliation');
  if (!['succeeded','failed'].includes(status) || !note?.trim()) throw new Error('status and inspection note required');
  if (status === 'succeeded' && (!result || typeof result !== 'object')) throw new Error('provider result required');
  if (status === 'succeeded') {
    const valid = op.step === 'refund' ? result.id && Number.isInteger(result.amount) && result.charge
      : op.step === 'write_case' ? result.number && result.url
      : ['post_proposal','post_refusal'].includes(op.step) ? result.channel && result.ts
      : true;
    if (!valid) throw new Error('provider result is missing fields needed to resume');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE operations SET status=?, result=?, error=?, completed_at=? WHERE op_key=?')
      .run(status, JSON.stringify(result ?? null), `Reconciled: ${note}`, now(), opKey);
    db.prepare('INSERT INTO operation_reconciliations (op_key,status,result,note,recorded_at) VALUES (?,?,?,?,?)')
      .run(opKey,status,JSON.stringify(result ?? null),note,now());
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return getOp(opKey);
}
