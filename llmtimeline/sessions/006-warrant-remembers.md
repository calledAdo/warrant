# Session 006 — Warrant Remembers (Open Agent Hackathon 2026, Wildcard/Tinkerer)

Updated 2026-10-25 by opencode (GLM-5.3-Flash). Branch `open-agent-hackathon`, baseline `oah-baseline` (d1c9ef7). Brief: BRIEF-OAH.md. Extend Warrant with Zetaris (evidence layer), Meterless H-MEM (precedent memory — core), Nightshift + NVIDIA Nemotron (model provider). Scored on new work only. **No git commit/push; Claude reviews.**

## Plan (agreed)
1. **Env**: copy ZETARIS_*, METERLESS_*, S3_*, HOSPITAL_DB_* values from `../studycircle-project/open-agent-hackathon/lotline/.env` into warrant `.env` programmatically (never display). Update `.env.example` with placeholders.
2. **Zetaris evidence layer** (reads only; money movement stays on approval-bound Stripe SDK path):
   - Postgres DB `warrant` in existing container `lotline-hospital-db-1` (host 55433): `wr_case_history`, `wr_cases_prior`.
   - SeaweedFS bucket `lotline` prefix `warrant/`: Stripe test-mode snapshot + GitHub incident snapshot as JSON Lines (Lightning filestore tables).
   - Registration script `scripts/setup-zetaris.mjs` (admin REST, new objects only): DATASOURCE `wr_ops` + LIGHTNING DBs + SchemaStore none. Least-privilege read-only principals: `wr_evidence` (charges/incidents), `wr_history` (case history, registered tables). Prefix `wr_` everywhere.
   - Runtime `src/zetaris.js` mirrors Lotline's ZetarisBackend (login, /sql-editor/sqls/run, 401 retry, policy allowlist `src/evidence-policy.js`, Spark dialect). `src/agent-tools.js`: search_charges/search_incidents route through Zetaris when WARRANT_EVIDENCE=zetaris; shapes identical to Stripe/GitHub adapters. Executor Stripe reads stay direct (live truth for money checks).
3. **H-MEM precedent memory (core)**:
   - Vendor `engines/hmem` from Meterless repo (upstream commit 1742dec56a66e58eef9dda2d2b865823758ca8cd): src + unmodified conformance runner + vectors + LICENSE + NOTICE + UPSTREAM_COMMIT.
   - Durability: replace reference rewrite-file persistence with append-only JSONL + replay (world-model pattern) → NOTICE documents changes.
   - Build: `npm run engine:build` (tsc, rewriteRelativeImportExtensions → `engines/hmem/dist`, committed so tests run offline); `npm run engine:conformance` (tsx + HMEM_IMPL=src/index.ts, must pass).
   - `src/precedent.js`: Warrant adapter — approver corrections/decisions as memory records with provenance + trust ledger; retrieve before decide; inject precedents into agent prompt; code guard `applyPrecedentDowngrade`: trusted declined precedent pair-profile → downgrade to refusal citing memory ID (never upgrades; only strengthens).
   - Conflict detection: precedents that contradict policy.md get flagged via ledger `conflict_detected`.
4. **Nightshift/Nemotron**: rewrite `src/llm.js` — OpenAI-compatible `/chat/completions` with meterless headers; pin `nvidia/nemotron-3.5-lightning-30b-a3b` (fast) and `nvidia/nemotron-3-ultra-550b-a55b` (deep); never meterless/fast|deep; receipts recorded into trace + run.llm.receipts; `enable_thinking` toggle; extractJson + one repair retry; keep tool loop + 429 handling + rules fallback.
5. **Sample mode**: `src/cassette.js` (replay recorded llm + zetaris responses); `npm run demo:memory` offline demo (case 1 correction → case 2 changed proposal citing memory ID) for judges, no creds.
6. **Live run**: `npm run evidence:sync` (Stripe test snapshot + incidents → Postgres/S3), `npm run setup:zetaris`, `npm run live:run` real Zetaris + real Nightshift, recorded into `data/live-run/` + docs.
7. **Tests**: keep 47 existing; add memory.test, zetaris.test, receipts.test, memory-demo.test (guard downgrades + citation). All offline.
8. **Docs**: `docs/OAH-EXTENSION.md` (file-by-file baseline vs new), README top extension section + current product, `docs/sponsor-tech.md`, `.env.example`.
9. **REPORT-OAH.md** with real command outputs.

## Progress
- [x] Context read (README, src, tests, llmtimeline, Lotline patterns, hmem reference fetched)
- [ ] Steps 1-9
