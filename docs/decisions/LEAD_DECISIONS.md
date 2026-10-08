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

## LD-18 Public ordering (032/033) runs in parallel with Wave 2 (specs/public-rebase.md + specs/public-cross-track.md, all LD-P1..P16 ACCEPTED)
- LD-P1: track/public is cut from integration/v1 right after platform 2.0 merges and develops PHASE A in parallel with Wave 2; it merges into integration/v1 exactly once, after account 031 and its B3 step; the flag flip (B4) is a separate revertible commit. B1 after 027, B2 after 030, B3 after 031 (B-028/029 optional); merge integration/v1 INTO track/public at each B step (LD-P11) and reset the track DB each time.
- LD-P2: public may use compat shims S1-S4 only (server/compat/public-*.ts, src/compat/public-*.ts), each with the owner's exact signature, deleted at its swap step; none reaches integration/v1.
- WAVE 2 CONTRACT ASKS (binding on those tracks): fiscal ships fiscalTicketIdentity in server/fiscal-read.ts with the exact S2 signature from public-rebase.md (one statement, formatFolio, db/shared imports only) (LD-P3); cfdi exports selfInvoiceOffered from server/cfdi/store.ts (public-rebase item / cfdi-rebase item 13); reports adds AUDIT_GROUPS prefixes public.hold_ -> sales and public.link_, public.settings, public.paused, public.resumed -> settings (LD-P4); account keeps publicOrderingEnabled / publicOrderingGate / restaurantPrivacyUrl signatures and the six accountGuest* key names exactly as account.md states them and makes NO change for public-owned files (LD-P12; public resolves those hunks at B3); any new value in orders.state/channel/mode, rounds.state or jobs.state is announced to public (LD-P13).
- LD-P5 (binding on discounts, reports, public): the online prop text is byte-identical: in src/App.tsx `<Operations ... locale={locale} online={online}` (online right after locale); Operations and Orders take `online?: boolean` defaulting to true, placed after `navigate` and `refreshKey` respectively; `<Orders ... refreshKey={...} online={online}>`. Discounts' merged text is the reference.
- LD-P6: public writes cfdi's service-worker exclusion byte for byte in Phase A: a `publicPage` const for /^\/(f|factura|qr|kiosk)(\/|$)/ before the SW comment and `&& !publicPage` on the registration condition; /legal stays out. The (\/|$) form is mandatory (a bare /qr#token must not render the staff POS).
- LD-P7 settings golden order (amends LD-15 account Q6): RestaurantSettings → FiscalSettings → CfdiSettings → MoneyControlsSettings → AccountPrivacy → PublicOrderingSettings → FreeSelection → DeviceManagement → PlanSettings.
- LD-P8: public's shell banner and inbox pill are aria-live="polite" regions, never role=status; count badges aria-hidden. LD-P9 BINDING browser hygiene: every public test (and its menu/core/security rewrites) decides or cancels every hold, revokes every link, resumes ordering and releases/voids every check in a finally, on its own "QR <runId>" tables. LD-P10: Phase A documents only in docs/PUBLIC_ORDERING.md; shared docs change once at B3.
- LD-P14: the Wave 2 critical path (2.0 → 027 → 028 → 029 → 030 → 031) has priority; public Phase A pauses first under throttling. LD-5 applies: a multi-lens round on Phase A at A10 and a delta round on B1-B4 before merge; high/medium are must-fix.
- LD-P15: re-baseline OQ-3, OQ-4, OQ-5, OQ-8, OQ-9 (done by the lead: env/public.env, reset-track-db.sh 'public'), OQ-10 (holdStatus ≤ 5 statements), OQ-13 (lock-order rows by command name), OQ-14 (P-27 pre-07:00 deploy window for 032 + RUNBOOK line), OQ-15 accepted as recommended. LD-P16: pre-approved contingency: a reachability-only rule for /api/ordering/ in src/connectivity.ts, only if offline.spec or access.spec flake at A9.
- Public never edits Receipt.tsx, FiscalReceipt.tsx, RefundSlip.tsx, PaymentDialog.tsx, server/orders.ts / getOrders, tests/service-db.ts or tests/lock-order.test.ts; holdStatus and the inbox never call getOrder. CI keeps APP_ENV non-production on browser and DB steps until B4.

## LD-19 Platform 2.0 merged (56da932, merge-time edits c30da87; review approved, no must-fix)
- Applied at merge: PLAT-R1 (loadConfig requires SIGNING_KEYS whenever isProductionEnv, matching the keyring), PLAT-R4 (Dockerfile comment). PLAT-R2: the lead added CI's synthetic SIGNING_KEYS (kid ci-20261005) to env/{integration,platform,fiscal,discounts,reports,cfdi,account,public,acceptance}.env so local runs exercise the listed kid as CI does.
- Follow-ups: PLAT-R3 (retentionPasses may run one extra empty pass after a full-but-final batch; low) → Wave 3 ops. PLAT-R5 (docs/LAUNCH_HANDOFF.md still calls Wave 2.0 names "proposed" and mentions the worker preDeploy) → lead docs sync now. Staging cutover with the 2.0 deltas, GitHub environment secrets (MIGRATION_DATABASE_URL, PG_APP_USER, ALERT_WEBHOOK_KIND) and SIGNING_KEYS on staging/production web are operator steps in Wave 3 (user consent given for staging; Railway CLI token needed).
- Wave 2 (fiscal, discounts, reports, cfdi, account) launched at c30da87 (run wf_1861517e-212). LD-5 multi-lens second opinion on platform runs off the critical path; its fixes land on integration.

