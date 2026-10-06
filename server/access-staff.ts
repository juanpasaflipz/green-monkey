import { createHmac, randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import type { Tx } from "./db.js";
import { managers, operators, permit } from "./auth.js";
import { audit, once } from "./orders.js";
import { employeeSlot, lockFreeLimits } from "./free-limits.js";
import {
  endEmployeeSessions,
  hashSecret,
  requireRecentAuth,
} from "./access.js";
import { cancelCodesCreatedBy } from "./access-pairing.js";
import { retirePersonalDevices } from "./access-devices.js";
import { DomainError, id, type Session } from "../shared/domain.js";
import {
  pinInput,
  type Approver,
  type DeviceKind,
  type StaffRow,
} from "../shared/access.js";

/**
 * Operation fingerprints never contain a PIN: an HMAC under the server secret
 * keeps operations.hash from being brute-forced over the 10^6..10^8 PIN space.
 */
export function pinFingerprint(pin: string) {
  return createHmac("sha256", process.env.JWT_SECRET!)
    .update("gm-pin-fp:" + pin)
    .digest("hex");
}

/** Google-linked employees use login "account-<accountId>". */
const usablePin = (login: string, pinSetAt: Date | null) =>
  pinSetAt !== null || !login.startsWith("account-");

async function staffRows(
  tx: Tx,
  s: Session,
  only?: string,
): Promise<StaffRow[]> {
  const rows = await tx`select e.id,e.name,e.login,e.role,e.active,e.free_slot,e.pin_set_at,e.deactivated_at,
      coalesce(e.locked_until='infinity',false) as hard,
      (select max(coalesce(x.authenticated_at,x.created_at)) from sessions x where x.employee_id=e.id) as last_sign_in,
      (select count(*) from pin_throttles t where t.employee_id=e.id and t.locked_until>now())::int as locked_devices,
      greatest(
        (select max(t.locked_until) from pin_throttles t where t.employee_id=e.id and t.locked_until>now()),
        case when e.locked_until>now() and e.locked_until<>'infinity' then e.locked_until end
      ) as locked_until,
      (select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,
            'kind',coalesce(d.kind, case when d.name='Owner browser' then 'personal' else 'terminal' end))
            order by d.name,d.id),'[]'::jsonb)
         from devices d
        where d.paired_by=e.id and d.active and coalesce(d.token_expires_at,'infinity')>now()) as paired_devices
    from employees e
    where ${only ?? null}::uuid is null or e.id=${only ?? null}::uuid
    order by e.active desc,e.name,e.id`;
  return rows.map((e) => {
    const google = e.login.startsWith("account-");
    const pin = usablePin(e.login, e.pin_set_at);
    return {
      id: e.id,
      name: e.name,
      login: e.login,
      role: e.role,
      active: e.active,
      access: google && pin ? "google_and_pin" : google ? "google" : pin ? "pin" : "none",
      freeSlot: e.free_slot,
      locked: {
        devices: e.locked_devices,
        until: e.locked_until?.toISOString() ?? null,
        hard: e.hard,
      },
      lastSignInAt: e.last_sign_in?.toISOString() ?? null,
      pinSetAt: e.pin_set_at?.toISOString() ?? null,
      deactivatedAt: e.deactivated_at?.toISOString() ?? null,
      isSelf: e.id === s.employeeId,
      pairedDevices: (
        e.paired_devices as { id: string; name: string; kind: DeviceKind }[]
      ).map((d) => ({ ...d, current: d.id === s.deviceId })),
    };
  });
}
async function staffRow(tx: Tx, s: Session, employeeId: string) {
  const [row] = await staffRows(tx, s, employeeId);
  return row;
}

export async function listStaff(tx: Tx, s: Session) {
  permit(s, managers);
  return staffRows(tx, s);
}

/** Active owners and managers who can approve with a PIN on this device. */
export async function listApprovers(tx: Tx, s: Session): Promise<Approver[]> {
  permit(s, operators);
  const rows = await tx`select id,name,role from employees
    where active and role in ('owner','manager')
      and (pin_set_at is not null or login not like 'account-%')
    order by name,id`;
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
}

/**
 * "María José Núñez" → "maria-jose-nunez" (≤30 characters), never starting with
 * the reserved "account-" prefix, suffixed -2, -3… when taken.
 */
export async function generateLogin(tx: Tx, name: string) {
  let base = name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  if (base.length < 2) base = `staff-${base || "1"}`.replace(/-$/, "");
  if (base.startsWith("account-")) base = `staff-${base}`.slice(0, 30);
  const taken = new Set(
    (
      await tx`select login from employees where login=${base} or login like ${base + "-%"}`
    ).map((r) => r.login as string),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++)
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function parseWithPin<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  try {
    return schema.parse(raw);
  } catch (error) {
    if (
      error instanceof ZodError &&
      error.issues.some((issue) => issue.path[0] === "pin")
    )
      throw new DomainError("pin_invalid_format", 400);
    throw error;
  }
}

async function target(tx: Tx, employeeId: string) {
  const [e] =
    await tx`select id,name,role,active,login from employees where id=${employeeId} for update`;
  if (!e) throw new DomainError("employee_not_found", 404);
  return e as {
    id: string;
    name: string;
    role: string;
    active: boolean;
    login: string;
  };
}
/** Staff records are the owner's; every mutation on a terminal needs a fresh PIN. */
function ownerCommand(s: Session) {
  permit(s, ["owner"]);
  requireRecentAuth(s);
}

const loginInput = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{1,39}$/)
  .refine((v) => !v.startsWith("account-"));
