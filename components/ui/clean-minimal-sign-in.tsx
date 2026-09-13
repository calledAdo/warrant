import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle, Mail, MessageSquare, ShieldCheck } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/api';

// The supplied 21st.dev sign-in visual, adapted to Warrant's real report contract.
// There is no password/social-login service in this application.
export function BillingReportForm({ onSubmitted }: { onSubmitted: (id: string) => void }) {
  const [email, setEmail] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; body?: string; server?: string }>({});
  const emailRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    const next: typeof errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = 'Enter a valid account email address.';
    if (!body.trim()) next.body = 'Tell us a little about the charge you want us to check.';
    setErrors(next);
    if (next.email || next.body) { (next.email ? emailRef.current : bodyRef.current)?.focus(); return; }
    setBusy(true); submitting.current = true;
    try {
      const result = await post<{ id: string }>('/api/complaints', { email: email.trim(), body: body.trim() });
      if (!result.id) throw new Error('Your report could not be confirmed. Please try again.');
      onSubmitted(result.id);
    } catch (e) { setErrors({ server: e instanceof Error ? e.message : 'We could not submit your report. Please try again.' }); }
    finally { setBusy(false); submitting.current = false; }
  }
  return <form className="report-form" onSubmit={submit} noValidate aria-busy={busy}>
    <div className="form-icon"><MessageSquare strokeWidth={1.6} /></div>
    <h2>Let’s look into it.</h2>
    <p className="form-intro">Tell us what happened. We’ll follow the evidence.</p>
    <div className="field">
      <label htmlFor="email">Account email</label>
      <div className="input-icon"><Mail /><input ref={emailRef} id="email" name="email" type="email" autoComplete="email" inputMode="email" placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} required aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'email-error' : 'email-hint'} /></div>
      {errors.email ? <p id="email-error" className="field-error">{errors.email}</p> : <p id="email-hint" className="field-hint">Use the email linked to your billing account.</p>}
    </div>
    <div className="field">
      <label htmlFor="body">What happened?</label>
      <textarea ref={bodyRef} id="body" name="body" rows={4} placeholder="I noticed two charges for the same subscription…" value={body} onChange={e => setBody(e.target.value)} maxLength={2000} required aria-invalid={Boolean(errors.body)} aria-describedby={errors.body ? 'body-error' : 'body-hint'} />
      <div className="field-meta"><p id={errors.body ? 'body-error' : 'body-hint'} className={errors.body ? 'field-error' : 'field-hint'}>{errors.body || 'Dates and amounts help. No card details needed.'}</p><span className="character-count">{body.length.toLocaleString()} / 2,000</span></div>
    </div>
    {errors.server && <div className="notice notice-error" role="alert">{errors.server}</div>}
    <Button type="submit" className="submit-report" disabled={busy}>{busy ? <><LoaderCircle className="spin" />Submitting report…</> : <>Submit report<ArrowRight /></>}</Button>
    <div className="form-reassurance"><ShieldCheck /><span>Any refund is reviewed by a real person.</span></div>
  </form>;
}
