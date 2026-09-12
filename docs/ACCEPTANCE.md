# Acceptance and verification

These are tests for the future application. They have not been run by this handoff. The implementation agent must attach actual results, screenshot paths, environment/commit identifiers, and any unrun checks to the release report.

## Product verification

| ID | Scenario | Required result |
| --- | --- | --- |
| UX-01 | Cashier adds three items, one with required modifiers | One modifier drawer; cart and amount remain visible; invalid combinations blocked |
| UX-02 | Exact-cash checkout from a prepared cart | At most three primary activations to confirmation; optional receipt sharing does not delay next sale |
| UX-03 | Table opens, receives first round, then another round | Same table/order lineage; only new/changed lines reach kitchen |
| UX-04 | Kitchen marks ready and server completes service | One purposeful progress action; payment remains independent; seen state truthful |
| UX-05 | Split payment succeeds for one payer, fails for another, then reloads | Successful allocation retained, remaining due correct, no duplicate charge |
| UX-06 | Two orders are paid together | Settlement allocations match; kitchen tickets and identities remain separate |
| UX-07 | Cashier parks a ticket, navigates, reloads, resumes | Products, modifiers, service mode, notes, and pricing lineage preserved |
| UX-08 | Owner selects an unusual waste/cash alert | Opens source evidence and permitted corrective action; no generic dead-end toast |
| UX-09 | Manager enters a physical count during sales | Clear cutoff/version, correct variance calculation, reviewed adjustment |
| UX-10 | Cash drawer close with tips/refunds/paid-out | Expected/count/discrepancy visible with drill-down; saved draft and final audit |
| UX-11 | Same tasks at 1440×900, 1024×768, 768×1024, 390×844 | No hidden checkout controls, clipped dialogs, page-wide horizontal scrolling, or unreachable actions |
| UX-12 | Keyboard/screen reader/reduced motion | Focus order and restoration correct; named controls, announced results, non-color statuses |
| UX-13 | Spanish/English switch and restaurant switch | Complete translations; correct currency/date scope; no cross-restaurant cart/data bleed |
| UX-14 | New owner imports a menu then makes first demo sale | Reviewable import, clear setup steps, functioning catalog; no integration credentials needed for demo cash |

## Order, money, and authorization

- CORE-01: The same item/modifier/discount input through POS, QR, kiosk, and online sync validation produces the same authorized quote. Tampered totals, prices, tenant IDs, and modifier IDs are rejected/recomputed.
- CORE-02: Parallel create requests using the same operation ID create one order; a changed payload with that ID is a conflict. Parallel order numbering is unique within its scope.
- CORE-03: Duplicate provider events and retries produce one tender, one stock effect, and one durable receipt/event set. Verify mismatched amount, currency, merchant, and tenant are rejected.
- CORE-04: Kill/restart the app before and after provider response, DB commit, and browser acknowledgement. Recovery resolves the saved attempt without blindly charging again.
- CORE-05: Concurrent cash/card/split requests cannot overcollect or overwrite allocations. Pending/unknown payments visibly block unsafe duplicate collection.
- CORE-06: Test one-cent remainder splits, quantity splits, tips, inclusive/exclusive tax configuration, full/partial discounts, refund caps, fractional costs, invalid numbers, and safe range bounds.
- CORE-07: Price/tax/recipe changes do not alter historic receipts, accepted offline money, cost snapshots, or report history.
- CORE-08: Wrong role, changed/revoked PIN, expired session, mismatched device, replayed approval, and unauthorized restaurant switch are denied server-side.
- CORE-09: Across two tenants, test authenticated routes, guessed IDs, forged headers, QR/menu/cart access, receipt links, public invoice flows, kiosks, webhooks, print agents, uploads, exports, and organization aggregates.
- CORE-10: A missing tenant transaction cannot fall back to privileged access. Check RLS reads/writes, cross-tenant foreign keys, connection reuse after rollback/error, and pooled/direct behavior.
- CORE-11: Refund/void preserves the original financial record and validates reason/approver. Stock disposition is explicit; already prepared goods do not automatically return to usable stock.

## Offline and operational recovery

