/**
 * Warrant cassette — records and replays LLM and SQL interactions for offline testing.
 * Pattern adapted from Lotline's cassette.ts.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const REPLAY_DIR = process.env.WARRANT_REPLAY_DIR || 'data/replays';
const SAMPLE_MODE = process.env.SAMPLE_MODE === 'true';

/** @typedef {Object} Recording
 * @property {'llm' | 'sql'} kind
 * @property {unknown} request
 * @property {unknown} response
 * @property {string} timestamp
 */

function requestKey(kind, request) {
  const hash = createHash('sha256').update(JSON.stringify({ kind, request })).digest('hex').slice(0, 16);
  return `${kind}_${hash}`;
}

export function record(runDir, kind, request, response) {
  if (SAMPLE_MODE) return; // Don't record in replay mode
  try {
    const dir = join(REPLAY_DIR, basename(String(runDir)));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${kind}.jsonl`);
    const line = JSON.stringify({ kind, request, response, timestamp: new Date().toISOString() }) + '\n';
    writeFileSync(file, line, { flag: 'a' });
  } catch {
    // Best effort
  }
}

export function replay(kind, request, runDir) {
  const key = requestKey(kind, request);
  const dirs = runDir 
    ? [join(REPLAY_DIR, basename(String(runDir))), join(REPLAY_DIR, 'default')]
    : [join(REPLAY_DIR, 'default')];
  // Committed recordings in data/cassettes/ are searched after the per-run replays.
  const files = dirs.map(dir => join(dir, `${kind}.jsonl`));
  const cassettes = process.env.WARRANT_CASSETTE_DIR || 'data/cassettes';
  if (existsSync(cassettes)) files.push(...readdirSync(cassettes).filter(f => f.endsWith('.jsonl')).sort().map(f => join(cassettes, f)));
  for (const file of files) {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          if (rec.kind === kind && requestKey(kind, rec.request) === key) {
            return rec.response;
          }
        } catch {}
      }
    }
  }
  throw new SampleMissing(key, kind);
}

export class SampleMissing extends Error {
  constructor(key, kind) {
    super(`No recording for ${kind} request: ${key}`);
    this.name = 'SampleMissing';
    this.key = key;
    this.kind = kind;
  }
}

/** Load all recordings from a run directory for injection into the runtime. */
export function loadRecordings(runDir) {
  const map = new Map();
  const files = [join(REPLAY_DIR, basename(String(runDir))), join(REPLAY_DIR, 'default')];
  for (const dir of files) {
    if (!existsSync(dir)) continue;
    for (const kind of ['llm', 'sql']) {
      const file = join(dir, `${kind}.jsonl`);
      if (!existsSync(file)) continue;
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          map.set(requestKey(rec.kind, rec.request), rec);
        } catch {}
      }
    }
  }
  return map;
}

/** Clear recordings for a run (for fresh live runs). */
export function clearRecordings(runDir) {
  try {
    const dir = join(REPLAY_DIR, runDir);
    if (existsSync(dir)) {
      for (const file of ['llm.jsonl', 'sql.jsonl']) {
        const f = join(dir, file);
        if (existsSync(f)) writeFileSync(f, '');
      }
    }
  } catch {}
}