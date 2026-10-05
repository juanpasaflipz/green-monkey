# Product completion ledger — September 22, 2026

This is a gap ledger, not release approval. Exact scope remains in
[the execution plan](PRODUCT_COMPLETION_PLAN.md). Required implementation is
incomplete; staging qualification and production launch are separate outcomes.
The user confirmed that no restaurant payment provider or printer is selected.
Do not enable those integrations or substitute mocked evidence for hardware proof.

## Current milestone disposition

| Milestone | Status | Next action |
| --- | --- | --- |
| M0 baseline | complete locally | Preserve checkpoints and applied migration checksums |
| M1 Free limits | local/Neon and deployed device selection passed | Remaining combined entitlement scenarios in M3 |
| M2 recovery | local/Neon and deployed recovery HTTP passed; wave-1 offline track (026) locally verified | Staging proof of the 026 offline changes, real tablet and printer checks, combined billing cases |
| M3 staging candidate | deployed; core flows passed | Finish remaining exact-candidate sandbox billing cases; see STAGING.md |
| M4 selling/pricing/cash/kitchen | partial | Item voids with manager approval and kitchen deltas done locally (Sept 26); next: discounts/courtesies with approval, item-level refunds, saved drawer close, combos/open amounts, promotions |
| M5 jobs/printing/merchant payments | incomplete | Durable delivery infrastructure; device/provider selection is absent |
| M6 inventory/procurement | partial | Purchase orders, substitutions, lots, yields, saved counts |
| M7 finance/imports/reports | partial | Complete metric contract, recurring expenses, settlement imports, PDF/schedules |
| M8 accounts/configured modules | partial | Linking/recovery/onboarding, team policies and explicitly configured providers |
| M9 migration/readiness | blocked in part | Approved source exports; isolated restore/rollback and operational evidence |
| M10 final qualification | pending | Full exact-revision security/load/UX/recovery matrix |
| M11 production launch | not authorized by GitHub publishing | Named live target, enabled modules and cutover window after qualification |

## Capability inventory

Evidence entry points: `tests/browser/`, `tests/*-db.ts`, `tests/*.test.ts`,
DELIVERY_STATUS.md, and the named implementation checkpoints. A row is not passed
merely because its implementation entry point exists. All external proof is
unverified unless a dated checkpoint explicitly records it.

