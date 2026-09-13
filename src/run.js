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
import { graph } from './graph.js';
import { runs, createRun } from './runstate.js';
import { recordApproval, getApproval, opsForPlan } from './journal.js';
import { lemma } from './trace.js';

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
async function sync(run) {
  const st = await graph.getState(threadConfig(run));
  const interrupted = (st.tasks || []).some((t) => t.interrupts?.length);
  let checkpoints = 0;
  for await (const _ of graph.getStateHistory(threadConfig(run))) checkpoints++;
  run.engine = { framework: 'langgraph', next: st.next || [], interrupted, checkpoints };

  if (interrupted) {
    run.status = 'awaiting_approval';
  } else if ((st.next || []).length) {
    // Stopped mid-graph because a node threw. If the money already moved and
    // was verified, that is a partial outcome to resume, not a failure.
    run.status = st.values?.verifiedAmount != null && run.plan ? 'partial'
      : run.status === 'declined' ? 'declined'
      : 'error';
  }
  run.emit('update', run.snapshot());
  return st;
}

/** One graph segment inside one Lemma trace. */
async function segment(run, name, input, drive) {
  await lemma.trace(
    { name, input, threadId: `case-${run.customerId}`, metadata: { run_id: run.id, plan_id: run.plan?.plan_id ?? null } },
    async (trace) => {
      run.trace = trace;
      if (name === 'warrant.investigate') run.traceId = trace.id;
      else run.execTraceId = trace.id;
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
}

export async function investigate(run) {
  return segment(run, 'warrant.investigate', run.report, () =>
    graph.invoke({ customerId: run.customerId, report: run.report }, threadConfig(run)));
}

/** Record the human's approval against the exact plan hash. Execution resumes separately. */
export function approve(run, approver = 'ops@warrant.test') {
  if (!run.plan) throw new Error('no plan to approve');
  if (run.status !== 'awaiting_approval') throw new Error(`cannot approve a run that is ${run.status}`);
  recordApproval(run.plan, approver);
  run.approver = approver;
  run.status = 'approved';
  run.emit('update', run.snapshot());
  return getApproval(run.plan.plan_id);
}

/** Resume the paused graph with the approval. Re-calling on a finished run is a no-op. */
export async function execute(run) {
  if (run.status === 'partial') return resume(run);
  if (run.status !== 'approved') return run.snapshot();
  for (const [k, l] of EXEC_STEPS) if (!run.steps.find((s) => s.key === k)) run.step(k, l, 'idle');
  run.status = 'executing';
  run.pending = [];
  return segment(run, 'warrant.execute', { plan_id: run.plan.plan_id, approver: run.approver }, () =>
    graph.invoke(new Command({ resume: { decision: 'approve', approver: run.approver, plan_id: run.plan.plan_id } }), threadConfig(run)));
}

/** Re-run only what failed. Completed nodes are checkpointed and not repeated. */
export async function resume(run) {
  const st = await graph.getState(threadConfig(run));
  if (!(st.next || []).length || (st.tasks || []).some((t) => t.interrupts?.length)) return run.snapshot();
  if (run.status !== 'declined') run.status = 'executing';
  run.error = null;
  return segment(run, run.status === 'declined' ? 'warrant.decline' : 'warrant.execute', { resume: st.next }, () =>
    graph.invoke(null, threadConfig(run)));
}

export async function decline(run, approver = 'ops@warrant.test', reason = '') {
  if (!run.plan) throw new Error('no plan to decline');
  if (run.status !== 'awaiting_approval') throw new Error(`cannot decline a run that is ${run.status}`);
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
  let before = null;
  for await (const snap of graph.getStateHistory(threadConfig(run))) {
    if ((snap.next || []).includes('refund')) { before = snap; break; }
  }
  if (!before) throw new Error('no checkpoint before refund — nothing to replay');
  run.status = 'executing';
  return segment(run, 'warrant.replay', { from_checkpoint: before.config.configurable.checkpoint_id }, () =>
    graph.invoke(null, { configurable: { thread_id: run.id, checkpoint_id: before.config.configurable.checkpoint_id } }));
}

export const journalFor = (planId) => opsForPlan(planId);
