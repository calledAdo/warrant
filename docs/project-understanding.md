# Warrant — implementation map

Reviewed by Codex, 2026-09-13. This describes the checked-out implementation, not just intended behavior. Application code was not changed. No external service calls, Slack failure scenarios, or Arga runs were performed.

## Product and architecture

Warrant investigates duplicate-charge complaints for a SaaS billing team. It gathers Stripe billing evidence and GitHub incidents, proposes one full refund or refuses, then waits for a human decision before moving money. GitHub is the audit case, Slack is the team notification surface, and Lemma receives execution traces.

The application is JavaScript ES modules on plain Node HTTP, with no frontend framework or build step. It uses LangGraph for orchestration, built-in node:sqlite for persistence, the Stripe SDK, fetch for Slack/GitHub/model calls, and the Lemma tracing SDK. The pages use vanilla JavaScript, inline SVG, shared CSS, and externally hosted GSAP/fonts.

| Area | Entry points and responsibility |
| --- | --- |
| HTTP | `src/server.js`: pages, complaint submission/listing, run snapshots, SSE, approve/decline/resume, journal and trace links, demo reset |
| Workflow API | `src/run.js`: investigate, approve, execute, decline, resume, checkpoint replay; wraps segments in traces |
| Execution | `src/graph.js`: StateGraph nodes, reducers, tool loop, approval interrupt, refund and follow-ups |
| Model tools | `src/agent-tools.js`: schemas, customer-scoped searches, finding parser, malformed-call recovery, fallback searches |
| Policy | `src/policy.md`, `src/agent.js`: untrusted report sanitization and deterministic duplicate guard; agent.js also retains the older single-prompt path |
| Fallback | `src/agent-rules.js`: deterministic pair selection |
| Approval | `src/plan.js`: material-field hash and 15-minute expiry |
| Persistence | `src/journal.js`: approvals and operation records; `src/complaints.js`: complaint rows and customer projections |
| Live state | `src/runstate.js`: in-memory run map, progress events and timing snapshots |
| Integrations | `src/adapters/{stripe,github,slack}.js`, `src/llm.js`, `src/trace.js` |
| Frontend | `public/index.html`, `public/admin.html`, `public/app.css` |

## End-to-end flow

1. Customer submits email and complaint. The server matches one Stripe customer by email, persists a complaint, creates an in-memory run, and starts investigation asynchronously.
2. `load_customer` initializes customer-scoped evidence and messages. `agent` calls the model; `tools` executes read-only searches and appends responses. The loop permits eight tool searches, ten charges per page, and a 365-day charge lookback. Incident searches scan at most three pages of 100 GitHub issues; the model sees at most eight incidents per call.
3. `submit_finding` ends the loop. `decide` checks proposed charge IDs and duplicate criteria against retrieved records. Provider failures take a separate deterministic fallback path, searching at most fifty charges and thirty days of incidents.
4. `write_case` creates a GitHub issue. A refusal posts to Slack and ends. A duplicate produces a deterministic refund plan, posts a Slack proposal, and pauses at LangGraph `interrupt()`.
5. Approval is stored in SQLite against the plan hash. Execution resumes the graph, checks approval/hash/expiry and current Stripe amount/currency, issues a full refund using a journal-derived idempotency key, and reads Stripe back to compare `amount_refunded` with the plan amount.
6. GitHub and Slack follow-ups execute in parallel, then finalize. Decline has separate parallel journalled follow-ups. A failed follow-up after verified refund produces `partial`; resume continues checkpointed work. Replay starts from the checkpoint immediately before refund.

Customer tracking polls every 1.5 seconds and renders plain-language stages. The admin queue polls every two seconds; selected-run progress streams through SSE. Admin panels show the decision, evidence, model explanation, search trail, operation journal, and trace links. The SVG graph is a simplified presentation, not the literal LangGraph topology.

## Persistence and guarantees

`data/warrant.db` contains complaints, approvals, and operations. LangGraph checkpoints and the UI run map are in memory. Restarting loses all run execution state, including completed-run projections: persisted complaints whose runs are missing appear received again.

Plan hashes include customer, refund charge, kept charge, amount, currency, and action. They exclude case ID, evidence, timestamps, and run ID. Equivalent plans across different cases therefore share approval and operation keys. Expiry is measured from plan creation, not approval time.

The journal records intent before a write, skips recorded successes, and stops on unresolved intended writes. Thrown errors are marked failed and may be retried. This is useful replay protection but is not general exactly-once delivery: a remote write that succeeds before a network error can be retried, particularly for GitHub comments without provider idempotency.

## Confirmed gaps and implications

