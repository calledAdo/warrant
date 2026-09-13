import { db } from './storage.js';
import { lemmaConfigured, lemmaGet } from './lemma-api.js';
import { dashboardUrlFor } from './trace.js';

const TTL = 30000;
const AGENTS = new Set(['warrant.investigate','warrant.execute','warrant.decline','warrant.replay']);
const relevant = issue => !issue.agent_name || AGENTS.has(issue.agent_name);
const active = issue => ['open','in_progress'].includes(issue.status);
db.exec('CREATE TABLE IF NOT EXISTS lemma_cache (project TEXT PRIMARY KEY, checked_at TEXT NOT NULL, issues TEXT NOT NULL);');
let inFlight = null;

export function cachedIssues() {
  const row = db.prepare('SELECT * FROM lemma_cache WHERE project=?').get(process.env.LEMMA_PROJECT_ID || '');
  return { enabled: lemmaConfigured(), issues: row ? JSON.parse(row.issues) : [], checked_at: row?.checked_at || null,
    stale: !row || Date.now() - Date.parse(row.checked_at) > TTL, error: null };
}

/** Pull all active issues, including low-frequency issues; publish cache only after a complete read. */
export async function listIssues({ force = false } = {}) {
  if (!lemmaConfigured()) return { enabled: false, issues: [], checked_at: null, stale: false, error: null };
  const cached = cachedIssues();
  if (!force && !cached.stale) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const issues = [];
      for (let page = 0; page < 100; page++) {
        const data = await lemmaGet('/issues', { project_id: process.env.LEMMA_PROJECT_ID, expanded: true, limit: 100, offset: page * 100 });
        if (!Array.isArray(data.issues) || typeof data.has_more !== 'boolean') throw new Error('Lemma returned an invalid issues page');
        issues.push(...data.issues.filter(i => relevant(i) && active(i)));
        if (!data.has_more) {
          const checked_at = new Date().toISOString();
          db.prepare('INSERT OR REPLACE INTO lemma_cache VALUES (?,?,?)').run(process.env.LEMMA_PROJECT_ID, checked_at, JSON.stringify(issues));
          return { enabled: true, issues, checked_at, stale: false, error: null };
        }
        if (!data.issues.length) throw new Error('Lemma pagination did not advance');
      }
      throw new Error('Lemma issue pagination limit reached');
    } catch(error) {
      return { ...cached, stale: true, error: error.message };
    } finally { inFlight = null; }
  })();
  return inFlight;
}

export async function proposalHold() {
  const result = await listIssues({ force: true });
  const issues = result.issues.filter(i => (i.tags || []).some(t => t.name === 'warrant-hold'));
  if (issues.length) return { reason: 'warrant-hold', issue_ids: issues.map(i => i.id), checked_at: result.checked_at,
    stale: result.stale, message: 'A person tagged an active Warrant issue warrant-hold. Remove the tag or resolve the issue in Lemma, then resume.' };
  // A failed read cannot establish that a hold was removed or that none exists.
  if (result.enabled && result.stale) return { reason: 'lemma_unavailable', issue_ids: [], checked_at: result.checked_at,
    stale: true, message: 'Unable to check the current hold policy in Lemma. Retry when monitoring is available.' };
  return null;
}

/** Occurrences are trace-specific; project-wide issues are not presented as findings on this run. */
export async function issuesForRun(run) {
  const project = await listIssues();
  const traceIds = [...new Set([...(run.traceIds || []),run.traceId,run.execTraceId].filter(Boolean))];
  const traces = await Promise.all(traceIds.map(async id => {
    try {
      const trace = await dashboardUrlFor(id);
      if (!trace) return { trace_id: id, status: 'not_indexed', occurrences: [] };
      const data = await lemmaGet(`/traces/${encodeURIComponent(trace.internalId)}/issue_occurrences`);
      if (!Array.isArray(data.issue_occurrences)) throw new Error('invalid occurrences response');
      return { trace_id: id, status: 'ready', url: trace.url, occurrences: data.issue_occurrences };
    } catch(error) { return { trace_id: id, status: 'unavailable', error: error.message, occurrences: [] }; }
  }));
  const ids = new Set(traces.flatMap(t => t.occurrences.map(o => o.issue_id || o.issue?.id).filter(Boolean)));
  return { ...project, issues: project.issues.filter(i => ids.has(i.id)), traces, run_id: run.id,
    flagged: traces.some(t => t.occurrences.some(o => active(o.issue || project.issues.find(i => i.id === o.issue_id) || {}))) };
}