| Capability | Required/configured/optional scope | Implementation and evidence | Remaining work / next action |
| --- | --- | --- | --- |
| Owner login, employee PIN, permissions | 1–2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Owner/password and employee PIN endpoints; signed device cookies; server roles. Google owner identity, explicit membership, Free restaurant signup/entry and logout implemented and tested locally with synthetic identity. Google staging login, invitations and organization switching verified in prior staging releases; deliberate account linking remains pending. |
| Restaurants/organizations, branding | 1, 4–5, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Owner settings, currency lock, receipt snapshots, approved branding, organization locations/invitations/switching implemented; dynamic asset upload remains pending. |
| Catalog/categories/search/photos | 2, required; R2 when images enabled | See DELIVERY_STATUS.md and corresponding M1–M9 section | Search, categories, bilingual product names, availability, menu editor; image assets not implemented. |
| Modifiers, combos, open amount | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Required modifier groups and authoritative prices. Combo slots and open-amount UI pending. |
| Promotions, scheduled offers, discounts/courtesies | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Tables, waiter attribution, service rounds | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Table selection, additional rounds, table moves and server reassignment with separate service version/audit. Verified creator/payment/round preservation and cross-tenant rejection. |
| Parked carts/templates, call names, fulfillment | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | IndexedDB drafts and call names. Templates and richer line edits pending. |
| Kitchen/bar, status, seen acknowledgement | 2–3, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Station queues, seen/ready/completed actions, persisted rounds and polling. Cancellation deltas pending. |
| Thermal receipts, kitchen printing, reprints | 2–3, required; hardware validation gate | See DELIVERY_STATUS.md and corresponding M1–M9 section | Browser receipt and durable blocked print records. Printer pairing/acknowledgement/reprint worker pending. |
| Cash, separate external bank terminal recording | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Cash and explicit external-terminal recording. Cash flow browser-tested; external-terminal recording not sandbox verification. |
| Integrated payments and terminal binding | 3, required for configured providers | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Split by items/amount; grouped settlement | 3, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Amount/item splits and grouped settlement API/UI; immutable per-unit allocations, partial-unit balances and concurrent selection checks verified. Pre-allocation history remains explicitly unallocated. |
| Full/partial refunds, cancellations, history | 2–3, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Partial/full amount cash refund API and UI, reason and no-return disposition. Item-level and provider refunds/cancellation pending. |
| Offline cash, menu cache, refresh recovery | 3, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Reachability heartbeat and request outcomes (not navigator.onLine), manual offline mode, request timeouts, cached-session restore on any transient failure, v3 offline sales by cash or external terminal with provisional numbers, kitchen tickets (print and device list), KDS review lane, exactly-once sync with authenticity/eligibility split, manager reconcile and archive, retries that never exhaust, clock offset, atomic service-worker revisions with an update prompt, persistence, manifest and browser gate (offline track, migration 026; locally verified). Real tablet, printer, ISP-outage and staging update proof pending; see OFFLINE_RECOVERY.md. |
| QR customer ordering and kiosk | 3, required web flows | See DELIVERY_STATUS.md and corresponding M1–M9 section | Signed scoped ordering links; QR/kiosk frontend shares service; unpaid kitchen dispatch and public receipt. Idle reset implemented. Provider checkout and held-order policy pending. Kiosk is required Pro; local server entitlement gates are implemented and tested for tenant isolation, expiry and accepted-order retries. Stripe reconciliation and live entitlement provisioning remain pending. |
| Native iOS/Android wrappers | Optional follow-on | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Ingredients, recipe links, substitutions, costs | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Stable stock IDs, append-only recipe versions, historical line cost snapshots; multi-ingredient editor implemented; substitutes and automatic costing pending. |
| Suppliers, purchase orders, receiving | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Supplier creation and merchandise receipt/expiry metadata. Purchase orders and lot depletion pending. |
| Raw-to-prepared inventory, portions, availability | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Prep input/output ledger and prepared-component consumption; yield/cost allocation policies pending. |
| Counts, waste, expiry, suggested variances | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Stock-version count adjustment, movement evidence, explicit waste. Saved count drafts and expiry alerts pending. |
| Fixed/variable/recurring expenses | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Fixed/variable expense entry. Recurrence and full report treatment pending. |
| Sales/margins/commission reporting | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Today source-record drill-down, order totals, tender/refund/tip totals, estimated COGS. Full net/tax/fee/commission reporting pending. |
| Forecasts/break-even/owner alerts | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Pure forecast arithmetic and insufficient-history state. Historical aggregation, editable scenarios and actionable alerts pending. |
| CSV/manual sales and delivery settlement imports | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Reviewed catalog JSON import for both source labels with mappings and deduplication. Historical sales/summary/delivery reconciliation pending. |
| PDF reports and scheduled summaries | 4, required generation; sending when configured | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Cash sessions, paid-outs, end-of-day | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Device drawer opening, paid-outs, closing count/reason and expected cash including refunds/tips. Saved close draft pending. |
| Team, shifts, payroll/tips summaries | 5, required; not legal payroll certification | See DELIVERY_STATUS.md and corresponding M1–M9 section | Employee creation, shift start/end and estimated hourly payroll list. Tip distribution and payroll policies pending. |
| Onboarding, account, subscription billing | 5, required; billing provider sandbox gate | See DELIVERY_STATUS.md and corresponding M1–M9 section | Owner onboarding, 14-day no-card trial, durable sandbox subscription billing, location quantity changes and Free device/team/location limits implemented. See BILLING_IMPLEMENTATION.md and FREE_LIMITS.md; live billing is not enabled. |
| CFDI invoice/customer self-service/cancellation | 5, configured module; required before invoice cutover | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Uber Eats/Rappi/DiDi imports and connectors | 4–5; live connectivity gated | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Courier dispatch (Uber Direct) | Optional configured module | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Loyalty/stamps/referrals | 5, configured module | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Apple/Google wallet passes | Optional configured module | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| SMS/WhatsApp and voice operations | Optional configured module | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| AI receipt/menu parsing and recipe matching | 4–5, optional assist; manual flow required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Kiosk suggestions, menu boards/displays | Optional follow-on | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Incident monitoring / AI sentinel | 6 baseline; advanced optional module | See DELIVERY_STATUS.md and corresponding M1–M9 section | Safe error IDs, health/version endpoints, explicit capabilities. Metrics/alerts and incident workflow pending. |
| Financing, settlement/disbursement, marketing/site fragments | Outside base scope | See DELIVERY_STATUS.md and corresponding M1–M9 section | Excluded from base POS per approved matrix. |

## Acceptance inventory

These inherited statuses remain conservative. The recovery evidence below
supersedes older descriptions of missing manager recovery, but does not silently
mark full scenarios complete. Each ID remains a release gate from ACCEPTANCE.md.

