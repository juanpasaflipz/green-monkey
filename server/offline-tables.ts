/**
 * Offline table service (wave contract §8.1): orders sent to the kitchen
 * offline, rounds added to local or cached server orders, and full or partial
 * payments of them. Rounds and payments go through the same server guards as
 * online commands (applyRound, recordPayment); nothing here changes totals or
 * tenders with direct SQL, except the manager reconcile of a payment into its
 * original drawer, which never targets a closed check.
 */
import type { Tx } from "./db.js";
import { DomainError, businessDate, type Session } from "../shared/domain.js";
import { permit, operators } from "./auth.js";
import {
  offlineRecord,
  type OfflineOrderV3,
  type OfflinePaymentV3,
  type OfflineRecord,
  type OfflineRoundV3,
  type OrderTarget,
} from "../shared/offline-recovery.js";
import { applyRound, getOrder } from "./orders.js";
import { assertCheckWritable } from "./checks.js";
import { placeRoundsInOfflineReview } from "./offline-kitchen.js";
import { requireTableService } from "./offline-settings.js";
import {
  appliers,
  assertLinesNotRecorded,
  CLOSED_STATES,
  dueOf,
  financialRecovery,
  isV3,
  ledger,
  moneyRefusal,
  moneyTarget,
  newTender,
  onlineCreateOf,
  reconcileIntoOrder,
  reconcilers,
  resolveOrCreateOrder,
  reviewTargets,
  verifyLines,
  type MoneyTarget,
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
    assertCheckWritable(row as { check_state: string; state: string });
  } catch (e) {
    if (e instanceof DomainError)
      throw new DomainError("offline_order_closed", 409);
    throw e;
  }
  return row;
}

/**
 * A check its tenders already cover takes no offline round (§2.3, §4.4.2): the
 * device refuses it as offline_check_paid, and a round made against a stale
 * copy goes to a manager instead of silently reopening a paid check. Service's
 * check_closed (and fiscal's fiscal_ticket_issued) give the same result at
 * merge; this keeps the in-wave behaviour identical.
 */
