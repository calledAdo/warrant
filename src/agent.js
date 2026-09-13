import { readFileSync } from 'node:fs';
import { completeJSON } from './llm.js';
import { enforceDuplicateRule } from './duplicate-policy.js';
import { outcomeFor } from './outcomes.js';
import { assembleCaseByRules } from './agent-rules.js';

const POLICY = readFileSync(new URL('./policy.md', import.meta.url), 'utf8');

export const REPORT_MAX = 2000;

/**
 * Customer text is untrusted input. Strip control characters, neutralise
 * anything that could close our delimiter, and cap the length.
 */
export function sanitizeReport(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<\/?\s*customer_report\s*>/gi, '[tag removed]')
    .slice(0, REPORT_MAX)
    .trim();
}

/**
 * The duplicate rule, enforced in code. Whatever the model concluded — and
 * whatever the complaint told it — a refund is only proposed when the Stripe
 * records themselves show a duplicate. A failing check downgrades the finding
 * to a refusal and records why.
 */
export { enforceDuplicateRule } from './duplicate-policy.js';

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
    '<customer_report>',
    sanitizeReport(report),
    '</customer_report>',
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
  // Charge identity, amounts and timing are checked by enforceDuplicateRule,
  // which downgrades to a refusal rather than crashing the run.

  const guard = enforceDuplicateRule(p, charges, incidents);
  if (guard.overridden) console.warn(`  [agent] code check overrode model: ${guard.reason}`);
  return { ...out, parsed: guard.finding, guard };
}

function rulesResult(charges, incidents, fellBack = false) {
  const parsed = enforceDuplicateRule(assembleCaseByRules({ charges, incidents }), charges, incidents).finding;
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
    finding.outcome === 'multiple_duplicates'
      ? `**Multiple duplicates confirmed.** Keep \`${finding.legitimate_charge}\`; proposed batch: ${finding.duplicate_charges.map(id => `full refund of \`${id}\``).join(', ')}.`
      : finding.verdict === 'duplicate'
      ? `**Duplicate confirmed.** Proposed correction: full refund of \`${finding.charge_to_refund}\` (duplicate of \`${finding.duplicate_of}\`).`
      : `**${outcomeFor(finding).label}. No correction proposed.**`;

  return [
    `## Report`,
    `> ${sanitizeReport(report).replace(/\n/g, '\n> ')}`,
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
