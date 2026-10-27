# Warrant on Zetaris: the Unified Semantic Layer

This document answers the Zetaris evaluation criteria for Warrant Remembers. Every query result it cites is real output from the local Zetaris, recorded in [zetaris-usl-results.md](zetaris-usl-results.md) and reproducible with `node scripts/usl-report.mjs` (17 of 17 queries succeed). The layer is registered with `node scripts/setup-zetaris.mjs`, `node scripts/setup-principals.mjs` and `node scripts/setup-usl.mjs`.

## 1a. Use case and the data sources it needs

**Use case.** A customer writes "you charged me twice". Answering properly means checking the billing system, looking for an engineering incident that explains it, and checking how similar cases were decided before. Only then may a refund be proposed for a person to approve.

| # | Source | Kind | Zetaris object | Why Warrant needs it |
|---|---|---|---|---|
| 1 | Billing history | PostgreSQL (JDBC datasource), synced from Stripe test mode | `warrant_db.billing_history` | Are there really two charges? |
| 2 | Engineering incidents | PostgreSQL (JDBC datasource), synced from GitHub | `warrant_db.engineering_incidents` | Is there a cause, such as a retry bug? |
| 3 | Case history | PostgreSQL (JDBC datasource), written by Warrant | `warrant_db.case_history` | How were similar cases decided? |
| 4 | Stripe snapshot | JSON in object storage (filestore) | `warrant_snap.stripe_charges`, `warrant_snap.stripe_customers` | The raw export, to reconcile against the database |
| 5 | GitHub snapshot | JSON in object storage (filestore) | `warrant_snap.github_incidents` | The raw incident export |

Five sources over two access methods (JDBC and object storage), above the minimum of three.

## 1b. Onboarding, verification and exploratory queries

`scripts/sync-evidence.mjs` pulls Stripe (test mode) and GitHub into the `warrant` database and writes the raw snapshots to object storage. `scripts/setup-zetaris.mjs` and `scripts/setup-usl.mjs` register both in Zetaris. Each source was verified with two questions (10 in total), all answered through Zetaris:

- **Billing:** charges per customer and status; unrefunded charges, newest first.
- **Incidents:** open incidents; which look billing-related.
- **Case history:** what past cases concluded; what approvers decided.
- **Stripe snapshot:** what the raw export holds per customer; who the customers are.
- **GitHub snapshot:** what the raw export holds; whether incidents state the window they cover.

Onboarding surfaced two issues we fixed:
- JSON snapshots must be JSON arrays, because Zetaris reads a JSON file as one document.
- Zetaris returns timestamps without a time zone and booleans as strings. Warrant parses both explicitly, after a run read "false" as true.

## 1c. The USL, its DDL, proof it is active, and a data quality rule

**The USL** is the registered sources plus a semantic view, `wr_views.duplicate_candidates`. It applies the same duplicate test as Warrant's code: same customer, amount and currency; both succeeded and unrefunded; the later charge within 24 hours; corroborated by an identical description or a billing incident in the window. Full DDL is in [scripts/register_zetaris_usl.sql](../scripts/register_zetaris_usl.sql):

```sql
CREATE SCHEMASTORE CONTAINER wr_views;
CREATE SCHEMASTORE VIEW duplicate_candidates WITH CONTAINER wr_views AS
SELECT a.customer_id, a.stripe_charge_id AS kept_charge, b.stripe_charge_id AS candidate_duplicate,
       b.amount, b.currency, (unix_timestamp(b.created_at) - unix_timestamp(a.created_at)) AS seconds_apart,
       (a.description <> '' AND a.description = b.description) AS same_description,
       EXISTS (SELECT 1 FROM warrant_db.engineering_incidents i
               WHERE lower(i.title) RLIKE 'billing|charge|payment|invoice|retry'
                 AND i.created_at BETWEEN a.created_at - INTERVAL 1 DAY AND b.created_at + INTERVAL 1 DAY) AS incident_corroborates
FROM warrant_db.billing_history a JOIN warrant_db.billing_history b
  ON a.customer_id = b.customer_id AND a.amount = b.amount AND a.currency = b.currency
 AND b.created_at > a.created_at AND b.created_at <= a.created_at + INTERVAL 1 DAY
WHERE a.status = 'succeeded' AND b.status = 'succeeded' AND NOT a.refunded AND NOT b.refunded
```

Access is governed in the same layer: [scripts/setup_zetaris_principals.sql](../scripts/setup_zetaris_principals.sql) creates `wr_evidence` (SELECT on billing history and incidents) and `wr_history` (SELECT on case history). The agent's tools can only read. Refunds never pass through Zetaris.

**The USL is active** (recorded results):

