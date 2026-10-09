/**
 * Order links (038, specs/loyalty-w4.md §2.5, §4.3): at most one member per order, for life.
 *
 * Lock order (ARCHITECTURE row 47, LO-R10): 1 → 2 → 3 (every member the command may post for: the
 * new member, the order's linked member and every member already posted on the order, sorted, one
 * statement FOR NO KEY UPDATE) → 5 (the orders row FOR SHARE, which closes the link-vs-settle
 * race: either the payment waits and its settle hook sees the link, or the link waits and reads
 * the settled state) → link insert/update → reconcileOrder inline with the members already held
 * (a set that changed in between is loyalty_retry, never a member lock after the order's).
 * Nothing later in the transaction locks orders for update.
 */
import type { Tx } from "../db.js";
import { managers, operators, permit } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { audit, once } from "../orders.js";
import { requirePro } from "../entitlements.js";
import { seal } from "../tokens.js";
import { DomainError, type Session } from "../../shared/domain.js";
import {
  orderChangeInput,
  orderLinkInput,
  programTitle,
  type OrderLoyaltyView,
  type ReceiptLoyaltyView,
} from "../../shared/loyalty.js";
import { loadProgram, requireClub, type Program } from "./settings.js";
import {
  isSettled,
  orderLoyaltyView,
  reconcileOrderHeld,
} from "./ledger.js";

/** The members a link command may post for, read before the lock (plain reads). */
export async function orderMemberIds(tx: Tx, orderId: string, extra: (string | null)[]) {
  const [link] =
    await tx`select member_id from loyalty_order_links where order_id=${orderId}`;
  const posted =
    await tx`select distinct member_id from loyalty_ledger where order_id=${orderId}
      and kind in ('earn','earn_reversal','reward_redeemed','reward_restored')`;
  return [
    ...new Set(
      [link?.member_id, ...posted.map((r) => r.member_id), ...extra].filter(
        (x): x is string => !!x,
      ),
    ),
  ].sort();
}

/** LO-3: the member rows, sorted, one statement. Returns the rows by id. */
export async function lockMembers(tx: Tx, ids: string[]) {
  const rows = ids.length
    ? await tx`select id,redacted_at from loyalty_members
        where id = any(${tx.array(ids)}::uuid[]) order by id for no key update`
    : [];
  return new Map(rows.map((r) => [r.id as string, r]));
}

/** LO-5: the order FOR SHARE with what the link rules need. */
export async function shareOrder(tx: Tx, orderId: string) {
  const [o] =
    await tx`select id,state,check_state,close_reason,closed_at,created_at from orders where id=${orderId} for share`;
  if (!o) throw new DomainError("not_found", 404);
  const [t] =
    await tx`select max(created_at) as last_tender_at from tenders where order_id=${orderId}`;
  return { ...o, last_tender_at: t.last_tender_at };
}

/** Recovery, cancelled and voided orders never take a member. */
export function assertEligible(o: Record<string, any>) {
  if (
    String(o.state).startsWith("recovery") ||
    o.state === "cancelled" ||
    (o.check_state === "closed" && !isSettled(o))
  )
    throw new DomainError("loyalty_order_not_eligible", 409);
}

/** Settled more than link_window_days ago (by the order's last tender) is past the window. */
export function windowClosed(o: Record<string, any>, p: Program, now = Date.now()) {
  if (!isSettled(o)) return false;
  const at = new Date(o.last_tender_at ?? o.closed_at ?? o.created_at).getTime();
  return now > at + p.linkWindowDays * 86_400_000;
}

/** After the member and order locks: the link and the posted members are still the ones held. */
export async function assertHeld(tx: Tx, orderId: string, held: string[]) {
  const now = await orderMemberIds(tx, orderId, []);
  if (now.some((m) => !held.includes(m)))
    throw new DomainError("loyalty_retry", 409);
  const [link] =
    await tx`select member_id,via from loyalty_order_links where order_id=${orderId}`;
  return link as { member_id: string | null; via: string } | undefined;
}

/**
 * POST /orders/:orderId/member (row 47): "Usar" in Vender, "Agregar cliente" in Detalle and Mesas.
 * The same member again replays the view; another member is loyalty_order_linked; a removed link
 * takes the member. Linking a settled order reconciles inline (stamps post once).
 */
