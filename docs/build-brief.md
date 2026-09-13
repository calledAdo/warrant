> **Historical.** This is the brief written before the hackathon. The shipped design differs: it runs on LangGraph, has separate customer and billing-team pages, and enforces the duplicate rule in code. See the README for the current system.

# Warrant — build brief

> An agent that has to earn the right to move money — and refuses when the evidence doesn't support it.

Read [PLAN.md](./PLAN.md) first for the verified gate results. This document is what you code against on Sunday. All three provider paths are already proven working; nothing here is speculative about the APIs.

**Window:** 09:30–16:00 PT = 390 minutes. Nothing new starts after 14:30.

---

## 1. What it does

A customer reports being billed twice. Warrant:

1. Reads the customer's recent **Stripe** charges
2. Reads **GitHub** for a corroborating billing incident
3. Assembles a cited case and either **proposes one exact correction** or **refuses for want of evidence**
4. Writes the case to **GitHub** — this happens either way, refusal included
5. Posts the proposal to **Slack** with a link to an approval screen
6. On approval, issues **one full refund**, then verifies and updates both GitHub and Slack

The demo is the refusal, not the refund.

---

## 2. Layout

```
src/
  adapters/
    stripe.js      listCharges, getCharge, refundFull
    github.js      createCase, updateCase, comment, findIncidents
    slack.js       postProposal, updateMessage
  journal.js       SQLite. Intent before every write, result after
  plan.js          buildPlan, hashPlan, isExpired
  executor.js      The guardrails. Owns all correctness
  agent.js         LLM: evidence -> cited case -> proposal | refusal
  policy.md        The rules. Goes in the prompt AND uploads to Lemma
  trace.js         Lemma wrapper
  server.js        POST /report, GET /approve/:planId, POST /approve/:planId
fixtures/
  build.mjs        --scenario s1|s2|s3|s4
verify/            (already green — don't touch on Sunday)
```

Node, ESM, no framework. `better-sqlite3` for the journal, `@ai-sdk/anthropic` + `ai` for the model, plus the three SDKs already installed.

---

## 3. The plan object — what approval binds to

Everything hinges on this. Approval authorises **one exact operation**, not "whatever the agent does next."

```js
{
  plan_id:      "wpl_a91f3c2e...",   // sha256 of the material fields below
  case_id:      2,                    // GitHub issue number
  customer_id:  "cus_VFGA9n4A51N9Ih",
  charge_id:    "ch_3UEldn...",       // the charge to refund
  duplicate_of: "ch_3UEldm...",       // the charge to keep
  amount:       4900,
  currency:     "usd",
  action:       "refund_full",        // the ONLY permitted action
  grounds:      "Identical amount, same customer, 1s apart, corroborated by #1",
  evidence:     [{ source, id, detail }, ...],
  created_at:   "2026-09-13T17:02:00Z",
  expires_at:   "2026-09-13T17:17:00Z"
}
```

```js
// plan.js
const MATERIAL = ['customer_id', 'charge_id', 'duplicate_of', 'amount', 'currency', 'action'];
export const hashPlan = (p) =>
  'wpl_' + createHash('sha256').update(JSON.stringify(MATERIAL.map(k => p[k]))).digest('hex').slice(0, 16);
```

**Why it matters:** if the agent re-runs and proposes anything different — a different charge, a different amount — the hash changes and the old approval no longer matches. Stale approvals die automatically rather than authorising the wrong thing.

---

## 4. The journal

```sql
CREATE TABLE operations (
  op_key       TEXT PRIMARY KEY,   -- "<plan_id>:<step>"
  plan_id      TEXT NOT NULL,
  step         TEXT NOT NULL,      -- refund | update_case | update_slack
  status       TEXT NOT NULL,      -- intended | succeeded | failed
  request      TEXT,
  result       TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE approvals (
  plan_id    TEXT PRIMARY KEY,
  plan       TEXT NOT NULL,
  approver   TEXT NOT NULL,
  approved_at TEXT NOT NULL
);
```

`op_key` doubles as the **Stripe idempotency key**. One identifier, one source of truth.

```js
// journal.js — the only shape the executor uses
async function withJournal(opKey, meta, fn) {
  const existing = db.get(opKey);
  if (existing?.status === 'succeeded') return { skipped: true, result: existing.result };
  if (existing?.status === 'intended')  return { uncertain: true };  // crashed mid-write — inspect, don't retry blind
  db.insert({ op_key: opKey, status: 'intended', request: meta });
  try {
    const result = await fn(opKey);           // opKey passed through as idempotency key
    db.update(opKey, { status: 'succeeded', result });
    return { result };
  } catch (error) {
    db.update(opKey, { status: 'failed', error });
    throw error;
  }
}
```

