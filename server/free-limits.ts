import { z } from "zod";
import type { Tx } from "./db.js";
import { DomainError, type Session } from "../shared/domain.js";
import { entitlement } from "./entitlements.js";
import { FREE_LIMITS } from "../shared/plans.js";

// Shared by password access, social access, invitations and owner selection.
export async function lockFreeLimits(tx: Tx) {
  await tx`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id'),920))`;
}
export async function selectFirstDevice(tx: Tx, deviceId: string) {
  await lockFreeLimits(tx);
  await tx`update devices set free_slot=1 where id=${deviceId} and not exists(select 1 from devices where free_slot=1)`;
}
export async function employeeSlot(
  tx: Tx,
  employeeId: string,
  active: boolean,
  role: string,
) {
  await lockFreeLimits(tx);
  const [old] =
    await tx`select role,free_slot from employees where id=${employeeId}`;
  // Extra owner roles must not bypass the named employee limit.
  if (role === "owner" && old?.role !== "owner")
    throw new DomainError("owner_role_reserved", 403);
  if (!active || role === "owner") return null;
  if (old?.free_slot) return old.free_slot as number;
  const rows =
    await tx`select free_slot from employees where free_slot is not null`;
  const slot = Array.from(
    { length: FREE_LIMITS.employees },
    (_, i) => i + 1,
  ).find((n) => !rows.some((r) => r.free_slot === n));
  if (!slot && (await entitlement(tx)).plan === "free")
    throw new DomainError("free_team_limit", 403);
  return slot ?? null;
}
export async function sellingAllowed(
  tx: Tx,
  employeeId: string,
  deviceId: string,
) {
  const [e] =
    await tx`select role,free_slot,active from employees where id=${employeeId}`;
  const [d] =
    await tx`select free_slot,active from devices where id=${deviceId}`;
  if (!e?.active || !d?.active) return false;
  const [r] =
    await tx`select free_location from restaurants where id=current_setting('app.tenant_id')::uuid`;
  return (
    (await entitlement(tx)).plan === "pro" ||
    Boolean(
      r?.free_location && d.free_slot && (e.role === "owner" || e.free_slot),
    )
  );
}
export async function requireSelling(tx: Tx, s: Session) {
  if (!(await sellingAllowed(tx, s.employeeId, s.deviceId)))
    throw new DomainError("free_selection_required", 403);
}
export async function freeSelection(tx: Tx, s: Session) {
  if (s.role !== "owner") throw new DomainError("forbidden", 403);
  return {
    limits: FREE_LIMITS,
    currentDeviceId: s.deviceId,
    devices:
      await tx`select id,name,free_slot from devices where active order by id`,
    employees:
      await tx`select id,name,role,free_slot from employees where active and role<>'owner' order by name`,
  };
}
export async function saveFreeSelection(tx: Tx, s: Session, raw: unknown) {
  if (s.role !== "owner") throw new DomainError("forbidden", 403);
  const p = z
    .object({
      deviceId: z.uuid(),
      employeeIds: z
        .array(z.uuid())
        .max(FREE_LIMITS.employees)
        .refine((v) => new Set(v).size === v.length),
    })
    .strict()
    .parse(raw);
  await lockFreeLimits(tx);
  const [d] =
    await tx`select id from devices where id=${p.deviceId} and active`;
  const employees =
    await tx`select id from employees where active and role<>'owner'`;
  if (!d || p.employeeIds.some((id) => !employees.some((e) => e.id === id)))
    throw new DomainError("invalid_selection", 400);
  await tx`update devices set free_slot=null where free_slot is not null`;
  await tx`update devices set free_slot=1 where id=${p.deviceId}`;
  await tx`update employees set free_slot=null where free_slot is not null`;
  for (const [index, id] of p.employeeIds.entries())
    await tx`update employees set free_slot=${index + 1} where id=${id}`;
  await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${s.tenantId},gen_random_uuid(),${s.employeeId},'plan.free_selection',${p.deviceId},${tx.json(p)})`;
  return freeSelection(tx, s);
}
