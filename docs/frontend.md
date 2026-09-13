# Frontend development and verification

Warrant's frontend is a React/TypeScript application with a Vite production build. The existing Node API and LangGraph workflow remain the backend.

## Run

```bash
npm ci
npm run dev
```

Development UI: `http://localhost:5173` and `/admin`. Vite proxies `/api` to the Node server on port 3000. Set `PORT` to change the API port. The development command starts and stops both child processes together.

For the production build served by Node:

```bash
npm run build
npm start
```

Open `http://localhost:3000` or `http://localhost:3000/admin`. Fonts, icons, CSS and JavaScript are bundled locally. Content-hashed assets receive immutable caching; HTML is revalidated. Serving an unbuilt frontend returns a useful 503 rather than exposing source files. The asset handler sets content types, prevents arbitrary file access, supports HEAD, and applies a same-origin content security policy.

## Structure

| Path | Purpose |
| --- | --- |
| `web/customer.tsx` | Report submission and tracking |
| `web/admin.tsx` | Queue, search, filtering, responsive workspace |
| `web/case-detail.tsx` | Evidence, assessment, decision, audit and references |
| `web/hooks` | Abortable polling and live run subscriptions |
| `components/ui` | Shared controls and the adapted 21st.dev components |
| `components/icons.tsx` | Free Hugeicons wrapper and selected imports |
| `lib/api.ts`, `lib/types.ts` | Error handling and backend contracts |
| `web/styles.css`, `DESIGN.md` | Visual system and its sources |
| `src/frontend.js` | Production asset serving |

The `/` shortcut focuses queue search. The case section tabs support arrow keys, Home and End. Dialogs support Escape, focus trapping and return focus to the invoking control. Reduced-motion preferences disable continuous graph animation.

## Checks

```bash
npm run build
npm run test:frontend-server
npx playwright install chromium
npm run test:ui
```

With an installed Google Chrome, `PLAYWRIGHT_CHANNEL=chrome npm run test:ui` avoids downloading a browser. Set `PLAYWRIGHT_OUTPUT_DIR` for an isolated artifact directory.

Browser tests run on port 4173 against `tests/mock-server.mjs`. They **never load provider credentials, call Stripe, write GitHub issues, or send Slack messages**. The mock server is test infrastructure and is not served by the app. Its Northwind/Harbor records are synthetic fixtures, not production activity.

Coverage includes report validation and network recovery; tracking reloads and invalid references; same-status case switching; plan-bound approval and rejection recovery; required decline reasons; approval expiry while the dialog is open; partial-failure resume; missing runs; queue outages; responsive layouts; automated accessibility checks; and screenshots. The separate Node test covers production routes, caching, content types, HEAD and path/method restrictions.

The automated accessibility scan is complemented by keyboard and responsive browser checks; it does not certify every assistive-technology combination.

Verified September 13, 2026: TypeScript and production build passed, the production-serving test passed, and all 12 Chrome browser tests passed. Desktop customer and workspace scans reported zero WCAG A/AA violations. Responsive checks covered 375 px and 320 px widths. Both actual preview routes on port 3000 returned HTTP 200 with no browser runtime errors. External provider integration tests were not run during this frontend change.

## Deployment boundary

This frontend does not add authentication to the existing API. `/admin` and the administrative API routes still require a server-side authentication and authorization layer before exposure to untrusted users. The reviewer email is an audit attribution field, not a verified identity. Customer reference URLs inherit the existing backend access model. LangGraph uses in-memory checkpoints, so a restart can invalidate an investigation even though its report remains in SQLite.

These are backend deployment requirements. A frontend dialog or hidden button cannot supply those guarantees. The UI explicitly reports unavailable investigations and does not fabricate successful outcomes.
