/**
 * The loyalty ledger and the order reconciler (038, specs/loyalty-w4.md §2.2, §4.4).
 *
 * postLedger is the only insert path into loyalty_ledger; 038's trigger applies each row to the
 * member's cached balances under the member's row lock (a free re-lock: callers already hold it,
 * LO-R10). reconcileOrder is ARCHITECTURE row 49: 3 (every member linked to or posted on the
 * order, sorted, one statement FOR NO KEY UPDATE) → plain reads of the order, its tenders,
 * refunds and discounts → ledger inserts. No once(): it is idempotent by state (planReconcile
 * posts only the difference between the order's target and what the ledger already holds), so
 * retries, double taps, job redelivery and races cannot double-stamp. A link that changed between
 * the first read and the lock throws loyalty_retry (the job retries; an HTTP caller retries).
 */
import { queueLoyaltyEvent } from "./engagement-events.js";
import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { DomainError } from "../../shared/domain.js";
import {
  firstName,
  maskPhone,
  planReconcile,
  stampBase,
  stampsFor,
  type LedgerKind,
  type MemberSummary,
  type OrderLoyaltyView,
  type PlannedLedgerRow,
  type ProgramRule,
} from "../../shared/loyalty.js";
import { loadProgram, type Program } from "./settings.js";

export type LedgerInsert = PlannedLedgerRow & {
  /** earn/earn_reversal: the rule the order earns under (§2.2.8, LOYALTY-MONEY-4). */
  rule?: ProgramRule;
  orderId?: string | null;
  actorId?: string | null;
  operationId?: string | null;
  reason?: string | null;
  note?: string;
};

/** Inserts one ledger row (never ON CONFLICT: 038's BEFORE trigger has already applied it). */
export async function postLedger(
  tx: Tx,
  tenantId: string,
  r: LedgerInsert,
): Promise<string> {
  const ledgerId = randomUUID();
  await tx`insert into loyalty_ledger(tenant_id,id,member_id,kind,stamps_delta,rewards_delta,order_id,
      discount_id,stamps_required,base,stamp_threshold,max_stamps_per_order,reason,note,actor_id,operation_id)
    values(${tenantId},${ledgerId},${r.memberId},${r.kind},${r.stampsDelta},${r.rewardsDelta},
      ${r.orderId ?? null},${r.discountId ?? null},${r.stampsRequired ?? null},${r.base ?? null},
      ${r.rule?.stampThreshold ?? null},${r.rule?.maxStampsPerOrder ?? null},
      ${r.reason ?? null},${r.note ?? ""},${r.actorId ?? null},${r.operationId ?? null})`;
  await queueLoyaltyEvent(tx, tenantId, r.memberId, r.kind, ledgerId);
  return ledgerId;
}

/** A member row as staff lists show it. */
export function summaryOf(
  m: Record<string, any>,
  required: number,
): MemberSummary {
  return {
    id: m.id,
    firstName: firstName(m.name ?? ""),
    maskedPhone: maskPhone(m.phone_e164 ?? null),
    stamps: m.stamps,
    required,
    rewards: m.rewards,
    deleted: m.redacted_at !== null && m.redacted_at !== undefined,
  };
}

/** Settled for stamps (§2.1): paid, or closed settled/released, and never in recovery. */
export const isSettled = (o: Record<string, any>) =>
  !String(o.state).startsWith("recovery") &&
  o.state !== "cancelled" &&
  (o.check_state === "paid" ||
    (o.check_state === "closed" &&
      (o.close_reason === "settled" || o.close_reason === "released")));

/** The order's stamp base from its tenders net of their refunds (plain reads). */
export async function orderStampBase(tx: Tx, orderId: string, total: number) {
  const tenders = await tx`select t.method,t.amount::int as amount,
      coalesce((select sum(r.amount) from refunds r where r.tenant_id=t.tenant_id and r.tender_id=t.id),0)::int as refunded
    from tenders t where t.order_id=${orderId}`;
  return stampBase({
    total,
    tenders: tenders.map((t) => ({
      method: t.method as string,
      amount: t.amount as number,
      refunded: t.refunded as number,
    })),
  });
}

/**
 * A settled order whose stamp base earns no stamp (paid by a platform, fully comped or refunded):
 * its receipt and the kiosk offer no join QR, which would promise stamps (LOYALTY-UX-7).
 */
