# Acceptance coverage

This file supplements ACCEPTANCE.md; it does not weaken its requirements. **Partial means the required scenario is not yet satisfied.** External staging/provider blockers are in DELIVERY_STATUS.md.

| Scenario | Status | Evidence / missing work |
| --- | --- | --- |
| UX-01 | partial | Modifier validation and persistent cart tested. One picker for required, optional and repeatable choices with blocked invalid combinations, live price and the cart visible; taquería build-and-sell flow browser-tested (`tests/browser/menu.spec.ts`, local, October 5, 2026). The three-item task with a modifier is measured by the restaurant-day gate (§11; local, October 7, 2026: 8 taps, modelled 10.5 s; see below); production-latency measurement pending. |
| UX-02 | partial | Cash checkout and receipt tested; the restaurant-day gate asserts 2 primary activations from a prepared cart to confirmation (local, October 7, 2026). |
| UX-03 | partial | Additional rounds, table/server reassignment and creator/round preservation tested; full table-service lifecycle pending. |
| UX-04 | partial | KDS acknowledgement/ready and independent payment tested; complete service scenario pending. |
| UX-05 | partial | Amount/item splits, lost cash-response recovery and reload tested; integrated provider failure recovery pending. |
| UX-06 | verified | Browser grouped cash settlement retains separate order IDs, tenders and rounds. |
| UX-07 | partial | Draft persistence implemented; complete parked-ticket restart scenario pending. |
| UX-08 | partial | Cash discrepancy links and inventory evidence implemented; full alert correction scenario pending. |
| UX-09 | partial | Count adjustment and concurrent stock version validation implemented; saved count workflow pending. |
| UX-10 | partial | Drawer close and refund tested; blind close with cash and terminal tips, refunds and paid-outs split by method tested locally (`tests/browser/discounts.spec.ts`, `test:db:discounts`); saved close draft pending. |
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
| CORE-08 | partial | Device PIN, CSRF and cashier management denial tested. Manager approval is verified server-side for the exact void request, never stored, and failed approvals count toward a per-employee lockout (tests/voids-db.ts). Access, locally verified October 5, 2026 (tests/access-db.ts, tests/access-http.ts, tests/browser/access.spec.ts, tests/voids-db.ts): single-use pairing codes, PIN sign-in throttled per employee and device, manager approval by a chosen manager's PIN, PIN step-up on terminals for refunds, paid-outs, self-approved voids and staff/device commands, staff deactivation revoking sessions and unpairing their personal devices, device unpairing, and an identical void retry after a lost response. Pending: staging run; invited-member removal and co-owner lifecycle (account area). |
| CORE-09 | partial | Two-tenant RLS/FK and public QR tamper checks; public ordering (032): a code resolves only through its hash's lookup policy, malformed codes are refused before the database, and a status key or hold of another restaurant is not found (`tests/public-ordering-db.ts` 4, 22, 29, 30, 32). Invoice/webhook/print/upload/org routes pending. |
| CORE-10 | partial | Missing context, rollback reuse and least-privileged role tested locally; tenant transactions set `statement_timeout` with the tenant in one statement, role defaults via `ALTER ROLE` and verified TLS off-host (`tests/ops-db.ts`, `tests/provision-db.ts`, 2026-10-05); Neon pooled/direct pending. |
| CORE-11 | partial | Cash refund reason, original tender immutability and no automatic stock return. Item voids keep the original line snapshot, record reason/actor/approver, refuse paid units and return stock only before the kitchen sees the ticket (tests/voids-db.ts). Item refunds of paid units, recorded terminal refunds, caps per tender and unit and approver validation tested locally (discounts 028, `test:db:discounts`); integrated provider refunds pending. |
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
| OPS-02 | partial | Persisted KDS rounds and polling. Void deltas persist until the kitchen acknowledges them; fully voided tickets close after acknowledgement. Disconnect scenario pending. |
| OPS-03 | pending | Durable jobs outbox locally verified: one job per (tenant, kind, dedupe key), two runners never lease the same job, bounded retries then dead with an alert (`tests/jobs-db.ts`, 2026-10-05). Report/email handler not implemented. |
| INV-01 | partial | Receiving/preparation/sale/count/waste ledger implemented; complete chained cost reconciliation pending. |
| INV-02 | verified | Negative stock is configured per restaurant. Under `block`, two concurrent last-portion sales serialize and only one succeeds; under the default `allow`, the sale proceeds and the item is flagged; offline cash already collected is always recorded (`npm run test:db:core`, `npm run test:db:menu`, local, October 5, 2026). |
| INV-03 | partial | Causal movement deduplication and recipe versions tested; refund restock returns the recipe once per refund line (discounts 028, local); substitutes pending. |
| INV-04 | partial | Append-only ledger with a trigger-maintained cached balance; counts use that balance with the stock-version cutoff, and the Negativo flag states it does not indicate a shortage by itself (`npm run test:db:menu`, local). Saved count scenario pending. |
| FIN-01 | pending | Historical summaries and settlement import not implemented. |
| FIN-02 | partial | Basic order/tender/refund/tip source totals; full tax/fee/commission definitions pending. |
| FIN-03 | partial | Pure forecast identity tested; editable historical scenarios not implemented. |
| FIN-04 | partial | Business cutoff, DST and leap-day unit tests; `business_date_at()` equals `businessDate()` on 10,000 instants incl. Tijuana DST, the cutoff instant and settings history (`tests/reports-db.ts`, local); the report statements against fiscal and discounts (`tests/reports-phaseb-db.ts`, local). |
| MIG-01 | partial | Both normalized catalog fixtures dry-run; mapping rerun/no side effects DB-tested; historical mappings pending. |
| MIG-02 | partial | Import transactionality implemented; kill-mid-import rehearsal pending. |

