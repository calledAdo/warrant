#!/usr/bin/env node
import 'dotenv/config';
import { archiveHistory } from '../src/retention.js';

const daysArg = process.argv.find(arg => arg.startsWith('--days='));
const days = Number(daysArg?.slice(7) || process.env.WARRANT_CHECKPOINT_RETENTION_DAYS || 90);
if (!Number.isFinite(days) || days < 1) throw new Error('--days must be at least 1');
const apply = process.argv.includes('--apply');
const before = new Date(Date.now() - days * 86400000).toISOString();
const result = archiveHistory({ before, apply });
console.log(JSON.stringify({ policy: { checkpoint_days: days, financial_audit: 'retained' }, ...result }, null, 2));
if (!apply && result.candidates.length) console.log('\nDry run only. Re-run with --apply to archive and prune these checkpoints.');