async function assertTakesRounds(tx: Tx, order: Record<string, unknown>) {
  const [row] =
    await tx`select coalesce(sum(amount),0)::int as paid from tenders where order_id=${order.id as string}`;
  const total = Number(order.total);
  if (total > 0 && row!.paid >= total)
    throw new DomainError("offline_order_closed", 409);
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
  // An online send of these same lines may have committed with its response
  // lost: a manager decides (archive if the order already has them).
  await assertLinesNotRecorded(tx, record.lines);
  // Re-price first (I3), then take the order lock for the append.
  const lines = await verifyLines(
    tx,
    record.lines,
    record.receiptSnapshot.lines,
    record.expectedTotal,
  );
  const order = await writableOrder(tx, orderId);
  await assertTakesRounds(tx, order);
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
type PaymentTarget = { state: "pending"; code: string } | MoneyTarget;

async function paymentTarget(
  tx: Tx,
  target: OrderTarget,
  lock: boolean,
  /** Rounds never follow an archived order to its online create (I5). */
  follow = true,
): Promise<PaymentTarget> {
  let orderId: string;
  try {
    orderId = await resolveTarget(tx, target);
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    if (e.code === "offline_dependency_pending")
      return { state: "pending", code: e.code };
    // OFF-R27: a local order archived because its create had already
    // committed online is that online order: its payments belong there.
    const online =
      follow &&
      e.code === "offline_dependency_archived" &&
      "localOrderOperationId" in target
        ? await archivedOnlineOrder(tx, target.localOrderOperationId)
        : null;
    // offline_dependency_archived, or an order id this tenant does not have.
    if (!online) return { state: "unresolvable", code: e.code };
    orderId = online;
  }
  return moneyTarget(tx, orderId, lock);
}

/**
 * The online order behind an archived local order record whose create had
 * already committed online (its response lost): the archived evidence is a
 * valid order record and the operation of its draft id created that order
 * from the same draft (a server price may differ). A different draft under
 * the same id is a conflict, never a merge (OFF-R32, I5): its payments then
 * take the financial-only path.
 */
async function archivedOnlineOrder(
  tx: Tx,
  operationId: string,
): Promise<string | null> {
  const [archived] =
    await tx`select evidence from offline_archives where operation_id=${operationId} and evidence_valid and kind='order'`;
  if (!archived) return null;
  const parsed = offlineRecord.safeParse(archived.evidence);
  if (!parsed.success || parsed.data.operationId !== operationId) return null;
  const created = await onlineCreateOf(tx, parsed.data);
  if (!created || created.problem === "offline_order_already_exists")
    return null;
  return created.orderId;
}

reviewTargets.resolve = async (tx, p) => {
  if (!isV3(p) || !("target" in p)) return null;
  const found = await paymentTarget(tx, p.target, false, p.kind === "payment");
  if (found.state === "pending" || found.state === "unresolvable")
    return {
      target: null,
      reconcile:
        found.state === "unresolvable" && p.kind === "payment"
          ? "financial"
          : "none",
      problems: [found.code],
    };
  const target = {
    orderId: found.order.id,
    number: found.order.number,
    due: dueOf(found.order),
  };
  // A round never goes onto a closed or fully paid check (I6, §4.4.2).
  if (p.kind === "round")
    return {
      target,
      reconcile: "none",
      problems:
        found.state === "closed" ||
        (found.order.total > 0 && found.order.paid >= found.order.total)
          ? ["offline_order_closed"]
          : [],
    };
  if (p.kind !== "payment") return { target, reconcile: "none", problems: [] };
  if (found.state === "open" && p.payment.amount <= target.due)
    return { target, reconcile: "order", problems: [] };
  return {
    target,
    reconcile: "none",
    problems: [moneyRefusal(p.payment.amount, found.order)],
  };
};

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
      throw new DomainError(
        moneyRefusal(record.payment.amount, found.order),
        409,
      );
    case "open":
      return reconcileIntoOrder(tx, s, record, ctx, found.order, reason);
  }
};

/**
 * Open orders from the current and previous business day, for selling against
 * them during an outage, only while the restaurant has offline table service
 * on (LD-7). One bounded query (200 rows). Contract D19: after
 * service merges this predicate becomes `check_state <> 'closed'`.
 */
export async function openOrdersSnapshot(tx: Tx, s: Session) {
  permit(s, operators);
  // LD-7 / GAP-4: devices fetch it only while table service is on.
  await requireTableService(tx);
  const today = businessDate(
    new Date().toISOString(),
    s.restaurant.timezone,
    s.restaurant.cutoff,
  );
  const rows =
    await tx`select o.id,o.number,o.version,o.mode,o.table_id,t.name as table_name,
      o.name,o.note,o.total,o.state,o.created_at,o.service_version,o.paid,
      o.tender_ids,o.offline_operation_ids,
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
            where x.tenant_id=o.tenant_id and x.order_id=o.id) as paid,
          (select coalesce(jsonb_agg(x.id order by x.created_at,x.id),'[]'::jsonb) from tenders x
            where x.tenant_id=o.tenant_id and x.order_id=o.id) as tender_ids,
          (select coalesce(jsonb_agg(r.operation_id order by r.synced_at,r.operation_id),'[]'::jsonb)
            from offline_sync_records r
            where r.tenant_id=o.tenant_id and r.order_id=o.id) as offline_operation_ids
          from orders o
          where o.business_date >= ${today}::date - 1
            -- D19: the service lifecycle's open-check rule, written literally.
            and o.check_state <> 'closed') o
    left join dining_tables t on t.tenant_id=o.tenant_id and t.id=o.table_id
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
      // Exactly what this copy already contains, so a device never counts one
      // of its own synced rounds or payments twice, whatever its clock says.
      tenderIds: o.tender_ids as string[],
      offlineOperationIds: o.offline_operation_ids as string[],
    })),
  };
}
