import { z } from "zod";
import type { Tx } from "./db.js";
import { hash } from "./auth.js";
import {
  MAX_CO_OWNERS,
  freshOwnerSession,
  organizationScope,
  type AccountCtx,
  type OrgRole,
} from "./co-owners.js";
import { fromName, maskEmail } from "./ownership-transfer.js";
import { legalState, type LegalConfig, type LegalState } from "./legal.js";
import { getTaxProfile, type TaxProfile } from "./tax-profile.js";
import type { SaasTaxConfig } from "./saas-tax.js";
import { freeSelectionMode, sellingAccess } from "./free-limits.js";
import { DomainError, type Session } from "../shared/domain.js";
import { acceptancePending } from "../shared/legal.js";
import { planNotice, type PlanNotice } from "../shared/plan-notice.js";

/** The account console (GET /api/auth/account-center), one transaction. */
export type AccountOverview = {
  account: { id: string; email: string; name: string };
  legal: LegalState;
  freshSession: boolean;
  organizations: Array<{
    id: string;
    name: string;
    role: OrgRole;
    primary: { name: string | null; email: string | null; isMe: boolean };
    coOwners: Array<{
      accountId: string;
      name: string;
      email: string;
      addedAt: string;
    }>;
    coOwnerLimit: number;
    pendingCoOwnerInvitations: Array<{
      id: string;
      email: string;
      expiresAt: string;
    }>;
    dpa: {
      version: string | null;
      acceptedAt: string | null;
      pending: boolean;
    };
    transfer: {
      id: string;
      state: "pending";
      initiatedBy: string;
      toEmailMasked: string;
      availableAt: string;
      expiresAt: string;
      previousOwnerStays: boolean;
      path: null;
    } | null;
    supportActions: Array<{
      action: string;
      ticket: string;
      createdAt: string;
    }>;
    events: Array<{
      kind: string;
      actorName: string | null;
      subjectName: string | null;
      createdAt: string;
    }>;
    taxProfile: TaxProfile | null | "disabled";
  }>;
  incomingTransfers: Array<{
    id: string;
    organizationName: string;
    fromName: string | null;
    initiatedBy: string;
    availableAt: string;
    expiresAt: string;
  }>;
  recoveryCodes: { remaining: number; generatedAt: string | null };
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function accountOverview(
  tx: Tx,
  a: AccountCtx,
  legal: LegalConfig,
  tax: SaasTaxConfig,
): Promise<AccountOverview> {
  const legalNow = await legalState(tx, a.id, legal);
  const freshSession = await freshOwnerSession(tx, a.sessionId);
  const orgRows =
    await tx`select o.id,o.name,'primary'::text as role from organizations o where o.created_by_account=${a.id}
    union all
    select o.id,o.name,'co_owner'::text as role from organization_co_owners c
      join organizations o on o.id=c.organization_id
     where c.account_id=${a.id} and c.removed_at is null
    order by role desc, name`;
  const organizations: AccountOverview["organizations"] = [];
  for (const o of orgRows) {
    const role = await organizationScope(tx, a.id, o.id, "owner");
    const [primary] = await tx`select a.id,a.name,a.email from organizations o
        left join owner_accounts a on a.id=o.created_by_account
      where o.id=${o.id}`;
    const coOwners =
      await tx`select c.account_id,a.name,a.email,c.added_at from organization_co_owners c
        join owner_accounts a on a.id=c.account_id
      where c.organization_id=${o.id} and c.removed_at is null order by c.added_at`;
    const invitations =
      await tx`select i.id,i.email,i.expires_at from restaurant_invitations i
        join restaurants r on r.id=i.tenant_id
      where r.organization_id=${o.id} and i.role='co_owner' and not i.revoked
        and i.accepted_by is null and i.expires_at>now() order by i.created_at`;
    const [dpa] =
      await tx`select version,entity_hash,published,accepted_at from legal_acceptances
      where organization_id=${o.id} and document='dpa' order by accepted_at desc, id limit 1`;
    const [transfer] = await tx`select * from ownership_transfers
      where organization_id=${o.id} and state='pending' and expires_at>now()`;
    const support =
      await tx`select action,ticket,created_at from support_actions
      where organization_id=${o.id} order by created_at desc limit 20`;
    const events =
      await tx`select e.kind,e.created_at,actor.name as actor_name,subject.name as subject_name
        from account_events e
        left join owner_accounts actor on actor.id=e.actor_account_id
        left join owner_accounts subject on subject.id=e.subject_account_id
      where e.organization_id=${o.id} order by e.created_at desc, e.id limit 50`;
    organizations.push({
      id: o.id,
      name: o.name,
      role,
      primary: {
        name: primary?.name ?? null,
        email: primary?.email ?? null,
        isMe: primary?.id === a.id,
      },
      coOwners: coOwners.map((c) => ({
        accountId: c.account_id,
        name: c.name,
        email: c.email,
        addedAt: iso(c.added_at)!,
      })),
      coOwnerLimit: MAX_CO_OWNERS,
      pendingCoOwnerInvitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        expiresAt: iso(i.expires_at)!,
      })),
      dpa: {
        version: dpa?.version ?? null,
        acceptedAt: iso(dpa?.accepted_at),
        pending: acceptancePending(
          "dpa",
          dpa && {
            version: dpa.version,
            entityHash: dpa.entity_hash,
            published: dpa.published,
          },
          { status: legal.status, entityHash: legal.entityHash },
        ),
      },
      transfer: transfer
        ? {
            id: transfer.id,
            state: "pending",
            initiatedBy: transfer.initiated_by,
            toEmailMasked: maskEmail(transfer.to_email),
            availableAt: iso(transfer.available_at)!,
            expiresAt: iso(transfer.expires_at)!,
            previousOwnerStays: transfer.previous_owner_stays,
            // The token is not recoverable from its hash: shown only once, at creation.
            path: null,
          }
        : null,
      supportActions: support.map((s) => ({
        action: s.action,
        ticket: s.ticket,
        createdAt: iso(s.created_at)!,
      })),
      events: events.map((e) => ({
        kind: e.kind,
        actorName: e.actor_name ?? null,
        subjectName: e.subject_name ?? null,
        createdAt: iso(e.created_at)!,
      })),
      taxProfile: tax.taxProfileEnabled
        ? await getTaxProfile(tx, a, o.id, tax)
        : "disabled",
    });
  }
  const incoming = await tx`select * from ownership_transfers
    where to_account_id=${a.id} and state='pending' and expires_at>now() order by created_at`;
  const incomingTransfers: AccountOverview["incomingTransfers"] = [];
  for (const t of incoming) {
    // Verified by to_account_id: the target may read the offered organization.
    await tx`select set_config('app.organization_id',${t.organization_id},true)`;
    const [org] =
      await tx`select name from organizations where id=${t.organization_id}`;
    incomingTransfers.push({
      id: t.id,
      organizationName: org?.name ?? "",
      fromName: await fromName(tx, t.organization_id, t.from_account_id),
      initiatedBy: t.initiated_by,
      availableAt: iso(t.available_at)!,
      expiresAt: iso(t.expires_at)!,
    });
  }
  const [codes] = await tx`select
      count(*) filter (where used_at is null and revoked_at is null)::int as remaining,
      max(created_at) filter (where revoked_at is null or used_at is not null) as generated_at
    from account_recovery_codes where account_id=${a.id}`;
  return {
    account: { id: a.id, email: a.email, name: a.name },
    legal: legalNow,
    freshSession,
    organizations,
    incomingTransfers,
    recoveryCodes: {
      remaining: codes?.remaining ?? 0,
      generatedAt: codes?.remaining ? iso(codes.generated_at) : null,
    },
  };
}

