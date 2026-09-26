-- Item voids with manager approval, and per-employee PIN lockout.
-- Voids are append-only corrections: the original order line snapshot is never
-- edited. Each void names the exact payable units it removes, so a unit that was
-- already paid can never be voided (paid units go through refunds instead).
ALTER TABLE employees
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  ADD COLUMN locked_until timestamptz;

CREATE TABLE line_voids(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_id uuid NOT NULL,
  units integer[] NOT NULL CHECK (cardinality(units) > 0),
  amount integer NOT NULL CHECK (amount >= 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  stock_disposition text NOT NULL CHECK (stock_disposition IN ('returned', 'not_returned')),
  preparation_state text NOT NULL,
  actor_id uuid NOT NULL,
  approver_id uuid NOT NULL,
  kitchen_ack_required boolean NOT NULL,
  kitchen_acknowledged_at timestamptz,
  kitchen_acknowledged_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, line_id) REFERENCES order_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, approver_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, kitchen_acknowledged_by) REFERENCES employees(tenant_id, id),
  CHECK ((kitchen_acknowledged_at IS NULL) = (kitchen_acknowledged_by IS NULL))
);
CREATE INDEX line_voids_order ON line_voids(tenant_id, order_id);
CREATE INDEX line_voids_line ON line_voids(tenant_id, line_id);

ALTER TABLE line_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_voids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON line_voids
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Only the kitchen acknowledgement may change after insert.
CREATE FUNCTION line_voids_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kitchen_acknowledged_at IS NOT NULL
     OR (NEW.tenant_id, NEW.id, NEW.order_id, NEW.line_id, NEW.units, NEW.amount, NEW.reason,
         NEW.stock_disposition, NEW.preparation_state, NEW.actor_id, NEW.approver_id,
         NEW.kitchen_ack_required, NEW.created_at)
        IS DISTINCT FROM
        (OLD.tenant_id, OLD.id, OLD.order_id, OLD.line_id, OLD.units, OLD.amount, OLD.reason,
         OLD.stock_disposition, OLD.preparation_state, OLD.actor_id, OLD.approver_id,
         OLD.kitchen_ack_required, OLD.created_at) THEN
    RAISE EXCEPTION 'line voids are immutable except for a single kitchen acknowledgement';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER line_voids_immutable BEFORE UPDATE ON line_voids
  FOR EACH ROW EXECUTE FUNCTION line_voids_immutable();