const createInput = z
  .object({
    operationId: id,
    name: z.string().trim().min(1).max(80),
    role: z.enum(["manager", "cashier", "server", "kitchen"]),
    pin: pinInput,
    login: loginInput.optional(),
  })
  .strict();
/**
 * Adds an employee with a PIN. Deliberately does not call requireSelling:
 * staff management must work from downgraded or unselected sessions; the Free
 * team limit is still enforced by employeeSlot.
 */
export async function createStaff(tx: Tx, s: Session, raw: unknown) {
  const p = parseWithPin(createInput, raw);
  ownerCommand(s);
  return once(
    tx,
    s,
    p.operationId,
    "access.employee_create",
    { ...p, pin: pinFingerprint(p.pin) },
    async () => {
      const employeeId = randomUUID();
      // employeeSlot takes the tenant's Free-limits lock, which also
      // serializes the login uniqueness check below.
      const slot = await employeeSlot(tx, employeeId, true, p.role);
      let login = p.login;
      if (login) {
        const [taken] =
          await tx`select 1 from employees where login=${login}`;
        if (taken) throw new DomainError("login_taken", 409);
      } else login = await generateLogin(tx, p.name);
      await tx`insert into employees(tenant_id,id,name,login,secret_hash,role,active,free_slot,pin_set_at)
        values(${s.tenantId},${employeeId},${p.name},${login},${await hashSecret(p.pin)},${p.role},true,${slot},now())`;
      await audit(tx, s, "access.employee_created", employeeId, {
        name: p.name,
        role: p.role,
        login,
      });
      return staffRow(tx, s, employeeId);
    },
  );
}

const updateInput = z
  .object({
    operationId: id,
    name: z.string().trim().min(1).max(80),
    role: z.enum(["owner", "manager", "cashier", "server", "kitchen"]),
  })
  .strict();
