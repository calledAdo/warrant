import { readFileSync } from 'node:fs';
import { completeJSON } from './llm.js';
import { assembleCaseByRules } from './agent-rules.js';

const POLICY = readFileSync(new URL('./policy.md', import.meta.url), 'utf8');

export const REPORT_MAX = 2000;
const DAY = 24 * 60 * 60;

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
export function enforceDuplicateRule(finding, charges, incidents) {
  if (finding.verdict !== 'duplicate') return { finding, overridden: false };
  const byId = new Map(charges.map((c) => [c.id, c]));
  const r = byId.get(finding.charge_to_refund);
  const k = byId.get(finding.duplicate_of);

  const fail = (reason) => ({
    overridden: true,
    reason,
    finding: {
      ...finding,
      verdict: 'insufficient_evidence',
      charge_to_refund: null,
      duplicate_of: null,
      missing_evidence: `The records do not support a duplicate: ${reason}.`,
      uncertainty: `The model proposed a refund, but a code check rejected it (${reason}).`,
      model_verdict: 'duplicate',
    },
  });

  if (!r || !k) return fail('a named charge is not on this account');
  if (r.id === k.id) return fail('the refund and the kept charge are the same charge');
  if (r.status !== 'succeeded' || k.status !== 'succeeded') return fail('both charges must have succeeded');
  if (r.refunded || r.amount_refunded > 0) return fail('the charge to refund has already been refunded');
  if (r.amount !== k.amount) return fail(`the amounts differ (${r.amount} vs ${k.amount})`);
  if (r.currency !== k.currency) return fail('the currencies differ');
  if (Math.abs(r.created - k.created) > DAY) return fail('the charges are more than 24 hours apart');
  if (r.created < k.created) return fail('the proposed refund is the earlier charge, not the later one');

  const sameDescription = (r.description || '') === (k.description || '');
  const incident = incidents.some((i) => Math.abs(Date.parse(i.created_iso) / 1000 - r.created) <= DAY);
  if (!sameDescription && !incident) {
    return fail('the descriptions differ and no incident covers that window');
  }
  return { finding, overridden: false };
}

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
