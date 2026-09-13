# Production operations

## Process coordination

Every graph segment acquires a renewable lease in `run_leases`. This prevents
two Node processes sharing the same SQLite database from driving one run at the
same time. A crashed process releases ownership automatically after 60 seconds.
The operation journal remains the final protection around provider writes.

SQLite should be used only by processes on one host, with the database on a
local filesystem. A multi-host deployment must move runs, leases, checkpoints,
approvals and the operation journal together to a transactional shared database.

## Audit retention

Financial audit records are retained. Completed, declined and refused runs get
a durable `closedAt` timestamp. The archive command snapshots the run,
complaints, approval and journal operations into `audit_archives`, then removes
only its LangGraph checkpoints and pending checkpoint writes.

The command is a dry run by default:

```sh
npm run history:archive -- --days=90
npm run history:archive -- --days=90 --apply
```

Do not delete operation-journal or approval records as routine cleanup. Export
`audit_archives` and journal tables to immutable storage according to the
organization's financial and privacy retention requirements.

## Integrated S1 demo

The hackathon demo uses the live adapter path:

```sh
npm run demo:prepare
npm run start:demo
```

`demo:prepare` creates a test-mode Stripe customer with two matching charges
and a GitHub billing incident. The customer form starts a real model
investigation. The graph reads Stripe and GitHub, writes the GitHub case, posts
the Slack approval request, emits Lemma traces, and pauses. Admin approval then
executes and verifies the Stripe test refund before updating GitHub and Slack.
SQLite stores Warrant's complaint, run, checkpoints, approval and operation
journal in the isolated `data/warrant-live-demo.db`; it does not replace
sponsor applications in this mode.

The same setup is available as the backend function
`prepareIntegratedS1Demo()` and through `POST /api/demo/reset`.

## Offline S1 demo

The browser talks only to HTTP endpoints backed by the application functions
in `src/application.js` and `src/demo.js`. It never runs a fixture script or
receives provider credentials.

```sh
npm run demo:prepare:sqlite
npm run start:demo:sqlite
```

The SQLite provider stores the Northwind customer, two matching charges, the
billing incident, case file, team notification and eventual refund in
`WARRANT_DB`. Submitting the customer form starts investigation but leaves
both charges untouched. Only the admin approval function can record the exact
plan approval and resume the refund branch.

`POST /api/demo/reset` clears workflow and demo-provider state, then reseeds
only S1. This mode exists for automated tests and offline development.
