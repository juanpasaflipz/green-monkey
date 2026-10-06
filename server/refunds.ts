// Refunds (028): item refunds of paid units and amount refunds, for cash and
// external-terminal (card) tenders, with kitchen cancellation and optional
// restock; and the legacy POST /refunds for old bundles. insertRefundBatch is
// the single writer of refunds and the single caller of fiscal's
// recordRefundTax. Lock order (docs/ARCHITECTURE.md): items 1 → 2 → 5 → 5a →
// 6 → 7 → 9 → 10 (kitchen cancellation) → 11; amount and legacy 1 → 2 → 5 →
// 6 → 11. Refunds never call refreshCheckState and never change the order's
// total, discount or check state.
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { Tx } from "./db.js";
import { managers, operators, permit } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { audit, drawer, getOrder, once, stock } from "./orders.js";
import { lockStockItems } from "./stock.js";
import { bumpKitchenFeed } from "./kitchen.js";
import {
  approvalFingerprint,
  assertApproverActive,
  type ApprovalContext,
} from "./discounts.js";
// discounts (028): fiscal 027 is built in parallel; this shim is replaced by
// ./fiscal.js at discounts' merge (specs/discounts.md §4.1).
import { recordRefundTax } from "./compat/discounts-fiscal.js";
import { recipeStockIds } from "../shared/menu.js";
import {
  businessDate,
  DomainError,
  id,
  money,
  sum,
  type Order,
  type Session,
} from "../shared/domain.js";
import {
  amountRefundAllowed,
  itemRefundPlanMatches,
  planItemRefund,
  refundInput,
  refundTaxScopes,
  type RefundBatchView,
} from "../shared/discounts.js";

export type RefundBatchWrite = {
  orderId: string;
  mode: "amount" | "items";
  reasonCode: string;
  note: string;
  restock: boolean;
  approverId: string;
  /** Computed ONCE by the calling command; stored on the batch and used by fiscal. */
  businessDate: string;
  /** This device's open drawer; required when any portion is cash. */
  drawerId: string | null;
  /** Legacy route only (refunds.disposition). */
  legacyDisposition?: "discard" | "no_stock_return";
  /** In tender order (created_at, id). */
  portions: {
    tenderId: string;
    method: "cash" | "external";
    amount: number;
    reference: string | null;
    units: { lineId: string; unit: number; amount: number }[];
  }[];
  lines: {
    lineId: string;
    units: number[];
    amount: number;
    preparationState: string;
    kitchenAck: boolean;
  }[];
};

/**
 * Writes one refund batch: the batch row, one refund_lines row per line, then
 * per portion (tender order) its refunds row, its refund_units rows and
 * fiscal's recordRefundTax with that row's scope (items) or none (amount).
 * The deferred triggers reconcile the batch at commit.
 */
