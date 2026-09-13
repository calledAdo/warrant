import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { getOp, reconcileOperation } from '../src/journal.js';

const [opKey, status, resultFile, ...reason] = process.argv.slice(2);
if (!opKey) {
  console.error('Inspect: node scripts/reconcile-operation.mjs <op-key>\nAfter inspecting the provider, with the server stopped:\n  node scripts/reconcile-operation.mjs <op-key> succeeded <result.json> <inspection note>\n  node scripts/reconcile-operation.mjs <op-key> failed - <confirmed-not-applied note>');
  process.exitCode = 1;
} else if (!status) console.log(JSON.stringify(getOp(opKey) || null, null, 2));
else {
  try {
    const result = resultFile && resultFile !== '-' ? JSON.parse(readFileSync(resultFile,'utf8')) : null;
    console.log(JSON.stringify(reconcileOperation(opKey, { status, result, note: reason.join(' ') }), null, 2));
  } catch(error) { console.error(error.message); process.exitCode = 1; }
}
