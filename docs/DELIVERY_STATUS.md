# Delivery status

September 26 continuation (branch `claude/m4-voids-approval`, not staged): M4 item voids with per-request manager approval, kitchen cancellation deltas and per-employee PIN lockout. Migration 021 and grants must be applied before deploying this revision.

Latest continuation, September 22, 2026: Free limits and offline/payment recovery
are implemented with local database/browser regression coverage. Google signup,
sandbox subscription billing, invitations and multiple locations have prior
staging proof; see TENANCY_QUALIFICATION.md, BILLING_IMPLEMENTATION.md and
LOCATION_IMPLEMENTATION.md. The current recovery changes are not yet staged.
No restaurant payment provider or printer is selected (user confirmed this
September 22); keep those integrations disabled. Full required product scope
remains incomplete. See PRODUCT_COMPLETION_PLAN.md and COMPLETION_LEDGER.md.

This is an in-progress implementation, not release approval. Required features remain pending unless the specific behavior is verified below. Code presence is not provider/hardware validation.

| Capability | Status | Implemented / remaining | External dependency |
| --- | --- | --- | --- |
| Owner login, employee PIN, permissions | pending | Owner/password and employee PIN endpoints; signed device cookies; server roles. Google owner identity, explicit membership, Free restaurant signup/entry and logout implemented and tested locally with synthetic identity. Google staging login, invitations and organization switching verified in prior staging releases; deliberate account linking remains pending. Per-employee lockout after 5 failed secrets (5 minutes) for sign-in and manager approvals, committed even when the request is rejected (September 26, local DB/HTTP checked). | — |
| Restaurants/organizations, branding | pending | Owner settings, currency lock, receipt snapshots, approved branding, organization locations/invitations/switching implemented; dynamic asset upload remains pending. | — |
| Catalog/categories/search/photos | pending | Search, categories, bilingual product names, availability, menu editor; image assets not implemented. | — |
| Modifiers, combos, open amount | pending | Required modifier groups and authoritative prices. Combo slots and open-amount UI pending. | — |
| Promotions, scheduled offers, discounts/courtesies | pending | Not implemented. | — |
| Tables, waiter attribution, service rounds | pending | Table selection, additional rounds, table moves and server reassignment with separate service version/audit. Verified creator/payment/round preservation and cross-tenant rejection. | — |
| Parked carts/templates, call names, fulfillment | pending | IndexedDB drafts and call names. Templates and richer line edits pending. | — |
| Kitchen/bar, status, seen acknowledgement | pending | Station queues, seen/ready/completed actions, persisted rounds and polling. Cancellation deltas pending. | — |
| Thermal receipts, kitchen printing, reprints | pending | Browser receipt and durable blocked print records. Printer pairing/acknowledgement/reprint worker pending. | Provider/account/device verification required; none performed. |
| Cash, separate external bank terminal recording | pending | Cash and explicit external-terminal recording. Cash flow browser-tested; external-terminal recording not sandbox verification. | — |
| Integrated payments and terminal binding | pending | Not implemented. | Provider/account/device verification required; none performed. |
| Split by items/amount; grouped settlement | verified | Amount/item splits and grouped settlement API/UI; immutable per-unit allocations, partial-unit balances and concurrent selection checks verified. Pre-allocation history remains explicitly unallocated. | — |
| Full/partial refunds, cancellations, history | pending | Partial/full amount cash refund API and UI, reason and no-return disposition. Item voids (September 26): unpaid units only, reason, manager approval verified server-side per request, stock return only before the kitchen sees the ticket, kitchen cancellation delta with acknowledgement, fully voided orders become cancelled; local DB-tested (`test:db:voids`) and browser-checked. Item-level refunds of paid units and provider refunds pending. | — |
| Offline cash, menu cache, refresh recovery | pending | Dexie queue, session scope, service worker, cross-tab lock, same-key retries and atomic sync. Versioned leases, manager reconciliation, backup validation, uncertain-payment checks, historical drawer corrections and concurrency recovery implemented. See OFFLINE_RECOVERY.md for remaining gates. | — |
| QR customer ordering and kiosk | pending | Signed scoped ordering links; QR/kiosk frontend shares service; unpaid kitchen dispatch and public receipt. Idle reset implemented. Provider checkout and held-order policy pending. Kiosk is required Pro; local server entitlement gates are implemented and tested for tenant isolation, expiry and accepted-order retries. Stripe reconciliation and live entitlement provisioning remain pending. | — |
| Native iOS/Android wrappers | optional follow-on | Not implemented. | — |
| Ingredients, recipe links, substitutions, costs | pending | Stable stock IDs, append-only recipe versions, historical line cost snapshots; multi-ingredient editor implemented; substitutes and automatic costing pending. | — |
| Suppliers, purchase orders, receiving | pending | Supplier creation and merchandise receipt/expiry metadata. Purchase orders and lot depletion pending. | — |
| Raw-to-prepared inventory, portions, availability | pending | Prep input/output ledger and prepared-component consumption; yield/cost allocation policies pending. | — |
| Counts, waste, expiry, suggested variances | pending | Stock-version count adjustment, movement evidence, explicit waste. Saved count drafts and expiry alerts pending. | — |
| Fixed/variable/recurring expenses | pending | Fixed/variable expense entry. Recurrence and full report treatment pending. | — |
| Sales/margins/commission reporting | pending | Today source-record drill-down, order totals, tender/refund/tip totals, estimated COGS. Full net/tax/fee/commission reporting pending. | — |
| Forecasts/break-even/owner alerts | pending | Pure forecast arithmetic and insufficient-history state. Historical aggregation, editable scenarios and actionable alerts pending. | — |
| CSV/manual sales and delivery settlement imports | pending | Reviewed catalog JSON import for both source labels with mappings and deduplication. Historical sales/summary/delivery reconciliation pending. | — |
| PDF reports and scheduled summaries | pending | Not implemented. | Provider/account/device verification required; none performed. |
| Cash sessions, paid-outs, end-of-day | pending | Device drawer opening, paid-outs, closing count/reason and expected cash including refunds/tips. Saved close draft pending. | — |
| Team, shifts, payroll/tips summaries | pending | Employee creation, shift start/end and estimated hourly payroll list. Tip distribution and payroll policies pending. | — |
| Onboarding, account, subscription billing | pending | Owner onboarding, 14-day no-card trial, durable sandbox subscription billing, location quantity changes and Free device/team/location limits implemented. See BILLING_IMPLEMENTATION.md and FREE_LIMITS.md; live billing is not enabled. | Provider/account/device verification required; none performed. |
| CFDI invoice/customer self-service/cancellation | pending | Not implemented. | Provider/account/device verification required; none performed. |
| Uber Eats/Rappi/DiDi imports and connectors | pending | Not implemented. | — |
| Courier dispatch (Uber Direct) | optional follow-on | Not implemented. | Provider/account/device verification required; none performed. |
| Loyalty/stamps/referrals | pending | Not implemented. | — |
| Apple/Google wallet passes | optional follow-on | Not implemented. | Provider/account/device verification required; none performed. |
| SMS/WhatsApp and voice operations | optional follow-on | Not implemented. | Provider/account/device verification required; none performed. |
| AI receipt/menu parsing and recipe matching | pending | Not implemented. | — |
| Kiosk suggestions, menu boards/displays | optional follow-on | Not implemented. | — |
| Incident monitoring / AI sentinel | partial | Structured JSON logs with request ids and route templates, `/api/ops/status`, worker watchdog alerts (web down, billing review/retrying), dead-job alerts, hourly uptime and backup-freshness workflow, optional Sentry; locally verified by `tests/ops-http.test.ts`, `tests/drain-http.ts` and `tests/browser/ops.spec.ts`. Alert topic and Railway deploy webhook are the owner's setup steps; no on-call staffing; AI sentinel not implemented. | — |
| Financing, settlement/disbursement, marketing/site fragments | optional follow-on | Excluded from base POS per approved matrix. | — |

