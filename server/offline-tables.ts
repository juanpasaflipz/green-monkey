/**
 * Offline table service (wave contract §8.1): orders sent to the kitchen
 * offline, rounds added to local or cached server orders, and full or partial
 * payments of them. Rounds and payments go through the same server guards as
 * online commands (applyRound, recordPayment); nothing here changes totals or
 * tenders with direct SQL, except the manager reconcile of a payment into its
 * original drawer, which never targets a closed check.
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import {
  DomainError,
  businessDate,
  type Order,
  type Session,
} from "../shared/domain.js";
import { allocatePayment } from "../shared/settlement.js";
import { permit, operators } from "./auth.js";
import type {
  OfflineOrderV3,
  OfflinePaymentV3,
  OfflineRecord,
  OfflineRoundV3,
  OrderTarget,
} from "../shared/offline-recovery.js";
import { audit, getOrder } from "./orders.js";
import {
  applyRound,
  assertCheckWritable,
  refreshCheckState,
} from "./compat/offline-service.js";
import { placeRoundsInOfflineReview } from "./offline-kitchen.js";
import {
  appliers,
  CLOSED_STATES,
  financialRecovery,
  isV3,
  ledger,
  newTender,
  reconcilers,
  resolveOrCreateOrder,
  reviewTargets,
  verifyLines,
  type EvidenceContext,
  type OfflineSyncResult,
} from "./offline-sync.js";

/**
 * The server order behind a target. A dependent record never applies before its
 * parent and is never re-targeted (invariant I5).
 */
export async function resolveTarget(
  tx: Tx,
  target: OrderTarget,
): Promise<string> {
  if ("orderId" in target) {
    const [order] = await tx`select id from orders where id=${target.orderId}`;
    if (!order) throw new DomainError("offline_order_closed", 409);
    return order.id;
  }
  const [parent] =
    await tx`select result from operations where id=${target.localOrderOperationId} and kind='offline_sync'`;
  if (parent) return parent.result.orderId ?? parent.result.id;
  const [archived] =
    await tx`select 1 from offline_archives where operation_id=${target.localOrderOperationId}`;
  if (archived) throw new DomainError("offline_dependency_archived", 409);
  throw new DomainError("offline_dependency_pending", 409);
}

/** Locks the target order and refuses closed, cancelled or recovery checks (I6). */
async function writableOrder(tx: Tx, orderId: string) {
  const [row] = await tx`select * from orders where id=${orderId} for update`;
  if (!row || CLOSED_STATES.includes(row.state))
    throw new DomainError("offline_order_closed", 409);
  try {
    assertCheckWritable(row as { check_state?: string; state: string });
  } catch (e) {
    if (e instanceof DomainError)
      throw new DomainError("offline_order_closed", 409);
    throw e;
  }
  return row;
}

appliers.order = async (tx, s, p, ctx) => {
  const record = p as OfflineOrderV3;
  const { orderId, reused } = await resolveOrCreateOrder(tx, s, record, ctx);
  await ledger(tx, s, p, ctx, {
    kind: "order",
    orderId,
    roundNumber: 1,
    tenderId: null,
    reused,
  });
  const kitchenReview = reused
    ? false
    : (await placeRoundsInOfflineReview(tx, s, {
        orderId,
        roundNumber: 1,
        operationId: p.operationId,
      })) > 0;
  return {
    kind: "order",
    orderId,
    roundNumber: 1,
    tenderId: null,
    reusedOnlineOrder: reused,
    kitchenReview,
  };
};

appliers.round = async (tx, s, p, ctx) => {
  const record = p as OfflineRoundV3;
  const orderId = await resolveTarget(tx, record.target);
  // Re-price first (I3), then take the order lock for the append.
  const lines = await verifyLines(
    tx,
    record.lines,
    record.receiptSnapshot.lines,
    record.expectedTotal,
  );
  const order = await writableOrder(tx, orderId);
  let roundNumber: number;
  try {
    // Additive: an offline round needs no version check, it only appends.
    roundNumber = await applyRound(tx, s, order as never, lines, {
      stockPolicy: "allow",
      detail: { channel: "offline", operationId: p.operationId },
    });
  } catch (e) {
    if (
      e instanceof DomainError &&
      (e.code === "check_closed" || e.code === "stale_order")
    )
      throw new DomainError("offline_order_closed", 409);
    throw e;
  }
  await ledger(tx, s, p, ctx, {
    kind: "round",
    orderId,
    roundNumber,
    tenderId: null,
  });
  const kitchenReview =
    (await placeRoundsInOfflineReview(tx, s, {
      orderId,
      roundNumber,
      operationId: p.operationId,
    })) > 0;
  return {
    kind: "round",
    orderId,
    roundNumber,
    tenderId: null,
    reusedOnlineOrder: false,
    kitchenReview,
  };
};

