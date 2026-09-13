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
