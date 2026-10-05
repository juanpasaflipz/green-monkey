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
| M2 recovery | local/Neon and deployed recovery HTTP passed | Deployed backup restore/download also passed; combined billing cases remain |
| M3 staging candidate | deployed; core flows passed | Finish remaining exact-candidate sandbox billing cases; see STAGING.md |
| M4 selling/pricing/cash/kitchen | partial | Item voids with manager approval and kitchen deltas done locally (Sept 26); next: discounts/courtesies with approval, item-level refunds, saved drawer close, combos/open amounts, promotions |
| M5 jobs/printing/merchant payments | incomplete | Durable delivery infrastructure; device/provider selection is absent |
| M6 inventory/procurement | partial | Stock item setup, recipe links on products and choices, cached balance and per-restaurant negative-stock policy done locally on `track/menu` (not staged); next: purchase orders, substitutions, lots, yields, saved counts |
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
| Catalog/categories/search/photos | 2, required; R2 when images enabled | See DELIVERY_STATUS.md and corresponding M1–M9 section | Categories (create, rename, reorder, archive), products with search, duplicate, reorder, archive/restore and live availability, bilingual names (English optional), POS category chips in category order, and menu-revision polling so 86'd items leave the POS within 60 s (or at once on focus or a `gm-menu-refresh` event) without overwriting the cached offline session. Locally verified on `track/menu`: `npm run test:db:menu` (revision bumps), `tests/menu.test.ts` "FOH-8: POS catalog freshness" (poll, focus, refresh event and cleanup guards) and the `tests/browser/menu.spec.ts` "FOH-8" test (an 86 reaches an open Vender screen through the 60 s poll, focus and `gm-menu-refresh`); not staged. Product photos pending (no storage provider configured). |
| Modifiers, combos, open amount | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Reusable modifier groups (required, optional or repeatable; min/max; priced choices; choice recipes and costs; live choice availability), combos as products with required choice groups, and open-price items with a manager-set ceiling (staff only; excluded from QR/kiosk). One choice picker for POS and QR/kiosk, priced by the shared quote. Locally verified on `track/menu` (`tests/menu.test.ts`, `npm run test:db:menu`, `tests/browser/menu.spec.ts`); not staged. Per-choice station routing for combos, kitchen/cashier 86 and cart-line editing pending. |
| Promotions, scheduled offers, discounts/courtesies | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Tables, waiter attribution, service rounds | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Table selection, additional rounds, table moves and server reassignment with separate service version/audit. Verified creator/payment/round preservation and cross-tenant rejection. |
| Parked carts/templates, call names, fulfillment | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | IndexedDB drafts and call names. Templates and richer line edits pending. |
| Kitchen/bar, status, seen acknowledgement | 2–3, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Station queues, seen/ready/completed actions, persisted rounds and polling. Cancellation deltas pending. |
| Thermal receipts, kitchen printing, reprints | 2–3, required; hardware validation gate | See DELIVERY_STATUS.md and corresponding M1–M9 section | Browser receipt and durable blocked print records. Printer pairing/acknowledgement/reprint worker pending. |
| Cash, separate external bank terminal recording | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Cash and explicit external-terminal recording. Cash flow browser-tested; external-terminal recording not sandbox verification. |
| Integrated payments and terminal binding | 3, required for configured providers | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Split by items/amount; grouped settlement | 3, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Amount/item splits and grouped settlement API/UI; immutable per-unit allocations, partial-unit balances and concurrent selection checks verified. Pre-allocation history remains explicitly unallocated. |
| Full/partial refunds, cancellations, history | 2–3, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Partial/full amount cash refund API and UI, reason and no-return disposition. Item-level and provider refunds/cancellation pending. |
| Offline cash, menu cache, refresh recovery | 3, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Dexie queue, session scope, service worker, cross-tab lock, same-key retries and atomic sync. Versioned leases, manager reconciliation, backup validation, uncertain-payment checks, historical drawer corrections and concurrency recovery implemented. See OFFLINE_RECOVERY.md for remaining gates. |
| QR customer ordering and kiosk | 3, required web flows | See DELIVERY_STATUS.md and corresponding M1–M9 section | Signed scoped ordering links; QR/kiosk frontend shares service; unpaid kitchen dispatch and public receipt. Idle reset implemented. Provider checkout and held-order policy pending. Kiosk is required Pro; local server entitlement gates are implemented and tested for tenant isolation, expiry and accepted-order retries. Stripe reconciliation and live entitlement provisioning remain pending. |
| Native iOS/Android wrappers | Optional follow-on | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Ingredients, recipe links, substitutions, costs | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Stock item setup (g, kg, ml, l, pieces; raw or prepared; reorder point, par level, opening stock, unit lock, archive), product and choice recipes with g↔kg and ml↔l entry, line cost including choice costs, append-only recipe versions and historical line cost snapshots. Locally verified on `track/menu` (`npm run test:db:menu`, browser); not staged. Substitutes and automatic costing pending. |
| Suppliers, purchase orders, receiving | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Supplier creation and merchandise receipt/expiry metadata. Purchase orders and lot depletion pending. |
| Raw-to-prepared inventory, portions, availability | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Prep input/output ledger and prepared-component consumption (stock rows locked in one global order); live product and choice availability with required-choice sold-out detection in POS and QR. Yield/cost allocation policies pending. |
| Counts, waste, expiry, suggested variances | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Cached theoretical balance kept by a ledger trigger (no history sums at sale time), per-restaurant negative-stock policy (allow and flag by default, block opt-in; offline cash always recorded), dated Negativo flag that is never labelled a shortage, stock-version count adjustment against the cached balance, explicit waste and a suggested order from the par level. Locally verified on `track/menu` (`npm run test:db:menu`, `npm run test:db:core`, browser); not staged. Saved count drafts and expiry alerts pending. |
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
| UX-01 | partial | One picker for required, optional and repeatable choices with blocked invalid combinations, live price and the cart visible; taquería build-and-sell flow browser-tested (`tests/browser/menu.spec.ts`, local). Exact three-item task measurement pending. |
| UX-02 | partial | Cash checkout and receipt tested; primary activation budget not measured. |
| UX-03 | partial | Additional rounds, table/server reassignment and creator/round preservation tested; full table-service lifecycle pending. |
| UX-04 | partial | KDS acknowledgement/ready and independent payment tested; complete service scenario pending. |
| UX-05 | partial | Amount/item splits, lost cash-response recovery and reload tested; integrated provider failure recovery pending. |
| UX-06 | verified | Browser grouped cash settlement retains separate order IDs, tenders and rounds. |
| UX-07 | partial | Draft persistence implemented; complete parked-ticket restart scenario pending. |
| UX-08 | partial | Cash discrepancy links and inventory evidence implemented; full alert correction scenario pending. |
| UX-09 | partial | Count adjustment computed against the cached balance of the locked row, with the stock version refusing a count started before a concurrent sale (`npm run test:db:menu`, local). Saved count workflow and reviewed adjustment pending. |
| UX-10 | partial | Drawer close and refund tested; tip/paid-out combined scenario and saved close draft pending. |
| UX-11 | partial | Selling/cart and item-payment screenshots at all four sizes; fixed payment footer and mobile confirmation checked. All-workspace review pending. |
| UX-12 | partial | Keyboard search, modal dismissal/focus and one-state axe check; full screen-reader review pending. |
| UX-13 | pending | Restaurant settings persist with English labels, timezone/cutoff/opening days. Organization switching and complete locale acceptance pending. |
| UX-14 | partial | Catalog import and cash sale independently verified; complete onboarding flow pending. |
| CORE-01 | partial | Canonical quote shared by POS/QR/kiosk/sync, now including choice counts, open amounts with a ceiling (staff channels only) and merged choice recipes; `selectionIssue` agreement test (`tests/menu.test.ts`). Offline sync still quotes without open price until the offline track merges; promotions and tax configuration pending. |
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
| OFF-01 | partial | Compiled offline refresh/reconnect and duplicate replay pass; complete browser close/reopen matrix remains. |
| OFF-02 | partial | Lost committed cash response, exact payment fingerprint/status and interrupted tab recovery pass; full process-restart HTTP matrix remains. |
| OFF-03 | partial | Two tabs serialize sync; closing the lock holder recovers its syncing row. Concurrent server sync/reconciliation deduplicates. |
| OFF-04 | partial | Eight failed automatic attempts stop with evidence retained; explicit retry verified using transport mocks. |
| OFF-05 | partial | Manager cash review, immutable evidence, concurrent kitchen/stock review, old-drawer corrections and refund cap pass; remaining refund browser matrix pending. |
| OFF-06 | partial | Tenant-bound atomic backups, wrong-tenant rejection, old-session payment retention and revoked-session manager DB recovery pass; full replacement-root/logout matrix pending. |
| OFF-07 | partial | Unsupported offline actions disabled; no provider offline capability claimed. |
| OFF-08 | partial | Waiting revision keeps unresolved work; complete hashed shell graph is precached and API responses are excluded. Exact staging update proof pending. |
| OPS-01 | pending | Printer jobs explicitly blocked; printer worker/hardware recovery pending. |
| OPS-02 | partial | Persisted KDS rounds and polling; disconnect/cancellation scenario pending. |
| OPS-03 | pending | Durable report/email worker not implemented. |
| INV-01 | partial | Receiving/preparation/sale/void return/count/waste ledger with a trigger-maintained cached balance that equals the ledger after every cause (`npm run test:db:menu`, local). Complete chained cost reconciliation pending. |
| INV-02 | verified | Configured per restaurant. Under `block`, concurrent last-portion sales serialize and exactly one succeeds; under the default `allow`, the sale proceeds and the item is flagged; offline cash already collected is always recorded (`npm run test:db:core`, `npm run test:db:menu`, browser; local, not staged). |
| INV-03 | partial | Causal movement deduplication (also enforced by the ledger trigger for repeated inserts), recipe versions per group edit and DB-5 global lock order tested. Substitutes and refund restoration pending. |
| INV-04 | partial | Counts use the cached balance, which includes receipts, prep input/output, sales, waste and earlier adjustments, with the stock-version cutoff; the Negativo flag states it does not indicate a shortage by itself. Saved count scenario pending. |
| FIN-01 | pending | Historical summaries and settlement import not implemented. |
| FIN-02 | partial | Basic order/tender/refund/tip source totals; full tax/fee/commission definitions pending. |
| FIN-03 | partial | Pure forecast identity tested; editable historical scenarios not implemented. |
| FIN-04 | partial | Business cutoff, DST and leap-day unit tests; report integration boundary suite pending. |
| MIG-01 | partial | Both normalized catalog fixtures dry-run; mapping rerun/no side effects DB-tested; historical mappings pending. |
| MIG-02 | partial | Import transactionality implemented; kill-mid-import rehearsal pending. |

## New recovery evidence

- `tests/offline-recovery-db.ts`: automatic/legacy replay, revoked-session manager
  recognition, price/recipe/settings/permission conflicts, exact payment status,
  original-drawer checks, two-writer deduplication, concurrent task completion,
  close/recovery serialization, historical drawer visibility, bounded refunds.
- `tests/browser/recovery.spec.ts`: real unavailable-catalog conflict and closed
  drawer review; unallocated report coverage; atomic backup failures and repeated
  import; JPY/KWD display; interrupted two-tab sync; eight-attempt exhaustion;
  old-session payment retained without another charge. Transport retry cases use
  explicit response mocks; they do not establish provider behavior.
- `tests/browser/core.spec.ts` and `settlement-settings.spec.ts`: compiled offline
  refresh/reconnect, service-worker update, lost committed cash response and splits.
- Shared contracts/readiness tests and all database suites run in the qualification
  workflow. CI results are recorded separately from local and Neon results.

## External prerequisites

No printer/payment provider selected. No approved historical source exports or
source/target migration mapping. Configured invoice, mail, asset-upload and live
connector modules require their actual scope and sandbox credentials. Production
cutover requires a named target/window after all required implementation and
qualification; GitHub publishing alone does not meet these gates.
