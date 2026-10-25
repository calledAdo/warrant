/**
 * Warrant H-MEM integration — precedent memory for refund decisions.
 * Uses the vendored Meterless H-MEM engine with durable JSONL persistence.
 * Stores approver corrections and past decisions with provenance and trust-ledger entries.
 * Retrieves relevant precedents for each new case and cites them in findings.
 * Conflict detection flags precedent that contradicts the current policy.
 */
import { HMEM } from '../engines/hmem/dist/index.js';
// Trace is imported dynamically where needed; we only use the emit method
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {Object} PrecedentRecord
 * @property {string} id
 * @property {string} content
 * @property {number} confidence
 * @property {string} source
 * @property {Object} provenance
 * @property {string} provenance.origin
 * @property {string} provenance.learnedAt
 * @property {string} provenance.label
 * @property {string[]} [provenance.refs]
 * @property {string[]} tags
 * @property {string} layer
 * @property {string[]} entities
 * @property {string[]} relatedTo
 * @property {string} [supersededBy]
 * @property {string[]} [derivedFrom]
 */

let hmemInstance;
let hmemInstanceDir = null;
let hmemClock = () => Date.now();

function getPrecedentDir() {
  return process.env.WARRANT_HMEM_DIR || 'data/hmem';
}

function getHmem() {
  const currentDir = getPrecedentDir();
  // Recreate HMEM instance if directory changed (for test isolation)
  if (!hmemInstance || hmemInstanceDir !== currentDir) {
    hmemInstance = new HMEM({ clock: hmemClock, persistDir: currentDir });
    hmemInstanceDir = currentDir;
  }
  return hmemInstance;
}

export class PrecedentMemory {
  constructor() {
    this.hmem = getHmem();
  }

  /**
   * Store an approver correction as precedent memory.
   * Called when an approver rejects a proposal or corrects a finding.
   * @param {{
   *   customerId: string;
   *   caseId: string;
   *   originalFinding: string;
   *   originalProposal: any;
   *   approverDecision: 'approve' | 'decline';
   *   approverReason: string;
   *   correctedFinding?: string;
   *   trace: Trace;
   * }} param0
   * @returns {Promise<string>}
   */
  async recordCorrection({ customerId, caseId, originalFinding, originalProposal, approverDecision, approverReason, correctedFinding, trace }) {
    const hmem = this.hmem;
    const content = `Approver ${approverDecision === 'decline' ? 'rejected' : 'corrected'} refund proposal for case ${caseId} (customer ${customerId}). ` +
      `Original finding: ${originalFinding}. Approver reason: ${approverReason}. ` +
      (correctedFinding ? `Corrected finding: ${correctedFinding}.` : '');

    const memory = hmem.add({
      content,
      source: 'approver_correction',
      provenance: {
        origin: 'user_correction',
        learnedAt: new Date().toISOString(),
        label: `Approver ${approverDecision} on case ${caseId}`,
        refs: [caseId],
      },
      tags: ['precedent', 'refund', 'correction', approverDecision, customerId],
      confidence: 0.95,
      layer: 'long_term',
      chatId: customerId,
      missionId: caseId,
    });

    trace.emit?.('hmem', 'precedent', 'Recorded approver correction', {
      memoryId: memory.id,
      caseId,
      customerId,
      decision: approverDecision,
    });

    return memory.id;
  }

  /**
   * Store a past decision (approved refund or declined) as precedent.
   * @param {{
   *   customerId: string;
   *   caseId: string;
   *   finding: string;
   *   proposal: any;
   *   approverDecision: 'approve' | 'decline';
   *   approverReason: string;
   *   trace: Trace;
   * }} param0
   * @returns {Promise<string>}
   */
  async recordDecision({ customerId, caseId, finding, proposal, approverDecision, approverReason, trace }) {
    const hmem = this.hmem;
    const content = `Refund ${approverDecision === 'approve' ? 'approved' : 'declined'} for case ${caseId} (customer ${customerId}). ` +
      `Finding: ${finding}. Proposal: ${JSON.stringify(proposal)}. Approver reason: ${approverReason}.`;

    const memory = hmem.add({
      content,
      source: 'past_decision',
      provenance: {
        origin: 'decision',
        learnedAt: new Date().toISOString(),
        label: `Refund ${approverDecision} on case ${caseId}`,
        refs: [caseId],
      },
      tags: ['precedent', 'refund', 'decision', approverDecision, customerId],
      confidence: 0.9,
      layer: 'long_term',
      chatId: customerId,
      missionId: caseId,
    });

    trace.emit?.('hmem', 'precedent', 'Recorded past decision', {
      memoryId: memory.id,
      caseId,
      customerId,
      decision: approverDecision,
    });

    return memory.id;
  }

