/**
 * The UI-facing view of a run. LangGraph owns execution state and checkpoints;
 * this object mirrors progress for the console (step timings, status) and
 * holds the Lemma trace handle for the segment currently executing.
 */
import { EventEmitter } from 'node:events';

export const runs = new Map();

export class Run extends EventEmitter {
  constructor(id, report, customerId) {
    super();
    this.id = id;
    this.report = report;
    this.customerId = customerId;
    this.steps = [];
    this.plan = null;
    this.slackRef = null;
    this.caseNumber = null;
    this.status = 'running';
    this.pending = [];
    this.engine = { framework: 'langgraph', next: [], checkpoints: 0 };
  }

  /** Tag the most recent attempt as journal-skipped (no external write happened). */
  markSkipped(key) {
    const s = this.steps.find((x) => x.key === key);
    const at = s?.attempts?.[s.attempts.length - 1];
    if (at) at.skipped = true;
  }

  step(key, label, state, detail) {
    const existing = this.steps.find((s) => s.key === key);
    const s = existing || { key, label };
    const prev = s.state;
    s.state = state;
    if (detail !== undefined) s.detail = detail;

    // Each activation is a separate attempt, so a retried node renders as a
    // second segment rather than moving the first.
    s.attempts ??= [];
    if (state === 'active' && prev !== 'active') {
      const at = { startedAt: Date.now(), endedAt: null, state: 'active' };
      s.attempts.push(at);
      s.startedAt = s.attempts[0].startedAt;
      this.t0 ??= at.startedAt;
    }
    if (['done', 'failed', 'refused'].includes(state)) {
      const at = s.attempts[s.attempts.length - 1];
      if (at && !at.endedAt) {
        at.endedAt = Date.now();
        at.state = state;
        at.durationMs = at.endedAt - at.startedAt;
      }
      s.endedAt = at?.endedAt ?? s.endedAt;
      s.durationMs = s.attempts.reduce((n, a) => n + (a.durationMs || 0), 0);
      s.retried = s.attempts.length > 1;
    }
    if (!existing) this.steps.push(s);
    this.emit('update', this.snapshot());
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      t0: this.t0 ?? null,
      traceId: this.traceId ?? null,
      execTraceId: this.execTraceId ?? null,
      finding: this.finding ?? null,
      llm: this.llm ?? null,
      guard: this.guard ?? null,
      incidents: this.incidentsSeen ?? null,
      now: Date.now(),
      steps: this.steps,
      plan: this.plan,
      caseNumber: this.caseNumber,
      caseUrl: this.caseUrl ?? null,
      pending: this.pending,
      customerId: this.customerId,
      report: this.report,
      approver: this.approver ?? null,
      declineReason: this.declineReason ?? null,
      error: this.error ?? null,
      engine: this.engine,
    };
  }
}

const STEPS_INVESTIGATE = [
  ['read_charges', 'read charges'],
  ['read_incidents', 'search incidents'],
  ['assemble', 'assemble case'],
  ['write_case', 'write case'],
  ['post_proposal', 'post to slack'],
];

export function createRun(report, customerId) {
  const id = 'run_' + Math.random().toString(36).slice(2, 10);
  const run = new Run(id, report, customerId);
  runs.set(id, run);
  for (const [k, l] of STEPS_INVESTIGATE) run.step(k, l, 'idle');
  return run;
}
