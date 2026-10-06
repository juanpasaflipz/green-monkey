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
/** Hours an open drawer keeps selling after the Free rules stop allowing it (GAP-1, D6). */
export const LAPSE_DRAWER_CONTINUATION_HOURS = 16;
export type SellingBasis =
  "pro" | "free_selection" | "drawer_continuation" | "none";
export type SellingAccess = {
  allowed: boolean;
  basis: SellingBasis;
  continuationUntil: string | null;
  plan: "free" | "pro";
  entitlement: Awaited<ReturnType<typeof entitlement>>;
};
/**
 * Why this employee may (or may not) start sales on this device. Pro allows
 * every active employee and device; Free allows the selected location, device
 * and employees (owners always). When neither applies, a drawer that was
 * opened on this device **before Pro ended** and less than 16 h ago keeps
 * selling until it closes (GAP-1): registers that were open when Pro ended
 * finish their shift. A restaurant that is simply on Free (never Pro, or a
 * drawer opened after the lapse) gets no continuation (ACC-14). A new drawer
 * cannot be opened under continuation (requireDrawerOpenAllowed).
 *
 * When Pro ended, from the entitlement row: `access_until` for trialing and
 * active rows (a trial or grant that ran out); for past_due, canceled and
 * paused rows the earlier of `access_until` (a canceled subscription's
 * `ended_at`) and `updated_at`, the moment the billing worker wrote the
 * status (past_due and paused rows carry no end date); support's
 * end-entitlement writes `free` with the same rule (its `access_until` keeps
 * the grant's end). No row (never Pro) or a Stripe `free` row (unpaid comes
 * after past_due, incomplete before any Pro) gives none.
 */
export async function sellingAccess(
  tx: Tx,
  employeeId: string,
  deviceId: string,
): Promise<SellingAccess> {
  const [e] =
    await tx`select role,free_slot,active from employees where id=${employeeId}`;
  const [d] =
    await tx`select free_slot,active from devices where id=${deviceId}`;
  const ent = await entitlement(tx);
  const result = (
    basis: SellingBasis,
    continuationUntil: string | null = null,
  ) => ({
    allowed: basis !== "none",
    basis,
    continuationUntil,
    plan: ent.plan,
    entitlement: ent,
  });
  if (!e?.active || !d?.active) return result("none");
  if (ent.plan === "pro") return result("pro");
  const [r] =
    await tx`select free_location from restaurants where id=current_setting('app.tenant_id')::uuid`;
  if (r?.free_location && d.free_slot && (e.role === "owner" || e.free_slot))
    return result("free_selection");
  // one_open_drawer makes this an index lookup of at most one row, joined to
  // the tenant's single entitlement row (primary key).
  const [c] =
    await tx`select c.opened_at+make_interval(hours=>${LAPSE_DRAWER_CONTINUATION_HOURS}) as until
    from cash_sessions c join restaurant_entitlements e on e.tenant_id=c.tenant_id
    where c.device_id=${deviceId} and c.closed_at is null
      and c.opened_at>clock_timestamp()-make_interval(hours=>${LAPSE_DRAWER_CONTINUATION_HOURS})
      and c.opened_at<case
        when e.status in ('trialing','active') then e.access_until
        when e.status in ('past_due','canceled','paused')
          or (e.status='free' and e.source='support') then least(e.access_until,e.updated_at)
      end`;
  return c
    ? result("drawer_continuation", (c.until as Date).toISOString())
    : result("none");
}
export async function sellingAllowed(
  tx: Tx,
  employeeId: string,
  deviceId: string,
) {
  return (await sellingAccess(tx, employeeId, deviceId)).allowed;
}
export async function requireSelling(tx: Tx, s: Session) {
  if (!(await sellingAllowed(tx, s.employeeId, s.deviceId)))
    throw new DomainError("free_selection_required", 403);
}
/**
 * Opening a drawer needs selling without continuation: continuation implies
 * this device already has an open drawer, and a second open would only hit the
 * one_open_drawer index (R-26).
 */
