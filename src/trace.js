import { Lemma } from '@uselemma/tracing';
import { execSync } from 'node:child_process';

let release = process.env.LEMMA_RELEASE;
if (!release) {
  try { release = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
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
export async function dashboardUrlFor(otelTraceId) {
  if (!enabled || !otelTraceId) return null;
  try {
    const r = await fetch(
      `https://api.uselemma.ai/traces/dashboard?project_id=${process.env.LEMMA_PROJECT_ID}&limit=25`,
      { headers: { Authorization: `Bearer ${process.env.LEMMA_API_KEY}` } }
    );
    const j = await r.json();
    const hit = (j.data || []).find((x) => x.otel_trace_id === otelTraceId);
    return hit ? { internalId: hit.id, url: `https://platform.uselemma.ai/traces/${hit.id}` } : null;
  } catch {
    return null;
  }
}