- OFF-01: In an eligible authenticated offline session, create a cash order, refresh/close/reopen, reconnect, and sync twice. One server order/tender/stock effect; local receipt survives.
- OFF-02: Disconnect after server commit but before response. Retry recovers the original result.
- OFF-03: Open two tabs/restart mid-sync. Leases and server deduplication prevent duplicate effects.
- OFF-04: Exhaust automatic retries. Queue remains visible and recoverable; no silent loss.
- OFF-05: Change catalog prices, availability, permissions, or account status before sync. Show explicit reconciliation for already collected cash; never silently change the paid amount.
- OFF-06: Switch restaurant/logout with pending orders. Data remains isolated and only authorized recovery can access it; pending sales are retained.
- OFF-07: Try offline integrated card/invoicing/protected override. Action clearly unavailable unless a tested specific offline capability exists. Kitchen status does not claim remote delivery.
- OFF-08: New application/service-worker version arrives during checkout or pending sync. Update defers safely and pending data survives migration.
- OPS-01: Printer offline, paper/acknowledgement uncertain, duplicate job delivery, worker restart. Payment stays correct; job state and reprint audit explain recovery.
- OPS-02: KDS disconnects and reconnects after new rounds/cancellations. No lost changes, duplicate sound bursts, or stale state shown as current.
- OPS-03: Report/email job runs twice or fails midway. One logical report per period; retriable delivery; no duplicate unbounded sending.

## Inventory and owner reporting

- INV-01: Purchase raw stock → prep into portions → sell → refund with chosen disposition → count/waste. Ledger, available quantity, cost, and displayed variance reconcile.
- INV-02: Two cashiers compete for the last available component. The configured reservation/oversell policy is enforced atomically and the exception is visible.
- INV-03: Duplicate payment/edit/void/refund events cannot double deduct/restore. Units and substitute recipe costs are validated.
- INV-04: Count expected quantity includes receipts, prep input/output, sales, waste, earlier adjustments, and concurrent movement cutoff. A discrepancy is not automatically labeled theft.
- FIN-01: Paid orders, historic weekly summaries, manual sales, and delivery settlements covering the same revenue are not added together.
- FIN-02: Report totals reconcile with tender/refund/cost records by restaurant/currency/business day. Taxes/tips/fees and cash overages/shortages stay distinct.
- FIN-03: Profit in every forecast period equals forecast sales minus forecast costs on the displayed basis. Missing/partial weeks and unknown costs are marked; no-data states are meaningful.
- FIN-04: Test local midnight, configured business-day cutoff, month/year boundaries, leap day, and a timezone with daylight-saving changes. Use half-open ranges without double counting boundary records.
- MIG-01: Import both source fixtures, inspect exceptions, commit, and rerun. Counts/totals/IDs remain stable; no outbound or stock side effects replay.
- MIG-02: Import interrupted halfway resumes or rolls back safely and reports the batch's actual state.

## Performance and UX evidence

Create a documented reference dataset: two tenants, 300 catalog items, realistic modifiers, 50 active orders, and enough dated transactions to exercise reporting. Use fictional restaurant/customer information. Add larger datasets for server/report queries where needed.

Record hardware/browser, viewport, network profile, cache state, database region/size, source/target commit, and dataset. Suggested product budgets: cached add-item feedback ≤100ms, warmed core reads p95 ≤400ms and local mutation APIs p95 ≤700ms under the declared 10-user pilot load, KDS appearance ≤2 seconds under healthy network conditions. These are proposed acceptance targets, not existing measurements or provider guarantees. Report cold starts and external payment waiting separately.

Measure source and target task completion time, primary activations, validation/recovery errors, and operator confusion when comparable baselines are available. Aim for ≥30% fewer navigation steps on the common workflows that need improvement, while meeting the explicit checkout target. If a source cannot be run safely, say the comparison is unavailable and report absolute target results only.

Capture screenshots of selling, modifiers, payment, pending payment recovery, tables, kitchen, offline queue, inventory count, owner summary, and mobile cart. Run automated accessibility checks plus manual keyboard/focus review. Do not substitute a numeric audit score for successful operation of the critical workflows.

## Release evidence

Required commands should exist and pass: clean install, lint, typecheck, unit tests, isolated database integration tests, browser tests, build, migration dry-run, and staging smoke. The implementation agent chooses exact command names and documents them.

Tests must refuse the production database by default, check an explicit test target/allowlist, and use non-production provider keys or mocks. Never inherit the source hardcoded test hostname. Provider mocks cover failure logic; sandbox/hardware checks are separately labeled and cannot be implied by passing mocks.

Release report: commit, implemented feature matrix, test results, measured UX/performance evidence, screenshots, configured adapters and sandbox/device verification, migration reconciliation, staging URL, operational runbooks, and explicit optional/blocked items. Live cutover needs a verified target and approved migration window.
