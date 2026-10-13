# Histórico POS Lite (sales history from pos-lite)

Juanberto's past pos-lite **kiosk and POS-terminal sales**, visible in Green Monkey as **report
history only**: daily totals per channel and per payment method, product quantities and amounts
per day, under Finanzas › **Histórico POS Lite** («POS Lite history»), with CSV exports. These are
not Green Monkey orders.

Code: `scripts/history/poslite-sales-export.sql` (the export), `shared/sales-history.ts` (schema,
conversion, aggregation; pure), `server/sales-history.ts` and `server/routes/sales-history.ts`
(preview, import, report), `migrations/040_sales_history.sql`, `src/features/history/` (the tab),
`src/i18n/history.ts`. Tests: `tests/sales-history.test.ts` (unit), `tests/sales-history-db.ts`
(`npm run test:db:history`, part of `test:db:qualification`).

## 1. Isolation: zero side effects

The import writes only the five `sales_history_*` tables and one `audit` row
(`sales_history.import`). It never creates or changes orders, order lines, tenders, cash sessions
or movements, fiscal tickets or folios (027), CFDI documents or the factura global (030), discounts,
refunds, stock, loyalty, jobs, prints, SMS or email. No existing report reads `sales_history_*`:
Ventas, IVA, Cobros, the cortes X/Z, the corte del día, checks and exceptions are exactly what they
were. Imported history is therefore **never invoiced** (no ticket exists for the factura global to
pick up) and never counted twice with Green Monkey's own sales.

The DB suite proves it: check 9 records a Green Monkey sale today, fingerprints every other public
table (row count and content digest) and the existing reports for the day (summary, products,
exceptions, corte del día), imports pos-lite sales for the same business day, and requires every
fingerprint and report to be identical.

## 2. pos-lite semantics (verified read-only before coding)

Inspected on pos-lite's database with SELECT-only aggregate queries over Juanberto's tenant (counts
of rows satisfying each relation; no row values copied). Every relation below held for every
included order unless stated.

| Question | Finding | Evidence query (shape) |
| --- | --- | --- |
| Is tax included in `total`? | Yes: `total = subtotal + tax` in every order. | `count(*) FILTER (WHERE total = subtotal + tax)` vs `count(*)` |
| How is tax computed? | 16 % **on top of** `subtotal`: `tax = round(subtotal × 0.16, 2)`. | `count(*) FILTER (WHERE abs(tax - round(subtotal*0.16,2)) <= 0.01)` |
| Is the tip in `total`? | **No.** `orders.tip` is separate; each `order_payments.amount` equals the order's `total` and its `tip` is separate too. | `FILTER (WHERE p.amount = o.total)` vs `= o.total + o.tip`; `FILTER (WHERE p.tip = o.tip)` |
| Line prices | `order_items.unit_price` includes IVA and the chosen modifiers: `total = Σ quantity × unit_price` of the lines with `voided_at IS NULL`. Adding `order_item_modifiers.price_adjustment` again breaks the equality. | `FILTER (WHERE total = Σ qty*unit_price)` with and without modifiers |
| Discounts | `total = Σ lines − orders.discount_amount − Σ order_items.discount_amount`; `subtotal` is already net of the discount. All but one order satisfy it (that one is imported at its `total` and counted as «lines differ»). | `FILTER (WHERE abs(total - (gross - disc - line_disc)) <= 0.01)` |
| Split payments | `payment_method = 'split'`; the parts are `order_payments` rows with status `paid` or `succeeded`; Σ amount = `total`, Σ tip = `tip` for every split order. Other statuses (e.g. `pending`) are not parts. | `sum(amount) FILTER (WHERE status IN ('paid','succeeded')) = total` |
| Refunds | `orders.refund_total` (and a `refunds` table); no included order had a refund. Exported and summed; never above `total`. | `count(*) FILTER (WHERE refund_total > 0)` |
| Methods | `cash`, `card`, `transfer`, `mp_terminal` (a Mercado Pago card terminal) and `split`. | `GROUP BY payment_method` |
| Money precision | numeric pesos with at most 2 decimals. | `FILTER (WHERE total <> round(total,2))` |

