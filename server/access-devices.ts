import { z } from "zod";
import type { Tx } from "./db.js";
import { managers, permit } from "./auth.js";
import { audit, once } from "./orders.js";
import { endDeviceSessions, requireRecentAuth } from "./access.js";
import { DomainError, id, type Session } from "../shared/domain.js";
import { ACCESS, type ManagedDevice } from "../shared/access.js";

async function deviceRows(
  tx: Tx,
  s: Session,
  only?: string,
): Promise<ManagedDevice[]> {
  const rows = await tx`select d.id,d.name,d.active,d.paired_at,d.last_seen_at,d.token_expires_at,
      d.idle_lock_seconds,d.free_slot,d.revoked_at,
      coalesce(d.kind, case when d.name='Owner browser' then 'personal' else 'terminal' end) as kind,
      coalesce(d.token_expires_at,'infinity')<=now() as expired,
      pb.name as paired_by,rb.name as revoked_by,
      (select jsonb_build_object('employeeName',e.name,'since',coalesce(x.created_at,x.last_seen_at,now()))
         from sessions x join employees e on e.tenant_id=x.tenant_id and e.id=x.employee_id
        where x.device_id=d.id and x.ended_at is null and not x.revoked and x.expires_at>now()
        order by coalesce(x.last_seen_at,x.created_at) desc nulls last limit 1) as live,
      exists(select 1 from cash_sessions c where c.device_id=d.id and c.closed_at is null) as open_drawer,
      (select count(distinct x.employee_id) from sessions x where x.device_id=d.id
        and coalesce(x.created_at,x.expires_at)>now()-interval '30 days')::int as employees
    from devices d
    left join employees pb on pb.tenant_id=d.tenant_id and pb.id=d.paired_by
    left join employees rb on rb.tenant_id=d.tenant_id and rb.id=d.revoked_by
    where ${only ?? null}::uuid is null or d.id=${only ?? null}::uuid
    order by d.active desc,coalesce(d.last_seen_at,d.paired_at) desc nulls last,d.name,d.id
    limit 200`;
  return rows.map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    status: !d.active ? "revoked" : d.expired ? "expired" : "active",
    pairedAt: d.paired_at?.toISOString() ?? null,
    pairedBy: d.paired_by ?? null,
    lastSeenAt: d.last_seen_at?.toISOString() ?? null,
    tokenExpiresAt: d.token_expires_at?.toISOString() ?? null,
    idleLockSeconds: d.idle_lock_seconds,
    freeSlot: d.free_slot === 1,
    current: d.id === s.deviceId,
    liveSession: d.live
      ? { employeeName: d.live.employeeName, since: d.live.since }
      : null,
    openDrawer: d.open_drawer,
    sharedWarning: d.kind === "personal" && d.employees > 1,
    revokedAt: d.revoked_at?.toISOString() ?? null,
    revokedBy: d.revoked_by ?? null,
  }));
}

export async function listDevices(tx: Tx, s: Session) {
  permit(s, managers);
  return deviceRows(tx, s);
}

/** Device commands: managers on terminals, a fresh PIN on shared terminals. */
function deviceCommand(s: Session) {
  permit(s, managers);
  requireRecentAuth(s);
}
/** Managers manage shared terminals; only the owner manages personal devices. */
async function manageable(tx: Tx, s: Session, deviceId: string) {
  const [d] = await tx`select id,name,active,
      coalesce(kind, case when name='Owner browser' then 'personal' else 'terminal' end) as kind,
      exists(select 1 from cash_sessions c where c.device_id=devices.id and c.closed_at is null) as open_drawer
    from devices where id=${deviceId} for update`;
  if (!d || !d.active) throw new DomainError("device_unavailable", 404);
  if (d.kind === "personal" && s.role !== "owner")
    throw new DomainError("forbidden", 403);
  return d as { id: string; name: string; kind: string; open_drawer: boolean };
}
async function one(tx: Tx, s: Session, deviceId: string) {
  return (await deviceRows(tx, s, deviceId))[0];
}

const updateInput = z
  .object({
    operationId: id,
    name: z.string().trim().min(1).max(60),
    idleLockSeconds: z
      .number()
      .int()
      .refine((v) => (ACCESS.idleLockChoices as readonly number[]).includes(v))
      .nullable(),
  })
  .strict();
export async function updateDevice(
  tx: Tx,
  s: Session,
  deviceId: string,
  raw: unknown,
) {
  const p = updateInput.parse(raw);
  deviceCommand(s);
  return once(
    tx,
    s,
    p.operationId,
    "access.device_update",
    { deviceId, ...p },
    async () => {
      const d = await manageable(tx, s, deviceId);
      await tx`update devices set name=${p.name},idle_lock_seconds=${p.idleLockSeconds} where id=${deviceId}`;
      await audit(tx, s, "access.device_renamed", deviceId, {
        previousName: d.name,
        name: p.name,
        idleLockSeconds: p.idleLockSeconds,
      });
      return one(tx, s, deviceId);
    },
  );
}

const commandInput = z.object({ operationId: id }).strict();
export async function endDeviceSession(
  tx: Tx,
  s: Session,
  deviceId: string,
  raw: unknown,
) {
  const p = commandInput.parse(raw);
  deviceCommand(s);
  return once(
    tx,
    s,
    p.operationId,
    "access.device_end_session",
    { deviceId, ...p },
    async () => {
      await manageable(tx, s, deviceId);
      const ended = await endDeviceSessions(tx, deviceId, "ended_by_manager", {
        revoke: false,
      });
      await audit(tx, s, "access.device_session_ended", deviceId, { ended });
      return one(tx, s, deviceId);
    },
  );
}