export async function linkOrderMember(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
): Promise<OrderLoyaltyView> {
  permit(s, operators);
  const parsed = orderLinkInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("invalid_input", 400);
  const p = parsed.data;
  return once(
    tx,
    s,
    p.operationId,
    "loyalty.order.link",
    { orderId, ...p },
    async () => {
      const program = await requireClub(tx);
      const ids = await orderMemberIds(tx, orderId, [p.memberId]);
      const members = await lockMembers(tx, ids);
      const member = members.get(p.memberId);
      if (!member) throw new DomainError("loyalty_member_not_found", 404);
      if (member.redacted_at)
        throw new DomainError("loyalty_member_deleted", 409);
      const o = await shareOrder(tx, orderId);
      assertEligible(o);
      const link = await assertHeld(tx, orderId, ids);
      if (link?.member_id === p.memberId)
        return orderLoyaltyView(tx, orderId, program);
      if (link?.member_id) throw new DomainError("loyalty_order_linked", 409);
      if (windowClosed(o, program))
        throw new DomainError("loyalty_link_window_closed", 409);
      if (link)
        await tx`update loyalty_order_links set member_id=${p.memberId},changed_at=clock_timestamp(),
            changed_by=${s.employeeId} where order_id=${orderId}`;
      else {
        const [inserted] =
          await tx`insert into loyalty_order_links(tenant_id,order_id,member_id,via,linked_by)
            values(${s.tenantId},${orderId},${p.memberId},'pos',${s.employeeId})
            on conflict (tenant_id,order_id) do nothing returning member_id`;
        if (!inserted) throw new DomainError("loyalty_retry", 409);
      }
      await audit(tx, s, "loyalty.order.linked", orderId, {
        orderId,
        memberId: p.memberId,
        via: "pos",
      });
      return reconcileOrderHeld(tx, s.tenantId, orderId, ids);
    },
  );
}

/**
 * PUT /orders/:orderId/member (row 47): "Cambiar cliente" / "Quitar cliente". Staff while nothing
 * is posted on the order and it is not settled; owner or manager with step-up otherwise. Moves
 * the stamps (reversal for the old member, earn for the new one) through the reconcile.
 */
export async function changeOrderMember(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
): Promise<OrderLoyaltyView> {
  permit(s, operators);
  const parsed = orderChangeInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("invalid_input", 400);
  const p = parsed.data;
  return once(
    tx,
    s,
    p.operationId,
    "loyalty.order.change",
    { orderId, ...p },
    async () => {
      const program = await requireClub(tx);
      const ids = await orderMemberIds(tx, orderId, [p.memberId]);
      const members = await lockMembers(tx, ids);
      if (p.memberId) {
        const member = members.get(p.memberId);
        if (!member) throw new DomainError("loyalty_member_not_found", 404);
        if (member.redacted_at)
          throw new DomainError("loyalty_member_deleted", 409);
      }
      const o = await shareOrder(tx, orderId);
      assertEligible(o);
      const link = await assertHeld(tx, orderId, ids);
      const current = link?.member_id ?? null;
      if (current !== p.expectedMemberId)
        throw new DomainError("loyalty_order_linked", 409);
      if (current === p.memberId) return orderLoyaltyView(tx, orderId, program);
      const [posted] =
        await tx`select count(*)::int as n from loyalty_ledger where order_id=${orderId}
          and kind in ('earn','earn_reversal')`;
      if (posted.n > 0 || isSettled(o)) {
        // Stamps move: an owner or manager decides, with a recent PIN.
        permit(s, managers);
        requireRecentAuth(s);
      }
      if (p.memberId && windowClosed(o, program))
        throw new DomainError("loyalty_link_window_closed", 409);
      if (link)
        await tx`update loyalty_order_links set member_id=${p.memberId},changed_at=clock_timestamp(),
            changed_by=${s.employeeId} where order_id=${orderId}`;
      else if (p.memberId) {
        const [inserted] =
          await tx`insert into loyalty_order_links(tenant_id,order_id,member_id,via,linked_by)
            values(${s.tenantId},${orderId},${p.memberId},'pos',${s.employeeId})
            on conflict (tenant_id,order_id) do nothing returning member_id`;
        if (!inserted) throw new DomainError("loyalty_retry", 409);
      }
      await audit(tx, s, "loyalty.order.relinked", orderId, {
        orderId,
        from: current,
        to: p.memberId,
      });
      return reconcileOrderHeld(tx, s.tenantId, orderId, ids);
    },
  );
}

