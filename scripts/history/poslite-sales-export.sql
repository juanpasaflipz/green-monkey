-- scripts/history/poslite-sales-export.sql — export one pos-lite restaurant's kiosk and POS-terminal
-- sales for green-monkey's "Histórico POS Lite" (040, docs/SALES_HISTORY.md runbook). Report
-- history only: Green Monkey never turns these rows into orders, tenders, tickets or CFDI.
--
-- The operator runs it with psql against pos-lite's database, as pos-lite's admin login (its
-- adminSql bypasses RLS), in a READ ONLY transaction. It reads pos-lite's tenants (the name),
-- orders, order_items and order_payments (pos-lite server/db/pg-schema.sql) and writes nothing:
--
--   umask 077
--   psql "$POSLITE_ADMIN_URL" -X -q -t -A -v ON_ERROR_STOP=1 \
--     -v tenant=<pos-lite tenant id> -v target=<green-monkey restaurant id> \
--     -f scripts/history/poslite-sales-export.sql > "<private scratchpad>/poslite-sales.json"
--
-- Included: completed, paid orders from the kiosk (source customer_kiosk) and the POS terminal
-- (source pos) that are not part of a manual batch (delivery-platform uploads). Voided lines are
-- left out; payment rows are exported with their status (Green Monkey counts paid/succeeded).
-- Only non-personal fields leave pos-lite: no customer, call name, phone, table, employee, notes,
-- secret, invoice token, CFDI id, terminal id or payment-provider id. Money is exported as text
-- (pos-lite numeric pesos, exact); instants as UTC ISO strings.
--
-- One JSON document: {source, sourceTenantId, sourceName, targetTenantId, exportedAt, currency,
-- summary, orders}. The owner's screen shows sourceName and asks to confirm it is the right
-- restaurant before Importar. An unknown -v tenant fails the export ("pos-lite tenant not found")
-- instead of writing an empty or foreign file. pos-lite is MXN only.
BEGIN READ ONLY;
WITH source AS (
  -- The count is a column, so the failing cast is never constant-folded at planning time.
  SELECT CASE WHEN n = 1 THEN 1 ELSE ('pos-lite tenant not found: ' || n)::int END AS ok
  FROM (SELECT count(*) AS n FROM tenants WHERE id = :'tenant') t
), sales AS (
  SELECT o.id, o.created_at, o.paid_at, o.completed_at, o.source, o.payment_method, o.subtotal,
         o.tax, o.tip, o.total, o.discount_amount, o.refund_total
  FROM orders o
  WHERE o.tenant_id = :'tenant'
    AND o.source IN ('customer_kiosk', 'pos')
    AND o.status = 'completed'
    AND o.payment_status = 'paid'
    AND o.manual_batch_id IS NULL
)
SELECT json_build_object(
  'source', 'pos-lite-sales',
  'sourceTenantId', :'tenant',
  'sourceName', (SELECT CASE WHEN source.ok = 1 THEN (SELECT name FROM tenants WHERE id = :'tenant') END
                 FROM source),
  'targetTenantId', :'target',
  'exportedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'currency', 'MXN',
  'summary', json_build_object(
    'orders', (SELECT count(*) FROM sales),
    'total', (SELECT coalesce(sum(total), 0)::text FROM sales),
    'tax', (SELECT coalesce(sum(tax), 0)::text FROM sales),
    'tip', (SELECT coalesce(sum(tip), 0)::text FROM sales)),
  'orders', (SELECT coalesce(json_agg(json_build_object(
      'id', s.id,
      'created_at', to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'paid_at', to_char(s.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'completed_at', to_char(s.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'source', s.source,
      'payment_method', s.payment_method,
      'subtotal', s.subtotal::text, 'tax', s.tax::text, 'tip', s.tip::text, 'total', s.total::text,
      'discount_amount', s.discount_amount::text, 'refund_total', s.refund_total::text,
      'lines', (SELECT coalesce(json_agg(json_build_object(
                  'name', i.item_name, 'quantity', i.quantity, 'unit_price', i.unit_price::text,
                  'discount_amount', i.discount_amount::text) ORDER BY i.id), '[]'::json)
                FROM order_items i
                WHERE i.tenant_id = :'tenant' AND i.order_id = s.id AND i.voided_at IS NULL),
      'payments', (SELECT coalesce(json_agg(json_build_object(
                     'method', p.payment_method, 'amount', p.amount::text, 'tip', p.tip::text,
                     'status', p.status) ORDER BY p.id), '[]'::json)
                   FROM order_payments p
                   WHERE p.tenant_id = :'tenant' AND p.order_id = s.id)
    ) ORDER BY s.id), '[]'::json) FROM sales s)
);
COMMIT;