- **No authentication or authorization layer.** Admin, approval, complaint listing, run data, customer charge lookup, resume and reset routes are exposed by the server. Approver identity is supplied by the caller; the UI hardcodes `ops@warrant.test`. Email matching is not verification. The intended human gate is a workflow gate, not an authenticated staff boundary.
- **Runtime Stripe adapter does not reject live keys.** Fixture and Stripe verification scripts check `sk_test_`; the server's adapter does not. Test-mode operation depends on configuration.
- **Rules mode is not wired into the active graph.** `graph.js` always calls `chatWithTools`; it never checks `LLM_MODE` or `LLM_FALLBACK`. Those controls exist in the older `assembleCase` path. The config badge can therefore disagree with actual execution.
- **Fallback bypasses the shared guard.** The rules engine filters `refunded` but not positive `amount_refunded`. A local reproduction returned a duplicate for a partially refunded candidate which `enforceDuplicateRule` rejects. Its first matching amount/time pair can also hide a later valid pair if initial corroboration fails.
- **Duplicate evidence checks are narrower than the documentation.** The guard validates the target and kept charge IDs but does not validate every evidence citation/detail. Empty descriptions count as equal. Any returned incident within 24 hours qualifies without checking its relevance to the charge. The kept charge's refund state is not checked. Equal timestamps do not establish which charge was later.
- **Execution revalidation is limited.** The pre-refund node checks amount/currency but does not refresh and re-check both charges, corroboration, or partial-refund state. Resume from a later checkpoint does not necessarily revisit approval expiry.
- **Not every external write is journalled.** GitHub case creation and initial Slack proposal/refusal posts call adapters directly. Refunds and post-decision follow-ups use the journal. README/UI claims that every write is journalled overstate coverage.
- **Repeated plans can suppress another case's follow-up.** Since follow-up operation keys use the material plan hash and step, identical plans on distinct cases can share journal results. This follows from key construction; it was not exercised against providers.
- **Refusal copy overstates certainty.** All refusals become “no duplicate found”; any truthy missing-evidence text becomes “different services” on the customer page, including already-refunded or inconclusive cases. Failed searches can consequently be presented as definitive negative findings.
- **Frontend error recovery is incomplete.** Customer submission and admin decisions lack robust network/error-response handling. Decline UI claims notifications were recorded even when follow-ups remain pending. Customer copy references an email reply flow which is not implemented.
- **Lemma is outbound-only.** There is no issue polling, webhook, badge or hold integration. Generation traces record message count rather than full input history; approval checks have no dedicated span; release metadata uses the last commit without a dirty suffix. Trace link resolution searches only the latest 25 traces and can miss older runs.

## Implementation update — session 003

The review findings above describe the state before session 003. The backend now uses the shared duplicate guard for model and rules findings; distinguishes already-refunded, partially-refunded, negative and inconclusive outcomes; journals initial GitHub/Slack writes; stores runs and LangGraph checkpoints in SQLite; and rechecks approval plus both charges before a new refund call. Lemma generation traces contain full message history, approval checks are explicit spans, dirty worktrees are identified in release metadata, active issues and per-trace occurrences are exposed through backend APIs, and a person-applied `warrant-hold` pauses new proposals. Frontend files were intentionally left unchanged.

Ambiguous provider writes now stay `uncertain` until an operator inspects the provider and uses `scripts/reconcile-operation.mjs`. This avoids blind retries but still requires an operational decision. Historical issue counts were not changed or triaged.

Session 003 also added deterministic multiple-debit handling. When at least three succeeded, unrefunded charges share amount and currency and pass the corroboration rule, the backend emits `multiple_duplicates`. It records the earliest charge as legitimate and builds one batch plan for every later charge. The normal window is 24 hours; extending it to 30 days requires a shared strong billing identifier plus explicit incident start/end coverage. Approval hashes the kept charge, ordered refund items, amounts, currencies, and total. Execution revalidates all charges before moving money and journals each full refund independently.

The post-batch hardening pass sends Stripe the exact approved amount and validates its response before journal success; distinguishes financial partial, notification partial, failed and uncertain execution; supports fresh approval for unfinished expired work; refuses batches until older charge pages are exhausted; anchors model batches to the model-selected charges; requires billing-relevant incident evidence; limits automatic batches to 10 refunds and $1,000; renders batch audit cases explicitly; uses full SHA-256 plan IDs for new plans while retaining legacy verification; records cross-run journal references; bounds HTTP request bodies; and performs checkpoint counts/filtering in SQLite.

## Verification and operational notes

Performed locally:

- Syntax checks passed for all 28 JS/MJS source, verification, fixture and script files, plus both inline browser scripts.
- `LLM_MODE=rules node verify/injection.mjs`: eight guard scenarios and one sanitization check passed; live injection was explicitly skipped.
- Pure-function assertions confirmed material hash changes, shared hashes across cases, expiry, fallback/guard disagreement on partial refunds, and unvalidated evidence citations.

Read, but did not execute, the provider and end-to-end scripts. `npm run verify` writes to providers. `verify/e2e.mjs` resets the journal, performs real test-mode refunds, creates cases/messages and fixtures, and runs S4 whenever `SLACK_API_URL` is set. It has no explicit skip-S4 option. S6 currently asserts proposal and target selection, not refund execution; S4 only logs absent expected Slack failure, so it can pass without exercising that fault. Decline coverage is described historically but is not present in the checked-in e2e runner.

Run from the repo root because SQLite and fixture paths are relative to cwd. Node 26.8.1 is installed locally. No server, browser session, fixture generation, provider verification, Slack failure simulation or Arga resource was started for this review. Prior README test results remain historical, not newly certified.

## Suggested order for subsequent work

1. Align the documented guarantees with implementation; unify fallback and model-path guards and honor explicit rules mode.
2. Address misleading refusal states and runtime test-key enforcement; add authentication before exposing operational routes.
3. Fix journal scope and ambiguous-write recovery, persist graph/run state, and tighten pre-refund checks.
4. Continue the existing Lemma A–D work with local checks first; keep issue triage separate from read-only monitoring.
5. Rehearse and record only after choosing which provider-writing scenarios to run. The user's current constraint is to skip Slack failure/Arga runs.