const previewInput = z
  .object({ token: z.string().regex(/^[a-f0-9-]{36}\.[a-f0-9]{64}$/) })
  .strict();
/** What an invitation offers, before accepting (staff or co-owner). */
export async function previewInvitation(tx: Tx, a: AccountCtx, raw: unknown) {
  const { token } = previewInput.parse(raw);
  await tx`select set_config('app.invitation_hash',${hash(token)},true)`;
  const [i] =
    await tx`select *,expires_at>now() as valid from restaurant_invitations where token_hash=${hash(token)}`;
  if (!i || i.revoked || !i.valid || (i.accepted_by && i.accepted_by !== a.id))
    throw new DomainError("invitation_unavailable", 403);
  await tx`select set_config('app.tenant_id',${i.tenant_id},true)`;
  const [r] =
    await tx`select r.name,o.name as organization_name from restaurants r
      left join organizations o on o.id=r.organization_id
    where r.id=${i.tenant_id}`;
  return {
    role: i.role as string,
    restaurantName: r?.name ?? "",
    organizationName: r?.organization_name ?? r?.name ?? "",
    expiresAt: iso(i.expires_at)!,
    emailMatches: i.email === (a.verifiedEmail ?? "").trim().toLowerCase(),
  };
}

export type ShellState = {
  plan: "free" | "pro";
  status: string;
  accessUntil: string | null;
  source: string | null;
  notice: PlanNotice | null;
  selling: {
    allowed: boolean;
    basis: string;
    continuationUntil: string | null;
  };
  freeSelection: {
    deviceName: string | null;
    thisDevice: boolean;
    mode: "auto" | "manual";
  };
  account: null | {
    legalPending: boolean;
    transfers: Array<{
      id: string;
      initiatedBy: string;
      toEmailMasked: string;
      availableAt: string;
      organizationName: string;
    }>;
    supportActions: Array<{ action: string; createdAt: string }>;
  };
};

