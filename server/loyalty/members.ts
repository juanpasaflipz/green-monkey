import { applyReferral } from "./engagement.js";
/**
 * Club members (038, specs/loyalty-w4.md §2.3, §2.9, §2.11, §4.2). Staff look members up by phone
 * (or by name, ≥ 3 characters, 10 rows, masked phones) and enroll them at the counter with the
 * staff consent attestation; owners and managers see the full detail, rectify (Editar datos),
 * adjust (Ajustar sellos o premios), print the ARCO data sheet and delete (ARCO cancellation).
 * The ARCO paths (list, detail, sheet, Editar datos, the marketing toggle, delete) need no Pro and
 * no club: they stay open while any member's data is held (LOYALTY-PRIVACY-3).
 *
 * Lock order (ARCHITECTURE rows 50 and 51): adjust, update and delete are 1 → 2 → 3 (the member
 * FOR NO KEY UPDATE) → update / ledger insert; enrollment is 1 → 2 → member insert, arbitrated by
 * the partial unique index (no row lock: a unique wait meets only a concurrent enrollment of the
 * same phone). Audit details hold ids, counts and changed field names only; never a name or phone.
 */
import { queueMemberMessage } from "./engagement-events.js";
import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { managers, operators, permit } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { audit, once } from "../orders.js";
import { restaurantPrivacyUrl } from "../account-settings.js";
import { requirePro } from "../entitlements.js";
import { DomainError, type Session } from "../../shared/domain.js";
import {
  cleanName,
  enrollInput,
  enrollmentIssue,
  maskPhone,
  memberAdjustInput,
  memberDeleteInput,
  memberUpdateInput,
  nameKey,
  normalizeRows,
  parsePhone,
  phoneCountry,
  loyaltyCountry,
  type EnrollResult,
  type LedgerRowView,
  type MemberDetail,
  type MemberListResponse,
  type MemberOrderView,
  type MemberSummary,
} from "../../shared/loyalty.js";
import { TO_CONFIRM_NOTE } from "../../shared/loyalty-import.js";
import { loadProgram, requireClub } from "./settings.js";
import { postLedger, summaryOf } from "./ledger.js";
import { z } from "zod";

// ---- per-session lookup budget (§4.2: 60 lookups a minute, loyalty_lookup_limited) ----------

