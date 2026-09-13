import { randomUUID } from 'node:crypto';
import { db } from './storage.js';

const OWNER = `${process.pid}:${randomUUID()}`;
export const RUN_LEASE_MS = 60_000;

db.exec(`CREATE TABLE IF NOT EXISTS run_leases (
  run_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
);`);

export function acquireRunLease(runId, owner = OWNER, ttlMs = RUN_LEASE_MS) {
  const now = Date.now();
  const result = db.prepare(`INSERT INTO run_leases (run_id,owner,expires_at,acquired_at)
    VALUES (?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at, acquired_at=excluded.acquired_at
    WHERE run_leases.expires_at <= ? OR run_leases.owner = excluded.owner`)
    .run(runId, owner, now + ttlMs, new Date(now).toISOString(), now);
  return result.changes === 1;
}

export function renewRunLease(runId, owner = OWNER, ttlMs = RUN_LEASE_MS) {
  return db.prepare('UPDATE run_leases SET expires_at=? WHERE run_id=? AND owner=?')
    .run(Date.now() + ttlMs, runId, owner).changes === 1;
}

export function releaseRunLease(runId, owner = OWNER) {
  return db.prepare('DELETE FROM run_leases WHERE run_id=? AND owner=?').run(runId, owner).changes === 1;
}

export async function withRunLease(runId, fn) {
  if (!acquireRunLease(runId)) throw new Error('run_busy');
  const heartbeat = setInterval(() => renewRunLease(runId), Math.floor(RUN_LEASE_MS / 3));
  heartbeat.unref?.();
  try { return await fn(); }
  finally { clearInterval(heartbeat); releaseRunLease(runId); }
}