appliers.payment = async (tx, s, p, ctx) => {
  const record = p as OfflinePaymentV3;
  const orderId = await resolveTarget(tx, record.target);
  await writableOrder(tx, orderId);
  const order = await getOrder(tx, orderId);
  // Revalidated against the balance now: it may have been paid elsewhere (I2).
  if (record.payment.amount > order.total - order.paid)
    throw new DomainError("offline_payment_exceeds_due", 409);
  const tenderId = await newTender(
    tx,
    s,
    orderId,
    record.payment,
    record.cashSessionId,
  );
  await ledger(tx, s, p, ctx, {
    kind: "payment",
    orderId,
    roundNumber: null,
    tenderId,
  });
  return {
    kind: "payment",
    orderId,
    roundNumber: null,
    tenderId,
    reusedOnlineOrder: false,
    kitchenReview: false,
  };
};

/**
 * Where a payment's money can go on the manager path (§4.3.6):
 * - `pending`: its original order record is still queued (on this or another
 *   device). Nothing is recorded: the order would later sync unpaid and the
 *   money would count twice (I5).
 * - `unresolvable`: the original order was archived, does not exist, or is
 *   cancelled or in recovery. Only a financial-only recovery can hold the money.
 * - `closed`: a closed check is never written (contract §3.4).
 * - `open`: the order takes the payment if it fits the balance (I2).
 */
type PaymentTarget =
  | { state: "pending"; code: string }
  | { state: "unresolvable"; code: string }
  | { state: "closed"; order: Order }
  | { state: "open"; order: Order };

async function paymentTarget(
  tx: Tx,
  target: OrderTarget,
  lock: boolean,
): Promise<PaymentTarget> {
  let orderId: string;
  try {
    orderId = await resolveTarget(tx, target);
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    if (e.code === "offline_dependency_pending")
      return { state: "pending", code: e.code };
    // offline_dependency_archived, or an order id this tenant does not have.
    return { state: "unresolvable", code: e.code };
  }
  const [row] = lock
    ? await tx`select * from orders where id=${orderId} for update`
    : await tx`select * from orders where id=${orderId}`;
  if (!row || CLOSED_STATES.includes(row.state))
    return { state: "unresolvable", code: "offline_order_closed" };
  const order = await getOrder(tx, orderId);
  try {
    assertCheckWritable(row as { check_state?: string; state: string });
  } catch (e) {
    if (e instanceof DomainError) return { state: "closed", order };
    throw e;
  }
  return { state: "open", order };
}

const dueOf = (order: Order) => order.total - order.paid;

/** A payment that cannot go into its order: why, as a sync error code. */
function refusal(p: OfflinePaymentV3, order: Order) {
  return p.payment.amount > dueOf(order)
    ? "offline_payment_exceeds_due"
    : "offline_order_closed";
}

reviewTargets.resolve = async (tx, p) => {
  if (!isV3(p) || !("target" in p)) return null;
  const found = await paymentTarget(tx, p.target, false);
  if (found.state === "pending" || found.state === "unresolvable")
    return {
      target: null,
      reconcile:
        found.state === "unresolvable" && p.kind === "payment"
          ? "financial"
          : "none",
      problem: found.code,
    };
  const target = {
    orderId: found.order.id,
    number: found.order.number,
    due: dueOf(found.order),
  };
  if (p.kind !== "payment") return { target, reconcile: "none", problem: null };
  if (found.state === "open" && p.payment.amount <= target.due)
    return { target, reconcile: "order", problem: null };
  return { target, reconcile: "none", problem: refusal(p, found.order) };
};

/**
 * Manager reconcile of a payment to its order: the tender goes to the original
 * drawer (open or closed) with the same allocations the payment command would
 * make. No recovery order, so the order stays a normal, serviceable order. The
 * caller holds the order row lock.
 */
