# Lead decisions (completion program, October 2026)

This is the binding decision record of the program that completes phases 1-4 (see docs/LAUNCH_HANDOFF.md). Specs and contracts referenced here as `specs/*.md` were working documents of the program; where an item matters after merge, the area doc (ACCESS, SERVICE, MENU, OFFLINE_RECOVERY, FISCAL, ...) carries it. Later entries override earlier ones.


Recorded by the technical lead while tracks were in flight. Integrators, wave-2
implementers and reviewers must apply these.

## LD-1 Order note on the receipt (acceptance Q1)
The order-level note (orders.note / round notes) must print on the customer
receipt as well as the kitchen ticket, in addition to line notes. Owner: service
(apply during service hardening or at service merge if not already done).

## LD-2 No double PIN for approved discounts (acceptance Q16)
When a manager approves a cashier's discount with the manager's PIN (the
ManagerApproval pattern), the cashier is NOT asked for their own step-up PIN as
well. The manager's fresh PIN is the authorization. A manager/owner applying a
discount themselves on a terminal still needs their own step-up. Owner:
discounts (wave 2). The acceptance suite must assert one PIN prompt, not two.

## LD-3 Production legal-entity values
Platform privacy notice / terms read the legal entity, address and support
contact from configuration. Production values are supplied by the user at
launch; CI acceptance uses clearly fictional values flagged as such and the
production readiness check must refuse to start legal pages with placeholder
values in production. Owner: account (wave 2) + ops runbook.

## LD-4 qrcode.react dependency (cfdi D14)
The lead adds the dependency on release/v1 before wave 2 (after checking its
docs); wave-2 tracks must not run npm install themselves.

## LD-5 Second-opinion hardening
Every money/security-critical track (access, menu, service, offline, then
discounts, fiscal, cfdi) gets an independent multi-lens review; its high and
medium findings are must-fix in a hardening round before integration.

## LD-6 Backfills under FORCE RLS (ops OPS-R2)
Deployed migrations run as the non-superuser table owner (gm_migrator), which is
subject to FORCE RLS. Every backfill must wrap each table it writes or reads in
NO FORCE / FORCE ROW LEVEL SECURITY within the same migration (see the contracts
§1.3 amendment). Access 023 and service 024 must be fixed; integrators must
check every wave-2 migration for this pattern.

## LD-7 Offline table service ships OFF by default in v1
The offline second opinion found I3/I5/I10/I13/I14 breaks concentrated at the
offline/online seams of offline table service (offline open checks, rounds and
partial payments against cached or local orders). Decision:
- Fix every must-fix offline hardening issue regardless (they also harden core
  offline selling).
- Put offline table service behind a per-restaurant setting
  (e.g. restaurants.settings.offlineTableService, default false), owner/manager
  editable with step-up, clearly labelled "Beta". With it off, offline mode
  supports NEW counter/takeaway orders with full payment (cash or recorded
  external terminal) and the kitchen fallback; existing checks show a clear
  "Disponible al volver la conexión" state instead of offline rounds/payments.
- Tests must cover both settings; the money invariants I1-I14 must hold with the
  setting on, and the off path must be the default in fixtures and acceptance.
- Docs state the default and the beta status honestly.

