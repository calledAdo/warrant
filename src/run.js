/**
 * Public API over the LangGraph run. The server and tests call these; the
 * graph in ./graph.js does the work.
 *
 * Each call is one graph segment and one Lemma trace, linked by threadId:
 *   investigate  → warrant.investigate  (START … human_review interrupt, or refusal)
 *   execute      → warrant.execute      (resume with "approve" … finalize)
 *   resume       → warrant.execute      (re-run only the node that failed)
 *   decline      → warrant.decline      (resume with "decline" … decline_done)
 *   replay       → warrant.replay       (fork from the checkpoint before refund)
 */
import { Command } from '@langchain/langgraph';
import { graph, checkpointer } from './graph.js';
import { runs, createRun } from './runstate.js';
import { recordApproval, getApproval, opsForPlan, opsForRun } from './journal.js';
import { isExpired, planRefunds, renewPlan } from './plan.js';
import { lemma } from './trace.js';
import { withRunLease } from './coordinator.js';

export { runs, createRun };

const threadConfig = (run, extra = {}) => ({ configurable: { thread_id: run.id, ...extra } });

const EXEC_STEPS = [
  ['verify_charge', 'verify charge'],
  ['refund', 'refund'],
  ['verify_refund', 'verify refund'],
  ['update_case', 'update case'],
  ['update_slack', 'update slack'],
];

/** Read LangGraph's view of the thread and derive the console status from it. */
export async function sync(run) {
  const st = await graph.getState(threadConfig(run));
  const interrupted = (st.tasks || []).some((t) => t.interrupts?.length);
  const checkpoints = checkpointer.count(run.id);
  run.engine = { framework: 'langgraph', next: st.next || [], interrupted, checkpoints };

  const v = st.values || {};
  const refundOps = run.plan ? opsForRun(run).filter(op => op.step === 'refund') : [];
  const successfulRefunds = refundOps.filter(op => op.status === 'succeeded').length;
  const failedRefunds = refundOps.filter(op => op.status === 'failed').length;
  const uncertainRefund = refundOps.some(op => ['uncertain', 'intended'].includes(op.status));
  const expectedRefunds = run.plan ? planRefunds(run.plan).length : 0;
  const refundedAmount = refundOps.filter(op => op.status === 'succeeded').reduce((sum, op) => {
    try { return sum + (JSON.parse(op.result || 'null')?.amount || 0); } catch { return sum; }
  }, 0);
  run.refundProgress = run.plan ? { completed: successfulRefunds, expected: expectedRefunds, amount: refundedAmount,
    total: run.plan.total_amount ?? run.plan.amount } : null;
  for (const key of ['finding','caseNumber','caseUrl','slackRef','customer']) if (v[key] != null) run[key] = v[key];
  if (v.plan != null) {
    const approval = getApproval(v.plan.plan_id, run.id);
    run.plan = approval && isExpired(v.plan) && !isExpired(approval.plan) ? approval.plan : v.plan;
  }
  if (v.charges) run.charges = v.charges;
  if (v.incidents) run.incidentsSeen = v.incidents.map(i => ({ number: i.number, title: i.title, url: i.url }));
  if (v.decision) {
    run.approver = v.decision.approver;
    run.declineReason = v.decision.reason || '';
  }
  if (interrupted) {
    const held = (st.tasks || []).some(t => t.interrupts?.some(i => i.value?.kind === 'lemma_hold'));
    if (held) {
      run.status = 'held';
      run.hold ||= st.tasks.flatMap(t => t.interrupts || []).find(i => i.value?.kind === 'lemma_hold')?.value;
    } else if (run.plan && getApproval(run.plan.plan_id, run.id)) run.status = 'approved';
    else if (run.decisionRequest?.decision === 'decline') run.status = 'declined';
    else run.status = 'awaiting_approval';
  } else if ((st.next || []).length) {
    run.status = uncertainRefund ? 'uncertain'
      : successfulRefunds > 0 && successfulRefunds < expectedRefunds ? 'financial_partial'
      : v.verifiedAmount != null && run.plan ? 'notification_partial'
      : failedRefunds > 0 ? 'failed'
      : v.decision?.decision === 'decline' ? 'declined' : 'error';
  } else if (v.verifiedAmount != null) {
    run.status = 'complete';
    run.pending = [];
    run.error = null;
  } else if (v.decision?.decision === 'decline') {
    run.status = 'declined'; run.pending = []; run.error = null;
  } else if (v.finding?.verdict === 'insufficient_evidence' && v.slackRef) {
    run.status = 'refused';
    run.error = null;
  } else if (!st.createdAt && run.status === 'running') {
    run.status = 'error'; run.error = 'Investigation interrupted before its first checkpoint; resume to start it.';
  }
  run.emit('update', run.snapshot());
  return st;
}

/** One graph segment inside one Lemma trace. */
async function segment(run, name, input, drive) {
  if (run.busy) throw new Error('run_busy');
  return withRunLease(run.id, async () => {
    run.busy = true;
    try {
    await lemma.trace(
      { name, input, threadId: `case-${run.customerId}`, metadata: { run_id: run.id, plan_id: run.plan?.plan_id ?? null } },
      async (trace) => {
        run.trace = trace;
        if (name === 'warrant.investigate') run.traceId = trace.id;
        else run.execTraceId = trace.id;
        run.traceIds = [...new Set([...(run.traceIds || []),trace.id].filter(Boolean))];
        run.persist();
        try {
          await drive();
        } catch (e) {
          if (!run.pending.some((p) => p.error === e.message)) run.error = e.message;
        }
        const st = await sync(run);
        trace.recordSpan({
          name: 'graph-state',
          output: { status: run.status, next: st.next, checkpoints: run.engine.checkpoints, pending: run.pending.map((p) => p.step) },
        });
        return { status: run.status, pending: run.pending.map((p) => p.step) };
      }
    );
      return run.snapshot();
    } finally { run.busy = false; run.persist(); }
  });
}

