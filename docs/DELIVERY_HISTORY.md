# Histórico de plataformas (delivery-platform sales history)

The restaurant's **Uber Eats, Rappi and DiDi Food sales**, complete and current, visible in Green
Monkey as **report history only**: daily orders, gross sales, commissions and the platform's net
per platform and store, under Finanzas › **Histórico de plataformas** («Delivery platforms
history»), with a CSV export. These are not Green Monkey orders. The sibling of
[Histórico POS Lite](SALES_HISTORY.md) (040), in tables of its own.

Code: `scripts/history/poslite-delivery-export.sql` (pos-lite's delivery days) and
`scripts/history/delivery-sales-build.ts` (the operator's builder), `shared/delivery-history.ts`
(schema, conversion, totals; pure), `server/delivery-history.ts` and
`server/routes/delivery-history.ts` (preview, import, report), `migrations/041_delivery_history.sql`,
`src/features/history/DeliveryHistory.tsx` (the tab), `src/i18n/delivery.ts`. Tests:
`tests/delivery-history.test.ts` (unit: the shared core and the builder's parse and merge),
`tests/delivery-history-db.ts` (`npm run test:db:delivery`, part of `test:db:qualification`),
`tests/browser/delivery-history.spec.ts`.

## 1. Isolation: zero side effects

The import writes only the three `delivery_history_*` tables and one `audit` row
(`delivery_history.import`). It never creates or changes orders, order lines, tenders, cash
sessions or movements, fiscal tickets or folios (027), CFDI documents or the factura global (030),
discounts, refunds, stock, loyalty, jobs, prints, SMS or email, and it never touches 040's
`sales_history_*` tables. No existing report reads `delivery_history_*`: Ventas, IVA, Cobros, the
cortes X/Z, the corte del día, checks, exceptions and Histórico POS Lite are exactly what they
were. The history is therefore **never invoiced** and never counted twice with Green Monkey's own
sales or with Histórico POS Lite.

Why not 040's tables: `sales_history_coverage` is one batch per business date for **every**
channel, so a delivery import there would take over (and hide) the kiosk and POS days of the same
dates. 041 has its own coverage, per platform.

The DB suite proves it like 040's check 9: check 9 records a Green Monkey sale today and imports a
Histórico POS Lite file for the same business day, fingerprints every other public table (040's
five included; row count and content digest) and the existing reports for the day (summary,
products, exceptions, corte del día, Histórico POS Lite), imports platform days on the same dates,
and requires every fingerprint and report to be identical. It then imports a newer pos-lite file
for the same day and requires this history to be unchanged.

## 2. Semantics

**Dates.** A row's `date` is the **platform's local calendar date** of its orders. Platforms
report calendar days and per-order instants are not available for every source (portal daily
totals), so Green Monkey does **not** re-bucket them by the restaurant's cutoff, unlike 040: an
order at 02:30 stays on its calendar day. The screen says so under the note. pos-lite's delivery
days use the same rule: `(COALESCE(paid_at, created_at) AT TIME ZONE tenant.timezone)::date`.

**Figures per (date, platform, store).**

| Field | Meaning |
| --- | --- |
| `orders` | Completed orders (> 0). |
| `gross` | What customers paid for the food, IVA included, before platform fees. |
| `commission` | The platform's fees; null when the source does not say. |
| `net` | What the platform pays the restaurant; null when unknown. Any sign (a chargeback can make a day negative), never above `gross`. |
| `unsettledOrders` | Orders whose payout the platform has not settled yet (typically Uber's last days); the screen marks the day «pago pendiente». |
| `cancelled` | Cancelled orders, informational, not in `orders`. |
| `chargebacks` | Amounts charged back, ≥ 0. |

**Stores.** A platform account can sell for more than one brand or location: DiDi had a second
brand («Rollbertos»), and the owner's Uber account also lists a second restaurant
(«Albufera (Roma Sur)») that the owner excluded. The builder only includes the stores it is told
to (`--store`); the server stores each row under its store label (1–80 characters).

**pos-lite's delivery days** (`scripts/history/poslite-delivery-export.sql`): orders with
`manual_batch_id IS NOT NULL AND status = 'completed' AND payment_status = 'paid'` (pos-lite's
manual batches are its platform settlement uploads and hand entries; 040 excludes exactly these),
grouped by calendar date and `source`: `count(*)`, `Σ total` (gross), `Σ
delivery_orders.platform_commission` (commission; null when no order of the day has a delivery
row) and gross − commission (net). Sources map to platforms: `uber_eats`, `rappi`, `didi_food` →
that platform with the operator's store label; `didi_food_rollbertos` → (`didi_food`,
`Rollbertos`). Any other source is exported without a platform and the builder refuses the file.

## 3. File format (`gm-delivery-sales`, version 1)

One JSON document:

```json
{ "format": "gm-delivery-sales", "version": 1, "exportedAt": "2026-10-14T12:00:00.000Z",
  "currency": "MXN", "targetTenantId": "<green-monkey restaurant id>", "sourceName": "Taquería Demo",
  "sources": [{ "platform": "uber_eats", "origin": "portal", "from": "2026-06-01", "to": "2026-10-13", "note": "…" }],
  "days": [{ "date": "2026-06-01", "platform": "uber_eats", "store": "Taquería Demo", "orders": 3,
             "gross": "300.00", "commission": "75.00", "net": "225.00", "unsettledOrders": 0,
             "cancelled": 1, "chargebacks": "0.00" }],
  "summary": { "days": 1, "orders": 3, "gross": "300.00", "commission": "75.00", "net": "225.00" } }
```

Money is decimal text in **pesos**, converted with 040's `Decimal` rule
(`centavos = round_half_up(pesos × 100)`; `shared/sales-history.ts` `decimalOf`/`toCentavos`). A
value with more than 2 decimals is rounded and counted (`reconciliation.rounded`). The preview
**reconciles** the exact sum of the accepted rows' pesos (gross, commission, net, chargebacks)
against the sum of their centavos, and the file's summary (every row) against its rows; Importar is
disabled unless both agree. Unknown keys are dropped (nothing personal reaches the server).

**Rejected rows** (shown in the preview with their row number and reason, never imported): an
unknown platform (`platform`); a date that is not a calendar date (`date`); an empty store or one
longer than 80 characters (`store`); money that is not a number, or a negative gross, commission or
chargebacks (`money`); orders, unsettled or cancelled that are not whole numbers ≥ 0, or no orders
(`orders`); commission above gross (`commission`); net above gross (`net`); a repeated
(date, platform, store) (`duplicate`).

## 4. Model (041)

All tables: `tenant_id` + RLS `ENABLE`/`FORCE` with the `tenant_scope` policy; money in integer
centavos; grants in `scripts/grants.sql` («-- 041 delivery-history»): `SELECT, INSERT` on all
three, `UPDATE (batch_id, updated_at)` on the coverage only, **no DELETE**.

| Table | Key | Holds |
| --- | --- | --- |
| `delivery_history_batches` | (tenant, id); unique (tenant, source, file_hash) | one uploaded file: `source = 'delivery-platforms'`, the source name, sha256 of the bytes, `exported_at`, accepted days, orders and rejected counts, `report` (coverage per platform, the file's sources, the reconciliation, rejections by reason), `imported_by` (employee), `created_at` |
| `delivery_history_days` | (tenant, batch, business_date, platform, store) | orders > 0, gross ≥ 0, commission ≥ 0 or null, net ≤ gross or null, unsettled_orders, cancelled, chargebacks ≥ 0 |
| `delivery_history_coverage` | (tenant, platform, business_date) | the batch that currently owns that platform's date |

**Replacement per platform, not deletion.** For each platform a file contains, its coverage is
that platform's first to last date with an accepted row. On import every date of each span (rows
or not) points to the new batch for that platform; other platforms and dates keep their batch.
Rows of a superseded batch stay as evidence; reads join through `delivery_history_coverage`, so
nothing is counted twice. The audit row records the coverage, totals, `replacedDays` and
`replacedBatches`. So a file with only Uber's last two weeks updates exactly those Uber days.

**Rules.** The identical file (same bytes) is a no-op (`replayed: true`, no rows, no audit). A file
whose `exportedAt` is older than the batch owning any of its (platform, date) pairs is refused
(`delivery_history_older_export`). The file must name this restaurant (`targetTenantId`, else
`delivery_history_scope`) and its currency (`delivery_history_currency`); anything that is not a
gm-delivery-sales v1 document is `delivery_history_file_invalid`; a file with no accepted row is
`delivery_history_empty`.

**Concurrency.** The import takes the class-0 advisory key (tenant + `delivery-platforms`), then
the restaurants row `FOR SHARE` (the currency the file is checked against), then inserts. It takes
no ordered row lock (ARCHITECTURE LO table row 64), like 040's import.

## 5. API and screen

- `POST /api/delivery-history/preview` — owners and managers. The body is the file itself as
  `application/octet-stream` (up to 16 MB; the app's JSON parser stops at 256 KB). The managers
  check runs **before** the body is read (040's pattern). Returns the source name, the file's
  sources, coverage per platform, counts and totals per platform, the reconciliation, rejected rows,
  and whether the file is already imported, would replace days, or is older than what is
  imported. Writes nothing.
- `POST /api/delivery-history/import` — the same file plus `x-gm-file-hash` (the preview's hash);
  owners and managers with a recent PIN (step-up). Returns the batch, accepted days, orders and
  replaced days.
- `GET /api/delivery-history?from&to` — owners and managers; at most 400 calendar dates; one
  read-only snapshot; `no-store`.

Finanzas › **Histórico de plataformas** (the last tab, after Histórico POS Lite) has its own date
range, a permanent note that the figures come from Uber Eats, Rappi and DiDi Food and are not part
of Green Monkey's sales, IVA, cobros or cortes and are never invoiced, and a line saying the days
are the platforms' calendar days. Tiles (pedidos, venta bruta, comisiones, neto; «N días sin dato»
when some days lack a commission or net), a table by platform and store, monthly and daily tables
(each platform's gross side by side; «pago pendiente» on days with unsettled orders), a CSV export
of the days and the list of imports. Owners and managers see «Importar histórico de plataformas»:
upload → preview → «Confirmo que es mi restaurante» → **Importar**.

The history is included in the owner's data export («Exportar datos del restaurante») as three
«Histórico de plataformas» tables (the file hash column is left out, as every `hash` column is).

## 6. Operator runbook

1. **Collect the inputs** on a machine with access to pos-lite's database and the platform
   portals, into a private scratchpad (`umask 077; mkdir -p "$HOME/private-scratch"`):
   - pos-lite's delivery days (read-only; an unknown `-v tenant` fails instead of writing a file):

     ```sh
     psql "$POSLITE_ADMIN_URL" -X -q -t -A -v ON_ERROR_STOP=1 \
       -v tenant=<pos-lite tenant id> -v store="<store label>" \
       -f scripts/history/poslite-delivery-export.sql > "$HOME/private-scratch/poslite-delivery.json"
     ```

   - each portal's daily totals, normalised to a PSV (or CSV) file with exactly this header, money
     in **pesos** with at most 2 decimals, commission and net empty when unknown:

     ```text
     date|store|orders|gross|commission|net|unsettled|cancelled|chargebacks
     ```

2. **Build** the file (the builder reads local files only):

   ```sh
   npx tsx scripts/history/delivery-sales-build.ts \
     --target <green-monkey restaurant id> --name "<restaurant name>" \
     --store "<store label>" [--store "<second brand>"] \
     --poslite "$HOME/private-scratch/poslite-delivery.json" \
     --portal uber_eats="$HOME/private-scratch/uber.psv" --cutover uber_eats=<first portal day> \
     --portal rappi="$HOME/private-scratch/rappi.psv" --cutover rappi=<first portal day> \
     --out "$HOME/private-scratch/delivery-sales.json"
   ```

   Per platform, pos-lite rows **before** `--cutover` and portal rows **from** it on (required when
   a platform has both inputs). Rows of any store not given with `--store` are left out and listed
   («excluded … (store)») — Albufera (Roma Sur) stays out this way. Check the printed
   per-platform/month table against each portal's monthly figures before going on.
3. **Upload** in Finanzas › Histórico de plataformas › «Importar histórico de plataformas» (owner
   or manager). Check the restaurant name, the coverage per platform, «Cuadra» and the rejected
   rows (normally none). Tick «Confirmo que es mi restaurante», then **Importar** (PIN if asked).
4. **Verify.** Pick three days (at least one per platform) and compare orders, gross and net with
   each portal for the same calendar days. Record the batch («Importaciones») and the check in the
   cutover log.
5. **Delete the files** from every machine they touched (`rm "$HOME/private-scratch/"{poslite-delivery.json,*.psv,delivery-sales.json}`).

To bring the history up to date later, build a new file (for example only the portal rows since the
last import) and upload it: only the platforms and dates it covers are replaced. An older file is
refused.

## 7. Limits

- Daily totals only: no per-order detail (no order id, customer, address or courier).
- A day's figures are the platform's at export time; a payout settled later (`unsettledOrders`)
  or a late chargeback appears after a newer file replaces that day.
- Not linked to Green Monkey's menu or orders. If platform orders are also recorded in Green Monkey
  for some dates, those dates would show the same orders here and in Ventas: build the file only
  for dates Green Monkey does not record (MIGRATION.md «Prevent double-counted revenue»).