/** Name and role. A role change ends (does not revoke) the employee's sessions. */
export async function updateStaff(
  tx: Tx,
  s: Session,
  employeeId: string,
  raw: unknown,
) {
  const p = updateInput.parse(raw);
  ownerCommand(s);
  return once(
    tx,
    s,
    p.operationId,
    "access.employee_update",
    { employeeId, ...p },
    async () => {
      const e = await target(tx, employeeId);
      if (employeeId === s.employeeId && p.role !== e.role)
        throw new DomainError("self_role_change", 400);
      if ((e.role === "owner") !== (p.role === "owner"))
        throw new DomainError("owner_role_locked", 403);
      const roleChanged = p.role !== e.role;
      // Owner transitions are refused above, so the Free slot never changes here.
      await tx`update employees set name=${p.name},role=${p.role} where id=${employeeId}`;
      if (roleChanged)
        await endEmployeeSessions(tx, employeeId, "role_changed", {
          revoke: false,
        });
      if (roleChanged && !managers.includes(p.role))
        await cancelCodesCreatedBy(tx, employeeId, s.employeeId);
      await audit(tx, s, "access.employee_updated", employeeId, {
        name: p.name,
        role: p.role,
        previousName: e.name,
        previousRole: e.role,
      });
      return staffRow(tx, s, employeeId);
    },
  );
}

const activeInput = z
  .object({ operationId: id, active: z.boolean() })
  .strict();
/**
 * Offboarding (SEC-3): deactivation revokes every session of the employee on
 * every device and unpairs the personal devices they entered through Google
 * (ACC-R6-2); Google entry is refused because enterOwnerRestaurant requires
 * an active employee. Terminals they paired stay paired (listed in Equipo for
 * review). Sales and records are kept. Reactivation re-applies the Free team
 * slot rules; a reactivated member's browser then gets a fresh device.
 */
export async function setStaffActive(
  tx: Tx,
  s: Session,
  employeeId: string,
  raw: unknown,
) {
  const p = activeInput.parse(raw);
  ownerCommand(s);
  return once(
    tx,
    s,
    p.operationId,
    "access.employee_active",
    { employeeId, ...p },
    async () => {
      // The Free-limits key (LO-3) before the employee row: reactivation takes
      // it in employeeSlot, and saveFreeSelection holds it while updating
      // employees (PLATFORM-LOCKS-6).
      await lockFreeLimits(tx);
      const e = await target(tx, employeeId);
      if (!p.active) {
        if (employeeId === s.employeeId)
          throw new DomainError("self_disable", 400);
        if (e.role === "owner")
          throw new DomainError("owner_cannot_be_deactivated", 400);
        await tx`update employees set active=false,deactivated_at=coalesce(deactivated_at,now()),free_slot=null
          where id=${employeeId}`;
        const sessions = await endEmployeeSessions(
          tx,
          employeeId,
          "employee_deactivated",
          { revoke: true },
        );
        const codes = await cancelCodesCreatedBy(tx, employeeId, s.employeeId);
        const personalDevices = await retirePersonalDevices(tx, s, employeeId);
        await audit(tx, s, "access.employee_deactivated", employeeId, {
          name: e.name,
          sessions,
          pairingCodes: codes,
          personalDevices,
        });
      } else {
        const slot = await employeeSlot(tx, employeeId, true, e.role);
        await tx`update employees set active=true,deactivated_at=null,free_slot=${slot} where id=${employeeId}`;
        await audit(tx, s, "access.employee_reactivated", employeeId, {
          name: e.name,
        });
      }
      return staffRow(tx, s, employeeId);
    },
  );
}

/**
 * Clears every PIN lock of an employee: all device throttles plus the global
 * counter and hard lock. Only the owner does this (PIN reset, owner unlock).
 */
async function clearLocks(tx: Tx, employeeId: string) {
  await tx`update employees set failed_attempts=0,locked_until=null where id=${employeeId}`;
  await clearDeviceLocks(tx, employeeId);
}
/**
 * A manager's unlock: the device throttles and a temporary global lock, never
 * the consecutive-failure counter or the hard lock, so repeated unlocks cannot
 * extend PIN guessing past the 100-failure hard lock (A5).
 */
