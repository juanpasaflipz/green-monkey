import { employeeSlot, requireSelling } from "./free-limits.js";
import { requirePro } from "./entitlements.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Tx } from "./db.js";
import { id, money, DomainError, type Session } from "../shared/domain.js";
import { permit, managers } from "./auth.js";
import {
  endEmployeeSessions,
  hashSecret,
  requireRecentAuth,
} from "./access.js";
import { pinFingerprint } from "./access-staff.js";
import { once, audit, stock } from "./orders.js";
const label = z
  .object({ es: z.string().min(1).max(120), en: z.string().min(1).max(120) })
  .strict();
export async function saveProduct(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = z
    .object({
      operationId: id,
      id,
      name: label,
      category: label,
      price: money,
      available: z.boolean(),
      station: z.enum(["kitchen", "bar"]),
      expectedVersion: z.number().int().nonnegative(),
      cost: money.nullable(),
      recipe: z
        .array(
          z.object({
            stockId: id,
            quantity: z.string().regex(/^\d+(\.\d{1,6})?$/),
          }),
        )
        .max(30),
    })
    .strict()
    .parse(raw);
  return once(tx, s, p.operationId, "catalog.save", p, async () => {
    await requireSelling(tx, s);
    const [old] =
      await tx`select data from catalog where id=${p.id} for update`;
    if (
      JSON.stringify(old?.data.recipe ?? []) !== JSON.stringify(p.recipe) ||
      (old?.data.cost ?? null) !== p.cost
    )
      await requirePro(tx);
    if ((old?.data.version ?? 0) !== p.expectedVersion)
      throw new DomainError("stale_order", 409);
    if (new Set(p.recipe.map((line) => line.stockId)).size !== p.recipe.length)
      throw new DomainError("invalid_recipe");
    for (const line of p.recipe) {
      const [i] = await tx`select id from stock_items where id=${line.stockId}`;
      if (!i || new Decimal(line.quantity).lte(0))
        throw new DomainError("invalid_recipe");
    }
    const data = {
      ...(old?.data ?? { groups: [] }),
      id: p.id,
      name: p.name,
      category: p.category,
      price: p.price,
      available: p.available,
      station: p.station,
      cost: p.cost,
      recipe: p.recipe,
      version: p.expectedVersion + 1,
    };
    await tx`insert into catalog(tenant_id,id,data) values(${s.tenantId},${p.id},${tx.json(data)}) on conflict(tenant_id,id) do update set data=excluded.data`;
    await tx`insert into recipe_versions(tenant_id,id,product_id,version,data) values(${s.tenantId},${randomUUID()},${p.id},${data.version},${tx.json({ recipe: p.recipe, cost: p.cost })})`;
    await audit(tx, s, "catalog.saved", p.id, { version: data.version });
    return data;
  });
}
export async function saveEmployee(tx: Tx, s: Session, raw: unknown) {
  permit(s, ["owner"]);
  // Same rule as the Equipo commands: staff mutations on a shared terminal
  // need a PIN entered recently (SEC-6), so this legacy route is no bypass.
  requireRecentAuth(s);
  const p = z
    .object({
      operationId: id,
      id,
      name: z.string().min(1).max(80),
      login: z.string().min(1).max(80),
      role: z.enum(["owner", "manager", "cashier", "server", "kitchen"]),
      secret: z.string().min(6).max(100),
      active: z.boolean(),
    })
    .strict()
    .parse(raw);
  if (p.id === s.employeeId && !p.active) throw new DomainError("self_disable");
  return once(
    tx,
    s,
    p.operationId,
    "employee.save",
    { ...p, secret: pinFingerprint(p.secret) },
    async () => {
      await requireSelling(tx, s);
      const [old] =
        await tx`select role from employees where id=${p.id} for update`;
      const slot = await employeeSlot(tx, p.id, p.active, p.role);
      await tx`insert into employees(tenant_id,id,name,login,role,secret_hash,active,free_slot,pin_set_at,deactivated_at)
        values(${s.tenantId},${p.id},${p.name},${p.login},${p.role},${await hashSecret(p.secret)},${p.active},${slot},now(),
          case when ${p.active} then null else now() end)
        on conflict(tenant_id,id) do update set name=excluded.name,login=excluded.login,role=excluded.role,
          secret_hash=excluded.secret_hash,active=excluded.active,free_slot=excluded.free_slot,pin_set_at=now(),
          deactivated_at=case when not excluded.active then coalesce(employees.deactivated_at,now()) end,
          failed_attempts=0,locked_until=null`;
      await tx`update pin_throttles set failures=0,lock_level=0,locked_until=null,last_failure_at=null
        where employee_id=${p.id}`;
      // The secret is always sent, so a name-only edit counts as a PIN reset.
      // Only deactivation revokes; other changes end sessions so queued
      // offline evidence still syncs (OFF-7).
      if (!p.active)
        await endEmployeeSessions(tx, p.id, "employee_deactivated", {
          revoke: true,
        });
      else if (old && old.role !== p.role)
        await endEmployeeSessions(tx, p.id, "role_changed", { revoke: false });
      else
        await endEmployeeSessions(tx, p.id, "pin_reset", {
          revoke: false,
          exceptSessionId: p.id === s.employeeId ? s.id : undefined,
        });
      await audit(tx, s, "employee.saved", p.id, {
        role: p.role,
        active: p.active,
      });
      return { ok: true };
    },
  );
}
export async function receive(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = z
    .object({
      operationId: id,
      supplierId: id,
      stockId: id,
      quantity: z.string().regex(/^\d+(\.\d{1,6})?$/),
      cost: money,
      expiresOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
      reason: z.string().min(3).max(300),
    })
    .strict()
    .parse(raw);
  return once(tx, s, p.operationId, "receiving", p, async () => {
    await requireSelling(tx, s);
    await requirePro(tx);
    if (new Decimal(p.quantity).lte(0))
      throw new DomainError("invalid_quantity");
    await tx`insert into receipts(tenant_id,id,supplier_id,stock_id,quantity,cost,expires_on) values(${s.tenantId},${p.operationId},${p.supplierId},${p.stockId},${p.quantity},${p.cost},${p.expiresOn})`;
    await stock(
      tx,
      s,
      p.stockId,
      p.quantity,
      "receipt",
      p.operationId,
      p.reason,
    );
    await audit(tx, s, "stock.received", p.operationId, p);
    return { ok: true };
  });
}
