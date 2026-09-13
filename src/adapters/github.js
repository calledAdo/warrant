import {
  sqliteProviderEnabled, demoIncidents, createDemoCase, updateDemoCase,
  commentDemoCase, getDemoCase,
} from '../demo-store.js';

const REPO = () => process.env.GITHUB_REPO;

const incidentRecord = (i) => {
  const rawBody = i.body || '';
  const body = rawBody.slice(0, 600);
  const field = name => rawBody.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1]?.trim() || null;
  const billingKeys = (field('billing_keys') || '').split(',').map(x => x.trim()).filter(Boolean);
  return {
    number: i.number, title: i.title, body, created_iso: i.created_at, url: i.html_url,
    coverage_start_iso: field('incident_start'),
    coverage_end_iso: field('incident_end'),
    billing_keys: billingKeys,
  };
};

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(`GitHub ${res.status}: ${body.message || res.statusText}`);
    error.definitiveRejection = res.status >= 400 && res.status < 500 && res.status !== 408;
    throw error;
  }
  return body;
}

/** Open incidents the agent may cite as corroborating evidence. */
export async function findIncidents() {
  if (sqliteProviderEnabled()) return demoIncidents();
  const issues = await gh(`/repos/${REPO()}/issues?labels=incident&state=all&per_page=10`);
  return issues.map(incidentRecord);
}

export async function createCase({ title, body, labels = ['billing-case'] }) {
  if (sqliteProviderEnabled()) return createDemoCase({ title, body, labels });
  const i = await gh(`/repos/${REPO()}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body, labels }),
  });
  return { number: i.number, url: i.html_url };
}

export async function updateCase(number, body) {
  if (sqliteProviderEnabled()) return updateDemoCase(number, body);
  const i = await gh(`/repos/${REPO()}/issues/${number}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
  return { number: i.number, url: i.html_url };
}

export async function comment(number, body) {
  if (sqliteProviderEnabled()) return commentDemoCase(number, body);
  const c = await gh(`/repos/${REPO()}/issues/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return { id: c.id, url: c.html_url };
}

export async function getCase(number) {
  if (sqliteProviderEnabled()) return getDemoCase(number);
  const i = await gh(`/repos/${REPO()}/issues/${number}`);
  return { number: i.number, title: i.title, body: i.body, url: i.html_url, state: i.state };
}

/**
 * Engineering incidents (issues labelled `incident`) in a date window,
 * optionally filtered by keywords. Lists issues and filters locally rather
 * than using GitHub search, whose index lags newly created issues by minutes.
 */
export async function searchIncidents({ since, until, keywords } = {}) {
  const parsedFrom = since ? Date.parse(since) : NaN;
  const parsedTo = until ? Date.parse(until) : NaN;
  const to = Number.isFinite(parsedTo) ? Math.min(parsedTo, Date.now()) : Date.now();
  const from = Number.isFinite(parsedFrom) ? Math.max(parsedFrom, to - 365 * 86400000) : to - 30 * 86400000;
  if (from > to) throw new Error('incident search start must be before end');
  const words = String(keywords || '').toLowerCase().split(/[\s,]+/).filter((w) => w.length > 2).slice(0, 6);

  if (sqliteProviderEnabled()) {
    const incidents = demoIncidents().filter(i => {
      const created = Date.parse(i.created_iso);
      const text = `${i.title} ${i.body}`.toLowerCase();
      return created >= from && created <= to && (!words.length || words.some(word => text.includes(word)));
    });
    return { incidents, window: { from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10) }, keywords: words };
  }

  const found = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh(`/repos/${REPO()}/issues?labels=incident&state=all&per_page=100&page=${page}&sort=created&direction=desc`);
    for (const i of batch) {
      const t = Date.parse(i.created_at);
      if (t > to) continue;
      if (t < from) { page = 99; break; }
      const text = `${i.title} ${i.body || ''}`.toLowerCase();
      if (words.length && !words.some((w) => text.includes(w))) continue;
      found.push(incidentRecord(i));
    }
    if (batch.length < 100) break;
  }
  return { incidents: found.slice(0, 15), window: { from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10) }, keywords: words };
}