export async function settledEarnsNothing(
  tx: Tx,
  orderId: string,
  program: Program,
): Promise<boolean> {
  const [o] =
    await tx`select state,check_state,close_reason,total from orders where id=${orderId}`;
  if (!o || !isSettled(o)) return false;
  const base = await orderStampBase(tx, orderId, o.total);
  return (
    stampsFor(base, {
      stampThreshold: program.stampThreshold,
      maxStampsPerOrder: program.maxStampsPerOrder,
    }) === 0
  );
}

/**
 * Brings the order's ledger rows to what §2.2 says they should be, then returns the order's
 * loyalty view. Every member it may post for is locked first, in one statement ordered by id.
 */
export async function reconcileOrder(
  tx: Tx,
  tenantId: string,
  orderId: string,
): Promise<OrderLoyaltyView> {
  return reconcileOrderHeld(tx, tenantId, orderId, null);
}

/**
 * reconcileOrder for a command that already holds member rows (the link commands, row 47): every
 * member the reconcile would lock must be one of `held`, else loyalty_retry, so no member row is
 * ever locked after the command's order lock. With `held` null it locks what it needs (row 49).
 */
export async function reconcileOrderHeld(
  tx: Tx,
  tenantId: string,
  orderId: string,
  held: string[] | null,
): Promise<OrderLoyaltyView> {
  const [link] =
    await tx`select member_id from loyalty_order_links where order_id=${orderId}`;
  const posted =
    await tx`select distinct member_id from loyalty_ledger where order_id=${orderId}
      and kind in ('earn','earn_reversal','reward_redeemed','reward_restored')`;
  const ids = [
    ...new Set(
      [link?.member_id, ...posted.map((r) => r.member_id)].filter(
        (x): x is string => !!x,
      ),
    ),
  ].sort();
  if (!ids.length) return orderLoyaltyView(tx, orderId);
  if (held && ids.some((m) => !held.includes(m)))
    throw new DomainError("loyalty_retry", 409);
  const members =
    await tx`select id,stamps,rewards,redacted_at from loyalty_members
      where id = any(${tx.array(ids)}::uuid[]) order by id for no key update`;
  const [again] =
    await tx`select member_id from loyalty_order_links where order_id=${orderId}`;
  if (again?.member_id && !ids.includes(again.member_id))
    throw new DomainError("loyalty_retry", 409);
  const program = await loadProgram(tx);
  const [o] =
    await tx`select state,check_state,close_reason,total from orders where id=${orderId}`;
  if (!o) throw new DomainError("not_found", 404);
  // The rule the order earns under: its first earn's, else today's (§2.2.8). A refund, relink or
  // requeue of an old order never re-targets it under a rule changed since (LOYALTY-MONEY-4).
  const [first] =
    await tx`select stamp_threshold,max_stamps_per_order from loyalty_ledger
      where order_id=${orderId} and kind='earn' order by created_at,id limit 1`;
  const rule: ProgramRule = first
    ? { stampThreshold: first.stamp_threshold, maxStampsPerOrder: first.max_stamps_per_order }
    : { stampThreshold: program.stampThreshold, maxStampsPerOrder: program.maxStampsPerOrder };
  const settled = isSettled(o);
  const base = settled ? await orderStampBase(tx, orderId, o.total) : 0;
  const sums =
    await tx`select member_id,sum(stamps_delta)::int as posted from loyalty_ledger
      where order_id=${orderId} and kind in ('earn','earn_reversal') group by member_id`;
  const redemptions = await tx`select l.member_id,l.discount_id,
      exists (select 1 from loyalty_ledger x where x.tenant_id=l.tenant_id and x.discount_id=l.discount_id
              and x.kind='reward_restored') as restored,
      d.reversed_at is not null as reversed,
      case when d.reversed_at is not null then 0 else
        coalesce((select sum(b.amount) from discount_allocations b
          where b.tenant_id=d.tenant_id and b.discount_id=d.id
            and not exists (select 1 from line_voids v where v.tenant_id=b.tenant_id
                            and v.line_id=b.line_id and b.unit_index=any(v.units))),0)::int end as active
    from loyalty_ledger l join discounts d on d.tenant_id=l.tenant_id and d.id=l.discount_id
    where l.order_id=${orderId} and l.kind='reward_redeemed'`;
  const rows = planReconcile({
    enabled: program.enabled,
    stampsRequired: program.stampsRequired,
    rule,
    settled,
    live:
      !settled &&
      !String(o.state).startsWith("recovery") &&
      o.state !== "cancelled" &&
      o.check_state !== "closed",
    base,
    linkMemberId: again?.member_id ?? null,
    members: members.map((m) => ({
      id: m.id,
      deleted: m.redacted_at !== null,
      stamps: m.stamps,
      rewards: m.rewards,
      posted: sums.find((x) => x.member_id === m.id)?.posted ?? 0,
    })),
    redemptions: redemptions.map((r) => ({
      memberId: r.member_id,
      discountId: r.discount_id,
      restored: r.restored,
      discountReversed: r.reversed,
      activeAmount: r.active,
      // A voided allocation never comes back: settled (a paid table check included, which may
      // be released later with no hook) is final, like closed (LOYALTY-MONEY-1).
      orderClosed: o.check_state === "closed" || settled,
    })),
  });
  for (const r of rows)
    await postLedger(tx, tenantId, {
      ...r,
      orderId,
      ...(r.kind === "earn" || r.kind === "earn_reversal" ? { rule } : {}),
    });
  return orderLoyaltyView(tx, orderId, program);
}