/**
 * GET /api/account/shell: plan notices for the POS shell (any role; the client
 * does not poll for kitchen). The owner block needs a Google-entered session.
 */
export async function shellState(
  tx: Tx,
  s: Session,
  legal: LegalConfig,
): Promise<ShellState> {
  const access = await sellingAccess(tx, s.employeeId, s.deviceId);
  const e = access.entitlement;
  const [clock] = await tx`select clock_timestamp() as now`;
  const [slot] =
    await tx`select id,name from devices where free_slot is not null`;
  return {
    plan: e.plan,
    status: e.status,
    accessUntil: e.accessUntil,
    source: e.source,
    notice: planNotice(
      {
        plan: e.plan,
        status: e.status,
        accessUntil: e.accessUntil,
        source: e.source,
      },
      access,
      (clock.now as Date).getTime(),
    ),
    selling: {
      allowed: access.allowed,
      basis: access.basis,
      continuationUntil: access.continuationUntil,
    },
    freeSelection: {
      deviceName: slot?.name ?? null,
      thisDevice: slot?.id === s.deviceId,
      mode: await freeSelectionMode(tx),
    },
    account: s.role === "owner" ? await ownerShell(tx, s, legal) : null,
  };
}

async function ownerShell(
  tx: Tx,
  s: Session,
  legal: LegalConfig,
): Promise<ShellState["account"]> {
  const [session] =
    await tx`select owner_account_id from sessions where id=${s.id}`;
  if (!session?.owner_account_id) return null;
  const accountId: string = session.owner_account_id;
  await tx`select set_config('app.account_id',${accountId},true)`;
  const [r] =
    await tx`select organization_id from restaurants where id=${s.tenantId}`;
  let role: OrgRole;
  try {
    role = await organizationScope(tx, accountId, r.organization_id, "owner");
  } catch {
    return null;
  }
  const state = await legalState(tx, accountId, legal);
  const transfers =
    role === "primary"
      ? await tx`select t.id,t.initiated_by,t.to_email,t.available_at,o.name as organization_name
          from ownership_transfers t join organizations o on o.id=t.organization_id
          where t.organization_id=${r.organization_id} and t.state='pending' and t.expires_at>now()`
      : [];
  const support = await tx`select action,created_at from support_actions
    where organization_id=${r.organization_id} and created_at>now()-interval '7 days'
    order by created_at desc limit 5`;
  return {
    legalPending: Boolean(state.pending.length || state.dpaPending.length),
    transfers: transfers.map((t) => ({
      id: t.id,
      initiatedBy: t.initiated_by,
      toEmailMasked: maskEmail(t.to_email),
      availableAt: iso(t.available_at)!,
      organizationName: t.organization_name,
    })),
    supportActions: support.map((x) => ({
      action: x.action,
      createdAt: iso(x.created_at)!,
    })),
  };
}
