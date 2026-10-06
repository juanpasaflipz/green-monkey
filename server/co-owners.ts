import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tx } from "./db.js";
import { hash } from "./auth.js";
import { endEmployeeSessions, hashSecret } from "./access.js";
import { cancelCodesCreatedBy } from "./access-pairing.js";
import { retirePersonalDevicesAs } from "./access-devices.js";
import { lockFreeLimits } from "./free-limits.js";
import { legalConfig, requireCurrentLegal, type LegalConfig } from "./legal.js";
import { DomainError } from "../shared/domain.js";

/**
 * Organization scope and co-owners (account 031, GAP-5). "Primary" is
 * organizations.created_by_account (billing and transfers); a co-owner is an
 * active organization_co_owners row. Both hold employee role `owner` at every
 * location, so every POS owner check applies to them unchanged. Seats reuse
 * access's lifecycle: sessions are only created by access's createSession and
 * only ended by endEmployeeSessions; account never writes sessions.
 *
 * app.organization_id widens what the account policies of 031 reveal, so it is
 * set only by organizationScope() after verifying the role, or after a verified
 * invitation or transfer token (docs/ACCOUNT_AND_LEGAL.md).
 */
export const MAX_CO_OWNERS = 3;
/** Fresh Google sign-in window for sensitive account commands (D11). */
export const FRESH_SESSION_MINUTES = 15;
export type OrgRole = "primary" | "co_owner";
export type AccountCtx = {
  id: string;
  name: string;
  email: string;
  sessionId: string;
  verifiedEmail: string | null;
};
const opaque = () => randomBytes(32).toString("hex");
const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());

/** The account's role in an organization (app.account_id must be the account). */
export async function organizationRole(
  tx: Tx,
  accountId: string,
  organizationId: string,
): Promise<OrgRole | null> {
  const [primary] =
    await tx`select 1 from organizations where id=${organizationId} and created_by_account=${accountId}`;
  if (primary) return "primary";
  const [coOwner] =
    await tx`select 1 from organization_co_owners where organization_id=${organizationId} and account_id=${accountId} and removed_at is null`;
  return coOwner ? "co_owner" : null;
}

/** Verifies the role, then (and only then) sets app.organization_id. */
export async function organizationScope(
  tx: Tx,
  accountId: string,
  organizationId: string,
  need: "owner" | "primary",
): Promise<OrgRole> {
  z.uuid().parse(organizationId);
  const role = await organizationRole(tx, accountId, organizationId);
  if (!role) throw new DomainError("forbidden", 403);
  if (need === "primary" && role === "co_owner")
    throw new DomainError("co_owner_primary_only", 403);
  await tx`select set_config('app.organization_id',${organizationId},true)`;
  return role;
}

/** organizationScope for the organization of a restaurant the account has an active membership in. */
export async function tenantOrganizationScope(
  tx: Tx,
  accountId: string,
  tenantId: string,
  need: "owner" | "primary",
): Promise<{ organizationId: string; role: OrgRole }> {
  z.uuid().parse(tenantId);
  const [r] =
    await tx`select organization_id from restaurants where id=${tenantId}`;
  if (!r) throw new DomainError("forbidden", 403);
  const role = await organizationScope(tx, accountId, r.organization_id, need);
  return { organizationId: r.organization_id, role };
}

/** Sensitive commands need a Google sign-in from the last 15 minutes (pre-031 sessions count as stale). */
export async function requireFreshOwnerSession(
  tx: Tx,
  sessionId: string,
): Promise<void> {
  const [fresh] = await tx`select 1 from owner_sessions where id=${sessionId}
      and created_at>now()-make_interval(mins=>${FRESH_SESSION_MINUTES})`;
  if (!fresh) throw new DomainError("reauthentication_required", 403);
}

/** Whether the owner session is fresh (overview flag; same rule). */
export async function freshOwnerSession(tx: Tx, sessionId: string) {
  const [fresh] = await tx`select 1 from owner_sessions where id=${sessionId}
      and created_at>now()-make_interval(mins=>${FRESH_SESSION_MINUTES})`;
  return Boolean(fresh);
}

async function orgTenants(tx: Tx, organizationId: string): Promise<string[]> {
  const rows =
    await tx`select id from restaurants where organization_id=${organizationId} order by id`;
  return rows.map((r) => r.id as string);
}

async function setTenant(tx: Tx, tenantId: string) {
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
}

