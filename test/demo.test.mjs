import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'warrant-demo-'));
process.env.WARRANT_DB = join(dir, 'demo.sqlite');
process.env.WARRANT_PROVIDER = 'sqlite';
process.env.LLM_MODE = 'rules';
process.env.LEMMA_API_KEY = '';
process.env.LEMMA_PROJECT_ID = '';

const { db } = await import('../src/storage.js');
const { prepareS1Demo, getS1Demo } = await import('../src/demo.js');
const {
  submitRefundRequest, investigateRefundRequest, approveRefundRequest, executeApprovedRefund,
} = await import('../src/application.js');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('SQLite S1 demo requires admin approval and refunds only the later charge', async () => {
  const seeded = prepareS1Demo();
  assert.equal(seeded.customer.email, 'billing@northwind.test');
  assert.deepEqual(seeded.charges.map(charge => charge.amount_refunded), [0, 0]);

  const { complaint, run } = await submitRefundRequest({
    email: 'billing@northwind.test',
    body: 'We were billed twice for September.',
  });
  assert.ok(complaint.id);
  await investigateRefundRequest(run);
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(run.plan.charge_id, 'ch_demo_northwind_02');
  assert.equal(getS1Demo().charges.every(charge => charge.amount_refunded === 0), true);

  assert.throws(
    () => approveRefundRequest({ runId: run.id, planId: 'stale-plan' }),
    /plan changed/,
  );
  approveRefundRequest({ runId: run.id, planId: run.plan.plan_id, approver: 'demo-admin@warrant.test' });
  await executeApprovedRefund(run);

  assert.equal(run.status, 'complete');
  const charges = getS1Demo().charges;
  assert.equal(charges[0].amount_refunded, 0);
  assert.equal(charges[1].amount_refunded, 4900);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM demo_cases').get().count, 1);
  assert.equal(db.prepare("SELECT kind FROM demo_notifications").get().kind, 'applied');
});
