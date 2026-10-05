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
| `shared/reports.ts` | `LIMITS` (92-day aggregates, 31-day lists, 500 rows per page, 20,000 export rows); `parseRange`, `isBusinessDate`, `addDays`, `rangeDates`, `quickRange` (Hoy, Ayer, Esta semana, Semana pasada, Este mes, Mes pasado; weeks start Monday); `currentBusinessDate`, `wideWindow`, and `wallClockBusinessDate` / `wallClockHour` (the SQL day formula in JS); `BREAKDOWNS`, `EXCEPTION_KINDS`, `AUDIT_GROUPS`, `auditGroupPrefixes`, `parseExceptionKinds`; the query and command schemas; `encodeReportCursor` / `decodeReportCursor`; `averageTicket`, `bps`; `composeSalesSummary` and `reconciliationChecks`; `hourRows`, `exceptionSummary`, `exceptionTotals`; `drawerRow`, `drawerSummary`, `corteAccess`, `buildCorteDocument`, `folioRanges`, `otherDayDrawerCollections`, `buildDayCorteDocument`; and the wire types (`SalesSummary`, `DrawerRow`, `CorteDocument`, `DayCorteDocument`, …). |
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
  tips on the checks, COGS and cost coverage;
- refunds, split into cash and terminal;
- collections by method: count, amount, tips, refunds and `net = amount + tips − refunds`,
  plus paid-outs and late offline collections;
- the margin from fiscal's totals;
- one row per business date of the range.

`reconciliationChecks` returns `lines_vs_orders`, `discounts_vs_allocations`,
`tickets_vs_orders`, `paid_identity`, `methods_sum` and `refunds_vs_fiscal`. Without fiscal
data (non-MXN), it skips the two fiscal checks.

Property tests over 400 random sales worlds check these figures against the records to the
centavo. The worlds include voids, comps, recovery orders, next-day and late offline
collections, later refunds and paid-outs. A one-centavo drift in any aggregate fails exactly
its own check.

### Cortes

- **Corte X** (open drawer): expected cash is `opening + cash sales + cash tips − cash
  refunds − paid-outs`. The terminal section shows payments, tips, refunds and net.
- **Corte Z** (closed drawer): cash as of close. Cash recorded after the close is shown
  separately. The document uses the stored expected cash and the signed difference
  (faltante / sobrante / cuadra), plus the terminal batch difference.
- **Blind count slip** (cashier or server who may not see expected cash): only the counted
  cash, the terminal section and the payment count. Expected cash, cash sales, refunds,
  paid-outs, the difference, the controls, the folios, late cash and the review note are
  never in the document.
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
  `shortages` and `overages` are amounts, not counts. An approver's `approved.amount` sums
  absolute amounts, so a reviewed shortage and an overage never cancel out.
- **CSV location.** The CSV builder lives in `shared/csv.ts`. The client's
  `src/features/reports/csv.ts` adds `downloadCsv` and the dataset column lists on top of it.
- **Settings argument.** `wideWindow` and `currentBusinessDate` take `{timezone, cutoff}`, not
  a `Session`. The client range picker needs them too.

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
