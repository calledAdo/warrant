const REPO = () => process.env.GITHUB_REPO;

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
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${body.message || res.statusText}`);
  return body;
}

/** Open incidents the agent may cite as corroborating evidence. */
export async function findIncidents() {
  const issues = await gh(`/repos/${REPO()}/issues?labels=incident&state=all&per_page=10`);
  return issues.map((i) => ({
    number: i.number,
    title: i.title,
    body: (i.body || '').slice(0, 600),
    created_iso: i.created_at,
    url: i.html_url,
  }));
}

export async function createCase({ title, body, labels = ['billing-case'] }) {
  const i = await gh(`/repos/${REPO()}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body, labels }),
  });
  return { number: i.number, url: i.html_url };
}

export async function updateCase(number, body) {
  const i = await gh(`/repos/${REPO()}/issues/${number}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
  return { number: i.number, url: i.html_url };
}

export async function comment(number, body) {
  const c = await gh(`/repos/${REPO()}/issues/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return { id: c.id, url: c.html_url };
}

export async function getCase(number) {
  const i = await gh(`/repos/${REPO()}/issues/${number}`);
  return { number: i.number, title: i.title, body: i.body, url: i.html_url, state: i.state };
}

/**
 * Engineering incidents (issues labelled `incident`) in a date window,
 * optionally filtered by keywords. Lists issues and filters locally rather
 * than using GitHub search, whose index lags newly created issues by minutes.
 */
export async function searchIncidents({ since, until, keywords } = {}) {
  const from = since ? Date.parse(since) : Date.now() - 30 * 86400000;
  const to = until ? Date.parse(until) : Date.now();
  const words = String(keywords || '').toLowerCase().split(/[\s,]+/).filter((w) => w.length > 2).slice(0, 6);

  const found = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh(`/repos/${REPO()}/issues?labels=incident&state=all&per_page=100&page=${page}&sort=created&direction=desc`);
    for (const i of batch) {
      const t = Date.parse(i.created_at);
      if (t > to) continue;
      if (t < from) { page = 99; break; }
      const text = `${i.title} ${i.body || ''}`.toLowerCase();
      if (words.length && !words.some((w) => text.includes(w))) continue;
      found.push({ number: i.number, title: i.title, body: (i.body || '').slice(0, 400), created_iso: i.created_at, url: i.html_url });
    }
    if (batch.length < 100) break;
  }
  return { incidents: found.slice(0, 15), window: { from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10) }, keywords: words };
}
