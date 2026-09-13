/**
 * Runs every gate in order and prints one go/no-go table.
 * Run: npm run verify
 */
import { spawn } from 'node:child_process';

const GATES = [
  { name: 'Stripe refund + idempotency', file: 'verify/stripe-refund.mjs', blocking: true },
  { name: 'GitHub investigation case', file: 'verify/github-issue.mjs', blocking: true },
  { name: 'Slack post + update', file: 'verify/slack-post.mjs', blocking: true },
];

const run = (file) =>
  new Promise((resolve) => {
    const p = spawn('node', [file], { stdio: 'inherit' });
    p.on('close', (code) => resolve(code === 0));
  });

const results = [];
for (const gate of GATES) {
  console.log(`\n\x1b[1m\x1b[44m  ${gate.name}  \x1b[0m`);
  results.push({ ...gate, ok: await run(gate.file) });
}

console.log('\n\x1b[1m══════════ GO / NO-GO ══════════\x1b[0m');
for (const r of results) {
  console.log(`  ${r.ok ? '\x1b[32mGO   \x1b[0m' : '\x1b[31mNO-GO\x1b[0m'}  ${r.name}`);
}
const blocked = results.filter((r) => !r.ok && r.blocking);
if (blocked.length) {
  console.log(`\n  \x1b[31m${blocked.length} blocking gate(s) failed. Do not commit to this build yet.\x1b[0m\n`);
  process.exit(1);
}
console.log('\n  \x1b[32mAll gates green. The Warrant plan is buildable.\x1b[0m\n');