## LD-8 Decisions on platform.md and public.md open items (2026-10-05)
Platform (wave 2.0):
- cfdi 030 adds `CREATE INDEX jobs_running_lease_until ON jobs (lease_until) WHERE state='running'` and the jobs_worker_discover policy as its last statements, built normally (non-concurrently): production has not launched, so all migrations apply to an empty database; staging data is tiny. No renumbering. (P-27, D10)
- Wave 2.0 MAY edit menu-owned server/public-ordering.ts (signedClaims body) and tests/menu-db.ts (MENU-R3 signature line) so v2 tokens work. (P-22)
- Wave 2.0 applies the two-line SHARE->UPDATE fix in saveNegativeStockPolicy if menu's merged code still has it. (D20, P-18)
- Access A1 (keyed digests) is deferred to wave 3. D5: production REFUSES legacy and v2.jwt.* tokens (none were ever issued there); staging/local keep accepting them while JWT_SECRET is set.
- Access A3 (owner PIN self-only for co-owners, D13) is assigned to account's merge.
- Worker discovery poll stays at 5 s (R17), default accepted.
- Platform §6.2 must record the createOrder exception: table orders take dining_tables FOR SHARE (LO-3) as menu built it; no cycle (only floor edits lock tables FOR UPDATE and they lock no orders). Update LO-R6 wording accordingly.
Public ordering (wave 3):
- Owns migrations 032 and 033 (033_state_checks_validate.sql, no-transaction VALIDATE).
- Lock level LO-2b (public_order_holds row, after LO-2, before LO-3) is accepted; the area adds its command rows to platform §6.2 / docs/ARCHITECTURE.md at its merge.
- Security defaults accepted: PIN step-up on shared terminals for creating/replacing/bulk-creating links, saving ordering policies and a manager's pay-first override; per-IP diner menu limit 60/min.
- Cross-area edits sanctioned: selfInvoiceOffered in server/cfdi, optional fiscalTicketIdentity in server/fiscal.ts, and account's publicOrderingEnabled default flip as a separately revertible commit.
- A QR diner's status page may show the whole check's balance, folio and self-invoice link (equivalent to the printed ticket). Accepted.
Acceptance (acceptance.md):
- SIGNING_KEYS and JWT_SECRET (32+ chars) go to the web process only; the production-mode worker refuses both.
- Use APP_ENV=staging-like settings or an https APP_URL for the local production-mode run (config refuses http APP_URL with APP_ENV=production); the acceptance implementer must pick a configuration config.ts accepts and document it.

## LD-9 Merge-time requirements from the ops integration (binding for integrators)
- Local qualification for every merge from now on = scratchpad/int-ops-r2-qualify.sh (full suite + CI load smoke), not only the base list.
- ACCESS merge: (1) git apply scratchpad/int-ops-r2-access-merge-load-pairing.patch and run the load smoke (re-check the patch if access changed pairingHash/generatePairingCode, device_pairing_codes columns, code bounds or /api/access/pair|pin bodies); (2) key access's limit() and limitPerDevice buckets on clientIp(req) from server/logging.ts (OPS-INT-R3) AND make scripts/ops/smoke.mjs assert forwardedHop===true on deployed runs; (3) add ACCESS_STEP_UP_SECONDS and ACCESS_IDLE_LOCK_DEFAULT_SECONDS as preserve() web variables in .railway/railway.ts, DEMO_TENANT_ID staging-only (OPS-INT-R5); (4) LD-6 backfill check for 023; (5) confirm npm run typecheck (payment-recovery TS2345); (6) package.json test:db:qualification keeps every suffix, ops first; COMPLETION_LEDGER resolved row by row.
- SERVICE merge: apply scratchpad/int-ops-r1-service-merge-i18n-errors.patch (OPS-INT-1/2) and update docs/FISCAL.md 'Pending integration'; translate logout_failed and owner_browser_reset and add access.* audit labels; LD-6 backfill check for 024; re-check load routes (/orders, rounds, payments, /kitchen states, /cash/open).
- MENU merge: server/db.ts tenant() to contract 3.11 golden form; re-check seed-load catalog data against shared/menu-schema.ts.
- OFFLINE merge: vite.config.ts __BUILD_ID__ reads build-info.json commit, falling back when it is "local" (OPS-INT-R4); translate rate_limited (offline owns it).
- CI-only path (OPS-INT-R2): the lead pushes release/v1 after each milestone merge so GitHub Actions qualification.yml (gm_migrator migrations with --grants --retention, web+worker browser suite, image smoke, gitleaks) acts as the gate.