**Which instant dates a sale.** `COALESCE(paid_at, created_at)`: pos-lite's own reports
(`server/routes/reports.js`) bucket every sales figure by `(COALESCE(paid_at, created_at) AT TIME
ZONE tenant.timezone)::date`. `paid_at` is null for some cash sales (then `created_at`, a few
seconds earlier, is the instant), and `completed_at` is the kitchen's completion, often hours
later and on another local day, so it is not used. Green Monkey then applies **its own business
day** to that instant: `business_date_at(restaurant, instant)` (029; `server/reports/days.ts`), the
restaurant's timezone and cutoff in force at that instant. A sale at 02:30 local with a 04:00
cutoff therefore belongs to the previous business date, as a Green Monkey sale would; pos-lite's
reports showed it on the calendar day (see the verification step).

**Included orders.** `tenant_id = :'tenant' AND source IN ('customer_kiosk','pos') AND status =
'completed' AND payment_status = 'paid' AND manual_batch_id IS NULL` (manual batches are the
delivery-platform uploads; platform orders are not kiosk or POS-terminal sales).

## 3. Money: pesos → centavos

Every amount is converted with `Decimal` (exact decimal text, never floats):
`centavos = round_half_up(pesos × 100)` (half away from zero). pos-lite stores 2 decimals, so the
rule is a no-op on its data; a value with more decimals is rounded and counted
(`reconciliation.rounded`). The preview **reconciles**: the exact sum of the accepted orders' pesos
(`source.total`, `tax`, `tip`, `refunds`, as text) against the sum of their converted centavos;
Importar is disabled unless they match and the file's own summary (order count, total, tax, tip of
every exported order) agrees with its order list.

Per order (kept only as aggregates): `gross` = Σ quantity × unit price (IVA included, before
discounts), `discount` = order discount + line discounts, `subtotal`, `tax`, `total`
(= subtotal + tax, IVA included, tips excluded), `tip`, `refunds`; payment parts (one per method;
a split order has several); lines (name, quantity, amount after line discounts). Product amounts
are before the order-level discount.

**Rejected orders** (shown in the preview with the pos-lite id and the reason, never imported):
a channel other than kiosk/POS (`channel`); no valid instant (`instant`); a money value that is not
a number or is negative, or a line discounted below zero (`money`); `total ≠ subtotal + tax`
(`totals`); a split whose settled parts do not add up to the total and tip (`payments`); refunds
above the total (`refund`); a repeated pos-lite id (`duplicate`).

## 4. Model (040)

All tables: `tenant_id` + RLS `ENABLE`/`FORCE` with the `tenant_scope` policy; money in integer
centavos with non-negative CHECKs; grants in `scripts/grants.sql` («-- 040 sales-history»):
`SELECT, INSERT` on all five, `UPDATE (batch_id, updated_at)` on the coverage only, **no DELETE**.

| Table | Key | Holds |
| --- | --- | --- |
| `sales_history_batches` | (tenant, id); unique (tenant, source, file_hash) | one uploaded file: pos-lite tenant and name, sha256 of the bytes, `exported_at`, coverage from/to, accepted and rejected counts, the reconciliation (`report`), `imported_by` (employee), `created_at` |
| `sales_history_days` | (tenant, batch, business_date, channel) | orders, gross, discount, subtotal, tax, total, tip, refunds; CHECK subtotal + tax = total |
| `sales_history_payments` | (tenant, batch, business_date, channel, method) | payments (a split counts once per part), amount, tip; method ∈ cash, card, transfer, other |
| `sales_history_products` | (tenant, batch, business_date, channel, product_name) | quantity, amount |
| `sales_history_coverage` | (tenant, business_date) | the batch that currently owns the date |

**Replacement, not deletion.** A batch's coverage is its first to last business date with an
accepted sale. On import, every date of that span (sales or not) points to the new batch; dates
outside it keep their batch. Aggregate rows of a superseded batch stay in place as evidence; reads
join through `sales_history_coverage`, so nothing is counted twice. The audit row records the
coverage, totals, `replacedDays` and `replacedBatches`. So the owner can import an early export now
and a final one at cutover: the final file replaces the days both cover and adds the rest.

**Rules.** The identical file (same bytes, same sha256) is a no-op (`replayed: true`, no rows, no
audit). An export whose `exportedAt` is older than the batch owning any of its dates is refused
(`sales_history_older_export`), so a stale file never overwrites a newer one. The file must name
this restaurant (`targetTenantId`, else `sales_history_scope`) and its currency
(`sales_history_currency`); a file that is not a pos-lite sales export is
`sales_history_file_invalid`; a file with nothing importable is `sales_history_empty`.

