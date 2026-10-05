# Acceptance coverage

This file supplements ACCEPTANCE.md; it does not weaken its requirements. **Partial means the required scenario is not yet satisfied.** External staging/provider blockers are in DELIVERY_STATUS.md.

| Scenario | Status | Evidence / missing work |
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
| CORE-08 | partial | Device PIN, CSRF and cashier management denial tested. Manager approval is verified server-side for the exact void request, never stored, and failed approvals count toward a per-employee lockout (tests/voids-db.ts). Membership lifecycle and replayed-approval checks for other sensitive actions pending. |
| CORE-09 | partial | Two-tenant RLS/FK and public QR tamper checks; invoice/webhook/print/upload/org routes pending. |
| CORE-10 | partial | Missing context, rollback reuse and least-privileged role tested locally; tenant transactions set `statement_timeout` with the tenant in one statement, role defaults via `ALTER ROLE` and verified TLS off-host (`tests/ops-db.ts`, `tests/provision-db.ts`, 2026-10-05); Neon pooled/direct pending. |
| CORE-11 | partial | Cash refund reason, original tender immutability and no automatic stock return. Item voids keep the original line snapshot, record reason/actor/approver, refuse paid units and return stock only before the kitchen sees the ticket (tests/voids-db.ts). Item-level refund and provider cases pending. |
| OFF-01 | partial | Compiled offline refresh/reconnect and duplicate replay pass; complete browser close/reopen matrix remains. |
| OFF-02 | partial | Lost committed cash response, exact payment fingerprint/status and interrupted tab recovery pass; full process-restart HTTP matrix remains. |
| OFF-03 | partial | Two tabs serialize sync; closing the lock holder recovers its syncing row. Concurrent server sync/reconciliation deduplicates. |
| OFF-04 | partial | Eight failed automatic attempts stop with evidence retained; explicit retry verified using transport mocks. |
| OFF-05 | partial | Manager cash review, immutable evidence, concurrent kitchen/stock review, old-drawer corrections and refund cap pass; remaining refund browser matrix pending. |
| OFF-06 | partial | Tenant-bound atomic backups, wrong-tenant rejection, old-session payment retention and revoked-session manager DB recovery pass; full replacement-root/logout matrix pending. |
| OFF-07 | partial | Unsupported offline actions disabled; no provider offline capability claimed. |
| OFF-08 | partial | Waiting revision keeps unresolved work; complete hashed shell graph is precached and API responses are excluded. Exact staging update proof pending. |
| OPS-01 | pending | Printer jobs explicitly blocked; the jobs runner never touches blocked jobs and provides lease fencing, retries and restart resume for a future printer handler (`tests/jobs-db.ts`, 2026-10-05). Printer worker/hardware recovery pending. |
| OPS-02 | partial | Persisted KDS rounds and polling. Void deltas persist until the kitchen acknowledges them; fully voided tickets close after acknowledgement. Disconnect scenario pending. |
| OPS-03 | pending | Durable jobs outbox locally verified: one job per (tenant, kind, dedupe key), two runners never lease the same job, bounded retries then dead with an alert (`tests/jobs-db.ts`, 2026-10-05). Report/email handler not implemented. |
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

Performance: fixture size is 12 base products per tenant plus test-created products, not the required 300-product/50-order pilot. Ten-user API latency and comparable source task timings remain unmeasured.

Release: clean install, lint, typecheck, domain tests, isolated DB tests, browser scenarios and production build passed. Local backup/restore passed; Neon/Railway staging, Docker execution, hardware/provider sandbox and schema-compatible application rollback remain unverified.
