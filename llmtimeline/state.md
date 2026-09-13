> llmtimeline · cross-agent work record. state.md is the live snapshot — rewrite it in place. sessions/ is append-only history — never edit past files. Any agent: read this file and the newest sessions/ entries before starting.

# Project State — updated 2026-09-13T21:08Z by codex (session 004)

## Goal
Ship **Warrant** for the Multi-App AI Agent Hackathon (Sun 2026-09-13, build 09:30–16:00 PT, judging 16:00): an agent that investigates "charged twice" complaints across Stripe, GitHub and Slack, refunds only after a human approves the exact plan, and is traced in Lemma and failure-tested with Arga. Done means: a working public repo, a README meeting the judges' checklist, a 2-minute demo video linked in the README, and a submitted entry.

## Tasks
- [x] Session 003 backend implementation: shared guards/rules mode, outcome reasons, journal coverage, Lemma visibility/holds, durable recovery. Authentication excluded; no Slack failure/Arga tests.
- [x] Safely batch-refund three-or-more matching debits; exact approval binding, per-charge journals, verification, partial recovery, and guarded 30-day evidence window.
- [x] Deep backend/agent architecture review after batch implementation; 36 offline tests pass, with follow-up risks documented.
- [x] Implement architecture-review fixes across refund execution, status semantics, evidence completeness, approval recovery, policy limits, audit output, and persistence performance.
- [x] Add production audit retention/archive tooling and shared-database run leases; 46 offline tests pass.
- [x] Upload revised Lemma policy and verify all four agent-scoped artifacts with Lemma.
- [x] Run S1 alone against fresh provider fixtures; exact later-charge refund and untouched legitimate charge verified.
- [x] Add function-based SQLite S1 demo backend and HTTP entry points; 47 offline tests and HTTP rehearsal pass. No frontend files changed.
- [x] Correct hackathon demo to use live Stripe/GitHub/Slack/Lemma integrations with SQLite only for Warrant state; prepare fresh S1 in an isolated demo database.
- [x] Add payment-first `/simulation` entry point to main with real Stripe test payment creation and persistent refund handoff.
- [x] Extensive implementation review (Codex session 002); findings and local verification in `docs/project-understanding.md`.
- [x] Verify every external dependency (Stripe refund + idempotency, GitHub, Slack, Arga Slack twin, Lemma ingest)
- [x] Build agent, journal, plan hashing, executor, customer page (/) and billing-team page (/admin)
- [x] Harden: complaint as untrusted input, duplicate rule enforced in code (S5 injection test)
- [x] Record declines in GitHub + Slack; fix Slack approval link
- [x] Migrate orchestration to LangGraph with interrupt() human review and checkpoint replay
- [x] Model-controlled evidence gathering: search_charges / search_incidents / submit_finding tool loop (S6)
- [x] Submission README; public repo https://github.com/calledAdo/warrant pushed (HEAD 33942d9)
- [x] A — Lemma trace fidelity: full message history, approval and pre-refund spans, dirty release metadata, updated policy script. Policy file has not been uploaded in this session.
- [x] B — Distinguish already refunded, partially refunded, not duplicate and inconclusive outcomes in backend, case and Slack content. Frontend intentionally unchanged per user direction.
- [x] C — Lemma flow-back backend: active issue polling, pagination, cached trace resolution, per-run occurrences and read-only API endpoints. No frontend panel or webhook added per user direction/current Lemma API scope.
- [x] D — Hold new proposals on active Lemma issues tagged `warrant-hold`; failed refreshes fail closed and held runs can resume after a fresh clear result.
- [!] Triage the 12 open Lemma issues (resolve fixed, dismiss stale/expected) — blocked on user approval: dismissed issues never reopen
- [ ] Restart server from warrant/ and rehearse the demo
- [ ] Record the 2-minute demo; add its link to README line 7; commit + push
- [ ] Submit the entry

## Summary
Session 003 completed the backend reliability and batch-refund work. Both model and rules findings use the same guard; refund-state outcomes are explicit; three-or-more matching charges create one batch that keeps the earliest charge and refunds every later charge. Approval binds the ordered items, amounts, currencies, kept charge and total. All charges are re-read before new money moves, each refund has its own journal/idempotency key, every result is verified, definitive failures can resume only remaining items, and uncertain results stop for reconciliation. Runs and LangGraph checkpoints persist across restarts. The revised Lemma contract is uploaded for all four Warrant agent identities. A provider-backed S1 run passed. The hackathon demo now uses the configured model plus live Stripe test mode, GitHub, Slack and Lemma; SQLite stores only Warrant complaints, runs, checkpoints, approvals and journal operations. The main branch now begins at a vanilla `/simulation` payment page that creates two Stripe test PaymentIntents, renders returned charge IDs, and always offers the refund handoff. Forty-seven offline tests pass. S4 is opt-in; no Slack failure or Arga run occurred.

Codex session 002 reviewed the implementation without changing application code or calling external services. Local syntax and S5A checks passed. `docs/project-understanding.md` records the architecture and confirmed gaps: unauthenticated operational routes, missing runtime test-key guard, active graph ignoring rules mode, fallback bypassing the shared guard, incomplete journal coverage, and misleading refusal copy. Prior descriptions below are historical and their stronger guarantees must be read with these corrections. User explicitly requested no Slack failure/Arga run.