## Lead note (2026-10-05 15:35 UTC): paused work to resume
- CFDI core + reports core workflow (run wf_2fc252b8-5ea, script scratchpad/wave.js, args {"tracks":["cfdi","reports"],...}) was STOPPED to reduce API throttling on the critical path. Resume with resumeFromRunId wf_2fc252b8-5ea after wave-1 merges. State at stop: reports in fix round 2 (review R2-1 test gap), cfdi in fix round 1 (CFDI-CORE-1 409 classification, CFDI-CORE-2 netGroups negative net). Worktrees keep commits and uncommitted edits.

## LD-10 Decisions on the merge-rehearsal blockers (scratchpad/merge-playbook.md)
- B1 ACCEPT: the KDS beforeTickets slot widens to ReactNode | ((station) => ReactNode) (backward compatible); OfflineKitchenReview treats service's 'all' as every station. Applied at offline's merge.
- B2 ACCEPT: offline's OFF-R29 "Cobrar juntas" charge guard is ported into service-owned src/features/Orders.tsx and SettlementDialog.tsx at offline's merge, plus the Array.isArray(order.lines) guard in chargeBlockFromRows.
- B3 ACCEPT with a behaviour check: menu.spec OWNER-6 uses service's CartLine markup; the integrator must verify that an 86'd line in the POS cart is still flagged in place with "Quitar" and that Enviar/Cobrar stay disabled while it remains (behaviour, not just markup). UnavailableLines remains for QR/kiosk.
- B4 DECISION: swap offline's LocalReceiptDocument to service's ReceiptDocument kind='local' at offline's merge AND extend service's local branch to print the payment method (efectivo / terminal externa), the external-terminal reference and change, so there is one receipt component for fiscal to extend. Add a browser assertion for an offline external-terminal receipt.
- B5 ACCEPT: add menu's 'Saldo' (balance_after) column to Operations' Existencias history at menu's merge (menu spec §2.10).
- B6 DECISION: at offline's merge, access's soft-unlock check (App.tsx, currently navigator.onLine) uses offline's connectivity state per contract §0.8.
- Offline merge must reconcile offline.spec.ts KDS-lane tests with service's KDS (/api/service/kitchen polling, default 'all', station radios).

## LD-11 Menu integration review follow-ups (menu merge approved)
- Fix now (small integration fixer before the offline merge): MENU-INT-1 public-ordering limiters key on clientIp(req) (ipKeyGenerator(clientIp(req), 56), per-link key ipKeyGenerator(clientIp(req),56)+":"+link); MENU-INT-2 rewrite docs/MENU.md integration notes as done and split the cart paragraph (POS = service CartLine text, QR/kiosk = UnavailableLines); MENU-INT-3 "Enviar como orden nueva" also disabled by cart.blocked; MENU-INT-4 CartLine error branch uses translateError for codes other than `unavailable`.
- Platform prep (wave 2.0) records MENU-INT-5: voids with stock return lock stock rows (LO-8) before rounds rows (LO-6) as a sanctioned exception next to the createOrder dining_tables exception in platform §6.2 and docs/ARCHITECTURE.md (no cycle today), and adds it to the lock-order ratchet allowlist.

