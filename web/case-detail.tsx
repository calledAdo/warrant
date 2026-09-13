import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, Clock, Copy, CreditCard, FileSearch, FileText, GitBranch, LoaderCircle, MessageSquare, RefreshCw, ShieldCheck, UserRound, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Integration } from '@/components/ui/integration-card';
import { Modal } from '@/components/ui/dialog';
import { StatusBadge } from '@/components/ui/status-badge';
import { useRun } from '@/web/hooks/use-run';
import { usePoll } from '@/web/hooks/use-poll';
import { post } from '@/lib/api';
import { money, safeLink, shortId } from '@/lib/utils';
import type { Complaint, Config, Operation, Run } from '@/lib/types';

function ProviderId({ value }: { value: string }) {
  return <code title={value}>{shortId(value)}</code>;
}

function Decision({ run, onChanged, connected }: { run: Run; onChanged: () => void; connected: boolean }) {
  const [action, setAction] = useState<'approve' | 'decline' | null>(null);
  const [actor, setActor] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const submitting = useRef(false);
  const [reviewedPlan, setReviewedPlan] = useState<string | null>(null);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setBusy(false); submitting.current = false; setAction(null); setError(''); }, [run.status]);
  const seconds = run.plan ? Math.max(0, Math.floor((new Date(run.plan.expires_at).getTime() - now) / 1000)) : 0;
  const expired = seconds <= 0;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !action || !run.plan) return;
    if (!connected) { setError('Wait for the investigation to reconnect before making a decision.'); return; }
    if (action === 'approve' && expired) { setError('This approval window has expired. The refund cannot be approved.'); return; }
    if (reviewedPlan !== run.plan.plan_id) { setError('The proposed refund has changed. Close this dialog and review the new plan.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor.trim())) { setError('Enter your work email to record who made this decision.'); return; }
    if (action === 'decline' && !reason.trim()) { setError('Add a reason for declining. It will be recorded in the case.'); return; }
    setBusy(true); submitting.current = true; setError('');
    try {
      await post(`/api/${action}/${encodeURIComponent(run.id)}`, { approver: actor.trim(), plan_id: reviewedPlan, ...(action === 'decline' ? { reason: reason.trim() } : {}) });
      setAction(null); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'The decision could not be saved.'); setBusy(false); submitting.current = false; }
  }
  if (run.status === 'awaiting_approval' && run.plan) return <>
    <section className="decision-card" aria-label="Proposed refund">
      <div className="decision-heading"><span className="decision-symbol"><ShieldCheck /></span><div><span className="eyebrow">YOUR DECISION</span><h2>{expired ? 'Approval window expired' : 'A duplicate. A proposed refund.'}</h2></div><span className="badge badge-amber"><Clock />{expired ? 'Expired' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining`}</span></div>
      <div className="decision-main"><div><div className="refund-amount">{money(run.plan.amount, run.plan.currency)}<span>Full refund</span></div><p>The later charge is proposed for a refund.<br />The original charge stays in place.</p></div><div className="decision-actions"><Button variant="outline" disabled={busy || !connected} onClick={() => { setReviewedPlan(run.plan!.plan_id); setAction('decline'); setError(''); }}><X />Decline</Button><Button disabled={expired || busy || !connected} onClick={() => { setReviewedPlan(run.plan!.plan_id); setAction('approve'); setError(''); }}>{busy ? <LoaderCircle className="spin" /> : <Check />}Approve refund</Button></div></div>
      <div className="decision-foot"><ShieldCheck /><span>{expired ? 'No refund has been issued. Decline this plan and request a new investigation if needed.' : 'Approval applies to this exact charge and amount. Every action is recorded.'}</span></div>
    </section>
    <Modal open={Boolean(action)} onOpenChange={open => { if (!open) setAction(null); }} title={action === 'approve' ? 'Approve this refund?' : 'Decline this refund?'} description={action === 'approve' ? 'Confirm the exact refund below. Your decision will be recorded on the case.' : 'The customer will be told no refund was issued. Add a clear reason for the case record.'} busy={busy}>
      <form onSubmit={submit} noValidate>
        <div className="confirmation-amount"><span>Full refund</span><strong>{money(run.plan.amount, run.plan.currency)}</strong><code>{run.plan.charge_id}</code></div>
        <div className="field"><label htmlFor="approver">Your work email</label><input id="approver" type="email" autoComplete="email" value={actor} onChange={e => setActor(e.target.value)} placeholder="you@company.com" required /></div>
        {action === 'decline' && <div className="field"><label htmlFor="decline-reason">Reason for declining</label><textarea id="decline-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} rows={3} placeholder="Explain why this refund should not go ahead…" required /></div>}
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <div className="dialog-actions"><Button variant="outline" disabled={busy} onClick={() => setAction(null)}>Cancel</Button><Button type="submit" variant={action === 'decline' ? 'destructive' : 'default'} disabled={busy || !connected || (action === 'approve' && expired)}>{busy && <LoaderCircle className="spin" />}{action === 'approve' ? `Confirm ${money(run.plan.amount, run.plan.currency)} refund` : 'Confirm decline'}</Button></div>
      </form>
    </Modal>
  </>;
  if (run.status === 'partial') return <section className="result-banner result-amber"><RefreshCw /><div><h2>Refund issued. Follow-up pending.</h2><p>The refund is preserved. {run.pending.map(p => p.step.replaceAll('_', ' ')).join(', ')} still needs to finish.</p>{run.pending.map(p => <p key={p.step} className="field-hint">{p.error}</p>)}{error && <p role="alert" className="field-error">{error}</p>}</div><Button variant="outline" disabled={busy || !connected} onClick={async () => { if (submitting.current) return; submitting.current = true; setBusy(true); setError(''); try { await post(`/api/resume/${encodeURIComponent(run.id)}`); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'Retry failed.'); } finally { submitting.current = false; setBusy(false); } }}>{busy ? <LoaderCircle className="spin" /> : <RefreshCw />}Retry follow-up</Button></section>;
  if (run.status === 'error') return <section className="result-banner result-red"><FileSearch /><div><h2>Investigation needs attention</h2><p>{run.error || 'The investigation could not finish. Review the operation journal before taking further action.'}</p></div></section>;
  if (run.status === 'complete') return <section className="result-banner result-green"><ShieldCheck /><div><h2>{money(run.plan?.amount, run.plan?.currency)} refunded and verified</h2><p>Confirmed against Stripe. Approved by {run.approver || 'the billing team'}.</p></div><span className="badge badge-green">Resolved</span></section>;
  if (run.status === 'declined' || run.status === 'refused') return <section className="result-banner"><FileSearch /><div><h2>{run.status === 'declined' ? 'Refund declined' : 'No duplicate found'}</h2><p>{run.status === 'declined' ? `Declined by ${run.approver || 'the billing team'}. ${run.declineReason || ''}` : 'The evidence does not support a refund. No approval was requested and no money moved.'}</p>{Boolean(run.pending.length) && <p className="field-error">Case updates pending: {run.pending.map(p => p.step.replaceAll('_', ' ')).join(', ')}.</p>}</div><span className="badge badge-neutral">No money moved</span></section>;
  return <div className="investigating-note" role="status"><LoaderCircle className="spin" /><span>{['approved', 'executing'].includes(run.status) ? 'The approved correction is being applied and verified.' : 'Warrant is gathering the evidence. You’ll see the findings here.'}</span></div>;
}

function EvidencePanel({ run }: { run: Run }) {
  const evidence = run.finding?.evidence || [];
  return <Card><CardHeader><CardTitle><FileSearch />Evidence</CardTitle><span className="small-count">{evidence.length} sources</span></CardHeader><CardContent className="evidence-content">
    {!run.finding ? <p className="panel-empty">Reading charges and incident records…</p> : !evidence.length ? <p className="panel-empty">No supporting evidence was recorded.</p> : evidence.map((item, i) => {
      const refund = item.id === run.finding?.charge_to_refund;
      const keep = item.id === run.finding?.duplicate_of;
      return <div key={`${item.id}-${i}`} className="evidence-row"><span className={`provider-icon provider-${item.source}`}>{item.source === 'stripe' ? <CreditCard /> : <GitBranch />}</span><div><div className="evidence-source"><span>{item.source === 'stripe' ? 'Stripe charge' : item.source === 'github' ? 'GitHub incident' : item.source}</span>{(refund || keep) && <span className={`evidence-role ${refund ? 'role-refund' : ''}`}>{refund ? 'To refund' : 'Keep'}</span>}</div><ProviderId value={item.id} /><p>{item.detail}</p></div></div>;
    })}
    {(run.incidents || []).filter(incident => !evidence.some(e => e.source === 'github' && (e.id === String(incident.number) || e.id === `#${incident.number}`))).slice(0, 3).map(incident => <div className="evidence-row" key={incident.number}><span className="provider-icon"><GitBranch /></span><div><div className="evidence-source">Incident #{incident.number}</div><p>{incident.title}</p></div></div>)}
  </CardContent></Card>;
}

