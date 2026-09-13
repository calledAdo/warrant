/**
 * Warrant as a LangGraph state machine.
 *
 *   load_customer → agent ⇄ tools (search_charges, search_incidents; ≤ 8 calls)
 *                 → decide → write_case ─┬→ post_refusal → END
 *                                        └→ propose → human_review (interrupt)
 *   human_review ─┬→ verify_charge → refund → verify_refund ─┬→ update_case  ─┬→ finalize → END
 *                 │                                          └→ update_slack ─┘
 *                 └→ record_decline ─┬→ decline_case  ─┬→ decline_done → END
 *                                    └→ decline_slack ─┘
 *
 * The model drives one loop (agent ⇄ tools): it chooses what evidence to look
 * up and how far back to go, through read-only tools scoped and capped in code.
 * decide re-checks its verdict in code. Every node after that is deterministic.
 * The graph is checkpointed after each super-step, so:
 *   - the approval is a real pause: interrupt() persists state and the run
 *     resumes with the human's decision,
 *   - a failed follow-up (e.g. Slack rate-limited) stops the graph after the
 *     refund is verified, and resuming continues from the last checkpoint
 *     instead of restarting the run,
 *   - resuming can re-enter a sibling that already finished (observed: the
 *     GitHub update re-runs when Slack fails alongside it), and replaying from
 *     an older checkpoint re-enters the refund node. The operation journal
 *     under every external write is what turns those re-entries into no-ops,
 *     so money moves once and each record is written once.
 */
import { StateGraph, Annotation, START, END, MemorySaver, interrupt } from '@langchain/langgraph';
import * as stripe from './adapters/stripe.js';
import * as github from './adapters/github.js';
import * as slack from './adapters/slack.js';
import { caseBody } from './agent.js';
import { chatWithTools } from './llm.js';
import { TOOLS, MAX_TOOL_CALLS, FINISH, recoverToolCall, initialMessages, runTool, decide as decideFinding, rulesInvestigation } from './agent-tools.js';
import { buildPlan, hashPlan, isExpired } from './plan.js';
import { withJournal, getApproval } from './journal.js';
import { runs } from './runstate.js';

const State = Annotation.Root({
  customerId: Annotation,
  report: Annotation,
  customer: Annotation,
  charges: Annotation,
  incidents: Annotation,
  messages: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  toolCalls: Annotation({ reducer: (a, b) => a + b, default: () => 0 }),
  llmFailed: Annotation,
  finding: Annotation,
  caseNumber: Annotation,
  caseUrl: Annotation,
  slackRef: Annotation,
  plan: Annotation,
  decision: Annotation,
  refundResult: Annotation,
  verifiedAmount: Annotation,
});

/** The console mirror and the Lemma trace for the segment in flight. */
function ctx(config) {
  const run = runs.get(config.configurable.thread_id);
  if (!run) throw new Error(`no run for thread ${config.configurable.thread_id}`);
  return { run, trace: run.trace };
}

async function tool(trace, name, input, fn) {
  const span = trace.startTool({ name, input });
  try {
    const output = await fn();
    span.end({ output });
    return output;
  } catch (error) {
    span.end({ error });
    throw error;
  }
}

const usd = (cents) => '$' + (cents / 100).toFixed(2);

// ---------------------------------------------------------------- investigate

const mergeById = (a, b, key) => {
  const m = new Map((a || []).map((x) => [x[key], x]));
  for (const x of b || []) m.set(x[key], x);
  return [...m.values()];
};

async function load_customer(state, config) {
  const { run, trace } = ctx(config);
  const customer = await tool(trace, 'stripe.get_customer', { id: state.customerId }, () => stripe.getCustomer(state.customerId));
  run.customer = customer;
  run.searches = [];
  run.charges = [];
  run.incidentsSeen = [];
  return { customer, charges: [], incidents: [], messages: initialMessages({ report: state.report, customer }) };
}

