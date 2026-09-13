import { db } from './storage.js';

db.exec(`CREATE TABLE IF NOT EXISTS audit_archives (
  run_id TEXT PRIMARY KEY,
  archived_at TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  snapshot TEXT NOT NULL
);`);

const terminal = new Set(['complete', 'declined', 'refused']);

export function archiveCandidates(before) {
  const cutoff = new Date(before).getTime();
  if (!Number.isFinite(cutoff)) throw new Error('valid archive cutoff required');
  return db.prepare('SELECT id,state FROM runs').all().flatMap(row => {
    const state = JSON.parse(row.state);
    return terminal.has(state.status) && Number.isFinite(Date.parse(state.closedAt)) && Date.parse(state.closedAt) < cutoff
      ? [{ id: row.id, status: state.status, closedAt: state.closedAt }] : [];
  });
}

export function archiveHistory({ before, apply = false }) {
  const candidates = archiveCandidates(before);
  if (!apply) return { apply: false, candidates, archived: 0 };
  let archived = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const candidate of candidates) {
      const run = db.prepare('SELECT state FROM runs WHERE id=?').get(candidate.id);
      const snapshot = {
        run: JSON.parse(run.state),
        complaints: db.prepare('SELECT * FROM complaints WHERE run_id=?').all(candidate.id),
        operations: db.prepare(`SELECT * FROM operations WHERE run_id=? OR EXISTS (
          SELECT 1 FROM run_operation_refs ref WHERE ref.run_id=? AND ref.op_key=operations.op_key)`).all(candidate.id, candidate.id),
        approval: db.prepare('SELECT * FROM run_approvals WHERE run_id=?').get(candidate.id) || null,
      };
      db.prepare('INSERT OR IGNORE INTO audit_archives VALUES (?,?,?,?)')
        .run(candidate.id, new Date().toISOString(), candidate.closedAt, JSON.stringify(snapshot));
      db.prepare('DELETE FROM checkpoint_writes WHERE thread=?').run(candidate.id);
      db.prepare('DELETE FROM checkpoints WHERE thread=?').run(candidate.id);
      archived++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { apply: true, candidates, archived };
}
