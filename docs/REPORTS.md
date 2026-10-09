# Reports

Status on October 6, 2026: **reports FULL, wired on fiscal (027) and discounts (028)** at
reports' merge (integration/v1 at 5e74ee6), with the second opinion's findings fixed (LD-27).
Migration 029 (versioned business-day settings, `business_date_at()`, corte print records, the
drawer folio index), Hoy, Finanzas (eight tabs), the corte X / Z / count slip / corte del día
prints, CSV exports, the remote close of an orphaned drawer, the kitchen cancellation chits
(KDS, void and item refund) and the legacy `/report` (served by reports for older bundles) are
live. Reports read fiscal and discounts through `server/reports/ports.ts` (the real modules;
tests wrap them) and call discounts' `closeDrawerRow` directly.

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
  Folios stay fiscal's contiguous runs: a series has several runs when a late offline sync, a
  repair or a cross-day settlement puts a later folio into an earlier date, and the merge
  joins two runs only when one continues the other across a chunk boundary, so Resumen, its
  CSV and the corte del día never print a range across a gap (LD-27 SQL-1).
  Fiscal splits refund IVA by complement extraction, so a day's net IVA equals the IVA cfdi
  stamps on that day's global invoice; an egreso's IVA may differ from fiscal's adjustment
  by ≤ 1 centavo per category (see docs/FISCAL.md and docs/CFDI.md). Without fiscal data
  (non-MXN) the IVA card says so and the margin shows "—".
