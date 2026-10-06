import { createSession } from "./access.js";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { hash, sign, verify, password } from "./auth.js";
import { type Tx } from "./db.js";
import { DomainError } from "../shared/domain.js";
import type { VerifiedGoogleIdentity } from "./google-identity.js";
import {
  billingConsentEvidence,
  legalConfig,
  legalState,
  recordAcceptances,
  signupOpen,
  type LegalConfig,
} from "./legal.js";
import { LEGAL_DOCUMENTS, legalAcceptedInput } from "../shared/legal.js";

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

/**
 * Called only after server-side provider verification, never from request JSON.
 * While the legal documents are unpublished (and signup is not explicitly
 * allowed outside production), a new Google identity is refused with
 * signup_paused and no owner_accounts row is created; existing accounts still
 * sign in (account 031, FIT-12).
 */
export async function signInGoogleOwner(
  sql: postgres.Sql,
  identity: VerifiedGoogleIdentity,
  policy: { allowNewAccounts: boolean } = { allowNewAccounts: true },
) {
  const identityKey = hash(JSON.stringify([identity.issuer, identity.subject]));
  return sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('app.identity_key',${identityKey},true)`;
    if (!policy.allowNewAccounts) {
      const [known] =
        await tx`select id from owner_accounts where identity_key=${identityKey}`;
      if (!known) throw new DomainError("signup_paused", 503);
    }
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
    await tx`insert into owner_sessions(account_id,id,token_hash,csrf,expires_at,verified_email)
      values(${account.id},${id},${hash(token)},${csrf},now()+interval '12 hours',${identity.email})`;
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
      verifiedEmail: string | null;
    },
  ) => Promise<T>,
) {
  const c = ownerCookie(cookie);
  return accountScope(sql, c.accountId, async (tx) => {
    const [row] =
      await tx`select a.id,a.name,a.email,s.csrf,s.id as session_id,s.verified_email
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
      verifiedEmail: row.verified_email,
    });
  });
}
export const signupInput = z
  .object({
    trialRequested: z.boolean().default(false),
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
    // account (031): versions of the terms, privacy notice and DPA the owner
    // accepted; required while the documents are published (FIT-12).
    legalAccepted: legalAcceptedInput.optional(),
    locale: z.enum(["es", "en"]).default("es"),
  })
  .strict();

