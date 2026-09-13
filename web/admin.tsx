import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowUpRight, CheckCheck, CircleHelp, CreditCard, FileSearch, FileText, Inbox, LayoutGrid, LoaderCircle, Search, ShieldCheck, SlidersHorizontal, X } from '@/components/icons';
import { Brand } from '@/components/brand';
import { Integration } from '@/components/ui/integration-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { usePoll } from '@/web/hooks/use-poll';
import { CaseDetail } from '@/web/case-detail';
import { money, relativeTime } from '@/lib/utils';
import type { Complaint, Config } from '@/lib/types';

type Filter = 'all' | 'review' | 'resolved';
export default function Admin() {
  const queue = usePoll<{ complaints: Complaint[] }>('/api/complaints', 4000);
  const config = usePoll<Config>('/api/config', 0);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(new URLSearchParams(location.search).get('case'));
  const [mobileDetail, setMobileDetail] = useState(Boolean(new URLSearchParams(location.search).get('run') || new URLSearchParams(location.search).get('case')));
  const [sort, setSort] = useState('newest');
  const [help, setHelp] = useState(false);
  const list = useMemo(() => queue.data?.complaints || [], [queue.data]);
  const waiting = list.filter(c => c.status === 'awaiting_approval').length;
  const resolved = list.filter(c => ['complete', 'refused', 'declined'].includes(c.status)).length;
  const visible = useMemo(() => list.filter(c => {
    const matches = `${c.customer_name || ''} ${c.email} ${c.body} ${c.id}`.toLowerCase().includes(search.toLowerCase().trim());
    return matches && (filter === 'all' || (filter === 'review' ? c.status === 'awaiting_approval' : ['complete', 'refused', 'declined'].includes(c.status)));
  }).sort((a, b) => sort === 'oldest' ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)), [list, search, filter, sort]);
  const selected = list.find(c => c.id === selectedId);
  useEffect(() => {
    document.title = 'Billing workspace — Warrant';
    const pop = () => { const params = new URLSearchParams(location.search); setSelectedId(params.get('case')); setMobileDetail(Boolean(params.get('case') || params.get('run'))); };
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !(event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)))) {
        event.preventDefault(); document.querySelector<HTMLInputElement>('input[aria-label="Search reports"]')?.focus();
      }
    };
    window.addEventListener('popstate', pop); window.addEventListener('keydown', shortcut);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('keydown', shortcut); };
  }, []);
  useEffect(() => {
    if (selectedId || !list.length) return;
    const requested = new URLSearchParams(location.search).get('run');
    if (requested && !list.some(c => c.run_id === requested)) { setSelectedId('unavailable'); return; }
    const first = (requested && list.find(c => c.run_id === requested)) || list.find(c => c.status === 'awaiting_approval') || list[0];
    if (first) setSelectedId(first.id);
  }, [list, selectedId]);
  function choose(complaint: Complaint) {
    setSelectedId(complaint.id); setMobileDetail(true);
    history.pushState({}, '', `/admin?case=${encodeURIComponent(complaint.id)}${complaint.run_id ? `&run=${encodeURIComponent(complaint.run_id)}` : ''}`);
  }
  return <div className="admin-app">
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <aside className="workspace-sidebar">
      <Brand href="/admin" />
      <div className="workspace-label"><div className="workspace-monogram">W</div><div><strong>Warrant workspace</strong><span>Billing operations</span></div></div>
      <p className="sidebar-section-label">WORKSPACE</p>
      <nav aria-label="Workspace navigation">
        <button className={filter === 'all' ? 'sidebar-active' : ''} onClick={() => { setFilter('all'); setMobileDetail(false); }}><Inbox />All reports<span>{list.length}</span></button>
        <button className={filter === 'review' ? 'sidebar-active' : ''} onClick={() => { setFilter('review'); setMobileDetail(false); }}><FileSearch />Needs review{waiting > 0 && <span className="sidebar-count">{waiting}</span>}</button>
        <button className={filter === 'resolved' ? 'sidebar-active' : ''} onClick={() => { setFilter('resolved'); setMobileDetail(false); }}><CheckCheck />Resolved<span>{resolved}</span></button>
      </nav>
      <div className="sidebar-principle"><ShieldCheck /><h2>Trust, with a paper trail.</h2><p>Every refund needs evidence. Every decision stays yours.</p></div>
      <div className="sidebar-bottom"><a href="/" target="_blank" rel="noreferrer"><ArrowUpRight />Customer portal<ArrowUpRight /></a><button onClick={() => setHelp(!help)} aria-expanded={help}><CircleHelp />How Warrant works</button>{help && <p className="sidebar-help">Reports are checked against Stripe charges and GitHub incidents. Review the evidence, then approve or decline the exact refund. Activity & audit contains the journal and trace links.</p>}<div className="workspace-person"><span className="team-avatar"><UserIcon /></span><div><strong>Billing team</strong><span>Review workspace</span></div></div></div>
    </aside>
    <main id="workspace" className="workspace-main">
      <header className="workspace-header"><div><LayoutGrid /><span>Billing operations</span><span className="workspace-header-slash">/</span><strong>Reports</strong></div><a href="/" className="button button-outline button-sm">Open customer portal<ArrowUpRight /></a></header>
      <div className="workspace-intro"><div><span className="eyebrow">THE BILLING DESK</span><h1>Every charge deserves clarity.</h1><p>Follow the evidence. Make the call. Close the loop.</p></div><div className="workspace-date"><span>{new Date().toLocaleDateString('en-US', { weekday: 'long' })}</span>{new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div></div>
      <div className="workspace-stats" aria-label="Report summary"><button onClick={() => { setFilter('all'); setMobileDetail(false); }}><span className="stat-icon"><Inbox /></span><div><span>Reports in queue</span><strong>{queue.data ? list.length.toString().padStart(2, '0') : '—'}</strong></div><span className="stat-note">Latest 50 reports</span></button><button onClick={() => { setFilter('review'); setMobileDetail(false); }}><span className="stat-icon stat-amber"><FileSearch /></span><div><span>Awaiting your review</span><strong>{queue.data ? waiting.toString().padStart(2, '0') : '—'}</strong></div><span className={`stat-note ${waiting ? 'text-amber' : ''}`}>{waiting ? 'Your decision needed' : 'You’re all caught up'}</span></button><button onClick={() => { setFilter('resolved'); setMobileDetail(false); }}><span className="stat-icon stat-green"><CheckCheck /></span><div><span>Resolved reports</span><strong>{queue.data ? resolved.toString().padStart(2, '0') : '—'}</strong></div><span className="stat-note">In this queue</span></button></div>
      {queue.error && <div className="notice notice-error queue-error" role="alert"><span>{queue.error.message} {queue.data ? 'Showing the last loaded queue.' : ''}</span><Button variant="outline" size="sm" onClick={queue.refresh}>Retry</Button></div>}
      <section className={`inbox-shell ${mobileDetail ? 'show-mobile-detail' : ''}`} aria-label="Report inbox">
        <div className="queue-panel"><div className="queue-heading"><h2>{filter === 'all' ? 'All reports' : filter === 'review' ? 'Needs review' : 'Resolved'}<span>{visible.length}</span></h2><div className="sort-control"><SlidersHorizontal /><select aria-label="Sort reports" value={sort} onChange={e => setSort(e.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div></div>
          <div className="queue-search"><Search /><input aria-label="Search reports" type="search" placeholder="Search reports…" value={search} onChange={e => setSearch(e.target.value)} /><kbd>/</kbd></div>
          <div className="queue-filter-row"><span>{filter === 'review' ? 'AWAITING A DECISION' : 'CUSTOMER REPORTS'}</span>{(filter !== 'all' || search) && <button onClick={() => { setFilter('all'); setSearch(''); }}>Clear filters<X /></button>}</div>
          <div className="queue-list" aria-label="Reports">
            {!queue.data && queue.loading ? <div className="queue-loading" role="status"><LoaderCircle className="spin" />Loading reports…</div> : visible.length ? visible.map(c => <button key={c.id} className={`queue-item ${selectedId === c.id ? 'queue-selected' : ''}`} aria-current={selectedId === c.id ? 'true' : undefined} onClick={() => choose(c)}><div className="queue-item-top"><span className="queue-avatar">{(c.customer_name || c.email).slice(0, 1).toUpperCase()}</span><strong>{c.customer_name || c.email}</strong><time dateTime={c.created_at}>{relativeTime(c.created_at)}</time></div><p>{c.body}</p><div className="queue-item-bottom"><StatusBadge status={c.status} /><span>{c.amount == null ? c.id : money(c.amount, c.currency)}</span></div></button>) : <div className="queue-empty"><Inbox /><h3>{list.length ? 'No matching reports' : queue.error ? 'Queue unavailable' : 'A clean slate.'}</h3><p>{list.length ? 'Try another search or clear your filters.' : queue.error ? 'Retry to load your reports.' : 'Customer reports will appear here as they come in.'}</p>{list.length > 0 && <Button variant="outline" size="sm" onClick={() => { setSearch(''); setFilter('all'); }}>Clear filters</Button>}</div>}
          </div>
          <div className="queue-footer"><ShieldCheck />Evidence before action.</div>
        </div>
        <div className="detail-container"><button className="mobile-back" onClick={() => setMobileDetail(false)}>← All reports</button>{selected ? <CaseDetail key={selected.id} complaint={selected} config={config.data} onChanged={queue.refresh} /> : <div className="workspace-empty"><div className="empty-top-label"><span className="status-dot" />{selectedId ? 'REPORT UNAVAILABLE' : 'READY WHEN YOU ARE'}</div><Integration /><div className="workspace-empty-copy"><h2>{selectedId ? 'This report isn’t in the current queue.' : 'Good decisions start with evidence.'}</h2><p>{selectedId ? 'Select another report from the queue. Only the latest 50 reports are listed.' : 'Choose a report to follow its investigation, review the evidence, and decide what happens next.'}</p><a className="button button-outline" href="/" target="_blank" rel="noreferrer">Open customer portal<ArrowRight /></a></div><div className="empty-principles"><span><CreditCard />Charges checked</span><span><FileText />Sources cited</span><span><ShieldCheck />Human approved</span></div></div>}</div>
      </section>
    </main>
  </div>;
}
function UserIcon() { return <ShieldCheck />; }
