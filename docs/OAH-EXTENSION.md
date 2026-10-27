# Open Agent Hackathon 2026 — Warrant Remembers Extension

This document states exactly what existed at the `oah-baseline` tag (commit `d1c9ef7`, 13 Sep 2026) and what was added during the build window, file by file.

## Baseline (oah-baseline)

At `oah-baseline`, Warrant was a complete LangGraph agent that:
- Investigates "you charged me twice" complaints across Stripe (test mode), GitHub, and Slack
- Proposes approval-bound refunds or refuses with reasons
- Uses LangGraph with `interrupt()` for human review
- Has operation journal (SQLite) for idempotent external writes
- Traces to Lemma
- Has 47 offline tests passing

**Key baseline files:**
```
src/
  agent.js              - Core agent logic, sanitization, case body
  agent-rules.js        - Deterministic rules engine (fallback)
  agent-tools.js        - Tool loop (search_charges, search_incidents, submit_finding)
  adapters/
    github.js           - GitHub API adapter (search incidents, create case, comment)
    slack.js            - Slack API adapter (post proposal/refusal, update)
    stripe.js           - Stripe API adapter (search charges, refund, verify)
  application.js        - HTTP server entry points
  checkpointer.js       - LangGraph SQLite checkpoint
  complaints.js         - Complaint CRUD
  coordinator.js        - Run coordination
  duplicate-policy.js   - Duplicate detection rules
  graph.js              - LangGraph state machine
  journal.js            - Operation journal (idempotent writes)
  lemma-api.js          - Lemma API client
  lemma-issues.js       - Lemma hold/policy integration
  llm.js                - OpenAI-compatible LLM client
  outcomes.js           - Outcome types
  plan.js               - Refund plan building, hashing, expiry
  policy.md             - Agent system prompt
  retention.js          - Archive tooling
  run.js                - Run lifecycle (investigate, approve, execute, resume)
  runstate.js           - In-memory run state
  server.js             - Express server
  simulation.js         - Payment-first demo endpoint
  storage.js            - SQLite database
  trace.js              - Lemma tracing
test/
  backend.test.mjs      - Backend integration tests (25 tests)
  demo.test.mjs         - Demo tests (2 tests)
  helpers.mjs           - Test mocks and fixtures
  lemma.test.mjs        - Lemma integration tests (4 tests)
  operations.test.mjs   - Operations tests (4 tests)
  policy.test.mjs       - Policy tests
  restart-worker.mjs    - Restart test helper
```

## Extension Added (Warrant Remembers)

### 1. Zetaris Evidence Layer (Read-only)

**New files:**
```
src/
  evidence.js           - Evidence service: searchCharges, searchIncidents, searchCaseHistory, recordCase via Zetaris
  evidence-policy.js    - Principal-based access control (evidence, history principals); allows INSERT for history on case_history
  zetaris.js            - Zetaris REST SQL backend with principal authentication
scripts/
  setup-zetaris.mjs     - Creates Postgres tables, registers Zetaris datasource
  setup_zetaris_principals.sql - Least-privilege principals (wr_evidence, wr_history)
```

**Modified files:**
```
src/agent-tools.js      - Added USE_ZETARIS flag; runs use Zetaris when enabled
src/graph.js            - Passes runDir to runTool/rulesInvestigation; finalize/record_decline call recordCase
.env.example            - Added Zetaris, Nightshift, S3, Postgres placeholders
```

**Infrastructure (pre-existing, configured via scripts):**
- Postgres `warrant` database in `lotline-hospital-db-1` container
- Tables: `warrant.billing_history`, `warrant.engineering_incidents`, `warrant.case_history`
- Zetaris datasource `warrant_db` registered with JDBC
- Principals: `wr_evidence@local.test` (billing_history, engineering_incidents), `wr_history@local.test` (case_history)

**Safety:** Writes that move money (Stripe refunds) stay on the existing approval-bound path. Zetaris is read-only for evidence gathering; case history writes use the history principal.

### 2. Meterless H-MEM Precedent Memory

**New files:**
```
src/
  hmem-precedent.js     - PrecedentMemory class: recordCorrection, recordDecision, retrievePrecedents, detectConflicts, feedback, getAllPrecedents
engines/hmem/           - Vendored Meterless H-MEM reference (Apache-2.0)
  src/                  - Compiled from TypeScript (memoryStore, trustLedger, etc.)
  conformance/          - Unmodified upstream conformance suite (13/13 pass)
  LICENSE               - Apache-2.0
  NOTICE                - Warrant changes documented
  UPSTREAM_COMMIT       - 1742dec56a66e58eef9dda2d2b865823758ca8cd
  AGENTS.md             - H-MEM spec
  tsconfig.build.json   - Build config
```

