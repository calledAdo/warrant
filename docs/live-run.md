# Live run: Zetaris + Nightshift (NVIDIA Nemotron)

Run on 25 Oct 2026 against the local Zetaris (`http://localhost:8888`) and Meterless Nightshift, with the Nemotron models pinned by name. Demo data only (sqlite provider, fictional customer); investigation only, no refund executed.

## Commands

```bash
npm run demo:prepare:sqlite
WARRANT_PROVIDER=sqlite WARRANT_DB=data/warrant-live-nemotron.db node --import=dotenv/config scripts/sync-evidence.mjs
WARRANT_USE_ZETARIS=true WARRANT_PROVIDER=sqlite WARRANT_DB=data/warrant-live-nemotron.db LLM_FALLBACK=off \
  node --import=dotenv/config <script calling submitRefundRequest + investigateRefundRequest>
```

The sync published 2 charges, 1 customer and 1 incident to `s3a://lotline/warrant/` and the `warrant` Postgres database. The agent's `search_charges` and `search_incidents` tools read them through Zetaris SQL (`warrant_db.billing_history`, `warrant_db.engineering_incidents`) as the `wr_evidence` principal.

## Complaint

`billing@northwind.test`: "You charged us twice for our March invoice. Please refund the duplicate."

## Model calls (every call receipted)

| Receipt | Routed model | Tool calls | Latency (ms) |
|---|---|---|---|
| rcpt_req_ymb4gkiz | nvidia/nemotron-3.5-lightning-30b-a3b | search_charges, search_incidents | 1249 |
| rcpt_req_8xyfupaq | nvidia/nemotron-3.5-lightning-30b-a3b | search_charges, search_incidents | 6799 |
| rcpt_req_i9otfjkt | nvidia/nemotron-3.5-lightning-30b-a3b | search_charges, search_incidents | 1315 |
| rcpt_req_8rsehedn | nvidia/nemotron-3.5-lightning-30b-a3b | search_charges, search_incidents | 1237 |
| rcpt_req_zsk73pn3 | nvidia/nemotron-3-ultra-550b-a55b | submit_finding | 4594 |

Lightning runs the search turns. Once the search budget is spent, only `submit_finding` is offered and Ultra writes the finding.

Full request and response bodies: `data/cassettes/live-2026-10-25.jsonl` (no secrets).

## Outcome

- Verdict `duplicate`: refund `ch_demo_northwind_02` as a duplicate of `ch_demo_northwind_01` (49.00 USD, same invoice description), corroborated by GitHub incident #1 "Billing retry duplicated successful payments".
- The model noted in `uncertainty` that the customer said "March" while the evidence shows September charges.
- The code check accepted the finding and the run stopped at `awaiting_approval` with a 4,900-cent plan for `ch_demo_northwind_02`. Nothing was refunded; execution still requires a human approval bound to the plan hash.
