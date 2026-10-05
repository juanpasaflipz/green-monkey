# Merge and delivery matrix

“Rewrite” retains the behavior while rebuilding the UI and implementation. Phases refer to the master prompt. Required work is not complete merely because a first demonstration works. Optional modules are explicit extensions; if an existing restaurant needs one for cutover, it becomes a release requirement for that restaurant.

| Capability | Source reference | Decision | Phase / requirement |
| --- | --- | --- | --- |
| Owner login, employee PIN, permissions | Both auth systems | Unify memberships, sessions, device-bound PIN access | 1–2, required |
| Restaurants/organizations, branding | POS Lite tenants/org/branding; Luma restaurant selector | One tenant model; explicit org aggregation | 1, 4–5, required |
| Catalog/categories/search/photos | Both menus; POS Lite uploads/R2 | New shared catalog and selling UI | 2, required; R2 when images enabled |
| Modifiers, combos, open amount | Both modifiers; POS Lite combos/open amount | Server validation and shared price calculation | 2, required |
| Promotions, scheduled offers, discounts/courtesies | Luma promotions; POS Lite discounts/approvals | One promotion/discount engine and audit | 2, required |
| Tables, waiter attribution, service rounds | Luma tables/waiter orders; POS Lite order edits | Rewrite table workspace and round dispatch | 2, required |
| Parked carts/templates, call names, fulfillment | POS Lite selling; Luma notes/table orders | Durable cart and service model | 2, required |
| Kitchen/bar, status, seen acknowledgement | Both KDS; POS Lite KDS devices | One queue per station, reliable acknowledgements | 2–3, required |
| Thermal receipts, kitchen printing, reprints | Both print bridges/jobs | One device-authorized durable print pipeline | 2–3, required; hardware validation gate |
| Cash, separate external bank terminal recording | Both payment methods; POS Lite external terminals | One payment workspace; explicit manual recording | 2, required |
| Integrated payments and terminal binding | POS Lite Stripe/MP/Getnet; Clip partial | Retain adapters, prove each enabled provider | 3, required for configured providers |
| Split by items/amount; grouped settlement | Both splits; POS Lite payment groups | Canonical allocations; keep kitchen orders distinct | 3, required |
| Full/partial refunds, cancellations, history | Both | Reversal records and scoped manager approval | 2–3, required |
| Offline cash, menu cache, refresh recovery | POS Lite Dexie/sync; Luma local handling | Preserve/rebuild with visible reconciliation | 3, required |
| QR customer ordering and kiosk | Both; dedicated POS Lite kiosk bundle | Rebuild on same order services; kiosk is required Pro | 3, required web flows |
| Native iOS/Android wrappers | POS Lite ios/android/Capacitor | Preserve a compatible API path; reintroduce when needed | Optional follow-on |
| Ingredients, recipe links, substitutions, costs | Luma recipes/substitutes; POS Lite recipe management | Stable IDs, units, snapshots, yield | 4, required |
| Suppliers, purchase orders, receiving | POS Lite procurement; Luma merchandise | One receiving workflow and stock cause | 4, required |
| Raw-to-prepared inventory, portions, availability | POS Lite prep/portion ledger | Retain concepts; unify all stock writers | 4, required |
| Counts, waste, expiry, suggested variances | Both | Explain expected stock; review before adjustment | 4, required |
| Fixed/variable/recurring expenses | Both | Avoid purchase/COGS/expense duplication | 4, required |
| Sales/margins/commission reporting | POS Lite reports; Luma today/week | One metric layer with provenance | 4, required |
| Forecasts/break-even/owner alerts | Luma projections/dashboard/alerts | Rebuild arithmetic and evidence/action UI | 4, required |
| CSV/manual sales and delivery settlement imports | Both import flows | Preview, mapping, lineage, deduplication | 4, required |
| PDF reports and scheduled summaries | Luma PDF/cron; Resend in both | Railway jobs and durable delivery tracking | 4, required generation; sending when configured |
| Cash sessions, paid-outs, end-of-day | POS Lite drawers; Luma cash cut | Guided close and discrepancy explanations | 2, required |
| Team, shifts, payroll/tips summaries | POS Lite staff/payroll; Luma team | Role-focused management; configurable rules | 5, required; not legal payroll certification |
| Onboarding, account, subscription billing | Both | One onboarding path and entitlement system | 5, required; billing provider sandbox gate |
| CFDI invoice/customer self-service/cancellation | Both FacturAPI flows | Verified provider adapter; private credential handling | 5, configured module; required before invoice cutover |
| Uber Eats/Rappi/DiDi imports and connectors | POS Lite adapters; Luma delivery parser | Import-first plus verified live connectors | 4–5; live connectivity gated |
| Courier dispatch (Uber Direct) | POS Lite | Retain distinct dispatch lifecycle and retries | Optional configured module |
| Loyalty/stamps/referrals | POS Lite | Integrate after checkout; do not obstruct cash sale | 5, configured module |
| Apple/Google wallet passes | POS Lite | Provider-gated loyalty extension | Optional configured module |
| SMS/WhatsApp and voice operations | POS Lite Twilio/Meta | Retain adapter boundary and consent/preferences | Optional configured module |
| AI receipt/menu parsing and recipe matching | Both Anthropic/AI parsers | Draft suggestions, confidence, human review before writes | 4–5, optional assist; manual flow required |
| Kiosk suggestions, menu boards/displays | POS Lite | Use shared catalog/branding; no separate pricing logic | Optional follow-on |
| Incident monitoring / AI sentinel | POS Lite sentinel | Basic operational monitoring required; automated fixes off by default | 6 baseline; advanced optional module |
| Financing, settlement/disbursement, marketing/site fragments | Legacy residual files/docs | Exclude from base POS; record any future demand explicitly | Outside base scope |

