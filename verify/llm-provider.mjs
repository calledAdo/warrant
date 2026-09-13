/**
 * Tests any OpenAI-compatible provider against what Warrant actually needs.
 *
 *   node verify/llm-provider.mjs <base_url> <api_key> <model>
 *
 * e.g. node verify/llm-provider.mjs https://api.groq.com/openai/v1 gsk_xxx llama-3.3-70b-versatile
 *
 * Checks: auth, chat completion, JSON mode, whether the model can actually do
 * the refusal (the case that matters), and latency.
 */
const [base, key, model] = process.argv.slice(2);
if (!base || !key || !model) {
  console.error('\nusage: node verify/llm-provider.mjs <base_url> <api_key> <model>\n');
  process.exit(1);
}
const URL_ = base.replace(/\/$/, '') + '/chat/completions';
const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m  ${m}`);

async function ask(messages, jsonMode) {
  const body = { model, messages, temperature: 0, max_tokens: 700 };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const t = Date.now();
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  return { ok: r.ok, status: r.status, ms: Date.now() - t, txt };
}

const EVIDENCE = (a, b) => `Customer report: "We were billed twice for September."

Stripe charges:
- ch_AAA | ${a} | succeeded | created 2026-09-13T14:03:11Z | "Invoice SEP-2026 — Pro plan"
- ch_BBB | ${b} | succeeded | created 2026-09-13T14:03:52Z | "${a === b ? 'Invoice SEP-2026 — Pro plan' : 'Invoice SEP-2026 — overage, 480 extra seats'}"

GitHub incidents:
${a === b ? '- #5 | 2026-09-13 | Billing: retry loop double-submitted invoices' : '- (none found)'}

Respond with a single JSON object:
{"verdict":"duplicate"|"insufficient_evidence","charge_to_refund":"<id>"|null,"duplicate_of":"<id>"|null,"grounds":"...","missing_evidence":"..."|null}`;

const POLICY = `You investigate billing problems. Propose a full refund ONLY when two succeeded charges share an identical amount and currency, are within 24h, and are corroborated by an incident or identical descriptions. Otherwise REFUSE with verdict "insufficient_evidence" and state what is missing. Refund the LATER charge.`;

console.log(`\n  ${URL_}\n  model: ${model}\n`);

const a = await ask([{ role: 'user', content: 'Say OK' }], false);
if (!a.ok) {
  fail(`auth/completion failed — HTTP ${a.status}`);
  console.log('  ' + a.txt.slice(0, 300) + '\n');
  process.exit(1);
}
pass(`auth + chat completion (${a.ms}ms)`);

const j = await ask([{ role: 'user', content: 'Reply with {"ok":true}' }], true);
if (j.ok) pass('JSON mode (response_format) supported');
else note(`JSON mode rejected (HTTP ${j.status}) — Warrant retries without it, fine`);

// The case that matters: will it refuse?
const r2 = await ask([{ role: 'system', content: POLICY }, { role: 'user', content: EVIDENCE('49.00 USD', '73.00 USD') }], j.ok);
let refused = false, parsed2 = null;
try {
  const c = JSON.parse(r2.txt).choices[0].message.content;
  parsed2 = JSON.parse(c.match(/\{[\s\S]*\}/)[0]);
  refused = parsed2.verdict === 'insufficient_evidence';
} catch (e) { fail('could not parse refusal response: ' + e.message); }
refused ? pass(`REFUSES correctly on distinct charges (${r2.ms}ms)`)
        : fail(`did NOT refuse — verdict was "${parsed2?.verdict}". Model too weak for S2.`);

const r1 = await ask([{ role: 'system', content: POLICY }, { role: 'user', content: EVIDENCE('49.00 USD', '49.00 USD') }], j.ok);
let dup = false, parsed1 = null;
try {
  const c = JSON.parse(r1.txt).choices[0].message.content;
  parsed1 = JSON.parse(c.match(/\{[\s\S]*\}/)[0]);
  dup = parsed1.verdict === 'duplicate' && parsed1.charge_to_refund === 'ch_BBB';
} catch {}
dup ? pass(`detects duplicate and picks the LATER charge (${r1.ms}ms)`)
    : fail(`duplicate case wrong — verdict="${parsed1?.verdict}" refund="${parsed1?.charge_to_refund}" (want ch_BBB)`);

const avg = Math.round((r1.ms + r2.ms) / 2);
console.log(`\n  avg reasoning latency: ${avg}ms  ${avg > 900 ? '(good — a visible bar in the waterfall)' : '(fast — bar will be small)'}`);

if (refused && dup) {
  console.log(`\n  \x1b[32mUSABLE.\x1b[0m Put in .env:\n`);
  console.log(`    LLM_MODE=llm`);
  console.log(`    OPENAI_BASE_URL=${base.replace(/\/$/, '')}`);
  console.log(`    OPENAI_API_KEY=${key.slice(0, 8)}…`);
  console.log(`    OPENAI_MODEL=${model}\n`);
} else {
  console.log(`\n  \x1b[31mNOT USABLE\x1b[0m for the refusal demo — try a stronger model.\n`);
  process.exit(1);
}