export async function requireDrawerOpenAllowed(tx: Tx, s: Session) {
  const access = await sellingAccess(tx, s.employeeId, s.deviceId);
  if (!access.allowed || access.basis === "drawer_continuation")
    throw new DomainError("free_selection_required", 403);
}
/** "auto" (default, row absent) or "manual" once the owner pinned a selection. */
export async function freeSelectionMode(tx: Tx): Promise<"auto" | "manual"> {
  const [row] =
    await tx`select free_selection_mode from restaurant_account_settings where tenant_id=current_setting('app.tenant_id')::uuid`;
  return row?.free_selection_mode === "manual" ? "manual" : "auto";
}
/**
 * Free-slot defaults in auto mode (GAP-1), called by POST /cash/open before
 * the selling check. During Pro the device slot follows the latest drawer
 * opener and the opener (owners excepted) gets an employee slot, evicting the
 * holder with the oldest drawer open, kitchen staff first. On Free, a slot
 * device that never opened a drawer (the owner's sign-up laptop) yields the
 * slot to the first device that opens one. Writes only on a real change
 * (lock order: LO-3 key 920, then devices/employees rows; ARCHITECTURE
 * exception E7, LD-15 account Q8).
 */
export async function autoAssignFreeSlots(tx: Tx, s: Session): Promise<void> {
  await lockFreeLimits(tx);
  if ((await freeSelectionMode(tx)) === "manual") return;
  const [r] =
    await tx`select free_location from restaurants where id=current_setting('app.tenant_id')::uuid`;
  if (!r?.free_location) return;
  const { plan } = await entitlement(tx);
  const detail: Record<string, string | null> = {};
  const [slot] =
    await tx`select id,active from devices where free_slot is not null`;
  if (slot?.id !== s.deviceId) {
    let move = !slot || !slot.active || plan === "pro";
    if (!move) {
      const [used] =
        await tx`select 1 from cash_sessions where device_id=${slot.id} limit 1`;
      move = !used;
    }
    if (move) {
      if (slot) await tx`update devices set free_slot=null where id=${slot.id}`;
      await tx`update devices set free_slot=1 where id=${s.deviceId}`;
      detail.deviceId = s.deviceId;
      detail.previousDeviceId = slot?.id ?? null;
    }
  }
  if (plan === "pro" && s.role !== "owner") {
    const [me] =
      await tx`select free_slot from employees where id=${s.employeeId}`;
    if (me && !me.free_slot) {
      const held =
        await tx`select free_slot from employees where free_slot is not null`;
      let number = Array.from(
        { length: FREE_LIMITS.employees },
        (_, i) => i + 1,
      ).find((n) => !held.some((h) => h.free_slot === n));
      if (!number) {
        const [evicted] =
          await tx`select e.id,e.free_slot from employees e where e.free_slot is not null
          order by (e.role='kitchen') desc,
            (select max(c.opened_at) from cash_sessions c where c.employee_id=e.id) asc nulls first, e.id
          limit 1`;
        await tx`update employees set free_slot=null where id=${evicted.id}`;
        number = evicted.free_slot as number;
        detail.evictedEmployeeId = evicted.id;
      }
      await tx`update employees set free_slot=${number} where id=${s.employeeId}`;
      detail.employeeId = s.employeeId;
    }
  }
  if (Object.keys(detail).length)
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${s.tenantId},gen_random_uuid(),${s.employeeId},'plan.free_slot_auto',${s.deviceId},${tx.json(detail)})`;
}
export async function freeSelection(tx: Tx, s: Session) {
  if (s.role !== "owner") throw new DomainError("forbidden", 403);
  return {
    limits: FREE_LIMITS,
    mode: await freeSelectionMode(tx),
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
  // An explicit owner selection pins it: slots no longer follow drawer openers.
  await tx`insert into restaurant_account_settings(tenant_id,free_selection_mode,updated_by)
      values(${s.tenantId},'manual',${s.employeeId})
    on conflict(tenant_id) do update set free_selection_mode='manual',
      version=restaurant_account_settings.version+1,updated_at=now(),updated_by=excluded.updated_by`;
  await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${s.tenantId},gen_random_uuid(),${s.employeeId},'plan.free_selection',${p.deviceId},${tx.json(p)})`;
  return freeSelection(tx, s);
}