/**
 * Gives the account an `owner` seat at every location of the organization
 * (or only `o.tenants`); app.organization_id must already be set. A new seat
 * has no usable PIN (login account-<id>, pin_set_at null): its holder enters
 * from their own browser with Google, or sets "Mi PIN para terminales
 * compartidas" through access. An existing seat is reactivated or promoted
 * (a manager seat becomes owner and loses its Free slot; a role change ends
 * its sessions, I-4) and keeps a PIN its holder set. Never creates a session.
 * Returns the seat employee id per tenant.
 */
export async function ensureOwnerSeat(
  tx: Tx,
  organizationId: string,
  accountId: string,
  name: string,
  o: { tenants?: string[]; preferredEmployeeIds?: Record<string, string> } = {},
): Promise<Record<string, string>> {
  const seats: Record<string, string> = {};
  for (const tenantId of o.tenants ?? (await orgTenants(tx, organizationId))) {
    await setTenant(tx, tenantId);
    await lockFreeLimits(tx);
    const [m] =
      await tx`select employee_id,revoked_at from owner_memberships where account_id=${accountId} and tenant_id=${tenantId}`;
    let changed = false;
    let employeeId: string;
    if (!m) {
      employeeId = o.preferredEmployeeIds?.[tenantId] ?? randomUUID();
      await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
        values(${tenantId},${employeeId},${name},${"account-" + accountId},${await hashSecret(opaque())},'owner')`;
      await tx`insert into owner_memberships(account_id,tenant_id,employee_id) values(${accountId},${tenantId},${employeeId})`;
      changed = true;
    } else {
      employeeId = m.employee_id;
      const [e] =
        await tx`select role,active,free_slot from employees where id=${employeeId}`;
      if (e.role !== "owner")
        await endEmployeeSessions(tx, employeeId, "role_changed", {
          revoke: false,
        });
      if (e.role !== "owner" || !e.active || e.free_slot !== null) {
        await tx`update employees set role='owner',active=true,deactivated_at=null,free_slot=null where id=${employeeId}`;
        changed = true;
      }
      if (m.revoked_at) {
        await tx`update owner_memberships set revoked_at=null,revoked_by=null where account_id=${accountId} and tenant_id=${tenantId}`;
        changed = true;
      }
    }
    seats[tenantId] = employeeId;
    if (changed)
      await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${tenantId},${randomUUID()},${employeeId},'account.owner_seat',${employeeId},${tx.json({ accountId, organizationId })})`;
  }
  return seats;
}

/**
 * Removes the account's owner seat at every location of the organization
 * through access's offboarding contract (setStaffActive, ACC-R6-2, LD-15
 * account Q4): deactivate, revoke every session, cancel the seat's open
 * pairing codes and retire its personal devices (ending the Google sign-ins
 * that entered them), then revoke the membership. The acting account's seat
 * in each tenant is the audit actor (the leaving person's own seat for
 * "left"; the new primary's seat, provisioned first, for "transfer").
 */
export async function revokeOwnerSeat(
  tx: Tx,
  organizationId: string,
  accountId: string,
  byAccountId: string,
  reason: "removed" | "left" | "transfer",
): Promise<void> {
  for (const tenantId of await orgTenants(tx, organizationId)) {
    await setTenant(tx, tenantId);
    const [seat] = await tx`select m.employee_id,e.name from owner_memberships m
        join employees e on e.tenant_id=m.tenant_id and e.id=m.employee_id
      where m.account_id=${accountId} and m.tenant_id=${tenantId} and m.revoked_at is null`;
    if (!seat) continue;
    const [by] =
      await tx`select employee_id from owner_memberships where account_id=${byAccountId} and tenant_id=${tenantId} and revoked_at is null`;
    const actor = by?.employee_id ?? seat.employee_id;
    await tx`update employees set active=false,deactivated_at=coalesce(deactivated_at,now()),free_slot=null
      where id=${seat.employee_id}`;
    const sessions = await endEmployeeSessions(
      tx,
      seat.employee_id,
      "employee_deactivated",
      { revoke: true },
    );
    const pairingCodes = await cancelCodesCreatedBy(
      tx,
      seat.employee_id,
      actor,
    );
    const personalDevices = await retirePersonalDevicesAs(
      tx,
      { tenantId, employeeId: actor, deviceId: null },
      seat.employee_id,
    );
    await tx`update owner_memberships set revoked_at=now(),revoked_by=${byAccountId}
      where account_id=${accountId} and tenant_id=${tenantId}`;
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${tenantId},${randomUUID()},${actor},'access.employee_deactivated',${seat.employee_id},${tx.json({ name: seat.name, sessions, pairingCodes, personalDevices })})`;
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${tenantId},${randomUUID()},${actor},'account.owner_seat_revoked',${seat.employee_id},${tx.json({ accountId, organizationId, reason })})`;
  }
}

