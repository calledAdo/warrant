/**
 * Lemma round-trip. Answers the last open dependency question:
 *
 *   Q1  Does a trace ingest at all with these credentials?
 *   Q2  How long until it's READY?  <- decides live vs pre-recorded demo trace
 *   Q3  Does the real Warrant trace shape survive (spans, generations, tools)?
 *   Q4  Are errors recorded on the exact failing span?
 *   Q5  Do threadId / metadata / release land?
 *
 * Run: npm run verify:lemma
 */
import 'dotenv/config';
import { Lemma } from '@uselemma/tracing';

const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m  ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

if (!process.env.LEMMA_API_KEY || !process.env.LEMMA_PROJECT_ID) {
  console.error('\nLEMMA_API_KEY and LEMMA_PROJECT_ID must be set in .env\n');
  process.exit(1);
}

const lemma = new Lemma({
  apiKey: process.env.LEMMA_API_KEY,
  projectId: process.env.LEMMA_PROJECT_ID,
  release: 'verify-' + new Date().toISOString().slice(0, 10),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  head('Q1/Q3 — ingest a realistic Warrant trace');

  const caseId = 'case-verify-' + Date.now().toString(36);
  let traceId;

  const started = Date.now();
  const result = await lemma.trace(
    {
      name: 'warrant.investigate',
      input: '"We were billed twice for September." — Northwind Trading Co.',
      threadId: caseId,
      userId: 'ops@warrant.test',
      metadata: { scenario: 's1', customer_id: 'cus_VFHYUolqt92mLM' },
    },
    async (trace) => {
      traceId = trace.id ?? trace.traceId;

      trace.recordTool({
        name: 'stripe.list_charges',
        input: { customer: 'cus_VFHYUolqt92mLM', limit: 10 },
        output: { count: 2, amounts: [4900, 4900], gap_seconds: 1 },
        durationMs: 180,
      });

      trace.recordTool({
        name: 'github.search_incidents',
        input: { repo: 'calledAdo/warrant-billing-cases', window: '24h' },
        output: { found: 1, issue: 5, title: 'retry loop double-submitted invoices' },
        durationMs: 240,
      });

      trace.recordGeneration({
        name: 'assemble-case',
        model: 'claude-sonnet-5',
        input: [{ role: 'user', content: 'Two charges, $49.00 each, 1s apart. Incident #5 covers the window.' }],
        output: 'Duplicate confirmed. Propose full refund of the later charge ch_3UEmzc.',
        usage: { inputTokens: 820, outputTokens: 140 },
        durationMs: 2100,
      });

      trace.recordTool({
        name: 'github.write_case',
        input: { issue: 6 },
        output: { number: 6, url: 'https://github.com/calledAdo/warrant-billing-cases/issues/6' },
        durationMs: 310,
      });

      // Q4 — the failure must land on THIS span, not the trace root
      trace.recordTool({
        name: 'slack.post_proposal',
        input: { channel: '#billing-approvals' },
        status: 'ERROR',
        error: new Error('ratelimited (HTTP 429, Retry-After: 60)'),
        durationMs: 95,
      });

      return { status: 'partial', pending: ['post_proposal'] };
    }
  );

  pass(`trace submitted (${Date.now() - started}ms wall)`);
  if (traceId) pass(`trace id: ${traceId}`);
  else note('trace id not exposed on the handle — check the dashboard by name');
  pass(`agent returned: ${JSON.stringify(result)}`);

  head('Q2 — time to READY');
  await lemma.flushTrace?.().catch(() => {});

  const t0 = Date.now();
  let ready = false;
  let lastStatus = 'unknown';

  // NB: lemma.fetchIngestStatus() reports "enqueued" forever — it keys on a
  // different id than the dashboard. Poll /traces/dashboard for otel_trace_id.
  const P = process.env.LEMMA_PROJECT_ID;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`https://api.uselemma.ai/traces/dashboard?project_id=${P}&limit=20`, {
        headers: { Authorization: `Bearer ${process.env.LEMMA_API_KEY}` },
      });
      const j = await r.json().catch(() => ({ data: [] }));
      const hit = (j.data || []).find((x) => x.otel_trace_id === traceId);
      if (hit) { ready = true; lastStatus = `internal id ${hit.id}`; break; }
    } catch (e) {
      note(`dashboard poll failed: ${e.message}`);
      break;
    }
    await sleep(2000);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (ready) {
    pass(`READY after ${elapsed}s`);
    note(`internal ${lastStatus}`);
    if (Number(elapsed) < 20) note('Fast enough to show a LIVE trace in the demo.');
    else note('~30s typical. Open the trace tab BEFORE the run, or narrate the fixtures while it lands.');
  } else {
    note(`not confirmed ready after ${elapsed}s. last: ${lastStatus}`);
    note('Check the dashboard directly; the SDK status API may differ from what this script guessed.');
  }

  head('Q5 — verify delivery end to end');
  try {
    const v = await lemma.verifyIngestDelivery?.();
    if (v) pass(`verifyIngestDelivery: ${JSON.stringify(v).slice(0, 200)}`);
    else note('verifyIngestDelivery returned nothing');
  } catch (e) {
    note(`verifyIngestDelivery: ${e.message}`);
  }

  head('Next');
  console.log('  Open https://platform.uselemma.ai and confirm:');
  console.log(`    - a trace named "warrant.investigate" with threadId ${caseId}`);
  console.log('    - four tool spans + one generation nested under the root');
  console.log('    - slack.post_proposal shows as the ERROR span (not the root)');
  console.log('    - metadata.scenario = s1, and the release tag is present\n');
}

main()
  .then(async () => { await lemma.flushTrace?.().catch(() => {}); process.exit(0); })
  .catch(async (e) => {
    console.error(`\n\x1b[31mFAILED\x1b[0m ${e.message}`);
    if (String(e.message).match(/401|403|unauthor/i)) console.error('  Key or project id rejected.');
    await lemma.flushTrace?.().catch(() => {});
    process.exit(1);
  });