| Scenario | Status | Evidence / outstanding work |
| --- | --- | --- |
| UX-01 | partial | Modifier validation and persistent cart tested; exact three-item task measurement pending. |
| UX-02 | partial | Cash checkout and receipt tested; primary activation budget not measured. |
| UX-03 | partial | Additional rounds, table/server reassignment and creator/round preservation tested; full table-service lifecycle pending. |
| UX-04 | partial | KDS acknowledgement/ready and independent payment tested; complete service scenario pending. |
| UX-05 | partial | Amount/item splits, lost cash-response recovery and reload tested; integrated provider failure recovery pending. |
| UX-06 | verified | Browser grouped cash settlement retains separate order IDs, tenders and rounds. |
| UX-07 | partial | Draft persistence implemented; complete parked-ticket restart scenario pending. |
| UX-08 | partial | Cash discrepancy links and inventory evidence implemented; full alert correction scenario pending. |
| UX-09 | partial | Count adjustment and concurrent stock version validation implemented; saved count workflow pending. |
| UX-10 | partial | Drawer close and refund tested; tip/paid-out combined scenario and saved close draft pending. |
| UX-11 | partial | Selling/cart and item-payment screenshots at all four sizes; fixed payment footer and mobile confirmation checked. All-workspace review pending. |
| UX-12 | partial | Keyboard search, modal dismissal/focus and one-state axe check; full screen-reader review pending. |
| UX-13 | pending | Restaurant settings persist with English labels, timezone/cutoff/opening days. Organization switching and complete locale acceptance pending. |
| UX-14 | partial | Catalog import and cash sale independently verified; complete onboarding flow pending. |
| CORE-01 | partial | Canonical quote shared by POS/QR/kiosk/sync; promotions and tax configuration pending. |
| CORE-02 | verified | Eight parallel same-ID creates produce one order/stock effect; altered payload conflicts. |
| CORE-03 | pending | Integrated provider events/reconciliation not implemented. |
| CORE-04 | pending | Committed cash response loss and original-operation recovery tested; integrated provider crash/restart recovery not implemented. |
| CORE-05 | partial | Concurrent cash/item collection and lost-response recovery tested; integrated cards pending. |
| CORE-06 | partial | Money/remainder/unit arithmetic and partial item units tested; live taxes/promotions pending. |
| CORE-07 | partial | Recipe/price edits retain historical snapshots; new orders retain restaurant configuration. Tax/offline conflict acceptance pending. |
| CORE-08 | partial | Device PIN, CSRF and cashier management denial tested; approval and membership lifecycle pending. |
| CORE-09 | partial | Two-tenant RLS/FK and public QR tamper checks; invoice/webhook/print/upload/org routes pending. |
| CORE-10 | partial | Missing context, rollback reuse and least-privileged role tested locally; Neon pooled/direct pending. |
| CORE-11 | partial | Cash refund reason, original tender immutability and no automatic stock return; item void/approval/provider cases pending. |
| OFF-01 | partial | Compiled offline refresh/reconnect, reload during an API outage and exactly-once replay pass locally (`offline.spec.ts`, `offline-sync-db.ts`); staging and real-device close/reopen remain. |
| OFF-02 | partial | Lost committed cash response, idempotent payment retry, reuse of an online order whose response was lost, exact payment fingerprint/status and interrupted tab recovery pass locally; full process-restart HTTP matrix remains. |
| OFF-03 | partial | Two tabs serialize sync; closing the lock holder recovers its syncing row. Concurrent sync/reconcile and sync/archive of one record apply exactly once (`offline-sync-db.ts`). Staging pending. |
| OFF-04 | partial | Redefined: transient failures never exhaust or become conflicts and attempts are not counted offline (`offline-policy.test.ts`, `offline.spec.ts` with 503 responses); every conflict can be reconciled or archived (`offline-sync-db.ts`, `offline.spec.ts`). Locally verified; staging pending. |
| OFF-05 | partial | Server repricing refuses price and product-revision changes; review never throws for evidence; lease-cited config change stays reconcilable; manager cash review, immutable evidence, kitchen/stock review, old-drawer corrections and refund cap pass locally; remaining refund browser matrix pending. |
| OFF-06 | partial | Tenant-bound atomic backups (v1/v2/v3), wrong-tenant rejection, parked review-required payment attempts, ended-session evidence auto-syncing for the same employee and device, and revoked-session manager recovery pass locally; access's logout guard and renewal evidence join at access's merge. |
| OFF-07 | partial | Item split, settlements, voids, refunds, discounts and drawer operations disabled offline; external terminal recording requires reference and confirmation; kitchen tickets say they are not network deliveries; no provider offline capability claimed. |
| OFF-08 | partial | Build id baked into the worker; a failed install leaves the old revision intact and an offline reload still renders; the update prompt applies only with nothing unsynced (`sw-shell.test.ts`, `offline.spec.ts`). Exact staging update proof between two deployed builds pending. |
| OFF-09 | partial | API down with the browser online, HTML 502 and a hung server switch to offline selling and sync on recovery (`offline.spec.ts`, Chromium and emulated WebKit iPad). Real ISP outage pending. |
| OFF-10 | partial | Kitchen tickets print and stay on the device; KDS review lane decisions pass locally. Live-KDS exclusion lands with service (D13); real printer pending. |
| OFF-11 | partial | External terminal offline sales and provisional numbers mapped at sync pass locally. Offline table service (open orders, rounds, partial payments) ships as the separate `feat(offline-tables)` series. |
| OFF-12 | partial | Fast device clock syncs; out-of-window and unverifiable evidence archived with a reason unblocks drawer close (`offline.spec.ts`, `offline-sync-db.ts`). Locally verified. |
| OPS-01 | pending | Printer jobs explicitly blocked; printer worker/hardware recovery pending. |
| OPS-02 | partial | Persisted KDS rounds and polling; disconnect/cancellation scenario pending. |
| OPS-03 | pending | Durable report/email worker not implemented. |
| INV-01 | partial | Receiving/preparation/sale/count/waste ledger implemented; complete chained cost reconciliation pending. |
| INV-02 | verified | Two concurrent last-portion deductions serialize; only one succeeds. |
| INV-03 | partial | Causal movement deduplication and recipe versions tested; substitutes/refund restoration pending. |
| INV-04 | partial | Append-only ledger-derived count and optimistic version checks; full scenario coverage pending. |
| FIN-01 | pending | Historical summaries and settlement import not implemented. |
| FIN-02 | partial | Basic order/tender/refund/tip source totals; full tax/fee/commission definitions pending. |
| FIN-03 | partial | Pure forecast identity tested; editable historical scenarios not implemented. |
| FIN-04 | partial | Business cutoff, DST and leap-day unit tests; report integration boundary suite pending. |
| MIG-01 | partial | Both normalized catalog fixtures dry-run; mapping rerun/no side effects DB-tested; historical mappings pending. |
| MIG-02 | partial | Import transactionality implemented; kill-mid-import rehearsal pending. |

