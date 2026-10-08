# Product completion ledger — September 22, 2026 (updated October 8, 2026)

This is a gap ledger, not release approval. **October 8 update:** Wave 2, public
ordering and Wave 3 are merged on `integration/v1` (migrations through 036); staging
is cut over and runs `main` at `3e62285` (migrations through 035, CD smoke green);
production is not launched ([LAUNCH_HANDOFF.md](LAUNCH_HANDOFF.md)). "Staged" below
means deployed to staging by CD on 2026-10-07 and covered there only by the CD smoke. Exact scope remains in
[the execution plan](PRODUCT_COMPLETION_PLAN.md). Required implementation is
incomplete; staging qualification and production launch are separate outcomes.
The user confirmed that no restaurant payment provider or printer is selected.
Do not enable those integrations or substitute mocked evidence for hardware proof.

## Current milestone disposition

| Milestone | Status | Next action |
| --- | --- | --- |
| M0 baseline | complete locally | Preserve checkpoints and applied migration checksums |
| M1 Free limits | local/Neon and deployed device selection passed | Remaining combined entitlement scenarios in M3 |
| M2 recovery | local/Neon and deployed recovery HTTP passed; wave-1 offline track (026) locally verified and staged (2026-10-07, smoke only) | Staging proof of the 026 offline changes, real tablet and printer checks, combined billing cases |
| M3 staging candidate | deployed; core flows passed (September); Wave 2.0 cutover done 2026-10-06/07 (RUNBOOK "Staging cutover" steps 1–13, rotations included): CD deploys `main` with migrations from GitHub Actions, smoke green on `3e62285` | Cutover steps 14–15 (backup and restore drill, waiting for the owner's R2 and age key; load test and pool decision), alerts, remaining exact-candidate sandbox billing cases; see STAGING.md |
| M4 selling/pricing/cash/kitchen | partial | Item voids with manager approval and kitchen deltas done locally (Sept 26); service lifecycle, notes, KDS and payment UX done locally (Oct 5: `test:db:service`, `tests/browser/service.spec.ts`, `tests/browser/kitchen.spec.ts`); combos, open-price items within a ceiling and one choice picker for the POS and QR/kiosk done locally (Oct 5: `test:db:menu`, `tests/browser/menu.spec.ts`); discounts/courtesies with limits and one-PIN manager approval, item and terminal refunds with kitchen cancellation and restock, blind drawer close with cash/terminal separation and review done locally on `track/discounts` (Oct 5: `test:db:discounts`, `tests/browser/discounts.spec.ts`; fiscal-dependent checks skip until fiscal 027 merges); next: promotions, saved drawer close, physical printer check |
| M5 jobs/printing/merchant payments | incomplete | Jobs outbox runner done locally (Oct 5: dedupe, lease fencing, backoff, dead-job alerts, restart resume; `tests/jobs-db.ts`); Wave 2.0 (Oct 5, local with CI parity; on staging since 2026-10-07, worker `jobs:true`): worker-only jobs runner on the `gm_jobs_worker` login with tenant discovery, `runAt` and per-kind `maxAttempts`; next: printer, report/email and payment handlers once devices/providers are selected |
| M6 inventory/procurement | partial | Stock item setup, recipe links on products and choices, cached balance and per-restaurant negative-stock policy done locally on `track/menu` (staged 2026-10-07); next: purchase orders, substitutions, lots, yields, saved counts |
| M7 finance/imports/reports | partial | Reports (029, local): metric contract, Hoy, Finanzas, cortes, exceptions and the activity log, wired on fiscal 027 and discounts 028 with the LD-27 hardening. Recurring expenses, settlement imports and schedules remain. |
| M8 accounts/configured modules | partial | Device pairing, PIN sign-in and staff offboarding (access, 023) and co-owners, ownership transfer, recovery codes, legal acceptance, owner data export, plan notices and the vendor support CLI (account, 031) delivered locally, staged 2026-10-07 and await staging verification; next: verified-email recovery, account linking, explicitly configured providers |
| M9 migration/readiness | blocked in part | Approved source exports. Per-file migrations, schema readiness, encrypted backups and restore verification locally verified (Oct 5; `tests/migrate-db.ts`, `tests/ops-http.test.ts`, `tests/backup-db.ts`); Wave 2.0 moved migrations and retention to GitHub Actions as `gm_migrator` (local with CI parity, Oct 5); CI runs on GitHub and CD deploys staging since 2026-10-07 (migrations 022–035 applied from Actions); R2 backups, the scheduled retention and the Neon restore rehearsal wait for the owner's R2 credentials and age key (LD-53); staging restore/rollback and operational evidence pending |
| M10 final qualification | in progress | Restaurant-day gate passes locally (branch N twice in a row, branch K against the Facturapi fake; ACCEPTANCE_STATUS.md) and `restaurant-day.yml` exists; next: its required checks (applied right after the release pull request merges), two consecutive green CI runs, the staging load test, then the full exact-revision security/load/UX/recovery matrix |
| M11 production launch | not launched; the owner's decision (not authorized by GitHub publishing) | The owner follows [LAUNCH_HANDOFF.md](LAUNCH_HANDOFF.md) section 2 (named live target, enabled modules, deploy window) after qualification |

Account 031 deferrals (recorded so they are not mistaken for done):
verified-email recovery and deliberate account linking (M8.2); SaaS CFDI for
the subscription (no flag exists; only the optional receptor tax profile is
stored); Stripe Tax (not used; Mexico border rates unsupported, a fixed IVA
16 % Tax Rate mode exists instead); account and restaurant deletion tooling
(offboarding is a manual operator procedure); the `billing_requests` inbox
(DB-1, reassigned to the post-launch billing area); email reminders (in-app
only); counsel review of the legal text and the real legal entity values.

## Capability inventory

Evidence entry points: `tests/browser/`, `tests/*-db.ts`, `tests/*.test.ts`,
DELIVERY_STATUS.md, and the named implementation checkpoints. A row is not passed
merely because its implementation entry point exists. All external proof is
unverified unless a dated checkpoint explicitly records it.

| Capability | Required/configured/optional scope | Implementation and evidence | Remaining work / next action |
| --- | --- | --- | --- |
| Owner login, employee PIN, permissions | 1–2, required | See DELIVERY_STATUS.md, ACCESS.md and corresponding M1–M9 section | Google owner identity, explicit membership, Free restaurant signup/entry and logout implemented and tested locally with synthetic identity; Google staging login, invitations and organization switching verified in prior staging releases. Access (locally verified October 5, 2026: `test:db:access` 39 checks, `test:access-http` 13 checks, `tests/browser/access.spec.ts` 25 flows): pairing codes, employee picker and PIN pad without a restaurant ID, demo form only with `DEMO_TENANT_ID`, sliding sessions with an absolute cap, per-device PIN throttling with owner unlock (managers unlock only cashiers, servers and kitchen staff) and device-keyed rate limits with a per-restaurant backstop, step-up for every PIN session (a pending prompt is cancelled by a switch or sign-out), idle and manual lock that Escape or a forced close cannot dismiss and that survives reloads and offline restores, a manual lock reaching every open tab while an idle background tab never locks the tab in use (offline soft unlock re-locks on reconnect, refuses every online call except the lock screen's own and the offline sync unsent once the server answers, and is never offered over a lock the server imposed; a revoked session leaves the offline cache) and quick switch, a lock that refreshes its roster, shows the offline lock when the server is unreachable and stays above later dialogs, terminal Google/account refusal under any path spelling or HEAD. Account (031, locally verified October 5, 2026): co-owners, ownership transfer (owner, support, recovery code) and recovery codes; owner seats revoked through access's deactivation. Remaining: staging verification; verified-email recovery and deliberate account linking are deferred (M8.2). |
| Restaurants/organizations, branding | 1, 4–5, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Owner settings, currency lock, receipt snapshots, approved branding, organization locations/invitations/switching implemented; dynamic asset upload remains pending. |
| Catalog/categories/search/photos | 2, required; R2 when images enabled | See DELIVERY_STATUS.md and corresponding M1–M9 section | Categories (create, rename, reorder, archive), products with search, duplicate, reorder, archive/restore and live availability, bilingual names (English optional), POS category chips in category order, and menu-revision polling so 86'd items leave the POS within 60 s (or at once on focus or a `gm-menu-refresh` event) without overwriting the cached offline session. Locally verified on `track/menu`: `npm run test:db:menu` (revision bumps), `tests/menu.test.ts` "FOH-8: POS catalog freshness" (poll, focus, refresh event and cleanup guards) and the `tests/browser/menu.spec.ts` "FOH-8" test (an 86 reaches an open Vender screen through the 60 s poll, focus and `gm-menu-refresh`); staged 2026-10-07. Product photos pending (no storage provider configured). |
| Modifiers, combos, open amount | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Reusable modifier groups (required, optional or repeatable; min/max; priced choices; choice recipes and costs; live choice availability), combos as products with required choice groups, and open-price items with a manager-set ceiling (staff only; excluded from QR/kiosk). One choice picker for POS and QR/kiosk, priced by the shared quote. Locally verified on `track/menu` (`tests/menu.test.ts`, `npm run test:db:menu`, `tests/browser/menu.spec.ts`); staged 2026-10-07. Per-choice station routing for combos, kitchen/cashier 86 and cart-line editing pending. |
| Promotions, scheduled offers, discounts/courtesies | 2, required | See DELIVERY_STATUS.md and DISCOUNTS.md | Manual discounts and courtesies by line or check (percentage, amount, 100 % comp) with reason codes, per-role limits, one manager PIN for staff over their limit, immutable unit allocations, LIFO removal and finality once a takeaway check closes; locally verified on `track/discounts` (migration 028: `tests/discounts.test.ts`, `npm run test:db:discounts`, `tests/browser/discounts.spec.ts`); staged 2026-10-07. Promotions, scheduled offers and automatic discounts pending. |
| Tables, waiter attribution, service rounds | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Table selection, additional rounds, table moves and server reassignment with separate service version/audit. Verified creator/payment/round preservation and cross-tenant rejection. Oct 5 (local): check lifecycle separate from kitchen state, Liberar mesa, occupancy from checks that are not closed, Orders list with filters and paging; staged 2026-10-07. |
| Parked carts/templates, call names, fulfillment | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | IndexedDB drafts and call names. Oct 5 (local): resume/restore park the unsent cart, line merging, line notes with presets, sold-out lines with Quitar. Templates pending. |
| Kitchen/bar, status, seen acknowledgement | 2–3, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Station queues, seen/ready/completed actions, persisted rounds and polling; cancellation deltas (Sept 26). Oct 5 (local): notes and modifiers on tickets, versioned single-flight feed, alerts, recall, stale banner, clear of previous-day tickets; Oct 7 (W3-2): at the feed cap the newest 200 open rounds, and 035 ranks a reopened round by when it reopened; staged 2026-10-07. |
| Thermal receipts, kitchen printing, reprints | 2–3, required; hardware validation gate | See DELIVERY_STATUS.md and corresponding M1–M9 section | Browser receipt and durable blocked print records. Oct 5 (local): browser/OS 58/80 mm receipt, pre-bill, kitchen ticket and audited reprint, verified in Chromium print emulation only. Oct 5 (fiscal 027, local): fiscal ticket content (issuer, consecutive folio, date of issue, IVA per rate, legends), printed in Spanish. Physical printer check and printer worker pending. |
| Cash, separate external bank terminal recording | 2, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Cash and explicit external-terminal recording. Oct 5 (local): per-sale payment form reset, change from this payment, quick cash, voluntary tips, drawer gate before sending; external-terminal recording is not sandbox verification. |
| Integrated payments and terminal binding | 3, required for configured providers | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Split by items/amount; grouped settlement | 3, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Amount/item splits and grouped settlement API/UI; immutable per-unit allocations, partial-unit balances and concurrent selection checks verified. Pre-allocation history remains explicitly unallocated. |
| Full/partial refunds, cancellations, history | 2–3, required | See DELIVERY_STATUS.md and DISCOUNTS.md | Refunds by item (fully paid units returned to the tenders that paid them, kitchen cancellation for unserved units, optional restock) or by amount (paid checks only), cash and recorded external-terminal refunds with reference and confirmation, refund reasons, approver and business date per batch, refund slip; locally verified on `track/discounts` (migration 028); staged 2026-10-07. Integrated provider refunds pending (no provider). |
| Offline cash, menu cache, refresh recovery | 3, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Reachability heartbeat and request outcomes (not navigator.onLine), manual offline mode, request timeouts, cached-session restore on any transient failure, v3 offline sales by cash or external terminal with provisional numbers, kitchen tickets (print and device list), KDS review lane, exactly-once sync with authenticity/eligibility split, manager reconcile and archive, retries that never exhaust, clock offset, atomic service-worker revisions with an update prompt, persistence, manifest and browser gate (offline track, migration 026; locally verified). Real tablet, printer, ISP-outage and staging update proof pending; see OFFLINE_RECOVERY.md. |
| QR customer ordering and kiosk | 3, required web flows | See DELIVERY_STATUS.md and corresponding M1–M9 section | Public ordering (032/033, locally verified on `track/public` with CI parity, October 6, 2026; staged 2026-10-07 after a DB-9 check on staging with 0 rows): revocable per-table, takeaway and kiosk codes (opaque 128-bit tokens kept in the URL fragment and sent in a header, stored only as hashes; replacing or deactivating a code stops it at once), held orders that reach the kitchen only when staff accept them in the Órdenes inbox or collect payment first (pay-first, with a manager's PIN-confirmed exception), DB-enforced caps per table, code and restaurant with a churn budget, per-IP limits, printable table QR cards (Mesas), pause and automatic pause when no shared terminal is online, abuse rejection that deactivates a code, and the DB-9 value constraints (032 `NOT VALID`, 033 `VALIDATE`). No online card payment: diners pay staff. Kill switch `PUBLIC_ORDERING_ENABLED` (account 031). Tests: `tests/public-ordering.test.ts`, `tests/public-kiosk.test.ts`, `tests/public-ordering-http.test.ts`, `npm run test:db:public`, `tests/browser/public-ordering.spec.ts` and the QR legs of `menu.spec`, `core.spec`, `security.spec` and `account.spec`. Pending: a staging browser run, QR scanners of real phones and card printing on thermal printers (field checks in PUBLIC_ORDERING.md). |
| Native iOS/Android wrappers | Optional follow-on | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Ingredients, recipe links, substitutions, costs | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Stock item setup (g, kg, ml, l, pieces; raw or prepared; reorder point, par level, opening stock, unit lock, archive), product and choice recipes with g↔kg and ml↔l entry, line cost including choice costs, append-only recipe versions and historical line cost snapshots. Locally verified on `track/menu` (`npm run test:db:menu`, browser); staged 2026-10-07. Substitutes and automatic costing pending. |
| Suppliers, purchase orders, receiving | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Supplier creation and merchandise receipt/expiry metadata. Purchase orders and lot depletion pending. |
| Raw-to-prepared inventory, portions, availability | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Prep input/output ledger and prepared-component consumption (stock rows locked in one global order); live product and choice availability with required-choice sold-out detection in POS and QR. Yield/cost allocation policies pending. |
| Counts, waste, expiry, suggested variances | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Cached theoretical balance kept by a ledger trigger (no history sums at sale time), per-restaurant negative-stock policy (allow and flag by default, block opt-in; offline cash always recorded), dated Negativo flag that is never labelled a shortage, stock-version count adjustment against the cached balance, explicit waste and a suggested order from the par level. Locally verified on `track/menu` (`npm run test:db:menu`, `npm run test:db:core`, browser); staged 2026-10-07. Saved count drafts and expiry alerts pending. |
| Fixed/variable/recurring expenses | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Fixed/variable expense entry. Recurrence and full report treatment pending. |
| Sales/margins/commission reporting | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Today source-record drill-down, order totals, tender/refund/tip totals, estimated COGS. Oct 5 (fiscal 027): IVA summary by business-date range and ticket register with CSV. Oct 6 (reports 029, local): Finanzas with sales, IVA, collections, margin, breakdowns and CSV. Fee/commission reporting pending (no providers). |
| Forecasts/break-even/owner alerts | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Pure forecast arithmetic and insufficient-history state. Historical aggregation, editable scenarios and actionable alerts pending. |
| CSV/manual sales and delivery settlement imports | 4, required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Reviewed catalog JSON import for both source labels with mappings and deduplication. Historical sales/summary/delivery reconciliation pending. |
| PDF reports and scheduled summaries | 4, required generation; sending when configured | See DELIVERY_STATUS.md and corresponding M1–M9 section | Reports (029, local): browser print / "Guardar como PDF" of the corte del día and report sheets on letter/A4. Scheduled and emailed summaries pending (no mail provider). |
| Cash sessions, paid-outs, end-of-day | 2, required | See DELIVERY_STATUS.md and DISCOUNTS.md | Device drawer opening, paid-outs; cash and terminal totals apart (only cash refunds and cash tips in expected cash); blind count by default with role-configurable visibility and closing, closer attribution, terminal batch total, immutable closed drawers and one manager review per difference (migration 028, local). Saved close draft pending. |
| Team, shifts, payroll/tips summaries | 5, required; not legal payroll certification | See DELIVERY_STATUS.md, ACCESS.md and corresponding M1–M9 section | Staff add/edit/role, PIN reset (including the owner's own terminal PIN), deactivate/reactivate with session revocation and unlock implemented and locally verified (access DB and browser suites). Shift start/end and estimated hourly payroll list. Tip distribution and payroll policies pending. |
| Onboarding, account, subscription billing | 5, required; billing provider sandbox gate | See DELIVERY_STATUS.md and corresponding M1–M9 section | Owner onboarding, 14-day no-card trial, durable sandbox subscription billing, location quantity changes and Free device/team/location limits implemented. Account (031, locally verified October 5, 2026): signup legal acceptance, lapse drawer continuation, automatic Free slots, POS plan notices, support pilot grants; SaaS tax mode off by default. See BILLING_IMPLEMENTATION.md and FREE_LIMITS.md; live billing is not enabled. |
| CFDI invoice/customer self-service/cancellation | 5, configured module; required before invoice cutover | See DELIVERY_STATUS.md and [CFDI](CFDI.md) | Built (030) on fiscal 027, discounts 028 and reports 029: stamping, egresos (from fiscal's `recordRefundTax`), self-invoice, cancellation, Hoy alerts and corte coverage are DB- and browser-tested against the Facturapi fake (`tests/cfdi-merge-gate.test.ts` keeps the compat shims out); contract-tested. Oct 7 (LD-51, local): the shared-sandbox flows passed against the real Facturapi sandbox (activation, five sales, física and moral portal invoices with the RESICO retention exact, a cancellation, a daily global and a late supplementary part); its findings fixed with migration 036 and two review rounds (LD-55, LD-58, LD-62), verified against the fake (integration only until the release merges). 030 staged with the test key (`sandbox_shared`); live not enabled. Remaining: the `organizations` provider (User key, CSD, going live), live cancellation acceptance, credit notes and substitution in the sandbox, the RESICO monthly close, real email, receptor-name validation, Base vs Importe rounding (accountant), live qualification with a real CSD, webhooks, multi-ticket invoices, foreign receptors. |
| Uber Eats/Rappi/DiDi imports and connectors | 4–5; live connectivity gated | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Courier dispatch (Uber Direct) | Optional configured module | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Loyalty/stamps/referrals | 5, configured module | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Apple/Google wallet passes | Optional configured module | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| SMS/WhatsApp and voice operations | Optional configured module | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| AI receipt/menu parsing and recipe matching | 4–5, optional assist; manual flow required | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Kiosk suggestions, menu boards/displays | Optional follow-on | See DELIVERY_STATUS.md and corresponding M1–M9 section | Not implemented. |
| Incident monitoring / AI sentinel | 6 baseline; advanced optional module | See DELIVERY_STATUS.md and corresponding M1–M9 section | Partial: structured logs and request ids, `/api/ops/status`, watchdog and dead-job alerts, optional Sentry; locally verified 2026-10-05 (`tests/ops-http.test.ts`, `tests/drain-http.ts`, `tests/browser/ops.spec.ts`). Since 2026-10-07 the worker jobs runner, migrations from GitHub Actions and the signing keyring run on staging. Hourly uptime and backup-freshness workflow written; pending its first scheduled run (`OPS_LIVE_ENVIRONMENTS` not set yet). Alert channel setup (none on staging) and incident staffing pending; AI sentinel not implemented. |
| Financing, settlement/disbursement, marketing/site fragments | Outside base scope | See DELIVERY_STATUS.md and corresponding M1–M9 section | Excluded from base POS per approved matrix. |

## Acceptance inventory

These inherited statuses remain conservative. The recovery evidence below
supersedes older descriptions of missing manager recovery, but does not silently
mark full scenarios complete. Each ID remains a release gate from ACCEPTANCE.md.

| Scenario | Status | Evidence / outstanding work |
| --- | --- | --- |
| UX-01 | partial | One picker for required, optional and repeatable choices with blocked invalid combinations, live price and the cart visible; taquería build-and-sell flow browser-tested (`tests/browser/menu.spec.ts`, local). The three-item task with a modifier is measured by the restaurant-day gate (local, October 7–8: 8 taps, modelled 10.5 s; ACCEPTANCE_STATUS.md); production-latency measurement pending. |
| UX-02 | partial | Cash checkout and receipt tested; the restaurant-day gate asserts 2 primary activations from a prepared cart to confirmation (local, October 7–8). |
| UX-03 | partial | Additional rounds, table/server reassignment and creator/round preservation tested; full dine-in table lifecycle (send, serve, dessert round, pay, Liberar mesa) browser-tested locally Oct 5; staging pending. |
| UX-04 | partial | KDS acknowledgement/ready/served, recall, new-ticket alert and independent payment browser-tested locally (Oct 5); complete multi-device service scenario pending. |
| UX-05 | partial | Amount/item splits, lost cash-response recovery and reload tested; integrated provider failure recovery pending. |
| UX-06 | verified | Browser grouped cash settlement retains separate order IDs, tenders and rounds. |
| UX-07 | partial | Draft persistence implemented; resume and draft restore park the unsent cart (browser-tested Oct 5); complete parked-ticket restart scenario pending. |
| UX-08 | partial | Cash discrepancy links and inventory evidence implemented; full alert correction scenario pending. |
| UX-09 | partial | Count adjustment computed against the cached balance of the locked row, with the stock version refusing a count started before a concurrent sale (`npm run test:db:menu`, local). Saved count workflow and reviewed adjustment pending. |
| UX-10 | partial | Drawer close and refund tested; blind close with cash and terminal tips, refunds and paid-outs split by method tested locally (`tests/browser/discounts.spec.ts`, `test:db:discounts`); saved close draft pending. |
| UX-11 | partial | Selling/cart and item-payment screenshots at all four sizes; fixed payment footer and mobile confirmation checked; 10-inch landscape (1024×768) cart keeps three dine-in lines fully visible (Oct 5). All-workspace review pending. |
| UX-12 | partial | Keyboard search, modal dismissal/focus and one-state axe check; full screen-reader review pending. |
| UX-13 | pending | Restaurant settings persist with English labels, timezone/cutoff/opening days. Organization switching and complete locale acceptance pending. |
| UX-14 | partial | Catalog import and cash sale independently verified; complete onboarding flow pending. |
| CORE-01 | partial | Canonical quote shared by POS/QR/kiosk/sync, now including choice counts, open amounts with a ceiling (staff channels only) and merged choice recipes; `selectionIssue` agreement test (`tests/menu.test.ts`). Offline sync still quotes without open price until the offline track merges. Tax configuration done (fiscal 027): restaurant fiscal profile and default, per-product tax category, server fiscal context in every server quote. Promotions pending. |
| CORE-02 | verified | Eight parallel same-ID creates produce one order/stock effect; altered payload conflicts. |
| CORE-03 | pending | Integrated provider events/reconciliation not implemented. |
| CORE-04 | pending | Committed cash response loss and original-operation recovery tested; integrated provider crash/restart recovery not implemented. |
| CORE-05 | partial | Concurrent cash/item collection and lost-response recovery tested; integrated cards pending. |
| CORE-06 | partial | Money/remainder/unit arithmetic and partial item units tested; full and partial discounts as unit allocations that never exceed a unit's due (property-tested) and item splits charging the discounted due tested locally (discounts 028). Live taxes (fiscal 027): tax-inclusive IVA extracted per category with SAT-valid rounding, tickets reconcile to the order total (DB-checked), refund IVA by complement extraction (`tests/fiscal.test.ts`, `tests/fiscal-db.ts`). Promotions, IEPS and CFDI pending. |
| CORE-07 | partial | Recipe/price edits retain historical snapshots; new orders retain restaurant configuration. Tax snapshots (fiscal 027): every line keeps an immutable tax snapshot from the server's fiscal context, including offline sync; a tax edit bumps the product version and sends queued offline sales to review. Acceptance run pending. |
| CORE-08 | partial | Device PIN, CSRF and cashier management denial tested. Access (locally verified October 5, 2026): manager approval by chosen manager and PIN with per-device throttling, step-up on terminals for refunds/paid-outs/self-approved voids, staff deactivation revoking sessions, unpairing the employee's personal devices and blocking Google re-entry, device unpairing, pairing codes, void retries after a lost response. Pending: staging run; invited-member removal and co-owner lifecycle (account area). |
| CORE-09 | partial | Two-tenant RLS/FK and public QR tamper checks; public ordering (032): a code resolves only through its hash's lookup policy, malformed codes are refused before the database, and a status key or hold of another restaurant is not found (`tests/public-ordering-db.ts` 4, 22, 29, 30, 32). Invoice/webhook/print/upload/org routes pending. |
| CORE-10 | partial | Missing context, rollback reuse and least-privileged role tested locally; tenant transactions set `statement_timeout` with the tenant in one statement, role defaults via `ALTER ROLE` and verified TLS off-host (`tests/ops-db.ts`, `tests/provision-db.ts`, 2026-10-05); Neon pooled/direct pending. |
| CORE-11 | partial | Refund caps per tender and per unit (code and triggers, 20 concurrent refunds), reason and approver validation, item refunds of paid units, recorded terminal refunds and amount refunds only on paid checks tested locally (discounts 028); integrated provider refunds pending. |
| OFF-01 | partial | Compiled offline refresh/reconnect, reload during an API outage and exactly-once replay pass locally (`offline.spec.ts`, `offline-sync-db.ts`); staging and real-device close/reopen remain. |
| OFF-02 | partial | Lost committed cash response, idempotent payment retry, reuse of an online order whose response was lost, exact payment fingerprint/status and interrupted tab recovery pass locally; full process-restart HTTP matrix remains. |
| OFF-03 | partial | Two tabs serialize sync; closing the lock holder recovers its syncing row. Concurrent sync/reconcile and sync/archive of one record apply exactly once (`offline-sync-db.ts`). Staging pending. |
| OFF-04 | partial | Redefined: transient failures never exhaust or become conflicts and attempts are not counted offline (`offline-policy.test.ts`, `offline.spec.ts` with 503 responses); a later record of the same order waits behind one retrying a 5xx instead of being refused out of order (`offline-tables-store.test.ts` "a 5xx on the round leaves the payment pending…"); every conflict can be reconciled or archived (`offline-sync-db.ts`, `offline.spec.ts`). Locally verified; staging pending. |
| OFF-05 | partial | Server repricing refuses price and product-revision changes; review never throws for evidence; lease-cited config change stays reconcilable; manager cash review, immutable evidence, kitchen/stock review, old-drawer corrections and refund cap pass locally; remaining refund browser matrix pending. |
| OFF-06 | partial | Tenant-bound atomic backups (v1/v2/v3), wrong-tenant rejection, parked review-required payment attempts, ended-session evidence auto-syncing for the same employee and device, and revoked-session manager recovery pass locally (`offline-sync-db.ts`). Since access merged, logout, switch, PIN reset and role change end the session without revoking it, logout first syncs and warns about unsent sales, and the offline window renews while the device is in contact (`npm run test:db:access`: "OFF-7 regression: logout ends without revoking…", "OFF-3: renewal appends an immutable row…"). The combined DB and browser run on the integration branch is pending. |
| OFF-07 | partial | Item split disabled and refused offline; settlements, voids, refunds, discounts and drawer operations unavailable offline (they need the server and fail with a connection message); external terminal recording requires reference and confirmation; kitchen tickets say they are not network deliveries; no provider offline capability claimed. |
| OFF-08 | partial | Build id baked into the worker; a failed install leaves the old revision intact and an offline reload still renders; the update prompt applies only with nothing unsynced (`sw-shell.test.ts`, `offline.spec.ts`). Exact staging update proof between two deployed builds pending. |
| OFF-09 | partial | API down with the browser online, HTML 502 and a hung server switch to offline selling and sync on recovery (`offline.spec.ts`, Chromium and emulated WebKit iPad); manual offline mode never blocks the next employee's sign-in ("Manual offline mode never locks the device at sign-in…"). Real ISP outage pending. |
| OFF-10 | partial | Kitchen tickets print and stay on the device, and a receipt prints only the round its checkout added ("Imprimir comanda prints the new round…"); KDS review lane decisions per station and its 10 s / 30 s cadence pass locally (`offline.spec.ts`, `offline-policy.test.ts` "lanePollDelay…"). Since service merged, the live KDS excludes those rounds (D13: kitchen feed, previous-day clearing and the legacy kitchen list) and the lane sits above its tickets for the station on screen; real printer pending. |
| OFF-11 | partial | External terminal offline sales and provisional numbers mapped at sync pass locally. Offline table service (`feat(offline-tables)` series) ships off by default as a per-restaurant beta (LD-7); both settings are tested, the off path in the default fixture ("With offline table service off…", "Open orders are never fetched…", `offline-sync-db.ts` section 22). With it on: cached open orders (including the order on screen when the connection drops), Enviar offline, additive rounds, full and partial payments, dependency ordering, closed targets, balance revalidation, clock-independent balances, the online payment guard, reconciled payments counted once, synced local orders that closed online never served again, rounds on paid checks refused with "Enviar como orden nueva" (the §7.4 tests "a round on a cached server order with zero projected balance…", "a round on a local order paid in full…", "a payment with an inline round on a zero-balance order…", "a round on a cached order with a positive balance…"), reuse of a lost online create only at the server's price, and lines already sent online pass locally (`offline-sync-db.ts`, `offline-tables-store.test.ts`, `offline.spec.ts`). Staging and real devices pending. |
| OFF-12 | partial | Fast device clock syncs; a device clock set back after a ping neither reopens the offline window nor backdates a record, and stops offline saves until the next ping (`offline-clock.test.ts`, `offline-store.test.ts`); out-of-window and unverifiable evidence archived with a reason unblocks drawer close (`offline.spec.ts`, `offline-sync-db.ts`). Locally verified. |
| OPS-01 | pending | Printer jobs explicitly blocked; the jobs runner never touches blocked jobs and provides lease fencing, retries and restart resume for a future printer handler (`tests/jobs-db.ts`, 2026-10-05). Printer worker/hardware recovery pending. |
| OPS-02 | partial | Persisted KDS rounds; versioned single-flight polling with backoff and a stale banner browser-tested locally (Oct 5); disconnect recovery on staging pending. |
| OPS-03 | pending | Durable jobs outbox locally verified: one job per (tenant, kind, dedupe key), two runners never lease the same job, bounded retries then dead with an alert (`tests/jobs-db.ts`, 2026-10-05). Wave 2.0 (2026-10-05, local with CI parity): per-kind retry limits, deferred jobs (`runAt`), and a worker runner whose login can claim only through tenant-scoped policies (cross-tenant claim and fence regressions in `tests/jobs-db.ts`). Report/email handler not implemented. |
| INV-01 | partial | Receiving/preparation/sale/void return/count/waste ledger with a trigger-maintained cached balance that equals the ledger after every cause (`npm run test:db:menu`, local). Complete chained cost reconciliation pending. |
| INV-02 | verified | Configured per restaurant. Under `block`, concurrent last-portion sales serialize and exactly one succeeds; under the default `allow`, the sale proceeds and the item is flagged; offline cash already collected is always recorded (`npm run test:db:core`, `npm run test:db:menu`, browser; local, not staged). |
| INV-03 | partial | Causal movement deduplication (also enforced by the ledger trigger for repeated inserts), recipe versions per group edit and DB-5 global lock order tested; refund restock returns the recipe once per refund line, without double counting on retries (discounts 028, local). Substitutes pending. |
| INV-04 | partial | Counts use the cached balance, which includes receipts, prep input/output, sales, waste and earlier adjustments, with the stock-version cutoff; the Negativo flag states it does not indicate a shortage by itself. Saved count scenario pending. |
| FIN-01 | pending | Historical summaries and settlement import not implemented. |
| FIN-02 | partial | Basic order/tender/refund/tip source totals; discounts stored per order and per unit, refunds by method with a business date per batch, drawer cash and terminal totals apart (discounts 028, local). Tax definitions (fiscal 027): IVA by ticket business date, refund IVA by refund date, `fiscalSummary` for reports. Reports (029, local): the metric contract with six reconciliation checks over three date lenses. Fee/commission definitions pending. |
| FIN-03 | partial | Pure forecast identity tested; editable historical scenarios not implemented. |
| FIN-04 | partial | Business cutoff, DST and leap-day unit tests; `business_date_at()` equals `businessDate()` on 10,000 instants incl. Tijuana DST, the cutoff instant and settings history (`tests/reports-db.ts`, local); the report statements against fiscal and discounts (`tests/reports-phaseb-db.ts`, local). |
| MIG-01 | partial | Both normalized catalog fixtures dry-run; mapping rerun/no side effects DB-tested; historical mappings pending. |
| MIG-02 | partial | Import transactionality implemented; kill-mid-import rehearsal pending. |

## New recovery evidence

- `tests/offline-sync-db.ts` (wave 1, migration 026): exactly-once v3 sale sync and
  replay, external terminal tenders, business date from the sale time, clock
  tolerance and clamping, lease-cited configuration, authenticity vs eligibility,
  archive idempotency and sync/archive races, reuse of a committed online order
  (only at the server's price), overpayment refusal, negative stock for offline
  sales, repricing, lines already sent online, rounds on paid checks, drawer guard
  and late reconcile, kitchen review lane, device prefixes, revoked vs ended
  sessions, legacy `/sync` compatibility, RLS, grants, immutability, pagination,
  heartbeat, and the LD-7 table-service setting (off by default, managers only,
  audited, gating the open-orders snapshot but never sync).
- `tests/offline-recovery-db.ts`: automatic/legacy replay, revoked-session manager
  recognition, price/recipe/settings/permission conflicts, exact payment status,
  original-drawer checks, two-writer deduplication, concurrent task completion,
  close/recovery serialization, historical drawer visibility, bounded refunds.
- `tests/browser/offline.spec.ts`: API down and HTML 502 with the browser online,
  hung server, reload during an outage, manual offline mode (including sign-in),
  parked payment attempts, transient retries, offline kitchen tickets and the
  round a receipt prints, KDS review lane per station and its cadence, fast device
  clock, archive and drawer close, service-worker update, 768 px state,
  persistence, manifest, browser gate, no polling, pruning, and table service off
  by default and on (cached checks, rounds, paid checks, synced orders paid
  online). `@cross` tests also run on Playwright's emulated WebKit iPad, which is
  not real-device evidence.
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

## Wave 2.0 platform evidence (2026-10-05, local with CI parity)

Built on `track/platform` and qualified locally against databases migrated as
the non-superuser `gm_migrator` under FORCE RLS, exactly as CI. Since then CI runs on
GitHub, and the staging cutover (RUNBOOK "Staging cutover", Wave 2.0 deltas) ran on
2026-10-06/07 ([STAGING.md](STAGING.md), "Wave 2.0 cutover record"):

- worker jobs runner on `WORKER_DATABASE_URL` (`checkWorkerRole`, discovery,
  `jobs` health loop): `tests/jobs-db.ts`, `tests/ops-db.ts`,
  `tests/drain-http.ts`, `tests/import-graph.test.ts`;
- OPS-10 keyring and sealed tokens (production refuses pre-2.0 tokens):
  `tests/keyring.test.ts`, `tests/tokens.test.ts`, access and menu DB suites
  with a synthetic `SIGNING_KEYS`;
- migrations, grants and retention in GitHub Actions (exit 75 retries):
  `tests/migrate-db.ts`, `tests/retention.test.ts`, `tests/workflows.test.ts`;
- capability roles from `globals.sql` and the worker login in provisioning:
  `tests/provision-db.ts`;
- the global lock order and its ratchet (`docs/ARCHITECTURE.md`,
  `tests/lock-order.test.ts`), and the negative-stock policy deadlock fix
  (`tests/menu-db.ts`).

## Account 031 evidence (2026-10-05, local with CI parity)

Built on `track/account` and qualified locally on databases migrated as
`gm_migrator` under FORCE RLS; staged 2026-10-07 (smoke only; no account flow exercised on staging, and the legal documents are unpublished there):

- legal documents, configuration and acceptance gating: `tests/legal.test.ts`,
  `tests/account-db.ts` (checks 1–8), `tests/browser/legal.spec.ts`,
  `tests/browser/account.spec.ts` (signup, material change);
- co-owners, transfers and recovery: `tests/account-db.ts` (checks 9–27),
  `tests/support-db.ts`, `tests/browser/account.spec.ts`;
- owner data export: `tests/account-export.test.ts`, `tests/account-db.ts`
  (28–29d), `tests/account-http.ts`, browser downloads and the terminal PIN
  step-up;
- plan lapse (continuation, automatic Free slots, notices):
  `tests/plan-notice.test.ts`, `tests/free-limits-db.ts`,
  `tests/browser/free-limits.spec.ts`, `tests/browser/account.spec.ts`;
- SaaS tax mode and canceled `ended_at`: `tests/saas-tax.test.ts`,
  `tests/stripe-billing.test.ts`, `tests/stripe-catalog.test.ts` (synthetic
  Stripe responses only);
- the public-ordering switch: `tests/public-ordering-flag.test.ts`,
  `tests/account-http.ts`, browser diner and generator checks;
- the restaurant privacy URL, 031 RLS and grants: `tests/account-db.ts` (30–32),
  `tests/support-db.ts`.

## Public ordering 032/033/034 evidence (2026-10-06, local with CI parity)

Built on `track/public` (Phase A plus B1-B4 on fiscal 027, discounts 028,
reports 029, cfdi 030 and account 031) and qualified locally on databases
migrated as `gm_migrator` under FORCE RLS; staged 2026-10-07 after the DB-9 check returned 0 rows on staging (smoke only; no QR flow exercised there). Audit
findings SEC-7 (bearer links without revocation), FIT-11 (unpaid QR orders
reaching the kitchen), FOH-13 (tables not bound) and the DB-9 remainder:

- SEC-7, revocable opaque codes: `tests/public-ordering.test.ts` (tokens,
  hashes, limiter keys), `tests/public-ordering-db.ts` 4-8 (lookup policy,
  table links, rotation, revocation, caps), 38 (a code revoked by another
  process stops at once), `tests/public-ordering-http.test.ts`, browser
  "revoke and rotate";
- FIT-11, held orders and pay-first: DB 9-12 (a hold creates nothing on the
  sales side; idempotency; pricing; durable caps), 15-21 (accept, append,
  atomicity, pay-first with a manager's exception, exclusions, reject,
  cancel), 23-24 (concurrency and the lock order under `noRetries`), 33,
  36-45; browser "table QR end to end", "append", "reject and restore",
  "pay-first kiosk", "price change", "abuse";
- FOH-13, tables bound: DB 5 and 14 (one active code per table; an archived
  table blocks its code; a pending hold blocks archiving and counts as
  occupancy), browser "inbox details";
- DB-9: DB 1+3, 1b and 2 (032/033 as a non-superuser owner, validation of
  another tenant's rows, RUNBOOK's check and repair run as written: they find
  and fix a bad row in each column as a Neon-owner-like BYPASSRLS role and
  fail as the owner instead of passing; every allowed value writable and
  nothing else);
- account integration (B3): DB 28 (account's gate before any limiter), 30
  (account's privacy URL on the diner menu), 31 (the export drops the three
  hash columns), `tests/account-http.ts` checks 2-3, `account.spec` QR legs;
- LD-5 round 2 (LD-41, 034): DB 22 (030) and 26 (the self-invoice code only
  for the payer), 41 (the paid-accept grace), 14 and 28 (the kill switch on
  Mesas and archiving), 46 (control characters), 21, 25 and 47 (034's
  redaction exception, ARCO without a table lock), 48 (the 30-day retention
  redaction), `tests/migrate-db.ts` (the no-transaction grants hook),
  `tests/lock-order.test.ts` (the public LO-3/LO-4 objects), browser legs
  for the kill switch's recovery, the refused terminal charge, the privacy
  notice warning, and the table-QR and pay-first kiosk tests on
  `webkit-ipad`.

## Wave 3 evidence (2026-10-08, local with CI parity, and staging)

- Restaurant-day go-live gate (LD-57, LD-59, LD-60): two fictional business days
  through the UI on a production-mode web and worker, then D1–D19; branch N green
  twice in a row and branch K green against the Facturapi fake, 0 waivers
  ([ACCEPTANCE_STATUS.md](ACCEPTANCE_STATUS.md), "Restaurant-day go-live gate").
  The workflow `restaurant-day.yml` reaches `main` with the release pull request;
  two consecutive green CI runs pending.
- CFDI against the real Facturapi sandbox (LD-51, local): all nine rehearsal goals
  passed; fixes in migration 036 (`docs/CFDI.md`, "Rehearsal fixes").
- Client address behind Railway (LD-46): verified on staging with a header-echo
  service; the CD smoke's `client_ip` check green since deploy run 37603422529.
- Staging cutover and rotations (LD-47): [STAGING.md](STAGING.md), "Wave 2.0 cutover
  record" and "Credential rotation log".
- W3-1 polish and W3-2 flake fixes (LD-42, LD-45, LD-50, LD-52): qualification on the
  merged trees (1279 unit, 548 DB, 257 browser incl. `@cross`, load smoke 0 errors at
  the W3-2 merge).

## External prerequisites

No printer/payment provider selected. No approved historical source exports or
source/target migration mapping. Configured invoice, mail, asset-upload and live
connector modules require their actual scope and sandbox credentials. Production
cutover requires a named target/window after all required implementation and
qualification; GitHub publishing alone does not meet these gates. The owner's inputs
(R2 credentials and age key, an alert topic, legal values after counsel, the
accountant's sign-off, the Facturapi User key, the production domain) are listed in
[LAUNCH_HANDOFF.md](LAUNCH_HANDOFF.md) section 1.