The `uncertain` branch is the honest one: if the process died between writing intent and recording the result, **we do not know** whether the refund landed. Read Stripe back before doing anything else. Never retry blind.

---

## 5. Executor guardrails

These are the deliverable. The model is not trusted with any of them.

| # | Rule | Enforcement |
| --- | --- | --- |
| G1 | **Full refunds only** | `plan.amount === charge.amount` or reject. Verified finding: partial refunds stack silently |
| G2 | Approval binds to the plan hash | `hashPlan(plan) === approval.plan_id` or reject |
| G3 | Approvals expire | 15 minutes. Checked at execution, not at approval |
| G4 | Intent journalled before every external write | `withJournal` wraps all three |
| G5 | Idempotency key = `op_key` | Deterministic from the plan, so a retry reuses it |
| G6 | **Assert `amount_refunded`, never `refunded`** | Verified: `refunded` reads `false` on an over-refunded charge |
| G7 | One refund per case | Journal lookup on `plan_id` prefix |
| G8 | The charge must come from the agent's own proposal | Reject any `charge_id` not in the case's evidence set |
| G9 | Never reverse a succeeded write because a later step failed | Report partial; resume the pending step only |

```js
// executor.js — shape
export async function execute(plan, approval, trace) {
  assert(hashPlan(plan) === approval.plan_id, 'plan_mismatch');      // G2
  assert(new Date() < new Date(plan.expires_at), 'approval_expired'); // G3
  assert(plan.action === 'refund_full', 'unsupported_action');

  const charge = await stripe.getCharge(plan.charge_id);
  assert(charge.amount === plan.amount, 'amount_mismatch');           // G1
  assert(charge.currency === plan.currency, 'currency_mismatch');

  const refund = await withJournal(`${plan.plan_id}:refund`, plan, (key) =>
    stripe.refundFull(plan.charge_id, key));                          // G4, G5

  const after = await stripe.getCharge(plan.charge_id);
  assert(after.amount_refunded === plan.amount, 'refund_not_verified'); // G6

  // G9: from here, failures are reported, never rolled back
  const steps = [
    ['update_case',  () => github.comment(plan.case_id, outcomeBody(plan, refund))],
    ['update_slack', () => slack.updateMessage(plan.slack_ts, appliedBlocks(plan, refund))],
  ];
  const pending = [];
  for (const [step, fn] of steps) {
    try { await withJournal(`${plan.plan_id}:${step}`, plan, fn); }
    catch (e) { pending.push({ step, error: e.message }); }
  }
  return pending.length ? { status: 'partial', pending } : { status: 'complete' };
}
```

---

## 6. `policy.md` — the agent's rules

This file goes in the system prompt **and** uploads to Lemma as agent context, so the rules the agent follows are the rules Lemma judges it against.

```markdown
You investigate reported billing problems. You may propose exactly one
correction: a full refund of a duplicate charge. You may not propose partial
refunds, credits, or any other remedy.

PROPOSE a refund only when ALL hold:
- Two succeeded charges, same customer, identical amount and currency
- Created within 24 hours of each other
- A corroborating GitHub incident covering that window, OR the charge
  descriptions are identical

REFUSE when ANY holds:
- The amounts differ
- The descriptions indicate different goods or services
- No corroborating incident and the descriptions differ
- Only one charge exists
- The charge is already refunded

When you refuse you must still write the investigation case, state exactly
which evidence is missing, and propose nothing.

ALWAYS:
- Cite provider IDs for every claim. Never describe a charge you did not read
- State uncertainty plainly. Do not resolve ambiguity in favour of acting
- Refund the LATER of the two charges; the earlier one is the legitimate one

NEVER:
- Name a charge ID that did not appear in the evidence you gathered
- Claim a refund succeeded. Only the executor's verified readback may say that
```

Keep it testable. Vague rules produce noisy Lemma findings.

---

## 7. The four scenarios

```bash
node fixtures/build.mjs --scenario s1   # prints the customer id to feed in
```

| # | Fixture | Required behaviour | Assert |
| --- | --- | --- | --- |
| **S1** | Two identical $49 charges 1s apart + incident #1 | Case written, proposal posted, one refund, verified | `amount_refunded===4900`, case has outcome comment, Slack ts unchanged |
| **S2** | $49 + $73, different descriptions, no incident | **Refuses.** Case written stating what's missing. No Slack proposal, no refund | zero rows in `operations`, case body contains the missing-evidence statement |
| **S3** | S1, then replay the approval / re-run execute | No second refund | `refunds.list(charge).length===1`, journal shows `skipped:true` |
| **S4** | S1, Slack rate-limited on `chat.update` *after* the refund | Refund preserved. `status:'partial'`, pending names `update_slack` only. Resume completes just that | `amount_refunded===4900` unchanged after resume; refund step shows `skipped` |
| S5 | *If time:* approval names a charge the agent never proposed | Rejected, `plan_mismatch`, nothing written | zero rows |

