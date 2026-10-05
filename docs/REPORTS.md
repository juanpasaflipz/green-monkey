# Reports

Status on October 5, 2026: **reports core only**. The pure modules for business-date
ranges, the metric contract's arithmetic, the reconciliation checks and the corte X/Z/del
día document model are implemented and unit tested. **Nothing in the running app calls
them yet.** There is no reports migration (029), no `server/reports/*` module, no
`/api/reports/*` route, no Finanzas or Hoy view, no CSV download button, no printed corte
and no i18n strings. The app still serves the old `GET /report` (current business day,
bucketed by `created_at`), so the audit findings FIT-7, MON-6, DB-7, OFF-9, GAP-3 and
FIT-10 stay open until the integration wave wires this core in.

## Reports core

Every amount is an integer number of minor units (centavos). Prices include IVA. The core
never computes IVA: it takes fiscal's `fiscalSummary` totals as input.

| Module | Contents |
| --- | --- |
| `shared/reports.ts` | `LIMITS` (92-day aggregates, 31-day lists, 500 rows per page, 20,000 export rows); `parseRange`, `isBusinessDate`, `addDays`, `rangeDates`, `quickRange` (Hoy, Ayer, Esta semana, Semana pasada, Este mes, Mes pasado; weeks start Monday); `currentBusinessDate`, `wideWindow`, and `wallClockBusinessDate` / `wallClockHour` (the SQL day formula in JS); `BREAKDOWNS`, `EXCEPTION_KINDS`, `DIFFERENCE_KINDS`, `AUDIT_GROUPS`, `auditGroupPrefixes`, `parseExceptionKinds`; the query and command schemas; `encodeReportCursor` / `decodeReportCursor`; `averageTicket`, `bps`, `aggregateInt`; `composeSalesSummary` and `reconciliationChecks`; `hourRows`, `exceptionSummary`, `exceptionTotals`; `drawerRow`, `drawerSummary`, `corteAccess`, `buildCorteDocument`, `folioRanges`, `otherDayDrawerCollections`, `buildDayCorteDocument`; and the wire types (`SalesSummary`, `DrawerRow`, `CorteDocument`, `DayCorteDocument`, …). |
| `shared/csv.ts` | `toCsv`, `csvCell`, `moneyCsv`, `percentCsv`, `dateTimeCsv`, `csvFileName`. |

Tests: `tests/reports.test.ts` (`npm test`), with the random sales world and reference
aggregator in `tests/fixtures/reports.ts`.

### Three date lenses

Each figure belongs to exactly one lens.

- **Ventas (sales).** Orders by their stored `business_date`.
- **Reembolsos (refunds).** Refunds by the refund's business date.
- **Cobros (collections).** Tenders by collection date. Offline-synced tenders count on the
  sale day, and recovery tenders count on the recovery order's date.

The business date of an instant is `((at AT TIME ZONE zone) − cutoff minutes)::date`, with
the settings in force at that instant. `wallClockBusinessDate` is that formula in JS. A unit
test checks it against `businessDate()` (the rule orders are stamped with) on 10,000 random
instants and minute by minute across the 2026 DST changes in America/Tijuana. An event at
exactly the cutoff instant belongs to the new day.

### Metric arithmetic and checks

`composeSalesSummary` builds every summary figure from the per-day aggregates. The server
statements S1–S5 (spec §4.5, next wave) produce those aggregates. The summary covers:

- sales: gross, discounts and courtesies, total with IVA, average ticket, voids, outstanding,
  tips on the checks, COGS and cost coverage. Ventas brutas is not an input: it is derived as
  `total + discounts`, per day and for the range (spec §2.2 `grossSales = Σ(total + discount)`).
  So `Ventas brutas − Descuentos = Ventas totales` holds by construction on the Resumen, on every
  day row and on the corte del día. The S1 `gross` column is not read;
- refunds, split into cash and terminal;
- collections by method: count, amount, tips, refunds and `net = amount + tips − refunds`,
  plus paid-outs and late offline collections;
- the margin from fiscal's totals;
- one row per business date of the range.

