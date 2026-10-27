#!/usr/bin/env node
// Registers Warrant's USL objects (scripts/register_zetaris_usl.sql) in Zetaris, one statement per call.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
const fill = (sql) => sql.replace(/\$\{(\w+)\}/g, (_, k) => { if (!process.env[k]) throw new Error(`missing ${k}`); return process.env[k]; });
const statements = readFileSync(new URL('./register_zetaris_usl.sql', import.meta.url), 'utf8')
  .replace(/^\s*--.*$/gm, '').split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
for (const sql of statements) {
  const res = await fetch(`${process.env.ZETARIS_REST_URL}/sql-editor/sqls/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.ZETARIS_API_KEY}`, 'X-Org-ID': process.env.ZETARIS_ORG_ID, 'X-Request-ID': randomUUID(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ queryId: randomUUID(), sql: fill(sql), source: 'SqlEditor', limit: 10 }),
  });
  const body = await res.json().catch(() => ({}));
  const exists = /already exists|already registered/i.test(body.msg ?? '');
  console.log(`${sql.split('\n')[0].slice(0, 90)}: ${res.ok ? 'OK' : exists ? 'exists (retained)' : `FAILED ${String(body.msg).split('\n')[0].slice(0, 160)}`}`);
}
