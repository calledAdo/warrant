import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, ArrowUpRight, Check, CheckCheck, CircleHelp, Copy, FileSearch, LoaderCircle, ReceiptText, ShieldCheck } from '@/components/icons';
import { Brand } from '@/components/brand';
import { BillingReportForm } from '@/components/ui/clean-minimal-sign-in';
import { IntegrationCard } from '@/components/ui/integration-card';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { usePoll } from '@/web/hooks/use-poll';
import { money } from '@/lib/utils';
import type { CustomerReport } from '@/lib/types';

function Tracking({ reference }: { reference: string }) {
  const [finished, setFinished] = useState(false);
  const { data, error, refresh } = usePoll<CustomerReport>(`/api/complaints/${encodeURIComponent(reference)}`, finished ? 0 : 2500);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => { if (data?.outcome) setFinished(true); }, [data]);
  useEffect(() => { if (error?.status === 404) setFinished(true); }, [error]);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 2500); return () => clearTimeout(timer); } }, [copied]);
  const stages = ['Report received', 'Checking the evidence', 'Team review', data?.outcome?.kind === 'no_action' ? 'Report closed' : 'Resolved'];
  const notes = ['Your report is ready for investigation.', 'We check your charges and incident records.', 'A person reviews any proposed refund.', 'Your outcome is recorded here.'];
  return <main id="main" className="tracking-layout">
    <a className="back-link" href="/">← Back to billing support</a>
    <div className="tracking-heading"><span className="eyebrow">YOUR BILLING REPORT</span><h1>{data?.outcome ? 'A clear answer.' : 'You’re in the loop.'}</h1><p>Follow your report from the first check to the final decision.</p></div>
    <section className="tracking-card" aria-label="Report progress">
      <div className="tracking-reference"><div><span className="eyebrow">REFERENCE</span><strong>{reference}</strong></div><Button variant="outline" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(location.href); setCopied(true); setCopyError(false); } catch { setCopyError(true); } }}>{copied ? <Check /> : <Copy />}{copied ? 'Link copied' : 'Copy tracking link'}</Button></div>
      {copyError && <p role="status" className="field-hint">Copy the address in your browser to save this report.</p>}
      {error && <div className="notice notice-error" role="alert">{error.status === 404 ? 'We couldn’t find that reference. Check the code and try again.' : error.message}<Button variant="ghost" size="sm" onClick={refresh}>Try again</Button></div>}
      {!data && !error && <div className="loading-state" role="status"><LoaderCircle className="spin" />Loading your report…</div>}
      {data && <>
        <p className="tracking-for">{data.customer_name ? `For ${data.customer_name}` : 'Your report'}<span>{new Date(data.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span></p>
        <ol className="progress-rail">{stages.map((stage, i) => {
          const done = data.stage > i + 1 || (i === 3 && Boolean(data.outcome));
          const current = data.stage === i + 1 && !done;
          const skipped = i === 2 && data.stage === 4 && data.outcome?.kind === 'no_action' && data.note.includes('did not find');
          return <li key={i} className={done ? 'step-done' : current ? 'step-current' : ''} aria-current={current ? 'step' : undefined}><span className="step-marker">{done ? <Check /> : i + 1}</span><div><h2>{skipped ? 'No refund proposed' : stage}</h2><p>{current ? data.note : skipped ? 'No duplicate was found, so no approval was needed.' : notes[i]}</p></div></li>;
        })}</ol>
        <p className="sr-only" role="status">{data.stage_label}. {data.note}</p>
        {data.outcome && <div className={`outcome outcome-${data.outcome.kind}`}><div className="outcome-icon">{data.outcome.kind === 'refund' ? <CheckCheck /> : <FileSearch />}</div><div><span className="eyebrow">{data.outcome.kind === 'refund' ? 'REFUND VERIFIED' : 'REVIEW COMPLETE'}</span><h2>{data.outcome.kind === 'refund' ? `${money(data.outcome.amount, data.outcome.currency)} refunded` : 'No changes to your account'}</h2><p>{data.outcome.text}</p></div></div>}
        <div className="original-report"><h2>Your original report</h2><p>{data.body}</p></div>
      </>}
    </section>
    <p className="tracking-help"><ShieldCheck />Keep this link to return to your report anytime.</p>
  </main>;
}

export default function Customer() {
  const [reference, setReference] = useState(new URLSearchParams(location.search).get('ref'));
  const [trackOpen, setTrackOpen] = useState(false);
  const [code, setCode] = useState('');
  const [trackError, setTrackError] = useState('');
  function track(id: string) {
    history.pushState({}, '', `/?ref=${encodeURIComponent(id)}`); setReference(id); setTrackOpen(false); window.scrollTo(0, 0);
  }
  useEffect(() => {
    document.title = 'Billing support — Warrant';
    const pop = () => setReference(new URLSearchParams(location.search).get('ref'));
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  function findReport(event: FormEvent) {
    event.preventDefault();
    const value = code.trim().toUpperCase();
    if (!/^C-[A-Z0-9]{5}$/.test(value)) { setTrackError('Enter your reference in the format C-XXXXX.'); return; }
    track(value);
  }
  return <div className="customer-app">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="customer-header"><Brand /><span className="header-divider" /><span className="header-context">Billing support</span><nav aria-label="Main navigation"><Button variant="ghost" size="sm" onClick={() => setTrackOpen(true)}>Track a report</Button><a href="/admin" className="team-link">Team workspace<ArrowUpRight /></a></nav></header>
    {reference ? <Tracking key={reference} reference={reference} /> : <main id="main" className="customer-main">
      <section className="customer-story">
        <div className="story-label"><span className="label-rule" />A LITTLE CLARITY GOES A LONG WAY</div>
        <h1>Unexpected charge.<br /><span>Clear next steps.</span></h1>
        <p className="story-description">Billing shouldn’t leave you guessing. Tell us what looks wrong. We’ll check the details and help put it right.</p>
        <IntegrationCard />
      </section>
      <section className="customer-form-column" aria-label="Submit a billing report"><BillingReportForm onSubmitted={track} /><div className="already-reported"><CircleHelp /><span>Already sent a report?</span><button onClick={() => setTrackOpen(true)}>Check its progress<ArrowRight /></button></div></section>
      <section className="how-it-works" aria-label="What happens next">
        <div className="how-heading"><span className="eyebrow">WHAT HAPPENS NEXT</span><h2>From a question to an answer.</h2></div>
        {[{ icon: ReceiptText, title: 'You tell us', text: 'Share the account email and what you noticed.' }, { icon: FileSearch, title: 'We look into it', text: 'We compare your charges with the evidence.' }, { icon: ShieldCheck, title: 'A person decides', text: 'Our team reviews any refund before it’s issued.' }].map((item, i) => <div className="how-step" key={item.title}><div className="how-icon"><item.icon /><span>0{i + 1}</span></div><h3>{item.title}</h3><p>{item.text}</p></div>)}
      </section>
    </main>}
    <footer className="customer-footer"><span>© {new Date().getFullYear()} Warrant</span><span>Thoughtful decisions. Accountable actions.</span><a href="/admin">For billing teams<ArrowUpRight /></a></footer>
    <Modal open={trackOpen} onOpenChange={setTrackOpen} title="Find your report" description="Enter the reference you received after submitting your billing report."><form onSubmit={findReport}><div className="field"><label htmlFor="reference">Report reference</label><input id="reference" placeholder="C-XXXXX" value={code} onChange={e => { setCode(e.target.value); setTrackError(''); }} autoComplete="off" aria-invalid={Boolean(trackError)} aria-describedby={trackError ? 'track-error' : undefined} />{trackError && <p className="field-error" id="track-error" role="alert">{trackError}</p>}</div><Button type="submit" className="w-full">Track report<ArrowRight /></Button></form></Modal>
  </div>;
}
