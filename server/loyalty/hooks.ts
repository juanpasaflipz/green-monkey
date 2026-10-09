/**
 * Loyalty's hooks inside money transactions (038, specs/loyalty-w4.md §4.6; ARCHITECTURE row 54,
 * LO-R10). Web only. The cfdi-style contract (server/cfdi/hooks.ts): no-op when the order has no
 * member; never throw for a missing setting; take no locks; at most one jobs insert whose key
 * only the calling operation can meet (LO-R8: the caller's own order, refund batch or discount).
 * Each hook costs one plain read of loyalty_order_links by primary key (the reversal hook none:
 * a reward discount always has a link), then the loyalty_reconcile job does the work in its own
 * transaction, outside the payment's. Payloads carry the order id only (no personal data).
 * Imports only jobs.ts and types, so checks.ts, refunds.ts and discounts.ts → hooks has no cycle.
 */
import type { Tx } from "../db.js";
import { enqueueJob } from "../jobs.js";
import type { Session } from "../../shared/domain.js";

export const LOYALTY_RECONCILE = "loyalty_reconcile";

async function linked(tx: Tx, orderId: string): Promise<boolean> {
  const [l] =
    await tx`select member_id from loyalty_order_links where order_id=${orderId}`;
  return !!l?.member_id;
}

async function enqueue(
  tx: Tx,
  s: Pick<Session, "tenantId">,
  orderId: string,
  dedupeKey: string,
) {
  await enqueueJob(tx, s, {
    kind: LOYALTY_RECONCILE,
    dedupeKey,
    payload: { orderId },
  });
}

/** refreshCheckState: a table check became paid, or a check is about to close settled. */
export async function loyaltyOrderSettled(
  tx: Tx,
  s: Pick<Session, "tenantId">,
  orderId: string,
  paid: number,
): Promise<void> {
  if (await linked(tx, orderId))
    await enqueue(tx, s, orderId, `settle:${orderId}:${paid}`);
}

/** refreshCheckState's all-voided branch, before the check closes voided (restores a reward). */
export async function loyaltyOrderVoided(
  tx: Tx,
  s: Pick<Session, "tenantId">,
  orderId: string,
): Promise<void> {
  if (await linked(tx, orderId)) await enqueue(tx, s, orderId, `void:${orderId}`);
}

/** The last statement of insertRefundBatch (R19): a refund lowers the stamp base. */
export async function loyaltyRefundRecorded(
  tx: Tx,
  s: Pick<Session, "tenantId">,
  orderId: string,
  batchId: string,
): Promise<void> {
  if (await linked(tx, orderId))
    await enqueue(tx, s, orderId, `refund:${batchId}`);
}

/** reverseDiscount of a loyalty_reward discount: the reward is restored by the reconcile. */
export async function loyaltyRewardDiscountReversed(
  tx: Tx,
  s: Pick<Session, "tenantId">,
  orderId: string,
  discountId: string,
): Promise<void> {
  await enqueue(tx, s, orderId, `discount:${discountId}`);
}
