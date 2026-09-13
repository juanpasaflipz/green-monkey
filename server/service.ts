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
export async function serviceOptions(tx: Tx, s: Session) {
  permit(s, operators);
  return {
    tables: await tx`select id,name from dining_tables order by name`,
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
      if (
        old.state === "completed" ||
        old.service_version !== p.expectedVersion
      )
        throw new DomainError("stale_order", 409);
      const [employee] =
        await tx`select id from employees where id=${p.employeeId} and active and role in ('owner','manager','server','cashier') for share`;
      if (!employee) throw new DomainError("invalid_assignee", 400);
      if (p.tableId) {
        const [table] =
          await tx`select id from dining_tables where id=${p.tableId}`;
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
      if (p.state === "seen")
        await tx`update rounds set seen_at=coalesce(seen_at,now()) where id=${r.id}`;
      else {
        nextPreparation(r.state, p.state);
        await tx`update rounds set state=${p.state},seen_at=coalesce(seen_at,now()) where id=${r.id}`;
      }
      const all =
        await tx`select state from rounds where order_id=${r.order_id}`;
      const state = all.every((r) => r.state === "completed")
        ? "completed"
        : all.every((r) => r.state !== "active")
          ? "ready"
          : "active";
      await tx`update orders set state=${state} where id=${r.order_id}`;
      await audit(tx, s, "kitchen." + p.state, r.id);
      return { ok: true };
    },
  );
}