export async function createOwnerRestaurant(
  tx: Tx,
  account: { id: string; name: string; sessionId: string },
  input: unknown,
  legal: LegalConfig = legalConfig(process.env),
) {
  const p = signupInput.parse(input);
  await tx`select pg_advisory_xact_lock(hashtextextended(${account.id},918))`;
  const [existing] =
    await tx`select r.id as tenant_id from restaurants r join organizations o on o.id=r.organization_id join signup_billing_intents i on i.tenant_id=r.id where o.created_by_account=${account.id}`;
  if (existing) return { tenantId: existing.tenant_id, created: false };
  if (!signupOpen(legal)) throw new DomainError("signup_paused", 503);
  if (legal.status === "published" && !p.legalAccepted?.dpa)
    throw new DomainError("legal_acceptance_required", 428);
  const accepted = p.legalAccepted;
  // The new primary's express billing consent (UX-3), its own evidence row.
  const consent = billingConsentEvidence(accepted, legal);
  if (accepted)
    for (const d of ["terms", "privacy", "dpa"] as const)
      if (
        accepted[d] !== undefined &&
        accepted[d] !== LEGAL_DOCUMENTS[d].version
      )
        throw new DomainError("legal_version_mismatch", 409);
  if (consent && consent.version !== LEGAL_DOCUMENTS.privacy.version)
    throw new DomainError("legal_version_mismatch", 409);
  const tenantId = randomUUID(),
    organizationId = randomUUID(),
    employeeId = randomUUID();
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
  await tx`insert into organizations(id,name,created_by_account) values(${organizationId},${p.restaurantName},${account.id})`;
  if (accepted) {
    // Terms and privacy only when not already current; the DPA for this organization.
    const state = await legalState(tx, account.id, legal);
    await recordAcceptances(
      tx,
      account,
      {
        documents: [
          ...(["terms", "privacy"] as const)
            .filter((d) => state.pending.includes(d) || !state.accepted[d])
            .map((d) => ({ document: d, version: accepted[d] })),
          ...(accepted.dpa
            ? [
                {
                  document: "dpa" as const,
                  version: accepted.dpa,
                  organizationId,
                },
              ]
            : []),
          ...(consent ? [consent] : []),
        ],
        locale: p.locale,
        context: "signup",
      },
      legal,
    );
  }
  await tx`insert into restaurants(id,organization_id,name,currency,timezone,cutoff,opening_days,free_location)
    values(${tenantId},${organizationId},${p.restaurantName},${p.currency},${p.timezone},${p.cutoff},${p.openingDays},true)`;
  // Social owners have no usable password until an explicit recovery/linking flow.
  await tx`insert into employees(tenant_id,id,name,login,secret_hash,role)
    values(${tenantId},${employeeId},${account.name},${"account-" + account.id},${password(opaque())},'owner')`;
  await tx`insert into owner_memberships(account_id,tenant_id,employee_id) values(${account.id},${tenantId},${employeeId})`;
  await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail)
    values(${tenantId},${randomUUID()},${employeeId},'restaurant.signup',${tenantId},${tx.json({ plan: "free", source: "google" })})`;
  await tx`insert into signup_billing_intents(tenant_id,trial_requested) values(${tenantId},${p.trialRequested})`;
  return { tenantId, created: true };
}

export async function enterOwnerRestaurant(
  tx: Tx,
  accountId: string,
  tenantId: string,
  ownerSessionId: string,
  browser?: { id: string; token: string },
) {
  z.uuid().parse(tenantId);
  const [membership] =
    await tx`select employee_id from owner_memberships where account_id=${accountId} and tenant_id=${tenantId} and revoked_at is null`;
  if (!membership) throw new DomainError("forbidden", 403);
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
  const [restaurant] =
    await tx`select activation_pending from restaurants where id=${tenantId}`;
  if (restaurant?.activation_pending)
    throw new DomainError("location_billing_pending", 409);
  const [employee] =
    await tx`select id from employees where id=${membership.employee_id} and active`;
  if (!employee) throw new DomainError("forbidden", 403);
  const device = {
    id: randomUUID(),
    tenantId,
    token: browser
      ? createHmac("sha256", browser.token)
          .update(`gm-owner-device-v1:${accountId}:${tenantId}`)
          .digest("hex")
      : opaque(),
  };
  let existingDevice = false;
  if (browser) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${accountId + ":" + browser.id + ":" + tenantId},919))`;
    const [prior] =
      await tx`select device_id,browser_token_hash from owner_browser_devices where browser_id=${browser.id} and tenant_id=${tenantId}`;
    if (prior) {
      if (prior.browser_token_hash !== hash(browser.token))
        throw new DomainError("forbidden", 403);
      const [valid] =
        await tx`select id from devices where id=${prior.device_id} and token_hash=${hash(device.token)}
          and active and coalesce(token_expires_at,'infinity')>now()`;
      if (!valid) {
        // A device unpaired after this Google sign-in (a lost or stolen phone
        // or laptop) is never replaced on the strength of the old gm_account:
        // only a new Google sign-in may pair this browser again (A6). Owner
        // sessions last 12 hours from issuance (signInGoogleOwner).
        const [state] = await tx`select d.revoked_at,
            (select os.expires_at-interval '12 hours' from owner_sessions os where os.id=${ownerSessionId}) as issued
          from devices d where d.id=${prior.device_id}`;
        if (state?.revoked_at && !(state.issued > state.revoked_at))
          throw new DomainError("owner_reauth_required", 401);
        // An expired one is never revived either: the route retries once with
        // a fresh browser identity, creating a new device.
        throw new DomainError("owner_browser_reset", 409);
      }
      device.id = prior.device_id;
      existingDevice = true;
      await tx`update devices set token_expires_at=now()+interval '30 days',last_seen_at=now() where id=${device.id}`;
    }
  }
  if (!existingDevice) {
    await tx`insert into devices(tenant_id,id,name,token_hash,kind,paired_at,paired_by,token_expires_at)
      values(${tenantId},${device.id},'Owner browser',${hash(device.token)},'personal',now(),${employee.id},now()+interval '30 days')`;
    if (browser)
      await tx`insert into owner_browser_devices(account_id,browser_id,tenant_id,device_id,browser_token_hash) values(${accountId},${browser.id},${tenantId},${device.id},${hash(browser.token)})`;
  }
  // Google-entered sessions end with the owner session that authorized them.
  const [owner] =
    await tx`select expires_at from owner_sessions where id=${ownerSessionId}`;
  const created = await createSession(tx, {
    employeeId: employee.id,
    deviceId: device.id,
    ownerAccountId: accountId,
    ownerSessionId,
    absoluteExpiresAt: owner?.expires_at,
  });
  return {
    device,
    session: { id: created.id, tenantId, token: created.token },
    absoluteExpiresAt: created.absoluteExpiresAt,
  };
}

export function ownerBrowserCookie(value?: string) {
  if (!value)
    return {
      purpose: "owner-browser" as const,
      id: randomUUID(),
      token: opaque(),
    };
  try {
    return z
      .object({
        purpose: z.literal("owner-browser"),
        id: z.uuid(),
        token: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(verify(value));
  } catch {
    throw new DomainError("pair_device", 403);
  }
}
