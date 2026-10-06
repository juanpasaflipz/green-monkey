// Reports (029): GET /api/report, the old daily report shape kept for PWA bundles that predate
// the reports views (moved from server/index.ts). Same keys; the values now follow the metric
// contract: orders by stored business date, tenders by collection date, refunds by refund date.
import { z } from "zod";
import type { Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import { boundaries, DomainError, type Session } from "../../shared/domain.js";
import {
  composeSalesSummary,
  currentBusinessDate,
  isBusinessDate,
} from "../../shared/reports.js";
import { businessDayCte, windowOf } from "./days.js";
import { restaurantOf } from "./restaurant.js";
import {
  collectionCtes,
  collectionDays,
  lineDays,
  refundDays,
  salesDays,
} from "./summary.js";

const legacyQuery = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .passthrough();

export async function legacyDailyReport(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const restaurant = await restaurantOf(tx, s);
  const q = legacyQuery.parse(raw ?? {});
  const date = q.date ?? currentBusinessDate(restaurant);
  if (!isBusinessDate(date)) throw new DomainError("invalid_input", 400);
  const range = { from: date, to: date };
  const w = windowOf(range, restaurant);
  const [
    orders,
    tenders,
    refunds,
    cash,
    sales,
    lines,
    collections,
    refundRows,
  ] = await Promise.all([
    tx`select o.*, (select coalesce(sum(t.amount), 0)::int from tenders t
                       where t.tenant_id = o.tenant_id and t.order_id = o.id) as paid
           from orders o where o.business_date = ${date}::date order by o.created_at, o.id`,
    tx`with cfg as (${businessDayCte(tx, s.tenantId)}), ${collectionCtes(tx, range, w)}
         select t.* from x join tenders t on t.tenant_id = x.tenant_id and t.id = x.id
          where x.day = ${date}::date order by t.created_at, t.id`,
    tx`with cfg as (${businessDayCte(tx, s.tenantId)})
         select r.* from refunds r
           left join refund_batches b on b.tenant_id = r.tenant_id and b.id = r.batch_id
           join cfg c on r.created_at >= c.valid_from and r.created_at < c.valid_until
          where r.created_at >= ${w.ws} and r.created_at < ${w.we}
            and coalesce(b.business_date,
                  ((r.created_at at time zone c.timezone) - make_interval(mins => c.cutoff))::date) = ${date}::date
          order by r.created_at, r.id`,
    tx`with cfg as (${businessDayCte(tx, s.tenantId)})
         select cs.* from cash_sessions cs
           join cfg c on cs.closed_at >= c.valid_from and cs.closed_at < c.valid_until
          where cs.closed_at >= ${w.ws} and cs.closed_at < ${w.we}
            and ((cs.closed_at at time zone c.timezone) - make_interval(mins => c.cutoff))::date = ${date}::date
          order by cs.closed_at, cs.id`,
    salesDays(tx, range),
    lineDays(tx, range),
    collectionDays(tx, s, range, w),
    refundDays(tx, s, range, w),
  ]);
  const summary = composeSalesSummary({
    range,
    currency: restaurant.currency,
    generatedAt: new Date().toISOString(),
    currentBusinessDate: currentBusinessDate(restaurant),
    sales,
    lines,
    collections,
    refunds: refundRows,
    restocks: [],
    paidOuts: [],
    drawers: [],
    tax: null,
  });
  const lineData = await tx`
    select l.data from order_lines l join orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
     where o.business_date = ${date}::date`;
  const unallocated = orders.filter(
    (o) => o.state === "recovery_pending" || o.state === "recovery_reviewed",
  );
  return {
    date,
    period: boundaries(date, restaurant.timezone, restaurant.cutoff),
    source: "business_date",
    refreshedAt: new Date().toISOString(),
    orders,
    tenders,
    refunds,
    cash,
    gross: summary.sales.salesTotal,
    collected: summary.collections.collected,
    tips: summary.collections.tips,
    refundTotal: summary.refunds.total,
    cogs: summary.sales.cogsAllOrders,
    unallocatedRecoveryCount: unallocated.length,
    unallocatedRecoveryTotal: unallocated.reduce(
      (total, o) => total + Number(o.total),
      0,
    ),
    // Old semantics (recovery.spec): the share of lines with a cost, recoveries uncovered.
    costCoverage:
      lineData.length + unallocated.length
        ? lineData.filter(
            (l) => l.data.cost !== null && l.data.cost !== undefined,
          ).length /
          (lineData.length + unallocated.length)
        : 0,
    // Additive keys.
    discounts: summary.sales.discounts,
    salesTotal: summary.sales.salesTotal,
    collectedByMethod: summary.collections.byMethod,
  };
}
