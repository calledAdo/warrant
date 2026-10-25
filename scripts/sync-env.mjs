/**
 * Copies the Zetaris, Nightshift, Postgres and S3 values Warrant needs from the
 * Lotline .env into this project's .env without ever displaying a secret, and
 * prints only the names copied. Run once from the repo root: node scripts/sync-env.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LOTLINE = '/Users/adokiye/studycircle-project/open-agent-hackathon/lotline/.env';
const HERE = new URL('../.env', import.meta.url);
if (!existsSync(HERE)) { console.error('.env missing in warrant — create it first (never commit it)'); process.exit(1); }

// Keys Warrant copies from Lotline by its own local name.
const COPIES = {
  ZETARIS_REST_URL: 'ZETARIS_REST_URL',
  ZETARIS_ORG_ID: 'ZETARIS_ORG_ID',
  ZETARIS_API_KEY: 'ZETARIS_API_KEY',
  METERLESS_BASE_URL: 'METERLESS_BASE_URL',
  METERLESS_RUNTIME_TOKEN: 'METERLESS_RUNTIME_TOKEN',
  METERLESS_APP_ID: 'WARRANT_METERLESS_APP_ID',
  S3_ACCESS_KEY: 'S3_ACCESS_KEY',
  S3_SECRET_KEY: 'S3_SECRET_KEY',
  HOSPITAL_DB_USER: 'WARRANT_DB_USER',
  HOSPITAL_DB_PASSWORD: 'WARRANT_DB_PASSWORD',
};

const parse = (text) => Object.fromEntries(text.split(/\r?\n/).filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => {
  const i = l.indexOf('=');
  return [l.slice(0, i), l.slice(i + 1)];
}));

const lotline = parse(readFileSync(LOTLINE, 'utf8'));
const current = readFileSync(HERE, 'utf8');
const parseCurrent = parse(current);
const missing = [];

for (const [from, to] of Object.entries(COPIES)) {
  if (!lotline[from]) { console.error(`Lotline .env has no ${from}`); process.exit(1); }
  if (parseCurrent[to] === undefined) missing.push(`${to}=${lotline[from]}`);
}

if (missing.length) {
  writeFileSync(HERE, current.replace(/\n*$/, '\n') + missing.join('\n') + '\n', { mode: 0o600 });
  console.log(`warrant/.env: copied ${missing.length} value(s), names only:`, missing.map((m) => m.split('=')[0]).join(', '));
} else {
  console.log('warrant/.env: all values already present');
}