function Reasoning({ run }: { run: Run }) {
  const finding = run.finding;
  return <Card><CardHeader><CardTitle><ShieldCheck />Assessment</CardTitle>{finding && <span className={`badge badge-${finding.verdict === 'duplicate' ? 'blue' : 'neutral'}`}>{finding.verdict === 'duplicate' ? 'Duplicate found' : 'No duplicate'}</span>}</CardHeader><CardContent>
    {!finding ? <p className="panel-empty">The assessment appears once the evidence has been checked.</p> : <>
      {run.guard?.overridden && <div className="notice notice-warning"><strong>Code check overrode the model</strong><p>{run.guard.reason}</p></div>}
      <p className="reasoning-text">{finding.grounds}</p>
      {finding.missing_evidence && <div className="reasoning-note"><h3>Missing evidence</h3><p>{finding.missing_evidence}</p></div>}
      {finding.uncertainty && finding.uncertainty !== 'none' && <div className="reasoning-note"><h3>Uncertainty</h3><p>{finding.uncertainty}</p></div>}
      {run.llm && <div className="reasoning-meta"><span>{run.llm.rules ? 'Rules fallback' : run.llm.model}</span><span>{(run.llm.ms / 1000).toFixed(1)}s</span><span>{run.llm.inTok + run.llm.outTok} tokens</span></div>}
    </>}
  </CardContent></Card>;
}

