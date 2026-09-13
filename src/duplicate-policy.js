const DAY = 24 * 60 * 60;
const MONTH = 30 * DAY;
export const MAX_BATCH_REFUNDS = 10;
export const MAX_BATCH_TOTAL = 100_000;

const incidentRelevant = (incident, billingKey = null) => {
  const text = `${incident.title || ''} ${incident.body || ''}`.toLowerCase();
  const describesBillingFailure = /(duplicate|retry|double).*(charge|payment|invoice|billing)|(charge|payment|invoice|billing).*(duplicate|retry|double)/i.test(text);
  if (!describesBillingFailure) return false;
  if (!billingKey) return true;
  return (incident.billing_keys || []).includes(billingKey) || text.includes(billingKey.toLowerCase());
};

const incidentNear = (incident, timestamp) => {
  const created = Date.parse(incident.created_iso) / 1000;
  return Number.isFinite(created) && Math.abs(created - timestamp) <= DAY;
};

const incidentCovers = (incident, first, last) => {
  const start = Date.parse(incident.coverage_start_iso) / 1000;
  const end = Date.parse(incident.coverage_end_iso) / 1000;
  return Number.isFinite(start) && Number.isFinite(end) && start <= first && end >= last;
};

const sharedBillingKey = charges => {
  if (!charges.length) return null;
  const rest = charges.slice(1).map(c => new Set(c.billing_keys || []));
  return (charges[0].billing_keys || []).find(key => rest.every(keys => keys.has(key))) || null;
};

const evidenceFor = (charges, incidents = []) => [
  ...charges.map(c => ({
    source: 'stripe',
    id: c.id,
    detail: `${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()} · ${c.status} · ${c.description || ''}`,
  })),
  ...incidents.map(i => ({ source: 'github', id: `#${i.number}`, detail: i.title })),
];

/**
 * Find one purchase-shaped group with more than one excess charge.
 */
export function findMultipleDuplicateGroup(charges, incidents, preferredIds = []) {
  const eligible = charges
    .filter(c => c.status === 'succeeded' && !c.refunded && c.amount_refunded === 0)
    .filter(c => Number.isSafeInteger(c.amount) && c.amount > 0 && Number.isFinite(c.created));
  const buckets = new Map();
  for (const charge of eligible) {
    const key = JSON.stringify([charge.amount, charge.currency]);
    const bucket = buckets.get(key) || [];
    bucket.push(charge);
    buckets.set(key, bucket);
  }

  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    for (let start = 0; start < bucket.length; start++) {
      const candidates = bucket.slice(start).filter(c => c.created - bucket[start].created <= MONTH);
      for (let end = candidates.length; end >= 3; end--) {
        const group = candidates.slice(0, end);
        const span = group.at(-1).created - group[0].created;
        const description = group[0].description?.trim();
        const sameDescription = Boolean(description) && group.every(c => c.description?.trim() === description);
        const matchingIncidents = incidents.filter(i => span <= DAY
          ? incidentRelevant(i) && (incidentNear(i, group[0].created) || incidentNear(i, group.at(-1).created))
          : incidentCovers(i, group[0].created, group.at(-1).created));
        const billingKey = sharedBillingKey(group);
        if (preferredIds.length && !preferredIds.every(id => group.some(c => c.id === id))) continue;
        if (span <= DAY && !sameDescription && !matchingIncidents.length) continue;
        if (span > DAY && (!billingKey || !matchingIncidents.some(i => incidentRelevant(i, billingKey)))) continue;
        return { charges: group, incidents: matchingIncidents, sameDescription, billingKey, extended: span > DAY };
      }
    }
  }
  return null;
}

function multipleDuplicateFinding(group, original = {}) {
  const [legitimate, ...duplicates] = group.charges;
  const total = duplicates.reduce((sum, c) => sum + c.amount, 0);
  if (duplicates.length > MAX_BATCH_REFUNDS || total > MAX_BATCH_TOTAL) return {
    ...original, verdict: 'insufficient_evidence', outcome: 'batch_limit_exceeded',
    charge_to_refund: null, duplicate_of: null, legitimate_charge: legitimate.id,
    duplicate_charges: duplicates.map(c => c.id), excess_charge_count: duplicates.length,
    grounds: `${group.charges.length} matching charges were found, but the correction exceeds the automatic batch limit.`,
    missing_evidence: `Manual billing review is required for more than ${MAX_BATCH_REFUNDS} refunds or a total above ${MAX_BATCH_TOTAL} minor currency units.`,
    uncertainty: 'No refund was proposed because the batch exceeds the configured financial boundary.',
    evidence: evidenceFor(group.charges, group.incidents), model_verdict: original.verdict,
  };
  return {
    ...original,
    verdict: 'duplicate',
    outcome: 'multiple_duplicates',
    charge_to_refund: null,
    duplicate_of: null,
    legitimate_charge: legitimate.id,
    duplicate_charges: duplicates.map(c => c.id),
    excess_charge_count: duplicates.length,
    grounds: `${group.charges.length} matching charges were found ${group.extended ? `within 30 days with shared billing key ${group.billingKey} and an incident covering the window` : 'in one 24-hour window'}; ${duplicates.length} full refunds are proposed as one batch.`,
    missing_evidence: null,
    uncertainty: 'Every excess charge must remain unchanged and the exact batch must receive human approval before any refund executes.',
    evidence: evidenceFor(group.charges, group.incidents),
    model_verdict: original.verdict,
  };
}