## Optional judgment assist (TypeSafe)

New capability; no source equivalent. [TypeSafe](https://docs.typesafe.ai/llms.txt) System One models return typed judgments with probabilities, not generated text. Code builds candidates and applies every write; the model only selects or flags. Each use is a disabled-by-default module behind the same manual flow, calls TypeSafe server-side only, and pre-fills review screens rather than committing records. Set confidence thresholds from Spanish-language sample data before enabling; verify current language support, limits, and pricing in the live docs.

| Capability | Spec reference | Decision | Phase / requirement |
| --- | --- | --- | --- |
| Recipe ↔ menu item matching | MIGRATION step 6; SOURCE_ANALYSIS #7 | Code generates candidate menu items; Choice selects one or “no match”; low confidence flagged on the reviewed matching screen | 4, optional assist; reviewed link required |
| Receipt/supplier line → ingredient | Row “AI receipt/menu parsing” above | After text extraction, Choice selects a catalog ingredient or “new/unknown”; code copies the ID and converts units | 4–5, optional assist; manual receiving required |
| Menu import categorization and duplicates | ACCEPTANCE UX-14; UX_SPEC menu editing | Choice assigns existing categories; Noul flags modifier-vs-item and likely duplicate products for review | 4–5, optional assist; import preview required |
| Kitchen note safety highlight | UX_SPEC kitchen tickets | Noul flags allergy/safety mentions as an added highlight only; never hides, reroutes, or delays dispatch | Optional follow-on; additive only |
| Waste/variance reason classification | UX_SPEC inventory; ACCEPTANCE INV-04 | Choice maps free-text notes to reason codes for reports; arithmetic stays in code; never infers theft | Optional follow-on |
| Legacy restaurant identity suggestions | MIGRATION “never deduplicate by name” | Noul scores code-selected candidate pairs as a suggestion; explicit reviewed mapping still required | Migration tooling, optional assist |

Excluded: pricing, tax, splits, cash close, stock arithmetic, forecasts, owner alert calculation, and cashier catalog search (local ≤100ms budget).

## Mandatory merge resolutions

- One order/payment/inventory service replaces parallel implementations.
- One menu item replaces duplicate “dish” and “menu item” catalogs; recipes reference it by ID.
- One raw/prepared stock model replaces consumption disguised as waste and disconnected counts.
- One financial definition layer replaces independently maintained POS weekly totals and reporting summaries.
- One permission model replaces Supabase owner roles, POS waiter PIN checks, and separate opaque admin access conventions.
- One deployment/configuration model replaces the Vercel/Supabase and Railway/Neon split.

Track progress using columns for implementation, tests, browser evidence, external dependency, and release disposition. A source file's existence is not sufficient evidence to mark an integration verified.
