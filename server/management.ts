import { employeeSlot, requireSelling } from "./free-limits.js";
import { requirePro } from "./entitlements.js";
import { z } from "zod";
import { Decimal } from "decimal.js";
import type { Tx } from "./db.js";
import { id, money, DomainError, type Session } from "../shared/domain.js";
import { permit, managers, password, hash } from "./auth.js";
import { once, audit, stock } from "./orders.js";
import { saveLegacyProduct } from "./menu.js";
export async function saveProduct(tx: Tx, s: Session, raw: unknown) {
  // Clients of the previous revision; the menu editor uses /menu/products/save.
  return saveLegacyProduct(tx, s, raw);
}
export async function saveEmployee(tx: Tx, s: Session, raw: unknown) {
  permit(s, ["owner"]);
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
    { ...p, secret: hash(p.secret) },
    async () => {
      await requireSelling(tx, s);
      const slot = await employeeSlot(tx, p.id, p.active, p.role);
      await tx`insert into employees(tenant_id,id,name,login,role,secret_hash,active,free_slot) values(${s.tenantId},${p.id},${p.name},${p.login},${p.role},${password(p.secret)},${p.active},${slot}) on conflict(tenant_id,id) do update set name=excluded.name,login=excluded.login,role=excluded.role,secret_hash=excluded.secret_hash,active=excluded.active,free_slot=excluded.free_slot`;
      await tx`update sessions set revoked=true where employee_id=${p.id}`;
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
