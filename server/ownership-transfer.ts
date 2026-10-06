import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tx } from "./db.js";
import { hash } from "./auth.js";
import { hashSecret, secretMatches } from "./access.js";
import {
  MAX_CO_OWNERS,
  accountEvent,
  ensureOwnerSeat,
  lockCoOwnerLimit,
  organizationRole,
  organizationScope,
  requireFreshOwnerSession,
  revokeOwnerSeat,
  type AccountCtx,
} from "./co-owners.js";
import {
  legalConfig,
  legalState,
  recordAcceptances,
  requireCurrentLegal,
  signupOpen,
  type LegalConfig,
} from "./legal.js";
import { DomainError } from "../shared/domain.js";
import { LEGAL_DOCUMENTS, legalAcceptedInput } from "../shared/legal.js";

export { requireFreshOwnerSession };

/**
 * Ownership transfer and recovery codes (account 031, GAP-5). The primary
 * owner pointer (organizations.created_by_account) changes only inside
 * acceptTransfer, guarded by the organization_owner_change_guard trigger and the
 * RESTRICTIVE organization_transfer_update policy (both need app.transfer_id of
 * a pending, available, unexpired transfer to exactly this account).
 */
export const TRANSFER_HOURS = 72;
export const RECOVERY_HOLD_HOURS = 24;
export const RECOVERY_CODES = 10;
const TOKEN = /^[a-f0-9-]{36}\.[a-f0-9]{64}$/;
const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());

/**
 * j***@g***.com: first character, the first character of the domain and the
 * top-level domain; enough to recognise one's own address, not to learn one.
 */