## LD-12 Offline merge sign-offs (2026-10-05, offline merged at 7ea104c, follow-ups to 2ce32e3)
- ACCEPT B6 design: the lock, the soft-unlock check, flow-H sign-out, the pending-logout retry and AccessGate follow net.serverReachable (not canUseServer). Manual "Trabajar sin conexión" is never a PIN bypass and never blocks sign-in/out. The session heartbeat stays on canUseServer (§3.10): a device in manual offline mode does not renew its offline window through the heartbeat. Documented in ACCESS.md/OFFLINE_RECOVERY.md.
- ACCEPT b936098: an offline payment for a check that closed meanwhile and whose amount exceeds the due syncs as offline_payment_exceeds_due (as review/reconcile already did); rounds against a closed check stay offline_order_closed. Contract §6's check_closed→offline_order_closed mapping is refined accordingly.
- ACCEPT §3.8 deviation: the local receipt label reads "Número provisional A-01". Fiscal (027) extends ReceiptDocument's local branch; the provisional number is never a fiscal folio.
- ACCEPT ace3e55: offline-sync-db cleanup disables menu's stock_movements immutability trigger inside one transaction (test-only, superuser fixture role). Other suites leave append-only ledgers in the disposable test DB.
- CI PARITY (lead, 2026-10-05): every local reset now migrates as gm_migrator (scratchpad/reset-track-db.sh), exactly as CI. Any SECURITY DEFINER function or fixture that touches FORCE-RLS tables must set app.tenant_id. Wave 2 implementers and reviewers must assume this.
- FOLLOW-UPS (not blocking): prettier drift pre-dating the merge in server/index.ts, server/payment-recovery.ts, App.tsx, LockScreen.tsx, access-client.test.ts, access-db.ts, access.spec, core.spec, settlement-settings.spec → format in the Wave 3 docs/evidence pass. R6 residual: sendWith's offline branch does not trim the parked copy after moved() as settleParkedCopy does online → fold into the Wave 3 acceptance fixes. Evidence regeneration + dated DELIVERY_STATUS wave line after the last merge (§9.2) → Wave 3.

## LD-13 Offline merge review follow-ups (review approved, 2026-10-05)
- Fix now on integration (small fixer, before platform branches): OFF-INT-1 (a retried idempotent POST answered by authentication before any handler, i.e. 401, 409 session_changed or missing_tenant, reports the first transient failure, so Selling never clears a payment attempt whose outcome is unknown; add the offline-net test), OFF-INT-2 (docs/OFFLINE_RECOVERY.md lock-order paragraph follows contracts §3.14 and names offline sync's sale path as the documented exception; no folio sentence until 027), OFF-INT-3 (local views/receipts carry round numbers and notes so ReceiptDocument prints offline round notes, LD-1; "pendiente de sincronizar" prints this device's pending amount, earlier tenders print as paid; cover in service-receipt.test.ts), OFF-INT-4 (offline collect and offline send refuse with serviceCartBlocked while priceCart(...).blocked), OFF-INT-5 together with the LD-12 R6 residual (after an offline save keep the lines tapped during the save, as SVC-R7 online, and trim the parked copy after moved() like settleParkedCopy).
- OFF-INT-6 DECISION: ACCEPT and document. Manual "Trabajar sin conexión" stays available to every role (it exists for slow or flaky connections, and gating it would add friction during a rush). A sale that physically happened lands with stockPolicy 'allow' (D8); the ledger records it and flags the item Negativo; an item 86'd after the catalog was cached still goes to manager review. Document this in docs/MENU.md (negative stock policy) and docs/OFFLINE_RECOVERY.md.

