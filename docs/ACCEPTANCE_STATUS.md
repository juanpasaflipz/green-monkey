# Acceptance coverage

This file supplements ACCEPTANCE.md; it does not weaken its requirements. **Partial means the required scenario is not yet satisfied.** External staging/provider blockers are in DELIVERY_STATUS.md.

| Scenario | Status | Evidence / missing work |
| --- | --- | --- |
| UX-01 | partial | Modifier validation and persistent cart tested; exact three-item task measurement pending. |
| UX-02 | partial | Cash checkout and receipt tested; primary activation budget not measured. |
| UX-03 | partial | Additional rounds tested; full table-service scenario pending. |
| UX-04 | partial | KDS acknowledgement/ready and independent payment tested; complete service scenario pending. |
| UX-05 | partial | Amount split and reload tested; item allocations and provider failure recovery pending. |
| UX-06 | verified | Browser grouped cash settlement retains separate order IDs, tenders and rounds. |
| UX-07 | partial | Draft persistence implemented; complete parked-ticket restart scenario pending. |
| UX-08 | partial | Cash discrepancy links and inventory evidence implemented; full alert correction scenario pending. |
| UX-09 | partial | Count adjustment and concurrent stock version validation implemented; saved count workflow pending. |
| UX-10 | partial | Drawer close and refund tested; tip/paid-out combined scenario and saved close draft pending. |
| UX-11 | partial | Selling/cart screenshots and overflow checks at all four sizes; all-workspace review pending. |
| UX-12 | partial | Keyboard search, modal dismissal/focus and one-state axe check; full screen-reader review pending. |
| UX-13 | pending | Spanish/English strings present; organization switching and complete locale acceptance pending. |
| UX-14 | partial | Catalog import and cash sale independently verified; complete onboarding flow pending. |
| CORE-01 | partial | Canonical quote shared by POS/QR/kiosk/sync; promotions and tax configuration pending. |
| CORE-02 | verified | Eight parallel same-ID creates produce one order/stock effect; altered payload conflicts. |
| CORE-03 | pending | Integrated provider events/reconciliation not implemented. |
| CORE-04 | pending | Provider crash/restart recovery not implemented. |
| CORE-05 | partial | Concurrent cash overcollection prevented; integrated cards/item allocations pending. |
| CORE-06 | partial | Money/remainder/unit arithmetic unit-tested; live taxes/promotions/item split pending. |
| CORE-07 | partial | Recipe/price edits retain historical cost and price snapshots; tax/offline conflict acceptance pending. |
| CORE-08 | partial | Device PIN, CSRF and cashier management denial tested; approval and membership lifecycle pending. |
| CORE-09 | partial | Two-tenant RLS/FK and public QR tamper checks; invoice/webhook/print/upload/org routes pending. |
| CORE-10 | partial | Missing context, rollback reuse and least-privileged role tested locally; Neon pooled/direct pending. |
| CORE-11 | partial | Cash refund reason, original tender immutability and no automatic stock return; item void/approval/provider cases pending. |
| OFF-01 | partial | Offline cash full refresh/reconnect verified; browser close/reopen and duplicate-sync scenario pending. |
| OFF-02 | pending | Lost-response recovery implemented through same-key operations but interruption scenario not tested. |
| OFF-03 | pending | Web Locks and server deduplication implemented; two-tab restart test pending. |
| OFF-04 | pending | Unbounded retained retry queue implemented; exhaustive retry test pending. |
| OFF-05 | pending | Conflicts retained; manager reconciliation not implemented. |
| OFF-06 | pending | Local data scoped and retained; revoked-session recovery and restaurant switching pending. |
| OFF-07 | partial | Unsupported offline actions disabled; no provider offline capability claimed. |
| OFF-08 | pending | Service worker defers activation; update-during-payment scenario pending. |
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

Performance: fixture size is 12 base products per tenant plus test-created products, not the required 300-product/50-order pilot. Ten-user API latency and comparable source task timings remain unmeasured.

Release: clean install, lint, typecheck, domain tests, isolated DB tests, browser scenarios and production build passed. Local backup/restore passed; Neon/Railway staging, Docker execution, hardware/provider sandbox and schema-compatible application rollback remain unverified.
