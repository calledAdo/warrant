/**
 * Third-app write. Proves: PAT auth works, we can create AND update an
 * investigation case, and we can read back what we wrote.
 * Run: npm run verify:github
 */
import 'dotenv/config';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO;

const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

if (!TOKEN || !REPO) {
  console.error('\nGITHUB_TOKEN and GITHUB_REPO must be set in .env\n');
  process.exit(1);
}

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`${res.status} ${body.message || res.statusText}`);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  return body;
}

async function main() {
  head('0. Auth and repo access');
  const me = await gh('/user');
  pass(`authenticated as ${me.login}`);
  const repo = await gh(`/repos/${REPO}`);
  pass(`repo reachable: ${repo.full_name} (issues ${repo.has_issues ? 'on' : 'OFF — enable them'})`);
  if (!repo.has_issues) {
    fail('Issues are disabled on this repo. Enable in Settings > Features.');
    process.exit(1);
  }

  head('1. Seed a corroborating incident (what the agent reads as evidence)');
  const incident = await gh(`/repos/${REPO}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'Billing: retry loop double-submitted invoices on 2026-09-02',
      body:
        'Between 14:02 and 14:09 UTC the invoice retry worker re-submitted ' +
        'PaymentIntents that had already succeeded.\n\n' +
        'Affected: customers with an open invoice at the time of deploy `a91f3c2`.\n' +
        'Symptom: two identical succeeded charges, minutes apart.\n\n' +
        '_Seeded fixture for Warrant S1._',
      labels: ['incident', 'billing'],
    }),
  });
  pass(`incident issue #${incident.number} created`);

  head('2. Create an investigation case (the agent write)');
  const created = await gh(`/repos/${REPO}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'Investigation: suspected duplicate charge — Northwind Trading Co.',
      body: '_placeholder — the agent overwrites this with cited evidence_',
      labels: ['billing-case'],
    }),
  });
  pass(`case issue #${created.number} created`);

  head('3. Update it with evidence (the agent revises its own case)');
  const updated = await gh(`/repos/${REPO}/issues/${created.number}`, {
    method: 'PATCH',
    body: JSON.stringify({
      body: [
        '## Finding',
        'Two succeeded charges, same customer, same amount, 41s apart.',
        '',
        '## Evidence',
        '| Source | ID | Detail |',
        '| --- | --- | --- |',
        '| Stripe | `ch_xxx` | $49.00 succeeded 14:03:11Z |',
        '| Stripe | `ch_yyy` | $49.00 succeeded 14:03:52Z |',
        `| GitHub | #${incident.number} | retry loop double-submitted, same window |`,
        '',
        '## Proposed correction',
        'Refund `ch_yyy` in full. Awaiting approval.',
        '',
        '## Uncertainty',
        'None material. Amounts, customer and window all corroborate.',
      ].join('\n'),
    }),
  });
  pass(`case #${updated.number} updated (${updated.body.length} chars)`);

  head('4. Readback');
  const readback = await gh(`/repos/${REPO}/issues/${created.number}`);
  const ok = readback.body.includes('Proposed correction');
  (ok ? pass : fail)('body reads back with the evidence table');

  head('5. Comment (used on resume to record the outcome)');
  const comment = await gh(`/repos/${REPO}/issues/${created.number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: 'Refund `re_xxx` applied and verified. `amount_refunded=4900`.' }),
  });
  pass(`comment ${comment.id} posted`);

  console.log(`\n  \x1b[32mGitHub path holds.\x1b[0m`);
  console.log(`  Reuse: incident #${incident.number}, case #${created.number}`);
  console.log(`  ${repo.html_url}/issues\n`);
}

main().catch((err) => {
  console.error(`\n\x1b[31mFAILED\x1b[0m ${err.message}`);
  if (err.status === 401) console.error('  Token is invalid or expired.');
  if (err.status === 403) console.error('  Token lacks `repo` scope, or you hit a rate limit.');
  if (err.status === 404) console.error('  Repo not found — check GITHUB_REPO is `owner/name` and the token can see it.');
  console.error();
  process.exit(1);
});