## LD-20 Platform second opinion (LD-5; 5 lenses, 35 issues: 2 high, 10 medium, 23 low) → hardening on track/platform (ff to 5153819), run wf_d01b5706-97f
- Must-fix: OPS-1 (runner concurrency reserved before the claim await), OPS-2 (deploy smoke requires the new worker commit and jobs:true), OPS-3 (lease-expired jobs past maxAttempts go dead), OPS-4 (deployed worker requires WORKER_DATABASE_URL), OPS-5 (lease-expiry abort releases the slot), KEYS-1 (RUNBOOK: never Railway dashboard Rollback/Redeploy across a SIGNING_KEYS change), KEYS-2 (seal() is signed, not encrypted: opaque ids only — binding on cfdi and public), KEYS-3 + CI-1 (deployed web incl. staging requires SIGNING_KEYS and refuses placeholder/CI keys), CI-2 (custom deployment branch policy = main), ROLES-1 (retention runs the live release's code), LOCKS-1/2 (stronger ratchet, allowlist still keyed per unit), LOCKS-3 (db_retry logged; concurrency tests assert zero retries).
- Fiscal's merge must reconcile tests/lock-order.test.ts with the hardened scanner using the hardening report's list of entries.

## LD-21 Platform hardening landed (track/platform fast-forwarded into integration/v1 at 605cac7; review approved, lows only)
- E5 SANCTIONED: a refreshCheckState that cannot issue a ticket is not an LO-12 lock (createOrder: nothing is paid at creation; applyRound: a check that takes rounds is not paid, LD-15 fiscal Q2); addRound keeps the feed after applyRound (fiscal §4.4). Allowlist addRound:12>10, applySale:12>11, applySale:12>5.
- E6 SANCTIONED: financial recovery after a target lookup (reconcileSale, reconcilers.payment: 5>4); no transaction locks order_numbers and then an existing order.
- FISCAL must delete createOrder:12>10, voidLines:12>10, assignService:12>10 from tests/lock-order.test.ts in its reorder commit and rewrite the "feed bump stays last" comments in server/orders.ts createOrder and server/service.ts assignService to cite LO-10/LO-R3. The scanner is now tests/lock-scan.ts (level-monotonic, transitive); fiscal's earlier A/C-rule edits must be re-expressed against it at fiscal's absorb step.
- REPORTS adds 'job.' (job.cancelled, job.requeued) to an AUDIT_GROUPS group (settings) at its absorb step. CFDI 030 adds the running-lease partial index jobs (tenant_id, kind, lease_until) WHERE state='running' and EXPLAINs discovery/claim/expiry in its DB suite.
- New operator surface: POST /api/jobs/:id/cancel and /requeue (owners/managers, step-up); RUNBOOK "Jobs". Deployed web requires SIGNING_KEYS and refuses placeholder keys; deployed worker requires WORKER_DATABASE_URL; smoke waits for the new worker commit with jobs:true; retention runs the live release's compiled code.
- Wave 3 (RUNBOOK Open follow-ups): rest of ROLES-2, ROLES-4 (setup-local.sh migrates as gm_migrator), CI-8 (pin postgres:18, node base image and gitleaks by digest).

## LD-22 Account's legal gate in browser runs (account track report, round 1)
- From account (031) on, signup/legal/account/landing tests and access's owner.spec need a published (fictional) legal set: under NODE_ENV=production an unpublished set pauses signup. Every compiled-server start for browser runs sources tests/fixtures/legal-ci.sh first when it exists (it exports the LEGAL_*/SUPPORT_* literals of tests/fixtures/legal-ci.ts and LEGAL_UNPUBLISHED_SIGNUP=allow, keeping values already set); scripts/compiled-local.sh does it itself. The lead's qualify.sh and finish-track.js already do this conditionally. DB, HTTP and drain suites do not need it. Account documents it in docs/ACCOUNT_AND_LEGAL.md "Merge notes (integration)".

## LD-23 Public phase A second opinion (5 lenses, 34 issues: 12 medium, 22 low) → hardening on track/public, run wf_eb5280da-efe
- Phase A implemented and approved (14 commits). It fixed a latent runner bug: server/ops/schema.ts applyNonTransactional called reserved.begin(), which postgres.js reserved connections lack, so the first no-transaction migration (033) would have failed every deploy.
- Hardening starts by merging integration/v1 (c5a17e6, platform hardening + level-monotonic scanner) into track/public (LD-P11).
- Decisions: MONEY-1 accept carries acknowledgedTotal (centavos), server refuses a different current total (409); MONEY-2 hold label (Q-xx/K-xx) stored on the order and shown on KDS ticket and receipt through existing fields or a public-owned table (LD-18 file bans hold; report the minimal edit if impossible); PRIVACY-1 diner status shows accepted server prices; PRIVACY-2/UX-5 kiosk pages render no navigational links (in-page dialog for privacy text); ABUSE-1 holds from a code revoked for abuse are badged and need explicit acknowledgement; UX-1..6 as proposed; CONCURRENCY-1 fixed against the hardened scanner, reordering preferred over new exception classes.

## LD-24 Public acceptHold lock-order entries (public hardening request, CONCURRENCY-1)
- APPROVED as an exception to LD-18's ban on public editing tests/lock-order.test.ts: exactly three PERMANENT allowlist lines, in one separate revertible commit, plus a row in docs/PUBLIC_ORDERING.md:
  "server/public-holds.ts#acceptHold:2b>1" (LO-R5: the hold's own order key, createOrder/addRound(h.order_operation_id), before LO-4);
  "server/public-holds.ts#acceptHold:12>1" (LO-R5 fresh key, recordPayment(randomUUID()) after createOrder's refresh, E5);
  "server/public-holds.ts#acceptHold:12>11" (E5: createOrder's refresh cannot issue at creation; then the drawer, as applySale).
- rejectHold:2b>1 and revokeLink:2>1 are fixed by reclassifying public's advisory keys (':public-links' class 924, ':public-hold:' class 925) as LO-3 area keys — no allowlist entries.
- At public's merge the integrator keeps these three lines next to fiscal's edits (fiscal deletes only createOrder/voidLines/assignService 12>10).

## LD-25 Fiscal second opinion (5 lenses, 33 issues: 8 medium, 25 low; SAT claims checked against sat.gob.mx, DOF and CFF) → finish round on track/fiscal (run wf_1f8c6121-dda)
- SAT-1: border IVA (8%) requires a complete issuer identity and a postal code whose prefix belongs to a border-region state (prefix ranges verified from an official source and cited); attestation kept. The PAC validates the exact c_CodigoPostal 'Estímulo Franja Fronteriza' flag and the RFC's LCO registration with mark 2: the owner's accountant confirms both before a border pilot (LAUNCH_HANDOFF item). The 8% incentive decree runs to 2026-12-31 (DOF 31/12/2025): if no extension is published in the DOF, border tenants must switch to 16% on 2027-01-01 — add to RUNBOOK/LAUNCH_HANDOFF as a dated operator check.
- SAT-2: 'Este RFC tiene más de una sucursal' makes the branch address required (CFF 29-A fr. I).
- MONEY-1: no refunds (amount or item) on an order without a fiscal ticket and with a balance due (refund_balance_due): before payment staff void lines; no IVA adjustment against a provisional gross.
- OFFLINE-1/2, UI-1/2, CONCURRENCY-1 as proposed. Lows when cheap.
- Absorb: the same round reconciles fiscal with the platform hardening (LD-21 allowlist deletions, level-monotonic scanner, db_retry assertions).

## LD-26 Discounts second opinion (5 lenses, 32 issues: 1 high, 9 medium, 22 low) → applied in discounts' finish round after fiscal lands
- FISCAL-1 / MONEY-1 / UI-1 (one issue): item refunds are refused too on an order without a fiscal ticket and with a balance due (LD-25): recordRefund refuses both modes before planning; the dialog shows only guidance (collect the payment or void the unpaid lines) and never the item tab or the terminal step; refund_balance_due copy covers both modes; discounts-db test rewritten to expect refusal.
- FISCAL-2: under fiscal D1 a discount that brings a dine-in check to zero issues the ticket and the check stops taking rounds or discount changes; corrections after a ticket are refunds. docs/DISCOUNTS.md and the UI say so (amends LD-15 discounts Q7's "stays correctable").
- MONEY-2: staff percent limits compare the requested percentage (percent kind), the plan amount against discount(base, maxPercentBps) with the same rounding (amount kind), and comps need 100%; unit cases with odd bases.
- MONEY-3 / APPROVALS-1 (one issue): limits apply per check to discounts recorded without an approver (sum under the order lock; same figure in the dialog preview; setting relabelled "por cuenta").
- UI-2 (tender re-selection after reload), UI-3 (quantity field), UI-4 (cash/terminal breakdown on the refund result) as proposed; lows when cheap.

## LD-27 Reports second opinion (LD-15 Q7; 5 lenses, 35 issues: 15 medium, 20 low) → applied in reports' finish round after discounts lands
- CORTES-1: remote close carries a precondition (the expected cash / drawer fingerprint the dialog showed) checked under the drawer lock (409 reports_drawer_changed → recount), and is refused while the drawer's device is in use (recent tender or last_seen within N minutes: "ciérrala en su dispositivo", where the pending-sync guard applies); the dialog re-fetches and shows the live expected cash before confirming.
- CORTES-2: printed cortes come from one REPEATABLE READ snapshot; print numbering stays in the READ COMMITTED transaction under its key; DB test commits a payment between statements of a print.
- SQL-1 / CONTRACTS-1: align with fiscal's hardened FiscalSummary (tickets.series = contiguous runs per series, LD-25 SAT-3). CONTRACTS-2 as proposed (comped lines on ticketed checks).
- UI-1..UI-10 as proposed (stale data cleared on range change, sticky actions at 390 px, faltante/sobrante words on every difference, alert targets, number wrapping, paging resets, filter resets, refund row wrapping, refreshKey). Lows when cheap; CORTES-3..5 especially.

## LD-28 Fiscal 027 landed (merge 70860d6 on integration/v1; finish round clean: 850 unit, full DB suite incl. 45 fiscal checks, 158 browser)
- Border prefixes derived from SAT Cat_Codigos_Postales.pdf (north 21-22, 25-27, 31-33, 64-67, 83-85, 87-89; south 24, 29-30, 77, 86); dated 2026-12-31 border-decree check in RUNBOOK and LAUNCH_HANDOFF.
- Fiscal profile advisory key is class 922 (LO-3). Discounts must give ':money.controls' its own non-zero class.
- refund_balance_due is declared by fiscal (src/i18n/fiscal.ts) and enforced for amount AND item refunds (assertRefundAllowed + recordRefundTax backstop).
- Deferred (not blocking): FISCAL-UI-7 wording of the printed 'Folio fiscal pendiente…' is bound by acceptance A13.4 → decide at the acceptance rebind (L1). FISCAL-OFFLINE-3 (queued offline sales taxed with the profile in force at sync; RUNBOOK says sync before switching a profile) → Wave 3 (needs a profile history or tax context in the offline lease). Menu's archiveProduct can unarchive an IVA 8% product outside a border region → Wave 3 menu fix.

## LD-29 CI stability and a rollover product note (2026-10-06)
- The browser suite's Playwright global setup moves the demo restaurants' cutoff to 10:00 when the 04:00 rollover is under three hours away (CI run 37445309932 crossed 04:00 and order numbers restarted mid-run). The SW update helper follows a revision the app's own checkForUpdate found first (b422b1e). ACC-18 tests tolerate a background 401 (e503521).
- Wave 3 product item: at the business-day rollover an open order from the previous day shows the same number as today's (two "#10"); Órdenes and the order cards should show the business date for orders not from the current business day (e.g. "#10 · 5 oct").
- Wave 3 CI item: a flake hunt (browser suite repeated under CPU throttling) before the acceptance run.
- Incident: an agent ran `npm install @types/qrcode.react` in the main checkout at 2026-10-05 21:10 (uncommitted; reverted; no branch affected). The main checkout's package files are now read-only between lead fast-forwards.

## LD-30 Wave 2 build loop finished (run wf_1861517e-212, 51 agents)
- fiscal clean (0 fix rounds; landed 70860d6), discounts clean (3 rounds), reports clean (3 rounds).
- cfdi NOT clean after 3 rounds: verify passed (740013b) but the review left two medium must-fix items (CFDI-R4-1 a motive-01 cancellation whose substitute is cancelled first stays queued forever; CFDI-R4-2 a refund's credit is lost when the ticket is handed to a substitute frozen before the refund) → carried into cfdi's finish round with its LD-5 second-opinion issues (scratchpad/cfdi-review-r4.json).
- account NOT clean after 3 rounds only because the build-loop verifier started the browser server without tests/fixtures/legal-ci.sh (LD-22: six environmental account.spec failures); the review approved → account's finish round verifies with the legal set.
- No agent pushed a branch; the stray main-checkout npm install (LD-29) was the only rule breach found.

## LD-31 Discounts 028 landed (merge 5e74ee6; finish round clean: all 32 second-opinion issues fixed, 900 unit, 54 discounts + 46 fiscal DB checks, 180 browser)
- Compat shim deleted; every refund goes through fiscal's assertRefundAllowed; insertRefundBatch is the only recordRefundTax caller; ':money.controls' advisory key is class 929 (LO-3); routes give each approved request its own transaction (no allowlist entries).
- Advisory class registry: 920 free limits, 921 organizations, 922 fiscal profile, 923 pairing/floor, 924 public links, 925 public hold, 926 reports AND cfdi (collision) → reports moves to 930+ in its finish round; cfdi keeps 926 unless its absorb finds otherwise. 927-929 per ARCHITECTURE LO-3.

## LD-32 Account second opinion (5 lenses, 40 issues: 1 high, 18 medium, 21 low; LFPDPPP DOF 20-03-2025 / reformed 14-11-2025, CFF art. 30, CCom checked) → applied in account's finish round (account lands after cfdi)
- OPS-1 (high): scripts/provision-support-operator.ts accepts the database names the ops provisioning actually creates (PROVISIONING.md), not a hard-coded list.
- LEGAL-1: simplified notice includes the responsable's domicilio and the data/no-sensitive-data clause; ONE source (PRIVACY_SIMPLIFIED via legalText), duplicate i18n strings deleted; the Google button waits for the config.
- LEGAL-2 / UX-5: DPA §6 lists Facturapi (CFDI stamping through a PAC and CFDI email) and, only if approved, Sentry; §2 adds CFDI receptors' data and the sealed CSD; §11 allows communications required by law or made on the responsable's instructions (PAC/SAT).
- LEGAL-3 / UX-4: legal documents carry announcedAt and effectiveFrom; a banner links the new text from announcedAt; the 428 gate starts at effectiveFrom; a test enforces effectiveFrom ≥ announcedAt + 15 days for material changes; entity-only changes show a generated "datos del responsable actualizados" entry and are not material unless the operator marks them so.
- LEGAL-4: Google-member managers get the re-acceptance path for the documents that apply to them.
- LEGAL-5 / DATA-1 / DATA-2: support-operator commands for ARCO rectification (owner name/email) and cancellation (blocking, then anonymization after the legal retention), respecting SAT 5-year fiscal retention and the append-only ledgers; the texts and OPERATIONS runbook describe exactly what the tools do.
- AUTHZ-1: removing a co-owner or revoking a seat also cancels pending ownership transfers involving that person. AUTHZ-2 / OPS-2: gm_support gets least privilege (narrow SECURITY DEFINER or column-limited paths; audit rows written with server defaults, not caller-chosen created_at/actor).
- OPS-3: the load smoke asserts zero concurrent_update (the LD-15 Q8 E7 condition).
- UX-1 (removing a co-owner is never blocked by pending legal acceptance: it is a security action), UX-2 (surface the 15-minute fresh Google sign-in requirement before the action), UX-3 (explicit, separately recorded express consent where the notice claims it), UX-6 (terms mention operator support access), UX-8 (no recovery-codes panel before a restaurant exists) as proposed. Lows when cheap.
- User hand-off addition: counsel (a Mexican data-protection lawyer) reviews the terms, privacy notices and DPA before they are first published (LAUNCH_HANDOFF).

## LD-33 CFDI second opinion (5 lenses + 2 review leftovers, 42 issues: 2 high, 14 medium, 26 low; SAT Guía de llenado global v4.0, cancelación 2026 FAQ, Anexo 20, CFF 29-A, LISR 113-J checked) → applied in cfdi's finish round after reports lands
- MONEY-2 / SAT-1 (high): tickets released by any cancellation always return to a CFDI: onCanceled enqueues a forced build for each released ticket's own period, whatever its age; a closed period with unclaimed eligible tickets shows as overdue with 'Emitir ahora' and counts in attention()/overdueGlobals; staff dialog copy stays true.
- WORKER-1 (high): cfdi_cancel and cfdi_reissue read the invoice's current provider status before resending DELETE on a retry and never mark a cancellation failed on a transient per-attempt error. WORKER-2/3, SECRETS-1 as proposed (no permanent failure on an unknown outcome; CSD jobs always reach terminal()).
- MONEY-1 / SAT-2: credit notes (egresos) cannot be cancelled with motive 02/03 by staff (cfdi_not_cancellable); corrections go through a substitute egreso related 04 and sent with motive 01.
- SAT-3: model CFF art. 29-A: cancellation is allowed only until the month the annual ISR return for the CFDI's year is due (March personas morales, April personas físicas); later attempts are refused with a clear message, and prior-year global corrections offer the credit-note route (Guía global Apéndice 2 III).
- SAT-4, UX-1..UX-4 as proposed; CFDI-R4-1 and R4-2 as the reviewer proposed. Lows when cheap.

## LD-34 Acceptance spec rebound (LD-16 L1 done: specs/acceptance.md v1.1, 2026-10-06; complement-extraction figures recomputed with the merged shared/fiscal.ts)
- Q19 (blocking for acceptance): account's provision-support-operator.ts must accept the acceptance database (green_monkey_acceptance_dev) — LD-32 OPS-1 fix accepts the real production names AND the local /^\/green_monkey(_[a-z]+)?_dev$/ pattern.
- Q20 ACCEPT: the acceptance run generates a fresh SIGNING_KEYS and JWT_SECRET per run (in memory only), since production-mode web refuses the CI/placeholder keys.
- Q18 ACCEPT: with APP_URL=https://127.0.0.1:3390 over the plain-http listener, the worker watchdog's web_down warn is the one tolerated G4 log key (no TLS terminator).
- Q17: Wave 3 fiscal copy fix "Folio pendiente: se asigna al sincronizar." with A13.4 updated in the same commit.
- The acceptance database is provisioned demo-free by support provisioning (never scratchpad reset-track-db.sh 'acceptance', which seeds demo data).
- Built-code facts the rebind surfaced: by default only managers/owners close a drawer (the scenario's owner enables 'Cajero' first); the drawer close-permission is a money-controls setting.

## LD-35 Reports 029 landed (merge 6edef99; finish round clean: phase B wired on fiscal/discounts, all 15 medium second-opinion issues fixed with regression tests)
- Report print key is advisory class 930 (LO-3 registry 920-930 in ARCHITECTURE); remote close calls discounts' closeDrawerRow directly (reports_drawer_changed / reports_drawer_in_use refusals); printed cortes read one REPEATABLE READ snapshot.
- The old /report route is deleted from server/index.ts; reports serves the legacy keys for older bundles. 'Historial de auditoría' opens Finanzas → Bitácora.
- CFDI finish round launched (run wf_c00138a9-db4) with LD-33 and the reports anchors to fill.

## LD-36 Staging credentials received (2026-10-06; values only in the session scratchpad secrets/, mode 600, never committed)
- Railway: a WORKSPACE token (Authorization: Bearer on the public GraphQL API; `railway whoami`/`list` reject workspace tokens in the installed CLI, so staging operations use the API or `RAILWAY_API_TOKEN` per command). Project green-monkey (9bd572ca…), environments production (78c6ff84…) and staging (9e87eafe…), one service today ('green-monkey'): the Wave 2.0 staging cutover adds the worker service.
- Facturapi TEST key for the CFDI staging rehearsal: organization regime 626 (RESICO), CSD loaded, production-ready, no pending steps → monthly global (cfdi D4) and ISR 1.25% withholding on invoices to personas morales (LD-16 L9) apply to the real pilot.

## LD-37 Account phase 1 finished clean (track/account at 5fd79af; all LD-32 items fixed with tests)
- Migration 031 was changed in place (never merged or deployed): restrictive gm_support policies bound to same-transaction support_actions rows; support CLI gains rectify-account, block-account, anonymize-account (only after 5 years blocked; acceptances and fiscal records kept) and redact-email; legal documents carry announcedAt/effectiveFrom (≥15 days for material changes); separate billing_consent evidence; Facturapi, Cloudflare and GitHub listed as processors (Sentry only if approved); OPS-1 support:provision accepts green_monkey_<env> and the local *_dev pattern; load smoke fails on any 409 concurrent_update.
- Phase 2 (after cfdi lands): absorb integration, wire server/cfdi/portal.ts restaurantPrivacyUrl, cfdi_secrets/cfdi_files in the export denylist, /api/account-data/* permit(owner)+step-up, cfdi's 030 grants block before 031, CfdiSettings in the golden order (docs/ACCOUNT_AND_LEGAL.md 'Merge notes (integration)').

## LD-38 CFDI 030 landed (merge 407154e; finish round clean: all LD-33 must-fixes incl. both highs with regression tests; 1045 unit, 70 cfdi DB checks, 199 browser)
- Real wiring: ticketForCfdi from fiscal-read, egreso payment form from refunds.method, fiscal enqueues cfdi_refund on refund adjustments, reports' Hoy alerts and corte coverage filled; class 926 is cfdi's; 030 ends with jobs_worker_discover + jobs_running_lease_until (EXPLAINed); worker grants on 027/028 tables.
- Root cause of the recurring SW-update flake found by cfdi's verifier (5e3bd8e): the failed revision stayed in dist/sw.js and Chromium's own soft update reinstalled it after reconnecting; its fetch crossed the test's route swap and never finished. The test now withdraws the failed revision and keeps stable routes (25/25).
- Local qualify.sh now runs the browser step like CI from cfdi on: Facturapi fake (port 4811), worker on its jobs login (port 3611) with the fake key and synthetic credential keyring, web with WORKER_URL.
- Account phase 2 (wf_117c3e5d-46a) and public B2 (wf_4759d246-e94) launched on top of 407154e.

## LD-39 CFDI tick chain fix on integration (4ef8941)
- cfdi-db R3 and INT-7 failed on integration late in the morning (passed earlier): the jobs uniqueness (tenant, kind, dedupe_key) covers done rows, and the paused-with-open-upload and last-attempt handover paths re-armed with the plain tick key only, so when that hour's key belonged to a tick that had already run the insert was dropped and the chain stopped. All three re-arm paths now use armNextTick (suffixed key fallback, as the main path already did). Production-relevant (a paused restaurant's open CSD upload could be left unswept; a failing tick could end the chain).
- Account phase 2 and public B2 absorbed 407154e before this fix: if their agents changed server/cfdi/worker/global.ts for the same failure, the merge keeps 4ef8941's armNextTick.
- LD-39 addendum (public B2 agent's independent diagnosis): the regular chain keys its next tick tick:<nextSixHours(now)>, which equals tick:<nextHour> only in the hour before 00/06/12/18 UTC — the exact failure window. An operator requeue of a future tick could hit the same gap in production; armNextTick closes it. Public B2 does not edit cfdi files; its merge takes 4ef8941.

## LD-40 Account 031 landed (merge e267ef5) — Wave 2 complete on integration/v1
- Account phase 2 clean: cfdi portal privacyUrl via restaurantPrivacyUrl; cfdi_secrets/cfdi_files denylisted (account-db 29c on the real 030 tables); accountDataGuard (owner + step-up) mounted on the whole /api/account-data prefix right after authentication (so a stale terminal owner with pending legal sees step_up_required before the 428 — intended: security before gating); processor-list test tied to server/cfdi/config.ts; it absorbed 4ef8941 and dropped its own duplicate tick fix.
- Follow-ups (Wave 3 flake hunt): several DB suites count advisory-lock waiters cluster-wide in pg_locks (access-db:2146, reports-phaseb-db:904, reports-db:463, menu-db:2008, migrate-db:708) and can flake when other worktrees test on the shared local server; filter by current database (cfdi-db 7b already fixed, 02af73a). fiscal_tickets.self_invoice_code stays in the owner export (owners already see it on receipts) — ACCEPT.
- qualify.sh runs test:account-http with tests/fixtures/legal-ci.sh as CI does. Public B3 + B4 launched (wf_bb670aa3-c5e).

## LD-41 Public LD-5 round 2 (5 lenses on B1-B4 + merges: 24 issues, 3 medium, 21 low; specs/harden-public-r2-issues.json) → fix round on track/public before it merges
- PUB-R5 runner change (server/ops/schema.ts no-transaction newest file: grants hook + registry row in an explicit BEGIN/COMMIT on the reserved connection) SIGNED OFF by the lead: verified against postgres.js 3.4.8 (reserve() has no begin()); 033 is the only no-transaction file. Add the migrate-db leg (CONCURRENCY-2) and rewrite PUBLIC_ORDERING §7 as merged history.
- MONEY-1 ACCEPT, D11 narrowed: the diner status offers the self-invoice code only when the diner is known to be the payer: pay-first holds (paid_at_accept) and takeaway holds (no table). A table check paid later shows the folio and "Pide tu factura con tu ticket impreso o en caja." with selfInvoiceCode null. DB test 22 gets the staff-paid table leg.
- MONEY-2 ACCEPT option (a) + copy: an accept that carries a payment passes lockHold up to 5 minutes after expires_at (target "new" pay-first only); the diner's HOLD_EXPIRY_GRACE_SECONDS matches so the diner page does not show "vencido" while staff can still collect; any refusal that arrives after the cashier confirmed an external terminal charge shows explicit copy that the charge must be recorded on a manual order or refunded.
- UX-1, OPS-1 (kill switch recovery on diner pages and staff devices), UX-2/SECURITY-2 (pending-holds badge and floor reads honour the switch), UX-3 (table vs kiosk "unavailable" copy), UX-4 (Pro + switch off reads as paused, not "próximamente"), UX-6 (API cleanup in afterEach), UX-7 (one inbox accept leg tagged @cross for webkit-ipad), SECURITY-1 (reject control characters and bidi overrides in diner name/note with the existing validation error), SECURITY-4 (settings and QR dialogs point to the restaurant privacy notice): ACCEPT as proposed.
- SECURITY-3 + CONCURRENCY-3 ACCEPT via migration 034 (public area, expand-only): the hold transition trigger allows a redaction-only update (name/note set to NULL, every other column unchanged) by the table owner/app as appropriate, so ARCO redaction is a plain tenant-scoped UPDATE with no DISABLE TRIGGER (no table-level lock across restaurants); redaction applies to accepted holds too (the order's call name is the sales record); ops retention blanks name/note of holds older than 30 days (retention.yml/--retention path, counted in the retention summary). LAUNCH_HANDOFF gets the counsel row (diner names/notes kept 30 days; ipHash in logs) (OPS-5).
- Docs ACCEPT: UX-5/OPS-3 (§8 matches B4), OPS-2 (roll back by setting PUBLIC_ORDERING_ENABLED=false, not git revert), OPS-4 (OPERATIONS ARCO route), OPS-6 (RUNBOOK retention list), OPS-8 (DB-9 check on staging AND production in RELEASE), CONCURRENCY-1 (ARCHITECTURE LO-3 rows).
- OPS-7: GAP-4 load profile lacks diner traffic → LOAD_TEST.md and RUNBOOK "Open follow-ups" line (staging capacity run must include diner submit/status polling); not built now.

## LD-42 W3-2 flake hunt results (discovery at 90884cb: rounds A, S1-S4 under CPU load, R1-R3; no timing-only flake found)
- P1 PRODUCT (crash): an aborted account data export can exit the web process (unhandled rejection from an async postgres.js .cursor(n, fn) callback on a table's final batch; postgres 3.4.8 does not await/catch it in CommandComplete/CloseComplete). Fix at the source: every cursor in server/ uses the async-iterator form (or a callback that never rejects), backpressure honoured on final batches; HTTP regression test (abort mid-stream with backpressure → /api/health still up, a second export works). Same audit for every other .cursor( call site.
- KDS cap DECISION (product): at KITCHEN_FEED_LIMIT the KDS currently hides the NEWEST tickets, so a restaurant that never bumps tickets stops seeing new orders. Change: at the cap the feed carries the newest 200 open rounds (still displayed oldest first) and the alert says older tickets are hidden and a manager can clear previous-day tickets (existing action). Deliberate behaviour change; update the cap tests and say so in the commit body.
- Kitchen a11y: a fully voided line fails contrast (opacity 0.6 over .muted). CSS fix keeping line-through at ≥4.5:1.
- Test hygiene on persistent databases (staging-like): browser tests complete/clear the kitchen rounds they create; global setup clears the demo tenant's leftover open rounds behind its isolated-DB guard; core.spec.ts:12 uses a unique name; fiscal.spec.ts:473 finds the folio by search, not by page 1; account.spec export test awaits download.path(); the kitchen a11y test creates its own voided line; reports.spec.ts:227 clears its ticket.
- Harness: qualify scripts give the worker APP_URL of the compiled web; reset the DB whenever the Facturapi fake restarts.

## LD-43 Public 032/033/034 landed (merge bd79e50; round-2 fix round clean at d622387, review approved with three lows)
- PUB-R3-L3 SIGNED OFF: public's f41086d makes the lock-order ratchet stricter (tests/lock-scan.ts TABLE_LEVEL/UPSERTED know public_links, public_ordering_settings, public_hold_numbers, plus a fixture test); no allowlist entry was added and the server scan still reports exactly LD-24's three pairs.
- PUB-R3-L1 → W3-1 polish round 2: the diner's 5-minute expiry grace applies only to pay_first holds; accept-policy holds keep 60 s.
- PUB-R3-L2 → W3-1 polish round 2 docs: PLANS_AND_SIGNUP says the kill switch shows "desactivados temporalmente"; "próximamente" only where B4 is reverted.
- Merge order from here: W3-1 polish (round 1 then round 2: items 7, 10, 11 + LD-43 lows) and W3-2 flake fixes absorb integration/v1 with public, then land; then W3-3 acceptance.

## LD-44 W3-1 polish round 1 clean (track/polish 3 review rounds, verify green at 80ba013); round-2 scope
- POL-8 / POL-R3-2 DECISION: printed kitchen paper (comanda, cancellation chit, every print call site) carries the business date for an order not from the current business day ("#10 · 5 oct"), same helper as the screens; tests on the print text.
- Round 2 (finish-track on track/polish, after absorbing integration/v1 with public): spec item 7 (PLAT-R3; public's 034 retention redaction is now in retention.ts — keep both), item 10 (docs pass incl. SERVICE.md/REPORTS.md kiosk-printing reconciliation with PILOT_SOP §1.3, STAGING.md rotation numbering, README/OPERATIONS links, RUNBOOK open follow-ups), LD-43 lows PUB-R3-L1 (diner 5-minute grace only for pay_first holds) and PUB-R3-L2 (PLANS_AND_SIGNUP kill-switch copy), POL-R2-6 (public's inbox/settings notices use errorNotice), POL-R3-1 (cached copies carry businessDate), POL-R3-3 (classify body-parser's other client errors as 4xx; Context7), POL-R3-4 (draft-gone CSS), POL-R2-2/-3/-4/-5, recovery.spec.ts:13 restores 'Taco de hongos' in finally.
- Item 11 (prettier) moves to the lead's final integration commit after flake and polish both land (formatting-only, verified).
- acceptance.md A13.4/Q17 updated by the lead to the adopted fiscal strings.

## LD-45 WebKit "HTML 502 from the proxy" flake (main CI 37563046530; diagnosis from the trace)
- Test-only race: the 502 route is installed before Cobrar, so openPay's GET /api/cash and api()'s 400 ms GET retry reach FAIL_THRESHOLD=2 about 0.4 s after the dialog opens; PaymentDialog relabels the same footer button to "Guardar cobro en este dispositivo" and Playwright's click (element resolved earlier) saves locally. No POST was sent.
- Fix the tests (W3-2 follow-up on track/flake): the outage starts at the payment's first POST /api/orders (route.fallback() before it, waitForRequest proves the online path); the same gate for offline.spec.ts "API down while browser online" (abort internetdisconnected) and fiscal.spec.ts 695-708 / 762-775; fix the stale "POST is retried once after 800 ms" comment. Add a permanent test pinning the product behaviour: an outage noticed after Cobrar relabels Confirmar in place and the relabelled tap saves locally with zero POSTs.
- Product hardening ACCEPTED (low): while the payment dialog is open, the confirm button ignores taps for ~700 ms after `online` changes (derived state + timeout, part of canConfirm), and the offline warning panel gets role="status"; regression with page.clock.
- Counting a request's retries as one connectivity failure: NOT changed in v1 (OFF-1 outage-detection policy; a 502 and its retry both failing is outage evidence). RUNBOOK/OFFLINE_RECOVERY note only.

## LD-46 Client IP on Railway (HIGH; first staging deploy's smoke client_ip failed, run 37567966909)
- Verified on staging 2026-10-07 with a temporary header-echo service (created, probed, deleted): Railway's edge DISCARDS client-supplied X-Forwarded-For and X-Real-IP and sends X-Forwarded-For "<client>, <edge hop 84.17.x.x>", X-Real-IP "<client>", from a peer in 100.64.0.0/10. With trust proxy "loopback, 100.0.0.0/8", req.ip is the rightmost untrusted hop = the edge hop, so clientIp() returns the edge hop: every client behind that hop shares one key for the access PIN/pairing limits, public ordering ceilings, cfdi portal, account and ops limiters, and ipHash in logs is meaningless. owner-routes.ts and billing-runtime.ts limiters use express-rate-limit's default key (req.ip) — same problem.
- Fix (track/netfix): clientIp(req) returns X-Real-IP when the immediate peer is a trusted proxy and X-Real-IP is a valid IP (Railway's documented client address, overwritten by the edge), else req.ip; every rateLimit() has an explicit keyGenerator through clientIp (static test: no limiter without one); /api/ops/diagnostics/ip reports {ip, peerTrusted, source: "x-real-ip"|"forwarded"|"peer"} and the CD smoke requires, on a deployed origin, peerTrusted, source "x-real-ip", spoof invariance, not spoofed, not private. Docs: RUNBOOK/INFRASTRUCTURE client-IP paragraph with the verified header shape.

## LD-47 Staging rotations done (steps 11-13, 2026-10-07 ~04:05 UTC) and a rotation-script follow-up
- Runtime: gm_staging_app → gm_staging_app_r20261007 (web DATABASE_URL/PG_APP_USER, GitHub env var PG_APP_USER), finalized (dropped). Billing: gm_staging_billing → gm_staging_billing_r20261007 (web + worker), finalized. neondb_owner: new 40-char password set by SQL (ALTER ROLE, Neon-supported), old refused; value only in the session scratchpad.
- The runtime finalize refused on a legacy grant `USAGE on schema public granted by pg_database_owner` (made before the cutover): remainingGrants reports can_set=true via the database owner's implicit membership, but nobody can SET ROLE to pg_database_owner. Cleared by the lead in one atomic transaction (temporary ALTER SCHEMA public OWNER TO neondb_owner → REVOKE → back to pg_database_owner, ACL diff verified: exactly that entry removed). FOLLOW-UP (ops, Wave 3): rotate-db-login finalize treats a pg_database_owner grantor explicitly (same ownership round-trip with the ACL-diff guard, or a clear refusal naming the procedure) + RUNBOOK note; test with a grant made as the database owner.
- The pre-cutover restore branch (br-super-hat-aeeeffgs) still carries the old passwords: user decision to delete it once staging is verified.

## LD-48 Polish LD-5 second opinion (5 lenses, 25 issues: 1 medium, 24 low; specs/harden-polish-issues.json) → polish round 3 fixes all
- POL-W3R2-L1 (reported by four lenses): add request_aborted and request_size_invalid to TRANSIENT_CODES (the body did not arrive intact; the same record retries). invalid_json, payload_too_large, unsupported_encoding, unsupported_charset and too_many_parameters stay conflicts (deterministic).
- LD-29 dating extends to the offline kitchen review, the offline payment review target, the offline "Órdenes abiertas" pick list and provisional numbers from another business day; the Órdenes card shows the date once (no duplicate "Del 5 oct" badge); labels use non-breaking spaces so "#10 · 5 oct" never wraps apart.
- Unexpected 4xx codes are logged (info) with the request id so a "Referencia de soporte" on a 4xx is searchable; offline sync failures keep the request id and Sincronización shows the reference; PILOT_SOP §7 tells the cashier to read the reference out.
- SERVICE.md matches what ships (medium); docs-consistency covers it. Remaining lows as each issue's fix says.

## LD-49 netfix landed on integration (merge 82cb8eb; review approved, four lows) + main merged in (5626f60, tree-identical)
- Follow-up batch (with LD-45 and LD-47): NETFIX-L1 log a warn (once per process) when a trusted peer sends no usable X-Real-IP in production; NETFIX-L2 the ratchet also requires the keyGenerator to call clientIp/ipKeyGenerator(clientIp(...)); NETFIX-L3 RUNBOOK wording (the smoke proves spoof invariance and x-real-ip source, not that the address is the runner's own); NETFIX-L4 rename the stale http.test.ts case.
- Launch handoff: a production custom domain must be DNS-only in Cloudflare (proxied would make X-Real-IP a Cloudflare address).
- PRs to main from now on: squash merge (ruleset); integration merges origin/main first (strict up-to-date).

## LD-50 W3-1 polish landed (merge 532476c; tree identical to track/polish e8b6c51, qualified: 1261 unit, 543 DB, 254 browser, load smoke 0 errors)
- Rounds 1-3 clean; LD-5 second opinion (25 issues) all fixed with tests (LD-48). Support references avoid O/I/L (written 0/1) so they read aloud unambiguously; unexpected 4xx are logged at info with code + requestId.
- Next: track/flake round 2 (LD-45/47/49 + flake lows) absorbs integration/v1 with polish, then lands; then the prettier commit (spec item 11) on integration, PR to main (squash), green staging deploy.

## LD-51 CFDI rehearsal against the real Facturapi sandbox (local, 532476c; all 9 goals passed: activation, 5 sales, portal física + moral with 1.25 % ISR exact, cancellation 02, daily global FG-1 one concept per ticket, supplementary FG-2 from a late offline sale; no warn/error lines) → track/cfdifix
- F1 HIGH ACCEPT: the self-invoice deadline (receipt, portal, settings) is the earlier of the policy deadline and the ticket's global period close + grace whenever portal_reissue_global is off; the receipt prints that date (and time when it is the same or next day); the settings form says how periodicity shortens the window.
- F2 MEDIUM ACCEPT: the activation step asks for the global periodicity (with SAT-4's rule for the issuer's regime shown); a periodicity change applies at once while no period of the current month has been stamped or claimed (built-but-empty periods are rebuilt), otherwise from the next month as today.
- F3 MEDIUM ACCEPT: in sandbox_shared the issuer facts used for withholding (regime, RFC kind) and LugarExpedicion come from the shared organization's legal data as Facturapi reports it; the CFDI panel shows the platform test organization as the issuer and warns that the restaurant profile is not used for stamping in this mode.
- F7 ACCEPT: a cancellation receipt is stored as the acuse only if its UUID matches the document; otherwise (Facturapi test-mode sample) it is not offered, and the status still comes from the document.
- F8-F13 ACCEPT as the report proposes (hide the pending legal-sync note for sandbox_shared; issuer RFC shown as pending until the org resolves; periodicity select shows current + pending; open periods count unclaimed tickets; a ticket issued into an already-built period triggers a tick; successful jobs log one info line with document id and the Facturapi request id when the API returns one — verify the header with Context7).
- F14 docs: LAUNCH_HANDOFF RESICO withholding is modelled and sandbox-verified (2026-10-07); CFDI.md/DELIVERY_STATUS record the local real-sandbox rehearsal and what remains (organizations provider, live cancellation acceptance, credit notes/substitution, RESICO monthly close, email, alerts).
- F4 USER ACTION: the Facturapi test key belongs to an organization with the user's real taxpayer identity; staging test documents carry it. Recommend a dedicated Facturapi organization with a SAT test identity for staging (its test key), or accept it knowingly. Rehearsal evidence files in scratchpad/cfdirh/ contain that identity: never commit or share them.
- F5/F6 → LAUNCH_HANDOFF accountant/provider items: test mode does not validate receptor names; Base vs Importe rounding on tax-inclusive concepts (D18).

## LD-52 W3-2 flake + follow-up batch landed (merge on integration; tree identical to track/flake 2fe8437, qualified: 1279 unit, 548 DB, 257 browser incl. @cross, load smoke 0 errors)
- Migration 035_kitchen_reopened.sql is flake's (rounds.reopened_at, KDS window ranking). Any later migration takes 036+ (cfdifix's spec said 035: renumber at its merge if it added one).
- LD-45, LD-47, LD-49 and the flake lows are closed.

## LD-53 User decisions (2026-10-07 ~07:10 CST; user away until ~21:00)
- Facturapi: the current test key (organization with the user's own identity) stays for staging — LD-51 F4 accepted by the user. Evidence files with that identity remain local only.
- Neon: the pre-cutover restore branch br-super-hat-aeeeffgs (pre-cutover-staging-2026-10-06) DELETED with the user's approval. Another old branch, pre-021-staging-backup-2026-09-30 (br-polished-hall-aem062zv), also carries the pre-rotation passwords: ask the user before deleting it.
- R2 + age: the user will provide the credentials (instructions given); until then the backup/restore drill stays pending.

## LD-54 cfdifix clean (track/cfdifix, migration 036_cfdi_rehearsal_fixes.sql; F1-F14 done) → fiscal LD-5 second opinion (4 lenses: fiscal, concurrency, ux, ops) before merge
- PR #7 merged (squash 3e62285); main CI re-run green after a 16-minute apt stall cancelled the first run; staging deploy applied 035, smoke all green. CI hardening on integration (70f6212): qualify timeout 60 min, Playwright install bounded at 10 min with one retry.
- The user reset the weekly usage (2026-10-07); workflows continued (one automatic agent retry each).

## LD-55 cfdifix fiscal second opinion (4 lenses, 22 issues: 1 high, 5 medium, 16 low; specs/harden-cfdifix-issues.json) → cfdifix round 2 fixes all
- CFDIFIX-FISCAL-1 / UX-1 (HIGH): whenever the effective deadline is global-bound (or is not the policy's end of day), the receipt, the portal and the staff view print date AND time ("hasta el 12/10/2026 a las 05:00"); tests with a mid-week weekly sale, fortnightly and monthly-with-days.
- F12 timing (FISCAL-4, OPS-2, CONCURRENCY-1, CONCURRENCY-4): a late ticket no longer triggers an immediate tick. It enqueues ONE tick per tenant per 30-minute bucket, due at the bucket's end plus 10 minutes (deduped; the suffixed fallback only when that key already ran), so a sync burst lands in one supplementary part and the counter keeps a short direct-invoice window; still far inside RMF 2.7.1.21's 24 h. The hook's read of the period state must not miss a period being built concurrently (re-check in the tick, or enqueue regardless of state for a past-dated ticket).
- OPS-1: record X-Facturapi-Log-Id on error answers too (FacturapiError.logId; Context7).
- The rest as each issue's fix proposes (deferred save promotes an in-force pending change first; monthShape treats in-flight invoice claims as uncovered; reissue-off/shorter-policy saves are guarded like a periodicity change; stampingFacts takes the shared issuer as a whole or not at all; acuse mismatch reasons; UX announcements; docs evidence; tests that vary the grace).

## LD-56 cfdifix round 2: F12 key shape accepted
- The absorb agent reconciled LD-55 with CONCURRENCY-1: a shared bucket key would make concurrent issuances wait on each other's uncommitted unique insert under LO-12. Accepted: the issuance hook dedupes by reading a committed waiting tick of the 30-minute bucket and inserts tick:issued:<bucket>:<orderId>; an offline drain gets one tick per bucket, racing first issuances may add a few same-time ticks (harmless: the builder is idempotent per period).
- Workflow stalls (agent killed after 3 min without progress) hit long foreground commands; finish-track.js now takes args.rulesExtra (background-run rule) and args.reviewNote.

## LD-57 Acceptance gate in CI
- The acceptance implementer built the suite (track/acceptance, ~30 commits, product fixes included) and was killed for inactivity before reporting; finish-track resumes it (verify runs track-qualify.sh AND scripts/restaurant-day.sh with the fictional RD_* set in scratchpad/rd-fictional.sh).
- GitHub repository variables RD_* set to that fictional, plausible set (LD-3: never the CI literals, never on Railway). restaurant-day and restaurant-day-cfdi become required checks when the updated ops/github/main-ruleset.json is applied with github-protect.sh after the acceptance PR merges (applying it earlier would block PRs before the workflow exists on main).
- FACTURAPI_TEST_KEY is NOT added to GitHub secrets: restaurant-day-cfdi (branch K) skips and reports success; branch K was rehearsed locally against the real sandbox (LD-51).

## LD-58 cfdifix round-2 review (standalone agent; workflow reviewers stalled on context size) → round 3 fix
- All 22 LD-55 issues verified fixed (UX-4/FISCAL-5 partial → R2-2/R2-5).
- CFDIFIX-R2-1 HIGH: 036 granted UPDATE on cfdi_settings columns TO the literal gm_app; on staging/production the runtime login is gm_<env>_app and only scripts/grants.sql is name-substituted → migrate would fail (42704) or, with a stray gm_app, every CFDI settings save would fail (42501). CI hid it (PG_APP_USER=gm_app). Fix: grants move to scripts/grants.sql; regression test with a non-gm_app runtime login; migrations-lint forbids naming the runtime role in a migration.
- CFDIFIX-R2-2 MEDIUM: cancelling/replacing a waiting self-invoicing change could shorten printed deadlines → guard on the stored result. Lows R2-3..R2-7 fixed in the same round.
- Process: workflow agents are killed after 3 minutes without progress, which large-context reasoning can exceed; long reviews/implementations now run as standalone agents.

## LD-59 W3-3 acceptance gate finished (track/acceptance 9f80d05; branch N green twice in a row, branch K green against the fake, D1-D19, G1-G4 with 0 waivers; qualification 1291 unit / 549 DB / 267 browser / load smoke 0 errors)
- The fictional RD_SUPPORT_PHONE had spaces; production requires E.164 → GitHub variable and scratchpad/rd-fictional.sh now "+523336150420". Global setup now refuses non-publishable RD values up front (55950e6).
- Spec deviations recorded in docs/ACCEPTANCE_STATUS.md (bound to built behaviour per LD-16 L1, plus harness spec-error fixes) — ACCEPTED, including the new cfdi-key job so day-cfdi reports skipped without FACTURAPI_TEST_KEY.
- The track's 18 product changes (incl. a 513-line PaymentDialog layout restructure) get a dedicated adversarial review before merge.
- Merge order: cfdifix (round 3) → integration; acceptance absorbs it and reruns the gate on both branches (cfdifix rewrites CfdiSettings/status.ts; B1.6 K and the 'open period reads 0' items should change to the fixed behaviour) → integration; prettier commit; final docs; PR; apply the ruleset with github-protect.sh after the acceptance PR merges; set RD_NIGHTLY_REF; deploy.yml gating production on the gate is a follow-up (ops).

## LD-60 Acceptance product-change review (verdict changes_required; specs/acceptance-pr-review.md is binding)
- PaymentDialog restructure verified intact. Fix ACC-PR-1 (offline Caja hides stale money figures, option a), ACC-PR-2, ACC-PR-3, ACC-PR-5, ACC-PR-7, ACC-PR-8 now on track/acceptance; ACC-PR-4 (gate asserts the server's periodicity decision) and ACC-PR-6 after cfdifix merges and acceptance absorbs it; then rerun the gate (branch N twice + K against the fake) and the qualification.

## LD-61 cfdifix landed (merge 6ef8e94; tree identical to track/cfdifix 891479b: 1345 unit, 566 DB, 258 browser, load smoke 0 errors)
- Round 3 closed CFDIFIX-R2-1..R2-7 (R2-2 by refusing with cfdi_self_invoice_pending_printed). A focused re-review of round 3 runs in parallel; any must-fix lands on integration before the final PR.
- Acceptance part 2 absorbs integration (cfdifix) and does ACC-PR-4/5b/6 + gate reruns (N twice, K against the fake).
- The Mac's maintenance sleep failed one browser run: long runs use caffeinate (lead keeps `caffeinate -dims` running).

## LD-62 cfdifix round-3 re-review: approve (no must-fix in round 3); pre-existing CFDIFIX-R3-1 fixed before release
- R3-1 (medium, predates round 3): while a waiting change turns reissue on, reissue is allowed when either the in-force or the waiting terms allow it (portal request, expiry check, reissueAllowed), matching deadlineOf. R3-2 lint precision and R3-3 global-setup timezone reset in the same small round on track/cfdifix (merged again into integration afterwards).

## LD-63 Release candidate (integration/v1 after c1fa202 acceptance merge, 23786d2 formatting, final docs)
- Everything planned for phases 1-4 is merged on integration/v1: Waves 1-2, public 032-034, LD-46 client address, W3-1 polish, W3-2 flake + follow-ups (035), CFDI rehearsal fixes (036), W3-3 restaurant-day gate; migrations 001-036.
- Final verification before the release PR: full CI-parity qualification on the final head and the restaurant-day gate on the final code (branch N + branch K against the fake).
- After the release PR merges (squash) and staging deploys green: apply ops/github/main-ruleset.json with github-protect.sh (adds restaurant-day and restaurant-day-cfdi as required checks), set RD_NIGHTLY_REF=main, dispatch the restaurant-day workflow once on main.
- Owner-only, pending (LAUNCH_HANDOFF §1): production launch itself; R2 + age for backups; old Neon branch pre-021-staging-backup-2026-09-30 decision; production legal values (LD-3); accountant review (IVA/RESICO/CFDI incl. Base/Importe rounding); counsel review of privacy texts; Google OAuth production client; Stripe live; Facturapi User key + CSD per restaurant; pilot hardware; production custom domain DNS-only.

## LD-64 Release v1 merged (PR #8 squash 9e95329) and staged
- PR CI: qualify, security, restaurant-day (first CI run, green), cfdi-key; restaurant-day-cfdi skipped (no key). Staging deploy 37777378586 applied 036; smoke all six checks green; staging check: gm_staging_app_r20261007 holds UPDATE on the new cfdi_settings columns, no gm_app role exists.
- Ruleset 24624180 now requires qualify, security, restaurant-day, restaurant-day-cfdi; RD_NIGHTLY_REF=main; restaurant-day dispatched on main (run 37777754078).

## LD-65 Old Neon branch deleted (2026-10-08, owner's approval)
- pre-021-staging-backup-2026-09-30 (br-polished-hall-aem062zv) deleted; the project keeps only its primary branch. No branch carries pre-rotation passwords any more. LAUNCH_HANDOFF 1.19 and STAGING.md's rotation log get this line in the next PR (bundled with the backup wiring when the owner sends R2 + age).

## LD-66 Staging backups: R2 wired (2026-10-08)
- Owner created bucket gm-backups-staging and gave an R2 Object Read & Write API token (expires 2026-11-07; it cannot list/create buckets or manage lifecycle). Verified over S3: list, put, get, delete on the bucket. GitHub env staging: R2_ACCESS_KEY_ID (token id), R2_SECRET_ACCESS_KEY (sha256 of the token value), vars R2_ACCOUNT_ID, R2_BUCKET. Token value only in scratchpad secrets/cloudflare.env.
- Lifecycle rules (daily/ 35 d, monthly/ 1900 d) must be set by the owner in the dashboard (token lacks permission).
- Rotate the R2 token before 2026-11-07 (or replace it with a non-expiring bucket-scoped token): LAUNCH_HANDOFF note in the next PR.
- Still needed before the first backup: the owner's age public key (age1…) committed to ops/backup/age-recipients.txt.