**S2 is the demo.** Build and test it *before* polishing S1.

S4's failure comes from the Arga Slack twin's seeded rate limit. If the twin can't produce it, use an adapter fault flagged `SIMULATED_FAULT` in the logs and say so in the brief — never present it as native.

---

## 8. Lemma instrumentation

One trace per execution. Investigation, approval and resume are separate executions linked by `threadId = case_id`.

```
warrant.investigate                      [threadId=case-2, release=<sha>]
  fetch-charges                  tool    stripe.charges.list
  fetch-incidents                tool    github.search
  assemble-case                  gen     model, input, output, tokens
  write-case                     tool    github.createCase
  post-proposal                  tool    slack.postMessage
warrant.execute                          [threadId=case-2]
  verify-charge                  tool
  refund                         tool    stripe.refunds.create
  verify-refund                  tool
  update-case                    tool
  update-slack                   tool    <- the failure lands here in S4
  evaluate-final-state           span    {status, pending[]}
```

Rules: record the failure on the **exact** tool span; pass `error`, never a fabricated output; set `metadata.scenario` and `metadata.plan_id`; `release` = git SHA so v1→v2 shows on the issue timeline.

Upload `policy.md` as agent context once named traces exist.

---

## 9. Sunday

| PT | Work | Exit condition |
| --- | --- | --- |
| 09:30–10:00 | `npm run verify` (all green already). Arga twin up. Lemma trace ready | Three providers live, one trace visible |
| 10:00–11:15 | Adapters + journal + `fixtures/build.mjs` | S1 fixture builds; a hardcoded plan executes end to end, **no LLM** |
| 11:15–12:15 | `agent.js` + `policy.md`. **S2 first**, then S1 | Agent refuses correctly before it acts correctly |
| 12:15–13:30 | Plan hashing, approval screen, executor guardrails G1–G9 | S3 passes: replay causes no second refund |
| 13:30–14:30 | S4 with the twin. Full instrumentation. Run all four | Four scenarios pass from a clean fixture |
| 14:30–15:15 | **Freeze.** Rehearse, record. Backup recording of a clean run | Video done |
| 15:15–16:00 | Reliability brief with real counts, README, submit | Submitted before judging |

If you're behind at 12:15, cut in this order: S5, the Slack twin (use the labelled adapter fault), the approval *screen* (approve via a signed CLI command, still plan-bound). **Never cut the journal or the readback assertions** — they are the submission.

---

## 10. Two-minute demo

| s | Show |
| --- | --- |
| 0–15 | "A customer says they were charged twice. The obvious move is to refund — and that's the move you don't want an agent making on its own." |
| 15–45 | **S1.** Agent reads Stripe, finds the pair, finds incident #1, writes the case with cited IDs, posts to Slack. Approve. Refund lands. Slack message edits itself to "applied and verified." |
| 45–75 | **S2.** Same agent, different customer. $49 and $73, different services, no incident. **It refuses** — writes the case, states exactly what evidence is missing, asks for nothing. |
| 75–100 | **S4.** Slack fails after the refund. Not rolled back. "Refund complete, Slack update pending." Resume — only Slack is retried. Then: *"and here's why"* — the partial-refund stacking test from PLAN.md. Our payment provider will double-refund silently. The journal is why we don't. |
| 100–120 | Lemma trace: the failed call, the recovery, the final checks. Real counts: 4 scenarios, N runs, N passed. |

Lead with competence, spend the middle on refusal, end on the dependency bug you found. Judges scoring reliability at 25% will recognise it.

---

## 11. Reliability brief (fill in after)

> Warrant investigates reported duplicate charges across Stripe, GitHub and Slack. A language model gathers evidence and either proposes one full refund or refuses; deterministic code owns charge identity, amount, currency, approver, idempotency and postconditions. An operation journal records intent before every external write, enabling honest partial-failure reporting and resume.
>
> Approval binds to a hash of the material plan fields and expires in 15 minutes; a changed plan invalidates it. Refunds are full-amount only — we verified that Stripe silently stacks partial refunds issued under different idempotency keys, and that the `refunded` boolean reads `false` on an over-refunded charge, so we assert `amount_refunded` instead.
>
> We ran [N] scenarios in [environment]: [N] passed, [N] wrong-resource writes, [N] false completions. Arga supplied [twins and fault controls used]; Lemma recorded [N] traces including the injected failure and recovery.
>
> Limitations: one duplicate pair per case; approval is an authenticated in-app screen rather than a Slack interactive callback; [observed limitations].