**Modified files:**
```
src/graph.js            - load_customer fetches precedents; initialMessages includes them
                         - record_decline records approver correction in H-MEM
                         - finalize records approved decision in H-MEM
                         - both finalize and record_decline call recordCase for Zetaris case_history
src/agent-tools.js      - initialMessages accepts precedents and injects them
```

**Durability changes to vendored engine:**
- `memoryStore.ts`: Append-only JSONL event log (`events.jsonl`) replacing rewrite-whole-file `state.json`; crash-tolerant replay drops torn final line
- `trustLedger.ts`: Same tail tolerance for `ledger.jsonl`
- Conformance suite unmodified; passes 13/13

### 3. Nightshift + NVIDIA Nemotron Model Provider

**Modified files:**
```
src/llm.js              - Rewritten to use Nightshift OpenAI-compatible API
                          - Two lanes: fast (Nemotron 3.5 Lightning 30B), deep (Nemotron 3 Ultra 550B)
                          - Records compute receipts (receiptId, routedModel, provider, latency, tokens, cost)
                          - enable_thinking toggle via chat_template_kwargs
                          - JSON extraction with reasoning strip
                          - One repair retry for invalid JSON
                          - One transport retry for 5xx/429
                          - Legacy completeJSON, chatWithTools, ping preserved for compatibility
.env.example            - Added NIGHTSHIFT_FAST_MODE, NIGHTSHIFT_DEEP_MODE, METERLESS_* placeholders
```

**Models pinned by name:**
- `nvidia/nemotron-3.5-lightning-30b-a3b` (extraction/hypotheses)
- `nvidia/nemotron-3-ultra-550b-a55b` (judgement/critique)

### 4. Offline Sample Mode (Cassette Pattern)

**New files:**
```
src/cassette.js         - Record/replay LLM and SQL interactions for offline testing
                          - JSONL format per run directory
                          - loadRecordings for injection
                          - SAMPLE_MODE=true enables replay
```

### 5. Documentation

**New files:**
```
docs/
  OAH-EXTENSION.md      - This file
  sponsor-tech.md       - Sponsor technology explanation
```

**Modified files:**
```
README.md               - Added extension section at top; updated product description
```

### 6. Credentials & Configuration

**Modified files:**
```
.env.example            - All new placeholders added (never committed)
scripts/sync-env.mjs    - Copies values from Lotline .env silently (names only printed)
.env                    - Updated with Zetaris, Nightshift, S3, Postgres, principal credentials
```

**Credentials sourced from Lotline (never displayed):**
- Zetaris: REST URL, org ID, admin API key
- Nightshift: base URL, runtime token, app ID
- S3 (SeaweedFS): access key, secret key (bucket `lotline`, prefix `warrant/`)
- Postgres: user, password (database `warrant` in `lotline-hospital-db-1`)
- Zetaris principals: wr_evidence, wr_history (passwords generated locally)

**H-MEM:**
| Variable | Value |
| --- | --- |
| `WARRANT_HMEM_DIR` | `data/hmem` (precedent JSONL store) |

## Verification

All tests pass (56/56):
- Backend tests: 25
- Demo tests: 1
- Lemma tests: 4
- Operations tests: 4
- Policy tests: 4
- Injection tests: 2
- Restart tests: 6
- Extension tests: 8 (Zetaris, H-MEM, cassette, Nightshift, e2e memory flow)

H-MEM conformance: 13/13 pass

## Limitations

- Zetaris evidence layer requires running Zetaris, Postgres, SeaweedFS (offline mode uses cassettes)
- Nightshift requires running Nightshift with Nemotron models (offline mode uses cassettes)
- H-MEM durability uses JSONL files in `data/hmem/` (not a database)
- Case history IS now auto-synced to Zetaris case_history on finalize and record_decline
- Conflict detection is rule-based (keyword matching), not semantic
- SQLite storage and leases support one host; multi-host needs shared transactional DB
### Added on 27 October 2026 (review fixes)

| File | Change |
|---|---|
| `src/clock.js` | `WARRANT_NOW` fixes the clock for a recorded run, so it replays exactly |
| `scripts/record-live-run.mjs` | Records one live investigation (Zetaris + Nightshift) into `data/cassettes/` |
| `scripts/replay-live-run.mjs` | `npm run demo:replay`: replays that run offline with no credentials |
| `src/zetaris.js`, `src/llm.js`, `src/cassette.js` | Offline replay of Zetaris SQL results and Nemotron replies in `SAMPLE_MODE` |
| `src/agent-tools.js` | Zetaris rows map to the Stripe charge shape with UTC times and string booleans parsed correctly; precedents formatted one per line; one evidence service per run |
| `src/evidence.js` | Case outcomes written to the `warrant` PostgreSQL database with a parameterised query; Zetaris stays read-only |
| `src/graph.js` | Tools receive the run ID, so Zetaris queries are recorded under the run |
