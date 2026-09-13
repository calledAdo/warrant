import { useEffect, useId, useRef, useState, type ComponentType } from 'react';
import { motion, useInView, useReducedMotion } from 'motion/react';
import { CreditCard, FileText, GitBranch, MessageSquare, ShieldCheck, UserRound, Check, LoaderCircle } from '@/components/icons';
import { BrandMark } from '@/components/brand';
import { cn } from '@/lib/utils';
import type { Run } from '@/lib/types';

type Connection = 'stripe' | 'github' | 'case' | 'slack' | 'review';
// Direction cues sit on exposed connector segments, clear of the opaque tiles.
const flowArrows: Record<Connection, { x: number; y: number; inward: number }> = {
  stripe: { x: 204, y: 80, inward: 0 }, github: { x: 366, y: 80, inward: 180 },
  case: { x: 174, y: 225, inward: -90 }, slack: { x: 390, y: 225, inward: -90 },
  review: { x: 282, y: 260, inward: -90 },
};
interface FlowPhase {
  title: string; detail: string; hub: string;
  flows: { node: Connection; direction: 'in' | 'out' }[];
  waiting?: boolean; duration?: number;
}
// One supported refund example, following src/graph.js. Evidence searches can
// repeat in any order; approval and verification must precede their side effects.
const refundFlow: FlowPhase[] = [
  { title: 'Read the billing evidence', detail: 'Warrant searches this customer’s Stripe charges, paging back when needed.', hub: 'Investigating', flows: [{ node: 'stripe', direction: 'in' }] },
  { title: 'Look for a matching incident', detail: 'GitHub incident searches add context. The agent can search again as needed.', hub: 'Investigating', flows: [{ node: 'github', direction: 'in' }] },
  { title: 'Check the finding against policy', detail: 'Code checks the proposed duplicate against the evidence the agent found.', hub: 'Checking', flows: [] },
  { title: 'Write a cited case', detail: 'Warrant records the finding and its supporting evidence in a GitHub case.', hub: 'Documenting', flows: [{ node: 'case', direction: 'out' }] },
  { title: 'Send the proposal to the team', detail: 'Slack receives the proposed refund and a link to the billing workspace.', hub: 'Notifying', flows: [{ node: 'slack', direction: 'out' }] },
  { title: 'Wait for a person’s decision', detail: 'The workflow stops here. No refund can proceed without approval.', hub: 'Awaiting review', flows: [], waiting: true, duration: 4800 },
  { title: 'If the reviewer approves', detail: 'A person approves the exact charge and amount in the billing workspace.', hub: 'Approved', flows: [{ node: 'review', direction: 'in' }] },
  { title: 'Recheck before moving money', detail: 'Warrant checks approval expiry and reads the Stripe charge again.', hub: 'Rechecking', flows: [{ node: 'stripe', direction: 'in' }] },
  { title: 'Issue one full refund', detail: 'Only after those checks pass does Warrant request the approved Stripe refund.', hub: 'Refunding', flows: [{ node: 'stripe', direction: 'out' }] },
  { title: 'Verify the refunded amount', detail: 'Warrant reads Stripe back to confirm the exact amount was refunded.', hub: 'Verifying', flows: [{ node: 'stripe', direction: 'in' }] },
  { title: 'Close the loop', detail: 'The GitHub case and original Slack message are updated with the verified outcome.', hub: 'Recording', flows: [{ node: 'case', direction: 'out' }, { node: 'slack', direction: 'out' }], duration: 4200 },
];

interface Illustration { phase: FlowPhase; moving: boolean }

// Adapted from Documents/prompts/integration-graph-prompt.md (21st.dev).
// The hub represents evidence and handoffs; step status comes only from the run.
interface IntegrationItem { id: string; label: string; sub: string; icon: ComponentType<{ className?: string }>; x: number; y: number; path: string; steps: string[] }
const integrations: IntegrationItem[] = [
  { id: 'stripe', label: 'Stripe', sub: 'Billing history', icon: CreditCard, x: 108, y: 80, path: 'M 264 174 V 95 Q 264 80 249 80 H 142', steps: ['read_charges'] },
  { id: 'github', label: 'GitHub', sub: 'Incident records', icon: GitBranch, x: 456, y: 80, path: 'M 300 174 V 95 Q 300 80 315 80 H 422', steps: ['read_incidents'] },
  { id: 'case', label: 'Case file', sub: 'Cited evidence', icon: FileText, x: 108, y: 262, path: 'M 250 192 H 188 Q 174 192 174 207 V 247 Q 174 262 159 262 H 142', steps: ['write_case'] },
  { id: 'slack', label: 'Slack', sub: 'Team updates', icon: MessageSquare, x: 456, y: 262, path: 'M 314 192 H 376 Q 390 192 390 207 V 247 Q 390 262 405 262 H 422', steps: ['post_proposal', 'update_slack', 'decline_slack'] },
  { id: 'review', label: 'Human review', sub: 'You have the final say', icon: UserRound, x: 282, y: 316, path: 'M 282 218 V 292', steps: [] },
];

function stateFor(item: IntegrationItem, run?: Run | null) {
  if (!run) return 'idle';
  if (item.id === 'review') {
    if (run.status === 'awaiting_approval') return 'waiting';
    if (['approved', 'executing', 'complete', 'partial', 'declined'].includes(run.status)) return 'done';
    return 'idle';
  }
  const steps = run.steps.filter(step => item.steps.includes(step.key));
  if (steps.some(s => s.state === 'failed')) return 'failed';
  if (steps.some(s => s.state === 'active')) return 'active';
  if (steps.some(s => ['done', 'refused'].includes(s.state))) return 'done';
  return 'idle';
}