- COGS counts remaining units of ticketed orders at the line's cost snapshot, and of orders
  comped to zero (fiscal never tickets a zero total: a staff meal's food cost still counts);
  voided units not returned to stock are waste cost; restocked refunds return their cost.
  Horas y canales places a manager's financial recovery at its original sale time.
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

## Views

- **Hoy:** the current business date, refreshed every 60 s while visible: tiles (Ventas
  totales with the same-weekday comparison, Órdenes, Ticket promedio, Efectivo cobrado,
  Terminal cobrado, Propinas), alerts, checks with a balance ("cuentas con saldo": a paid
  dine-in check waiting for Liberar mesa is not counted), open drawers with Corte X, top
  sellers and today's exceptions. No forecast text.
- **Finanzas:** a range picker (Hoy, Ayer, Esta semana, Semana pasada, Este mes, Mes pasado,
  custom; weeks start Monday) and eight tabs: Resumen, Productos, Personal, Horas y canales,
  Pagos, Cortes, Excepciones and Bitácora. Summaries and cortes read up to 92 days, row lists
  up to 31. Each tab has Actualizar and Descargar CSV. A tab shows figures only for the range
  and filters they were fetched for: while another range loads, after it fails and offline the
  previous figures are gone, so a CSV, a sheet or a tile never pairs the new range with old
  figures; a paged list (Pagos, Excepciones, Bitácora) restarts at its first page when a filter
  changes, and the Caja filter of Pagos is cleared when the range changes. Resumen's Cajas card
  shows faltantes and sobrantes apart, then the net with its word (faltante / sobrante /
  cuadra); every drawer or terminal difference in Excepciones starts with its word; refunds
  show their cash and terminal split as rows of their own; tile amounts never wrap mid-number.
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
  (`AUDIT_GROUPS`), including forward prefixes for cfdi (030), account (031), public
  ordering and the platform's `job.` operator commands (Configuración, LD-21), and a unit
  test keeps every labelled operation in a group.

## Cortes

- **Corte X** (open drawer): float, cash sales and tips, cash refunds, paid-outs (and pay-ins
  when any), expected cash; the terminal section; payments; controls (discounts active at the
  end of the window, refunds and paid-outs on that device while the drawer was open) and the
  folio runs of the tickets issued on that device while it was open, by issue time (an old
  order's ticket issued there counts; folios other devices issued in between are gaps; more
  than four runs of a series print as one "… en N tramos" line).
- **Corte Z** (closed drawer): every figure as of close; a discount reversed after the close
  stays on it, so a reprint equals the signed original. Tenders recorded after the close
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
  instant and a print in between (the remote close commits the close alone and reads its corte
  Z afterwards, so its window is as short as any close). A stored, serialized Z counter would
  remove it (a later expand migration, not in 029). A printed document comes from one
  `REPEATABLE READ` snapshot, so a payment committing during the print is on none of its
  lines; its number comes from a separate `READ COMMITTED` transaction. Every print is
  recorded in `report_prints`, one sequence per document: the corte X,
  the corte Z, the blind count slip (kind `count_slip`) and the corte del día. The second
  print of a corte Z, count slip or corte del día says "REIMPRESIÓN 2"; a corte X never
  does, because each one is a new partial reading with new figures (RPT-R20). A cashier's
  count slip and the manager's corte Z of the same drawer are different documents, so the manager's first Z is print 1, and only
  reprints of the full Z are audited as `reports.corte_z.reprinted` and listed as
  `corte_reprint` exceptions (slips are audited as `reports.count_slip.printed`). Prints of
  one document serialize on the advisory key `tenant:report-print:kind:subject`, class 930
  (an LO-3 area key; class 0 would be an LO-1 operation key after once()'s LO-2; 926 is
  cfdi's per-ticket key, LD-31) before numbering, so two prints at once get 1 and 2. The
  subject is the lowercase drawer id, whatever case the URL used.
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
  Z, read after the close commits. A same-day drawer of a healthy device is refused
  (`reports_drawer_not_orphaned`). An earlier day's drawer whose device was seen or took a
  payment in the last 10 minutes is refused too (`reports_drawer_in_use`, "ciérrala en su
  dispositivo"): that device's own close runs the pending-sync guard. The dialog reads the
  drawer's live corte X when it opens and again before the confirm step, and sends that
  reading's fingerprint (every money figure of the drawer); under the drawer lock the server
  refuses a drawer that changed since (`reports_drawer_changed`), so a count never closes
  against figures the manager did not see, and the dialog asks for a recount (LD-27
  CORTES-1). Unsynced offline sales left on a revoked device are archived or reconciled in
  Recuperación.

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
driver. There is no confirmed way to print without the browser's print dialog today
([PILOT_SOP §1.3](PILOT_SOP.md)): every chit, like every comanda and receipt, opens the dialog,
so the KDS auto-print setup is practical only on a device verified to print without it.
Public sources, not official Chrome or Chromium documentation, describe Chrome started with
`--kiosk-printing` as printing silently on Windows; it is not verified here, and the pilot
does not depend on it (LD-17, [Service](SERVICE.md)). Browser printing never confirms that
paper came out. Cash-drawer kick and auto-cut depend on the printer driver.

## CSV

UTF-8 with BOM, comma separator, CRLF, quoted fields with doubled quotes, headers in the UI
language, money as dot decimals with the currency exponent, dates `AAAA-MM-DD` and date-times
`AAAA-MM-DD HH:mm` in the restaurant zone. A text cell that starts with `= + - @`, TAB, CR,
LF or a full-width `＝＋－＠` is prefixed with `'` (OWASP formula injection), and a text cell
with a `;` or TAB before such a character is quoted, so Excel with a `;` list separator never
splits it into a formula cell. Files are
`{dataset}_{from}_{to}.csv` (or `{dataset}_{date}.csv`); paged datasets export every page up
to 20,000 rows and then say "La exportación se detuvo en 20,000 filas. Reduce el rango.". The
writer is `shared/csv.ts` (cfdi and fiscal reuse it). For Excel set to another locale use
"Datos → Desde texto/CSV".

## Club de lealtad (038)

Finanzas › "Club de lealtad" ([Loyalty](LOYALTY.md)), owners and managers, one read-only snapshot for
the business-date range (92 days at most): members (total, new in the period, imported, with purchases),
stamps (earned, reversed, adjustments), rewards (earned net of withdrawals, redeemed net of
restorations, the redemption rate, and their value as active `loyalty_reward` discounts by the order's
business date), member sales (Σ stamp base of linked settled orders and its share of all settled
sales) and the top 10 members by visits. The check `loyalty_ledger_vs_members` shows an alert when a
member's cached balances differ from their ledger. Rewards are discounts, so the drawer, cortes and
Excepciones need no change: they show "Recompensa del club" as any discount. The Bitácora has a
"Club de lealtad" group (`loyalty.*`).

## Roles and plans

Hoy, Finanzas, CSV and the corte del día: owners and managers. Cortes: see "Access" above.
Remote close: owners and managers with the step-up. Kitchen cancellation printing: a device
setting. Reports and prints work on Free and while selling is blocked.

## Runbook

- **"Cambié la hora de corte."** Only records created after the change move. Past reports are
  unchanged (the settings history is in `business_day_settings`).
- **"Una caja quedó abierta."** Finanzas → Cortes → "Cerrar caja desde aquí" (manager, PIN).
  Count the drawer's cash first; reconcile or archive unsynced offline sales in Recuperación.
  "Esta caja se usó en su dispositivo…": close it on that device (Caja). "La caja cambió…":
  money reached the drawer after the dialog read it; count again against the new expected
  cash.
- **"Reimprimir un corte Z."** Finanzas → Cortes (or Caja → Historial de cajas) → Reimprimir
  corte Z; it prints "REIMPRESIÓN n" and appears in Excepciones.
- **"Los totales no cuadran."** Send support the codes and the request id shown under
  Comprobaciones; the server log line `report_check_failed` carries the same id.
- **"Exportar para el contador."** Finanzas → Resumen and the tabs → Descargar CSV, plus
  fiscal's ticket register. Reports are internal documents, not comprobantes.

## Integration notes (reports 029 merge)

Wired at the merge on fiscal 027 and discounts 028 (wave2-cross-track §2 phase B):

- `server/reports/ports.ts` holds the real fiscal and discounts functions; every report route
  registers in `server/routes/reports.ts` and the old `/report` left `server/index.ts`
  (C13; the legacy keys and semantics are kept for older bundles).
- Operations mounts `TodayDashboard` and `ReportsView` with `online` and `refreshKey`; the
  settings "Historial de auditoría" button opens the Bitácora. The `online` prop text is
  discounts' (LD-18 LD-P5).
- Corte buttons in discounts' components (C9, C10, LD-16 L6): `DrawerPanel` `actions` (Corte X
  of an open drawer the viewer may see), `closedActions` (the closed drawer's corte Z or count
  slip: managers, or the device's cashier for 12 h), `closeResultActions` (the close dialog's
  result step, passed to `DrawerCloseDialog` `resultActions`), and `CashHistory` `rowActions`
  (Imprimir corte Z next to "Revisar diferencia").
- `RefundDialog` prints the kitchen cancellation chits of an item refund with "comanda al
  enviar" (a failed chit offers only a print retry). Reason codes read with discounts'
  `reasonLabel(kind, code)` in Excepciones, the Bitácora and their CSVs (C18).
- `AUDIT_GROUPS` keeps the forward prefixes (`cfdi.`, `account.`, `public.*`) and puts the
  platform's `job.` commands under Configuración (LD-21).
- Shared cleanups follow LD-16 L5 (`tests/fixtures/reports-cleanup.ts`); grants and the
  qualification chain follow fiscal and discounts (C23).
- DB suites: `tests/reports-db.ts` (migration 029, snapshot, role refusals before any fiscal
  or discounts statement) and `tests/reports-phaseb-db.ts` (S1–S7 and every report against
  the real modules, plus fiscal's and discounts' commands on the demo tenant for the second
  opinion's cases: the remote close's fingerprint and in-use refusal, a payment committed in
  the middle of a corte X and a corte del día print, a whole-check comp's COGS, folio runs).
  Browser: `tests/browser/finance.spec.ts` (spec §7.3 tests 1–9, 13, 14) and
  `tests/browser/reports.spec.ts` (kitchen chits, A13.8, the HTTP routes with CSRF).

For cfdi (030): the report-print key moved from advisory class 926 to **930** (cfdi's
per-ticket key keeps 926; ARCHITECTURE LO-3), so `tests/lock-scan.ts` sees two distinct LO-3
keys. cfdi fills the anchors: `collectAlerts()` adds the four `cfdi_*` attention codes
(`server/reports/today.ts`), `dayCorte()` sets `extra.cfdi` (`server/reports/cortes.ts`) and the
corte del día prints `doc.extra.cfdi` as a "Facturación (CFDI)" section; all three are absent
while CFDI is off. Hoy's `AlertLine` words the `cfdi_*` codes through cfdi's
`cfdiReportAlertText` and sends them to Configuración, where the CFDI panel and register live;
it still shows no line for a code it cannot word.

Spec DB tests 12 (a 60-day summary in two fiscal chunks), 18 (no IVA and no margin without
fiscal data) and 37 (a batchless refund fails `refunds_vs_fiscal`) run in the DB suites. Not
done here (follow-ups): spec DB tests 3 for summaries, breakdowns and exceptions (DB-7/MON-6
covers collections and activity pages), 33 (performance), 35 (fiscal's complement extraction,
covered in fiscal's suite) and 38 (the acceptance rows, covered by unit test 21 on the
document). `DocRow` is not adopted in the receipt documents in v1 (LD-16 L8; the reason is
in [delivery status](DELIVERY_STATUS.md), "Thermal receipts").

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
Q4–Q7), LD-16 (L3, L5, L7, L8), LD-27 (the second opinion) and LD-31 (class 930).

Open for a lead decision (second opinion REPORTS-SECURITY-1): Hoy and Finanzas keep the last
figures on screen offline (spec §5.2), and the lock screen's offline "Continuar como …" removes
the lock without a PIN over the same mounted view, so a manager's cached report can be read on
a locked tablet that went offline. Clearing report data when a lock engages, or remounting the
view after an offline continue, would close it; it is not changed here because §5.2 asks for
the cached figures.

## Sources

- Corte X vs Z practice: posretailsolutions.com.mx and docs.cofac.mx (spec §13).
- Tips belong to workers (LFT arts. 346-347) and are outside the IVA base (SAT 33/IVA/N).
- Refund adjustments in the refund period: LIVA art. 7. Five-year retention: CFF art. 30.
- CSV: RFC 4180; formula injection: OWASP CSV Injection.
- PostgreSQL (`AT TIME ZONE`, function volatility, repeatable read snapshots, advisory locks)
  and postgres.js 3.4.8 (`sql.begin(options, fn)`, nested fragments, `sql.unsafe`
  fragments), checked with Context7.
