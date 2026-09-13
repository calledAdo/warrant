import { Lemma } from '@uselemma/tracing';
import { execSync } from 'node:child_process';
import { lemmaGet } from './lemma-api.js';
import { db } from './storage.js';

let release = process.env.LEMMA_RELEASE;
if (!release) {
  try { release = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) release += '-dirty';
  }
  catch { release = 'dev'; }
}

const enabled = Boolean(process.env.LEMMA_API_KEY && process.env.LEMMA_PROJECT_ID);

/** No-op shim so the app runs identically without Lemma configured. */
const noopSpan = { end() {} };
const noopTrace = {
  id: null,
  recordTool() {}, recordGeneration() {}, recordSpan() {},
  startTool: () => noopSpan, startGeneration: () => noopSpan, startSpan: () => noopSpan,
};

export const lemma = enabled
  ? new Lemma({ apiKey: process.env.LEMMA_API_KEY, projectId: process.env.LEMMA_PROJECT_ID, release })
  : { trace: (_o, fn) => fn(noopTrace), flushTrace: async () => {} };

export const tracingEnabled = enabled;
export const currentRelease = release;

/**
 * The SDK returns an otel_trace_id, but the dashboard keys on a separate
 * internal id and fetchIngestStatus() says "enqueued" forever. Resolve it here.
 * Verified 2026-09-12 — see PLAN.md.
 */
db.exec('CREATE TABLE IF NOT EXISTS lemma_trace_links (project TEXT NOT NULL, otel TEXT NOT NULL, internal TEXT NOT NULL, PRIMARY KEY(project,otel));');

export async function dashboardUrlFor(otelTraceId) {
  if (!enabled || !otelTraceId) return null;
  const project = process.env.LEMMA_PROJECT_ID;
  const lookup = () => {
    const row = db.prepare('SELECT internal FROM lemma_trace_links WHERE project=? AND otel=?').get(project,otelTraceId);
    return row ? { internalId: row.internal, url: `https://platform.uselemma.ai/traces/${encodeURIComponent(row.internal)}` } : null;
  };
  const cached = lookup();
  if (cached) return cached;
  let cursor;
  for (let page = 0; page < 20; page++) {
    const data = await lemmaGet('/traces/dashboard', { project_id: project, limit: 100, cursor });
    if (!Array.isArray(data.data)) throw new Error('Lemma returned an invalid traces page');
    for (const trace of data.data) db.prepare('INSERT OR REPLACE INTO lemma_trace_links VALUES (?,?,?)').run(project, trace.otel_trace_id, trace.id);
    const found = lookup();
    if (found) return found;
    if (!data.next_cursor) return null;
    const next = JSON.stringify(data.next_cursor);
    if (next === cursor) throw new Error('Lemma trace pagination did not advance');
    cursor = next;
  }
  throw new Error('Lemma trace lookup limit reached');
}
