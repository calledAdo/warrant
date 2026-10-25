// Canonical H-MEM shapes per AGENTS.md section 2 and 9.
export const FEEDBACK_DELTAS = { helpful: 0.05, not_helpful: -0.03, wrong: -0.2 };
export const DEFAULTS = {
    retrievalTopN: 5,
    retrievalThreshold: 0.35, // on the final score, after the confidence multiplier
    consolidationDays: 7,
    archiveMinDays: 30,
    archiveMaxAccess: 2,
    synthesisCosine: 0.82,
    dreamClusterMinSize: 2,
    dreamRelatedness: 0.35,
    maxDreamProposalsPerType: 8,
    conflictAutoResolveGate: 0.7,
    entityCap: 10,
    relatedCap: 5,
    recencyDays: 14,
};
export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const DAY_MS = 24 * 60 * 60 * 1000;
