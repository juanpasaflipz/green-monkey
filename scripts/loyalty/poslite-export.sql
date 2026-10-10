-- scripts/loyalty/poslite-export.sql — export one pos-lite restaurant's loyalty members for
-- green-monkey's "Importar socios de POS Lite" (specs/loyalty-w4.md §6, docs/LOYALTY.md runbook).
--
-- The operator runs it with psql against pos-lite's database, as pos-lite's admin login (its
-- adminSql bypasses RLS), in a READ ONLY transaction. It reads pos-lite's tenants (the name),
-- loyalty_customers, stamp_cards and loyalty_config (pos-lite server/db/pg-schema.sql) and writes
-- nothing:
--
--   umask 077
--   psql "$POSLITE_ADMIN_URL" -X -q -t -A -v ON_ERROR_STOP=1 \
--     -v tenant=<pos-lite tenant id> -v target=<green-monkey restaurant id> \
--     -f scripts/loyalty/poslite-export.sql > "<private scratchpad>/poslite-loyalty.json"
--
-- The file holds personal data (names, phones): it stays in the operator's private scratchpad
-- (mode 600), is uploaded only on the owner's import screen and is deleted after verification.
-- One JSON document: {source, sourceTenantId, sourceName, sourceSubdomain, targetTenantId,
-- exportedAt, config, summary, members}. The owner's import screen shows sourceName and asks to
-- confirm it is the right restaurant before Importar (LOYALTY-OPS-8). An unknown -v tenant fails
-- the export ("pos-lite tenant not found") instead of writing an empty or foreign file.
BEGIN READ ONLY;
WITH source AS (
  -- The count is a column, so the failing cast is never constant-folded at planning time.
  SELECT CASE WHEN n = 1 THEN 1 ELSE ('pos-lite tenant not found: ' || n)::int END AS ok
  FROM (SELECT count(*) AS n FROM tenants WHERE id = :'tenant') t
), customers AS (
  SELECT c.* FROM loyalty_customers c WHERE c.tenant_id = :'tenant'
), cards AS (
  SELECT s.* FROM stamp_cards s JOIN customers c ON c.id = s.customer_id
  WHERE s.tenant_id = :'tenant'
), active AS (
  -- pos-lite's getActiveStampCard: the newest card not completed.
  SELECT DISTINCT ON (customer_id) customer_id, id, stamps_earned, stamps_required
  FROM cards WHERE NOT coalesce(completed, false) ORDER BY customer_id, id DESC
), completed AS (
  SELECT customer_id,
         json_agg(json_build_object('completed_at', completed_at, 'redeemed', coalesce(redeemed, false))
                  ORDER BY completed_at, id) AS list,
         max(id) AS last_id,
         count(*) AS n,
         count(*) FILTER (WHERE NOT coalesce(redeemed, false)) AS unredeemed
  FROM cards WHERE coalesce(completed, false) GROUP BY customer_id
), members AS (
  SELECT c.id, c.phone, c.country_code, c.name, c.sms_opt_in, c.created_at, c.last_visit,
         coalesce(c.orders_count, 0) AS orders_count, coalesce(c.total_spent, 0) AS total_spent,
         a.stamps_earned AS active_stamps, a.stamps_required AS active_required,
         coalesce(k.list, '[]'::json) AS completed_cards,
         coalesce(k.n, 0) AS completed_n, coalesce(k.unredeemed, 0) AS unredeemed_n,
         -- Stamps on the card after the latest completed one: 0 means no visit since.
         CASE WHEN a.id IS NOT NULL AND (k.last_id IS NULL OR a.id > k.last_id)
              THEN coalesce(a.stamps_earned, 0) ELSE 0 END AS next_card_stamps
  FROM customers c
  LEFT JOIN active a ON a.customer_id = c.id
  LEFT JOIN completed k ON k.customer_id = c.id
)
SELECT json_build_object(
  'source', 'pos-lite-loyalty',
  'sourceTenantId', :'tenant',
  'sourceName', (SELECT CASE WHEN source.ok = 1 THEN (SELECT name FROM tenants WHERE id = :'tenant') END
                 FROM source),
  'sourceSubdomain', (SELECT t.subdomain FROM tenants t WHERE t.id = :'tenant'),
  'targetTenantId', :'target',
  'exportedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'config', (SELECT coalesce(json_object_agg(key, value), '{}'::json) FROM loyalty_config
             WHERE tenant_id = :'tenant'
               AND key IN ('stamps_required', 'reward_description', 'stamp_bonus_threshold',
                           'referral_bonus_stamps', 'sms_enabled', 'google_review_target')),
  'summary', json_build_object(
    'members', (SELECT count(*) FROM members),
    'activeCardStamps', (SELECT coalesce(sum(active_stamps), 0) FROM members),
    'completedCards', (SELECT coalesce(sum(completed_n), 0) FROM members),
    'completedUnredeemed', (SELECT coalesce(sum(unredeemed_n), 0) FROM members)),
  'members', (SELECT coalesce(json_agg(json_build_object(
      'id', id, 'phone', phone, 'country_code', country_code, 'name', name,
      'sms_opt_in', sms_opt_in,
      'created_at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'last_visit', to_char(last_visit AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'orders_count', orders_count, 'total_spent', total_spent,
      'active_card', CASE WHEN active_stamps IS NULL THEN NULL
        ELSE json_build_object('stamps_earned', active_stamps, 'stamps_required', active_required) END,
      'completed_cards', completed_cards,
      'next_card_stamps', next_card_stamps) ORDER BY id), '[]'::json) FROM members)
);
COMMIT;
