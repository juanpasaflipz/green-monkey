import { randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { hash, sign, verify, password } from "./auth.js";
import { type Tx } from "./db.js";
import { DomainError } from "../shared/domain.js";
import type { VerifiedGoogleIdentity } from "./google-identity.js";

const opaque = () => randomBytes(32).toString("hex");
export async function accountScope<T>(
  sql: postgres.Sql,
  accountId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  z.uuid().parse(accountId);
  return sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('app.account_id',${accountId},true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Called only after server-side provider verification, never from request JSON. */
export async function signInGoogleOwner(
  sql: postgres.Sql,
  identity: VerifiedGoogleIdentity,
) {
  const identityKey = hash(JSON.stringify([identity.issuer, identity.subject]));
  return sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('app.identity_key',${identityKey},true)`;
    await tx`insert into owner_accounts(id,identity_key,issuer,subject,email,name)
      values(${randomUUID()},${identityKey},${identity.issuer},${identity.subject},${identity.email},${identity.name ?? identity.email})
      on conflict(identity_key) do nothing`;
    const [account] =
      await tx`select id,active from owner_accounts where identity_key=${identityKey}`;
    if (!account?.active) throw new DomainError("unauthorized", 401);
    await tx`select set_config('app.account_id',${account.id},true)`;
    const id = randomUUID(),
      token = opaque(),
      csrf = opaque();
    await tx`insert into owner_sessions(account_id,id,token_hash,csrf,expires_at)
      values(${account.id},${id},${hash(token)},${csrf},now()+interval '12 hours')`;
    return sign({ purpose: "owner-account", accountId: account.id, id, token });
  });
}

export function ownerCookie(value: string) {
  try {
    return z
      .object({
        purpose: z.literal("owner-account"),
        accountId: z.uuid(),
        id: z.uuid(),
        token: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(verify(value));
  } catch {
    throw new DomainError("unauthorized", 401);
  }
}
export async function withOwner<T>(
  sql: postgres.Sql,
  cookie: string,
  csrf: string | undefined,
  fn: (
    tx: Tx,
    account: {
      id: string;
      name: string;
      email: string;
      csrf: string;
      sessionId: string;
    },
  ) => Promise<T>,
) {
  const c = ownerCookie(cookie);
  return accountScope(sql, c.accountId, async (tx) => {
    const [row] = await tx`select a.id,a.name,a.email,s.csrf,s.id as session_id
      from owner_sessions s join owner_accounts a on a.id=s.account_id
      where s.id=${c.id} and s.token_hash=${hash(c.token)} and not s.revoked
        and s.expires_at>now() and a.active`;
    if (!row) throw new DomainError("unauthorized", 401);
    if (csrf !== undefined && csrf !== row.csrf)
      throw new DomainError("forbidden", 403);
    return fn(tx, {
      id: row.id,
      name: row.name,
      email: row.email,
      csrf: row.csrf,
      sessionId: row.session_id,
    });
  });
}
export const signupInput = z
  .object({
    restaurantName: z.string().trim().min(1).max(100),
    currency: z.enum(["MXN", "USD", "EUR"]),
    timezone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
    cutoff: z.number().int().min(0).max(1439),
    openingDays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();

export async function createOwnerRestaurant(
  tx: Tx,
  account: { id: string; name: string },
  input: unknown,
) {
  const p = signupInput.parse(input);
  await tx`select pg_advisory_xact_lock(hashtextextended(${account.id},918))`;
  const [existing] =
    await tx`select tenant_id from owner_memberships where account_id=${account.id}`;
  if (existing) return { tenantId: existing.tenant_id, created: false };
  const tenantId = randomUUID(),
    organizationId = randomUUID(),
    employeeId = randomUUID();
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
  await tx`insert into organizations(id,name,created_by_account) values(${organizationId},${p.restaurantName},${account.id})`;
  await tx`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,opening_days)
    values(${tenantId},${organizationId},${p.restaurantName},${p.currency},${p.timezone},${p.cutoff},${p.openingDays})`;
  // Social owners have no usable password until an explicit recovery/linking flow.
  await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
    values(${tenantId},${employeeId},${account.name},${"account-" + account.id},${password(opaque())},'owner')`;
  await tx`insert into owner_memberships(account_id,tenant_id,employee_id) values(${account.id},${tenantId},${employeeId})`;
  await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail)
    values(${tenantId},${randomUUID()},${employeeId},'restaurant.signup',${tenantId},${tx.json({ plan: "free", source: "google" })})`;
  return { tenantId, created: true };
}

export async function enterOwnerRestaurant(
  tx: Tx,
  accountId: string,
  tenantId: string,
  ownerSessionId: string,
) {
  z.uuid().parse(tenantId);
  const [membership] =
    await tx`select employee_id from owner_memberships where account_id=${accountId} and tenant_id=${tenantId}`;
  if (!membership) throw new DomainError("forbidden", 403);
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
  const [employee] =
    await tx`select id from employees where id=${membership.employee_id} and active and role='owner'`;
  if (!employee) throw new DomainError("forbidden", 403);
  const device = { id: randomUUID(), tenantId, token: opaque() };
  const session = { id: randomUUID(), tenantId, token: opaque() };
  await tx`insert into devices(tenant_id,id,name,token_hash) values(${tenantId},${device.id},'Owner browser',${hash(device.token)})`;
  await tx`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,expires_at,offline_until,owner_account_id,owner_session_id)
    values(${tenantId},${session.id},${employee.id},${device.id},${hash(session.token)},${opaque()},now()+interval '12 hours',now()+interval '4 hours',${accountId},${ownerSessionId})`;
  return { device, session };
}
