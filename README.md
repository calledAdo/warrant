# Warrant

An agent that has to earn the right to move money — and refuses when the evidence doesn't support it.

Investigates a reported duplicate charge across **Stripe**, **GitHub** and **Slack**: assembles cited evidence, writes an investigation case, requests approval for one exact correction, and executes only that. Traced with Lemma; failure-tested against an Arga twin.

**Status:** pre-build. This repo currently contains only the verification gates that decide whether the plan is viable.

```bash
cp .env.example .env    # fill in — see PLAN.md
npm install
npm run verify
```

Read [PLAN.md](./PLAN.md) for the verified gate results, then [BUILD.md](./BUILD.md) for what Sunday builds.

Stripe runs in **test mode only** — the scripts refuse any key not starting with `sk_test_`.
