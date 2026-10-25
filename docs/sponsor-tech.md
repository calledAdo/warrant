# Warrant Remembers: Sponsor Technology Explanation

Warrant Remembers extends the Warrant refund-investigation agent with three sponsor technologies: **Zetaris** as the evidence layer, **Meterless H-MEM** as precedent memory, and **Nightshift + NVIDIA Nemotron** as the model provider.

## Zetaris: One Query Surface Over Fragmented Evidence

Warrant's evidence (billing history, engineering incidents, prior cases) is served through the user's local Zetaris at `http://localhost:8888/api/v1.0`.

### Sources Registered

| Source | Type | Tables | Purpose |
|--------|------|--------|---------|
| `warrant_db` | PostgreSQL JDBC | `billing_history`, `engineering_incidents`, `case_history` | Warrant's own evidence database in the existing `lotline-hospital-db-1` container |

### Access Control (Least Privilege)

Two read-only principals with table-specific grants:

| Principal | User | Grants |
|-----------|------|--------|
| `warrant_evidence` | `wr_evidence@local.test` | `SELECT` on `warrant_db.billing_history`, `warrant_db.engineering_incidents` |
| `warrant_history` | `wr_history@local.test` | `SELECT` on `warrant_db.case_history`; `INSERT` on `warrant_db.case_history` |

Principals authenticate via `/auth/login` (Basic auth) → receive ID token → use Bearer token for `/sql-editor/sqls/run`. No admin fallback exists.

### Agent Integration

The agent's read-only tools (`search_charges`, `search_incidents`) now query Zetaris via `ZetarisBackend` instead of calling Stripe/GitHub SDKs directly. The `ZetarisBackend`:
- Binds to a principal at construction
- Logs in automatically, refreshes on 401
- Validates every SQL query against the principal's allowlist (conservative grammar: single SELECT/DESCRIBE/INSERT, no comments, no comma joins, allowlisted functions only; INSERT only for history principal on case_history)
- Emits trace spans for every query (SQL, row count, latency)

**Writes that move money stay on the existing approval-bound Stripe path.** Zetaris is read-only for evidence gathering; case history writes use the history principal.

### Object Storage (SeaweedFS)

Bucket `lotline` with prefix `warrant/` is available for evidence snapshots (e.g., full Stripe exports, GitHub incident archives). Configured via S3 credentials in `.env`.

## Meterless H-MEM: Precedent Memory with Provenance

Warrant now remembers past refund decisions and approver corrections as precedent memories with full provenance and trust-ledger entries.

### Engine