**Concurrency.** The import takes the class-0 advisory key (tenant + `pos-lite-sales`), then the
restaurants row `FOR SHARE` (the timezone and cutoff the dates use; a change since the session is
`settings_changed`), then inserts. It takes no ordered row lock (ARCHITECTURE LO table), like the
loyalty import.

## 5. API and screen

- `POST /api/sales-history/preview` — owners and managers. The body is the export file itself as
  `application/octet-stream` (up to 16 MB; the app's JSON parser stops at 256 KB and a full
  pos-lite history is about 1.3 MB). The managers check runs **before** the body is read (the
  kiosk photo upload's pattern). Returns the source name, coverage, counts and totals per channel
  and method, the reconciliation, rejected rows, and whether the file is already imported, would
  replace days, or is older than what is imported. Writes nothing.
- `POST /api/sales-history/import` — the same file plus `x-gm-file-hash` (the preview's hash);
  owners and managers with a recent PIN (step-up). Returns the batch, accepted orders, days and
  replaced days.
- `GET /api/sales-history?from&to` — owners and managers; at most 400 business dates; one
  read-only snapshot; `no-store`.

Finanzas › **Histórico POS Lite** (the last tab) has its own date range (pos-lite history predates
Finanzas' 92-day picker), a permanent note that the figures come from POS Lite and are not part of
Green Monkey's sales, IVA, cobros or cortes and are never invoiced, tiles (sales, total, IVA, tips),
by channel (Kiosco / Caja) and by method, monthly and daily tables, the top 100 products, three
CSV exports (days, payment methods, products) and the list of imports. Owners and managers see
«Importar histórico de POS Lite» there: upload → preview → «Confirmo que es mi restaurante» →
**Importar**. The import lives in Finanzas (not Configuración) because it has no setting to save
first and its result is only ever read there.

## 6. Operator runbook

Before cutover (optional) and again after pos-lite stops selling (MIGRATION.md «Día de cambio»):

1. **Export** from a machine with access to pos-lite's database, as pos-lite's admin login, into a
   private scratchpad (the file holds no personal data, but it is the restaurant's sales):

   ```sh
   umask 077
   mkdir -p "$HOME/private-scratch"
   psql "$POSLITE_ADMIN_URL" -X -q -t -A -v ON_ERROR_STOP=1 \
     -v tenant=<pos-lite tenant id> -v target=<green-monkey restaurant id> \
     -f scripts/history/poslite-sales-export.sql > "$HOME/private-scratch/poslite-sales.json"
   ```

   The script runs in a `READ ONLY` transaction and writes nothing in pos-lite. An unknown
   `-v tenant` fails («pos-lite tenant not found») instead of writing an empty file. It exports
   only non-personal fields: no customer, call name, phone, table, employee, notes, secrets,
   tokens, invoice tokens, CFDI ids, terminal or payment-provider ids.
2. **Upload** in Finanzas › Histórico POS Lite › «Importar histórico de POS Lite» (owner or
   manager). Check the preview: the pos-lite restaurant name, the dates, «Cuadra», the counts per
   channel and method, and the rejected rows (normally none; any `channel`/`totals`/`payments`
   row is reviewed with support before importing). Tick «Confirmo que es mi restaurante», then
   **Importar** (PIN if asked).
3. **Verify.** Pick three days and compare Histórico POS Lite's daily total and tips with pos-lite's
   Reportes for the same days. pos-lite shows calendar days; Green Monkey uses the business day
   (cutoff), so sales between midnight and the cutoff appear on the previous date here. Record the
   batch (the «Importaciones» list) and the check in the cutover log.
4. **Delete the file** from every machine it touched (`rm "$HOME/private-scratch/poslite-sales.json"`).

To re-import after more pos-lite sales (before cutover), export again and upload: only the dates
the new file covers are replaced. Uploading an older file than the one imported is refused.

## 7. Limits

- Only kiosk and POS-terminal orders; delivery-platform orders, QR orders and manual batches stay
  in pos-lite (MIGRATION.md «Prevent double-counted revenue»).
- No per-order detail is kept (no ticket, no customer); refunds made in pos-lite after an export
  appear only after a newer export replaces that day.
- Product names are pos-lite's line names at sale time (trimmed to 120 characters), not linked to
  Green Monkey's menu.
- The history is included in the owner's data export («Exportar datos del restaurante») as five
  «Histórico POS Lite» tables (the file hash column is left out, as every `hash` column is).