/** Seats for the active co-owners at a location the primary just created. */
export async function provisionCoOwnersForLocation(
  tx: Tx,
  organizationId: string,
  tenantId: string,
): Promise<void> {
  const coOwners =
    await tx`select c.account_id,a.name from organization_co_owners c
      join owner_accounts a on a.id=c.account_id
    where c.organization_id=${organizationId} and c.removed_at is null order by c.account_id`;
  for (const c of coOwners)
    await ensureOwnerSeat(tx, organizationId, c.account_id, c.name, {
      tenants: [tenantId],
    });
  await setTenant(tx, tenantId);
}

async function accountEvent(
  tx: Tx,
  e: {
    organizationId: string | null;
    actor: string;
    subject?: string | null;
    kind: string;
    detail?: Record<string, unknown>;
  },
) {
  await tx`insert into account_events(id,organization_id,actor_account_id,subject_account_id,kind,detail)
    values(${randomUUID()},${e.organizationId},${e.actor},${e.subject ?? null},${e.kind},${tx.json((e.detail ?? {}) as never)})`;
}
export { accountEvent };

/** Active co-owners plus pending, unexpired co-owner invitations (app.organization_id set). */
async function coOwnerCount(tx: Tx, organizationId: string, pending: boolean) {
  const [active] =
    await tx`select count(*)::int as n from organization_co_owners where organization_id=${organizationId} and removed_at is null`;
  if (!pending) return active.n as number;
  const [invited] =
    await tx`select count(*)::int as n from restaurant_invitations i
      join restaurants r on r.id=i.tenant_id
    where r.organization_id=${organizationId} and i.role='co_owner' and not i.revoked
      and i.accepted_by is null and i.expires_at>now()`;
  return (active.n as number) + (invited.n as number);
}
const lockOrganization = (tx: Tx, organizationId: string, key: number) =>
  tx`select pg_advisory_xact_lock(hashtextextended(${organizationId},${key}))`;
/**
 * The co-owner limit key (931). Taken before the transfer key (932) by any
 * command that needs both (ARCHITECTURE lock order, row 30).
 */
export const lockCoOwnerLimit = (tx: Tx, organizationId: string) =>
  lockOrganization(tx, organizationId, 931);

const inviteInput = z
  .object({ operationId: z.uuid(), organizationId: z.uuid(), email })
  .strict();
/** The primary invites a co-owner (max 3, counting pending invitations). */
export async function createCoOwnerInvitation(
  tx: Tx,
  account: AccountCtx,
  raw: unknown,
  c: LegalConfig = legalConfig(process.env),
): Promise<{ id: string; path: string; expiresAt: string }> {
  const p = inviteInput.parse(raw);
  await requireFreshOwnerSession(tx, account.sessionId);
  await requireCurrentLegal(tx, account.id, c);
  await organizationScope(tx, account.id, p.organizationId, "primary");
  await lockOrganization(tx, p.organizationId, 931);
  const [tenant] =
    await tx`select id from restaurants where organization_id=${p.organizationId}
    order by free_location desc, activation_pending, id limit 1`;
  if (!tenant) throw new DomainError("forbidden", 403);
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32)
    throw Error("invitation_signing_key_required");
  const token =
    p.operationId +
    "." +
    createHmac("sha256", secret)
      .update(
        ["gm-invitation-v1", account.id, tenant.id, p.operationId].join(":"),
      )
      .digest("hex");
  const [prior] =
    await tx`select * from restaurant_invitations where id=${p.operationId}`;
  if (!prior) {
    if ((await coOwnerCount(tx, p.organizationId, true)) >= MAX_CO_OWNERS)
      throw new DomainError("co_owner_limit", 409);
    await tx`insert into restaurant_invitations(id,tenant_id,created_by,email,role,token_hash)
      values(${p.operationId},${tenant.id},${account.id},${p.email},'co_owner',${hash(token)}) on conflict(id) do nothing`;
    await accountEvent(tx, {
      organizationId: p.organizationId,
      actor: account.id,
      kind: "co_owner_invited",
      detail: { invitationId: p.operationId },
    });
  }
  const [i] =
    await tx`select * from restaurant_invitations where id=${p.operationId}`;
  if (
    !i ||
    i.tenant_id !== tenant.id ||
    i.email !== p.email ||
    i.role !== "co_owner" ||
    i.token_hash !== hash(token)
  )
    throw new DomainError("operation_conflict", 409);
  return {
    id: i.id,
    path: "/app?account=1#invite=" + token,
    expiresAt: (i.expires_at as Date).toISOString(),
  };
}

