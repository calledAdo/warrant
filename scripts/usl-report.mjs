// Runs the exploratory, semantic-layer and data-quality queries against Zetaris and writes
// their real results to docs/zetaris-usl-results.md. Usage: node scripts/usl-report.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8")
  .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

const Q = [
  ["Billing history (PostgreSQL via JDBC, synced from Stripe test mode)", [
    ["How many charges per customer and status?", "SELECT customer_id, status, COUNT(*) AS charges, SUM(amount) AS cents FROM warrant_db.billing_history GROUP BY customer_id, status"],
    ["Which charges are unrefunded, newest first?", "SELECT stripe_charge_id, amount, currency, created_at, description FROM warrant_db.billing_history WHERE NOT refunded ORDER BY created_at DESC LIMIT 5"],
  ]],
  ["Engineering incidents (PostgreSQL via JDBC, synced from GitHub)", [
    ["Which incidents are open?", "SELECT github_issue_number, title, state, created_at FROM warrant_db.engineering_incidents ORDER BY created_at DESC"],
    ["Which incidents look billing-related?", "SELECT github_issue_number, title FROM warrant_db.engineering_incidents WHERE lower(title) RLIKE 'billing|charge|payment|invoice|retry'"],
  ]],
  ["Case history (PostgreSQL via JDBC, written by Warrant)", [
    ["What did past cases conclude?", "SELECT finding, COUNT(*) AS cases FROM warrant_db.case_history GROUP BY finding"],
    ["What did approvers decide?", "SELECT COALESCE(approver_decision, 'pending') AS decision, COUNT(*) AS cases FROM warrant_db.case_history GROUP BY COALESCE(approver_decision, 'pending')"],
  ]],
  ["Stripe snapshot (JSON in object storage)", [
    ["What does the raw Stripe export hold per customer?", "SELECT customer_id, COUNT(*) AS charges, SUM(amount) AS cents, MIN(created) AS first_epoch, MAX(created) AS last_epoch FROM warrant_snap.stripe_charges GROUP BY customer_id"],
    ["Who are the customers?", "SELECT id, name, email FROM warrant_snap.stripe_customers"],
  ]],
  ["GitHub snapshot (JSON in object storage)", [
    ["What does the raw GitHub export hold?", "SELECT number, title, created_at FROM warrant_snap.github_incidents"],
    ["Do incidents state the window they cover?", "SELECT number, coverage_start, coverage_end FROM warrant_snap.github_incidents"],
  ]],
];
const USL = [
  ["The USL is active: duplicate candidates, the same test Warrant's code applies", "SELECT * FROM wr_views.duplicate_candidates"],
  ["Three sources in one question: candidate duplicates with the customer's name (Stripe snapshot) and the corroborating incident (GitHub)", "SELECT c.name AS customer, d.candidate_duplicate, d.amount, d.seconds_apart, i.title AS incident FROM wr_views.duplicate_candidates d JOIN warrant_snap.stripe_customers c ON c.id = d.customer_id LEFT JOIN warrant_db.engineering_incidents i ON lower(i.title) RLIKE 'billing|charge|payment|invoice|retry'"],
  ["Why the view is needed: same-amount pairs without the policy (status, refund state, 24-hour window, corroboration)", "SELECT COUNT(*) AS naive_same_amount_pairs FROM warrant_db.billing_history a JOIN warrant_db.billing_history b ON a.customer_id = b.customer_id AND a.amount = b.amount AND a.stripe_charge_id < b.stripe_charge_id"],
];
const DQ = [
  ["DQ-1 Cross-store reconciliation: every charge in PostgreSQL matches the Stripe snapshot on id, amount and currency (expected 0 mismatches)", "SELECT COUNT(*) AS mismatches FROM warrant_db.billing_history p FULL OUTER JOIN warrant_snap.stripe_charges s ON p.stripe_charge_id = s.id WHERE p.stripe_charge_id IS NULL OR s.id IS NULL OR p.amount <> s.amount OR p.currency <> s.currency"],
  ["DQ-2 Referential integrity: every charge's customer exists in the customer snapshot (expected 0 violations)", "SELECT COUNT(*) AS orphan_charges FROM warrant_db.billing_history p LEFT JOIN warrant_snap.stripe_customers c ON p.customer_id = c.id WHERE c.id IS NULL"],
  ["DQ-3 Validity: amounts positive, currency a 3-letter code, status a known Stripe status (expected 0 violations; evaluated in the SELECT list, see the finding below)", "SELECT SUM(CASE WHEN amount <= 0 OR NOT currency RLIKE '^[a-z]{3}$' OR status NOT IN ('succeeded', 'pending', 'failed') THEN 1 ELSE 0 END) AS invalid_rows FROM warrant_db.billing_history"],
  ["Finding: on the JDBC datasource, a regex filter in WHERE is not applied. Both of these count every row", "SELECT (SELECT COUNT(*) FROM warrant_db.billing_history WHERE currency RLIKE '^[a-z]{3}$') AS rows_matching_regex, (SELECT COUNT(*) FROM warrant_db.billing_history WHERE NOT currency RLIKE '^[a-z]{3}$') AS rows_not_matching_regex, (SELECT COUNT(*) FROM warrant_db.billing_history) AS total_rows"],
];

async function run(sql) {
  const t0 = Date.now();
  const res = await fetch(`${env.ZETARIS_REST_URL}/sql-editor/sqls/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ZETARIS_API_KEY}`, "X-Org-ID": env.ZETARIS_ORG_ID, "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
    body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 50 }), signal: AbortSignal.timeout(300_000),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, ms: Date.now() - t0, headers: body.headers ?? [], data: body.data ?? [], error: body.msg ? String(body.msg).split("\n")[0].slice(0, 200) : null };
}
const table = r => r.ok ? [`| ${r.headers.join(" | ")} |`, `|${r.headers.map(() => "---").join("|")}|`, ...r.data.slice(0, 8).map(row => `| ${row.map(v => String(v ?? "").replace(/\|/g, "/").slice(0, 60)).join(" | ")} |`)].join("\n") : `Error: ${r.error}`;
const out = [`# Zetaris USL: live query results`, ``, `Generated by \`node scripts/usl-report.mjs\` against the local Zetaris on ${new Date().toISOString().slice(0, 16)}Z. Every result below is real output.`, ``];
let n = 0, ok = 0;
for (const [source, qs] of Q) {
  out.push(`## ${source}`, ``);
  for (const [q, sql] of qs) { const r = await run(sql); n++; ok += r.ok; out.push(`**${q}** (${r.ms} ms)`, ``, "```sql", sql, "```", ``, table(r), ``); }
}
out.push(`## The USL is active`, ``);
for (const [q, sql] of USL) { const r = await run(sql); n++; ok += r.ok; out.push(`**${q}** (${r.ms} ms)`, ``, "```sql", sql, "```", ``, table(r), ``); }
out.push(`## Data quality rules (executed)`, ``);
for (const [q, sql] of DQ) { const r = await run(sql); n++; ok += r.ok; out.push(`**${q}** (${r.ms} ms)`, ``, "```sql", sql, "```", ``, table(r), ``); }
writeFileSync(new URL("../docs/zetaris-usl-results.md", import.meta.url), out.join("\n") + "\n");
console.log(`${ok}/${n} queries succeeded; wrote docs/zetaris-usl-results.md`);
