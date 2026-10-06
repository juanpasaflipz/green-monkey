# Reports

Status on October 5, 2026: **reports FULL, phase A live, phase B built and waiting for
fiscal (027) and discounts (028)**. Reports read fiscal's and discounts' tables and call
their functions, which are not on this branch yet, so the work is split (wave2-cross-track
§2):

- **Live on this branch (phase A).** Migration 029 (versioned business-day settings,
  `business_date_at()`, corte print records). The read-only report snapshot. The routes
  `GET /api/reports/audit` (the Bitácora), `/api/reports/filters` and
  `/api/reports/tenders`. Printed **kitchen cancellation chits** on a KDS with auto-print
  and on a selling device with "Imprimir comanda al enviar". Every `reports*` string and
  error in Spanish and English. The `online` prop of Operations. Offline, Hoy and Finanzas
  no longer fetch the old `/report` and say "Los reportes requieren conexión.".
- **Built, not yet wired (phase B).** The statements S1–S5 and every other report query, the
  Hoy dashboard, the eight Finanzas tabs, the corte X/Z and corte del día documents and
  prints, CSV exports, the remote close of an orphaned drawer and the legacy `/report`
  move. They are typed against fiscal's and discounts' documented signatures
  (`server/reports/ports.ts`) and register once those modules merge ("Merge wiring" below).
  Until then Hoy and Finanzas show the old view, and `/api/report` is still the old route in
  `server/index.ts`.

Nothing here has been checked with a physical printer or by an accountant.

## Three date lenses

Each figure belongs to exactly one lens; labels and hints say which.

- **Ventas (sales).** Orders by their stored `orders.business_date` (offline orders carry the
  sale day). Gross, discounts, total, orders, voids, outstanding, COGS and the product,
  category, employee, hour, channel and service-type breakdowns.
- **Reembolsos (refunds).** The refund batch's business date (discounts computes it once per
  refund command and fiscal dates the IVA adjustment with the same value). A batchless
  refund recorded before 028 uses `business_date_at(created_at)`.
- **Cobros (collections).** Each tender on its collection day: an offline-synced tender on the
  sale day from the offline ledger, a recovery order's tender on the recovery order's
  business date, any other tender on `business_date_at(created_at)`. Paid-outs by movement
  date. Drawers by opening date.

**Business date of an instant** = `((at AT TIME ZONE zone) − cutoff minutes)::date` with the
settings **in force at that instant**. Migration 029 records every timezone or cutoff change
in `business_day_settings` through an `AFTER UPDATE` trigger on `restaurants` (so the
previous app revision is covered too), and `business_date_at(tenant, at)` is the single SQL
definition. Report queries use the equivalent `cfg` join (`server/reports/days.ts`). A cutoff
change therefore moves only records created after it; the DB suite checks that past days'
collections and activity pages are identical before and after a change from 04:00 to 02:00,
and that the formula equals `businessDate()` on 10,000 instants including the Tijuana DST
changes. Changes made before 029 are not reconstructed (decision D4; only staging data
predates it).

**Contract for other areas:** any code path that updates `restaurants.timezone` or
`restaurants.cutoff` must run inside the restaurant's tenant scope (`tenant()`), because the
history trigger inserts under FORCE RLS. Outside it a non-superuser updates nothing.

## Metric contract and checks

All amounts are integer centavos; prices include IVA. `shared/reports.ts`
(`composeSalesSummary`) builds every figure from the per-day aggregates of S1–S5; the
definitions are spec §2.2. Highlights:

- Ventas brutas − Descuentos = Ventas totales, by construction.
- IVA comes only from fiscal's `fiscalSummary` (`SalesSummary.tax`), read in ≤ 31-day chunks
  and merged (`mergeFiscalSummaries`). It is never recomputed from orders or CFDI totals.
  Fiscal splits refund IVA by complement extraction, so a day's net IVA equals the IVA cfdi
  stamps on that day's global invoice; an egreso's IVA may differ from fiscal's adjustment
  by ≤ 1 centavo per category (see docs/FISCAL.md and docs/CFDI.md). Without fiscal data
  (non-MXN) the IVA card says so and the margin shows "—".
- COGS counts remaining units of ticketed orders at the line's cost snapshot; voided units
  not returned to stock are waste cost; restocked refunds return their cost.
- Offline sales (`channel = 'offline'`) exclude manager recovery orders, which are disclosed
  as "Ventas sin conexión conciliadas (sin detalle de productos)".
