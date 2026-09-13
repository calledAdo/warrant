> llmtimeline · cross-agent work record. state.md is the live snapshot — rewrite it in place. sessions/ is append-only history — never edit past files. Any agent: read this file and the newest sessions/ entries before starting.

# Project State — updated 2026-09-13T18:42Z by opus (session 001)

## Goal
Ship **Warrant** for the Multi-App AI Agent Hackathon (Sun 2026-09-13, build 09:30–16:00 PT, judging 16:00): an agent that investigates "charged twice" complaints across Stripe, GitHub and Slack, refunds only after a human approves the exact plan, and is traced in Lemma and failure-tested with Arga. Done means: a working public repo, a README meeting the judges' checklist, a 2-minute demo video linked in the README, and a submitted entry.

## Tasks
- [x] Verify every external dependency (Stripe refund + idempotency, GitHub, Slack, Arga Slack twin, Lemma ingest)
- [x] Build agent, journal, plan hashing, executor, customer page (/) and billing-team page (/admin)
- [x] Harden: complaint as untrusted input, duplicate rule enforced in code (S5 injection test)
- [x] Record declines in GitHub + Slack; fix Slack approval link
- [x] Migrate orchestration to LangGraph with interrupt() human review and checkpoint replay
- [x] Model-controlled evidence gathering: search_charges / search_incidents / submit_finding tool loop (S6)
- [x] Submission README; public repo https://github.com/calledAdo/warrant pushed (HEAD 33942d9)
- [ ] A — Lemma trace fidelity: full prompt per agent turn, approval-check span in execute, dirty-aware release tag, policy note that resume/replay re-verification is expected (proposed; awaiting user go-ahead)
- [ ] B — Fix the bug Lemma caught: distinguish "already refunded" from "not a duplicate" in case title, Slack and customer page (proposed; awaiting go-ahead)
- [ ] C — Lemma → Warrant flow-back: pull issues + per-trace occurrences, "Lemma flagged" on /admin, signed webhook endpoint (proposed; awaiting go-ahead)
- [ ] D — Hold new proposals on Lemma issues a human tagged `warrant-hold` (proposed; awaiting go-ahead)
- [!] Triage the 12 open Lemma issues (resolve fixed, dismiss stale/expected) — blocked on user approval: dismissed issues never reopen
- [ ] Restart server from warrant/ and rehearse the demo
- [ ] Record the 2-minute demo; add its link to README line 7; commit + push
- [ ] Submit the entry

## Summary
Warrant is built, tested and public. A customer files a complaint by email + free text on `/`; Warrant matches the Stripe customer by email. A LangGraph graph runs `load_customer → agent ⇄ tools → decide → write_case`, where the model (gpt-5.6-luna via an OpenAI-compatible gateway) pages through that customer's charges and searches GitHub incidents with read-only tools that code scopes (customer locked, ≤8 searches, 10/page, 365 days), then calls `submit_finding`; `decide` re-checks the duplicate rule in code against only what the tools returned. A refusal posts to Slack and closes; a duplicate posts a proposal and pauses at `human_review` (`interrupt()`). On `/admin` a person approves or declines the exact plan (plan-hash bound, 15-min expiry). Approve runs verify_charge → refund (journalled, full refunds only) → verify_refund → update_case ∥ update_slack → finalize; decline records reason in GitHub + Slack. An operation journal (SQLite) makes every external write happen once, including across LangGraph resume and checkpoint replay.

Tests passing on gpt-5.6-luna: S1 refund, S2 refusal, S3 checkpoint replay (no double refund), S4 Slack 429 after refund then resume (local twin stand-in; real Arga twin verified pre-LangGraph), S5 prompt injection, S6 duplicate buried under 22 newer charges (flat last-20 fetch misses it; agent pages back 3×), decline path.

Latest review found Lemma integration gaps. Checked against Lemma's API: Lemma has **12 open issues** on the project that nothing surfaces. Two are real: (1) cases titled "no duplicate found" when a duplicate existed but was already refunded; (2) execute traces show no approval, so Lemma flagged "refund without authorization". "verify_refund repeated" (×6) is expected replay/resume behaviour. New trace shape confirmed arriving (agent-turn generations, search tools, duplicate-rule-check, graph-state). Tasks A–D above are the proposed response; none started.

