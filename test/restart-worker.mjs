import { installMocks } from './helpers.mjs';
installMocks();
const { runs, recoverRuns, approve, execute, resume } = await import('../src/run.js');
await recoverRuns();
const run = runs.get(process.argv[2]);
if (!run) throw new Error('persisted run missing');
if (process.argv[3] === 'approve') { approve(run,'restart@test'); await execute(run); }
if (process.argv[3] === 'resume') await resume(run);
console.log(JSON.stringify(run.snapshot()));
