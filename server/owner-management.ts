import { createHmac, randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Tx } from "./db.js";
import { DomainError } from "../shared/domain.js";
import { hash, password } from "./auth.js";
import { signupInput } from "./owner-accounts.js";
import { requirePro } from "./entitlements.js";
const input = signupInput
  .omit({ trialRequested: true })
  .extend({ operationId: z.uuid(), sourceTenantId: z.uuid() });
async function owned(tx: Tx, accountId: string, tenantId: string) {
  const [r] =
    await tx`select r.id,r.organization_id from restaurants r join organizations o on o.id=r.organization_id where r.id=${tenantId} and o.created_by_account=${accountId}`;
  if (!r) throw new DomainError("forbidden", 403);
  return r;
}
export async function createAdditionalLocation(
  tx: Tx,
  account: { id: string; name: string },
  value: unknown,
) {
  const p = input.parse(value);
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
) {
  const p = inviteInput.parse(value);
  await owned(tx, accountId, p.tenantId);
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
  await owned(tx, accountId, tenantId);
  return tx`select id,email,role,expires_at,revoked,accepted_at from restaurant_invitations where tenant_id=${tenantId} order by created_at desc limit 100`;
}
export async function revokeInvitation(tx: Tx, accountId: string, id: string) {
  z.uuid().parse(id);
  const rows =
    await tx`update restaurant_invitations set revoked=true where id=${id} and created_by=${accountId} and accepted_by is null returning id`;
  if (!rows.length) throw new DomainError("invitation_unavailable", 404);
  return { ok: true };
}
export async function acceptInvitation(
  tx: Tx,
  account: { id: string; name: string; verifiedEmail: string | null },
  value: unknown,
) {
  const { token } = z
    .object({ token: z.string().regex(/^[a-f0-9-]{36}\.[a-f0-9]{64}$/) })
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
  await tx`select set_config('app.tenant_id',${i.tenant_id},true)`;
  const [existing] =
    await tx`select employee_id from owner_memberships where tenant_id=${i.tenant_id}`;
  const employeeId = existing?.employee_id ?? randomUUID();
  if (!existing)
    await tx`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${i.tenant_id},${employeeId},${account.name},${"account-" + account.id},${password(randomBytes(32).toString("hex"))},${i.role})`;
  await tx`update restaurant_invitations set accepted_by=${account.id},accepted_at=now(),employee_id=${employeeId} where id=${i.id}`;
  if (!existing)
    await tx`insert into owner_memberships(account_id,tenant_id,employee_id) values(${account.id},${i.tenant_id},${employeeId})`;
  await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${i.tenant_id},${randomUUID()},${employeeId},'invitation.accepted',${i.id},${tx.json({ accountId: account.id, role: i.role })})`;
  return { tenantId: i.tenant_id };
}