async function reconcilePaymentToOrder(
  tx: Tx,
  s: Session,
  p: OfflinePaymentV3,
  ctx: EvidenceContext,
  order: Order,
  reason: string,
): Promise<OfflineSyncResult> {
  const orderId = order.id;
  if (p.payment.amount > dueOf(order))
    throw new DomainError("offline_payment_exceeds_due", 409);
  // Global lock order (contract §3.14): the drawer after the order, so a
  // concurrent drawer close waits for this tender and counts it.
  await tx`select id from cash_sessions where id=${p.cashSessionId} for update`;
  const allocations = order.itemSplitAvailable
    ? allocatePayment(order.paymentUnits!, p.payment.amount)
    : [];
  const tenderId = randomUUID();
  await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,external_reference,source,source_id,created_at)
    values(${s.tenantId},${tenderId},${orderId},${p.cashSessionId},${p.payment.method},${p.payment.amount},${p.payment.tip},${p.payment.received},${p.payment.reference || null},'offline_recovery',${p.operationId},clock_timestamp())`;
  for (const allocation of allocations)
    await tx`insert into tender_allocations(tenant_id,order_id,tender_id,line_id,unit_index,amount)
      values(${s.tenantId},${orderId},${tenderId},${allocation.lineId},${allocation.unit},${allocation.amount})`;
  await ledger(tx, s, p, ctx, {
    kind: "payment",
    orderId,
    roundNumber: null,
    tenderId,
    path: "manager",
    reason,
  });
  await audit(tx, s, "offline.payment_reconciled", orderId, {
    reason,
    operationId: p.operationId,
    amount: p.payment.amount,
    tip: p.payment.tip,
    method: p.payment.method,
    drawerId: p.cashSessionId,
  });
  await refreshCheckState(tx, s, orderId);
  const result = await getOrder(tx, orderId);
  return {
    kind: "payment",
    operationId: p.operationId,
    orderId,
    orderNumber: result.number,
    provisionalNumber: p.provisionalNumber,
    roundNumber: null,
    tenderId,
    soldAt: ctx.soldAt.toISOString(),
    businessDate: ctx.businessDate,
    reusedOnlineOrder: false,
    kitchenReview: false,
    order: result,
  };
}

reconcilers.payment = async (tx, s, p: OfflineRecord, ctx, reason) => {
  const record = p as OfflinePaymentV3;
  const found = await paymentTarget(tx, record.target, true);
  switch (found.state) {
    case "pending":
      // The original order is still queued: recording the money now would
      // make it count twice once that order syncs unpaid.
      throw new DomainError("offline_dependency_pending", 409);
    case "unresolvable":
      // The order will never exist as a sale: only a financial-only recovery
      // in the original drawer can hold the money.
      return financialRecovery(tx, s, p, ctx, reason);
    case "closed":
      // Never into a closed check (contract §3.4); the manager archives.
      throw new DomainError(refusal(record, found.order), 409);
    case "open":
      return reconcilePaymentToOrder(tx, s, record, ctx, found.order, reason);
  }
};

/**
 * Open orders from the current and previous business day, for selling against
 * them during an outage. One bounded query (200 rows). Contract D19: after
 * service merges this predicate becomes `check_state <> 'closed'`.
 */
export async function openOrdersSnapshot(tx: Tx, s: Session) {
  permit(s, operators);
  const today = businessDate(
    new Date().toISOString(),
    s.restaurant.timezone,
    s.restaurant.cutoff,
  );
  const rows =
    await tx`select o.id,o.number,o.version,o.mode,o.table_id,t.name as table_name,
      o.name,o.note,o.total,o.state,o.created_at,o.service_version,o.paid,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id',l.id,'productId',l.product_id,'round',l.round,
          'quantity',(l.data->>'quantity')::int,'name',l.data->'name',
          'optionNames',coalesce(l.data->'optionNames','[]'::jsonb),
          'unitPrice',(l.data->>'unitPrice')::int,'total',(l.data->>'total')::int,
          'station',l.data->>'station',
          'voidedQuantity',coalesce((select sum(cardinality(v.units)) from line_voids v
             where v.tenant_id=l.tenant_id and v.line_id=l.id),0)) order by l.round,l.id),'[]'::jsonb)
        from order_lines l where l.tenant_id=o.tenant_id and l.order_id=o.id) as lines
    from (select o.*,(select coalesce(sum(x.amount),0)::int from tenders x
            where x.tenant_id=o.tenant_id and x.order_id=o.id) as paid
          from orders o
          where o.business_date >= ${today}::date - 1
            and o.state not in ('cancelled','recovery_pending','recovery_reviewed')) o
    left join dining_tables t on t.tenant_id=o.tenant_id and t.id=o.table_id
    where o.state <> 'completed' or o.total > o.paid
    order by o.created_at desc
    limit 200`;
  return {
    refreshedAt: new Date().toISOString(),
    orders: rows.map((o) => ({
      id: o.id,
      number: o.number,
      version: o.version,
      mode: o.mode,
      tableId: o.table_id,
      tableName: o.table_name ?? null,
      name: o.name,
      note: o.note,
      total: o.total,
      paid: o.paid,
      state: o.state,
      createdAt: o.created_at.toISOString(),
      serviceVersion: o.service_version,
      lines: o.lines,
    })),
  };
}