## New recovery evidence

- `tests/offline-sync-db.ts` (wave 1, migration 026): exactly-once v3 sale sync and
  replay, external terminal tenders, business date from the sale time, clock
  tolerance and clamping, lease-cited configuration, authenticity vs eligibility,
  archive idempotency and sync/archive races, reuse of a committed online order,
  overpayment refusal, negative stock for offline sales, repricing, drawer guard and
  late reconcile, kitchen review lane, device prefixes, revoked vs ended sessions,
  legacy `/sync` compatibility, RLS, grants, immutability, pagination, heartbeat.
- `tests/offline-recovery-db.ts`: automatic/legacy replay, revoked-session manager
  recognition, price/recipe/settings/permission conflicts, exact payment status,
  original-drawer checks, two-writer deduplication, concurrent task completion,
  close/recovery serialization, historical drawer visibility, bounded refunds.
- `tests/browser/offline.spec.ts`: API down and HTML 502 with the browser online,
  hung server, reload during an outage, manual offline mode, parked payment
  attempts, transient retries, offline kitchen tickets, KDS review lane, fast
  device clock, archive and drawer close, service-worker update, 768 px state,
  persistence, manifest, browser gate, no polling, pruning. `@cross` tests also run
  on Playwright's emulated WebKit iPad, which is not real-device evidence.
- `tests/browser/recovery.spec.ts`: real unavailable-catalog conflict and closed
  drawer review; unallocated report coverage; atomic backup failures and repeated
  import; JPY/KWD display; interrupted two-tab sync; old-session payment retained
  without another charge. Transport retry cases use explicit response mocks; they
  do not establish provider behavior.
- `tests/browser/core.spec.ts` and `settlement-settings.spec.ts`: compiled offline
  refresh/reconnect, baked service-worker revision, lost committed cash response
  and splits.
- Unit: `offline-policy`, `offline-net`, `offline-records`, `offline-clock`,
  `sw-shell`. Shared contracts/readiness tests and all database suites run in the
  qualification workflow. CI results are recorded separately from local and Neon
  results.

## External prerequisites

No printer/payment provider selected. No approved historical source exports or
source/target migration mapping. Configured invoice, mail, asset-upload and live
connector modules require their actual scope and sandbox credentials. Production
cutover requires a named target/window after all required implementation and
qualification; GitHub publishing alone does not meet these gates.