Performance: fixture size is 12 base products per tenant plus test-created products, not the required 300-product/50-order pilot. Ten-user API latency and comparable source task timings remain unmeasured.

Release: clean install, lint, typecheck, domain tests, isolated DB tests, browser scenarios and production build passed. Local backup/restore passed; Neon/Railway staging, Docker execution, hardware/provider sandbox and schema-compatible application rollback remain unverified.

## Restaurant-day go-live gate (`specs/acceptance.md` v1.1)

Two complete fictional business days, created from nothing through the real UI on a production-mode
web and worker: "Taquería Nopal Azul" (counter service, 26 orders, a ten-minute outage with four
offline sales, refunds, a blind close with a shortage) and "Restaurante Casa Jacaranda" (table
service on phones, border region at IVA 8%, split payments, a paid table waiting for "Liberar
mesa"). Every money figure is checked against an independent oracle and hand-typed tables, then a
DB reconciliation suite (D1–D19) re-reads the day under RLS.

| Piece | Where |
| --- | --- |
| Browser chain (10 serial tests, 46 checkpoints with axe, overflow and the production-text scanner at three sizes) | `tests/browser/restaurant-day.spec.ts`, `tests/restaurant-day/*.ts`, `playwright.restaurant-day.config.ts` |
| DB reconciliation | `tests/restaurant-day-db.ts` (`npm run test:db:restaurant-day`) |
| Local run | `bash scripts/restaurant-day.sh` (`npm run test:acceptance:day`) with `RD_LEGAL_*` and `RD_SUPPORT_*` exported; it refuses any database but the disposable `green_monkey_acceptance_dev` on loopback |
| CI | `.github/workflows/restaurant-day.yml`: on demand, nightly (`vars.RD_NIGHTLY_REF`) and on release/* PRs into `main`; jobs `restaurant-day` and `restaurant-day-cfdi` are required checks in `ops/github/main-ruleset.json` |
| Artifacts | `test-results/restaurant-day/` (state, oracle, actual, timing, axe, screens, prints, server, worker and D22 logs) |

**Status, October 7, 2026 (local only).** Branch N passed end to end in the last five full runs on
this branch, the last two after absorbing integration/v1 (W3-2 flake fixes, LD-45, LD-49) and on
the final code (10/10 browser tests in about 9 minutes, then D1–D19), with zero soft findings. The
track's full qualification passed on the final code as well. It ran on the local
fixture cluster with a plausible fictional legal and support set, so G1.6 proves publication of
that set, not of the vendor's real values (LD-3). The workflow has never run on GitHub: the
repository variables `RD_LEGAL_*`, `RD_SUPPORT_*` and `RD_NIGHTLY_REF` must be set and
`scripts/ops/github-protect.sh` re-applied before it can gate a release. Branch K (CFDI with the
Facturapi sandbox) passed end to end locally only against the Facturapi fake (10/10 and D1–D19;
`RD_CFDI_FAKE_PORT`, a local triage switch that CI refuses, runs the worker as `APP_ENV=test`). It
is unverified against the real sandbox, including the D22 test receptor (§15 Q5) and LD-36's
RESICO test organization.

Timing (§11), canonical order sampled five times per run on the 10-inch tablet, local runs:
every tap's latency p95 within its budget (taps 1-6 and 8 under 80 ms against 150-700 ms; "Confirmar
cobro" 141-253 ms against 2 s), system time p95 0.53-0.68 s (budget 4 s), kitchen appearance p95
2.9-3.0 s (budget 3.5 s), modelled cashier time 10.5-10.7 s with exact cash and 11.6-11.8 s with a
bill (budgets 15 s and 16 s), 8 taps exact and 9 with "$100", 2 activations from cart to
confirmation. Local latencies are not production latencies (no network between browser and server).

### Product defects the gate found (fixed at the source, each with a regression test in its owner's suite)

| Finding | Fix | Regression test |
| --- | --- | --- |
| A4.3: a 4-digit staff PIN showed the browser's English validation bubble | `1bd9841` | `tests/browser/access.spec.ts` |
| A9.2: the opening-cash field was not labelled "Fondo inicial" | `ad6b1fc` | `tests/browser/core.spec.ts` |
| G3: the data-export picker showed raw table names | `d564366` | `tests/account-db.ts` 29f |
| 390 px overflow: the long paused public-ordering status widened Configuración | `b0cebdf` | `tests/browser/public-ordering.spec.ts` |
| FOH-10 on a 10-inch tablet (1024×768): menu cards, the line-note "Listo", the payment dialog's quick cash, "Cambio" and terminal confirmation, and the receipt's buttons needed scrolling | `9560bc6`, `6e87e7c`, `34db98a` | `tests/browser/service.spec.ts` |
| Axe: the scrolling receipt was not keyboard-focusable | `fff9a37` | `tests/browser/service.spec.ts` |
| G3 dates: receipts, the money-controls note and the Sync screen used `toLocaleString` ("7/10/2026") instead of dd/MM/yyyy HH:mm | `99927cc`, `2512a5d` | `tests/datetime.test.ts`, `tests/browser/offline.spec.ts` |
| A check closed from Órdenes stayed in Vender's cart with its old balance | `8ee970c`; narrowed in `f974181` to the moment Vender comes back on screen (the broader re-read delayed an offline sync, which integration's kitchen hygiene caught) | `tests/browser/voids.spec.ts`, `tests/browser/offline.spec.ts` |
| "Al guardar sin conexión" chosen on the Sync screen did not apply to the next offline sale | `6f78209` | `tests/browser/offline.spec.ts` |
| During an outage Caja showed "Caja cerrada" and "Abrir caja" for an open drawer | `3510d2e` | `tests/browser/offline.spec.ts` |
| A15.7: an unpaired terminal's gate did not say the device had been unpaired | `a528034` | `tests/access-http.ts`, `tests/browser/access.spec.ts` |
| B1.6: after saving Datos fiscales, the CFDI panel on the same screen kept "Completa los datos fiscales del restaurante." and a disabled "Activar en modo prueba" until the owner left the screen | `b88b322`: `CfdiSettings.tsx` re-reads its settings when the fiscal context changes | `tests/browser/cfdi.spec.ts` |
| Axe on B7-global (768 px): the "Facturas globales" table scrolls sideways and, while no period has documents, holds nothing a keyboard can reach (`scrollable-region-focusable`) | `b88b322`: the `GlobalPeriods.tsx` table wrapper is a labelled, focusable region | `tests/browser/cfdi.spec.ts` |
| G4 at A14.4 (branch K): with the platform's CFDI provider configured, every refund dialog of a restaurant that never activated CFDI asked for the ticket's CFDI view and logged a 409 | `a0caee3`: `status.ts` asks only once CFDI has a mode | `tests/cfdi-client.test.ts` |
| G3 dates (B6-cfdi, A14-detail): Detalle de orden dated the order with `toLocaleString` ("7/10/2026, 9:41:23"); A14-detail had scanned the dialog before it loaded | `bfecfbe`: `OrderDetail.tsx` uses `dateTime`; the checkpoint waits for the loaded detail | `tests/browser/service.spec.ts` |

### Spec expectations bound to the built behaviour (recorded here per LD-16 L1; assertions adapted, not weakened)

- A1.4: signup also requires the express billing-consent box ("Consiento expresamente…", account LD-32 UX-3) before "Crear restaurante gratis" enables.
- A2.4: the plan line reads "Pro otorgado por soporte · Acceso hasta: 6 dic 2026, 4:00 a.m." (Spanish month and time), not dd/MM/yyyy.
- A4.4: the Acceso cell reads "PIN" with the muted line "PIN del {date}".
- A5/A7: the recipe editor names units by symbol ("kg", "l") and "piezas" ("= 0.03 kg").
- P-SELL: a product card's accessible name starts with its category; the card is located by its name element.
- A9.1: the cart has no "Vaciar"; the line's minus stepper empties a one-unit cart. The kitchen poll goes through the page, because Playwright's request client does not send the Secure session cookie over http://127.0.0.1.
- KDS-checks: ticket lines are compared as a multiset (the KDS groups them its own way); print captures are compared with whitespace collapsed (`innerText` of the print root).
- A10.12: the courtesy line reads "Cortesía · Agua fresca (Jamaica, Grande) −$45.00" (it names the line).
- A11.2 and A15.3: Corte X and corte Z open a "Vista previa" dialog (reports 029); the corte Z difference row is "Diferencia (faltante)".
- A13.8: a blind-close cashier never sees "Corte X", so it is asserted absent rather than disabled; "Cerrar caja" carries "Cerrar caja y registrar retiros requieren conexión."; Órdenes cannot list checks offline, so "Reembolsar" and "Anular" are unreachable rather than disabled.
- A13.9/A13.13 and D7: one comanda and one review card per station round, so the four offline sales give five tickets and five cards (A22's drink is a bar round) and D7 expects 4 `already_served` + 1 `prepare`; "Preparar ahora" arrives on the KDS as "Cocina recibió".
- A13.12: "Continuar como Diego Ramos" is a soft unlock (ACC-18); when the server answers again the lock returns and Diego enters his PIN.
- A14.2: the uncertain payment recovers by itself once the server answers (offline `settleActiveAttempt`); "Recuperar pago" is tapped only if it is still shown.
- B6.2: the waiter's phone shows no "Asignación actualizada" notice; the Órdenes card shows the new table, and the KDS shows the badge.
- B1.6 K: activation queues a global tick that adds the current period's row, and once any period row exists a periodicity change applies from the first day of next month (CFDI-R2-1, so a period never mixes periodicities). "Diaria" saved right after activation therefore shows "El cambio aplica desde el 1 nov 2026." and the first period is "Octubre 2026"; the gate accepts either outcome of that race and records which one it saw.
- B6.9 K: the invoice dialog title dates the ticket "7 oct 2026" (cfdi `dateLabel`), not dd/MM/yyyy; the receipt modal is released before Órdenes → Detalle → Facturar. D19 K reads the claims from `cfdi_document_tickets` (the spec's `cfdi_ticket_claims`).
- B7.5 K: the "Facturas globales" register sums stamped documents, so the open period reads 0 tickets and $0.00 until it is built; the six-ticket readiness set (§7.11 row K) is reconciled by D19, not read from the register.
- X1.2/X1.3: a cashier's foreign ticket-register query answers 403 or an empty list; a foreign `x-tenant-id` answers 409 `session_changed`; a foreign PIN answers 401 `employee_unavailable` or `invalid_pin`.
- D6, D9, D12, D17: the built names are used (`operations.kind like 'refund%'`, void movements with `cause='void'`, the audit action names, support action `grant_entitlement`).

### Spec errors corrected in the harness (procedure, not product)

- A13.2: the first 65 s of the outage pass in real time. With `runFor`, `performance.now` moves ahead for good, and the app's corrected clock follows the monotonic clock from its last server contact (OFF-R24), so the four sales were stamped 65 s in the future (D7 read 115 s of drift instead of 180 s).
- §3.5 clock control: compressed minutes advance in 3 s steps and wait for short in-flight requests, otherwise a jump reads as seconds of latency and the pill shows "Conexión lenta"; heartbeats are refreshed before the outage so the tablet's measured offset is the true 3 minutes.
- P-ROUND on a phone: before adding a round to an existing check, the waiter opens "Ver orden" and sees the check loaded. A line tapped while the resume is still loading goes to a fresh draft that the resume parks in Borradores (seen once in a branch K run at B6.6).
- §11: `tap()` asserts "in viewport" on Caja 1 (the tablet the budget measures); other devices and steps outside the budget use `press()`.
- §6.11 says A16 pays exact, but the order book (§6.6), which the money tables come from, pays A16 with "$100": the order book wins, so A07, A16 and A24 take 9 taps.
- LD-46/LD-49 (absorbed from integration): the web trusts its loopback peer like Railway's edge, so every gate client sends the edge's `X-Real-IP` (127.0.0.1, keeping §3.8's shared per-IP buckets); the clients exercise the production client-address path and the deployed web has no `client_ip_without_real_ip` warning to log.
- §13.1: the nightly job checks out `vars.RD_NIGHTLY_REF` (scheduled runs start on the default branch), and G1.2 compares `/api/version` with the stamped commit (`RD_BUILD_COMMIT`), not `GITHUB_SHA`.

### Open items

- Real sandbox (branch K) and the vendor's real legal values have never been exercised; the first `restaurant-day-cfdi` run with `FACTURAPI_TEST_KEY` verifies D22.
- §13.2 asks for the gate before any production deploy dispatch; `deploy.yml` does not check it yet (ops).
- §13.2 requires two consecutive green CI runs after any change to the suite; only local runs exist.
- Product questions surfaced by branch K (left as built, recorded above): an open global period could
  preview the tickets it will hold instead of reading 0 tickets and $0.00 until it is built, and the
  periodicity an owner saves right after activation, before any sale, could apply to the first
  period instead of the next month.