/**
 * Ends the Google sign-ins (owner_sessions) that entered a personal device, so
 * the 12-hour gm_account left on a lost or stolen phone or laptop cannot enter
 * the restaurant again (A6). owner_sessions is scoped by app.account_id, which
 * is set per account and then restored to the caller's value (empty in POS
 * transactions; the acting account in account's owner-seat revocation, which
 * still needs it for its own policies: LD-15 account Q4).
 */
async function revokeOwnerSessions(tx: Tx, deviceId: string): Promise<number> {
  const rows = await tx`select distinct owner_account_id,owner_session_id from sessions
    where device_id=${deviceId} and owner_session_id is not null`;
  if (!rows.length) return 0;
  const [prior] =
    await tx`select coalesce(current_setting('app.account_id',true),'') as account`;
  let ended = 0;
  for (const row of rows) {
    await tx`select set_config('app.account_id',${row.owner_account_id},true)`;
    const done = await tx`update owner_sessions set revoked=true
      where id=${row.owner_session_id} and account_id=${row.owner_account_id} and not revoked
      returning id`;
    ended += done.length;
  }
  await tx`select set_config('app.account_id',${prior.account},true)`;
  return ended;
}

/**
 * The actor of an offboarding that runs outside a POS session: account's
 * owner-seat revocation (co-owner removal or leave, previous owner leaving at
 * a transfer) acts as the acting account's seat employee in each tenant.
 */
export type OffboardingActor = Pick<Session, "tenantId" | "employeeId"> & {
  deviceId: string | null;
};

/**
 * Offboarding (SEC-3/SEC-5, ACC-R6-2): retires the personal devices an
 * employee entered through Google (paired_by = the employee, effective kind
 * personal), as Desvincular would, so a fired person's own phone or laptop
 * stops loading the roster and accepting colleagues' PINs. Their sessions are
 * revoked and the Google sign-ins that entered them end. Terminals the
 * employee paired are left alone, since they are usually the restaurant's own
 * tablets: Equipo lists them so the owner can review them in Dispositivos.
 * An open drawer stays open (recorded in the audit row), as with any revoke.
 */
export async function retirePersonalDevices(
  tx: Tx,
  s: Session,
  employeeId: string,
): Promise<number> {
  return retirePersonalDevicesAs(tx, s, employeeId);
}
/** retirePersonalDevices for an actor that is not a POS session (LD-15 account Q4). */
export async function retirePersonalDevicesAs(
  tx: Tx,
  actor: OffboardingActor,
  employeeId: string,
): Promise<number> {
  // audit() reads only tenantId and employeeId.
  const s = actor as Session;
  const devices = await tx`select id,name,
      exists(select 1 from cash_sessions c where c.device_id=devices.id and c.closed_at is null) as open_drawer
    from devices
    where active and paired_by=${employeeId}
      and coalesce(kind, case when name='Owner browser' then 'personal' else 'terminal' end)='personal'
    order by id
    for update`;
  for (const d of devices) {
    await tx`update devices set active=false,revoked_at=now(),revoked_by=${s.employeeId},
        revoked_reason='revoked',free_slot=null
      where id=${d.id}`;
    const sessions = await endDeviceSessions(tx, d.id, "device_revoked", {
      revoke: true,
    });
    const ownerSessions = await revokeOwnerSessions(tx, d.id);
    await audit(tx, s, "access.device_revoked", d.id, {
      name: d.name,
      kind: "personal",
      reason: "employee_deactivated",
      employeeId,
      openDrawer: d.open_drawer,
      sessions,
      ownerSessions,
      self: d.id === actor.deviceId,
    });
  }
  return devices.length;
}

const revokeInput = z
  .object({ operationId: id, acknowledgeOpenDrawer: z.boolean().default(false) })
  .strict();
/**
 * Unpairs a device: its credential stops working at once, its sessions are
 * revoked (queued sales go to manager reconciliation) and its Free slot is freed.
 * An open drawer stays open and needs an explicit acknowledgement (audited).
 */
export async function revokeDevice(
  tx: Tx,
  s: Session,
  deviceId: string,
  raw: unknown,
) {
  const p = revokeInput.parse(raw);
  deviceCommand(s);
  return once(
    tx,
    s,
    p.operationId,
    "access.device_revoke",
    { deviceId, ...p },
    async () => {
      const d = await manageable(tx, s, deviceId);
      if (d.open_drawer && !p.acknowledgeOpenDrawer)
        throw new DomainError("open_drawer_ack_required", 409);
      await tx`update devices set active=false,revoked_at=now(),revoked_by=${s.employeeId},
          revoked_reason='revoked',free_slot=null
        where id=${deviceId}`;
      const revoked = await endDeviceSessions(tx, deviceId, "device_revoked", {
        revoke: true,
      });
      const ownerSessions =
        d.kind === "personal" ? await revokeOwnerSessions(tx, deviceId) : 0;
      await audit(tx, s, "access.device_revoked", deviceId, {
        name: d.name,
        kind: d.kind,
        openDrawer: d.open_drawer,
        acknowledgedOpenDrawer: p.acknowledgeOpenDrawer,
        sessions: revoked,
        ownerSessions,
        self: deviceId === s.deviceId,
      });
      return one(tx, s, deviceId);
    },
  );
}
