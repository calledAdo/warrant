# Live run: Zetaris + Nightshift (NVIDIA Nemotron)

Recorded on 27 October 2026 against the local Zetaris (`http://localhost:8888`) and Meterless Nightshift, with the Nemotron models pinned by name. Demo data only: the fictional Northwind customer on the SQLite stand-in for Stripe test mode. Investigation only; nothing was refunded.

The run uses a fixed clock (`WARRANT_NOW=2026-10-27T09:00:00Z`) and an empty precedent memory, so it can be replayed exactly offline.

## Record it

```bash
export WARRANT_NOW=2026-10-27T09:00:00Z WARRANT_PROVIDER=sqlite WARRANT_DB=/tmp/record.db WARRANT_HMEM_DIR=/tmp/hmem-record
npm run demo:prepare:sqlite                                         # seed the S1 customer at that clock
node --import=dotenv/config scripts/sync-evidence.mjs                # publish it to the warrant database Zetaris serves
WARRANT_USE_ZETARIS=true LLM_FALLBACK=off node --import=dotenv/config scripts/record-live-run.mjs
```

The sync published 2 charges, 1 customer and 1 incident. The agent's tools read them through Zetaris SQL as `wr_evidence` (role `warrant_evidence`, SELECT on `warrant_db.billing_history` and `warrant_db.engineering_incidents`).

## Replay it offline

```bash
npm run demo:replay
```

The replay runs the real agent graph, tools, duplicate policy and approval plan. Each Zetaris query and each Nemotron request must match the recording exactly, or the replay stops. It needs no `.env` and no network.

## Complaint

`billing@northwind.test`: "We were charged twice for our Pro plan."

## Model calls (every call receipted)

| Receipt | Routed model | Tool calls | Latency (ms) |
|---|---|---|---|
| rcpt_req_ji59c35q | nvidia/nemotron-3.5-lightning-30b-a3b | search_charges | 2880 |
| rcpt_req_w7jrz1qf | nvidia/nemotron-3.5-lightning-30b-a3b | search_charges | 820 |
| rcpt_req_a44erykn | nvidia/nemotron-3.5-lightning-30b-a3b | search_charges | 2033 |
| rcpt_req_wxqqdxx8 | nvidia/nemotron-3.5-lightning-30b-a3b | search_charges | 768 |
| rcpt_req_kafrrrrk | nvidia/nemotron-3.5-lightning-30b-a3b | search_charges × 8 (beyond the search budget) | 4416 |
| rcpt_req_zu7sdi3n | nvidia/nemotron-3-ultra-550b-a55b | submit_finding | 8913 |

Lightning ran the searches. Once the search budget of 8 was spent, only `submit_finding` was offered, and Ultra wrote the finding. Eight Zetaris queries were made, all as `warrant_evidence`, each returning the customer's two charges.

Full request and response bodies, and every SQL result: `data/cassettes/live-2026-10-27.jsonl` (no credentials or authorization headers).

## Outcome

- **Verdict:** duplicate. Refund `ch_demo_northwind_02` as a duplicate of `ch_demo_northwind_01`: two succeeded 49.00 USD charges with the identical description "Invoice SEP-2026 - Pro plan", created 43 seconds apart.
- **Incidents:** in this run the model did not search them. The duplicate rule accepts identical non-empty descriptions within 24 hours as corroboration, so the code check accepted the finding without an incident.
- **Result:** the run stopped at `awaiting_approval` with a 4,900-cent plan for `ch_demo_northwind_02`. Nothing was refunded; execution still requires a person's approval, bound to the plan hash.
