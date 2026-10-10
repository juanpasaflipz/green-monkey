-- 039_kiosk.sql — kiosk self-checkout (LD-71, LD-72; specs/kiosk-w4.md §3.1 with the Wave 4
-- critic's R9, R25 and R35 binding where they differ): kiosk stations, device binding, one checkout
-- per kiosk hold, "para aquí" on kiosk holds, menu photos and curated suggestions.
--
-- LD-72: the kiosk fires to the kitchen on payment only. There is no fire policy, no unpaid-fire
-- limit and no fire eligibility here; a later migration adds them if fire-before-payment is built.
-- Payment state is never copied: a checkout points at its latest payments attempt (037,
-- payment_attempts target 'kiosk_hold'), and "approved but unapplied" is that attempt's 'review'
-- state with a kiosk_settle_* error code (R9: no settle_error column).
--
-- Expand-only: the previous revision never reads the new tables; the hold table-mode CHECK is
-- replaced by a strictly weaker one under the same name; public_links and public_order_holds gain a
-- column each (constant defaults, no rewrite). No DML (no backfill, LD-6 not triggered), no role
-- and no grant: grants live in scripts/grants.sql ("-- 039 kiosk"), never here (migrations-lint
-- runtime_role_named). No SECURITY DEFINER. No advisory class (critic R3: 935 stays reserved).
-- Every new table forces row-level security; nothing grants DELETE on any of them (R35).
SET LOCAL lock_timeout = '5s';

-- 1. Holds: kiosk "para aquí" (dine_in without a table) and who decided ------------------------
-- The replaced CHECK is weaker than the validated 032 one, so its scan cannot fail. A counter QR
-- hold still cannot be dine_in without a table; only a kiosk hold can.
ALTER TABLE public_order_holds
  DROP CONSTRAINT public_order_holds_table_mode,
  ADD CONSTRAINT public_order_holds_table_mode CHECK (
    (table_id IS NOT NULL AND mode = 'dine_in') OR
    (table_id IS NULL AND (mode = 'takeaway' OR (mode = 'dine_in' AND channel = 'kiosk')))),
  ADD COLUMN decision_source text NOT NULL DEFAULT 'staff'
    CHECK (decision_source IN ('staff', 'kiosk')),
  ADD CONSTRAINT public_order_holds_kiosk_decision CHECK (
    decision_source = 'staff' OR (state = 'accepted' AND channel = 'kiosk'));

-- 2. Restaurant kiosk settings (row absent = the defaults below) --------------------------------
CREATE TABLE kiosk_settings (
  tenant_id uuid PRIMARY KEY REFERENCES restaurants(id),
  payment_mode text NOT NULL DEFAULT 'counter'
    CHECK (payment_mode IN ('counter', 'card_and_counter', 'card_first')),
  ask_fulfillment boolean NOT NULL DEFAULT true,
  suggestions boolean NOT NULL DEFAULT true,
  loyalty_at_kiosk boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

-- 3. Stations: the kiosk spot's mutable configuration (survives link rotation) ------------------
-- terminal_id: the payments terminal next to the kiosk (critic R14: not payment_device_terminals,
-- which binds POS devices). register_device_id: the staff till whose open drawer receives the
-- kiosk's card tenders and whose drawer opener the kiosk actor acts as.
CREATE TABLE kiosk_stations (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  terminal_id uuid,
  register_device_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, terminal_id) REFERENCES payment_terminals(tenant_id, id),
  FOREIGN KEY (tenant_id, register_device_id) REFERENCES devices(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

-- A kiosk link points at its station; set at insert (rotation copies it), never updated. A kiosk
-- link created before 039 has none until it is replaced (Reemplazar creates the station).
ALTER TABLE public_links
  ADD COLUMN station_id uuid,
  ADD CONSTRAINT public_links_station_kind CHECK (station_id IS NULL OR kind = 'kiosk'),
  ADD CONSTRAINT public_links_station_fk FOREIGN KEY (tenant_id, station_id)
    REFERENCES kiosk_stations(tenant_id, id);
CREATE INDEX public_links_station ON public_links (tenant_id, station_id) WHERE station_id IS NOT NULL;

-- Identity now includes station_id (the 032 function, same body plus the column).
CREATE OR REPLACE FUNCTION public_link_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.token_hash, NEW.kind, NEW.channel, NEW.table_id,
      NEW.created_by, NEW.created_at, NEW.replaces_id, NEW.station_id)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.token_hash, OLD.kind, OLD.channel, OLD.table_id,
      OLD.created_by, OLD.created_at, OLD.replaces_id, OLD.station_id)
     OR (OLD.revoked_at IS NOT NULL AND
         (NEW.revoked_at, NEW.revoked_by, NEW.revoke_reason, NEW.label)
         IS DISTINCT FROM
         (OLD.revoked_at, OLD.revoked_by, OLD.revoke_reason, OLD.label))
  THEN
    RAISE EXCEPTION 'public_link_immutable';
  END IF;
  RETURN NEW;
END $$;

-- 4. Bound kiosk devices -------------------------------------------------------------------------
-- secret_hash = sha256('gm-kiosk-device-v1:' || secret) (the HttpOnly gm_kiosk cookie);
-- pairing_code_hash = sha256('gm-kiosk-pair-v1:' || station_id || ':' || code), hex. No IP and no
-- user agent: only a build id and a viewport class (§3.3). A revoked row is kept as evidence.
CREATE TABLE kiosk_devices (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  station_id uuid NOT NULL,
  pairing_code_hash text CHECK (pairing_code_hash ~ '^[0-9a-f]{64}$'),
  pairing_expires_at timestamptz,
  pairing_attempts integer NOT NULL DEFAULT 0 CHECK (pairing_attempts BETWEEN 0 AND 5),
  secret_hash text UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  paired_at timestamptz,
  last_seen_at timestamptz,
  build text CHECK (build ~ '^[A-Za-z0-9._-]{1,40}$'),
  viewport text CHECK (viewport IN ('landscape', 'portrait')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, station_id) REFERENCES kiosk_stations(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES employees(tenant_id, id),
  CONSTRAINT kiosk_devices_shape CHECK (
    (paired_at IS NULL) = (secret_hash IS NULL) AND
    (paired_at IS NULL) = (pairing_code_hash IS NOT NULL) AND
    (pairing_code_hash IS NULL) = (pairing_expires_at IS NULL) AND
    (revoked_at IS NULL) = (revoked_by IS NULL))
);
-- One live (pending or paired) device per station.
CREATE UNIQUE INDEX kiosk_devices_one_live ON kiosk_devices (tenant_id, station_id)
  WHERE revoked_at IS NULL;

-- 5. Checkouts: one per kiosk hold (self-service state; payment state is derived) ---------------
-- attempt_id is the latest payments attempt (target 'kiosk_hold') started for the hold;
-- attempt_count counts them (at most 3, §2.5). fire_operation_id is the once() key of the kiosk's
-- own accept without payment (a zero total, §2.15). loyalty_member_id is set at submit from the
-- diner's member token and blanked by retention at 30 days (R25, as the schema owner).
CREATE TABLE kiosk_checkouts (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  hold_id uuid NOT NULL,
  station_id uuid NOT NULL,
  device_id uuid,
  fire_operation_id uuid NOT NULL,
  payment_choice text CHECK (payment_choice IN ('card', 'counter')),
  attempt_id uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  loyalty_member_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, hold_id),
  UNIQUE (tenant_id, fire_operation_id),
  FOREIGN KEY (tenant_id, hold_id) REFERENCES public_order_holds(tenant_id, id),
  FOREIGN KEY (tenant_id, station_id) REFERENCES kiosk_stations(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES kiosk_devices(tenant_id, id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES payment_attempts(tenant_id, id),
  FOREIGN KEY (tenant_id, loyalty_member_id) REFERENCES loyalty_members(tenant_id, id),
  CONSTRAINT kiosk_checkouts_attempt CHECK ((attempt_id IS NULL) = (attempt_count = 0)),
  CONSTRAINT kiosk_checkouts_card CHECK (attempt_id IS NULL OR payment_choice IS NOT NULL)
);
CREATE INDEX kiosk_checkouts_station_recent ON kiosk_checkouts (tenant_id, station_id, created_at DESC);
-- The retention pass blanks member references older than 30 days (server/ops/retention.ts).
CREATE INDEX kiosk_checkouts_member_retention ON kiosk_checkouts (created_at)
  WHERE loyalty_member_id IS NOT NULL;

-- 6. Menu media: image assets (bytes in the object store, never in the database) ----------------
-- variants = {thumb|card|hero: {w, h, bytes, sha256}}. Object keys m/<tenant_id>/<id>/<variant>.webp.
CREATE TABLE menu_media (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  id uuid NOT NULL,
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'ready', 'deleted', 'purged')),
  width integer CHECK (width BETWEEN 1 AND 20000),
  height integer CHECK (height BETWEEN 1 AND 20000),
  variants jsonb CHECK (variants IS NULL OR jsonb_typeof(variants) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  purged_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, deleted_by) REFERENCES employees(tenant_id, id),
  CONSTRAINT menu_media_shape CHECK (
    (state = 'uploading') = (variants IS NULL) AND
    (variants IS NULL) = (width IS NULL) AND
    (width IS NULL) = (height IS NULL) AND
    (state IN ('deleted', 'purged')) = (deleted_at IS NOT NULL) AND
    (state = 'purged') = (purged_at IS NOT NULL))
);

-- 7. Suggestions (curated): one row per product, plus one cart row (critic R35: replaced by
-- UPDATE, never deleted). Product ids are validated at write and filtered again at read (archived
-- or unavailable products are never offered).
CREATE TABLE menu_suggestions (
  tenant_id uuid NOT NULL REFERENCES restaurants(id),
  scope text NOT NULL CHECK (scope IN ('product', 'cart')),
  source_product_id uuid,
  product_ids uuid[] NOT NULL DEFAULT '{}'
    CHECK (array_position(product_ids, NULL) IS NULL),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  FOREIGN KEY (tenant_id, source_product_id) REFERENCES catalog(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id),
  CONSTRAINT menu_suggestions_scope CHECK ((scope = 'product') = (source_product_id IS NOT NULL)),
  CONSTRAINT menu_suggestions_size CHECK (
    cardinality(product_ids) <= CASE scope WHEN 'product' THEN 4 ELSE 6 END),
  CONSTRAINT menu_suggestions_not_self CHECK (
    source_product_id IS NULL OR NOT (source_product_id = ANY (product_ids)))
);
CREATE UNIQUE INDEX menu_suggestions_one ON menu_suggestions (tenant_id, scope, source_product_id)
  NULLS NOT DISTINCT;

-- 8. Immutability triggers -----------------------------------------------------------------------
CREATE FUNCTION kiosk_station_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kiosk_station_immutable'; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.created_by, OLD.created_at)
     OR OLD.archived_at IS NOT NULL
     OR NEW.version < OLD.version THEN
    RAISE EXCEPTION 'kiosk_station_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kiosk_stations_transition BEFORE UPDATE OR DELETE ON kiosk_stations
  FOR EACH ROW EXECUTE FUNCTION kiosk_station_transition();

-- A device is born pending (a pairing code), is paired once (the secret replaces the code), sees
-- heartbeats, and is revoked once. A revoked device never changes; a paired one never re-pairs; a
-- pending code never changes and its expiry only moves earlier.
CREATE FUNCTION kiosk_device_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kiosk_device_immutable'; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.station_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.station_id, OLD.created_by, OLD.created_at)
     OR OLD.revoked_at IS NOT NULL
     OR NEW.pairing_attempts < OLD.pairing_attempts
     OR (OLD.secret_hash IS NOT NULL AND
         (NEW.secret_hash, NEW.paired_at, NEW.pairing_attempts)
         IS DISTINCT FROM (OLD.secret_hash, OLD.paired_at, OLD.pairing_attempts))
     OR (OLD.secret_hash IS NULL AND NEW.secret_hash IS NULL AND
         (NEW.pairing_code_hash IS DISTINCT FROM OLD.pairing_code_hash
          OR NEW.pairing_expires_at > OLD.pairing_expires_at))
     OR (OLD.paired_at IS NULL AND
         (NEW.last_seen_at, NEW.build, NEW.viewport)
         IS DISTINCT FROM (OLD.last_seen_at, OLD.build, OLD.viewport)) THEN
    RAISE EXCEPTION 'kiosk_device_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kiosk_devices_transition BEFORE UPDATE OR DELETE ON kiosk_devices
  FOR EACH ROW EXECUTE FUNCTION kiosk_device_transition();

-- The checkout's identity is evidence. payment_choice: null -> card | counter, card -> counter.
-- attempt_count rises by one exactly when attempt_id changes (a new attempt). loyalty_member_id
-- only value -> null, with nothing else changing (the retention pass).
CREATE FUNCTION kiosk_checkout_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kiosk_checkout_immutable'; END IF;
  IF NEW.loyalty_member_id IS DISTINCT FROM OLD.loyalty_member_id THEN
    IF NEW.loyalty_member_id IS NULL
       AND (to_jsonb(NEW) - 'loyalty_member_id') = (to_jsonb(OLD) - 'loyalty_member_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'kiosk_checkout_immutable';
  END IF;
  IF (NEW.tenant_id, NEW.hold_id, NEW.station_id, NEW.device_id, NEW.fire_operation_id, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.hold_id, OLD.station_id, OLD.device_id, OLD.fire_operation_id, OLD.created_at)
     OR (NEW.payment_choice IS DISTINCT FROM OLD.payment_choice
         AND NOT (OLD.payment_choice IS NULL OR (OLD.payment_choice = 'card' AND NEW.payment_choice = 'counter')))
     OR (NEW.attempt_id IS DISTINCT FROM OLD.attempt_id) <> (NEW.attempt_count = OLD.attempt_count + 1)
     OR NEW.attempt_count NOT IN (OLD.attempt_count, OLD.attempt_count + 1) THEN
    RAISE EXCEPTION 'kiosk_checkout_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kiosk_checkouts_transition BEFORE UPDATE OR DELETE ON kiosk_checkouts
  FOR EACH ROW EXECUTE FUNCTION kiosk_checkout_transition();

-- uploading -> ready (dimensions and variants set once) | deleted; ready -> deleted; deleted -> purged.
CREATE FUNCTION menu_media_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'menu_media_immutable'; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.created_by, OLD.created_at)
     OR NOT ((OLD.state, NEW.state) IN (('uploading','ready'),('uploading','deleted'),
                                        ('ready','deleted'),('deleted','purged')))
     OR (OLD.state <> 'uploading' AND
         (NEW.width, NEW.height, NEW.variants) IS DISTINCT FROM (OLD.width, OLD.height, OLD.variants))
     OR (OLD.state IN ('deleted','purged') AND
         (NEW.deleted_at, NEW.deleted_by) IS DISTINCT FROM (OLD.deleted_at, OLD.deleted_by)) THEN
    RAISE EXCEPTION 'menu_media_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER menu_media_transition BEFORE UPDATE OR DELETE ON menu_media
  FOR EACH ROW EXECUTE FUNCTION menu_media_transition();

CREATE FUNCTION menu_suggestion_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'menu_suggestion_immutable'; END IF;
  IF (NEW.tenant_id, NEW.scope, NEW.source_product_id)
     IS DISTINCT FROM (OLD.tenant_id, OLD.scope, OLD.source_product_id)
     OR NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'menu_suggestion_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER menu_suggestions_transition BEFORE UPDATE OR DELETE ON menu_suggestions
  FOR EACH ROW EXECUTE FUNCTION menu_suggestion_transition();

-- 9. Row-level security --------------------------------------------------------------------------
ALTER TABLE kiosk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiosk_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON kiosk_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE kiosk_stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiosk_stations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON kiosk_stations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE kiosk_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiosk_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON kiosk_devices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE kiosk_checkouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiosk_checkouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON kiosk_checkouts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE menu_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_media FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON menu_media
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE menu_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON menu_suggestions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- The media route has no tenant: it may read exactly the ready asset whose id it supplies (the
-- public_link_lookup pattern of 032). Only server/media.ts sets app.media_id, always a uuid.
CREATE POLICY menu_media_lookup ON menu_media FOR SELECT
  USING (state = 'ready' AND id = nullif(current_setting('app.media_id', true), '')::uuid);
