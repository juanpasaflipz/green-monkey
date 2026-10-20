/**
 * The receipt's join QR and the /club page (038, specs/loyalty-w4.md §2.7). Pre-auth: the tenant
 * comes from the sealed "loyalty-join" token {t, o} (opaque ids only), which travels in the URL
 * fragment and the x-gm-join-token header, never in a path. GET never returns member data; POST
 * returns counts only, never the stored name, and never overwrites an existing member's name.
 * Each order is claimable once: the first phone wins, and an order that already has a link answers
 * loyalty_order_linked to every phone, the claimant's included, so a receipt never tells whether
 * a given phone claimed it (LOYALTY-PRIVACY-2; "Esta compra ya sumó sellos.").
 *
 * Lock order (ARCHITECTURE row 47, join path; no once()): member insert-or-select → 3 (the members
 * of the order plus this one, sorted, FOR NO KEY UPDATE) → 5 (orders FOR SHARE) → link insert (ON
 * CONFLICT: a concurrent claim that committed first is loyalty_order_linked, never a 23505) →
 * reconcile inline with the members held.
 */
import { queueMemberMessage } from "./engagement-events.js";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { tenant, type Tx } from "../db.js";
import { entitlement } from "../entitlements.js";
import { restaurantPrivacyUrl } from "../account-settings.js";
import { unsealOrExpired } from "../tokens.js";
import { DomainError } from "../../shared/domain.js";
import {
  cleanName,
  enrollmentIssue,
  joinInput,
  nameKey,
  parsePhone,
  programTitle,
  type JoinResult,
  type JoinView,
} from "../../shared/loyalty.js";
import { loadProgram, type Program } from "./settings.js";
import { reconcileOrderHeld } from "./ledger.js";
import {
  assertEligible,
  assertHeld,
  lockMembers,
  orderMemberIds,
  shareOrder,
  windowClosed,
} from "./links.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The token's tenant and order: 401 for a bad token, 410 loyalty_join_expired for an old one. */
export function joinClaims(token: string): { tenantId: string; orderId: string } {
  const c = unsealOrExpired<{ t?: unknown; o?: unknown }>(
    "loyalty-join",
    token,
    "loyalty_join_expired",
  );
  if (
    typeof c?.t !== "string" ||
    typeof c?.o !== "string" ||
    !UUID.test(c.t) ||
    !UUID.test(c.o)
  )
    throw new DomainError("unauthorized", 401);
  return { tenantId: c.t, orderId: c.o };
}

/** The club must be on and the plan Pro, else loyalty_join_unavailable (404). */
async function availableProgram(tx: Tx): Promise<Program> {
  const p = await loadProgram(tx);
  if (!p.enabled || (await entitlement(tx)).plan !== "pro")
    throw new DomainError("loyalty_join_unavailable", 404);
  return p;
}

/** GET /api/club/join. */
export async function joinView(
  sql: postgres.Sql,
  token: string,
): Promise<JoinView> {
  const { tenantId, orderId } = joinClaims(token);
  return tenant(sql, tenantId, async (tx) => {
    const p = await availableProgram(tx);
    const [o] = await tx`select o.number,o.business_date,r.name as restaurant,
        exists (select 1 from loyalty_order_links l where l.tenant_id=o.tenant_id and l.order_id=o.id
                and l.member_id is not null) as linked
      from orders o join restaurants r on r.id=o.tenant_id where o.id=${orderId}`;
    // A genuine token names an order of its tenant; anything else is not a receipt of ours.
    if (!o) throw new DomainError("unauthorized", 401);
    return {
      restaurantName: o.restaurant,
      programName: programTitle(p.programName, o.restaurant),
      orderNumber: o.number,
      businessDate: new Date(o.business_date).toISOString().slice(0, 10),
      stampsRequired: p.stampsRequired,
      rewardDescription: p.rewardDescription,
      privacyUrl: await restaurantPrivacyUrl(tx),
      linked: o.linked,
    };
  });
}

/** POST /api/club/join. */
export async function joinOrder(
  sql: postgres.Sql,
  token: string,
  raw: unknown,
): Promise<JoinResult> {
  const { tenantId, orderId } = joinClaims(token);
  const parsed = joinInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("invalid_input", 400);
  const b = parsed.data;
  const issue = enrollmentIssue({
    phone: b.phone,
    country: b.country,
    name: b.name,
    consent: b.privacyAccepted,
  });
  if (issue) throw new DomainError(issue, 400);
  const phone = parsePhone(b.phone, b.country)!;
  const name = cleanName(b.name);
  return tenant(sql, tenantId, async (tx) => {
    const p = await availableProgram(tx);
    const [exists] = await tx`select id from orders where id=${orderId}`;
    if (!exists) throw new DomainError("unauthorized", 401);
    const notice = await restaurantPrivacyUrl(tx);
    if (!notice) throw new DomainError("loyalty_privacy_notice_required", 409);
    // Member insert-or-select: an existing member's name is never overwritten from this page.
    const [enrolled] = await tx`insert into loyalty_members(tenant_id,id,phone_e164,name,name_key,joined_via,
        consent_channel,consent_at,consent_notice_url,marketing_opt_in,marketing_changed_at)
      values(${tenantId},${randomUUID()},${phone},${name},${nameKey(name)},'join_qr',
        'self_service',now(),${notice},${b.marketingOptIn},${b.marketingOptIn ? new Date() : null})
      on conflict (tenant_id,phone_e164) where phone_e164 is not null do nothing returning id`;
    if (enrolled) await queueMemberMessage(tx, tenantId, enrolled.id, "welcome", `welcome:${enrolled.id}`);
    const [member] =
      await tx`select id from loyalty_members where phone_e164=${phone}`;
    if (!member) throw new DomainError("loyalty_retry", 409);
    const ids = await orderMemberIds(tx, orderId, [member.id]);
    await lockMembers(tx, ids);
    const o = await shareOrder(tx, orderId);
    assertEligible(o);
    // Any link (this phone's, another's or a removed one) is the same answer for every phone.
    if (await assertHeld(tx, orderId, ids))
      throw new DomainError("loyalty_order_linked", 409);
    if (windowClosed(o, p)) throw new DomainError("loyalty_join_expired", 410);
    // Two phones (or the cashier's "Usar") racing on one order hold disjoint members and share the
    // order: the later insert waits on the first's key, then finds it (LOYALTY-CONCURRENCY-3).
    const [inserted] =
      await tx`insert into loyalty_order_links(tenant_id,order_id,member_id,via,linked_by)
        values(${tenantId},${orderId},${member.id},'join_qr',null)
        on conflict (tenant_id,order_id) do nothing returning member_id`;
    if (!inserted) throw new DomainError("loyalty_order_linked", 409);
    const view = await reconcileOrderHeld(tx, tenantId, orderId, ids);
    return {
      stampsAdded: view.earned,
      stamps: view.member?.stamps ?? 0,
      required: p.stampsRequired,
      rewards: view.member?.rewards ?? 0,
      completed: view.completed,
      pending: !view.settled,
    };
  });
}