  /**
   * Retrieve relevant precedents for a new case.
   * Returns memories with scores and metadata for citation.
   * @param {{
   *   customerId: string;
   *   complaintText: string;
   *   trace: Trace;
   * }} param0
   * @returns {Promise<Array<{ memory: PrecedentRecord; score: number; relevance: string }>>}
   */
  async retrievePrecedents({ customerId, complaintText, trace }) {
    const hmem = this.hmem;

    // Query with the complaint text to find relevant precedents.
    // Threshold lowered to 0.10 to work with the deterministic FNV-1a embedder
    // which has limited semantic discrimination but good keyword overlap.
    // Filter by customerId via chatId to isolate precedents per customer.
    const result = hmem.query(complaintText, { threshold: 0.10, topN: 10, chatId: customerId });

    const precedents = result.memories
      .filter(m => m.memory.provenance?.origin === 'user_correction' || m.memory.provenance?.origin === 'decision')
      .map(m => ({
        memory: m.memory,
        score: m.relevance,
        relevance: this.explainRelevance(m.memory.content, complaintText),
      }));

    trace.emit?.('hmem', 'precedent', `Retrieved ${precedents.length} relevant precedents`, {
      customerId,
      precedents: precedents.map(p => ({ id: p.memory.id, score: p.score, tags: p.memory.tags })),
    });

    return precedents;
  }

  /**
   * Detect conflicts between retrieved precedents and current policy.
   * Returns any precedents that contradict the duplicate policy.
   * @param {Array<{ memory: PrecedentRecord; score: number }>} precedents
   * @returns {Array<{ memory: PrecedentRecord; conflict: string }>}
   */
  detectConflicts(precedents) {
    const conflicts = [];

    for (const p of precedents) {
      const mem = p.memory;
      // Check if precedent says "plan change + proration is not a duplicate" but current policy might allow it
      if (mem.content.includes('not a duplicate') && mem.content.includes('plan change') && mem.content.includes('proration')) {
        conflicts.push({ memory: mem, conflict: 'Precedent rejects plan-change+proration as duplicate; current policy may differ' });
      }
      // Check for any precedent that explicitly contradicts the duplicate rule
      if (mem.tags.includes('correction') && mem.content.includes('duplicate') && mem.confidence > 0.8) {
        conflicts.push({ memory: mem, conflict: 'High-confidence approver correction contradicts standard duplicate rule' });
      }
    }

    return conflicts;
  }

  /**
   * Apply feedback to a precedent (helpful/not_helpful/wrong).
   * @param {string} memoryId
   * @param {'helpful' | 'not_helpful' | 'wrong'} kind
   * @param {Trace} trace
   * @returns {Promise<void>}
   */
  async feedback(memoryId, kind, trace) {
    const hmem = this.hmem;
    hmem.feedback(memoryId, kind);
    trace.emit?.('hmem', 'precedent', `Feedback applied to precedent ${memoryId}`, { kind });
  }

  /**
   * Get all precedent memories for audit/export.
   * @returns {Promise<PrecedentRecord[]>}
   */
  async getAllPrecedents() {
    const dir = getPrecedentDir();
    const eventsPath = join(dir, 'events.jsonl');
    if (!existsSync(eventsPath)) return [];
    
    const content = readFileSync(eventsPath, 'utf8').trim();
    if (!content) return [];
    
    const lines = content.split('\n').filter(Boolean);
    const allMemories = [];
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.records && Array.isArray(entry.records)) {
          allMemories.push(...entry.records);
        }
      } catch {
        // Skip invalid lines
      }
    }
    
    return allMemories
      .filter(m => m.tags?.includes('precedent'))
      .map(m => m);
  }

  /**
   * Run sleep cycle for consolidation (optional, for long-running processes).
   * @returns {Promise<void>}
   */
  async sleep() {
    const hmem = this.hmem;
    if (hmem.sleep) {
      await hmem.sleep();
    }
  }

  /**
   * @param {string} memoryContent
   * @param {string} query
   * @returns {string}
   */
  explainRelevance(memoryContent, query) {
    const memLower = memoryContent.toLowerCase();
    const queryLower = query.toLowerCase();
    const sharedWords = new Set(queryLower.split(/\W+/).filter(w => w.length > 3 && memLower.includes(w)));
    if (sharedWords.size > 0) return `Shares keywords: ${[...sharedWords].slice(0, 5).join(', ')}`;
    return 'Semantic similarity';
  }
}

/** Singleton instance for the run. */
let precedentMemoryInstance = null;

export function getPrecedentMemory() {
  if (!precedentMemoryInstance) {
    precedentMemoryInstance = new PrecedentMemory();
  }
  return precedentMemoryInstance;
}

export function resetPrecedentMemory() {
  precedentMemoryInstance = null;
  hmemInstance = null;
}