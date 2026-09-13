import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'warrant-operations-'));
process.env.WARRANT_DB = join(dir, 'db.sqlite');

const { db } = await import('../src/storage.js');
await import('../src/complaints.js');
await import('../src/journal.js');
const { acquireRunLease, renewRunLease, releaseRunLease } = await import('../src/coordinator.js');
const { archiveHistory } = await import('../src/retention.js');

after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test('run leases exclude another process owner and expired leases can be reclaimed', () => {
  assert.equal(acquireRunLease('run_lease', 'owner-a', 60_000), true);
  assert.equal(acquireRunLease('run_lease', 'owner-b', 60_000), false);
  assert.equal(renewRunLease('run_lease', 'owner-b'), false);
  db.prepare('UPDATE run_leases SET expires_at=? WHERE run_id=?').run(Date.now() - 1, 'run_lease');
  assert.equal(acquireRunLease('run_lease', 'owner-b', 60_000), true);
  assert.equal(releaseRunLease('run_lease', 'owner-a'), false);
  assert.equal(releaseRunLease('run_lease', 'owner-b'), true);
});

test('archive is dry-run first and preserves financial audit records when applied', () => {
  const runId = 'run_archive';
  const closedAt = '2025-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO runs VALUES (?,?)').run(runId, JSON.stringify({ id: runId, status: 'complete', closedAt }));
  db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?,?)')
    .run(runId, '', 'cp_1', null, 'json', Buffer.from('{}'), 'json', Buffer.from('{}'));
  db.prepare('INSERT INTO operations (op_key,plan_id,step,status,result,created_at,run_id) VALUES (?,?,?,?,?,?,?)')
    .run('refund_full:ch_archive', 'plan', 'refund', 'succeeded', JSON.stringify({ id: 're_archive', amount: 100, charge: 'ch_archive' }), closedAt, runId);

  const dry = archiveHistory({ before: '2026-01-01T00:00:00.000Z' });
  assert.equal(dry.archived, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM checkpoints WHERE thread=?').get(runId).count, 1);

  const applied = archiveHistory({ before: '2026-01-01T00:00:00.000Z', apply: true });
  assert.equal(applied.archived, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM checkpoints WHERE thread=?').get(runId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM operations WHERE run_id=?').get(runId).count, 1);
  const archive = JSON.parse(db.prepare('SELECT snapshot FROM audit_archives WHERE run_id=?').get(runId).snapshot);
  assert.equal(archive.operations[0].op_key, 'refund_full:ch_archive');
});