- Amount refunds need a fully paid check (discounts' `refund_balance_due`).

Every summary computes six reconciliation checks (`lines_vs_orders`,
`discounts_vs_allocations`, `tickets_vs_orders`, `paid_identity`, `methods_sum`,
`refunds_vs_fiscal`). The UI shows "Todos los totales cuadran." or the failing codes with the
request id; a failed check logs `report_check_failed` with that id and never throws. A
batchless refund recorded by the previous revision during a deploy overlap has no fiscal
adjustment and fails `refunds_vs_fiscal` for that day on purpose (a real IVA gap).

Reports run in one `REPEATABLE READ, READ ONLY` transaction (`snapshotTenant`) whose first
statement sets the tenant, `statement_timeout` 30 s, `lock_timeout` 8 s and the idle timeout
15 s, so a payment committing half way never breaks a summary's checks. A statement timeout
answers `reports_timeout` with **HTTP 422** (LD-15 Q1): a domain answer the client never
retries. The client waits up to 40 s for report reads and prints, and report outcomes count
as reachability only (`src/connectivity.ts`): a slow report never makes a device look
offline.

## Views (phase B)

- **Hoy:** the current business date, refreshed every 60 s while visible: tiles (Ventas
  totales with the same-weekday comparison, Órdenes, Ticket promedio, Efectivo cobrado,
  Terminal cobrado, Propinas), alerts, checks with a balance ("cuentas con saldo": a paid
  dine-in check waiting for Liberar mesa is not counted), open drawers with Corte X, top
  sellers and today's exceptions. No forecast text.
- **Finanzas:** a range picker (Hoy, Ayer, Esta semana, Semana pasada, Este mes, Mes pasado,
  custom; weeks start Monday) and eight tabs: Resumen, Productos, Personal, Horas y canales,
  Pagos, Cortes, Excepciones and Bitácora. Summaries and cortes read up to 92 days, row lists
  up to 31. Each tab has Actualizar and Descargar CSV.
- **Personal** attributes a check to its assigned server, else to whoever opened it. QR and
  kiosk orders run under the link creator's session, so unassigned ones form a **"QR /
  Kiosco"** row instead of crediting that employee (LD-15 Q4).
- **Excepciones** (loss prevention): voids, discounts, discount removals, refunds, cash
  paid-outs, drawer and terminal differences, receipt and corte Z reprints, open-price
  lines, and archived or reconciled offline sales, each with actor, approver, amount, order,
  reason and device, plus totals per kind and per employee. A self-approved row (a manager
  acting alone) shows the approver's name, but only approvals given to someone else count in
  "Autorizó" (LD-16 L3). Drawer shortages and overages never cancel out.
- **Bitácora:** keyset paging past the old newest-100 limit, filters by employee, activity
  group and order number, translated labels. Activity groups match by operation prefix
  (`AUDIT_GROUPS`), including forward prefixes for cfdi (030), account (031) and public
  ordering, and a unit test keeps every labelled operation in a group.

## Cortes

- **Corte X** (open drawer): float, cash sales and tips, cash refunds, paid-outs (and pay-ins
  when any), expected cash; the terminal section; payments; controls (discounts, refunds and
  paid-outs on that device while the drawer was open) and the folio range issued there.
- **Corte Z** (closed drawer): every figure as of close. Tenders recorded after the close
  (offline late sync) are disclosed apart ("Registrado después del cierre"). Stored expected
  and counted cash, the signed difference (faltante / sobrante / cuadra), the explanation,
  the review, the terminal batch total and difference, and two signature lines.
- **Count slip** (blind count): for a cashier or server who may not see expected cash: the
  counted cash, the terminal section and the payment count only. The server never sends the
  hidden figures.
- **Corte del día:** the Resumen rows of one date (the same i18n keys, so an acceptance label
  bound for one binds for both), the drawers, the controls and the cost line, on 58/80 mm or
  as a letter/A4 sheet ("Imprimir o guardar PDF").
- **Numbering.** The Z number is a drawer's position among this location's closed drawers by
  `(closed_at, id)`: computed and gapless, and stable once the closes involved have committed.
  `closed_at` is taken when the close updates the row, so two drawers closing at nearly the
  same moment can commit in the opposite order. A report or print that reads after the first
  commit and before the second can show a drawer as Z n that every later read numbers n+1, so
  a Z printed in that window disagrees with its reprint. It needs two closes within the same
  instant (a remote close stays open longer, because it builds the corte Z before it commits)
  and a print in between. A stored, serialized Z counter would remove it (a later expand
  migration, not in 029). Every print is recorded in `report_prints`, one sequence per document: the corte X,
  the corte Z, the blind count slip (kind `count_slip`) and the corte del día. The second
  print of a document says "REIMPRESIÓN 2". A cashier's count slip and the manager's corte Z
  of the same drawer are different documents, so the manager's first Z is print 1, and only
  reprints of the full Z are audited as `reports.corte_z.reprinted` and listed as
  `corte_reprint` exceptions (slips are audited as `reports.count_slip.printed`). Prints of
  one document serialize on the advisory key `tenant:report-print:kind:subject` (lock level
  LO-3) before numbering, so two prints at once get 1 and 2. The subject is the lowercase
  drawer id, whatever case the URL used.
- **Access** (spec §4.7, §2.12): owners and managers print any corte Z in full and a corte X
  when they may see expected cash. Cashiers and servers print only their own device's
  drawer: a corte X if they may see expected cash, and the corte Z or count slip of the
  device's **last** drawer closed in the last 12 h, so the next shift on a shared device
  cannot print the previous shift's count (LD-15 Q6).
- **Blind count and Finanzas** (LD-15 Q5, option 2): the Cortes table hides an open drawer's
  expected cash from viewers who may not see it, but only owners and managers reach
  Finanzas, and they can work expected cash out from the tender figures anyway. Blind count
  protects cashiers and servers, not managers.
- **Remote close:** a manager, with the PIN step-up, closes a drawer whose device was
  revoked or deactivated, or that is still open from an earlier business date ("Cerrar caja
  desde aquí" in Cortes). It counts visibly with a required reason, goes through discounts'
  `closeDrawerRow`, is audited `cash.close` with `remote: true`, and answers with the corte
  Z. A same-day drawer of a healthy device is refused (`reports_drawer_not_orphaned`).
  Unsynced offline sales left on a revoked device are archived or reconciled in Recuperación.

Every document says "Documento interno; no es comprobante fiscal." Internal documents
(cortes, corte del día, report sheets, kitchen tickets and cancellation chits) print in the
device's UI language; customer comprobantes always print in Spanish (D17).

## Printing setup and kitchen cancellation chits

Service (024) prints kitchen tickets, receipts and pre-bills through the browser
(docs/SERVICE.md "Printing"). Reports adds **cancellation chits** ("CANCELACIÓN · NO
PREPARAR", or "REEMBOLSADO · NO PREPARAR" for refunds), one per round and station:

- A KDS device with "Imprimir tickets nuevos automáticamente en esta pantalla" prints a chit
  for each void it sees for the first time; its station filter applies, so a bar screen
  prints bar cancellations only.
- A selling device with "Imprimir comanda al enviar a cocina" prints the chits after a void
  (and, once discounts is wired, after an item refund of unserved units).
- Printing never blocks or fails the void. If the chit does not print, the void dialog says
  "La anulación quedó registrada." and "No se pudo imprimir la cancelación." and offers only
  "Reintentar impresión" or Cerrar (no second void from the same dialog).

A restaurant uses one of two setups: one device per station with its KDS station filter and
auto-print on, or one selling device with "comanda al enviar" printing every station's
section on its own printer. Set the thermal printer's roll size and zero margins in the OS
driver. Silent printing needs Chrome or Edge started with `--kiosk-printing` and the thermal
printer as the OS default (described as working on Windows; macOS and Android always show the
dialog); the kiosk flag is not verified on pilot hardware yet (LD-17). Browser printing never
confirms that paper came out. Cash-drawer kick and auto-cut depend on the printer driver.

## CSV

UTF-8 with BOM, comma separator, CRLF, quoted fields with doubled quotes, headers in the UI
language, money as dot decimals with the currency exponent, dates `AAAA-MM-DD` and date-times
`AAAA-MM-DD HH:mm` in the restaurant zone. A text cell that starts with `= + - @`, TAB, CR,
LF or a full-width `＝＋－＠` is prefixed with `'` (OWASP formula injection). Files are
`{dataset}_{from}_{to}.csv` (or `{dataset}_{date}.csv`); paged datasets export every page up
to 20,000 rows and then say "La exportación se detuvo en 20,000 filas. Reduce el rango.". The
writer is `shared/csv.ts` (cfdi and fiscal reuse it). For Excel set to another locale use
"Datos → Desde texto/CSV".

## Roles and plans

Hoy, Finanzas, CSV and the corte del día: owners and managers. Cortes: see "Access" above.
Remote close: owners and managers with the step-up. Kitchen cancellation printing: a device
setting. Reports and prints work on Free and while selling is blocked.

## Runbook

- **"Cambié la hora de corte."** Only records created after the change move. Past reports are
  unchanged (the settings history is in `business_day_settings`).
- **"Una caja quedó abierta."** Finanzas → Cortes → "Cerrar caja desde aquí" (manager, PIN).
  Count the drawer's cash first; reconcile or archive unsynced offline sales in Recuperación.
- **"Reimprimir un corte Z."** Finanzas → Cortes (or Caja → Historial de cajas) → Reimprimir
  corte Z; it prints "REIMPRESIÓN n" and appears in Excepciones.
- **"Los totales no cuadran."** Send support the codes and the request id shown under
  Comprobaciones; the server log line `report_check_failed` carries the same id.
- **"Exportar para el contador."** Finanzas → Resumen and the tabs → Descargar CSV, plus
  fiscal's ticket register. Reports are internal documents, not comprobantes.

## Merge wiring (phase B, after 027 and 028)

1. `server/routes/reports.ts`: `register(ctx)` passes the ports instead of `null`:
   `{ fiscalSummary, missingTicketCount }` from `../fiscal.js`, `moneyControls` from
   `../discounts.js`, `canSeeExpected` from `../../shared/discounts.js`, `closeDrawerRow` from
   `../cash.js` (signatures in `server/reports/ports.ts`).
2. `server/index.ts`: delete the old `/report` route and the `businessDate`, `boundaries`
   imports (wave2-cross-track C13); `registerReports` re-registers `/report`.
3. `src/features/Operations.tsx`: add `"today"`, `"finance"` to the self-loading list, drop the
   `today`/`finance` → `report` mapping, the phase-A offline guard, its `shownOnline`
   reload effect and the `loads` sequence check (the views poll with `enabled: online`
   themselves), replace the old
   Today/Finance block with `<TodayDashboard … online={online} />` and
   `<ReportsView … online={online} />`, point the settings "Historial de auditoría" button at
   `openReports("audit"); navigate("finance")`, and drop the then unused `ArrowUpRight`,
   `Empty` and `useRef` imports.
4. Slots in discounts' components (C9, C10): `actions={<CortePrintButton … label="Corte X"
   online={online} />}` on `DrawerPanel` for an open drawer the viewer may see; one
   `CortePrintButton` (Imprimir corte Z / comprobante de conteo) in `DrawerCloseDialog`'s
   result step; `rowActions` on `CashHistory` from Operations with a Corte Z button.
5. `RefundDialog`: after an item refund, `printCancellations(cancellationsFromRefund(order,
   batch, reason), …)` when "comanda al enviar" is on; confirm that discounts'
   `RefundBatchView` has `lines[].lineId/units/kitchenPending`.
6. `src/features/reports/exception-text.ts` `reasonLabel`: return discounts' discount-reason
   and refund-reason labels (C18).
7. `tests/browser/core.spec.ts` (Hoy drill-down): `.metric-grid` → `.report-tiles`, and
   "Ver órdenes" instead of the first metric.
8. Docs: docs/ACCESS.md (remote close replaces the support-SQL workaround), this file's
   status, DELIVERY_STATUS and the ledgers.
9. Shared cleanups (wave2-cross-track C16, LD-16 L5): after fiscal converts
   `tests/access-db.ts`, `tests/offline-sync-db.ts` and `tests/offline-recovery-db.ts` to
   the named-trigger transaction, append `report_prints` and `business_day_settings` (and
   their triggers `report_prints_immutable`, `business_day_settings_immutable`) after the
   discounts tables, as `tests/fixtures/reports-cleanup.ts` orders them.
10. `scripts/grants.sql` and `package.json` (C23): the `-- 029 reports` grants block and the
    `test:db:reports` entry and qualification suffix go after discounts' (merge order).
11. The `online` prop (LD-18 LD-P5): keep one copy; this branch already carries discounts'
    exact text, doc comment included.
12. `tests/reports-phaseb-db.ts` moves to the real commands (spec §7.2): payments that issue
    fiscal tickets, `applyDiscount`/`reverseDiscount`, `recordRefund` in items and amount
    modes and the legacy refund, `closeCash`/`reviewDrawer`, `recordPaidOut` and offline
    sync/reconcile. Hand-inserted rows stay only for clock-dependent cases. It also gains
    spec DB tests 3 (past summaries, breakdowns and exceptions unchanged after a cutoff
    change), 12 (a 60-day summary merges two fiscal chunks), 18 (a non-MXN restaurant has
    null tax and margin), 33 (performance), 35 (complement extraction), 37 (a refund at the
    cutoff instant; a batchless refund fails refunds_vs_fiscal) and 38 (acceptance rows).
    Until then the reconciliation checks are proven only against self-consistent hand rows.
13. Browser tests (spec §7.3) in `tests/browser/reports.spec.ts`, required with the views:
    1 (ranges, Efectivo/Terminal split, axe on Finanzas), 2 (Productos, Personal, Horas and
    their CSVs), 3 (Resumen rows and "Todos los totales cuadran."), 4 (Excepciones with the
    employee filter and CSV), 5 (Bitácora paging and filters), 6 (corte X, close, corte Z and
    REIMPRESIÓN 2), 7 (the blind count slip, then the manager's first corte Z of that drawer
    without REIMPRESIÓN: RPT-R11), 8 (58 and 80 mm fit), 9 (Hoy and its
    previous-day drawer alert resolved by the remote close), 13 (the disabled Caja "Corte X"
    with its reason) and 14 (390 and 768 px without page-wide scroll, axe on Hoy and the
    corte preview). Add the phase B GETs to the HTTP check (no-store, cashier forbidden)
    and check that a print or remote-close POST without the CSRF token is refused.

`tests/reports-phaseb-db.ts` (part of `test:db:reports`) skips until 027 and 028 are migrated
and then runs against the real modules. Before the merge it ran twice outside the repository:
first against the 027/028 DDL as fiscal.md and discounts.md write it, with stand-in ports;
then (15 checks) in a scratch copy of this branch with fiscal's and discounts' current
migrations and modules on a CI-parity database. The 15 checks cover S1–S7 with every
reconciliation check, the breakdowns, order and tender lists, all twelve exception kinds with
their summary, drawer figures against `drawerTotals`, X/Z prints and reprints, two
concurrent Z prints numbered 1 and 2, a cashier's count slip followed by the manager's first
corte Z (print 1, no corte_reprint; an uppercase drawer id in the same sequence), the corte
del día, Hoy alerts, the role refusals, the
remote close with its step-up and both orphan reasons, and the legacy `/report`. The phase A
suite (`tests/reports-db.ts`) also refuses cashier, server and kitchen on every phase B
function and checks the remote-close step-up before any 027/028 statement runs, so those
checks already run in qualification. The phase B views were rendered only in an uncommitted
setup (axe on Hoy and the Finanzas tabs, 390 px, CSV and print flows); item 13 re-proves that
with committed tests at the merge.

## Limitations and decisions

Deferred (spec §1.3): scheduled or emailed reports and server PDFs (no mail provider; print
or "Guardar como PDF" instead), forecasts, per-option sales, organization-wide consolidated
reports (RLS forbids cross-tenant reads), per-employee "collected by" (tenders carry no
employee), tip distribution, inventory valuation, delivery-platform imports and ESC/POS
printer SDKs. The integrations panel keeps "Impresión directa a impresora" disabled: browser
printing works without it, and that label describes direct printer integration, which does
not exist (spec D16 not applied). This deviation still needs a lead decision: wave2-cross-track
C13 says reports sets `printer` at `server/index.ts:559`, and cfdi plans to keep that line.
Until a decision is recorded, `/capabilities` keeps `printer: {enabled: false, reason:
"device_not_paired"}`, so cfdi's "keep reports' printer line" has nothing to keep.

The blind count slip numbered apart from the corte Z (kind `count_slip`) departs from the
spec's literal `kind = "corte_" + p.kind` (§4.5 printDrawerCorte) to keep the spec's own rule
that the second print *of a document* is the reprint (review RPT-R11); it needs the lead's
sign-off. Decisions D1–D20 are in the spec; the binding lead decisions are LD-15 (reports Q1,
Q4–Q7) and LD-16 (L3, L5, L7, L8).

## Sources

- Corte X vs Z practice: posretailsolutions.com.mx and docs.cofac.mx (spec §13).
- Tips belong to workers (LFT arts. 346-347) and are outside the IVA base (SAT 33/IVA/N).
- Refund adjustments in the refund period: LIVA art. 7. Five-year retention: CFF art. 30.
- CSV: RFC 4180; formula injection: OWASP CSV Injection.
- PostgreSQL (`AT TIME ZONE`, function volatility, repeatable read snapshots, advisory locks)
  and postgres.js 3.4.8 (`sql.begin(options, fn)`, nested fragments, `sql.unsafe`
  fragments), checked with Context7.