export function Integration({ run, className, illustration }: { run?: Run | null; className?: string; illustration?: Illustration }) {
  const uid = useId().replace(/:/g, '');
  const reduced = useReducedMotion();
  const working = run?.status === 'running' || run?.status === 'executing';
  // A real run always wins. The landing illustration never fabricates Run data.
  const example = run ? undefined : illustration;
  return <div className={cn('integration-visual', className)}>
    <div className="integration-dots" />
    <svg className="integration-lines" viewBox="0 0 564 390" fill="none" aria-hidden="true">
      {integrations.map((item, index) => {
        const active = stateFor(item, run) === 'active';
        const flow = example?.phase.flows.find(flow => flow.node === item.id);
        const arrow = flow ? flowArrows[flow.node] : null;
        const id = `${uid}-${item.id}`;
        return <g key={item.id}>
          <path d={item.path} stroke="var(--line-strong)" strokeWidth="1.2" />
          {flow && <>
            <path d={item.path} stroke="#5283b9" strokeWidth="1.7" opacity="0.45" />
            {example?.moving && !reduced && <motion.path
              key={`${example.phase.title}-${item.id}`} className="flow-pulse" data-direction={flow.direction}
              d={item.path} stroke="#376fa9" strokeWidth="3" strokeLinecap="round"
              initial={{ pathLength: 0.14, pathSpacing: 1, pathOffset: flow.direction === 'in' ? 1 : -0.14 }}
              animate={{ pathOffset: flow.direction === 'in' ? -0.14 : 1 }}
              transition={{ duration: 1.6, repeat: Infinity, repeatDelay: 0.35, ease: 'linear' }}
            />}
            {arrow && <path d="M -4 -4 L 1 0 L -4 4" stroke="#376fa9" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" transform={`translate(${arrow.x} ${arrow.y}) rotate(${arrow.inward + (flow.direction === 'out' ? 180 : 0)})`} />}
          </>}
          {active && !reduced && <motion.path d={item.path} stroke={`url(#${id})`} strokeWidth="2" strokeDasharray="40 160" initial={{ strokeDashoffset: 200 }} animate={{ strokeDashoffset: -200 }} transition={{ duration: 4, repeat: Infinity, ease: 'linear', delay: index * 0.2 }} />}
          <defs><linearGradient id={id}><stop offset="0%" stopColor="#6299dd" stopOpacity="0" /><stop offset="50%" stopColor="#6299dd" /><stop offset="100%" stopColor="#6299dd" stopOpacity="0" /></linearGradient></defs>
        </g>;
      })}
    </svg>
    <div className="integration-center">
      <div className={cn('hub-shell', working && 'hub-working', example && 'hub-illustrated', example?.phase.waiting && 'hub-waiting')}><div className="hub-inner"><BrandMark /></div></div>
      <span className="hub-label">{example?.phase.hub || (working ? 'Investigating' : 'warrant.')}</span>
    </div>
    <ul className="integration-nodes" aria-label={run ? 'Live investigation evidence map' : 'How Warrant connects your billing evidence'}>
      {integrations.map(item => {
        const state = example ? example.phase.waiting && item.id === 'review' ? 'waiting' : example.phase.flows.some(flow => flow.node === item.id) ? 'active' : 'idle' : stateFor(item, run);
        const Icon = item.icon;
        return <li key={item.id} className={cn('integration-node', `integration-${state}`)} style={{ left: `${item.x / 564 * 100}%`, top: `${item.y / 390 * 100}%` }}>
          <div className="integration-icon"><Icon />{state === 'done' && <span className="node-check"><Check /></span>}{state === 'active' && !example && <LoaderCircle className="node-spinner spin" />}</div>
          <span className="node-label">{item.label}</span><span className="node-sub">{state === 'waiting' ? 'Awaiting your decision' : state === 'failed' ? 'Needs attention' : item.sub}</span>
          {run && <span className="sr-only">{state}</span>}
        </li>;
      })}
    </ul>
  </div>;
}

export function IntegrationCard() {
  const container = useRef<HTMLElement>(null);
  const inView = useInView(container, { amount: 0.3 });
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const phase = refundFlow[index];
  const moving = inView && visible && !paused && !reduced;
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(() => setIndex(current => (current + 1) % refundFlow.length), phase.duration || 3200);
    return () => clearTimeout(timer);
  }, [index, moving, phase.duration]);
  return <section ref={container} className="intro-integration" aria-label="Illustrated refund workflow">
    <div className="flow-toolbar"><span>HOW IT FLOWS <span>· Illustrated example</span></span><div>
      {!reduced && <button type="button" onClick={() => setPaused(!paused)} aria-label={paused ? 'Play workflow animation' : 'Pause workflow animation'}>{paused ? 'Play' : 'Pause'}</button>}
      <button type="button" aria-label="Next workflow step" onClick={() => { setPaused(true); setIndex(current => (current + 1) % refundFlow.length); }}>Next <span aria-hidden="true">→</span></button>
    </div></div>
    <Integration illustration={{ phase, moving }} />
    <div className="flow-description" aria-live={paused || reduced ? 'polite' : 'off'} aria-atomic="true"><span className="flow-number">{String(index + 1).padStart(2, '0')} / {refundFlow.length}</span><div><h2>{phase.title}</h2><p>{phase.detail}</p></div></div>
    <div className="integration-caption"><ShieldCheck /><span>If evidence is insufficient or approval is declined, no money moves.</span></div>
  </section>;
}