`reconciliationChecks` returns `lines_vs_orders`, `discounts_vs_allocations`,
`tickets_vs_orders`, `paid_identity`, `methods_sum` and `refunds_vs_fiscal`. Without fiscal
data (non-MXN), it skips the two fiscal checks.

Property tests over 400 random sales worlds check every summary figure against the records to
the centavo. The worlds include voids, comps, recovery orders, next-day and late offline
collections, later refunds and paid-outs.

**What the checks guard, and what they do not.** A one-centavo drift in one of these aggregates
fails exactly its own check (a property test drifts each one in turn):

| Check | Aggregates it compares |
| --- | --- |
| `lines_vs_orders` | S1 `total` and `recovery_total` against S2 `line_net` |
| `discounts_vs_allocations` | S1 `discounts` against S2 `line_discounts` |
| `tickets_vs_orders` | S1 `ticketed_order_total` and `ticketed_gross` against fiscal's `totals.gross` |
| `paid_identity` | S1 `overpaid`, and the sign of `outstanding` (`paid ≤ total` over the range) |
| `refunds_vs_fiscal` | S4 `fiscal_amount` against fiscal's `totals.refundGross` |

The checks do **not** see a wrong value in the other aggregates. They are S1 `paid` (beyond the
sign of `outstanding`), `tips`, the counts and the offline and unticketed figures; S2 voids,
courtesies, COGS, coverage and waste; every S3 collection figure; the S4 amounts and counts
(and all of S4 when there is no fiscal data); S4b restocked cost; and S5 paid-outs.
`methods_sum` holds by construction here, because the core derives `collected` and `tips` from
the same S3 rows as `byMethod`. A drift in any of those leaves every check green (the property
test asserts this too). The next wave's DB suite (`tests/reports-db.ts`, spec §7.2) is what
compares them with the records.

### Cortes

- **Corte X** (open drawer): expected cash is `opening + cash sales + cash tips − cash
  refunds − paid-outs`. The terminal section shows payments, tips, refunds and net.
