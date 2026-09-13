# Warrant interface system

The two user-supplied 21st.dev prompts are the design foundation:

- `~/Documents/prompts/clean-minimal-sign-in-prompt.md`: soft sky-to-white form surface, inset inputs, layered icon tile, rounded corners, charcoal primary button.
- `~/Documents/prompts/integration-graph-prompt.md`: bordered integration tiles, dotted canvas, fine connector paths, a central mark, and motion restricted to active connections.

The report form adapts the sign-in composition to the existing billing workflow. There are no pretend authentication buttons, passwords, social providers, or successful-demo alerts. The integration component shows Warrant's actual sources and handoffs, with step state supplied by the backend.

## Foundation

React + TypeScript, Tailwind CSS, and shadcn-compatible `components/ui` modules. `components.json` registers the root aliases. Shared visual tokens live in `web/styles.css`; application-specific data contracts live in `lib/types.ts`.

| Element | Decision |
| --- | --- |
| Font | Instrument Sans Variable, self-hosted through Fontsource |
| Primary ink | `#252c37` |
| Background | `#fafbfc`, white cards |
| Supporting text | Slate, with measured WCAG AA contrast |
| Accent | Muted blue; amber for decisions, green for verified outcomes, red for errors |
| Corners | 8–13 px for controls and workspace panels; 20–24 px for the customer form |
| Borders | Fine cool-gray borders; dashed separators only for supporting context |
| Icons | Hugeicons **free Stroke Rounded** set, 1.6 stroke width, shared wrapper |
| Motion | Active graph paths only; respect `prefers-reduced-motion` |

## Layout and interaction

The customer portal presents a short explanation beside one focused form. Mobile prioritizes the form and removes the decorative map. Report tracking exposes plain-language progress and verified outcomes.

The team workspace places a searchable report queue beside the selected investigation. Filters and counts use the returned queue (the server caps it at 50). On mobile, list and detail become separate views with an explicit back control. Activity, operation journal, plan identifiers, and traces live in a second tab.

Approval dialogs show the exact amount and charge, request the reviewer email, and submit the displayed plan hash. Expiry and connection loss disable approval. Declines require a reason. Buttons recover from rejected and failed requests. Selected-case changes dispose of the old event stream and async requests.

## Reference research

Lazyweb query: `customer support inbox`, desktop, 3 results, one per company. Returned coverage: strong, top similarity 0.58. The useful references were the inbox layouts visible in [Crisp](https://crisp.chat/en/) and [Kustomer's product tour](https://www.kustomer.com/product-tour/). These supported the queue/detail structure; the supplied 21st.dev components determine the visual language. The encyclopedia enquiry form was discarded as a poor visual match.

Free components and documentation:

- [shadcn Vite setup](https://ui.shadcn.com/docs/installation/vite) and the Card structure included in the supplied prompt.
- [Base UI Dialog](https://base-ui.com/react/components/dialog) and Button for accessible interaction primitives.
- [Hugeicons free React pack](https://hugeicons.com/docs/integrations/react/quick-start). No Pro assets or paid dependencies.
- [Motion reduced-motion support](https://motion.dev/docs/react-use-reduced-motion).
- [Fontsource Instrument Sans](https://fontsource.org/fonts/instrument-sans/install).

Retain the respective package terms when redistributing dependencies. The supplied 21st.dev snippets are adapted in `components/ui/clean-minimal-sign-in.tsx` and `components/ui/integration-card.tsx`.