/**
 * Kiosk (039, R23): links the member the diner identified, right after createOrder inside
 * kioskAccept and the hold settler, before any tender or refresh, so the settle hook sees the
 * link. One insert (row 54): no member lock, no ledger write; the foreign keys take FOR KEY SHARE
 * on the member and the order, which LO-R10 never blocks. A link already present is kept.
 */
export async function linkFromKiosk(
  tx: Tx,
  s: Pick<Session, "tenantId">,
  orderId: string,
  memberId: string,
): Promise<void> {
  await tx`insert into loyalty_order_links(tenant_id,order_id,member_id,via,linked_by)
    values(${s.tenantId},${orderId},${memberId},'kiosk',null)
    on conflict (tenant_id,order_id) do nothing`;
}

/** GET /orders/:orderId (operators): the Detalle de orden / Mesas panel. */
export async function getOrderLoyalty(
  tx: Tx,
  s: Session,
  orderId: string,
): Promise<OrderLoyaltyView> {
  permit(s, operators);
  const program = await requireClub(tx);
  return orderLoyaltyView(tx, orderId, program);
}

/** POST /orders/:orderId/reconcile (operators, row 49): Vender's call after a payment. */
export async function reconcileOrderRoute(
  tx: Tx,
  s: Session,
  orderId: string,
): Promise<OrderLoyaltyView> {
  permit(s, operators);
  await requireClub(tx);
  const [o] = await tx`select id from orders where id=${orderId}`;
  if (!o) throw new DomainError("not_found", 404);
  return reconcileOrderHeld(tx, s.tenantId, orderId, null);
}

/**
 * GET /orders/:orderId/receipt (operators): the receipt's club block. A linked order prints the
 * member's counts (no name, no phone); an unlinked one within its window prints the join QR,
 * whose token is minted here (opaque ids only, TTL link_window_days).
 */
export async function receiptLoyalty(
  tx: Tx,
  s: Session,
  orderId: string,
): Promise<ReceiptLoyaltyView> {
  permit(s, operators);
  const program = await loadProgram(tx);
  if (!program.enabled) return { kind: "none" };
  try {
    await requirePro(tx);
  } catch {
    return { kind: "none" };
  }
  const name = programTitle(program.programName, s.restaurant.name);
  const view = await orderLoyaltyView(tx, orderId, program);
  if (view.member && !view.member.deleted)
    return {
      kind: "member",
      programName: name,
      stamps: view.member.stamps,
      required: view.member.required,
      rewards: view.member.rewards,
      rewardDescription: program.rewardDescription,
    };
  if (!program.receiptJoinQr || view.member || !view.linkable)
    return { kind: "none" };
  return {
    kind: "join",
    token: joinToken(s.tenantId, orderId, program),
    programName: name,
    stampsRequired: program.stampsRequired,
    rewardDescription: program.rewardDescription,
  };
}

/** The receipt's (and kiosk's) join token: {t, o}, valid link_window_days. */
export function joinToken(tenantId: string, orderId: string, p: Program) {
  return seal(
    "loyalty-join",
    { t: tenantId, o: orderId },
    { ttlSeconds: p.linkWindowDays * 86400 },
  );
}

/**
 * Kiosk (039, R23 joinOffer): the /club URL of an order within its window, or null. Uses the same
 * loyalty-join token as receipts.
 */
export async function joinUrlForOrder(
  tx: Tx,
  orderId: string,
): Promise<{ url: string; expiresAt: string } | null> {
  const program = await loadProgram(tx);
  if (!program.enabled) return null;
  const view = await orderLoyaltyView(tx, orderId, program);
  if (view.member || !view.linkable) return null;
  const [r] =
    await tx`select tenant_id from orders where id=${orderId}`;
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  return {
    url: `${base}/club#${joinToken(r.tenant_id, orderId, program)}`,
    expiresAt: new Date(
      Date.now() + program.linkWindowDays * 86_400_000,
    ).toISOString(),
  };
}
