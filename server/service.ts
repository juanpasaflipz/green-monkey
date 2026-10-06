import { z } from "zod";
import type { Tx } from "./db.js";
import {
  DomainError,
  id,
  nextPreparation,
  type Session,
} from "../shared/domain.js";
import { permit, operators } from "./auth.js";
import { once, audit, getOrder } from "./orders.js";
import { assertCheckWritable, refreshCheckState } from "./checks.js";
import { bumpKitchenFeed } from "./kitchen.js";
import { refreshOrderState } from "./voids.js";
export async function serviceOptions(tx: Tx, s: Session) {
  permit(s, operators);
  return {
    tables:
      await tx`select t.id,t.name,t.area_id from dining_tables t left join dining_areas a on a.tenant_id=t.tenant_id and a.id=t.area_id where t.archived_at is null order by a.position nulls first,t.position,t.name`,
    employees:
      await tx`select id,name from employees where active and role in ('owner','manager','server','cashier') order by name`,
  };
}
export async function assignService(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
) {
  permit(s, operators);
  const p = z
    .object({
      operationId: id,
      expectedVersion: z.number().int().nonnegative(),
      tableId: id.nullable(),
      employeeId: id,
      mode: z.enum(["takeaway", "dine_in", "delivery"]),
      reason: z.string().trim().min(3).max(300),
    })
    .strict()
    .parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "service.assignment",
    { orderId, ...p },
    async () => {
      const [old] =
        await tx`select * from orders where id=${orderId} for update`;
      if (!old) throw new DomainError("not_found", 404);
      assertCheckWritable(old as { check_state: string; state: string });
      if (old.service_version !== p.expectedVersion)
        throw new DomainError("stale_order", 409);
      const [employee] =
        await tx`select id from employees where id=${p.employeeId} and active and role in ('owner','manager','server','cashier') for share`;
      if (!employee) throw new DomainError("invalid_assignee", 400);
      if (p.tableId) {
        const [table] =
          await tx`select id from dining_tables where id=${p.tableId} and archived_at is null for share`;
        if (!table || p.mode !== "dine_in")
          throw new DomainError("invalid_table", 400);
      }
      await tx`update orders set assigned_employee_id=${p.employeeId},table_id=${p.tableId},mode=${p.mode},service_version=service_version+1 where id=${orderId}`;
      await audit(tx, s, "service.assigned", orderId, {
        before: {
          employeeId: old.assigned_employee_id ?? old.employee_id,
          tableId: old.table_id,
          mode: old.mode,
        },
        after: { employeeId: p.employeeId, tableId: p.tableId, mode: p.mode },
        reason: p.reason,
      });
      // LO-R3: the kitchen feed (LO-10) after the order, assignee and table locks
      // and before refreshCheckState: a paid check moved off its table settles and
      // may issue its ticket, which takes the folio counter (LO-12) last.
      await bumpKitchenFeed(tx, s);
      await refreshCheckState(tx, s, orderId);
      return getOrder(tx, orderId);
    },
  );
}

export async function progressPreparation(
  tx: Tx,
  s: Session,
  roundId: string,
  raw: unknown,
) {
  permit(s, ["owner", "manager", "kitchen", "server"]);
  const p = z
    .object({ operationId: id, state: z.enum(["seen", "ready", "completed"]) })
    .strict()
    .parse(raw);
  if (s.role === "server" && p.state !== "completed")
    throw new DomainError("forbidden", 403);
  return once(
    tx,
    s,
    p.operationId,
    "kitchen",
    { ...p, id: roundId },
    async () => {
      const [pointer] =
        await tx`select order_id from rounds where id=${roundId}`;
      if (!pointer) throw new DomainError("not_found", 404);
      // Lock the parent before a round, matching additions and financial commands.
      await tx`select id from orders where id=${pointer.order_id} for update`;
      const [r] = await tx`select * from rounds where id=${roundId} for update`;
      if (p.state === "completed") {
        // SVC-K6: a delivered round leaves the KDS, and with it the only place
        // its void (or refund cancellation, discounts 028) can be acknowledged.
        // The kitchen confirms it first.
        const [pending] = await tx`select 1 from kitchen_removals v
          join order_lines l on l.tenant_id=v.tenant_id and l.id=v.line_id
          where v.tenant_id=${r.tenant_id} and v.order_id=${r.order_id}
            and l.round=${r.number} and l.data->>'station'=${r.station}
            and v.kitchen_ack_required and v.kitchen_acknowledged_at is null
          limit 1`;
        if (pending) throw new DomainError("void_ack_required", 409);
      }
      if (p.state === "seen")
        await tx`update rounds set seen_at=coalesce(seen_at,now()) where id=${r.id}`;
      else {
        nextPreparation(r.state, p.state);
        await tx`update rounds set state=${p.state},seen_at=coalesce(seen_at,now()) where id=${r.id}`;
      }
      // Never resurrects a cancelled order or touches recovery orders.
      await refreshOrderState(tx, r.order_id);
      await audit(tx, s, "kitchen." + p.state, r.id);
      await bumpKitchenFeed(tx, s);
      return { ok: true };
    },
  );
}
