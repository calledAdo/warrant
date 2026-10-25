import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.ZETARIS_REST_URL;
const headers = {
  Authorization: 'Bearer ' + process.env.ZETARIS_API_KEY,
  'X-Org-ID': process.env.ZETARIS_ORG_ID ?? '1',
  'Content-Type': 'application/json',
};

const sql = readFileSync('scripts/setup_zetaris_principals.sql', 'utf8');
const env = process.env;

const statements = sql.replace(/^\s*--.*$/gm, '').split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);

for (const statement of statements) {
  const filled = statement.replace(/\$\{(\w+)\}/g, (_, key) => { 
    if (!env[key]) throw new Error('Missing ' + key); 
    return env[key].replaceAll("'", "''"); 
  });
  
  try {
    const res = await fetch(url + '/sql-editor/sqls/run', {
      method: 'POST',
      headers: { ...headers, 'X-Request-ID': randomUUID() },
      body: JSON.stringify({ queryId: randomUUID(), sql: filled, source: 'SqlEditor', limit: 10 }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json();
    console.log(filled.split('\n')[0].slice(0, 100) + ': ' + res.status);
    if (body.error) console.log('  error:', body.error);
  } catch (err) {
    if (/already exists|already (?:been )?assigned|already (?:been )?granted/i.test(err.message)) {
      console.log(filled.split('\n')[0].slice(0, 100) + ': exists');
    } else {
      throw err;
    }
  }
}
