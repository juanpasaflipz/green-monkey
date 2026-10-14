-- scripts/menu/poslite-menu-export.sql — export one pos-lite restaurant's menu for green-monkey's
-- «Importar menú de POS Lite» (docs/MENU.md, «Importar el menú de POS Lite»).
--
-- The operator runs it with psql against pos-lite's database, as pos-lite's admin login (its
-- adminSql bypasses RLS, so every table below is filtered by tenant_id explicitly), in a READ ONLY
-- transaction. It reads pos-lite's tenants (the name), menu_categories, ai_category_roles,
-- menu_items, modifier_groups, modifiers, menu_item_modifier_groups, combo_definitions and
-- virtual_brands (pos-lite server/db/pg-schema.sql; migrations 0077, 0087, 0088, 0105) and writes
-- nothing:
--
--   umask 077
--   psql "$POSLITE_ADMIN_URL" -X -q -t -A -v ON_ERROR_STOP=1 \
--     -v tenant=<pos-lite tenant id> -v target=<green-monkey restaurant id> \
--     -f scripts/menu/poslite-menu-export.sql > "<private scratchpad>/poslite-menu.json"
--
-- The file holds no personal data, only the menu. One JSON document: {source, sourceTenantId,
-- sourceName, targetTenantId, exportedAt, currency, summary, categories, items, groups,
-- itemGroups}. An unknown -v tenant fails the export ("pos-lite tenant not found") instead of
-- writing an empty or foreign file.
--
-- What is exported, as pos-lite's kiosk showed it (kiosk menu.js:261, kiosk.js:2596):
-- - items: active and not seeded placeholders (is_example);
-- - categories: the ones those items use, with `active` (pos-lite's kiosk ignored it; the import
--   screen warns) and the kitchen/bar role from ai_category_roles (the KDS filter's source);
-- - groups: active ones attached to an exported item, with their active modifiers (a group left
--   with none is exported and skipped by the import, with a warning);
-- - prices as pesos text with 2 decimals (NUMERIC(10,2), IVA included).
-- Photos are not exported («Importar fotos», docs/KIOSK.md §7). Combos and virtual brands are
-- counted in the summary only: the import does not carry them.
BEGIN READ ONLY;
WITH source AS (
  -- The count is a column, so the failing cast is never constant-folded at planning time.
  SELECT CASE WHEN n = 1 THEN 1 ELSE ('pos-lite tenant not found: ' || n)::int END AS ok
  FROM (SELECT count(*) AS n FROM tenants WHERE id = :'tenant') t
), items AS (
  SELECT i.* FROM menu_items i
  WHERE i.tenant_id = :'tenant' AND i.active AND NOT coalesce(i.is_example, false)
), categories AS (
  SELECT c.*, r.role FROM menu_categories c
  LEFT JOIN ai_category_roles r ON r.category_id = c.id AND r.tenant_id = :'tenant'
  WHERE c.tenant_id = :'tenant' AND c.id IN (SELECT category_id FROM items)
), links AS (
  SELECT l.menu_item_id, l.modifier_group_id, l.sort_order
  FROM menu_item_modifier_groups l
  JOIN modifier_groups g ON g.id = l.modifier_group_id AND g.tenant_id = :'tenant' AND g.active
  WHERE l.tenant_id = :'tenant' AND l.menu_item_id IN (SELECT id FROM items)
), groups AS (
  SELECT g.* FROM modifier_groups g
  WHERE g.tenant_id = :'tenant' AND g.id IN (SELECT modifier_group_id FROM links)
), modifiers AS (
  SELECT m.* FROM modifiers m
  WHERE m.tenant_id = :'tenant' AND m.active AND m.group_id IN (SELECT id FROM groups)
)
SELECT json_build_object(
  'source', 'pos-lite-menu',
  'sourceTenantId', :'tenant',
  'sourceName', (SELECT CASE WHEN source.ok = 1 THEN (SELECT name FROM tenants WHERE id = :'tenant') END
                 FROM source),
  'targetTenantId', :'target',
  'exportedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'currency', 'MXN',
  'summary', json_build_object(
    'categories', (SELECT count(*) FROM categories),
    'items', (SELECT count(*) FROM items),
    'groups', (SELECT count(*) FROM groups),
    'modifiers', (SELECT count(*) FROM modifiers),
    'itemGroups', (SELECT count(*) FROM links),
    'virtualBrands', (SELECT count(*) FROM virtual_brands WHERE tenant_id = :'tenant' AND active),
    'combos', (SELECT count(*) FROM combo_definitions WHERE tenant_id = :'tenant' AND active)),
  'categories', (SELECT coalesce(json_agg(json_build_object(
      'id', id, 'name', name, 'sortOrder', sort_order, 'active', coalesce(active, true),
      'role', role, 'printerTarget', printer_target)
      ORDER BY sort_order NULLS LAST, id), '[]'::json) FROM categories),
  'items', (SELECT coalesce(json_agg(json_build_object(
      'id', id, 'categoryId', category_id, 'name', name, 'nameEn', name_en,
      'price', to_char(price, 'FM999999990.00'),
      'description', description, 'descriptionEn', description_en, 'sortOrder', sort_order)
      ORDER BY category_id, sort_order NULLS LAST, id), '[]'::json) FROM items),
  'groups', (SELECT coalesce(json_agg(json_build_object(
      'id', g.id, 'name', g.name, 'selectionType', g.selection_type, 'required', coalesce(g.required, false),
      'min', g.min_selections, 'max', g.max_selections, 'sortOrder', g.sort_order,
      'modifiers', (SELECT coalesce(json_agg(json_build_object(
          'id', m.id, 'name', m.name, 'price', to_char(coalesce(m.price_adjustment, 0), 'FM999999990.00'),
          'sortOrder', m.sort_order) ORDER BY m.sort_order NULLS LAST, m.id), '[]'::json)
        FROM modifiers m WHERE m.group_id = g.id))
      ORDER BY g.sort_order NULLS LAST, g.id), '[]'::json) FROM groups g),
  'itemGroups', (SELECT coalesce(json_agg(json_build_object(
      'itemId', menu_item_id, 'groupId', modifier_group_id, 'sortOrder', sort_order)
      ORDER BY menu_item_id, sort_order NULLS LAST, modifier_group_id), '[]'::json) FROM links)
) FROM source;
ROLLBACK;