export function maskEmail(value: string): string {
  const [user = "", domain = ""] = value.split("@");
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${user.slice(0, 1)}***@${domain.slice(0, 1)}***${tld}`;
}

function transferToken(
  accountId: string,
  organizationId: string,
  operationId: string,
) {
  const secret = process.env.JWT_SECRET;
  // Same key and pattern as invitations (owner-management.ts createInvitation).
  if (!secret || secret.length < 32)
    throw Error("invitation_signing_key_required");
  return (
    operationId +
    "." +
    createHmac("sha256", secret)
      .update(
        ["gm-transfer-v1", accountId, organizationId, operationId].join(":"),
      )
      .digest("hex")
  );
}
const transferPath = (token: string) => "/app?account=1#transfer=" + token;
const lockTransfers = (tx: Tx, organizationId: string) =>
  tx`select pg_advisory_xact_lock(hashtextextended(${organizationId},932))`;
/** Expired pending rows are closed lazily so a new transfer can start. */
const closeExpired = (tx: Tx, organizationId: string) =>
  tx`update ownership_transfers set state='canceled',canceled_at=now(),canceled_by='expired'
    where organization_id=${organizationId} and state='pending' and expires_at<=now()`;
const sameName = (a: string, b: string) =>
  a.trim().toLocaleLowerCase("es-MX") === b.trim().toLocaleLowerCase("es-MX");

const requestInput = z
  .object({
    operationId: z.uuid(),
    organizationId: z.uuid(),
    email,
    previousOwnerStays: z.boolean(),
    confirmName: z.string().max(200),
  })
  .strict();
/** The primary offers the organization to another Google account (72 h link). */
export async function requestTransfer(
  tx: Tx,
  a: AccountCtx,
  raw: unknown,
  c: LegalConfig = legalConfig(process.env),
): Promise<{
  id: string;
  path: string;
  availableAt: string;
  expiresAt: string;
}> {
  const p = requestInput.parse(raw);
  await requireFreshOwnerSession(tx, a.sessionId);
  await requireCurrentLegal(tx, a.id, c);
  await organizationScope(tx, a.id, p.organizationId, "primary");
  await lockTransfers(tx, p.organizationId);
  const [org] =
    await tx`select name from organizations where id=${p.organizationId}`;
  if (!sameName(p.confirmName, org.name))
    throw new DomainError("invalid_confirmation", 400);
  const mine = [a.email, a.verifiedEmail ?? ""].map((e) =>
    e.trim().toLowerCase(),
  );
  if (mine.includes(p.email)) throw new DomainError("transfer_self", 400);
  const token = transferToken(a.id, p.organizationId, p.operationId);
  const [prior] =
    await tx`select * from ownership_transfers where id=${p.operationId}`;
  if (prior) {
    if (
      prior.organization_id !== p.organizationId ||
      prior.from_account_id !== a.id ||
      prior.to_email !== p.email ||
      prior.previous_owner_stays !== p.previousOwnerStays ||
      prior.token_hash !== hash(token)
    )
      throw new DomainError("operation_conflict", 409);
    return {
      id: prior.id,
      path: transferPath(token),
      availableAt: (prior.available_at as Date).toISOString(),
      expiresAt: (prior.expires_at as Date).toISOString(),
    };
  }
  if (p.previousOwnerStays) {
    const [active] =
      await tx`select count(*)::int as n from organization_co_owners where organization_id=${p.organizationId} and removed_at is null`;
    if (active.n >= MAX_CO_OWNERS) throw new DomainError("co_owner_limit", 409);
  }
  await closeExpired(tx, p.organizationId);
  const [pending] =
    await tx`select 1 from ownership_transfers where organization_id=${p.organizationId} and state='pending'`;
  if (pending) throw new DomainError("transfer_pending_exists", 409);
  const [row] =
    await tx`insert into ownership_transfers(id,organization_id,from_account_id,to_email,token_hash,
      initiated_by,previous_owner_stays,available_at,expires_at)
    values(${p.operationId},${p.organizationId},${a.id},${p.email},${hash(token)},'owner',${p.previousOwnerStays},
      now(),now()+make_interval(hours=>${TRANSFER_HOURS}))
    returning available_at,expires_at`;
  await accountEvent(tx, {
    organizationId: p.organizationId,
    actor: a.id,
    kind: "transfer_requested",
    detail: { transferId: p.operationId, initiatedBy: "owner" },
  });
  return {
    id: p.operationId,
    path: transferPath(token),
    availableAt: (row.available_at as Date).toISOString(),
    expiresAt: (row.expires_at as Date).toISOString(),
  };
}

export type TransferPreview = {
  id: string;
  organizationName: string;
  locations: number;
  fromName: string | null;
  previousOwnerStays: boolean;
  initiatedBy: "owner" | "support" | "recovery_code";
  availableAt: string;
  expiresAt: string;
  hasSubscription: boolean;
  emailMatches: boolean;
  onHold: boolean;
  dpaVersion: string;
  needsLegal: Array<"terms" | "privacy">;
};

/** The from-account's seat name (owner_accounts rows are private to each account). */
export async function fromName(
  tx: Tx,
  organizationId: string,
  accountId: string,
) {
  const tenants =
    await tx`select id from restaurants where organization_id=${organizationId}
    order by free_location desc, id`;
  for (const t of tenants) {
    await tx`select set_config('app.tenant_id',${t.id},true)`;
    const [seat] = await tx`select e.name from owner_memberships m
        join employees e on e.tenant_id=m.tenant_id and e.id=m.employee_id
      where m.account_id=${accountId} and m.tenant_id=${t.id}`;
    if (seat) return seat.name as string;
  }
  return null;
}

async function describeTransfer(
  tx: Tx,
  a: AccountCtx,
  t: Record<string, any>,
  c: LegalConfig,
): Promise<TransferPreview> {
  // Verified by the token or by to_account_id.
  await tx`select set_config('app.organization_id',${t.organization_id},true)`;
  const [org] =
    await tx`select name,(select count(*)::int from restaurants r where r.organization_id=o.id) as locations
      from organizations o where o.id=${t.organization_id}`;
  const [billing] =
    await tx`select 1 from organization_billing where organization_id=${t.organization_id} and subscription_id is not null`;
  const [clock] = await tx`select now() as now`;
  return {
    id: t.id,
    organizationName: org.name,
    locations: org.locations,
    fromName: await fromName(tx, t.organization_id, t.from_account_id),
    previousOwnerStays: t.previous_owner_stays,
    initiatedBy: t.initiated_by,
    availableAt: (t.available_at as Date).toISOString(),
    expiresAt: (t.expires_at as Date).toISOString(),
    hasSubscription: Boolean(billing),
    emailMatches: t.to_email === (a.verifiedEmail ?? "").trim().toLowerCase(),
    onHold: (t.available_at as Date) > (clock.now as Date),
    dpaVersion: LEGAL_DOCUMENTS.dpa.version,
    needsLegal: (await legalState(tx, a.id, c)).pending,
  };
}

async function liveTransfer(
  tx: Tx,
  where: { token?: string; transferId?: string; accountId: string },
) {
  if (where.token) {
    await tx`select set_config('app.transfer_hash',${hash(where.token)},true)`;
    const [t] =
      await tx`select *,expires_at>now() as live from ownership_transfers where token_hash=${hash(where.token)}`;
    return t;
  }
  const [t] =
    await tx`select *,expires_at>now() as live from ownership_transfers where id=${where.transferId!} and to_account_id=${where.accountId}`;
  return t;
}

const previewInput = z
  .object({
    token: z.string().regex(TOKEN).optional(),
    transferId: z.uuid().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.token) !== Boolean(v.transferId));
/** What the target sees before accepting (never the from-account's email). */
export async function previewTransfer(
  tx: Tx,
  a: AccountCtx,
  raw: unknown,
  c: LegalConfig = legalConfig(process.env),
): Promise<TransferPreview> {
  const p = previewInput.parse(raw);
  const t = await liveTransfer(tx, { ...p, accountId: a.id });
  if (!t || t.state !== "pending" || !t.live)
    throw new DomainError("transfer_unavailable", 403);
  return describeTransfer(tx, a, t, c);
}

const acceptInput = z
  .object({
    token: z.string().regex(TOKEN).optional(),
    transferId: z.uuid().optional(),
    legalAccepted: legalAcceptedInput.optional(),
    locale: z.enum(["es", "en"]).default("es"),
  })
  .strict()
  .refine((v) => Boolean(v.token) !== Boolean(v.transferId));
/**
 * The target becomes the primary owner, in one transaction: the previous owner
 * stays as a co-owner or leaves (access offboarding); the target gets owner
 * seats everywhere (an invited manager seat is promoted); the new primary
 * accepts the DPA for the organization.
 */
export async function acceptTransfer(
  tx: Tx,
  a: AccountCtx,
  raw: unknown,
  c: LegalConfig = legalConfig(process.env),
): Promise<{ organizationId: string; tenantIds: string[] }> {
  const p = acceptInput.parse(raw);
  await requireFreshOwnerSession(tx, a.sessionId);
  const found = await liveTransfer(tx, { ...p, accountId: a.id });
  if (!found) throw new DomainError("transfer_unavailable", 403);
  // 931 then 932: the co-owner limit is re-checked below (ACC-10).
  await lockCoOwnerLimit(tx, found.organization_id);
  await lockTransfers(tx, found.organization_id);
  const [t] =
    await tx`select *,expires_at>now() as live,available_at>now() as on_hold
      from ownership_transfers where id=${found.id} for update`;
  if (!t || t.state !== "pending" || !t.live)
    throw new DomainError("transfer_unavailable", 403);
  if (t.on_hold) throw new DomainError("transfer_on_hold", 409);
  // The generic error avoids confirming which address a link was meant for.
  if (
    !a.verifiedEmail ||
    t.to_email !== a.verifiedEmail.trim().toLowerCase() ||
    (t.to_account_id && t.to_account_id !== a.id) ||
    t.from_account_id === a.id
  )
    throw new DomainError("transfer_unavailable", 403);
  const organizationId: string = t.organization_id;
  const [owns] =
    await tx`select 1 from organizations where created_by_account=${a.id} and id<>${organizationId}`;
  if (owns) throw new DomainError("transfer_target_owns_organization", 409);
  await tx`select set_config('app.organization_id',${organizationId},true),
      set_config('app.transfer_id',${t.id},true)`;
  if (!t.to_account_id)
    await tx`update ownership_transfers set to_account_id=${a.id} where id=${t.id}`;
  const legal = await legalState(tx, a.id, c);
  const documents: Array<{
    document: "terms" | "privacy" | "dpa";
    version: string;
    organizationId?: string;
  }> = [];
  if (c.status === "published") {
    if (!p.legalAccepted)
      throw new DomainError("legal_acceptance_required", 428);
    for (const d of legal.pending)
      documents.push({ document: d, version: p.legalAccepted[d] });
    if (!p.legalAccepted.dpa)
      throw new DomainError("legal_acceptance_required", 428);
    documents.push({
      document: "dpa",
      version: p.legalAccepted.dpa,
      organizationId,
    });
  } else if (p.legalAccepted && signupOpen(c)) {
    // Unpublished drafts (test environments): evidence with published=false.
    for (const d of ["terms", "privacy"] as const)
      if (!legal.accepted[d])
        documents.push({ document: d, version: p.legalAccepted[d] });
    if (p.legalAccepted.dpa)
      documents.push({
        document: "dpa",
        version: p.legalAccepted.dpa,
        organizationId,
      });
  }
  for (const d of documents)
    if (d.version !== LEGAL_DOCUMENTS[d.document].version)
      throw new DomainError("legal_version_mismatch", 409);
  if (t.previous_owner_stays) {
    // Max 3 at acceptance too (ACC-10, under 931): co-owners who joined during
    // the 72 h window count; the target's own row is about to be 'promoted'.
    const [active] =
      await tx`select count(*)::int as n from organization_co_owners
        where organization_id=${organizationId} and removed_at is null and account_id<>${a.id}`;
    if (active.n >= MAX_CO_OWNERS) throw new DomainError("co_owner_limit", 409);
  }
  const moved =
    await tx`update organizations set created_by_account=${a.id} where id=${organizationId} and created_by_account=${t.from_account_id} returning id`;
  if (!moved.length) throw new DomainError("transfer_unavailable", 403);
  if (documents.length)
    await recordAcceptances(
      tx,
      a,
      { documents, locale: p.locale, context: "transfer" },
      c,
    );
  await tx`update organization_co_owners set removed_at=now(),removed_by=${a.id},removal='promoted'
    where organization_id=${organizationId} and account_id=${a.id} and removed_at is null`;
  const seats = await ensureOwnerSeat(tx, organizationId, a.id, a.name);
  // ACC-15: the previous primary's pending invitations do not outlive the
  // transfer. Leaving: all of them, with the seat (revokeOwnerSeat). Staying
  // as co-owner: their co-owner invitations, a primary-only power (staff
  // invitations stay valid: co-owners may invite staff). Under 931, which
  // acceptInvitation takes before the invitation row.
  let invitationsRevoked: number;
  if (t.previous_owner_stays) {
    await tx`insert into organization_co_owners(id,organization_id,account_id,added_by,source,transfer_id)
      values(${randomUUID()},${organizationId},${t.from_account_id},${a.id},'transfer',${t.id})`;
    const revoked = await tx`update restaurant_invitations set revoked=true
      where tenant_id in (select id from restaurants where organization_id=${organizationId})
        and created_by=${t.from_account_id} and role='co_owner'
        and accepted_by is null and not revoked
      returning id`;
    invitationsRevoked = revoked.length;
  } else
    invitationsRevoked = (
      await revokeOwnerSeat(
        tx,
        organizationId,
        t.from_account_id,
        a.id,
        "transfer",
      )
    ).invitations;
  await tx`update ownership_transfers set state='completed',completed_at=now() where id=${t.id}`;
  for (const [tenantId, employeeId] of Object.entries(seats)) {
    await tx`select set_config('app.tenant_id',${tenantId},true)`;
    await tx`insert into audit(tenant_id,id,actor_id,operation,entity_id,detail) values(${tenantId},${randomUUID()},${employeeId},'account.ownership_transferred',${organizationId},${tx.json({ fromAccountId: t.from_account_id, toAccountId: a.id, previousOwnerStays: t.previous_owner_stays, initiatedBy: t.initiated_by })})`;
  }
  await accountEvent(tx, {
    organizationId,
    actor: a.id,
    subject: t.from_account_id,
    kind: "transfer_completed",
    detail: {
      transferId: t.id,
      initiatedBy: t.initiated_by,
      invitationsRevoked,
    },
  });
  return { organizationId, tenantIds: Object.keys(seats) };
}

const cancelInput = z
  .object({
    transferId: z.uuid().optional(),
    token: z.string().regex(TOKEN).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.token) !== Boolean(v.transferId));
/**
 * The current primary cancels any pending transfer (owner, support or recovery
 * initiated); the target declines its own. Anyone else gets transfer_unavailable.
 */
export async function cancelTransfer(
  tx: Tx,
  a: AccountCtx,
  raw: unknown,
): Promise<{ ok: true }> {
  const p = cancelInput.parse(raw);
  let t: Record<string, any> | undefined;
  if (p.token) t = await liveTransfer(tx, { token: p.token, accountId: a.id });
  else {
    [t] = await tx`select * from ownership_transfers where id=${p.transferId!}`;
    // The primary sees its organizations' transfers once its scope is verified.
    if (!t) {
      const orgs =
        await tx`select id from organizations where created_by_account=${a.id}`;
      for (const o of orgs) {
        await organizationScope(tx, a.id, o.id, "primary");
        [t] =
          await tx`select * from ownership_transfers where id=${p.transferId!} and organization_id=${o.id}`;
        if (t) break;
      }
    }
  }
  if (!t || t.state !== "pending")
    throw new DomainError("transfer_unavailable", 403);
  let by: "owner" | "target" | null = null;
  if ((await organizationRole(tx, a.id, t.organization_id)) === "primary") {
    await organizationScope(tx, a.id, t.organization_id, "primary");
    by = "owner";
  } else if (
    t.to_account_id === a.id ||
    (!t.to_account_id &&
      p.token &&
      t.to_email === (a.verifiedEmail ?? "").trim().toLowerCase())
  )
    by = "target";
  if (!by) throw new DomainError("transfer_unavailable", 403);
  await lockTransfers(tx, t.organization_id);
  const rows =
    await tx`update ownership_transfers set state='canceled',canceled_at=now(),canceled_by=${by}
    where id=${t.id} and state='pending' returning id`;
  if (!rows.length) throw new DomainError("transfer_unavailable", 403);
  await accountEvent(tx, {
    organizationId: t.organization_id,
    actor: a.id,
    subject: by === "owner" ? t.to_account_id : t.from_account_id,
    kind: "transfer_canceled",
    detail: { transferId: t.id, by },
  });
  return { ok: true };
}

// Recovery codes ----------------------------------------------------------------------

/** Crockford base32 (no I, L, O, U). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function crockford(length: number) {
  // 256 is a multiple of 32, so masking each byte keeps the distribution uniform.
  return Array.from(randomBytes(length), (b) => CROCKFORD[b & 31]).join("");
}
/** ABCD-EFGH-JKMN-PQRS-TVWX-YZ23: 8 lookup characters, then a 16-character (80-bit) secret. */
export function formatRecoveryCode(lookup: string, secret: string) {
  return (lookup + secret).match(/.{4}/g)!.join("-");
}
export const RECOVERY_CODE =
  /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/i;

/** Ten single-use codes, shown once; generating new ones revokes the unused old ones. */
export async function generateRecoveryCodes(
  tx: Tx,
  a: AccountCtx,
): Promise<{ codes: string[]; generatedAt: string }> {
  await requireFreshOwnerSession(tx, a.sessionId);
  await tx`update account_recovery_codes set revoked_at=now()
    where account_id=${a.id} and used_at is null and revoked_at is null`;
  const batch = randomUUID();
  const codes: string[] = [];
  for (let n = 0; n < RECOVERY_CODES; n++) {
    const lookup = crockford(8),
      secret = crockford(16);
    await tx`insert into account_recovery_codes(account_id,lookup,secret_hash,batch_id)
      values(${a.id},${lookup},${await hashSecret(secret)},${batch})`;
    codes.push(formatRecoveryCode(lookup, secret));
  }
  const [clock] = await tx`select now() as now`;
  await accountEvent(tx, {
    organizationId: null,
    actor: a.id,
    kind: "recovery_codes_generated",
    detail: { count: RECOVERY_CODES },
  });
  return { codes, generatedAt: (clock.now as Date).toISOString() };
}

const redeemInput = z
  .object({ code: z.string().regex(RECOVERY_CODE) })
  .strict();
/**
 * A new Google account schedules a transfer of the old account's organization
 * (24 h hold). The old primary sees a critical banner and can cancel.
 */
export async function redeemRecoveryCode(
  tx: Tx,
  a: AccountCtx,
  raw: unknown,
): Promise<{
  transferId: string;
  organizationName: string;
  availableAt: string;
}> {
  const p = redeemInput.parse(raw);
  const normalized = p.code.toUpperCase().replace(/-/g, "");
  const lookup = normalized.slice(0, 8),
    secret = normalized.slice(8);
  await tx`select set_config('app.recovery_lookup',${lookup},true)`;
  const [code] =
    await tx`select account_id,secret_hash,used_at,revoked_at from account_recovery_codes where lookup=${lookup}`;
  if (
    !code ||
    code.used_at ||
    code.revoked_at ||
    code.account_id === a.id ||
    !(await secretMatches(secret, code.secret_hash))
  )
    throw new DomainError("recovery_code_invalid", 403);
  await tx`select set_config('app.recovery_account_id',${code.account_id},true)`;
  const [org] =
    await tx`select id,name from organizations where created_by_account=${code.account_id}`;
  if (!org) throw new DomainError("recovery_nothing_to_recover", 409);
  const [owns] =
    await tx`select 1 from organizations where created_by_account=${a.id}`;
  if (owns) throw new DomainError("transfer_target_owns_organization", 409);
  // Verified by the recovery code of the organization's primary.
  await tx`select set_config('app.organization_id',${org.id},true)`;
  await lockTransfers(tx, org.id);
  await closeExpired(tx, org.id);
  const [pending] =
    await tx`select 1 from ownership_transfers where organization_id=${org.id} and state='pending'`;
  if (pending) throw new DomainError("transfer_pending_exists", 409);
  const transferId = randomUUID();
  const used =
    await tx`update account_recovery_codes set used_at=now(),used_by_account=${a.id},used_for_transfer=${transferId}
    where lookup=${lookup} and used_at is null and revoked_at is null returning lookup`;
  if (!used.length) throw new DomainError("recovery_code_invalid", 403);
  const [row] =
    await tx`insert into ownership_transfers(id,organization_id,from_account_id,to_email,to_account_id,
      token_hash,initiated_by,previous_owner_stays,available_at,expires_at)
    values(${transferId},${org.id},${code.account_id},${(a.verifiedEmail ?? a.email).trim().toLowerCase()},${a.id},
      ${hash(randomBytes(32).toString("hex"))},'recovery_code',false,
      now()+make_interval(hours=>${RECOVERY_HOLD_HOURS}),
      now()+make_interval(hours=>${RECOVERY_HOLD_HOURS})+interval '7 days')
    returning available_at`;
  await accountEvent(tx, {
    organizationId: org.id,
    actor: a.id,
    subject: code.account_id,
    kind: "recovery_code_redeemed",
    detail: { transferId },
  });
  return {
    transferId,
    organizationName: org.name,
    availableAt: (row.available_at as Date).toISOString(),
  };
}
