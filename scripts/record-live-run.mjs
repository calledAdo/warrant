#!/usr/bin/env node
// Records one live investigation (Zetaris + Nightshift) at a fixed clock, for exact offline replay.
// Usage: WARRANT_NOW=2026-10-27T09:00:00Z node --import=dotenv/config scripts/record-live-run.mjs
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
if (!process.env.WARRANT_NOW) throw new Error('Set WARRANT_NOW so the run can be replayed exactly');
const { submitRefundRequest, investigateRefundRequest } = await import('../src/application.js');
const { run } = await submitRefundRequest({ email: 'billing@northwind.test', body: 'We were charged twice for our Pro plan.' });
await investigateRefundRequest(run);
const s = run.snapshot();
const dir = `data/replays/${run.id}`;
const lines = ['sql', 'llm'].flatMap(k => existsSync(`${dir}/${k}.jsonl`) ? readFileSync(`${dir}/${k}.jsonl`, 'utf8').split('\n').filter(Boolean) : []);
const out = `data/cassettes/live-${process.env.WARRANT_NOW.slice(0, 10)}.jsonl`;
writeFileSync(out, lines.join('\n') + '\n');
console.log(JSON.stringify({ error: s.error, status: s.status, verdict: s.finding?.verdict, refund: s.finding?.charge_to_refund, duplicate_of: s.finding?.duplicate_of, recordings: lines.length, cassette: out }, null, 2));