/** One model turn. The first turn must search; once the cap is hit it must answer. */
async function agent(state, config) {
  const { run, trace } = ctx(config);
  const turn = (run.turns = (run.turns || 0) + 1);
  run.step('assemble', 'assess', 'active', turn === 1 ? 'deciding what to look up…' : `turn ${turn} · ${state.toolCalls} searches so far`);
  // Every turn must be a tool call: a search, or submit_finding. Once the
  // search budget is spent the model is told to finish.
  const budgetSpent = state.toolCalls >= MAX_TOOL_CALLS;
  const nudge = budgetSpent ? [{ role: 'user', content: 'Search budget used. Call submit_finding now with the evidence you have.' }] : [];
  const messages = [...state.messages, ...nudge];
  try {
    let out;
    try {
      out = await chatWithTools({ messages, tools: TOOLS, toolChoice: 'required' });
    } catch (e) {
      const recovered = /tool_use_failed/.test(e.message) ? recoverToolCall(e) : null;
      if (!recovered) throw e;
      console.warn(`  [agent] recovered malformed tool call: ${recovered.tool_calls.map((t) => t.function.name).join(', ')}`);
      trace.recordSpan({ name: 'recovered-tool-call', input: { provider_error: e.body?.error?.code }, output: recovered.tool_calls });
      out = { message: recovered, model: process.env.OPENAI_MODEL, durationMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };
    }
    trace.recordGeneration({
      name: `agent-turn-${turn}`,
      model: out.model,
      input: { budget_spent: budgetSpent, messages: messages.length },
      output: out.message.tool_calls
        ? { tool_calls: out.message.tool_calls.map((t) => ({ name: t.function.name, arguments: t.function.arguments })) }
        : out.message.content,
      usage: out.usage,
      durationMs: out.durationMs,
    });
    const l = run.llm || { model: out.model, ms: 0, inTok: 0, outTok: 0, rules: false, turns: 0 };
    run.llm = { ...l, model: out.model, ms: l.ms + out.durationMs, inTok: l.inTok + out.usage.inputTokens, outTok: l.outTok + out.usage.outputTokens, turns: turn };
    return { messages: [...nudge, out.message] };
  } catch (e) {
    console.warn(`  [agent] model unavailable (${e.message.slice(0, 80)}) — falling back to rules`);
    return { llmFailed: e.message };
  }
}

const routeAgent = (state) => {
  if (state.llmFailed) return 'decide';
  const last = state.messages[state.messages.length - 1];
  const calls = last?.tool_calls || [];
  if (!calls.length || calls.some((t) => t.function?.name === FINISH)) return 'decide';
  return state.toolCalls < MAX_TOOL_CALLS ? 'tools' : 'decide';
};

/** Execute the model's tool calls with the customer locked in and caps applied. */
async function tools(state, config) {
  const { run, trace } = ctx(config);
  const last = state.messages[state.messages.length - 1];
  const calls = (last.tool_calls || []).filter((t) => t.function?.name !== FINISH).slice(0, Math.max(0, MAX_TOOL_CALLS - state.toolCalls));
  const replies = [];
  let charges = state.charges || [];
  let incidents = state.incidents || [];

  for (const call of calls) {
    const key = call.function?.name === 'search_incidents' ? 'read_incidents' : 'read_charges';
    const label = key === 'read_incidents' ? 'search incidents' : 'search charges';
    run.step(key, label, 'active', `${call.function?.name}(${(call.function?.arguments || '').slice(0, 80)})`);
    try {
      const r = await tool(trace, call.function?.name || 'unknown_tool', JSON.parse(call.function?.arguments || '{}'), () => runTool(call, state.customerId));
      charges = mergeById(charges, r.charges, 'id');
      incidents = mergeById(incidents, r.incidents, 'number');
      run.searches.push({ tool: r.name, args: r.args, summary: r.summary, at: Date.now() });
      replies.push({ role: 'tool', tool_call_id: call.id, content: r.content });
      run.step(key, label, 'done', key === 'read_charges'
        ? `${run.searches.filter((x) => x.tool === 'search_charges').length} searches · ${charges.length} charges seen`
        : `${run.searches.filter((x) => x.tool === 'search_incidents').length} searches · ${incidents.length} incidents seen`);
    } catch (e) {
      replies.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: e.message }) });
      run.searches.push({ tool: call.function?.name, args: call.function?.arguments, summary: `error: ${e.message}`, at: Date.now() });
      run.step(key, label, 'done', `search failed: ${e.message.slice(0, 60)}`);
    }
  }
  // Any calls beyond the cap get an explicit answer so the transcript stays valid.
  for (const call of (last.tool_calls || []).filter((t) => t.function?.name !== FINISH).slice(calls.length)) {
    replies.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'search limit reached; answer with the evidence you have' }) });
  }
  run.charges = charges;
  run.incidentsSeen = incidents.map((i) => ({ number: i.number, title: i.title, url: i.url }));
  run.emit('update', run.snapshot());
  return { messages: replies, toolCalls: calls.length, charges, incidents };
}