## LD-14 Platform (Wave 2.0) open questions from specs/platform-rebase.md (all recommendations ACCEPTED)
- OQ-1: service's assignService takes dining_tables FOR SHARE after orders and employees (server/service.ts:57-61): record as a second sanctioned lock-order exception next to LD-8's createOrder one (no cycle: floor edits lock tables, never orders). Do not reorder.
- OQ-2: the lock-order ratchet gains rule D (no rounds FOR UPDATE after a stock event); the allowlist is keyed per (unit, rule) with voidLines:D permanent (MENU-INT-5); top-level `X.y = function` assignments count as units so the offline appliers are scanned.
- OQ-3: offline sale/order/round sync updating rounds (placeRoundsInOfflineReview) after the drawer (and after the folio once 027 lands) is a sanctioned exception: only rows created by the same transaction are touched; reordering is blocked by the FK to offline_sync_records.
- OQ-4: Wave 2.0 replaces cfdi core's temporary server/cfdi/catalog.ts uso block with a re-export from shared/sat.ts in the same commit as (j), so one uso catalog exists before cfdi branches. (cfdi core is merged on integration since 06d2283.)
- OQ-5: DONE by the lead: scratchpad/reset-track-db.sh creates gm_worker (LOGIN, 'local-only-worker', NOBYPASSRLS) and grants gm_jobs_worker once globals.sql creates it; WORKER_DATABASE_URL (gm_worker on the track's dev DB) is in env/{platform,integration,fiscal,discounts,reports,cfdi,account}.env. The platform track still delivers provision-local.sql, setup-local.sh and qualification.yml per spec §3.5/§5.6/§5.7.
- OQ-6: with zero worker kinds registered, the jobs health loop runs `select 1` on workerSql before tickNow('jobs'), so spec §2.2 holds in 2.0.
- OQ-7: the keyring's production predicate (D5, LD-8) is the one in server/access.ts:58-63 (APP_ENV=production or RAILWAY_ENVIRONMENT_NAME=production, case-insensitive), read lazily; extract it to one shared helper used by both.
- OQ-8: reserve LO-2b (public_order_holds, LD-8) in platform §6.2 and docs/ARCHITECTURE.md now.

## LD-15 Wave 2 re-baseline open questions (specs/<track>-rebase.md, baseline 8d7214c)
Global: every Wave 2 track (fiscal, discounts, reports, cfdi, account) branches from integration/v1 AFTER platform (Wave 2.0) has merged, and reads its specs/<track>-rebase.md as binding corrections to its spec (lead decisions still override both). Questions that ask "what if 2.0 is missing" are moot. Local DBs are CI parity (gm_migrator owner, FORCE RLS on the owner).
- fiscal Q1: moot (branches after 2.0). Q2 ACCEPT D1: a check gets its ticket at open→paid and takes no rounds afterwards (RMF 2.7.1.21: the folio is on the comprobante given at payment); late items go out as "Enviar como orden nueva" for the same table. Fiscal rewrites service.spec:2237, service-db:486 and :1276, the SERVICE.md lifecycle and the Tables.tsx comment. Q3 ACCEPT (orders FOR UPDATE before the tender key on legacy POST /refunds; the pre-ticket refund window is accepted until discounts' refund_balance_due lands; discounts adds the refusal test). Q4 ACCEPT (same exception as LD-14 OQ-3). Q5 ACCEPT (step-up on /fiscal/tickets/repair; ACCESS.md list). EXTRA (cfdi Q1): fiscal exports ticketForCfdi and the ticket readers from a leaf module server/fiscal-read.ts (imports db/shared only), re-exported by server/fiscal.ts, so the worker never loads the web sales graph.
- discounts Q1: moot (branch after 2.0; getOrders budget ≤10 comes from 2.0). Keep the fiscal compat shim and gate fiscal-dependent DB tests until fiscal merges. Q2 ACCEPT (a manager/owner acting alone gets requireRecentAuth step-up and is the approver; ManagerApproval only for staff; one PIN, LD-2). Q3 ACCEPT (verifyApproval without orderId; approval pre-check parity is a Wave 3 access hardening item). Q4 (A): keep DELETE/TRUNCATE-blocking triggers on refunds and cash_sessions (money records are never deleted) and fix access-db, offline-recovery-db and offline-sync-db cleanups with the LD-12 named-trigger transaction pattern in FK order. Q5 ACCEPT. Q6 ACCEPT: pass online={online} to <Operations> in src/App.tsx and thread it per contract §0.8 — reports makes the byte-identical hunk (reports Q3); whichever merges second keeps one copy. Q7 ACCEPT.
- reports Q1 ACCEPT (reports_timeout = HTTP 422 domain kind; {timeoutMs: 40000} on report GETs and print POSTs; one-line offline-owned change in src/connectivity.ts so /reports/ and /report outcomes count as reachability only, no latency sample). Q2: the core merge put the reports_* codes in tests/i18n-errors.test.ts ownedElsewhere (06d2283); the full track translates all six reports_* codes in src/i18n/reports.ts (spec §5.7) and removes them from ownedElsewhere. Same rule for cfdi's ten core codes in src/i18n/cfdi.ts. Q3 ACCEPT (see discounts Q6). Q4 ACCEPT ("QR / Kiosco" pseudo-row for unassigned qr/kiosk orders). Q5 ACCEPT option 2. Q6 ACCEPT (latestOnDevice). Q7 ACCEPT: LD-5 second opinion extends to reports' cortes.ts and S1-S5 SQL; high/medium findings are must-fix.
- cfdi Q1 ACCEPT (fiscal-read.ts leaf; import-graph test that the worker never reaches server/auth.ts, server/tokens.ts or server/orders.ts; fallback own SQL in server/cfdi/store.ts only if fiscal already merged without it). Q2 ACCEPT (approved core codes win; map each spec §5.5 Spanish string to the core code; translate every core code; hand acceptance the code→string table). Q3 ACCEPT (manager-only + step-up for "Sustituir global y facturar" in v1). Q4 ACCEPT (service worker registers only when !/^\/(f|factura|qr|kiosk)(\/|$)/; one shared condition, unioned with public at its merge). Q5 ACCEPT (drop 17c's negative half; static check + grants-twice idempotency).
- account Q1 ACCEPT (account merges last; never edits ops files). Q2 ACCEPT (a)-(d). Q3 ACCEPT (organization_transfer_update AS RESTRICTIVE FOR UPDATE). Q4 ACCEPT (owner-seat revocation retires personal devices and cancels pairing codes through an access-owned actor variant). Q5 ACCEPT (no offline-window renewal under drawer_continuation). Q6 ACCEPT settings golden order: RestaurantSettings → FiscalSettings → CfdiSettings → MoneyControlsSettings → AccountPrivacy → FreeSelection → DeviceManagement → PlanSettings (binding for fiscal, discounts, cfdi, account). Q7 ACCEPT. Q8 ACCEPT (documented exception; write only on a real slot change; tenant() single 40P01 retry; load smoke asserts zero concurrent_update).
- LD-13 addendum (fixer result 4757387): OFF-INT-1..6 done. Follow-up for the Wave 3 acceptance fixes: parkCurrentCart parks a cart for a LOCAL order under its local id, and restoreDraft cannot resume it (GET /orders/<local id> fails online and offline), so the parked round stays stuck in Borradores (offline table service Beta only, LD-7 off by default).

## LD-16 Wave 2 cross-track critic (specs/wave2-cross-track.md is BINDING for collisions; its 31 resolutions are accepted)
Merge order: platform → fiscal 027 → discounts 028 → reports 029 → cfdi 030 → account 031 → acceptance (wave 3). Discounts develops with server/compat/discounts-fiscal.ts and gated tests, then rebases after fiscal. Reports runs phase A in parallel, phase B after 028. cfdi rebases onto fiscal before stamping/egresos (steps 7-17).
- L1 ACCEPT: the acceptance doc rebind lands as one lead-dispatched doc commit right after discounts merges (complement-extraction numbers, LD-2/LD-15 approval flows, SEC-6 step, provisioning per the CI-parity reset incl. globals.sql + database-grants.sql + GRANT gm_jobs_worker TO gm_worker, APP_URL guard, [BIND-028]/[BIND-030] tables, reports label changes; expected.ts regenerated with R8 as complement extraction).
- L2 ACCEPT (A14.4/R1 waits >70 s so the manager's own refund shows the global "Confirma con tu PIN"; [CP A10-stepup] moves there).
- L3 ACCEPT: store and show the approver name even when approver = actor ("autorizó Marisol Vega"); exclude self-approvals only from per-approver counts; same for voids, discounts and refunds (overrides reports-rebase's approverId:null).
- L4 ACCEPT: amend LD-15 cfdi Q1: the import-graph test asserts the worker never reaches tokens.ts, orders.ts, fiscal.ts, index.ts, routes/* or the cfdi service/portal; splitting billing-runtime/queue.ts away from auth.ts is a Wave 3 ops item.
- L5 ACCEPT FK order for shared cleanups: fiscal tables, then discounts, then reports, then wave-1 lists, then account rows; fiscal first converts the three money suites to one admin.begin with named-trigger disables (LD-12).
- L6 ACCEPT (CashHistory rowActions render prop, no session prop). L7 ACCEPT (reports adds forward AUDIT_GROUPS prefixes cfdi.→fiscal, account.→access). L8 ACCEPT (DocRow adoption deferred to the Wave 3 docs pass).
- L9 ACCEPT (legal): cfdi FULL supports RESICO ISR withholding (LISR 113-J): on nominative invoices from an issuer with regime 626 (persona física) to a 12-character RFC (persona moral), add the 1.25% ISR retention per concept and compare pre-retention totals in amount_check; verify the Facturapi taxes/withholding shape with Context7 before writing it; tests with the fake. Added to the user hand-off list: an accountant confirms the RESICO behaviour before the pilot.
- L10 ACCEPT contingency (cfdi may merge before reports by lead decision at that time). L11 ACCEPT: the lead dispatches a small ops commit after 030 adding control totals for fiscal_tickets, discounts, refund_batches, refund_units, Σ orders.discount and valid cfdi_documents to scripts/ops/control-totals.ts and rehearse-restore.sh. L12 ACCEPT (acceptance: APP_URL=https://127.0.0.1:3390 with a same-host guard after verifying Secure cookies on 127.0.0.1 in Chromium, else a loopback TLS terminator in global setup). L13 ACCEPT (fiscal CSV via shared/csv.ts, fixed snake_case headers, tickets_{from}_{to}.csv; fix fiscal.md:284). L14 ACCEPT (docs only in Wave 2: pilot printing/hardware runbook — browser printing, paper width, auto-cut, drawer kick via the OS driver — and an MXN-only scope line with a USD cash conversion SOP for border restaurants).
- Missing items assigned: global CFDI end-to-end staging rehearsal (real cutoff, one daily global stamped with FACTURAPI_TEST_KEY, a late offline sync producing a supplementary part, 030 deployed before 07:00) → Wave 3 staging, needs the user's Facturapi test key. account adds the cfdi touchpoints (server/cfdi/portal.ts privacy anchor via restaurantPrivacyUrl(tx), cfdi_secrets/cfdi_files in EXPORT_TABLE_DENYLIST, /api/account-data/* permit(owner) + step-up). reports keeps the cfdi anchors collectAlerts()/dayCorte() and doc.extra.cfdi. G4 "no worker error lines": cfdi's disabled-provider boot and 2.0's health tick log at info/warn. Any fixture that updates restaurants.timezone/cutoff as the owner sets app.tenant_id (029 trigger).

## LD-17 Follow-ups surfaced by the pilot docs fact-check (2026-10-05, docs b40ffa3 + b2e8168)
- Wave 3 (acceptance fixes): servicePrintSilentHint tells staff to open Chrome with kiosk printing; no official doc found by Context7 confirms the flag. Test silent printing on the pilot hardware; if unconfirmed, reword the hint to point at PILOT_SOP's manual print steps.
- Wave 3: RUNBOOK "Signals" says a cashier reads out a "Referencia de soporte", which no screen shows. Show the request id as "Referencia de soporte" on error notices (server already logs request ids), or correct RUNBOOK.
- Wave 3 docs pass: STAGING.md "Credential rotation log" step numbers (9-11) → RUNBOOK cutover numbering (11-13). README/OPERATIONS link PILOT_SOP and LAUNCH_HANDOFF.
- Platform review input: track/platform's scripts/setup-local.sh points at .env.example for WORKER_DATABASE_URL and SIGNING_KEYS, but neither .env.example nor .railway/railway.ts defines them; CFDI_LIVE_ENABLED is refused only on web, not wherever the spec says.
- Operational facts now in PILOT_SOP (no change): offline records sync only under the employee who saved them (OFF-7) — a manager reviews other people's leftovers in «Sincronización»; drawer close needs a manager on that device; refunds are cash from the refunding device's drawer until discounts (028); a production pilot is on Free (one selling device) until account (031) adds the support entitlement grant.