export async function investigate(run) {
  if (run.busy) throw new Error('run_busy');
  const existing = await graph.getState(threadConfig(run));
  if (existing.createdAt) return resume(run);
  return segment(run, 'warrant.investigate', run.report, () =>
    graph.invoke({ customerId: run.customerId, report: run.report }, threadConfig(run)));
}

/** Record the human's approval against the exact plan hash. Execution resumes separately. */
export function approve(run, approver = 'ops@warrant.test') {
  if (!run.plan) throw new Error('no plan to approve');
  const reapproval = ['financial_partial', 'failed'].includes(run.status)
    || (run.status === 'error' && /approval_expired/.test(run.error || ''));
  if (run.status !== 'awaiting_approval' && !reapproval) throw new Error(`cannot approve a run that is ${run.status}`);
  if (run.busy) throw new Error('run_busy');
  if (!reapproval && isExpired(run.plan)) throw new Error('approval_expired');
  if (reapproval) run.plan = renewPlan(run.plan);
  recordApproval(run.plan, approver, run.id);
  run.approver = approver;
  run.status = 'approved';
  run.resumeApproved = reapproval;
  run.emit('update', run.snapshot());
  return getApproval(run.plan.plan_id, run.id);
}

/** Resume the paused graph with the approval. Re-calling on a finished run is a no-op. */
export async function execute(run) {
  if (run.status !== 'approved') return run.snapshot();
  if (run.resumeApproved) {
    run.resumeApproved = false;
    run.persist();
    return resume(run);
  }
  for (const [k, l] of EXEC_STEPS) if (!run.steps.find((s) => s.key === k)) run.step(k, l, 'idle');
  run.status = 'executing';
  run.pending = [];
  return segment(run, 'warrant.execute', { plan_id: run.plan.plan_id, approver: run.approver }, () =>
    graph.invoke(new Command({ resume: { decision: 'approve', approver: run.approver, plan_id: run.plan.plan_id } }), threadConfig(run)));
}

/** Continue from the durable checkpoint; the journal skips completed writes on re-entry. */
export async function resume(run) {
  if (run.busy) throw new Error('run_busy');
  const st = await sync(run);
  if (run.status === 'uncertain') return run.snapshot();
  const interrupts = (st.tasks || []).flatMap(t => t.interrupts || []);
  if (interrupts.some(i => i.value?.kind === 'lemma_hold')) {
    return segment(run, 'warrant.investigate', { resume: 'check hold' }, () =>
      graph.invoke(new Command({ resume: { retry: true } }), threadConfig(run)));
  }
  if (interrupts.length) {
    if (run.status === 'approved') return execute(run);
    if (run.decisionRequest?.decision === 'decline') return segment(run, 'warrant.decline', run.decisionRequest, () =>
      graph.invoke(new Command({ resume: run.decisionRequest }), threadConfig(run)));
    return run.snapshot();
  }
  if (!st.createdAt) return investigate(run);
  if (!(st.next || []).length) return run.snapshot();
  run.error = null;
  return segment(run, st.values?.decision?.decision === 'decline' ? 'warrant.decline'
    : st.values?.decision ? 'warrant.execute' : 'warrant.investigate', { resume: st.next }, () =>
    graph.invoke(null, threadConfig(run)));
}

export async function decline(run, approver = 'ops@warrant.test', reason = '') {
  if (!run.plan) throw new Error('no plan to decline');
  if (run.status !== 'awaiting_approval') throw new Error(`cannot decline a run that is ${run.status}`);
  if (run.busy) throw new Error('run_busy');
  run.decisionRequest = { decision: 'decline', approver, reason, plan_id: run.plan.plan_id };
  run.approver = approver;
  run.declineReason = reason;
  run.status = 'declined';
  run.pending = [];
  run.emit('update', run.snapshot());
  return segment(run, 'warrant.decline', { plan_id: run.plan.plan_id, approver, reason }, () =>
    graph.invoke(new Command({ resume: { decision: 'decline', approver, reason, plan_id: run.plan.plan_id } }), threadConfig(run)));
}

/**
 * Replay from LangGraph history: fork the thread at the checkpoint taken just
 * before the refund node and run forward again. The checkpoint makes this
 * possible; the journal is what keeps it from refunding a second time.
 */
export async function replay(run) {
  if (run.busy) throw new Error('run_busy');
  let before = null;
  for await (const snap of graph.getStateHistory(threadConfig(run))) {
    if ((snap.next || []).includes('refund')) { before = snap; break; }
  }
  if (!before) throw new Error('no checkpoint before refund — nothing to replay');
  run.status = 'executing';
  return segment(run, 'warrant.replay', { from_checkpoint: before.config.configurable.checkpoint_id }, () =>
    graph.invoke(null, { configurable: { thread_id: run.id, checkpoint_id: before.config.configurable.checkpoint_id } }));
}

export const journalFor = (id) => runs.has(id) ? opsForRun(runs.get(id)) : opsForPlan(id);

/** Rebuild status from durable checkpoints; never execute external writes at startup. */
export async function recoverRuns() {
  for (const run of runs.values()) {
    try { await sync(run); }
    catch(error) { run.status = 'error'; run.error = `Recovery failed: ${error.message}`; run.persist(); }
  }
}
