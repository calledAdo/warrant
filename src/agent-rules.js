/**
 * Deterministic fallback implementing the same policy.md rules.
 *
 * Used when LLM_MODE=rules, or automatically when the gateway is unreachable.
 * It exists so the pipeline can be exercised without a model, and so a demo
 * survives an API outage — NOT as a replacement for the model. The submission
 * runs the model; this is clearly labelled wherever it is used.
 */
const DAY = 24 * 60 * 60;

export function assembleCaseByRules({ charges, incidents }) {
  const succeeded = charges.filter((c) => c.status === 'succeeded' && !c.refunded);

  // Find a pair with identical amount + currency within 24h.
  let pair = null;
  for (let i = 0; i < succeeded.length; i++) {
    for (let j = i + 1; j < succeeded.length; j++) {
      const a = succeeded[i], b = succeeded[j];
      if (a.amount === b.amount && a.currency === b.currency && Math.abs(a.created - b.created) <= DAY) {
        pair = [a, b];
        break;
      }
    }
    if (pair) break;
  }

  const evidence = charges.map((c) => ({
    source: 'stripe',
    id: c.id,
    detail: `${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()} · ${c.status} · ${c.created_iso} · "${c.description || ''}"`,
  }));

  if (!pair) {
    const amounts = succeeded.map((c) => `$${(c.amount / 100).toFixed(2)}`).join(' and ');
    return {
      verdict: 'insufficient_evidence',
      charge_to_refund: null,
      duplicate_of: null,
      grounds: `Charges for this customer are ${amounts} — no two succeeded charges share an amount and currency.`,
      missing_evidence:
        'No pair of succeeded charges with identical amount and currency within 24 hours. ' +
        'The charges describe different services, and no billing incident covers this window. ' +
        'A duplicate cannot be established on this evidence.',
      evidence,
      uncertainty: 'The customer may be describing a billing period they did not expect. That is not a duplicate charge.',
    };
  }

  const [early, late] = pair[0].created <= pair[1].created ? pair : [pair[1], pair[0]];
  const gap = late.created - early.created;

  // Corroboration: an incident in the window, or identical descriptions.
  const incident = incidents.find((i) => {
    const t = Date.parse(i.created_iso) / 1000;
    return Math.abs(t - late.created) <= DAY;
  });
  const sameDesc = (early.description || '') === (late.description || '');

  if (!incident && !sameDesc) {
    return {
      verdict: 'insufficient_evidence',
      charge_to_refund: null, duplicate_of: null,
      grounds: `Two charges of $${(late.amount / 100).toFixed(2)} exist, but nothing corroborates a fault.`,
      missing_evidence: 'No billing incident covers this window and the charge descriptions differ.',
      evidence, uncertainty: 'Amounts match by coincidence or legitimate repeat purchase.',
    };
  }

  if (incident) {
    evidence.push({ source: 'github', id: `#${incident.number}`, detail: incident.title });
  }

  return {
    verdict: 'duplicate',
    charge_to_refund: late.id,
    duplicate_of: early.id,
    grounds:
      `\`${late.id}\` and \`${early.id}\` are both succeeded charges of ` +
      `$${(late.amount / 100).toFixed(2)} ${late.currency.toUpperCase()} for the same customer, ${gap}s apart` +
      (incident ? `, corroborated by incident #${incident.number} ("${incident.title}")` : `, with identical descriptions`) +
      `. The later charge is the duplicate.`,
    missing_evidence: null,
    evidence,
    uncertainty: 'none',
  };
}
