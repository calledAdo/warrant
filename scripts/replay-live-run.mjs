#!/usr/bin/env node
// Replays the recorded live investigation offline: the real agent graph and tools, with the
// Zetaris SQL answers and Nemotron replies from data/cassettes/live-2026-10-27.jsonl.
// No Stripe, GitHub, Slack, Zetaris or Nightshift account is needed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'warrant-replay-'));
Object.assign(process.env, {
  SAMPLE_MODE: 'true', WARRANT_USE_ZETARIS: 'true', WARRANT_PROVIDER: 'sqlite', LLM_FALLBACK: 'off',
  WARRANT_NOW: '2026-10-27T09:00:00Z', WARRANT_DB: join(work, 'warrant.db'), WARRANT_HMEM_DIR: join(work, 'hmem'),
  WARRANT_REPLAY_DIR: join(work, 'replays'), METERLESS_RUNTIME_TOKEN: process.env.METERLESS_RUNTIME_TOKEN || 'replay',
});
try {
  const { prepareS1Demo } = await import('../src/demo.js');
  const { submitRefundRequest, investigateRefundRequest } = await import('../src/application.js');
  prepareS1Demo();
  const { run } = await submitRefundRequest({ email: 'billing@northwind.test', body: 'We were charged twice for our Pro plan.' });
  await investigateRefundRequest(run);
  const s = run.snapshot();
  console.log(JSON.stringify({ error: s.error, status: s.status, verdict: s.finding?.verdict, refund: s.finding?.charge_to_refund, duplicate_of: s.finding?.duplicate_of, grounds: s.finding?.grounds, model: s.llm?.model, turns: s.llm?.turns }, null, 2));
  if (s.status !== 'awaiting_approval') process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