async function clearDeviceLocks(tx: Tx, employeeId: string) {
  await tx`update pin_throttles set failures=0,lock_level=0,locked_until=null,last_failure_at=null
    where employee_id=${employeeId}`;
  await tx`update employees set locked_until=null
    where id=${employeeId} and locked_until is not null and locked_until<>'infinity'`;
}
/** Roles a manager may unlock; owners and managers are unlocked by the owner only. */
const MANAGER_UNLOCKABLE = ["cashier", "server", "kitchen"];
/** A manager's unlocks of one employee per rolling 24 hours (A5). */
export const MANAGER_UNLOCKS_PER_DAY = 3;

const pinCommand = z.object({ operationId: id, pin: pinInput }).strict();
/** Owner sets a new PIN (also their own "PIN for shared terminals"). */
export async function resetStaffPin(
  tx: Tx,
  s: Session,
  employeeId: string,
  raw: unknown,
) {
  const p = parseWithPin(pinCommand, raw);
  ownerCommand(s);
  return once(
    tx,
    s,
    p.operationId,
    "access.employee_pin",
    { employeeId, operationId: p.operationId, pin: pinFingerprint(p.pin) },
    async () => {
      const e = await target(tx, employeeId);
      // A3 (LD-8, assigned to account 031): an owner's PIN is that person's own
      // "PIN para terminales compartidas"; another owner (co-owner) cannot set it.
      if (e.role === "owner" && employeeId !== s.employeeId)
        throw new DomainError("owner_pin_self_only", 403);
      await tx`update employees set secret_hash=${await hashSecret(p.pin)},pin_set_at=now() where id=${employeeId}`;
      await clearLocks(tx, employeeId);
      const self = employeeId === s.employeeId;
      const sessions = await endEmployeeSessions(tx, employeeId, "pin_reset", {
        revoke: false,
        exceptSessionId: self ? s.id : undefined,
      });
      await audit(tx, s, "access.employee_pin_reset", employeeId, {
        name: e.name,
        self,
        sessions,
      });
      return staffRow(tx, s, employeeId);
    },
  );
}

const unlockInput = z.object({ operationId: id }).strict();
/**
 * Clears a PIN lock (SEC-2). The owner unlocks anyone and clears everything,
 * including the hard lock. A manager unlocks only cashiers, servers and
 * kitchen staff, at most 3 times per employee a day, and never clears the
 * consecutive-failure counter or a hard lock: otherwise a manager could
 * alternate wrong approval PINs and unlocks to guess the owner's PIN (A5).
 */
export async function unlockStaff(
  tx: Tx,
  s: Session,
  employeeId: string,
  raw: unknown,
) {
  const p = unlockInput.parse(raw);
  permit(s, managers);
  requireRecentAuth(s);
  return once(
    tx,
    s,
    p.operationId,
    "access.employee_unlock",
    { employeeId, ...p },
    async () => {
      const e = await target(tx, employeeId);
      const owner = s.role === "owner";
      if (!owner) {
        const [state] =
          await tx`select coalesce(locked_until='infinity',false) as hard from employees where id=${employeeId}`;
        if (!MANAGER_UNLOCKABLE.includes(e.role) || state.hard)
          throw new DomainError("unlock_owner_only", 403);
        const [recent] = await tx`select count(*)::int as n from audit
          where operation='access.employee_unlocked' and entity_id=${employeeId}
            and created_at>now()-interval '1 day'
            and coalesce(detail->>'by','manager')='manager'`;
        if (recent.n >= MANAGER_UNLOCKS_PER_DAY)
          throw new DomainError("unlock_limit", 429);
      }
      if (owner) await clearLocks(tx, employeeId);
      else await clearDeviceLocks(tx, employeeId);
      await audit(tx, s, "access.employee_unlocked", employeeId, {
        name: e.name,
        by: owner ? "owner" : "manager",
      });
      return staffRow(tx, s, employeeId);
    },
  );
}