Warrant is built, tested and public. A customer files a complaint by email + free text on `/`; Warrant matches the Stripe customer by email. A LangGraph graph runs `load_customer → agent ⇄ tools → decide → write_case`, where the model (gpt-5.6-luna via an OpenAI-compatible gateway) pages through that customer's charges and searches GitHub incidents with read-only tools that code scopes (customer locked, ≤8 searches, 10/page, 365 days), then calls `submit_finding`; `decide` re-checks the duplicate rule in code against only what the tools returned. A refusal posts to Slack and closes; a duplicate posts a proposal and pauses at `human_review` (`interrupt()`). On `/admin` a person approves or declines the exact plan (plan-hash bound, 15-min expiry). Approve runs verify_charge → refund (journalled, full refunds only) → verify_refund → update_case ∥ update_slack → finalize; decline records reason in GitHub + Slack. An operation journal (SQLite) makes every external write happen once, including across LangGraph resume and checkpoint replay.

Tests passing on gpt-5.6-luna: S1 refund, S2 refusal, S3 checkpoint replay (no double refund), S4 Slack 429 after refund then resume (local twin stand-in; real Arga twin verified pre-LangGraph), S5 prompt injection, S6 duplicate buried under 22 newer charges (flat last-20 fetch misses it; agent pages back 3×), decline path.

Latest review found Lemma integration gaps. Checked against Lemma's API: Lemma has **12 open issues** on the project that nothing surfaces. Two are real: (1) cases titled "no duplicate found" when a duplicate existed but was already refunded; (2) execute traces show no approval, so Lemma flagged "refund without authorization". "verify_refund repeated" (×6) is expected replay/resume behaviour. New trace shape confirmed arriving (agent-turn generations, search tools, duplicate-rule-check, graph-state). Tasks A–D above are the proposed response; none started.

## Next
1. Review the completed hardening and operations work; `npm test` currently passes 47/47.
2. For multi-host production, move leases, runs, checkpoints, approvals and journal operations together to a transactional shared database.
3. Do not triage/dismiss the current Lemma issues without explicit user authorization.
4. Frontend integration for new outcome/hold/issue fields is deferred by user direction.
5. Before recording: `npm run fixtures:demo && npm start`, then open `/` and `/admin`. Do not run S4/Arga unless explicitly requested.
6. For the integrated S1 demo, open `/simulation`, click Pay, then use the persistent refund handoff. The payment endpoint creates fresh Stripe test data; no reset is required for the first take.

## Notes
- **Run from `~/hacks/warrant`.** `~/hacks/lemma2` is a frozen backup. Earlier research-phase timelines by Codex live in `~/hacks/llmtimeline` and `~/hacks/lemma-pro/llmtimeline`; they predate the build and recommend other concepts (Raincheck/Takeback) — historical only.
- **Secrets:** all credentials are in `warrant/.env` (gitignored). The repo is public; never paste keys into this timeline, README or commits. Keys pasted in chat during setup (Stripe test, GitHub PAT, Slack bot, Lemma, LLM keys) should be rotated after the event.
- **Model:** gpt-5.6-luna on the OpenAI-compatible gateway (~2–3 s/turn). Groq `gpt-oss-120b` is a commented ALT in `.env`: its free tier (8k tokens/min) can't carry the tool loop, it rejects null tool args, and gpt-oss sometimes emits its verdict under a fake tool name — handled by `recoverToolCall()` in `src/agent-tools.js`. `LLM_MODE=rules` = deterministic outage fallback (admin shows "Rules fallback").
- **Arga:** Free plan, 5 of 10 runs left, 1 twin/run, 10-min TTL. S4 uses `verify/mock-slack.mjs` for routine testing; save real twins for recording. Seeded twin limit allows 1 `chat.update`/window, so tests "arm" it with a decoy update.
- **Lemma:** manual tracing, one trace per graph segment (investigate/execute/decline/replay) linked by threadId `case-<customer>`. Lemma's own `langGraph()` handler deliberately not used (opens its own trace, only captures LangChain components). Trace indexing ~30–40 s; issue detection observed ~30 min after a trace. `fetchIngestStatus()` reports "enqueued" forever — resolve otel id via `/traces/dashboard`.
- **Stripe finding:** partial refunds with different idempotency keys stack silently and `refunded` stays false → full refunds only, assert `amount_refunded`.
- **Known gaps:** Email isn't verified before filing. Frontend does not yet render the new backend outcome/hold/Lemma fields. Ambiguous writes require manual provider inspection and `npm run journal:reconcile`. SQLite recovery targets a single server process. S6 takes ~20–25 s.
- **Review remediation:** Stripe receives the exact amount and response validation occurs before journal success. Financial and notification partial states are distinct. Batch history must cross the relevant older boundary; model batches are anchored to selected IDs. Batch audit text, reapproval, incident relevance, count/value limits, full plan hashes, cross-run journal references, request limits and indexed checkpoint queries are implemented and covered by tests. Checkpoint archival is dry-run-first and retains financial audit history; an organization must still choose its retention duration and immutable archive destination before production use.
- **Lemma policy:** On 2026-09-13 the 6,275-character behavior contract was uploaded to project `bbee7267-baa7-4837-ab80-39f87ba93c61` for all four Warrant agent identities and verified through the artifact listing.
- **Demo providers:** `start:demo` forces `WARRANT_PROVIDER=live`, so sponsor applications remain in the judged path. `WARRANT_PROVIDER=sqlite` is an explicit offline test option only. Integrated demo state is isolated in `data/warrant-live-demo.db`.
- **Payment-first demo:** `POST /api/simulation/payment` creates the two real Stripe test charges. `public/simulation.html` links to the existing complaint page with the S1 email and report prefilled; the CTA is visible from the beginning and is not conditional on duplicate detection.
- **Fixtures:** `npm run fixtures:demo` (~30 s) seeds Northwind (S1), Harbor (S2), Lakeside (S6); rerun between demo takes because an approved refund consumes the fixture.
