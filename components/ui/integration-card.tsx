import { useId, type ComponentType } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { CreditCard, FileText, GitBranch, MessageSquare, ShieldCheck, UserRound, Check, LoaderCircle } from '@/components/icons';
import { BrandMark } from '@/components/brand';
import { cn } from '@/lib/utils';
import type { Run } from '@/lib/types';

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

export function Integration({ run, className }: { run?: Run | null; className?: string }) {
  const uid = useId().replace(/:/g, '');
  const reduced = useReducedMotion();
  const working = run?.status === 'running' || run?.status === 'executing';
  return <div className={cn('integration-visual', className)}>
    <div className="integration-dots" />
    <svg className="integration-lines" viewBox="0 0 564 390" fill="none" aria-hidden="true">
      {integrations.map((item, index) => {
        const active = stateFor(item, run) === 'active';
        const id = `${uid}-${item.id}`;
        return <g key={item.id}>
          <path d={item.path} stroke="var(--line-strong)" strokeWidth="1.2" />
          {active && !reduced && <motion.path d={item.path} stroke={`url(#${id})`} strokeWidth="2" strokeDasharray="40 160" initial={{ strokeDashoffset: 200 }} animate={{ strokeDashoffset: -200 }} transition={{ duration: 4, repeat: Infinity, ease: 'linear', delay: index * 0.2 }} />}
          <defs><linearGradient id={id}><stop offset="0%" stopColor="#6299dd" stopOpacity="0" /><stop offset="50%" stopColor="#6299dd" /><stop offset="100%" stopColor="#6299dd" stopOpacity="0" /></linearGradient></defs>
        </g>;
      })}
    </svg>
    <div className="integration-center">
      <div className={cn('hub-shell', working && 'hub-working')}><div className="hub-inner"><BrandMark /></div></div>
      <span className="hub-label">{working ? 'Investigating' : 'warrant.'}</span>
    </div>
    <ul className="integration-nodes" aria-label={run ? 'Live investigation evidence map' : 'How Warrant connects your billing evidence'}>
      {integrations.map(item => {
        const state = stateFor(item, run);
        const Icon = item.icon;
        return <li key={item.id} className={cn('integration-node', `integration-${state}`)} style={{ left: `${item.x / 564 * 100}%`, top: `${item.y / 390 * 100}%` }}>
          <div className="integration-icon"><Icon />{state === 'done' && <span className="node-check"><Check /></span>}{state === 'active' && <LoaderCircle className="node-spinner spin" />}</div>
          <span className="node-label">{item.label}</span><span className="node-sub">{state === 'waiting' ? 'Awaiting your decision' : state === 'failed' ? 'Needs attention' : item.sub}</span>
          {run && <span className="sr-only">{state}</span>}
        </li>;
      })}
    </ul>
  </div>;
}

export function IntegrationCard() {
  return <div className="intro-integration"><Integration /><div className="integration-caption"><ShieldCheck /><span>Evidence first. Human approval. Every time.</span></div></div>;
}