export type InvitationRow = {
  id: string;
  tenant_id: string;
  created_by: string;
  role: string;
};
/**
 * Called by acceptInvitation for a co_owner invitation, after the token, email
 * and expiry were verified and app.tenant_id / app.invitation_hash set.
 */
export async function acceptCoOwnerInvitation(
  tx: Tx,
  account: AccountCtx,
  i: InvitationRow,
): Promise<{ tenantId: string; organizationId: string }> {
  const [r] =
    await tx`select organization_id from restaurants where id=${i.tenant_id}`;
  if (!r) throw new DomainError("invitation_unavailable", 403);
  const organizationId: string = r.organization_id;
  await lockOrganization(tx, organizationId, 931);
  // Verified by the invitation token.
  await tx`select set_config('app.organization_id',${organizationId},true)`;
  if (await organizationRole(tx, account.id, organizationId))
    throw new DomainError("invitation_unavailable", 403);
  if ((await coOwnerCount(tx, organizationId, false)) >= MAX_CO_OWNERS)
    throw new DomainError("co_owner_limit", 409);
  const [existing] =
    await tx`select employee_id from owner_memberships where account_id=${account.id} and tenant_id=${i.tenant_id}`;
  const seatId: string = existing?.employee_id ?? randomUUID();
  await tx`update restaurant_invitations set accepted_by=${account.id},accepted_at=now(),employee_id=${seatId} where id=${i.id}`;
  await tx`insert into organization_co_owners(id,organization_id,account_id,added_by,source,invitation_id)
    values(${randomUUID()},${organizationId},${account.id},${i.created_by},'invitation',${i.id})`;
  const seats = await ensureOwnerSeat(
    tx,
    organizationId,
    account.id,
    account.name,
    {
      preferredEmployeeIds: { [i.tenant_id]: seatId },
    },
  );
  for (const [tenantId, employeeId] of Object.entries(seats)) {
    await setTenant(tx, tenantId);
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${tenantId},${randomUUID()},${employeeId},'account.co_owner_added',${employeeId},${tx.json({ accountId: account.id, organizationId })})`;
  }
  await setTenant(tx, i.tenant_id);
  await accountEvent(tx, {
    organizationId,
    actor: account.id,
    subject: account.id,
    kind: "co_owner_added",
    detail: { invitationId: i.id },
  });
  return { tenantId: i.tenant_id, organizationId };
}

const removeInput = z
  .object({ organizationId: z.uuid(), accountId: z.uuid() })
  .strict();
/** The primary removes a co-owner: their seats and sessions end everywhere. */
export async function removeCoOwner(
  tx: Tx,
  account: AccountCtx,
  raw: unknown,
  c: LegalConfig = legalConfig(process.env),
): Promise<{ ok: true }> {
  const p = removeInput.parse(raw);
  await requireFreshOwnerSession(tx, account.sessionId);
  await requireCurrentLegal(tx, account.id, c);
  await organizationScope(tx, account.id, p.organizationId, "primary");
  await lockOrganization(tx, p.organizationId, 931);
  const rows =
    await tx`update organization_co_owners set removed_at=now(),removed_by=${account.id},removal='removed'
    where organization_id=${p.organizationId} and account_id=${p.accountId} and removed_at is null returning id`;
  if (!rows.length) throw new DomainError("co_owner_not_found", 404);
  await revokeOwnerSeat(
    tx,
    p.organizationId,
    p.accountId,
    account.id,
    "removed",
  );
  await accountEvent(tx, {
    organizationId: p.organizationId,
    actor: account.id,
    subject: p.accountId,
    kind: "co_owner_removed",
  });
  return { ok: true };
}

const leaveInput = z.object({ organizationId: z.uuid() }).strict();
/** A co-owner leaves (the primary cannot: co_owner_primary_only). */
export async function leaveCoOwnership(
  tx: Tx,
  account: AccountCtx,
  raw: unknown,
): Promise<{ ok: true }> {
  const p = leaveInput.parse(raw);
  const role = await organizationScope(
    tx,
    account.id,
    p.organizationId,
    "owner",
  );
  if (role === "primary") throw new DomainError("co_owner_primary_only", 403);
  await lockOrganization(tx, p.organizationId, 931);
  const rows =
    await tx`update organization_co_owners set removed_at=now(),removed_by=${account.id},removal='left'
    where organization_id=${p.organizationId} and account_id=${account.id} and removed_at is null returning id`;
  if (!rows.length) throw new DomainError("co_owner_not_found", 404);
  await revokeOwnerSeat(tx, p.organizationId, account.id, account.id, "left");
  await accountEvent(tx, {
    organizationId: p.organizationId,
    actor: account.id,
    subject: account.id,
    kind: "co_owner_left",
  });
  return { ok: true };
}
