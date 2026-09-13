import 'dotenv/config';
import { listIssues } from '../src/lemma-issues.js';
const result = await listIssues({ force: true });
console.log(JSON.stringify(result, null, 2));
if (result.error) process.exitCode = 1;