/** Parse the verdict and enforce the duplicate rule against what the tools returned. */
async function decide(state, config) {
  const { run, trace } = ctx(config);
  let finding, guard, charges = state.charges || [], incidents = state.incidents || [];

  if (state.llmFailed) {
    const r = await rulesInvestigation(state.customerId);
    charges = r.charges; incidents = r.incidents; finding = r.finding;
    guard = { overridden: false, reason: null };
    run.llm = { model: 'rules-engine (LLM unavailable)', ms: 0, inTok: 0, outTok: 0, rules: true, turns: run.turns || 0 };
    run.charges = charges;
    run.incidentsSeen = incidents.map((i) => ({ number: i.number, title: i.title, url: i.url }));
  } else {
    const last = state.messages[state.messages.length - 1];
    ({ finding, guard } = decideFinding(last, charges, incidents));
  }

  run.finding = finding;
  run.guard = guard;
  trace.recordSpan({
    name: 'duplicate-rule-check',
    input: { charges_seen: charges.length, incidents_seen: incidents.length, searches: (run.searches || []).length },
    output: guard,
  });
  run.step('assemble', 'assess', finding.verdict === 'duplicate' ? 'done' : 'refused',
    finding.verdict === 'duplicate' ? finding.grounds : finding.missing_evidence);
  if (!run.steps.find((x) => x.key === 'read_charges')?.attempts?.length) run.step('read_charges', 'search charges', 'done', 'no search made');
  if (!run.steps.find((x) => x.key === 'read_incidents')?.attempts?.length) run.step('read_incidents', 'search incidents', 'idle');
  return { finding, charges, incidents };
}

async function write_case(state, config) {
  const { run, trace } = ctx(config);
  run.step('write_case', 'write case', 'active');
  const f = state.finding;
  const title = f.verdict === 'duplicate'
    ? `Investigation: duplicate charge — ${state.customer.name}`
    : `Investigation: no duplicate found — ${state.customer.name}`;
  const created = await tool(trace, 'github.create_case', { title }, () =>
    github.createCase({ title, body: caseBody({ report: state.report, customer: state.customer, charges: state.charges, incidents: state.incidents, finding: f }) }));
  run.caseNumber = created.number;
  run.caseUrl = created.url;
  run.step('write_case', 'write case', 'done', `#${created.number}`);
  return { caseNumber: created.number, caseUrl: created.url };
}

const routeCase = (state) => (state.finding.verdict === 'duplicate' ? 'propose' : 'post_refusal');

async function post_refusal(state, config) {
  const { run, trace } = ctx(config);
  run.step('post_proposal', 'post to slack', 'active');
  const posted = await tool(trace, 'slack.post_refusal', { case: state.caseNumber }, () =>
    slack.postRefusal(state.caseNumber, state.customer.name, state.finding.missing_evidence, state.caseUrl));
  run.slackRef = posted;
  run.status = 'refused';
  run.step('post_proposal', 'post to slack', 'done', 'refusal posted — nothing requested');
  return { slackRef: posted };
}