const LOOKUPS_PER_MINUTE = 60;
const lookups = new Map<string, number[]>();
/** Counts one lookup of this session; 429 loyalty_lookup_limited past 60 in a minute. */
export function takeLookup(sessionId: string, now = Date.now()): void {
  const recent = (lookups.get(sessionId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= LOOKUPS_PER_MINUTE) {
    lookups.set(sessionId, recent);
    throw new DomainError("loyalty_lookup_limited", 429);
  }
  recent.push(now);
  lookups.set(sessionId, recent);
  if (lookups.size > 5000)
    for (const [k, v] of lookups)
      if (!v.some((t) => now - t < 60_000)) lookups.delete(k);
}
/** Test hook. */
export function resetLookupBudget() {
  lookups.clear();
}

/** The member row FOR NO KEY UPDATE (LO-3), or loyalty_member_not_found. */
export async function lockMember(tx: Tx, memberId: string) {
  const [m] =
    await tx`select * from loyalty_members where id=${memberId} for no key update`;
  if (!m) throw new DomainError("loyalty_member_not_found", 404);
  return m;
}

const lookupQuery = z
  .object({ phone: z.string().max(40), country: loyaltyCountry })
  .strict();
/** GET /members/lookup: exact phone match; a deleted member has no phone and is never found. */
export async function lookupByPhone(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<MemberSummary | null> {
  permit(s, operators);
  const program = await requireClub(tx);
  const q = lookupQuery.safeParse(raw);
  const phone = q.success ? parsePhone(q.data.phone, q.data.country) : null;
  if (!phone) throw new DomainError("loyalty_invalid_phone", 400);
  takeLookup(s.id);
  const [m] =
    await tx`select id,name,phone_e164,stamps,rewards,redacted_at from loyalty_members where phone_e164=${phone}`;
  return m ? summaryOf(m, program.stampsRequired) : null;
}

const likeEscape = (v: string) => v.replace(/[\\%_]/g, (c) => "\\" + c);
const searchQuery = z.object({ q: z.string().max(60) }).strict();
/** GET /members/search: ≥ 3 characters, prefix matches first, then contains; 10 rows. */
export async function searchByName(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<MemberSummary[]> {
  permit(s, operators);
  const program = await requireClub(tx);
  const parsed = searchQuery.safeParse(raw);
  const key = parsed.success ? nameKey(parsed.data.q) : "";
  if (key.length < 3) return [];
  takeLookup(s.id);
  const k = likeEscape(key);
  const rows = await tx`select id,name,phone_e164,stamps,rewards,redacted_at,
      (name_key like ${k + "%"}) as prefix
    from loyalty_members
    where redacted_at is null and name_key like ${"%" + k + "%"}
    order by prefix desc, name_key, id limit 10`;
  return rows.map((m) => summaryOf(m, program.stampsRequired));
}

/**
 * POST /members (row 51): the counter enrollment. Needs the club on, the restaurant's privacy
 * notice (loyalty_privacy_notice_required) and the staff attestation that the customer heard the
 * notice and agreed. A phone already enrolled returns that member with created:false.
 */
export async function enrollMember(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<EnrollResult> {
  permit(s, operators);
  const parsed = enrollInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("invalid_input", 400);
  const p = parsed.data;
  const issue = enrollmentIssue(p);
  if (issue) throw new DomainError(issue, 400);
  const phone = parsePhone(p.phone, p.country)!;
  const name = cleanName(p.name);
  // The saved result holds ids only (LOYALTY-PRIVACY-1): a replay re-reads the member as it is
  // now, so an ARCO deletion or the retention pass leaves no name or phone in operations.
  const done = await once(tx, s, p.operationId, "loyalty.member.enroll", p, async () => {
    await requireClub(tx);
    const notice = await restaurantPrivacyUrl(tx);
    if (!notice) throw new DomainError("loyalty_privacy_notice_required", 409);
    const memberId = randomUUID();
    const [inserted] = await tx`insert into loyalty_members(tenant_id,id,phone_e164,name,name_key,joined_via,
        joined_by,consent_channel,consent_at,consent_notice_url,marketing_opt_in,marketing_changed_at)
      values(${s.tenantId},${memberId},${phone},${name},${nameKey(name)},'pos',${s.employeeId},
        'staff_attested',now(),${notice},${p.marketingOptIn},${p.marketingOptIn ? new Date() : null})
      on conflict (tenant_id,phone_e164) where phone_e164 is not null do nothing
      returning id,name,phone_e164,stamps,rewards,redacted_at`;
    if (inserted) {
      if (p.referralCode) await applyReferral(tx, s.tenantId, memberId, p.referralCode);
      await queueMemberMessage(tx, s.tenantId, memberId, "welcome", `welcome:${memberId}`);
      await audit(tx, s, "loyalty.member.enrolled", memberId, {
        memberId,
        via: "pos",
        marketingOptIn: p.marketingOptIn,
      });
      return { memberId: inserted.id as string, created: true };
    }
    const [existing] =
      await tx`select id from loyalty_members where phone_e164=${phone}`;
    if (!existing) throw new DomainError("loyalty_retry", 409);
    return { memberId: existing.id as string, created: false };
  });
  return { member: await currentSummary(tx, done.memberId), created: done.created };
}

/** What once() saves for a member command: ids only, never a name or phone (LOYALTY-PRIVACY-1). */
type MemberRef = { memberId: string };

/** The member as staff lists show it, read now (a replay sees a deletion). */
async function currentSummary(tx: Tx, memberId: string): Promise<MemberSummary> {
  const program = await loadProgram(tx);
  const [m] =
    await tx`select id,name,phone_e164,stamps,rewards,redacted_at from loyalty_members where id=${memberId}`;
  if (!m) throw new DomainError("loyalty_member_not_found", 404);
  return summaryOf(m, program.stampsRequired);
}

/** PATCH /members/:id (row 50): Editar datos and the marketing toggle (rectification, opposition). */
export async function updateMember(
  tx: Tx,
  s: Session,
  memberId: string,
  raw: unknown,
): Promise<MemberDetail> {
  permit(s, managers);
  requireRecentAuth(s);
  const parsed = memberUpdateInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("invalid_input", 400);
  const p = parsed.data;
  const name = p.name === undefined ? undefined : cleanName(p.name);
  if (name !== undefined && !name)
    throw new DomainError("loyalty_name_required", 400);
  let phone: string | undefined;
  if (p.phone !== undefined) {
    phone = parsePhone(p.phone, p.country ?? "MX") ?? undefined;
    if (!phone) throw new DomainError("loyalty_invalid_phone", 400);
  }
  await once<MemberRef>(
    tx,
    s,
    p.operationId,
    "loyalty.member.update",
    { memberId, ...p },
    async () => {
      // ARCO rectification and opposition: every plan, club on or off (LOYALTY-PRIVACY-3).
      const m = await lockMember(tx, memberId);
      if (m.redacted_at) throw new DomainError("loyalty_member_deleted", 409);
      if (m.version !== p.expectedVersion)
        throw new DomainError("loyalty_member_changed", 409);
      const fields: string[] = [];
      if (name !== undefined && name !== m.name) fields.push("name");
      if (phone !== undefined && phone !== m.phone_e164) {
        const [taken] =
          await tx`select 1 from loyalty_members where phone_e164=${phone} and id<>${memberId}`;
        if (taken) throw new DomainError("loyalty_phone_taken", 409);
        fields.push("phone");
      }
      if (
        p.marketingOptIn !== undefined &&
        p.marketingOptIn !== m.marketing_opt_in
      )
        fields.push("marketingOptIn");
      if (fields.length) {
        const nextName = fields.includes("name") ? name! : m.name;
        const nextPhone = fields.includes("phone") ? phone! : m.phone_e164;
        const marketing = fields.includes("marketingOptIn")
          ? p.marketingOptIn!
          : m.marketing_opt_in;
        await tx`update loyalty_members set name=${nextName},name_key=${nameKey(nextName)},
            phone_e164=${nextPhone},marketing_opt_in=${marketing},
            marketing_changed_at=${fields.includes("marketingOptIn") ? new Date() : m.marketing_changed_at},
            version=version+1,updated_at=now()
          where id=${memberId}`;
        await audit(tx, s, "loyalty.member.updated", memberId, {
          memberId,
          fields,
        });
      }
      return { memberId };
    },
  );
  return memberDetail(tx, s, memberId);
}


/**
 * POST /members/:id/delete (row 50): ARCO cancellation. Redaction in place (name, phone, notice
 * snapshot, marketing); ledger rows, links and sales stay. Irreversible; balances are frozen.
 */
export async function deleteMember(
  tx: Tx,
  s: Session,
  memberId: string,
  raw: unknown,
): Promise<MemberDetail> {
  permit(s, managers);
  requireRecentAuth(s);
  const parsed = memberDeleteInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("invalid_input", 400);
  const p = parsed.data;
  await once<MemberRef>(
    tx,
    s,
    p.operationId,
    "loyalty.member.delete",
    { memberId, ...p },
    async () => {
      // ARCO cancellation: every plan, club on or off (LOYALTY-PRIVACY-3).
      const m = await lockMember(tx, memberId);
      if (m.redacted_at) throw new DomainError("loyalty_member_deleted", 409);
      if (m.version !== p.expectedVersion)
        throw new DomainError("loyalty_member_changed", 409);
      await tx`update loyalty_members set name='',name_key='',phone_e164=null,consent_notice_url=null,
          marketing_opt_in=false,redacted_at=now(),redacted_by=${s.employeeId},redaction_reason='arco',
          version=version+1,updated_at=now()
        where id=${memberId}`;
      await audit(tx, s, "loyalty.member.deleted", memberId, {
        memberId,
        reason: "arco",
      });
      return { memberId };
    },
  );
  return memberDetail(tx, s, memberId);
}

/**
 * POST /members/:id/adjust (row 50): "Ajustar sellos o premios" with a reason and a note (no
 * personal data). A negative adjustment never takes the card below zero
 * (loyalty_adjust_below_zero) nor rewards below zero (loyalty_no_reward); a full card completes.
 */
export async function adjustMember(
  tx: Tx,
  s: Session,
  memberId: string,
  raw: unknown,
): Promise<MemberDetail> {
  permit(s, managers);
  requireRecentAuth(s);
  const parsed = memberAdjustInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("invalid_input", 400);
  const p = parsed.data;
  await once<MemberRef>(
    tx,
    s,
    p.operationId,
    "loyalty.member.adjust",
    { memberId, ...p },
    async () => {
      // Adjusting balances is the club's (Pro), with the club on or off.
      await requirePro(tx);
      const program = await loadProgram(tx);
      const m = await lockMember(tx, memberId);
      if (m.redacted_at) throw new DomainError("loyalty_member_deleted", 409);
      if (p.stamps < 0 && m.stamps + p.stamps < 0)
        throw new DomainError("loyalty_adjust_below_zero", 409);
      if (m.rewards + p.rewards < 0)
        throw new DomainError("loyalty_no_reward", 409);
      await postLedger(tx, s.tenantId, {
        memberId,
        kind: "adjustment",
        stampsDelta: p.stamps,
        rewardsDelta: p.rewards,
        reason: p.reason,
        note: p.note,
        actorId: s.employeeId,
        operationId: p.operationId,
      });
      for (const r of normalizeRows(
        memberId,
        m.stamps + p.stamps,
        m.rewards + p.rewards,
        program.stampsRequired,
        false,
      ))
        await postLedger(tx, s.tenantId, { ...r, actorId: s.employeeId });
      await audit(tx, s, "loyalty.stamps.adjusted", memberId, {
        memberId,
        stamps: p.stamps,
        rewards: p.rewards,
        reason: p.reason,
      });
      return { memberId };
    },
  );
  return memberDetail(tx, s, memberId);
}

/** Ledger rows of a member, newest first, with the order they belong to and who posted them. */
async function history(
  tx: Tx,
  memberId: string,
  limit: number,
): Promise<LedgerRowView[]> {
  const rows = await tx`select l.id,l.kind,l.stamps_delta,l.rewards_delta,l.order_id,l.discount_id,
      l.reason,l.note,l.created_at,o.number,o.business_date,e.name as actor_name
    from loyalty_ledger l
    left join orders o on o.tenant_id=l.tenant_id and o.id=l.order_id
    left join employees e on e.tenant_id=l.tenant_id and e.id=l.actor_id
    where l.member_id=${memberId}
    order by l.created_at desc,l.id desc limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    stampsDelta: r.stamps_delta,
    rewardsDelta: r.rewards_delta,
    orderId: r.order_id,
    orderNumber: r.number ?? null,
    orderBusinessDate: r.business_date
      ? new Date(r.business_date).toISOString().slice(0, 10)
      : null,
    discountId: r.discount_id,
    reason: r.reason,
    note: r.note,
    actorName: r.actor_name ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

async function memberOrders(
  tx: Tx,
  memberId: string,
  limit: number,
): Promise<MemberOrderView[]> {
  const rows = await tx`select l.order_id,l.linked_at,o.number,o.business_date,o.total,
      coalesce((select sum(x.stamps_delta) from loyalty_ledger x where x.tenant_id=l.tenant_id
        and x.order_id=l.order_id and x.member_id=l.member_id and x.kind in ('earn','earn_reversal')),0)::int as stamps
    from loyalty_order_links l join orders o on o.tenant_id=l.tenant_id and o.id=l.order_id
    where l.member_id=${memberId}
    order by l.linked_at desc limit ${limit}`;
  return rows.map((r) => ({
    orderId: r.order_id,
    number: r.number,
    businessDate: new Date(r.business_date).toISOString().slice(0, 10),
    total: r.total,
    stamps: r.stamps,
    linkedAt: new Date(r.linked_at).toISOString(),
  }));
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** GET /members/:id (managers): the whole member, its history and orders. */
export async function memberDetail(
  tx: Tx,
  s: Session,
  memberId: string,
  limit = 100,
): Promise<MemberDetail> {
  permit(s, managers);
  const program = await loadProgram(tx);
  const [m] = await tx`select m.*,e.name as joined_by_name from loyalty_members m
    left join employees e on e.tenant_id=m.tenant_id and e.id=m.joined_by
    where m.id=${memberId}`;
  if (!m) throw new DomainError("loyalty_member_not_found", 404);
  return {
    ...summaryOf(m, program.stampsRequired),
    name: m.name,
    phone: m.phone_e164,
    country: m.phone_e164 ? phoneCountry(m.phone_e164) : "MX",
    version: m.version,
    joinedAt: iso(m.joined_at)!,
    joinedVia: m.joined_via,
    joinedByName: m.joined_by_name ?? null,
    consentChannel: m.consent_channel,
    consentAt: iso(m.consent_at)!,
    consentNoticeUrl: m.consent_notice_url,
    marketingOptIn: m.marketing_opt_in,
    marketingChangedAt: iso(m.marketing_changed_at),
    lifetimeStamps: m.lifetime_stamps,
    rewardsEarned: m.rewards_earned,
    rewardsRedeemed: m.rewards_redeemed,
    lastVisitAt: iso(m.last_activity_at ?? m.legacy_last_visit_at),
    legacy: m.legacy_source
      ? {
          visits: m.legacy_visits,
          spend: Number(m.legacy_spend),
          lastVisitAt: iso(m.legacy_last_visit_at),
          smsOptIn: m.legacy_sms_opt_in,
        }
      : null,
    redactedAt: iso(m.redacted_at),
    redactionReason: m.redaction_reason,
    history: await history(tx, memberId, limit),
    orders: await memberOrders(tx, memberId, limit),
  };
}

/** GET /members/:id/sheet (managers, step-up): the printable ARCO access sheet, all history. */
export async function memberDataSheet(
  tx: Tx,
  s: Session,
  memberId: string,
): Promise<MemberDetail> {
  permit(s, managers);
  requireRecentAuth(s);
  return memberDetail(tx, s, memberId, 1000);
}

const listQuery = z
  .object({
    cursor: z.string().max(200).optional(),
    q: z.string().max(60).optional(),
    filter: z.enum(["rewards", "imported", "to_confirm"]).optional(),
  })
  .strict();
const PAGE = 50;
/**
 * GET /members (managers): Clientes. Deleted members are not listed. Keyset paging on
 * (coalesce(last_activity_at, legacy_last_visit_at, joined_at) desc, id).
 */
export async function listMembers(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<MemberListResponse> {
  permit(s, managers);
  const parsed = listQuery.safeParse(raw ?? {});
  if (!parsed.success) throw new DomainError("invalid_input", 400);
  const p = parsed.data;
  const program = await loadProgram(tx);
  let after: { a: string; i: string } | null = null;
  if (p.cursor)
    try {
      const c = JSON.parse(Buffer.from(p.cursor, "base64url").toString());
      if (typeof c?.a === "string" && z.string().uuid().safeParse(c?.i).success)
        after = { a: new Date(c.a).toISOString(), i: c.i };
    } catch {
      after = null;
    }
  const q = (p.q ?? "").trim();
  const digits = q.replace(/[^0-9]/g, "");
  const byPhone = /^[0-9\s+()-]+$/.test(q) && digits.length >= 3;
  const key = byPhone ? "" : nameKey(q);
  const rows = await tx`select id,name,phone_e164,stamps,rewards,redacted_at,joined_at,legacy_source,
      coalesce(last_activity_at, legacy_last_visit_at) as last_visit,
      coalesce(last_activity_at, legacy_last_visit_at, joined_at) as activity
    from loyalty_members
    where redacted_at is null
      ${byPhone ? tx`and phone_e164 like ${"%" + likeEscape(digits) + "%"}` : tx``}
      ${!byPhone && key.length >= 1 ? tx`and name_key like ${"%" + likeEscape(key) + "%"}` : tx``}
      ${p.filter === "rewards" ? tx`and rewards > 0` : tx``}
      ${p.filter === "imported" ? tx`and legacy_source is not null` : tx``}
      ${
        // Imported with pos-lite cards to confirm, not yet settled with Ajustar › Saldo de POS
        // Lite (LOYALTY-OPS-2): the dates are on the member's import row.
        p.filter === "to_confirm"
          ? tx`and exists (select 1 from loyalty_ledger l where l.tenant_id=loyalty_members.tenant_id
                and l.member_id=loyalty_members.id and l.kind='import' and l.note like ${TO_CONFIRM_NOTE + "%"})
              and not exists (select 1 from loyalty_ledger a where a.tenant_id=loyalty_members.tenant_id
                and a.member_id=loyalty_members.id and a.kind='adjustment' and a.reason='pos_lite_balance')`
          : tx``
      }
      ${after ? tx`and (coalesce(last_activity_at, legacy_last_visit_at, joined_at), id) < (${after.a}::timestamptz, ${after.i}::uuid)` : tx``}
    order by coalesce(last_activity_at, legacy_last_visit_at, joined_at) desc, id desc
    limit ${PAGE + 1}`;
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  return {
    rows: page.map((m) => ({
      ...summaryOf(m, program.stampsRequired),
      name: m.name,
      maskedPhone: maskPhone(m.phone_e164),
      lastVisitAt: iso(m.last_visit),
      joinedAt: iso(m.joined_at)!,
      imported: !!m.legacy_source,
    })),
    nextCursor:
      rows.length > PAGE && last
        ? Buffer.from(
            JSON.stringify({ a: iso(last.activity), i: last.id }),
          ).toString("base64url")
        : null,
  };
}