function Journal({ run }: { run: Run }) {
  const { data, error } = usePoll<{ operations: Operation[] }>(run.plan ? `/api/journal/${encodeURIComponent(run.id)}` : null, run.status === 'complete' ? 0 : 5000);
  const names: Record<string, string> = { refund: 'Full refund', update_case: 'GitHub case updated', update_slack: 'Slack team notified', decline_case: 'Decline recorded in GitHub', decline_slack: 'Slack decline update' };
  return <Card><CardHeader><CardTitle><FileText />Operation journal</CardTitle><span className="eyebrow">AUDIT TRAIL</span></CardHeader><CardContent>
    {error ? <p className="field-error" role="alert">The journal could not be loaded. It may contain completed actions.</p> : data?.operations.length ? <div className="journal-rows">{data.operations.map(op => <div className="journal-row" key={op.op_key}><span className={`journal-dot ${op.status === 'succeeded' ? 'journal-done' : ''}`}>{op.status === 'succeeded' ? <Check /> : <Clock />}</span><div><strong>{names[op.step] || op.step.replaceAll('_', ' ')}</strong>{op.error && <p>{op.error}</p>}</div><span className={`badge badge-${op.status === 'succeeded' ? 'green' : op.status === 'failed' ? 'red' : 'amber'}`}>{op.status}</span></div>)}</div> : <div className="journal-empty"><ShieldCheck /><div><strong>{run.status === 'declined' || run.status === 'refused' ? 'No refund operations' : 'No refund actions yet'}</strong><p>External refund actions appear here when execution begins. Investigation activity is recorded in the case and traces.</p></div></div>}
  </CardContent></Card>;
}

function References({ run, config }: { run: Run; config: Config | null }) {
  const { data, error } = usePoll<{ investigate: string | null; execute: string | null }>(config?.tracing ? `/api/tracelinks/${encodeURIComponent(run.id)}` : null, 15000);
  const github = safeLink(run.caseUrl) || (config?.repo && run.caseNumber ? safeLink(`https://github.com/${config.repo}/issues/${run.caseNumber}`) : undefined);
  const links = [{ title: 'GitHub case file', detail: run.caseNumber ? `#${run.caseNumber}` : '', href: github, icon: GitBranch }, { title: 'Investigation trace', detail: 'Lemma', href: safeLink(data?.investigate), icon: FileSearch }, { title: 'Execution trace', detail: 'Lemma', href: safeLink(data?.execute), icon: ShieldCheck }];
  return <Card><CardHeader><CardTitle><ArrowUpRight />References</CardTitle></CardHeader><CardContent className="references-content">
    {links.filter(link => link.href).map(link => <a key={link.title} className="reference-link" href={link.href} target="_blank" rel="noreferrer"><link.icon /><span>{link.title}<small>{link.detail}</small></span><ArrowUpRight /></a>)}
    {!github && <p className="panel-empty">The GitHub case link appears once the case is written.</p>}
    {config?.tracing && !data?.investigate && <p className="trace-note">{error ? 'Trace links are temporarily unavailable.' : 'Investigation trace is being indexed.'}</p>}
    <div className="checkpoint-note"><GitBranch /><span>{run.engine?.checkpoints || 0} checkpoints<span className="checkpoint-thread" title={run.id}>{shortId(run.id)}</span></span></div>
  </CardContent></Card>;
}