export function enforceDuplicateRule(finding, charges, incidents) {
  const preferred = finding.verdict === 'duplicate' ? [finding.charge_to_refund, finding.duplicate_of].filter(Boolean) : [];
  const multiple = (finding.verdict === 'duplicate' || finding.rules_scan)
    ? findMultipleDuplicateGroup(charges, incidents, preferred) : null;
  if (multiple) {
    return {
      finding: multipleDuplicateFinding(multiple, finding),
      overridden: false,
      reason: null,
    };
  }
  if (finding.verdict !== 'duplicate') return { finding: classifyRefusal(finding, charges, incidents), overridden: false };
  const byId = new Map(charges.map((c) => [c.id, c]));
  const r = byId.get(finding.charge_to_refund);
  const k = byId.get(finding.duplicate_of);

  const fail = (reason, outcome = 'insufficient_evidence') => ({
    overridden: true,
    reason,
    finding: {
      ...finding,
      verdict: 'insufficient_evidence',
      outcome,
      charge_to_refund: null,
      duplicate_of: null,
      missing_evidence: `No additional automatic refund is eligible: ${reason}.`,
      uncertainty: `The proposed correction did not pass the code check (${reason}).`,
      model_verdict: 'duplicate',
      evidence: charges.filter(c => c.id === r?.id || c.id === k?.id).map(c => ({ source: 'stripe', id: c.id, detail: `${c.amount} ${c.currency} · refunded ${c.amount_refunded || 0}` })),
    },
  });

  if (!r || !k) return fail('a named charge is not on this account');
  if (r.id === k.id) return fail('the refund and the kept charge are the same charge');
  if (r.status !== 'succeeded' || k.status !== 'succeeded') return fail('both charges must have succeeded');
  if (!Number.isSafeInteger(r.amount) || r.amount <= 0 || !Number.isFinite(r.created) || !Number.isFinite(k.created)) return fail('charge amount or timestamp is invalid');
  if (r.amount !== k.amount) return fail(`the amounts differ (${r.amount} vs ${k.amount})`);
  if (r.currency !== k.currency) return fail('the currencies differ');
  const span = Math.abs(r.created - k.created);
  if (span > MONTH) return fail('the charges are more than 30 days apart');
  if (r.created < k.created) return fail('the proposed refund is the earlier charge, not the later one');

  const sameDescription = Boolean(r.description?.trim()) && r.description.trim() === k.description?.trim();
  const incident = incidents.some((i) => incidentRelevant(i) && incidentNear(i, r.created));
  const extended = span > DAY;
  const billingKey = sharedBillingKey([r, k]);
  const coveringIncident = incidents.some(i => incidentCovers(i, Math.min(r.created, k.created), Math.max(r.created, k.created)) && incidentRelevant(i, billingKey));
  if (extended && (!billingKey || !coveringIncident)) {
    return fail('charges beyond 24 hours require a shared billing identifier and an incident explicitly covering the full window');
  }
  if (!extended && !sameDescription && !incident) {
    return fail('the descriptions differ and no incident covers that window');
  }
  if (r.refunded || r.amount_refunded >= r.amount) return fail('the charge to refund has already been refunded', 'already_refunded');
  if (r.amount_refunded > 0) return fail('the charge to refund has already been partially refunded', 'partially_refunded');
  if (k.refunded || k.amount_refunded > 0) return fail('the kept charge has a prior refund and needs manual review');
  const evidence = [r, k].map(c => ({ source: 'stripe', id: c.id, detail: `${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()} · ${c.status} · ${c.description || ''}` }));
  const corroborating = incidents.find(i => extended
    ? incidentCovers(i, Math.min(r.created, k.created), Math.max(r.created, k.created))
    : incidentRelevant(i) && incidentNear(i, r.created));
  if (corroborating) evidence.push({ source: 'github', id: `#${corroborating.number}`, detail: corroborating.title });
  return { finding: { ...finding, outcome: 'duplicate', evidence }, overridden: false };
}

/** Determine refund-related refusals from records, never from a model-supplied reason code. */
function classifyRefusal(finding, charges, incidents) {
  for (const r of charges) for (const k of charges) {
    if (r.id === k.id || !(r.amount_refunded > 0 || r.refunded)) continue;
    const checked = enforceDuplicateRule({ verdict: 'duplicate', charge_to_refund: r.id, duplicate_of: k.id }, charges, incidents);
    if (['already_refunded','partially_refunded'].includes(checked.finding.outcome)) return {
      ...checked.finding, grounds: 'A matching charge has a prior refund.', model_verdict: finding.verdict,
    };
  }
  const succeeded = charges.filter(c => c.status === 'succeeded');
  const possiblePair = succeeded.some(a => succeeded.some(b => a.id !== b.id && a.amount === b.amount && a.currency === b.currency && Math.abs(a.created-b.created) <= DAY));
  const outcome = succeeded.length >= 2 && !possiblePair ? 'not_duplicate' : 'insufficient_evidence';
  return { ...finding, outcome, charge_to_refund: null, duplicate_of: null,
    evidence: charges.map(c => ({ source: 'stripe', id: c.id, detail: `${(c.amount/100).toFixed(2)} ${c.currency.toUpperCase()} · ${c.status}` })),
    missing_evidence: finding.missing_evidence || 'The available records did not establish a duplicate.' };
}