- **Corte Z** (closed drawer): every figure as of close. Cash and terminal tenders recorded
  after the close (offline late sync, LD-7) are left out of sales, tips, the terminal net and
  the payment count. They are shown separately as `lateCash` and `lateTerminal` ("Registrado
  después del cierre"). The document uses the stored expected cash and the signed difference
  (faltante / sobrante / cuadra). The terminal batch difference uses the stored external
  expected, or the as-of-close terminal net for a legacy close without one. So the printed net,
  the reported total and the difference agree on one document.
- **Cortes table rows** (`DrawerRow`) cover every tender of the drawer, late ones included, and
  disclose the late parts in `lateCash` / `lateTerminal`.
- **Blind count slip** (cashier or server who may not see expected cash): only the counted
  cash, the terminal section (as of close, with `lateTerminal`) and the payment count. Expected
  cash, cash sales, refunds, paid-outs, the difference, the controls, the folios, late cash and
  the review note are never in the document.
- `corteAccess` applies the spec §4.7 role rules, including the 12-hour own-device window
  for cashiers and servers.

### CSV

- UTF-8 with BOM, comma separator, CRLF after every record.
- A field with a comma, quote, CR or LF is quoted, with its quotes doubled.
- Headers are in the UI language.
- Money uses dot decimals with the currency exponent (MXN `1234.50`, JPY `1234`). Percents
  have one decimal. Date-times are `AAAA-MM-DD HH:mm` in the restaurant zone.
- Formula guard (OWASP): a text cell that starts with `= + - @`, TAB, CR, LF or the
  full-width `＝＋－＠` is prefixed with `'` and quoted. Numeric cells are written as numbers
  only when they have a number's shape. Anything else falls back to guarded text.
- `csvCell` takes already formatted values. A raw number in a money (`m`) or percent (`p`)
  column is a `TypeError("csv_unformatted")`, because writing `2000` for MXN 20.00 would be a
  100× error. Format with `moneyCsv` / `percentCsv` first, or let `toCsv` do it.

### Choices the integration wave must keep

- **Date bounds.** Business dates outside 2000-01-01..2999-12-31 are `reports_range_invalid`.
  Temporal accepts year 0000 and PostgreSQL does not, so without the bounds a forged range
  could reach SQL as a date error.
- **Coverage denominator.** The S1 statement must also select `ticketedRecoveryGross` (Σ
  total + discount of ticketed recovery orders). Spec §4.5 puts it in the cost-coverage
  denominator, but the spec's S1 SQL does not select it.
- **Open-price rows.** `ExceptionRow` carries `accountId` (the check's server) as well as
  `accountName`, so `exceptionSummary` can group open-price lines by employee id.
- **Drawer differences.** In `DrawerSummary` and in the per-employee exception summary,
  `shortages` and `overages` are amounts, not counts. For the difference kinds
  (`drawer_difference`, `terminal_difference`), the Excepciones tiles (`ExceptionTotals`, also
  used by Hoy and the corte del día) and each employee's `acted` amount sum magnitudes. A tile
  also carries `shortages` and `overages`. An approver's `approved.amount` sums absolute amounts.
  So a $500 shortage and a $500 overage show as $1,000.00 (faltante $500.00 · sobrante $500.00),
  never as $0.00.
- **int8 aggregates.** The S1–S5 sums are `::int8`, and postgres.js returns `int8` (and
  `numeric`) columns as strings: `server/db.ts` registers no BigInt type. The core refuses
  non-numbers with `RangeError("invalid_amount")`, so passing raw rows would turn every summary
  into a 500. `server/reports/*` maps every aggregate through `aggregateInt`, which accepts int8
  text, `bigint` or a number and refuses anything that is not an exact safe integer. Do not cast
  the sums to `::int`: a 92-day range can pass 2^31 centavos.
- **Late drawer tenders.** The `drawerList` tender lateral must select, for cash and for
  external separately, the count, amount and tip of the tenders with `created_at > closed_at`
  (`DrawerFacts.cash.late*`, `DrawerFacts.external.late*`). Spec §4.5 lists only `lateCash`.
- **CSV location.** The CSV builder lives in `shared/csv.ts`. The client's
  `src/features/reports/csv.ts` adds `downloadCsv` and the dataset column lists on top of it.
- **Settings argument.** `wideWindow` and `currentBusinessDate` take `{timezone, cutoff}`, not
  a `Session`. The client range picker needs them too.

## Open question for the lead (before the server wave)

**Blind count and the drawer row.** For an open drawer and a viewer who may not see expected
cash during the shift, `drawerRow()` sets only `expected` to null, as spec §4.5 says. The same
row still carries `opening`, `cashSales`, `cashTips`, `cashRefunds` and `paidOuts` (non-nullable
in the spec's `DrawerRow`). Pay-ins are always 0, so the viewer can add those up to the expected
cash. `corteAccess` refuses that viewer the corte X (`reports_corte_hidden`), and discounts'
`cashSummary` (discounts spec, not on this branch yet) nulls the cash figures, cash tenders, cash
refunds and movements for blind viewers. Only owners and managers see the
Cortes table, and managers can also read the tender list (with drawer and device) and Efectivo
cobrado. So redacting the row alone would not hide expected cash. The two options:

1. Make the cash components of `DrawerRow` nullable and null them whenever the drawer is open
   and `!canSeeExpected`. Redact the tender list's cash rows and the Resumen cash figures for
   the same viewers too.
2. Document that in reports, blind count applies to cashiers and servers only, and that a
   manager under blind count can still work expected cash out from the tender figures.

The core implements neither yet. The code follows the spec as written.

## Pending (next wave)

- Migration 029: `business_day_settings`, `business_date_at()`, `report_prints`, indexes and
  grants.
- `SalesSummary.tax` and `mergeFiscalSummaries`.
- The `server/reports/*` modules, the read-only snapshot and `/api/reports/*`.
- The `/report` move and the DB suite `tests/reports-db.ts`.
- The Finanzas tabs, Hoy, the printed cortes, the shared print layout, kitchen cancellation
  chits and `src/i18n/reports.ts`.
- Browser tests.
- The README, DELIVERY_STATUS, COMPLETION_LEDGER, ACCEPTANCE_STATUS, OPERATIONS,
  ARCHITECTURE and SERVICE updates listed in spec §8.

Nothing here has been checked against a real database, printer or accountant workflow yet.