export function CaseDetail({ complaint, config, onChanged }: { complaint: Complaint; config: Config | null; onChanged: () => void }) {
  const { run, connection, error } = useRun(complaint.run_id);
  const [tab, setTab] = useState('overview');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 2500); return () => clearTimeout(timer); } }, [copied]);
  const initials = (complaint.customer_name || complaint.email).split(/[ @]+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  return <article className="case-detail" aria-label={`Case ${complaint.id}`}>
    <div className="case-toolbar"><span className="case-breadcrumb">Reports <span>/</span> <strong>{complaint.id}</strong></span><Button variant="ghost" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(`${location.origin}/admin?run=${encodeURIComponent(complaint.run_id || '')}&case=${encodeURIComponent(complaint.id)}`); setCopied(true); setCopyError(false); } catch { setCopyError(true); } }} aria-label="Copy case link">{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy link'}</Button></div>
    {copyError && <p role="status" className="field-hint case-copy-error">Copy the address in your browser to share this case.</p>}
    <div className="case-heading"><div className="customer-avatar">{initials}</div><div className="case-customer"><h1>{complaint.customer_name || complaint.email}</h1><p>{complaint.email}</p></div><StatusBadge status={run?.status || complaint.status} /></div>
    <div className="complaint-message"><MessageSquare /><div><p>{complaint.body}</p><span>Reported {new Date(complaint.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div></div>
    <div className="detail-tabs"><div className="tab-buttons" role="tablist" aria-label="Case sections">{['overview', 'activity'].map(value => <button id={`tab-${value}`} key={value} role="tab" aria-selected={tab === value} aria-controls={`panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'activity' : value === 'overview' ? 'activity' : 'overview'; setTab(next); document.getElementById(`tab-${next}`)?.focus(); } }}>{value === 'overview' ? 'Overview' : 'Activity & audit'}</button>)}</div><span className={`connection-state connection-${connection}`} role="status"><span className="status-dot" />{connection === 'live' ? 'Live updates' : connection === 'connecting' ? 'Connecting' : connection === 'unavailable' ? 'Unavailable' : 'Reconnecting'}</span></div>
    {error && <div className="notice notice-warning" role="alert">{error}</div>}
    {!complaint.run_id && <div className="notice">The report has been received. An investigation has not been attached yet.</div>}
    {!run && complaint.run_id && !error && <div className="case-loading" role="status"><LoaderCircle className="spin" /><p>Opening the investigation…</p><div className="skeleton" /><div className="skeleton" /></div>}
    {run && <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="case-panels">
      {tab === 'overview' ? <>
        <Decision run={run} connected={connection === 'live'} onChanged={onChanged} />
        <Card className="investigation-card"><CardHeader><CardTitle><GitBranch />Investigation map</CardTitle><span className="eyebrow">EVIDENCE → DECISION</span></CardHeader><Integration run={run} /><div className="investigation-summary"><span><ShieldCheck />{run.guard?.overridden ? 'Code check overrode finding' : run.finding ? 'Evidence checked against policy' : 'Evidence checks in progress'}</span><span>{run.steps.filter(s => s.state === 'done' || s.state === 'refused').length} steps complete</span></div></Card>
        <div className="panel-grid"><EvidencePanel run={run} /><Reasoning run={run} /></div>
      </> : <>
        <Card><CardHeader><CardTitle><Clock />Investigation activity</CardTitle></CardHeader><CardContent><ol className="activity-list">{run.steps.map(step => <li key={step.key}><span className={`activity-icon activity-${step.state}`}>{step.state === 'done' ? <Check /> : step.state === 'active' ? <LoaderCircle className="spin" /> : step.state === 'failed' ? <X /> : <Clock />}</span><div><h3>{step.label}</h3>{step.detail && <p>{step.detail}</p>}</div><span>{step.durationMs != null ? `${(step.durationMs / 1000).toFixed(1)}s` : step.state}</span></li>)}</ol></CardContent></Card>
        <Journal run={run} />
        <div className="panel-grid"><References run={run} config={config} /><Card><CardHeader><CardTitle><UserRound />Case details</CardTitle></CardHeader><CardContent><dl className="case-properties"><dt>Customer</dt><dd><ProviderId value={complaint.customer_id} /></dd><dt>Run</dt><dd><ProviderId value={run.id} /></dd><dt>Plan</dt><dd>{run.plan ? <ProviderId value={run.plan.plan_id} /> : 'No refund proposed'}</dd><dt>Decision by</dt><dd>{run.approver || 'Awaiting decision'}</dd><dt>Action</dt><dd>{run.plan ? 'One full refund' : 'None'}</dd></dl></CardContent></Card></div>
      </>}
    </div>}
  </article>;
}