## Next
1. Get the user's go-ahead on tasks A → B → C → D (proposed in this order) and on Lemma issue triage.
2. If A: in `src/graph.js` `agent()`, pass the full `messages` array as `recordGeneration` input; in `verify_charge()` add `trace.recordSpan({ name: 'approval-check', output: { approver, approved_at, plan_hash_match, expires_at } })`; in `src/trace.js` append `-dirty` to the release when `git status --porcelain` is non-empty; add a "re-verification on resume/replay is expected" bullet under "What is NOT a violation" in `scripts/upload-policy.mjs`, then `npm run lemma:policy`.
3. If B: in `src/agent-tools.js` / `src/agent.js` `enforceDuplicateRule`, return a distinct reason for already-refunded pairs; branch case title in `write_case()` (`src/graph.js`), the Slack refusal text (`src/adapters/slack.js postRefusal`) and `customerView()` in `src/complaints.js`.
4. If C: new `src/lemma-issues.js` polling `GET https://api.uselemma.ai/issues?project_id=…&status=open` and `GET /traces/{internal_id}/issue_occurrences` (resolve otel→internal id via `dashboardUrlFor` in `src/trace.js`); expose `/api/lemma/issues`; render badges + panel in `public/admin.html`; add `POST /webhooks/lemma` verifying `X-Lemma-Signature` (HMAC-SHA256) + `X-Lemma-Timestamp` (5-min tolerance).
5. Before recording: `cd ~/hacks/warrant && npm run fixtures:demo && npm start`, open `/` and `/admin`.

## Notes
- **Run from `~/hacks/warrant`.** `~/hacks/lemma2` is a frozen backup. Earlier research-phase timelines by Codex live in `~/hacks/llmtimeline` and `~/hacks/lemma-pro/llmtimeline`; they predate the build and recommend other concepts (Raincheck/Takeback) — historical only.
- **Secrets:** all credentials are in `warrant/.env` (gitignored). The repo is public; never paste keys into this timeline, README or commits. Keys pasted in chat during setup (Stripe test, GitHub PAT, Slack bot, Lemma, LLM keys) should be rotated after the event.
- **Model:** gpt-5.6-luna on the OpenAI-compatible gateway (~2–3 s/turn). Groq `gpt-oss-120b` is a commented ALT in `.env`: its free tier (8k tokens/min) can't carry the tool loop, it rejects null tool args, and gpt-oss sometimes emits its verdict under a fake tool name — handled by `recoverToolCall()` in `src/agent-tools.js`. `LLM_MODE=rules` = deterministic outage fallback (admin shows "Rules fallback").
- **Arga:** Free plan, 5 of 10 runs left, 1 twin/run, 10-min TTL. S4 uses `verify/mock-slack.mjs` for routine testing; save real twins for recording. Seeded twin limit allows 1 `chat.update`/window, so tests "arm" it with a decoy update.
- **Lemma:** manual tracing, one trace per graph segment (investigate/execute/decline/replay) linked by threadId `case-<customer>`. Lemma's own `langGraph()` handler deliberately not used (opens its own trace, only captures LangChain components). Trace indexing ~30–40 s; issue detection observed ~30 min after a trace. `fetchIngestStatus()` reports "enqueued" forever — resolve otel id via `/traces/dashboard`.
- **Stripe finding:** partial refunds with different idempotency keys stack silently and `refunded` stays false → full refunds only, assert `amount_refunded`.
- **Known gaps:** LangGraph `MemorySaver` is in-memory (server restart loses paused approvals; journal persists). Email isn't verified before filing. Release tag reflects last commit, not uncommitted work. S6 takes ~20–25 s. One unreproducible S1 refusal (likely the "already refunded" case Lemma flagged).
- **Fixtures:** `npm run fixtures:demo` (~30 s) seeds Northwind (S1), Harbor (S2), Lakeside (S6); rerun between demo takes because an approved refund consumes the fixture.