/**
 * Detalle de orden, Mesas and Vender's toast (pure read, also kiosk's R23 export). Never from
 * getOrders (its statement budget is full, C-14).
 */
export async function orderLoyaltyView(
  tx: Tx,
  orderId: string,
  program?: Program,
): Promise<OrderLoyaltyView> {
  const p = program ?? (await loadProgram(tx));
  const [o] = await tx`select o.id,o.state,o.check_state,o.close_reason,o.closed_at,
      coalesce((select max(t.created_at) from tenders t where t.tenant_id=o.tenant_id and t.order_id=o.id),
               o.closed_at, o.created_at) as settled_at,
      l.member_id,l.via
    from orders o left join loyalty_order_links l on l.tenant_id=o.tenant_id and l.order_id=o.id
    where o.id=${orderId}`;
  if (!o) throw new DomainError("not_found", 404);
  const settled = isSettled(o);
  const eligible =
    !String(o.state).startsWith("recovery") &&
    o.state !== "cancelled" &&
    !(o.check_state === "closed" && !settled);
  const windowEndsAt = settled
    ? new Date(
        new Date(o.settled_at).getTime() + p.linkWindowDays * 86_400_000,
      ).toISOString()
    : null;
  const [m] = o.member_id
    ? await tx`select id,name,phone_e164,stamps,rewards,redacted_at from loyalty_members where id=${o.member_id}`
    : [];
  const [mine] = o.member_id
    ? await tx`select
        coalesce(sum(stamps_delta) filter (where kind in ('earn','earn_reversal')),0)::int as earned,
        (count(*) filter (where kind='reward_earned') - count(*) filter (where kind='reward_unearned'))::int as completed
      from loyalty_ledger where order_id=${orderId} and member_id=${o.member_id}`
    : [{ earned: 0, completed: 0 }];
  const redemptions = await tx`select l.discount_id,d.amount,
      exists (select 1 from loyalty_ledger x where x.tenant_id=l.tenant_id and x.discount_id=l.discount_id
              and x.kind='reward_restored') as restored
    from loyalty_ledger l join discounts d on d.tenant_id=l.tenant_id and d.id=l.discount_id
    where l.order_id=${orderId} and l.kind='reward_redeemed' order by l.created_at`;
  const [job] =
    await tx`select exists (select 1 from jobs where kind='loyalty_reconcile'
      and state in ('queued','available','running') and payload->>'orderId'=${orderId}) as pending`;
  return {
    orderId,
    member: m ? summaryOf(m, p.stampsRequired) : null,
    via: o.via ?? null,
    earned: mine.earned,
    completed: mine.completed,
    redemptions: redemptions.map((r) => ({
      discountId: r.discount_id,
      amount: r.amount,
      restored: r.restored,
    })),
    linkable:
      eligible &&
      (!settled || (windowEndsAt !== null && Date.now() < Date.parse(windowEndsAt))),
    settled,
    windowEndsAt,
    pending: job.pending,
  };
}

/** Kinds that show on the member's history, newest first. */
export const HISTORY_KINDS: readonly LedgerKind[] = [
  "earn",
  "earn_reversal",
  "reward_earned",
  "reward_unearned",
  "reward_redeemed",
  "reward_restored",
  "adjustment",
  "import",
];
