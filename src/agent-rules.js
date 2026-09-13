import { enforceDuplicateRule } from './duplicate-policy.js';

/** Examine all candidate pairs using exactly the same policy as model findings. */
export function assembleCaseByRules({ charges, incidents }) {
  const grouped = enforceDuplicateRule({ verdict: 'insufficient_evidence', rules_scan: true }, charges, incidents).finding;
  if (grouped.outcome === 'multiple_duplicates') return grouped;
  let refunded = null;
  for (const a of charges) for (const b of charges) {
    if (a.id === b.id || a.created < b.created) continue;
    const result = enforceDuplicateRule({
      verdict: 'duplicate', charge_to_refund: a.id, duplicate_of: b.id,
      grounds: `${a.id} matches ${b.id} in amount, currency and timing, with corroborating records.`,
      uncertainty: 'none', missing_evidence: null,
    }, charges, incidents);
    if (!result.overridden) return result.finding;
    if (['already_refunded','partially_refunded'].includes(result.finding.outcome)) refunded ??= result.finding;
  }
  if (refunded) return refunded;
  return {
    verdict: 'insufficient_evidence', outcome: 'insufficient_evidence', charge_to_refund: null, duplicate_of: null,
    grounds: 'No eligible duplicate was established among the charges examined.',
    missing_evidence: 'No eligible pair met the amount, currency, timing, refund-state and corroboration checks. Older or unavailable records may require manual review.',
    evidence: charges.map(c => ({ source: 'stripe', id: c.id, detail: `${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()} · ${c.status}` })),
    uncertainty: 'The investigation covers only the records retrieved.',
  };
}
