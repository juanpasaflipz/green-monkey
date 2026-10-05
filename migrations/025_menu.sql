-- 025_menu.sql: menu editor, reusable modifier groups, floor plan, stock item
-- setup, cached stock balance and per-restaurant negative-stock policy.
-- Expand-only: nothing is dropped or renamed. The previous app revision keeps
-- working: it ignores the new columns, and the ledger trigger keeps on_hand
-- correct for its stock writes as well.
-- Must run as the table owner (the migration role): the owner-scoped backfill
-- toggles NO FORCE / FORCE ROW LEVEL SECURITY inside this transaction, and a
-- non-owner fails loudly at ALTER TABLE instead of silently skipping rows.
SET LOCAL lock_timeout = '5s';

-- 1. Per-restaurant negative-stock policy ------------------------------------
ALTER TABLE restaurants
  ADD COLUMN negative_stock_policy text NOT NULL DEFAULT 'allow'
  CONSTRAINT restaurants_negative_stock_policy
    CHECK (negative_stock_policy IN ('allow', 'block'));

-- 2. Menu revision; its row lock also serializes menu writes per tenant ------
CREATE TABLE menu_state(
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Categories ---------------------------------------------------------------
CREATE TABLE menu_categories(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  name_es text NOT NULL CHECK (length(btrim(name_es)) BETWEEN 1 AND 200),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 200),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- 4. Reusable modifier groups (options live in data.options) -----------------
CREATE TABLE modifier_groups(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'
                             AND jsonb_typeof(data->'options') = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- 5. Floor plan ----------------------------------------------------------------
CREATE TABLE dining_areas(
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE dining_tables
  ADD COLUMN area_id uuid,
  ADD COLUMN seats integer CHECK (seats IS NULL OR seats BETWEEN 1 AND 99),
  ADD COLUMN position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD COLUMN archived_at timestamptz;
-- MATCH SIMPLE: a NULL area_id is not checked; a set one must be same-tenant.
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_area
  FOREIGN KEY (tenant_id, area_id) REFERENCES dining_areas(tenant_id, id);

-- 6. Stock items: cached balance, par level, archive, settings version --------
ALTER TABLE stock_items
  ADD COLUMN on_hand numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN par_level numeric(18,6) CHECK (par_level IS NULL OR par_level >= 0),
  ADD COLUMN negative_since timestamptz,
  ADD COLUMN settings_version integer NOT NULL DEFAULT 1 CHECK (settings_version >= 1),
  ADD COLUMN archived_at timestamptz;
-- Running balance after each movement; NULL for movements recorded before 025.
ALTER TABLE stock_movements ADD COLUMN balance_after numeric(18,6);
CREATE INDEX stock_movements_item_time
  ON stock_movements(tenant_id, stock_id, created_at DESC, id DESC);

-- 7. Row security for the new tables ------------------------------------------
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['menu_state','menu_categories','modifier_groups','dining_areas'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
 END LOOP;
END $$;

-- 8. Backfill the cached balance (owner-scoped, inside this transaction) -------
ALTER TABLE stock_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_movements NO FORCE ROW LEVEL SECURITY;
UPDATE stock_items i
   SET on_hand = m.total,
       negative_since = CASE WHEN m.total < 0 THEN now() END
  FROM (SELECT tenant_id, stock_id, sum(quantity) AS total
          FROM stock_movements GROUP BY tenant_id, stock_id) m
 WHERE i.tenant_id = m.tenant_id AND i.id = m.stock_id;
ALTER TABLE stock_items FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;

-- 9. Ledger trigger: the only writer of on_hand / negative_since / balance_after.
-- SECURITY DEFINER because gm_app no longer has UPDATE on those columns. The
-- stock row is locked first, so concurrent movements on one item serialize.
-- A movement that repeats an existing (stock, cause, cause_id) or id is skipped
-- without effect: BEFORE INSERT triggers fire before ON CONFLICT arbitration,
-- so applying the delta first would let a skipped insert drift on_hand.
-- The stock row lock serializes repeats on one item; a repeated movement id on
-- two different items is serialized by a transaction advisory lock on the id,
-- taken before any row lock, so the second insert sees the first one committed
-- (the EXISTS below takes a fresh snapshot) instead of applying its delta and
-- then being dropped by ON CONFLICT DO NOTHING.
-- When a tenant context is set it must match the row (RLS WITH CHECK on the
-- movement is evaluated only after BEFORE triggers).
CREATE FUNCTION stock_ledger_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scope uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  balance numeric(18,6);
BEGIN
  IF scope IS NOT NULL AND scope IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'stock movement outside the current tenant' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('stock_movement:' || NEW.tenant_id::text || ':' || NEW.id::text, 0));
  PERFORM 1 FROM public.stock_items
    WHERE tenant_id = NEW.tenant_id AND id = NEW.stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock item % not found', NEW.stock_id USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_movements m
              WHERE m.tenant_id = NEW.tenant_id
                AND ((m.stock_id = NEW.stock_id AND m.cause = NEW.cause AND m.cause_id = NEW.cause_id)
                     OR m.id = NEW.id)) THEN
    RETURN NULL;
  END IF;
  UPDATE public.stock_items
     SET on_hand = on_hand + NEW.quantity,
         negative_since = CASE WHEN on_hand + NEW.quantity < 0
                               THEN coalesce(negative_since, clock_timestamp())
                               ELSE NULL END
   WHERE tenant_id = NEW.tenant_id AND id = NEW.stock_id
   RETURNING on_hand INTO balance;
  NEW.balance_after := balance;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION stock_ledger_apply() FROM PUBLIC;
CREATE TRIGGER stock_movements_ledger BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_apply();

-- 10. Stock movements are append-only (history), even for the owner -----------
CREATE FUNCTION stock_movements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock movements are append-only';
END $$;
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_immutable();

-- 11. Adopt legacy catalog documents (categories, positions, reusable groups).
-- Idempotent; owner-only; also re-runnable after a deploy overlap in which the
-- previous revision wrote legacy-format documents (docs/MENU.md runbook).
-- Does not bump product versions: price and recipe are unchanged.
CREATE FUNCTION menu_adopt_legacy_catalog() RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE adopted integer;
BEGIN
  ALTER TABLE catalog NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE menu_categories NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE modifier_groups NO FORCE ROW LEVEL SECURITY;

  INSERT INTO menu_categories(tenant_id, id, name_es, name_en, position)
  SELECT l.tenant_id, gen_random_uuid(), l.es, l.en,
         (coalesce((SELECT max(m.position) FROM menu_categories m WHERE m.tenant_id = l.tenant_id), 0)
          + row_number() OVER (PARTITION BY l.tenant_id ORDER BY l.es))::int
    FROM (SELECT c.tenant_id,
                 left(coalesce(nullif(btrim(c.data->'category'->>'es'), ''), 'General'), 200) AS es,
                 min(left(coalesce(nullif(btrim(c.data->'category'->>'en'), ''),
                                   nullif(btrim(c.data->'category'->>'es'), ''), 'General'), 200)) AS en
            FROM catalog c
           WHERE NOT (c.data ? 'categoryId')
           GROUP BY 1, 2) l
   WHERE NOT EXISTS (SELECT 1 FROM menu_categories m
                      WHERE m.tenant_id = l.tenant_id AND m.name_es = l.es AND m.archived_at IS NULL);

  UPDATE catalog c
     SET data = c.data || jsonb_build_object(
                  'categoryId', m.id::text,
                  'categoryPosition', m.position,
                  'category', jsonb_build_object('es', m.name_es, 'en', m.name_en))
    FROM menu_categories m
   WHERE m.tenant_id = c.tenant_id AND m.archived_at IS NULL
     AND m.name_es = left(coalesce(nullif(btrim(c.data->'category'->>'es'), ''), 'General'), 200)
     AND NOT (c.data ? 'categoryId');
  GET DIAGNOSTICS adopted = ROW_COUNT;

  -- Unpositioned documents go after the positioned ones of their category.
  UPDATE catalog c SET data = c.data || jsonb_build_object('position', p.pos)
    FROM (SELECT u.tenant_id, u.id,
                 (coalesce((SELECT max((k.data->>'position')::int) FROM catalog k
                             WHERE k.tenant_id = u.tenant_id
                               AND k.data->>'categoryId' = u.data->>'categoryId'
                               AND k.data ? 'position'), 0)
                  + row_number() OVER (PARTITION BY u.tenant_id, u.data->>'categoryId'
                                       ORDER BY u.data->'name'->>'es', u.id))::int AS pos
            FROM catalog u
           WHERE NOT (u.data ? 'position')) p
   WHERE p.tenant_id = c.tenant_id AND p.id = c.id;

  INSERT INTO modifier_groups(tenant_id, id, data)
  SELECT DISTINCT ON (c.tenant_id, g.value->>'id')
         c.tenant_id, (g.value->>'id')::uuid,
         jsonb_build_object('name', g.value->'name', 'min', g.value->'min', 'max', g.value->'max',
                            'repeat', false, 'options', coalesce(g.value->'options', '[]'::jsonb))
    FROM catalog c
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'groups', '[]'::jsonb)) AS g(value)
   WHERE NOT (c.data ? 'groupIds')
     AND g.value->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   ORDER BY c.tenant_id, g.value->>'id', c.id
  ON CONFLICT (tenant_id, id) DO NOTHING;

  UPDATE catalog c
     SET data = c.data || jsonb_build_object('groupIds', coalesce(
           (SELECT jsonb_agg(g.value->'id' ORDER BY g.ord)
              FROM jsonb_array_elements(coalesce(c.data->'groups', '[]'::jsonb))
                   WITH ORDINALITY AS g(value, ord)
             WHERE g.value->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
           '[]'::jsonb))
   WHERE NOT (c.data ? 'groupIds');

  ALTER TABLE catalog FORCE ROW LEVEL SECURITY;
  ALTER TABLE menu_categories FORCE ROW LEVEL SECURITY;
  ALTER TABLE modifier_groups FORCE ROW LEVEL SECURITY;
  RETURN adopted;
END $$;
REVOKE ALL ON FUNCTION menu_adopt_legacy_catalog() FROM PUBLIC;
SELECT menu_adopt_legacy_catalog();