| Query | Result |
|---|---|
| `wr_views.duplicate_candidates` | `ch_demo_northwind_02` duplicates `ch_demo_northwind_01`: 4,900 cents, **43 seconds apart**, same description, incident corroborates. This is exactly what the live Nemotron investigation concluded |
| Three sources in one question | Northwind Trading Co. (Stripe snapshot), the candidate duplicate, and "Billing retry duplicated successful payments" (GitHub) |
| Same-amount pairs without the policy | 1 pair here. The view adds the status, refund, window and corroboration conditions that keep legitimate repeat charges out |

**Data quality rules, executed** (all passed):

- **DQ-1 Cross-store reconciliation:** every charge in PostgreSQL matches the Stripe snapshot in object storage on id, amount and currency (0 mismatches).
- **DQ-2 Referential integrity:** every charge's customer exists in the customer snapshot (0 orphans).
- **DQ-3 Validity:** amounts positive, currency a 3-letter code, status a known Stripe status (0 invalid rows).

**A finding while building DQ-3.** On the JDBC datasource, a regular-expression filter in `WHERE` is not applied. `WHERE currency RLIKE '^[a-z]{3}$'` and `WHERE NOT currency RLIKE '^[a-z]{3}$'` both return every row (2 and 2 of 2). The same expression in the `SELECT` list evaluates correctly, so DQ-3 is written that way. The recorded results include the query that shows it.

## 2a. Time the USL saved versus a hand-coded approach

Warrant's own baseline (`oah-baseline`) is the hand-coded approach: direct SDK adapters for Stripe and GitHub (117 lines each), and a 186-line duplicate policy in JavaScript.

| Capability | Baseline, hand-coded | With Zetaris |
|---|---|---|
| Read billing and incidents | Two SDK adapters, paging and rate limits per API | SQL through one client, governed per principal |
| "Is this a duplicate?" across sources | Only inside the app, in JavaScript | Also a 20-line view any analyst or auditor can query |
| Reconcile database against the raw export | Not possible without new code | One SQL rule (DQ-1) |
| Who may read what | Enforced in application code | `GRANT SELECT` per principal, enforced by Zetaris |

**An honest result:** for simple reads, Zetaris did not save code here. Warrant's Zetaris client, evidence service and policy (398 lines) are larger than the two baseline adapters, because they add per-principal login and read checks. The saving is in cross-source questions and governance. The duplicate test, reconciliation and access rules became SQL objects anyone can run and audit, written in under an hour. We estimate the same as application features at about a day, before tests.

## 2b. Where the USL helps, and where it does not

**It helps** auditing and trust. A refund team, or an auditor, can query `wr_views.duplicate_candidates` directly and get the same answer the agent reached, without reading code. Least-privilege access is declared in one place.

**It does not help (yet)** with high-frequency single-record reads in an agent loop. Each SQL round trip adds latency against a direct API, and the read path needed extra code to parse zone-less timestamps and string booleans. The regex-filter finding also means a validation written the obvious way can silently pass.

**A project that would benefit:** a payments operations team handling disputes across Stripe, the internal ledger and support tickets. Each system becomes a source, `duplicate_candidates`-style views become shared definitions, and reconciliation rules run continuously. We forecast that new detection rules would take hours, not sprint-sized tickets.

## 2c. A requirement for Zetaris (written as a PM)

**Requirement: a pushdown-safety guarantee, with data-quality rules as first-class objects.**

*Problem.* Data-quality rules are exactly where silent wrong answers do the most harm. We found a regular-expression filter that is not applied on a JDBC source, so a validity rule reported every row as invalid, and its negation did too. A rule written to prove the data is clean could equally have proved it was clean when it was not.

*Requirement.*
1. When a predicate cannot be pushed down faithfully to a source, Zetaris evaluates it itself (or refuses with an error), never silently changes the result.
2. A `CREATE DATA QUALITY RULE` object that stores a rule against a table, runs it on a schedule or on demand, records pass/fail history, and is evaluated by Zetaris itself, not pushed down.

*Mock DDL:*

```sql
CREATE DATA QUALITY RULE billing_valid ON warrant_db.billing_history
  EXPECT amount > 0 AND currency RLIKE '^[a-z]{3}$' AND status IN ('succeeded','pending','failed')
  EVALUATE IN ZETARIS            -- never pushed down
  SCHEDULE EVERY 1 HOUR;

CREATE DATA QUALITY RULE stripe_matches_snapshot
  EXPECT ZERO ROWS FROM (SELECT p.stripe_charge_id FROM warrant_db.billing_history p
                         FULL OUTER JOIN warrant_snap.stripe_charges s ON p.stripe_charge_id = s.id
                         WHERE p.stripe_charge_id IS NULL OR s.id IS NULL OR p.amount <> s.amount);

SHOW DATA QUALITY RESULTS billing_valid;   -- run time, rows checked, violations, pass/fail history
```

*Why it matters.* In money-moving systems, the layer's answers must be trustworthy exactly where they are used as proof. Rules that Zetaris evaluates itself, with a history, would make the USL a system of record for data quality, not just for data.
