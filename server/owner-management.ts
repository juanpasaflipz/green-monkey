import { employeeSlot } from "./free-limits.js";
import { createHmac, randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Tx } from "./db.js";
import { DomainError } from "../shared/domain.js";
import { hash, password } from "./auth.js";
import { signupInput } from "./owner-accounts.js";
import { requirePro } from "./entitlements.js";
import {
  acceptCoOwnerInvitation,
  provisionCoOwnersForLocation,
  tenantOrganizationScope,
  type AccountCtx,
  type InvitationRow,
} from "./co-owners.js";
import {
  legalConfig,
  legalState,
  recordAcceptances,
  requireCurrentLegal,
  signupOpen,
  type LegalConfig,
} from "./legal.js";
import { legalAcceptedInput } from "../shared/legal.js";
const input = signupInput
  .omit({ trialRequested: true, legalAccepted: true, locale: true })
  .extend({ operationId: z.uuid(), sourceTenantId: z.uuid() });
/**
 * The restaurant's organization, after verifying the account's role there
 * (account 031): "primary" for locations and billing, "owner" (primary or
 * co-owner) for staff invitations and the Free location.
 */
async function owned(
  tx: Tx,
  accountId: string,
  tenantId: string,
  need: "owner" | "primary" = "primary",
) {
  const { organizationId } = await tenantOrganizationScope(
    tx,
    accountId,
    tenantId,
    need,
  );
  return { id: tenantId, organization_id: organizationId };
}
export async function createAdditionalLocation(
  tx: Tx,
  account: { id: string; name: string },
  value: unknown,
  legal: LegalConfig = legalConfig(process.env),
) {
  const p = input.parse(value);
  await requireCurrentLegal(tx, account.id, legal);
  const source = await owned(tx, account.id, p.sourceTenantId);
  await tx`select pg_advisory_xact_lock(hashtextextended(${account.id},918))`;
  const fingerprint = hash(JSON.stringify(p));
  const [prior] =
    await tx`select tenant_id,payload_hash from owner_location_commands where id=${p.operationId}`;
  if (prior) {
    if (prior.payload_hash !== fingerprint)
      throw new DomainError("operation_conflict", 409);
    return { tenantId: prior.tenant_id, created: false, billingPending: true };
  }
  await tx`select set_config('app.tenant_id',${p.sourceTenantId},true)`;
  await requirePro(tx);
  const tenantId = randomUUID(),
    employeeId = randomUUID();
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
  await tx`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,opening_days,activation_pending) values(${tenantId},${source.organization_id},${p.restaurantName},${p.currency},${p.timezone},${p.cutoff},${p.openingDays},true)`;
  await tx`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${tenantId},${employeeId},${account.name},${"account-" + account.id},${password(randomBytes(32).toString("hex"))},'owner')`;
  await tx`insert into owner_memberships(account_id,tenant_id,employee_id) values(${account.id},${tenantId},${employeeId})`;
  await tx`insert into owner_location_commands(account_id,id,payload_hash,tenant_id) values(${account.id},${p.operationId},${fingerprint},${tenantId})`;
  await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${tenantId},${randomUUID()},${employeeId},'restaurant.location_created',${tenantId},${tx.json({ activation: "billing_pending", sourceTenantId: p.sourceTenantId })})`;
  // Active co-owners get their owner seat at the new location too.
  await provisionCoOwnersForLocation(tx, source.organization_id, tenantId);
  return { tenantId, created: true, billingPending: true };
}
const inviteInput = z
  .object({
    operationId: z.uuid(),
    tenantId: z.uuid(),
    email: z
      .email()
      .max(254)
      .transform((v) => v.trim().toLowerCase()),
    role: z.enum(["manager", "cashier", "server", "kitchen"]),
  })
  .strict();
export async function createInvitation(
  tx: Tx,
  accountId: string,
  value: unknown,
  legal: LegalConfig = legalConfig(process.env),
) {
  const p = inviteInput.parse(value);
  await requireCurrentLegal(tx, accountId, legal);
  await owned(tx, accountId, p.tenantId, "owner");
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32)
    throw Error("invitation_signing_key_required");
  const token =
    p.operationId +
    "." +
    createHmac("sha256", secret)
      .update(
        ["gm-invitation-v1", accountId, p.tenantId, p.operationId].join(":"),
      )
      .digest("hex");
  await tx`insert into restaurant_invitations(id,tenant_id,created_by,email,role,token_hash) values(${p.operationId},${p.tenantId},${accountId},${p.email},${p.role},${hash(token)}) on conflict(id) do nothing`;
  const [i] =
    await tx`select * from restaurant_invitations where id=${p.operationId}`;
  if (
    !i ||
    i.tenant_id !== p.tenantId ||
    i.email !== p.email ||
    i.role !== p.role ||
    i.token_hash !== hash(token)
  )
    throw new DomainError("operation_conflict", 409);
  return {
    id: i.id,
    path: "/app?account=1#invite=" + token,
    expiresAt: i.expires_at,
  };
}
export async function listInvitations(
  tx: Tx,
  accountId: string,
  tenantId: string,
) {
  z.uuid().parse(tenantId);
  await owned(tx, accountId, tenantId, "owner");
  return tx`select id,email,role,expires_at,revoked,accepted_at from restaurant_invitations where tenant_id=${tenantId} order by created_at desc limit 100`;
}
const revokeInput = z
  .object({ id: z.uuid(), tenantId: z.uuid().optional() })
  .strict();
/**
 * Revokes an unaccepted invitation. With tenantId any owner of the organization
 * may revoke (co-owner invitations: the primary only); a bare id (or the
 * previous `{ id }` body) keeps the creator-only behaviour.
 */
export async function revokeInvitation(
  tx: Tx,
  accountId: string,
  raw: unknown,
) {
  const p = revokeInput.parse(typeof raw === "string" ? { id: raw } : raw);
  if (!p.tenantId) {
    const rows =
      await tx`update restaurant_invitations set revoked=true where id=${p.id} and created_by=${accountId} and accepted_by is null returning id`;
    if (!rows.length) throw new DomainError("invitation_unavailable", 404);
    return { ok: true };
  }
  await owned(tx, accountId, p.tenantId, "owner");
  const [i] =
    await tx`select role from restaurant_invitations where id=${p.id} and tenant_id=${p.tenantId}`;
  if (!i) throw new DomainError("invitation_unavailable", 404);
  if (i.role === "co_owner") await owned(tx, accountId, p.tenantId, "primary");
  const rows =
    await tx`update restaurant_invitations set revoked=true where id=${p.id} and tenant_id=${p.tenantId} and accepted_by is null returning id`;
  if (!rows.length) throw new DomainError("invitation_unavailable", 404);
  return { ok: true };
}
export async function acceptInvitation(
  tx: Tx,
  account: AccountCtx,
  value: unknown,
  legal: LegalConfig = legalConfig(process.env),
) {
  const { token, legalAccepted, locale } = z
    .object({
      token: z.string().regex(/^[a-f0-9-]{36}\.[a-f0-9]{64}$/),
      legalAccepted: legalAcceptedInput.omit({ dpa: true }).optional(),
      locale: z.enum(["es", "en"]).default("es"),
    })
    .strict()
    .parse(value);
  await tx`select pg_advisory_xact_lock(hashtextextended(${account.id},918))`;
  await tx`select set_config('app.invitation_hash',${hash(token)},true)`;
  const [i] =
    await tx`select *,expires_at>now() as valid from restaurant_invitations where token_hash=${hash(token)} for update`;
  if (
    !i ||
    i.revoked ||
    !account.verifiedEmail ||
    i.email !== account.verifiedEmail.trim().toLowerCase()
  )
    throw new DomainError("invitation_unavailable", 403);
  if (i.accepted_by) {
    if (i.accepted_by !== account.id)
      throw new DomainError("invitation_unavailable", 403);
    return { tenantId: i.tenant_id };
  }
  if (!i.valid) throw new DomainError("invitation_unavailable", 403);
  // account (031): current terms and privacy notice before joining.
  const state = await legalState(tx, account.id, legal);
  if (legal.status === "published" && state.pending.length) {
    if (!legalAccepted) throw new DomainError("legal_acceptance_required", 428);
    await recordAcceptances(
      tx,
      account,
      {
        documents: state.pending.map((d) => ({
          document: d,
          version: legalAccepted[d],
        })),
        locale,
        context: "invitation",
      },
      legal,
    );
  } else if (
    legal.status !== "published" &&
    legalAccepted &&
    signupOpen(legal)
  ) {
    const missing = (["terms", "privacy"] as const).filter(
      (d) => !state.accepted[d],
    );
    if (missing.length)
      await recordAcceptances(
        tx,
        account,
        {
          documents: missing.map((d) => ({
            document: d,
            version: legalAccepted[d],
          })),
          locale,
          context: "invitation",
        },
        legal,
      );
  }
  await tx`select set_config('app.tenant_id',${i.tenant_id},true)`;
  if (i.role === "co_owner")
    return acceptCoOwnerInvitation(tx, account, i as unknown as InvitationRow);
  // Only this account's own membership (031 makes the tenant's memberships
  // readable in tenant scope, R-06).
  const [existing] =
    await tx`select employee_id,revoked_at from owner_memberships where tenant_id=${i.tenant_id} and account_id=${account.id}`;
  const employeeId = existing?.employee_id ?? randomUUID();
  if (!existing) {
    const slot = await employeeSlot(tx, employeeId, true, i.role);
    await tx`insert into employees(tenant_id,id,name,login,secret_hash,role,free_slot) values(${i.tenant_id},${employeeId},${account.name},${"account-" + account.id},${password(randomBytes(32).toString("hex"))},${i.role},${slot})`;
  } else if (existing.revoked_at) {
    // A former owner seat (removed co-owner) rejoins as staff.
    const slot = await employeeSlot(tx, employeeId, true, i.role);
    await tx`update employees set role=${i.role},active=true,deactivated_at=null,free_slot=${slot} where id=${employeeId}`;
    await tx`update owner_memberships set revoked_at=null,revoked_by=null where account_id=${account.id} and tenant_id=${i.tenant_id}`;
  }
  await tx`update restaurant_invitations set accepted_by=${account.id},accepted_at=now(),employee_id=${employeeId} where id=${i.id}`;
  if (!existing)
    await tx`insert into owner_memberships(account_id,tenant_id,employee_id) values(${account.id},${i.tenant_id},${employeeId})`;
  await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${i.tenant_id},${randomUUID()},${employeeId},'invitation.accepted',${i.id},${tx.json({ accountId: account.id, role: i.role })})`;
  return { tenantId: i.tenant_id };
}

export async function selectFreeLocation(
  tx: Tx,
  accountId: string,
  tenantId: string,
  legal: LegalConfig = legalConfig(process.env),
) {
  z.uuid().parse(tenantId);
  await requireCurrentLegal(tx, accountId, legal);
  const r = await owned(tx, accountId, tenantId, "owner");
  await tx`select pg_advisory_xact_lock(hashtextextended(${r.organization_id},921))`;
  const [location] =
    await tx`select activation_pending from restaurants where id=${tenantId}`;
  if (location?.activation_pending)
    throw new DomainError("location_billing_pending", 409);
  const previous =
    await tx`select id from restaurants where organization_id=${r.organization_id} and free_location`;
  for (const location of previous) {
    await tx`select set_config('app.tenant_id',${location.id},true)`;
    await tx`update restaurants set free_location=false where id=${location.id}`;
  }
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
  await tx`update restaurants set free_location=true where id=${tenantId}`;
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
  const [m] =
    await tx`select employee_id from owner_memberships where account_id=${accountId} and tenant_id=${tenantId} and revoked_at is null`;
  await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${tenantId},${randomUUID()},${m.employee_id},'plan.free_location',${tenantId},${tx.json({ organizationId: r.organization_id })})`;
  return { ok: true };
}
