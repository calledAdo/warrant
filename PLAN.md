# Warrant — setup plan and go/no-go gates

> An agent that has to earn the right to move money — and refuses when the evidence doesn't support it.

**Hackathon:** Multi-App AI Agent Hackathon, Sun 13 Sep 2026, 09:30–16:00 PT (390 minutes).
**Apps:** Stripe · GitHub · Slack. Chosen because all three authenticate with a pasted token — no OAuth consent screen anywhere on the critical path.

This document covers **setup and verification only**. Nothing here is the agent. The point is to answer, before Sunday, the questions that would waste the morning if answered on Sunday.

---

## Run the gates

```bash
cp .env.example .env     # then fill it in — see below
npm install
npm run verify           # all three gates, one go/no-go table
```

Or individually: `npm run verify:stripe`, `verify:github`, `verify:slack`.

Every script is read-safe in the sense that matters: **Stripe refuses any key not starting with `sk_test_`**. GitHub and Slack write to a throwaway repo and a test workspace you nominate.

---

## Credentials (~20 minutes, all today)

| Var | Where | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Dashboard → Developers → API keys, **Test mode toggle on** | Must be `sk_test_`. No Stripe account? Sign up free, test mode works immediately. |
| `GITHUB_TOKEN` | [Settings → Tokens](https://github.com/settings/tokens) → classic, `repo` scope | Fine-grained tokens work too; needs Issues read/write. |
| `GITHUB_REPO` | Create an empty repo, e.g. `you/warrant-billing-cases` | **Enable Issues** in Settings → Features. |
| `SLACK_BOT_TOKEN` | [api.slack.com/apps](https://api.slack.com/apps) → new app → OAuth & Permissions → bot scope `chat:write` → install | Then `/invite @yourbot` in the channel. |
| `SLACK_CHANNEL` | e.g. `#billing-approvals` | Create it in a test workspace, not your real one. |
| `LEMMA_API_KEY` / `LEMMA_PROJECT_ID` | [platform.uselemma.ai](https://platform.uselemma.ai) | Not needed for the three gates; needed Sunday. |

---

## Gate 1 — Stripe: does the refund remedy actually hold?

`npm run verify:stripe`

This is **the gate that decides the whole plan.** The Warrant design swaps the earlier credit-note remedy for a duplicate-charge refund, on the argument that it is cheaper to fixture and has an unambiguous readback. That argument is worthless untested.

The script walks the entire money path:

| Step | What it proves |
| --- | --- |
| 0 | Two confirmed `PaymentIntent`s in one call each → **the duplicate fixture is cheap** (target: under ~3s total) |
| 1 | `charges.list` surfaces the pair with a timestamp gap → the signal the agent reasons over |
| 2 | One `refunds.create` → `charge.refunded === true`, `amount_refunded === amount` → **binary readback** |
| 3 | Replay with the **same** `Idempotency-Key` → returns the *same* refund ID, `amount_refunded` does not move |
| 4 | Replay with a **different** key → **the finding that shapes the executor** |
| 5 | Builds the S2 refusal fixture: two *legitimately distinct* charges |

### RESULT — run 2026-09-12, 9/9 passed

Gate 1 is **green**. The refund remedy is viable. Measured facts:

| Fact | Value |
| --- | --- |
| Duplicate fixture build time | **1.8s** for two confirmed PaymentIntents — cheap to rebuild between scenarios |
| Readback | `refunded=true`, `amount_refunded=4900` — binary, as designed |
| Same idempotency key replayed | Returns the **identical** refund ID. `amount_refunded` does not move |
| Different key, **full** refund | **Rejected** by Stripe — `charge_already_refunded` |
| Different key, **partial** refund | **STACKED SILENTLY** — see below |

### The finding that shapes the executor

A follow-up test refunded $30 twice against a $100 charge using two different
idempotency keys:

```
refund 1: re_...12WncBmG  3000
refund 2: re_...1BxKLihH  3000   <- succeeded, no error
>>> amount_refunded = 6000 of 10000 | refunded flag: false
```

**Stripe silently double-refunded, and the `refunded` boolean still read `false`.**
This is exactly the class of failure the project is about: no exception, no error
code, a wrong amount of real money moved, and the obvious readback field says
nothing is wrong.

Two design consequences, both of which go in the reliability brief:

1. **Warrant only ever issues a FULL refund of the duplicate charge.** This is
   correct domain modelling anyway — a duplicate charge should not exist at all,
   so the remedy is the whole thing — and it happens to put us in the branch
   where Stripe backstops us with `charge_already_refunded`.
2. **The journal still owns correctness, not Stripe.** Stripe's protection is
   incidental to our design, not a guarantee we control, and it does nothing
   about the case where a replayed approval names a *different* charge. Assert
   `amount_refunded` against the expected value — never trust the `refunded`
   flag alone, which the test above proves can be `false` on an over-refunded
   charge.

S3 tests *our* protection. The partial-refund stacking result is worth showing
in the demo as the reason the journal exists.

### Reusable fixture IDs

```
S1 duplicate   customer=cus_VFGA9n4A51N9Ih
               keep=ch_3UEldmIa2TNAqGWf0xfkN7oI
               refund=ch_3UEldnIa2TNAqGWf1rirCu4H   (already refunded — rebuild for a clean run)
S2 distinct    customer=cus_VFGAcdlmE7GmcJ          ($49.00 + $73.00, different reasons)
```

**If gate 1 fails on a parameter error**, the API shape differs from the plan — fix the script, not the plan, and re-run. **If it fails on eligibility**, the refund remedy is wrong and Raincheck becomes the recommendation again.

---

## Gate 2 — GitHub: the third-app write

`npm run verify:github`

The earlier assessment flagged that GitHub was only *read* in the original TradeBridge happy path, which would weaken the three-app-action claim. This gate proves the write works, and seeds the evidence the agent will later cite:

1. Auth + repo reachable, Issues enabled
2. **Seeds a billing incident issue** — this is the corroborating evidence for S1
3. Creates an investigation case
4. **Updates** it with a cited evidence table — the agent revises its own case
5. Reads it back
6. Posts a comment — used on resume to record the outcome

Keep the issue numbers it prints. They're your Sunday fixtures.

---

## Gate 3 — Slack: post, update, and honest failure

`npm run verify:slack`

Three things:

1. **Post a proposal** with Block Kit — customer, charge, amount, grounds, expiry.
2. **Update that same message** in place, same `ts`. The whole approval UX depends on this working: the agent posts a proposal and later edits it to show the outcome. This is why Slack keeps a real write even though approval itself moves in-app.
3. **`ok: false` must be treated as a failure.** Slack returns HTTP 200 with `ok: false`. The script deliberately makes a bad call and asserts it throws. An adapter that only checks the status code would report a phantom success — exactly the silent failure this whole project is about.

### Twin mode

Set `SLACK_API_URL` to an Arga twin base URL and re-run the same script against the twin. It additionally checks for `X-Twin-Stub: true` / `_twin_stub` markers. **Never build on a stubbed endpoint.**

---

## Gate 4 — Arga (manual, one bootup)

You have **10 twin bootups, 1 twin per run, 10-minute TTL**. Spend exactly one:

```bash
uv tool install arga-cli
arga login
arga whoami                      # confirm remaining quota
arga previews twins provision --twins slack --ttl 10 --wait
```

Then, with the printed base URL:

```bash
SLACK_API_URL=<twin-url> SLACK_BOT_TOKEN=<twin-token> npm run verify:slack
```

Answering, in one run:
- Do `chat.postMessage` and `chat.update` work on the twin, unstubbed?
- Can a seeded `rate_limiting_enabled` rule on `chat.update` produce the S4 failure?

**Do this once.** Don't burn bootups repeating it. If the twin's rate limiting doesn't produce a usable failure, fall back to a clearly-labelled adapter fault on Sunday and say in the brief that it's a simulated fault, not a native Arga one.

---

## Gate 5 — Lemma (15 minutes)

Clone the Lemma examples repo, run the `vercel-ai` example with your key and project ID, and confirm a trace reaches *ready* in the dashboard. Note how long that takes — it sets whether the Sunday demo can show a live trace or needs a pre-recorded one.

Optional but valuable: send a trace that deliberately violates a rule you've uploaded as agent context, and time how long an Issue takes to appear. If it's slow, the demo leans on the trace tree rather than the Issues view.

---

## What "go" looks like

```
══════════ GO / NO-GO ══════════
  GO     Stripe refund + idempotency
  GO     GitHub investigation case
  GO     Slack post + update
```

Plus: one Arga Slack twin confirmed unstubbed, one ready Lemma trace, and a written answer to the step-4 idempotency question.

**If Stripe gate 1 fails** → fall back to Raincheck (its Stripe write is `active=false` on a payment link, the simplest financial operation in any of the candidate plans) — but only if your Google Calendar OAuth is already working.

---

## After the gates: what Sunday builds

Not in this repo yet. The shape, for reference:

```
src/
  adapters/      stripe.js  github.js  slack.js   — typed ok/err, never leak credentials
  journal.js     intent written BEFORE every external write, result after
  executor.js    owns charge identity, amount, currency, approver, idempotency
  agent.js       LLM: gather evidence → cited case → proposal OR refusal
  approve/       authenticated in-app approval screen, plan-bound, expiring
fixtures/        S1 duplicate · S2 distinct · S3 replay · S4 slack-fails
```

The division that goes in the reliability brief: **the model interprets and summarises evidence; code owns identity, amounts, authorization, idempotency and postconditions.**

### The four scenarios

| # | Fixture | Required behaviour |
| --- | --- | --- |
| S1 | Two identical charges + matching incident | Case written, approval requested, one refund, verified |
| S2 | Two legitimately distinct charges, no incident | **Refuses.** Writes the case, states what's missing, requests nothing |
| S3 | Approval replayed / run re-executed | No second refund. Journal and provider state agree |
| S4 | Slack rate-limited *after* the refund succeeded | Refund preserved, not reversed. Exact pending step reported. Resume completes only Slack |

**S2 is the demo.** An agent that declines to move money on thin evidence is a better thirty seconds, for this panel, than one that moves it smoothly.

---

## Open questions still owed to the organisers

- Do Arga twins count as "external apps" for the three-app requirement?
- What pre-Sunday scaffolding is permitted? (This repo is setup + verification only, which should be safe under any reading — but confirm.)
- Is multi-twin access available to participants?

---

## Gate results log

| Gate | Date | Result |
| --- | --- | --- |
| Stripe refund + idempotency | 2026-09-12 | **GO** — 9/9. Partial refunds stack silently (see above) |
| GitHub investigation case | 2026-09-12 | **GO** — 6/6. `calledAdo/warrant-billing-cases`, incident #1, case #2 |
| Slack post + update | 2026-09-12 | **GO** — 4/4. Workspace `Hug Face`, channel `#billing-approvals`, bot `hugger_face` |
| Arga Slack twin | 2026-09-12 | **GO** — unstubbed, native 429 fault confirmed, recovery verified. 7 remaining |
| Lemma trace round-trip | 2026-09-12 | **GO** — ingest works, ~32s to visible, error lands on the exact span |

**All three blocking gates green as of 2026-09-12. The Warrant plan is buildable.**

### Papercuts already fixed (so they don't cost time on Sunday)

- `SLACK_CHANNEL=#billing-approvals` unquoted is parsed by dotenv as an empty
  value — the `#` starts a comment. Must be quoted.
- The bot must be `/invite`d to the channel or `chat.postMessage` returns
  `channel_not_found`, even with `chat:write` granted.
- `conversations.list` needs `channels:read`, which we deliberately do **not**
  grant. Address channels by name from config; never enumerate them.

### Remaining before Sunday

- One Arga bootup on a Slack twin: confirm `chat.postMessage` / `chat.update`
  are unstubbed and that a seeded rate limit produces the S4 failure.
  Run: `SLACK_API_URL=<twin-url> npm run verify:slack`
- Lemma trace round-trip: run the `vercel-ai` example, time trace-ready.
- Consider a throwaway Slack workspace — `Hug Face` is a real one.
- Rotate the GitHub PAT after the event.

---

## Gate 4 RESULT — Arga Slack twin, 2026-09-12 (1 bootup, 7 remaining)

Provisioned with a single command — no saved scenario needed:

```bash
arga twin-runs create --twins slack --ttl 10 \
  --scenario-prompt "A Slack workspace with a channel named billing-approvals. \
Enable rate limiting with a strict limit on the chat.update method: at most 1 \
request per 60 seconds." --wait --json
```

| Question | Answer |
| --- | --- |
| `auth.test` | Works. `slack-twin-bot` @ `Default Workspace` |
| `chat.postMessage` | **Real, not stubbed.** Returns a real `ts` and channel id |
| `chat.update` | **Real, not stubbed.** `ts` preserved — the approval UX works |
| Seeded rate limit | **Fires. HTTP 429, `error=ratelimited`, `Retry-After: 60`** |
| Recovery after the window | **Works.** Second update returns 200, `ts` still preserved |
| `conversations.list` | Works on the twin — usable for assertions |
| `/admin/config`, `/admin/stub-hits` | 404 on the public host, **401 on the admin host** — needs the proxy token, not the bot token. Assert via the Slack API instead |

**S4 uses a NATIVE Arga fault.** No simulated fault, no caveat in the brief.

The seeded limit fires on the *first* `chat.update`, which is exactly the S4
shape: the refund succeeds, then Slack fails, then resume completes only the
Slack step once the window clears. The natural-language scenario prompt
produced this directly — no explicit `seed_config` JSON required.

### Notes for Sunday

- Twin bot token is fixed: `xoxb-F9SXMECOSFOGYR3XKXWN`. Base URL changes per run.
- Backoff must honour `Retry-After` (60s). For the demo, seed a shorter window
  so the recovery beat stays under ~20s on camera.
- The twin's channel is `billing-approvals` — same name as the real workspace,
  so `SLACK_CHANNEL` needs no change when swapping between them.
- Provision, probe and teardown took well under the 10-minute TTL.

---

## Gate 5 RESULT — Lemma, 2026-09-12

Signup is self-serve and free; no plan selection, no card, no published pricing.

| Question | Answer |
| --- | --- |
| Does ingest work? | **Yes.** Trace accepted in ~1.5–2.4s |
| Time to visible on the dashboard | **~32s** (measured, fresh trace) |
| Does the Warrant trace shape survive? | **Yes.** 6 spans: root + 4 tools + 1 generation |
| Is the error on the exact span? | **Yes.** `slack.post_proposal` = ERROR, root is not |
| `threadId`, `metadata`, `release` | All land |

### Trap — `fetchIngestStatus()` lies

`lemma.fetchIngestStatus(traceId)` returns **`"enqueued"` forever**, even when the
trace is fully processed and on the dashboard. `GET /traces/{id}` with the SDK's
id returns **404**.

Cause: two different identifiers. The SDK hands back an `otel_trace_id`
(`02c72974-…`); the API keys traces on a separate internal `id`
(`bf84852b-…`). Resolve one to the other via:

```
GET https://api.uselemma.ai/traces/dashboard?project_id=<P>&limit=20
    -> match on otel_trace_id, read .id
GET https://api.uselemma.ai/traces/{internal_id}/spans?project_id=<P>
```

`verify/lemma-trace.mjs` now polls the dashboard instead. **Do not trust
`fetchIngestStatus` on Sunday** — it would read as "our traces aren't arriving"
when they are.

### Demo consequence

~32s is too slow to open cold on camera. **Open the Lemma tab before the run
starts**, or narrate the fixture reset while the trace lands. Do not click into
Lemma and wait.

---

## End-to-end rehearsal — 2026-09-13 (1 bootup, 6 remaining)

`node verify/e2e.mjs` — all four scenarios pass against real Stripe, real
GitHub, and real or twinned Slack.

| Scenario | Result |
| --- | --- |
| S1 duplicate | Proposed → approved → refunded → `amount_refunded=4900` verified. The legitimate charge untouched |
| S2 not a duplicate | **Refused.** Case written anyway, missing evidence stated, no money moved |
| S3 replay | `amount_refunded` unchanged; exactly one refund op in the journal; executor reports "already done" |
| S4 Slack fails after refund | `status=partial`, pending `update_slack` (HTTP 429, Retry-After 60). **Refund preserved, not rolled back.** Resume → `complete`, refund still exactly once |

### Arming S4

The seeded limit allows **1** `chat.update` per 60s, and a normal run makes
exactly one — so the fault does not fire on its own. The harness consumes the
quota with a decoy update immediately before `execute()`. The fault is a
genuine Arga rate limit; we only guarantee the quota is saturated when the
executor arrives. Say this plainly in the brief.

For the demo, seed a shorter window so the recovery beat stays under ~20s.

### LLM

The shared gateway (`https://share-ai.ckbdev.com/v1`) returns
`API_KEY_EXPIRED`. Tonight's rehearsal ran in `LLM_MODE=rules` — a
deterministic engine implementing the same `policy.md`. Set a working key and
`LLM_MODE=llm` to use the model. The agent falls back to rules automatically if
the gateway is unreachable, which also protects the demo from an outage.

---

## LLM path verified against a mock — 2026-09-13

The shared gateway key is expired, so the model path was proven with a local
OpenAI-compatible mock (`/tmp/mockllm.mjs`, 1.8s simulated latency):

```
LLM_MODE=llm OPENAI_BASE_URL=http://localhost:4010/v1 \
OPENAI_API_KEY=mock OPENAI_MODEL=mock-gpt-4o node verify/e2e.mjs
```

All scenarios passed in LLM mode, including structural validation of the
model's JSON and the refusal branch. **When a working key arrives, the only
change is three env vars** — no code.

With a real model, `assemble case` becomes the widest bar in the waterfall
(~2s against ~0.5s provider calls), which is correct: the thinking should look
like the expensive step. In rules mode it is ~0ms and renders at the minimum
visible width.

---

## LLM provider — options, 2026-09-13

The shared gateway (`share-ai.ckbdev.com`) returns `API_KEY_EXPIRED`.
**GitHub Models is retired** — HTTP 410 `github_models_retirement_brownout` on
both `models.github.ai` and `models.inference.ai.azure.com`. Do not plan on it.

Test any candidate before trusting it:

```bash
node verify/llm-provider.mjs <base_url> <api_key> <model>
```

It checks auth, JSON mode, whether the model **refuses** on distinct charges
(the S2 case that carries the demo), whether it picks the LATER charge on a
duplicate, and reports reasoning latency.

| Provider | Free tier | OpenAI-compatible | Base URL |
| --- | --- | --- | --- |
| **Groq** (first choice) | 30 req/min, no card | Fully | `https://api.groq.com/openai/v1` |
| **Cerebras** | ~1M tokens/day, no card | Fully | `https://api.cerebras.ai/v1` |
| **OpenRouter** | 20 req/min, 50/day fresh account | Fully | `https://openrouter.ai/api/v1` |
| Google AI Studio | Generous, no card | **Partial** — risk | `https://generativelanguage.googleapis.com/v1beta/openai` |

Groq is first choice: fully OpenAI-compatible, generous, no card, and fast
enough that a demo never stalls. OpenRouter's 50 requests/day on a fresh
account is tight once you factor in rehearsals.


---

## LLM: RESOLVED — Groq, 2026-09-13

```
LLM_MODE=llm
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_MODEL=openai/gpt-oss-120b
```

`node verify/llm-provider.mjs <base> <key> <model>` results:

| Check | Result |
| --- | --- |
| Auth + completion | PASS (1073ms) |
| JSON mode (`response_format`) | **Rejected, HTTP 400** — the adapter retries without it and parses the object out of the text. Works. |
| Refuses on distinct charges | PASS (1215ms) |
| Picks the LATER charge on a duplicate | PASS (1055ms) |
| Reasoning latency in situ | **~2.1s** — the widest bar in the waterfall, as intended |

All four scenarios pass in LLM mode. The model's own refusal wording:

> Charges `ch_3UFBz1…` and `ch_3UFBz0…` have differing amounts (73.00 USD vs
> 49.00 USD) and different descriptions, so they are not duplicates.
> **Missing:** Amounts differ and descriptions indicate different goods/services.

Groq free tier is 30 req/min with no daily cap — comfortable for rehearsals
plus the live demo. Rules mode (`LLM_MODE=rules`) remains as an outage
fallback and the agent falls back automatically if the gateway is unreachable.

Alternatives if Groq fails: Cerebras (`https://api.cerebras.ai/v1`),
OpenRouter (`https://openrouter.ai/api/v1`, but only 50 req/day on a fresh
account). GitHub Models is retired — do not use.

---

## Model bake-off — 2026-09-13

The shared gateway came back with a strong model list. Tested on the **real**
evidence prompt, not a toy one:

| Model | Latency (real prompt) | Verdict | Notes |
| --- | --- | --- | --- |
| **Groq `openai/gpt-oss-120b`** | **~2–3s** | correct | **Chosen.** 30 req/min, dedicated |
| `gpt-5.6` (gateway) | **24s** | correct, best reasoning | Too slow for a 2-minute demo |
| `gpt-5.6-luna` | 16s | correct | Still too slow |
| `gpt-5.6-sol` | 34s | correct | Far too slow |
| `gpt-5.4`, `gpt-5.2` | — | **HTTP 429** | "All available accounts are currently rate-limited" |

`gpt-5.6` reasons noticeably better — it even flagged that the seeded GitHub
incident is labelled non-real and discounted it. But 24s of dead air kills the
demo, and the shared pool rate-limits unpredictably across accounts.

**Decision: Groq.** Fast, dedicated quota, good enough reasoning. Gateway
config kept commented in `.env` as `ALT_*` if a judge asks about model choice.

### Silent-fallback warning

When the gateway 429s, the agent falls back to the rules engine and still
returns a correct-looking answer — `llm.ms = 0`, `outTok = 0`. The console's
telemetry line shows **RULES FALLBACK**, which is the only on-screen signal.
Watch for it during rehearsal; never demo rules mode while claiming a model.

---

## Lemma agent context — wired 2026-09-13

`npm run lemma:policy` uploads `src/policy.md` to Lemma as agent context,
scoped to both `warrant.investigate` and `warrant.execute` (artifacts are
agent-scoped, so both need it).

The uploaded document wraps the raw policy with the framing Lemma needs to
judge a run:

- **What counts as a violation** — a refund proposed on charges that differ in
  amount/currency/service; the earlier charge refunded instead of the later; a
  charge id named that never appeared in the evidence; a success claim without
  a matching `stripe.verify_refund`; an execute trace with no approval for that
  plan hash; more than one `stripe.refund` for one plan id; a refusal that does
  not say what is missing.
- **What is NOT a violation** — a refusal on insufficient evidence; a `partial`
  outcome where the refund landed and a notification failed; a skipped step on
  a resumed run.

That second list matters as much as the first. Without it Lemma would flag the
refusal and the partial as failures, when both are the product working.

Lemma then generated its own **understanding document** (8,744 chars, v1) from
the traces plus this policy — visible under Artifacts in the dashboard. Re-run
the upload after editing `src/policy.md`.

Endpoint: `POST /projects/{id}/artifacts?agent_name=...`, multipart file.
Note: one upload attempt failed with a transient TLS `bad record mac`; a
straight retry succeeded.