export async function insertRefundBatch(
  tx: Tx,
  s: Session,
  b: RefundBatchWrite,
): Promise<{
  batchId: string;
  refundIds: string[];
  refundLineIds: Record<string, string>;
}> {
  const scopes = refundTaxScopes(
    b.portions.flatMap((p) =>
      p.units.map((u) => ({ ...u, tenderId: p.tenderId })),
    ),
  );
  if (b.portions.some((p) => p.method === "cash") && !b.drawerId)
    throw new DomainError("drawer_required", 409);
  const batchId = randomUUID();
  const amount = sum(b.portions.map((p) => p.amount));
  const cash = sum(
    b.portions.filter((p) => p.method === "cash").map((p) => p.amount),
  );
  await tx`insert into refund_batches(tenant_id,id,order_id,mode,amount,cash_amount,external_amount,
      reason_code,note,restock,actor_id,approver_id,device_id,business_date)
    values(${s.tenantId},${batchId},${b.orderId},${b.mode},${amount},${cash},${amount - cash},
      ${b.reasonCode},${b.note},${b.restock},${s.employeeId},${b.approverId},${s.deviceId},${b.businessDate})`;
  const refundLineIds: Record<string, string> = {};
  for (const line of b.lines) {
    const lineId = randomUUID();
    refundLineIds[line.lineId] = lineId;
    await tx`insert into refund_lines(tenant_id,id,batch_id,order_id,line_id,units,amount,
        preparation_state,restocked,kitchen_ack_required)
      values(${s.tenantId},${lineId},${batchId},${b.orderId},${line.lineId},${line.units},${line.amount},
        ${line.preparationState},${b.restock},${line.kitchenAck})`;
  }
  const refundIds: string[] = [];
  for (const p of b.portions) {
    const refundId = randomUUID();
    await tx`insert into refunds(tenant_id,id,tender_id,session_id,amount,reason,disposition,actor_id,
        method,external_reference,batch_id,order_id)
      values(${s.tenantId},${refundId},${p.tenderId},${b.drawerId},${p.amount},${b.note || b.reasonCode},
        ${b.legacyDisposition ?? "no_stock_return"},${s.employeeId},${p.method},
        ${p.method === "external" ? p.reference : null},${batchId},${b.orderId})`;
    if (p.units.length)
      await tx`insert into refund_units(tenant_id,refund_id,tender_id,batch_id,order_id,line_id,unit_index,amount)
        select ${s.tenantId},${refundId},${p.tenderId},${batchId},${b.orderId},x.line_id,x.unit_index,x.amount
        from unnest(${tx.array(p.units.map((u) => u.lineId))}::uuid[],
          ${tx.array(p.units.map((u) => u.unit))}::int[],
          ${tx.array(p.units.map((u) => u.amount))}::int[]) as x(line_id,unit_index,amount)`;
    await recordRefundTax(
      tx,
      s,
      refundId,
      b.mode === "items" ? scopes[p.tenderId] : undefined,
    );
    refundIds.push(refundId);
  }
  return { batchId, refundIds, refundLineIds };
}

/** Kitchen states whose refunded units get a cancellation the station acknowledges (Q5). */
const KITCHEN_ACK_STATES = ["not_started", "active", "ready", "offline_review"];

/**
 * POST /orders/:id/refunds. Item refunds are allowed in every check state
 * (only fully paid units); amount refunds only without a balance due
 * (refund_balance_due). Card portions need the terminal's reference and an
 * explicit confirmation and never touch drawer cash.
 */