Vendored from Meterless H-MEM reference (https://github.com/Meterless/Meterless, `engines/hmem/reference`, Apache-2.0) at commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`.

**Durability changes for Warrant:**
- `memoryStore.ts`: Append-only JSONL event log (`events.jsonl`), one line per mutating operation carrying the ordered store snapshot. Replay takes the last complete line; torn final line from crash mid-append is dropped. `logs()` exposes accepted replays for audits.
- `trustLedger.ts`: Same tail tolerance — torn final line in `ledger.jsonl` is skipped instead of throwing at load.
- Conformance suite (`conformance/runner.ts` + `conformance/vectors/`) is unmodified upstream; passes 13/13.

### Memory Model

Each precedent memory record contains:
- `content`: Natural language description (e.g., "Approver rejected refund proposal for case #42: a plan change plus a proration is not a duplicate")
- `source`: `approver_correction` or `past_decision`
- `provenance`: `{ origin, learnedAt, label, refs[] }` — mandatory
- `confidence`: 0.9–0.95 for high-confidence approver actions
- `layer`: `long_term` (durable)
- `tags`: `['precedent', 'refund', 'correction'/'decision', 'approve'/'decline', customerId]`
- Scoping: `chatId` (customer), `missionId` (case)
- Graph: `entities[]`, `relatedTo[]`, `supersedes`/`supersededBy`, `derivedFrom[]`

### Retrieval & Citation

On each new case, `load_customer` fetches relevant precedents via `hmem.query(complaintText, { threshold: 0.10, topN: 10, chatId: customerId })`, filters for precedent sources, and injects them into the agent's initial messages:

```
<relevant_precedents>
[1] Memory mem_abc123 (score: 0.87): Approver rejected refund proposal for case #42... — Shares keywords: plan, change, proration
[2] Memory mem_def456 (score: 0.72): Refund approved for case #15... — Semantic similarity
</relevant_precedents>
```

The agent is instructed: "If relevant precedents are provided above, consider them and cite any that apply in your finding."

### Conflict Detection

`detectConflicts()` flags precedents that contradict the current duplicate policy:
- "plan change + proration is not a duplicate" vs. policy that may allow it
- High-confidence approver corrections mentioning "duplicate"

Conflicts are surfaced in the trace for human review.

### Trust Ledger

Every memory mutation is audit-logged (create, feedback, conflict_detected, conflict_resolved). Feedback from the agent (`helpful`/`not_helpful`/`wrong`) adjusts confidence per H-MEM spec (+0.05 / -0.03 / -0.20 + `review` tag).

## Nightshift + NVIDIA Nemotron: Model Provider with Receipts

All Warrant model calls route through Nightshift's OpenAI-compatible API at `METERLESS_BASE_URL`.

### Two Lanes, Pinned by Name

| Lane | Model | Responsibility | `enable_thinking` |
|------|-------|----------------|-------------------|
| `fast` | `nvidia/nemotron-3.5-lightning-30b-a3b` | Extraction, hypotheses, mechanical tasks | `false` (2.4s / 188 tokens vs 14s / 1280) |
| `deep` | `nvidia/nemotron-3-ultra-550b-a55b` | Judgement, critique, senior review | `true` (large token budget) |

**Never uses** `meterless/fast` or `meterless/deep` routing modes — models are pinned by exact name.

### Compute Receipts

Every model call returns a compute receipt recorded in the trace:

```json
{
  "receiptId": "rct_...",
  "requestedModel": "nvidia/nemotron-3.5-lightning-30b-a3b",
  "routedModel": "nvidia/nemotron-3.5-lightning-30b-a3b",
  "provider": "nvidia",
  "latencyMs": 2400,
  "inputTokens": 188,
  "outputTokens": 89,
  "costUsd": 0.00012,
  "privacyPath": "local",
  "replayed": false
}
```

Receipts are emitted in trace spans (`llm` event) for every call, including cached/replayed calls and failed calls.

### Reliability

- **JSON extraction**: Strips Nemotron `query` reasoning blocks, finds last complete JSON object/array
- **Repair retry**: Invalid structured replies get one repair request with error context
- **Transport retry**: Transient 5xx/429 errors get one retry after 2s
- **Fallback**: If lane is down, caller gets `LlmUnavailable` and uses deterministic rules fallback (labeled in trace)

### Cassette Replay (Offline Mode)

`SAMPLE_MODE=true` enables cassette replay:
- LLM requests/responses recorded to `data/replays/<runDir>/llm.jsonl`
- SQL queries recorded to `data/replays/<runDir>/sql.jsonl`
- Replay matches by request hash; no provider contact needed for judges

## Safety Boundaries

| Boundary | Enforcement |
|----------|-------------|
| Money movement | Stripe refunds only via existing approval-bound path (plan hash, 15-min expiry, journal, idempotency) |
| Zetaris writes | None for evidence; case_history INSERT only via history principal on finalize/record_decline |
| Model calls | All via Nightshift; receipts prove which model answered |
| H-MEM durability | Append-only JSONL; crash-tolerant replay |
| Test isolation | Offline mode uses cassettes; no live credentials needed |

## Reproduce

```bash
# Live run (requires Zetaris, Nightshift, Postgres, SeaweedFS)
npm run engine:conformance  # H-MEM conformance (13/13)
npm test                    # 56 tests pass

# Offline sample mode (no live services)
SAMPLE_MODE=true npm test
```