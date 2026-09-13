import { readFileSync } from 'node:fs';
import { completeJSON } from './llm.js';
import { assembleCaseByRules } from './agent-rules.js';

const POLICY = readFileSync(new URL('./policy.md', import.meta.url), 'utf8');

const SCHEMA = `Respond with a single JSON object:
{
  "verdict": "duplicate" | "insufficient_evidence",
  "charge_to_refund": "<charge id>" | null,
  "duplicate_of": "<charge id>" | null,
  "grounds": "<one sentence citing IDs and the corroborating evidence>",
  "missing_evidence": "<what is absent; required when verdict is insufficient_evidence, else null>",
  "evidence": [ { "source": "stripe"|"github", "id": "<id>", "detail": "<short fact>" } ],
  "uncertainty": "<what you are unsure about, or 'none'>"
}`;

/**
 * The model interprets evidence. It never decides amounts, identity or
 * authorisation — the executor owns those.
 */
export async function assembleCase({ report, customer, charges, incidents }) {
  // Explicit rules mode, or no key configured.
  if (process.env.LLM_MODE === 'rules' || !process.env.OPENAI_API_KEY) {
    return rulesResult(charges, incidents);
  }
  const user = [
    `Customer report: ${report}`,
    '',
    `Customer: ${customer.name} (${customer.id})`,
    '',
    'Stripe charges:',
    ...charges.map(
      (c) =>
        `- ${c.id} | ${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()} | ${c.status} | ` +
        `created ${c.created_iso} | refunded=${c.refunded} | "${c.description || ''}"`
    ),
    '',
    'GitHub incidents in this repo:',
    ...(incidents.length
      ? incidents.map((i) => `- #${i.number} | ${i.created_iso} | ${i.title}\n    ${i.body.replace(/\n/g, ' ').slice(0, 240)}`)
      : ['- (none found)']),
    '',
    SCHEMA,
  ].join('\n');

  let out;
  try {
    out = await completeJSON({ system: POLICY, user });
  } catch (e) {
    if (process.env.LLM_FALLBACK === 'off') throw e;
    console.warn(`  [agent] LLM unavailable (${e.message.slice(0, 80)}) — falling back to rules`);
    return rulesResult(charges, incidents, true);
  }
  const p = out.parsed;

  // Structural validation. The model does not get to return a shape we cannot act on.
  if (!['duplicate', 'insufficient_evidence'].includes(p.verdict)) {
    throw new Error(`agent returned unknown verdict: ${p.verdict}`);
  }
  if (p.verdict === 'duplicate') {
    const ids = new Set(charges.map((c) => c.id));
    if (!ids.has(p.charge_to_refund)) {
      throw new Error(`agent named a charge not in evidence: ${p.charge_to_refund}`);
    }
    if (!ids.has(p.duplicate_of)) {
      throw new Error(`agent named a duplicate_of not in evidence: ${p.duplicate_of}`);
    }
    if (p.charge_to_refund === p.duplicate_of) {
      throw new Error('agent proposed refunding a charge as its own duplicate');
    }
  }

  return { ...out, parsed: p };
}

function rulesResult(charges, incidents, fellBack = false) {
  const parsed = assembleCaseByRules({ charges, incidents });
  return {
    parsed,
    raw: JSON.stringify(parsed),
    model: fellBack ? 'rules-engine (LLM unavailable)' : 'rules-engine',
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    rulesMode: true,
  };
}

export function caseBody({ report, customer, charges, incidents, finding }) {
  const rows = charges
    .map((c) => `| Stripe | \`${c.id}\` | ${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()} · ${c.status} · ${c.created_iso} · "${c.description || ''}" |`)
    .join('\n');
  const inc = incidents.map((i) => `| GitHub | #${i.number} | ${i.title} |`).join('\n');

  const verdictLine =
    finding.verdict === 'duplicate'
      ? `**Duplicate confirmed.** Proposed correction: full refund of \`${finding.charge_to_refund}\` (duplicate of \`${finding.duplicate_of}\`).`
      : `**Insufficient evidence. No correction proposed.**`;

  return [
    `## Report`,
    report,
    ``,
    `Customer: ${customer.name} (\`${customer.id}\`)`,
    ``,
    `## Finding`,
    verdictLine,
    ``,
    finding.grounds ? `${finding.grounds}` : '',
    finding.verdict === 'insufficient_evidence' ? `\n**Missing evidence:** ${finding.missing_evidence}` : '',
    ``,
    `## Evidence`,
    `| Source | ID | Detail |`,
    `| --- | --- | --- |`,
    rows,
    inc,
    ``,
    `## Uncertainty`,
    finding.uncertainty || 'none',
    ``,
    `_Investigated by Warrant. Seeded fixture data._`,
  ]
    .filter(Boolean)
    .join('\n');
}