export async function recordRefund(
  tx: Tx,
  s: Session,
  orderId: string,
  raw: unknown,
  a: ApprovalContext,
): Promise<{ order: Order; batch: RefundBatchView }> {
  permit(s, operators);
  const p = refundInput.parse(raw);
  if (p.reasonCode === "other" && p.note.length < 3)
    throw new DomainError("refund_note_required", 400);
  return once(
    tx,
    s,
    p.operationId,
    p.mode === "items" ? "refund.items" : "refund.amount",
    approvalFingerprint({ orderId }, p),
    async () => {
      // LD-2: the route always sets an approver here (a manager's PIN, or a
      // manager acting alone after their own step-up); the rule stays literal.
      if (!a.approverId && !managers.includes(s.role))
        throw new DomainError("approval_required", 403);
      if (!a.approverId) requireRecentAuth(s);
      const approverId = a.approverId ?? s.employeeId;
      // Computed once per command: batch, fiscal adjustments and reports agree.
      const businessDay = businessDate(
        new Date().toISOString(),
        s.restaurant.timezone,
        s.restaurant.cutoff,
      );
      const [o] =
        await tx`select id from orders where id=${orderId} for update`;
      if (!o) throw new DomainError("not_found", 404);
      await assertApproverActive(tx, approverId, s);
      const order = await getOrder(tx, orderId);
      // §2.4 rule 2 (DSC-R9): the client's preview is stale when a refund was
      // recorded since (another device, or a dialog reopened on an old order
      // after a lost response), even when the next units cost the same.
      if (order.refunded !== p.expectedRefunded)
        throw new DomainError("refund_changed", 409);
      let portions: RefundBatchWrite["portions"];
      let planned: { lineId: string; units: number[]; amount: number }[] = [];
      if (p.mode === "items") {
        if (!order.itemSplitAvailable)
          throw new DomainError("unallocated_history", 409);
        const plan = planItemRefund(order, p.lines);
        // ...and when the server's plan is not the previewed one, unit for
        // unit (a payment in between makes a later unit refundable).
        if (!itemRefundPlanMatches(plan, p))
          throw new DomainError("refund_changed", 409);
        planned = plan.lines;
        portions = plan.byTender.map((t) => ({
          tenderId: t.tenderId,
          method: t.method,
          amount: t.amount,
          reference: null,
          units: plan.units
            .filter((u) => u.tenderId === t.tenderId)
            .map((u) => ({ lineId: u.lineId, unit: u.unit, amount: u.amount })),
        }));
      } else {
        if (!amountRefundAllowed(order))
          throw new DomainError("refund_balance_due", 409);
        const t = order.tenders.find(
          (x: { id: string }) => x.id === p.tenderId.toLowerCase(),
        );
        if (!t) throw new DomainError("not_found", 404);
        if (p.amount > t.amount - t.refunded)
          throw new DomainError("refund_exceeds", 409);
        portions = [
          {
            tenderId: t.id,
            method: t.method,
            amount: p.amount,
            reference: null,
            units: [],
          },
        ];
      }
      // Every external portion needs exactly its own confirmed terminal reference.
      const external = portions.filter((x) => x.method === "external");
      const confirmations = new Map(
        p.external.map((e) => [e.tenderId.toLowerCase(), e.reference]),
      );
      if (
        confirmations.size !== p.external.length ||
        confirmations.size !== external.length ||
        external.some((x) => !confirmations.has(x.tenderId))
      )
        throw new DomainError("refund_external_confirmation", 400);
      for (const x of external) x.reference = confirmations.get(x.tenderId)!;
      // Tender keys, sorted (LO-6): the previous revision may refund a tender
      // without the order lock, so re-read each tender's refunds under its key.
      const tenderIds = [...new Set(portions.map((x) => x.tenderId))].sort();
      for (const tenderId of tenderIds)
        await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + tenderId},0))`;
      const refunded = new Map(
        (
          await tx`select tender_id,coalesce(sum(amount),0)::int as refunded from refunds
            where tender_id=any(${tx.array(tenderIds)}::uuid[]) group by tender_id`
        ).map((r) => [r.tender_id as string, r.refunded as number]),
      );
      for (const x of portions) {
        const t = order.tenders.find(
          (y: { id: string }) => y.id === x.tenderId,
        );
        const now = refunded.get(x.tenderId) ?? 0;
        // A refund the order lock did not see (an earlier revision) also
        // makes the plan stale, not only one that leaves too little.
        if (now !== t.refunded || x.amount > t.amount - now)
          throw new DomainError("refund_changed", 409);
      }
      let lines: RefundBatchWrite["lines"] = [];
      const refundedLines = planned.map((l) =>
        order.lines.find((x) => x.id === l.lineId)!,
      );
      if (p.mode === "items") {
        // Rounds of the refunded lines (LO-7), then stock (LO-9), the feed
        // (LO-10) and the drawer (LO-11), as voids and offline sync do.
        const rounds =
          await tx`select id,number,station,state,seen_at from rounds
          where order_id=${orderId} and number=any(${tx.array([
            ...new Set(refundedLines.map((l) => l.round ?? 0)),
          ])}::int[]) order by id for update`;
        lines = planned.map((l) => {
          const line = order.lines.find((x) => x.id === l.lineId)!;
          const round = rounds.find(
            (r) => r.number === line.round && r.station === line.station,
          );
          const preparationState = round
            ? round.state === "active" && !round.seen_at
              ? "not_started"
              : round.state
            : "completed";
          return {
            ...l,
            preparationState,
            kitchenAck: KITCHEN_ACK_STATES.includes(preparationState),
          };
        });
        if (p.restock) await lockStockItems(tx, recipeStockIds(refundedLines));
        if (lines.some((l) => l.kitchenAck)) await bumpKitchenFeed(tx, s);
      }
      const cashPart = portions.some((x) => x.method === "cash");
      const [d] = cashPart
        ? [await drawer(tx, s)]
        : await tx`select id from cash_sessions where device_id=${s.deviceId} and closed_at is null for update`;
      const written = await insertRefundBatch(tx, s, {
        orderId,
        mode: p.mode,
        reasonCode: p.reasonCode,
        note: p.note,
        restock: p.mode === "items" && p.restock,
        approverId,
        businessDate: businessDay,
        drawerId: d?.id ?? null,
        portions,
        lines,
      });
      if (p.mode === "items" && p.restock)
        for (const l of lines) {
          const line = order.lines.find((x) => x.id === l.lineId)!;
          for (const r of [...line.recipe].sort((x, y) =>
            x.stockId.localeCompare(y.stockId),
          ))
            await stock(
              tx,
              s,
              r.stockId,
              new Decimal(r.quantity).mul(l.units.length).toFixed(6),
              "refund",
              written.refundLineIds[l.lineId],
              "refund_return",
              "allow",
            );
        }
      const total = sum(portions.map((x) => x.amount));
      const cash = sum(
        portions.filter((x) => x.method === "cash").map((x) => x.amount),
      );
      await audit(tx, s, "refund.recorded", orderId, {
        batchId: written.batchId,
        mode: p.mode,
        amount: total,
        cash,
        external: total - cash,
        lines: lines.map((l) => ({ lineId: l.lineId, units: l.units })),
        restock: p.mode === "items" && p.restock,
        reasonCode: p.reasonCode,
        approverId,
        businessDate: businessDay,
      });
      const after = await getOrder(tx, orderId);
      return {
        order: after,
        batch: after.refundBatches!.find((x) => x.id === written.batchId)!,
      };
    },
  );
}

/** Same strict schema and fingerprint as before 028 (old bundles, I-17). */
const legacyRefundInput = z
  .object({
    operationId: id,
    tenderId: id,
    amount: money.refine((n) => n > 0),
    reason: z.string().min(3).max(300),
    disposition: z.enum(["discard", "no_stock_return"]),
  })
  .strict();

/**
 * Legacy POST /refunds (old bundles): a manager's cash refund of one tender,
 * with step-up and no approval. Now also locks the order before the tender
 * key, refuses checks with a balance due and writes a batch, like every
 * post-028 refund.
 */
export async function refund(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  requireRecentAuth(s);
  const p = legacyRefundInput.parse(raw);
  return once(tx, s, p.operationId, "refund", p, async () => {
    const [pointer] =
      await tx`select order_id from tenders where id=${p.tenderId}`;
    if (!pointer) throw new DomainError("not_found", 404);
    await tx`select id from orders where id=${pointer.order_id} for update`;
    const order = await getOrder(tx, pointer.order_id);
    if (!amountRefundAllowed(order))
      throw new DomainError("refund_balance_due", 409);
    const tenderId = p.tenderId.toLowerCase();
    // The same key as the refunds trigger: tenant::text || tender::text (S-30).
    await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + tenderId},0))`;
    const [t] = await tx`select * from tenders where id=${tenderId}`;
    const [r] =
      await tx`select coalesce(sum(amount),0)::int as amount from refunds where tender_id=${tenderId}`;
    if (p.amount > t.amount - r.amount)
      throw new DomainError("refund_exceeds", 409);
    if (t.method === "external")
      throw new DomainError("external_refund_unverified", 409);
    if (p.reason.trim().length < 3)
      throw new DomainError("refund_note_required", 400);
    const d = await drawer(tx, s);
    const written = await insertRefundBatch(tx, s, {
      orderId: t.order_id,
      mode: "amount",
      reasonCode: "other",
      note: p.reason,
      restock: false,
      approverId: s.employeeId,
      businessDate: businessDate(
        new Date().toISOString(),
        s.restaurant.timezone,
        s.restaurant.cutoff,
      ),
      drawerId: d.id,
      legacyDisposition: p.disposition,
      portions: [
        {
          tenderId: t.id,
          method: "cash",
          amount: p.amount,
          reference: null,
          units: [],
        },
      ],
      lines: [],
    });
    await audit(tx, s, "refund.recorded", t.order_id, {
      ...p,
      batchId: written.batchId,
      mode: "amount",
      legacyRoute: true,
    });
    return getOrder(tx, t.order_id);
  });
}
