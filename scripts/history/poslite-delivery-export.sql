-- scripts/history/poslite-delivery-export.sql — export one pos-lite restaurant's delivery-platform
-- sales (the manual batches: platform settlement uploads and hand entries) as daily totals, the
-- first input of scripts/history/delivery-sales-build.ts for green-monkey's "Histórico de
-- plataformas" (041, docs/DELIVERY_HISTORY.md runbook). Report history only: Green Monkey never
-- turns these rows into orders, tenders, tickets or CFDI.
--
-- The operator runs it with psql against pos-lite's database, as pos-lite's admin login (its
-- adminSql bypasses RLS), in a READ ONLY transaction. It reads pos-lite's tenants (the name and
-- timezone), orders and delivery_orders (pos-lite server/db/pg-schema.sql) and writes nothing:
--
--   umask 077
--   psql "$POSLITE_ADMIN_URL" -X -q -t -A -v ON_ERROR_STOP=1 \
--     -v tenant=<pos-lite tenant id> -v store="<store label, e.g. Taquería Demo>" \
--     -f scripts/history/poslite-delivery-export.sql > "<private scratchpad>/poslite-delivery.json"
--
-- Included: completed, paid orders of a manual batch (manual_batch_id IS NOT NULL). One row per
-- (local calendar date in the tenant's timezone of COALESCE(paid_at, created_at), source): orders,
-- Σ total (gross, pesos, IVA included), Σ delivery_orders.platform_commission (commission; null
-- when no order of the day has a delivery row) and gross − commission (net; null with it). Sources map to (platform, store): uber_eats, rappi and didi_food to
-- that platform with -v store; didi_food_rollbertos to (didi_food, 'Rollbertos'), DiDi's second
-- brand. Any other source is exported with a null platform so the builder refuses it instead of
-- guessing. No personal field leaves pos-lite: no customer, address, courier, phone, external
-- order id, webhook payload or employee; only daily sums.
--
-- One JSON document: {format, sourceTenantId, sourceName, timezone, exportedAt, rows}. Money is
-- text (pos-lite numeric pesos, exact). An unknown -v tenant fails the export ("pos-lite tenant not
-- found") instead of writing an empty or foreign file.
BEGIN READ ONLY;
WITH source AS (
  -- The count is a column, so the failing cast is never constant-folded at planning time.
  SELECT CASE WHEN n = 1 THEN 1 ELSE ('pos-lite tenant not found: ' || n)::int END AS ok
  FROM (SELECT count(*) AS n FROM tenants WHERE id = :'tenant') t
), tz AS (
  SELECT timezone FROM tenants WHERE id = :'tenant'
), sales AS (
  SELECT (COALESCE(o.paid_at, o.created_at) AT TIME ZONE (SELECT timezone FROM tz))::date AS date,
         o.source,
         o.total,
         -- An order has at most one delivery row in practice; summing keeps it one value either way.
         -- NULL when the order has none (the commission is unknown, not zero).
         (SELECT sum(d.platform_commission) FROM delivery_orders d
           WHERE d.tenant_id = :'tenant' AND d.order_id = o.id) AS commission
  FROM orders o
  WHERE o.tenant_id = :'tenant'
    AND o.manual_batch_id IS NOT NULL
    AND o.status = 'completed'
    AND o.payment_status = 'paid'
), days AS (
  -- A day's commission is the sum over its orders with a delivery row; NULL (unknown, and so is
  -- net) when none of them has one.
  SELECT date, source, count(*) AS orders, sum(total) AS gross, sum(commission) AS commission
  FROM sales GROUP BY date, source
)
SELECT json_build_object(
  'format', 'pos-lite-delivery',
  'sourceTenantId', :'tenant',
  'sourceName', (SELECT CASE WHEN source.ok = 1 THEN (SELECT name FROM tenants WHERE id = :'tenant') END
                 FROM source),
  'timezone', (SELECT timezone FROM tz),
  'exportedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'rows', (SELECT coalesce(json_agg(json_build_object(
      'date', to_char(d.date, 'YYYY-MM-DD'),
      'source', d.source,
      'platform', CASE d.source
        WHEN 'uber_eats' THEN 'uber_eats'
        WHEN 'rappi' THEN 'rappi'
        WHEN 'didi_food' THEN 'didi_food'
        WHEN 'didi_food_rollbertos' THEN 'didi_food' END,
      'store', CASE d.source
        WHEN 'didi_food_rollbertos' THEN 'Rollbertos'
        WHEN 'uber_eats' THEN :'store'
        WHEN 'rappi' THEN :'store'
        WHEN 'didi_food' THEN :'store' END,
      'orders', d.orders,
      'gross', d.gross::text,
      'commission', d.commission::text,
      'net', (d.gross - d.commission)::text
    ) ORDER BY d.date, d.source), '[]'::json) FROM days d)
);
COMMIT;