## Verified subsets

- Google sign-in: staging OAuth client created; server exchange/token validation,
  durable attempts, mounted callbacks, owner accounts, membership and Free signup
  tested locally. Real Google end-to-end staging login passed; see TENANCY_QUALIFICATION.md. See PLANS_AND_SIGNUP.md.

- Pinned reference downloads match every file hash in the source manifest.
- Domain unit tests: exact decimal money, remainder allocation, modifier constraints, unit conversion, business cutoff/DST/leap day, state progression, finance and forecast arithmetic.
- Isolated PostgreSQL tests: RLS, tenant FKs, same-key concurrency, changed payload rejection, payment overcollection prevention, rollback/context reset, immutable tenders, last-portion contention, import rerun without operational side effects.
- Browser evidence is tracked in RELEASE_REPORT.md; passing subsets do not imply every acceptance criterion is satisfied.

## External blockers

- Approved Pro pricing and bilingual display are implemented: MXN 799/month or
  MXN 7,990/year per location. Sandbox catalog provisioning is locally tested but
  verified against a dedicated Stripe sandbox, including an idempotent rerun. Trial,
  Checkout, portal and signed subscription webhook sandbox checks passed;
  approving the offer does not activate billing.

- Separate Neon staging/test databases and Railway staging are provisioned. Seventeen Neon integration checks and a live cash/KDS/receipt browser smoke passed; [STAGING.md](STAGING.md) records targets and evidence. The CD path (GitHub Actions → Railway IaC, worker preDeploy migrations as `gm_migrator`), encrypted R2 backups and the Neon restore rehearsal are scripted but have not run against staging yet ([RUNBOOK.md](RUNBOOK.md) "Staging cutover"); staging restore/rollback, broader cloud acceptance and provider checks remain pending.
- No approved legacy exports/schema metadata: historical mapping, totals reconciliation and migration rehearsal remain pending. The Luma ZIP is not a database backup.
- No payment sandbox merchant/terminal, FacturAPI sandbox, printer bridge/device, verified Resend sender or R2 target configured. These integrations remain disabled. Clip has no assumed request schema or amount units.
- Docker CLI is absent locally; CI now builds the image and smoke-tests web, worker and `migrate --check` inside it (`.github/workflows/qualification.yml`), pending its first GitHub run.