async function propose(state, config) {
  const { run, trace } = ctx(config);
  run.step('post_proposal', 'post to slack', 'active');
  const f = state.finding;
  const charge = state.charges.find((c) => c.id === f.charge_to_refund);
  const plan = buildPlan({
    case_id: state.caseNumber,
    customer_id: state.customer.id,
    customer_name: state.customer.name,
    charge_id: f.charge_to_refund,
    duplicate_of: f.duplicate_of,
    amount: charge.amount,
    currency: charge.currency,
    grounds: f.grounds,
    evidence: f.evidence,
  });
  run.plan = plan;
  const reviewUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/admin?run=${run.id}`;
  const posted = await tool(trace, 'slack.post_proposal', { plan_id: plan.plan_id }, () => slack.postProposal(plan, reviewUrl));
  run.slackRef = posted;
  run.step('post_proposal', 'post to slack', 'done', `awaiting approval · plan ${plan.plan_id}`);
  return { plan, slackRef: posted };
}

// ---------------------------------------------------------------- human gate

/**
 * The graph stops here. interrupt() checkpoints the state and hands the plan
 * to a human; the run resumes only with an explicit decision. This node is
 * re-executed on resume, so it performs no side effects before interrupt().
 */
function human_review(state, config) {
  const { run } = ctx(config);
  const decision = interrupt({
    kind: 'refund_approval',
    plan_id: state.plan.plan_id,
    charge_id: state.plan.charge_id,
    amount: state.plan.amount,
    currency: state.plan.currency,
  });
  if (!decision || !['approve', 'decline'].includes(decision.decision)) {
    throw new Error('human_review resumed without an approve/decline decision');
  }
  // The decision must name the plan it was made about.
  if (decision.plan_id && decision.plan_id !== state.plan.plan_id) {
    throw new Error('plan_mismatch: decision was made about a different plan');
  }
  run.approver = decision.approver;
  return { decision };
}

const routeDecision = (state) => (state.decision.decision === 'approve' ? 'verify_charge' : 'record_decline');

// ---------------------------------------------------------------- approve branch

async function verify_charge(state, config) {
  const { run, trace } = ctx(config);
  const plan = state.plan;
  run.status = 'executing';
  run.step('verify_charge', 'verify charge', 'active');

  const approval = getApproval(plan.plan_id);
  if (!approval) throw new Error('not_approved');
  if (hashPlan(plan) !== approval.plan_id) throw new Error('plan_mismatch');
  if (isExpired(plan)) throw new Error('approval_expired');

  const charge = await tool(trace, 'stripe.get_charge', { id: plan.charge_id }, () => stripe.getCharge(plan.charge_id));
  if (charge.amount !== plan.amount) throw new Error('amount_mismatch');
  if (charge.currency !== plan.currency) throw new Error('currency_mismatch');
  run.step('verify_charge', 'verify charge', 'done', `${usd(charge.amount)} matches plan`);
  return {};
}

async function refund(state, config) {
  const { run, trace } = ctx(config);
  const plan = state.plan;
  run.step('refund', 'refund', 'active');
  const j = await withJournal(`${plan.plan_id}:refund`, { planId: plan.plan_id, step: 'refund', request: plan }, (key) =>
    tool(trace, 'stripe.refund', { charge: plan.charge_id, idempotency_key: key }, () => stripe.refundFull(plan.charge_id, key)));
  if (j.uncertain) throw new Error('uncertain_refund_state — inspect Stripe before retrying');
  run.step('refund', 'refund', 'done', j.skipped ? `already done — ${j.result.id} (no second refund)` : j.result.id);
  if (j.skipped) run.markSkipped('refund');
  return { refundResult: j.result };
}

async function verify_refund(state, config) {
  const { run, trace } = ctx(config);
  const plan = state.plan;
  run.step('verify_refund', 'verify refund', 'active');
  const after = await tool(trace, 'stripe.verify_refund', { id: plan.charge_id }, () => stripe.getCharge(plan.charge_id));
  // Assert the amount, never the `refunded` flag (it reads false on an over-refund).
  if (after.amount_refunded !== plan.amount) throw new Error('refund_not_verified');
  run.step('verify_refund', 'verify refund', 'done', `amount_refunded=${after.amount_refunded} ✓`);
  return { verifiedAmount: after.amount_refunded };
}

/** A journalled follow-up write. Failure is recorded and re-thrown so the graph stops here. */
function followUp(key, label, write) {
  return async (state, config) => {
    const { run, trace } = ctx(config);
    const plan = state.plan;
    run.pending = run.pending.filter((p) => p.step !== key);
    run.step(key, label, 'active');
    try {
      const r = await withJournal(`${plan.plan_id}:${key}`, { planId: plan.plan_id, step: key }, () =>
        tool(trace, key, { plan_id: plan.plan_id }, () => write(state, run)));
      // Intent recorded but no result: an earlier attempt is still in flight or
      // died mid-write. Never report that as done — leave it pending to retry.
      if (r.uncertain) throw new Error(`${key}: previous attempt has no recorded result yet — retry shortly`);
      run.step(key, label, 'done', r.skipped ? 'already done — skipped' : 'ok');
      if (r.skipped) run.markSkipped(key);
      return {};
    } catch (e) {
      run.pending.push({ step: key, error: e.message, retryAfter: e.retryAfter });
      run.step(key, label, 'failed', e.message);
      throw e;
    }
  };
}

const update_case = followUp('update_case', 'update case', (state) =>
  github.comment(state.plan.case_id,
    `Refund \`${state.refundResult.id}\` applied and verified.\n\n` +
    `- \`amount_refunded\` = ${state.verifiedAmount} (expected ${state.plan.amount})\n` +
    `- approved by ${state.decision.approver}\n` +
    `- plan \`${state.plan.plan_id}\``));

