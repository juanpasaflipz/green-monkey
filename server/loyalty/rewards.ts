/**
 * Reward redemption (038, specs/loyalty-w4.md §2.6, §4.5): "Canjear premio" records an audited
 * discount through the discounts engine (reason loyalty_reward, no approver, no PIN, never counted
 * against a cashier's limit) tied one-to-one to a reward_redeemed ledger row.
 *
 * Lock order (ARCHITECTURE row 48): 1 → 2 → 3 (the member FOR NO KEY UPDATE) → 5 (orders FOR
 * UPDATE through discounts' recordDiscount) → link insert if absent → 8 (discount and allocations)
 * → ledger insert (LO-3 re-lock, free) → refresh [12] (whose settle hook reads the link and
 * enqueues the reconcile, LO-R8). Discounts' row 25 shape with LO-3 in front.
 */
import type { Tx } from "../db.js";
import { operators, permit } from "../auth.js";
import { audit, getOrder, once } from "../orders.js";
import { recordDiscount } from "../discounts.js";
import { DomainError, type Order, type Session } from "../../shared/domain.js";
import { RESERVED_DISCOUNT_REASON } from "../../shared/discounts.js";
import {
  redeemInput,
  rewardDiscountRequest,
  type OrderLoyaltyView,
} from "../../shared/loyalty.js";
import { requireClub } from "./settings.js";
import { orderLoyaltyView, postLedger } from "./ledger.js";
import { lockMember } from "./members.js";

export type RedeemResult = { order: Order; loyalty: OrderLoyaltyView };

/** POST /orders/:orderId/reward (operators). */
export async function redeemReward(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
): Promise<RedeemResult> {
  permit(s, operators);
  const parsed = redeemInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("invalid_input", 400);
  const p = parsed.data;
  // once() saves ids only (LOYALTY-PRIVACY-1): a replay re-reads the order and its loyalty view
  // (whose member summary is the member as it is now).
  let fresh: Order | null = null;
  await once<{ orderId: string; discountId: string }>(
    tx,
    s,
    p.operationId,
    "loyalty.reward.redeem",
    { orderId, ...p },
    async () => {
      const program = await requireClub(tx);
      const m = await lockMember(tx, p.memberId);
      if (m.redacted_at) throw new DomainError("loyalty_member_deleted", 409);
      if (m.rewards < 1) throw new DomainError("loyalty_no_reward", 409);
      // The request the dialog planned; recordDiscount replans it under the order lock and
      // refuses a different result (discount_changed, DSC-R13).
      const request = rewardDiscountRequest(
        program,
        await getOrder(tx, orderId),
        p.lineId,
      );
      let discountId = "";
      let amount = 0;
      const order = await recordDiscount(
        tx,
        s,
        orderId,
        {
          ...request,
          expectedVersion: p.expectedVersion,
          expectedAmount: p.expectedAmount,
          expectedBase: p.expectedBase,
          expectedAllocations: p.expectedAllocations,
          expectedDue: p.expectedDue,
          expectedCloses: p.expectedCloses,
          reasonCode: RESERVED_DISCOUNT_REASON,
          note: "",
        },
        {
          reserved: true,
          afterInsert: async (id, plan) => {
            discountId = id;
            amount = plan.amount;
            // Under the order lock: the order's active redemptions, then its link.
            const [active] =
              await tx`select count(*)::int as n from loyalty_ledger l
                join discounts d on d.tenant_id=l.tenant_id and d.id=l.discount_id
                where l.order_id=${orderId} and l.kind='reward_redeemed' and d.reversed_at is null
                  and not exists (select 1 from loyalty_ledger x where x.tenant_id=l.tenant_id
                    and x.discount_id=l.discount_id and x.kind='reward_restored')`;
            if (active.n >= program.maxRewardsPerOrder)
              throw new DomainError("loyalty_reward_limit", 409);
            const [link] =
              await tx`select member_id from loyalty_order_links where order_id=${orderId}`;
            if (link?.member_id && link.member_id !== p.memberId)
              throw new DomainError("loyalty_order_linked", 409);
            if (link && !link.member_id)
              await tx`update loyalty_order_links set member_id=${p.memberId},
                  changed_at=clock_timestamp(),changed_by=${s.employeeId} where order_id=${orderId}`;
            else if (!link)
              await tx`insert into loyalty_order_links(tenant_id,order_id,member_id,via,linked_by)
                values(${s.tenantId},${orderId},${p.memberId},'pos',${s.employeeId})`;
            await postLedger(tx, s.tenantId, {
              memberId: p.memberId,
              kind: "reward_redeemed",
              stampsDelta: 0,
              rewardsDelta: -1,
              orderId,
              discountId: id,
              actorId: s.employeeId,
              operationId: p.operationId,
            });
          },
        },
      );
      await audit(tx, s, "loyalty.reward.redeemed", orderId, {
        memberId: p.memberId,
        discountId,
        amount,
      });
      fresh = order;
      return { orderId, discountId };
    },
  );
  return {
    order: fresh ?? (await getOrder(tx, orderId)),
    loyalty: await orderLoyaltyView(tx, orderId),
  };
}