const update_slack = followUp('update_slack', 'update slack', (state) =>
  slack.updateApplied(state.slackRef.channel, state.slackRef.ts, state.plan, state.refundResult, state.decision.approver));

function finalize(state, config) {
  const { run, trace } = ctx(config);
  run.pending = [];
  trace.recordSpan({ name: 'evaluate-final-state', output: { status: 'complete', amount_refunded: state.verifiedAmount } });
  run.status = 'complete';
  run.emit('update', run.snapshot());
  return {};
}

// ---------------------------------------------------------------- decline branch

function record_decline(state, config) {
  const { run } = ctx(config);
  run.status = 'declined';
  run.approver = state.decision.approver;
  run.declineReason = state.decision.reason || '';
  run.emit('update', run.snapshot());
  return {};
}

const decline_case = followUp('decline_case', 'record decline', (state) =>
  github.comment(state.plan.case_id,
    `**Refund declined** by ${state.decision.approver}.\n\n` +
    `- proposed: full refund of \`${state.plan.charge_id}\` (${(state.plan.amount / 100).toFixed(2)} ${state.plan.currency.toUpperCase()})\n` +
    `- plan \`${state.plan.plan_id}\`\n` +
    `- reason: ${state.decision.reason || '_none given_'}\n\nNo money moved.`));

const decline_slack = followUp('decline_slack', 'notify decline', (state) =>
  slack.updateDeclined(state.slackRef.channel, state.slackRef.ts, state.plan, state.decision.approver, state.decision.reason));

function decline_done(_state, config) {
  const { run } = ctx(config);
  run.pending = [];
  run.emit('update', run.snapshot());
  return {};
}

// ---------------------------------------------------------------- wiring

export const checkpointer = new MemorySaver();

export const graph = new StateGraph(State)
  .addNode('load_customer', load_customer)
  .addNode('agent', agent)
  .addNode('tools', tools)
  .addNode('decide', decide)
  .addNode('write_case', write_case)
  .addNode('post_refusal', post_refusal)
  .addNode('propose', propose)
  .addNode('human_review', human_review)
  .addNode('verify_charge', verify_charge)
  .addNode('refund', refund)
  .addNode('verify_refund', verify_refund)
  .addNode('update_case', update_case)
  .addNode('update_slack', update_slack)
  .addNode('finalize', finalize)
  .addNode('record_decline', record_decline)
  .addNode('decline_case', decline_case)
  .addNode('decline_slack', decline_slack)
  .addNode('decline_done', decline_done)

  .addEdge(START, 'load_customer')
  .addEdge('load_customer', 'agent')
  .addConditionalEdges('agent', routeAgent, ['tools', 'decide'])
  .addEdge('tools', 'agent')
  .addEdge('decide', 'write_case')
  .addConditionalEdges('write_case', routeCase, ['propose', 'post_refusal'])
  .addEdge('post_refusal', END)
  .addEdge('propose', 'human_review')
  .addConditionalEdges('human_review', routeDecision, ['verify_charge', 'record_decline'])

  .addEdge('verify_charge', 'refund')
  .addEdge('refund', 'verify_refund')
  .addEdge('verify_refund', 'update_case')
  .addEdge('verify_refund', 'update_slack')
  .addEdge(['update_case', 'update_slack'], 'finalize')
  .addEdge('finalize', END)

  .addEdge('record_decline', 'decline_case')
  .addEdge('record_decline', 'decline_slack')
  .addEdge(['decline_case', 'decline_slack'], 'decline_done')
  .addEdge('decline_done', END)

  .compile({ checkpointer });
