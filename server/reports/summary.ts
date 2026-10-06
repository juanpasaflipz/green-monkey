// Reports (029): the metric contract's statements S1–S5 (spec §4.5), fiscalForRange and the
// SalesSummary composition. Every statement buckets by stored business dates or by the
// versioned settings in force at each instant (cfg CTE, migration 029); none uses today's
// cutoff for old records. Reads run inside snapshotTenant (one REPEATABLE READ snapshot).
import type { Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import { log } from "../logging.js";
import type { Session } from "../../shared/domain.js";
import type { FiscalSummary } from "../../shared/fiscal.js";
import {
  aggregateInt,
  composeSalesSummary,
  currentBusinessDate,
  failedCheckCodes,
  mergeFiscalSummaries,
  rangeChunks,
  type CollectionDayAggregate,
  type DateRange,
  type DrawerRow,
  type LineDayAggregate,
  type PaidOutDayAggregate,
  type RefundDayAggregate,
  type RestockDayAggregate,
  type SalesDayAggregate,
  type SalesSummary,
  type TenderMethod,
} from "../../shared/reports.js";
import { businessDayCte, windowOf } from "./days.js";
import { fiscalCurrency, type ReportsPorts } from "./ports.js";
import { restaurantOf, type ReportRestaurant } from "./restaurant.js";
import { drawerList } from "./drawers.js";

type Row = Record<string, unknown>;
const n = aggregateInt;
const method = (value: unknown): TenderMethod =>
  value === "external" ? "external" : "cash";

/** S1: the sales lens per order business date (orders, their tenders, their fiscal ticket). */
export async function salesDays(
  tx: Tx,
  range: DateRange,
): Promise<SalesDayAggregate[]> {
  const rows = await tx<Row[]>`
    select o.business_date::text as date,
      count(*) filter (where o.total > 0)::int as orders,
      count(*) filter (where o.state = 'cancelled')::int as cancelled,
      count(*) filter (where o.state like 'recovery%')::int as recovery_count,
      coalesce(sum(o.total) filter (where o.state like 'recovery%'), 0)::int8 as recovery_total,
      coalesce(sum(o.total + o.discount) filter (where o.state like 'recovery%' and f.id is not null), 0)::int8
        as ticketed_recovery_gross,
      coalesce(sum(o.discount), 0)::int8 as discounts,
      coalesce(sum(o.total), 0)::int8 as total,
      coalesce(sum(p.paid), 0)::int8 as paid,
      coalesce(sum(p.tip), 0)::int8 as tips,
      count(*) filter (where o.total > p.paid)::int as open_checks,
      count(*) filter (where p.paid > o.total)::int as overpaid,
      count(f.id)::int as ticketed,
      coalesce(sum(f.gross), 0)::int8 as ticketed_gross,
      coalesce(sum(o.total) filter (where f.id is not null), 0)::int8 as ticketed_order_total,
      coalesce(sum(o.total) filter (where f.id is null and o.total > p.paid), 0)::int8 as unticketed_open,
      coalesce(sum(o.total) filter (where f.id is null and o.total > 0 and o.total <= p.paid), 0)::int8
        as unticketed_paid,
      count(*) filter (where o.channel = 'offline' and o.state not like 'recovery%' and o.total > 0)::int
        as offline_count,
      coalesce(sum(o.total) filter (where o.channel = 'offline' and o.state not like 'recovery%'), 0)::int8
        as offline_total,
      coalesce(sum(p.tip) filter (where o.channel = 'offline' and o.state not like 'recovery%'), 0)::int8
        as offline_tips
    from orders o
    cross join lateral (
      select coalesce(sum(t.amount), 0)::int8 as paid, coalesce(sum(t.tip), 0)::int8 as tip
        from tenders t where t.tenant_id = o.tenant_id and t.order_id = o.id) p
    left join fiscal_tickets f on f.tenant_id = o.tenant_id and f.order_id = o.id
    where o.business_date between ${range.from}::date and ${range.to}::date
    group by o.business_date order by o.business_date`;
  return rows.map((r) => ({
    date: String(r.date),
    orders: n(r.orders),
    cancelled: n(r.cancelled),
    recoveryCount: n(r.recovery_count),
    recoveryTotal: n(r.recovery_total),
    ticketedRecoveryGross: n(r.ticketed_recovery_gross),
    discounts: n(r.discounts),
    total: n(r.total),
    paid: n(r.paid),
    tips: n(r.tips),
    openChecks: n(r.open_checks),
    overpaid: n(r.overpaid),
    ticketed: n(r.ticketed),
    ticketedGross: n(r.ticketed_gross),
    ticketedOrderTotal: n(r.ticketed_order_total),
    unticketedOpen: n(r.unticketed_open),
    unticketedPaid: n(r.unticketed_paid),
    offlineCount: n(r.offline_count),
    offlineTotal: n(r.offline_total),
    offlineTips: n(r.offline_tips),
  }));
}

/**
 * The line facts CTE body `lf` (S2), shared with the product and category breakdowns: one row per
 * order line of the range's orders, with its voided units and amount, its active discount
 * allocations on units that are not voided (and the comp part), its unit cost snapshot and
 * whether its order has a fiscal ticket.
 */
export function lineFacts(tx: Tx, range: DateRange) {
  return tx`
    select o.business_date, o.id as order_id, (f.id is not null) as ticketed, (o.state = 'cancelled') as cancelled,
      l.id as line_id, l.product_id, l.data,
      (l.data->>'quantity')::int as qty, (l.data->>'total')::int8 as total,
      (l.data->>'cost')::int8 as unit_cost,
      coalesce(v.units, 0) as voided_units, coalesce(v.amount, 0) as voided_amount,
      coalesce(v.waste_units, 0) as waste_units,
      coalesce(d.amount, 0) as discount, coalesce(d.comp, 0) as comp
    from orders o
    join order_lines l on l.tenant_id = o.tenant_id and l.order_id = o.id
    left join fiscal_tickets f on f.tenant_id = o.tenant_id and f.order_id = o.id
    left join lateral (
      select sum(cardinality(v.units))::int as units, sum(v.amount)::int8 as amount,
             coalesce(sum(cardinality(v.units)) filter (where v.stock_disposition = 'not_returned'), 0)::int as waste_units
        from line_voids v where v.tenant_id = l.tenant_id and v.line_id = l.id) v on true
    left join lateral (
      select sum(a.amount)::int8 as amount, sum(a.amount) filter (where x.kind = 'comp')::int8 as comp
        from discount_allocations a
        join discounts x on x.tenant_id = a.tenant_id and x.id = a.discount_id
       where a.tenant_id = l.tenant_id and a.line_id = l.id and x.reversed_at is null
         and not exists (select 1 from line_voids v2 where v2.tenant_id = a.tenant_id
                         and v2.line_id = a.line_id and a.unit_index = any (v2.units))) d on true
    where o.business_date between ${range.from}::date and ${range.to}::date`;
}

/** S2: line facts per order business date. */
export async function lineDays(
  tx: Tx,
  range: DateRange,
): Promise<LineDayAggregate[]> {
  const rows = await tx<Row[]>`
    with lf as (${lineFacts(tx, range)})
    select business_date::text as date,
      coalesce(sum(total - voided_amount - discount), 0)::int8 as line_net,
      coalesce(sum(voided_amount), 0)::int8 as voided,
      coalesce(sum(voided_units), 0)::int8 as voided_units,
      coalesce(sum(voided_amount) filter (where cancelled), 0)::int8 as cancelled_amount,
      coalesce(sum(discount), 0)::int8 as line_discounts,
      coalesce(sum(comp), 0)::int8 as courtesies,
      coalesce(sum(unit_cost * (qty - voided_units)) filter (where ticketed and unit_cost is not null), 0)::int8 as cogs,
      coalesce(sum(unit_cost * (qty - voided_units)) filter (where unit_cost is not null), 0)::int8 as cogs_all,
      coalesce(sum(total - voided_amount) filter (where ticketed and unit_cost is not null), 0)::int8 as covered_gross,
      coalesce(sum(total - voided_amount) filter (where ticketed), 0)::int8 as ticketed_line_gross,
      coalesce(sum(unit_cost * waste_units) filter (where unit_cost is not null), 0)::int8 as waste_cost
    from lf group by business_date order by business_date`;
  return rows.map((r) => ({
    date: String(r.date),
    lineNet: n(r.line_net),
    voided: n(r.voided),
    voidedUnits: n(r.voided_units),
    cancelledAmount: n(r.cancelled_amount),
    lineDiscounts: n(r.line_discounts),
    courtesies: n(r.courtesies),
    cogs: n(r.cogs),
    cogsAll: n(r.cogs_all),
    coveredGross: n(r.covered_gross),
    ticketedLineGross: n(r.ticketed_line_gross),
    wasteCost: n(r.waste_cost),
  }));
}

/**
 * The CTE bodies `ids` and `x` of S3 (shared with tenderRows): the tenders whose collection date
 * may fall in the range, and per tender its collection day (the offline ledger's sale day, the
 * recovery order's business date, else the business date of created_at under the settings in
 * force then), the day it was recorded, and whether an offline ledger row carries it.
 * Requires `cfg` in the same WITH list.
 */
export function collectionCtes(
  tx: Tx,
  range: DateRange,
  w: { ws: string; we: string },
) {
  return tx`
    ids as (
      select t.id from tenders t where t.created_at >= ${w.ws} and t.created_at < ${w.we}
      union
      select r.tender_id from offline_sync_records r
       where r.business_date between ${range.from}::date and ${range.to}::date and r.tender_id is not null
      union
      select t.id from orders o join tenders t on t.tenant_id = o.tenant_id and t.order_id = o.id
       where o.business_date between ${range.from}::date and ${range.to}::date and o.state like 'recovery%'
    ),
    x as (
      select t.id, t.tenant_id, t.created_at, t.method, t.amount, t.tip, t.external_reference, t.session_id,
        t.source, o.id as order_id, o.number as order_number, o.business_date as order_date,
        ((t.created_at at time zone c.timezone) - make_interval(mins => c.cutoff))::date as recorded_day,
        coalesce(r.business_date,
                 case when o.state like 'recovery%' then o.business_date end,
                 ((t.created_at at time zone c.timezone) - make_interval(mins => c.cutoff))::date) as day,
        (r.business_date is not null) as offline
      from ids
      join tenders t on t.id = ids.id
      join orders o on o.tenant_id = t.tenant_id and o.id = t.order_id
      join cfg c on t.created_at >= c.valid_from and t.created_at < c.valid_until
      left join lateral (select r.business_date from offline_sync_records r
                          where r.tenant_id = t.tenant_id and r.order_id = t.order_id and r.tender_id = t.id
                          limit 1) r on true
    )`;
}

/** S3: tenders per collection date and method, with the late (synced afterwards) part. */
export async function collectionDays(
  tx: Tx,
  s: Session,
  range: DateRange,
  w: { ws: string; we: string },
): Promise<CollectionDayAggregate[]> {
  const rows = await tx<Row[]>`
    with cfg as (${businessDayCte(tx, s.tenantId)}), ${collectionCtes(tx, range, w)}
    select day::text as date, method, count(*)::int as count,
      coalesce(sum(amount), 0)::int8 as amount, coalesce(sum(tip), 0)::int8 as tips,
      count(*) filter (where day < recorded_day)::int as late_count,
      coalesce(sum(amount) filter (where day < recorded_day), 0)::int8 as late_amount
    from x where day between ${range.from}::date and ${range.to}::date
    group by day, method order by day, method`;
  return rows.map((r) => ({
    date: String(r.date),
    method: method(r.method),
    count: n(r.count),
    amount: n(r.amount),
    tips: n(r.tips),
    lateCount: n(r.late_count),
    lateAmount: n(r.late_amount),
  }));
}

/**
 * S4: refunds per refund business date and method. The refund date is the batch's business date
 * (discounts 028 computes it once per refund command; fiscal dates the adjustments with the same
 * value), or, for a batchless pre-028 refund, the business date of created_at under the settings
 * in force then. `fiscal_amount` is the part created at or after fiscal_epoch() (027).
 */
export async function refundDays(
  tx: Tx,
  s: Session,
  range: DateRange,
  w: { ws: string; we: string },
): Promise<RefundDayAggregate[]> {
  const rows = await tx<Row[]>`
    with cfg as (${businessDayCte(tx, s.tenantId)})
    select q.day::text as date, q.method, count(*)::int as count, coalesce(sum(q.amount), 0)::int8 as amount,
      coalesce(sum(q.amount) filter (where q.created_at >= fiscal_epoch()), 0)::int8 as fiscal_amount
    from (select r.amount, r.method, r.created_at,
            coalesce(b.business_date,
                     ((r.created_at at time zone c.timezone) - make_interval(mins => c.cutoff))::date) as day
          from refunds r
          left join refund_batches b on b.tenant_id = r.tenant_id and b.id = r.batch_id
          join cfg c on r.created_at >= c.valid_from and r.created_at < c.valid_until
          where r.created_at >= ${w.ws} and r.created_at < ${w.we}) q
    where q.day between ${range.from}::date and ${range.to}::date
    group by q.day, q.method order by q.day, q.method`;
  return rows.map((r) => ({
    date: String(r.date),
    method: method(r.method),
    count: n(r.count),
    amount: n(r.amount),
    fiscalAmount: n(r.fiscal_amount),
  }));
}

/** S4b: cost returned to stock by restocked item refunds, per refund business date. */
export async function restockDays(
  tx: Tx,
  range: DateRange,
): Promise<RestockDayAggregate[]> {
  const rows = await tx<Row[]>`
    select b.business_date::text as date,
      coalesce(sum(cardinality(rl.units) * (l.data->>'cost')::int8), 0)::int8 as restocked_cost
    from refund_batches b
    join refund_lines rl on rl.tenant_id = b.tenant_id and rl.batch_id = b.id and rl.restocked
    join order_lines l on l.tenant_id = rl.tenant_id and l.id = rl.line_id and l.data->>'cost' is not null
    where b.business_date between ${range.from}::date and ${range.to}::date
    group by b.business_date order by b.business_date`;
  return rows.map((r) => ({
    date: String(r.date),
    restockedCost: n(r.restocked_cost),
  }));
}

/**
 * S5: cash paid-outs per movement business date. Drawers opened more than 35 days before the
 * range are left out here; they are flagged as drawer_open_long.
 */
export async function paidOutDays(
  tx: Tx,
  s: Session,
  range: DateRange,
  w: { ws: string; we: string },
): Promise<PaidOutDayAggregate[]> {
  const rows = await tx<Row[]>`
    with cfg as (${businessDayCte(tx, s.tenantId)}),
    d as (select id from cash_sessions
           where opened_at >= ${w.ws}::timestamptz - interval '35 days' and opened_at < ${w.we}
             and (closed_at is null or closed_at >= ${w.ws}))
    select q.day::text as date, count(*)::int as count, coalesce(-sum(q.amount), 0)::int8 as amount
    from (select m.amount, ((m.created_at at time zone c.timezone) - make_interval(mins => c.cutoff))::date as day
            from cash_movements m join d on d.id = m.session_id
            join cfg c on m.created_at >= c.valid_from and m.created_at < c.valid_until
           where m.amount < 0) q
    where q.day between ${range.from}::date and ${range.to}::date
    group by q.day order by q.day`;
  return rows.map((r) => ({
    date: String(r.date),
    count: n(r.count),
    amount: n(r.amount),
  }));
}

/**
 * fiscal's IVA figures for the range: null when the restaurant issues no fiscal tickets
 * (currency other than MXN); otherwise fiscalSummary per ≤ 31-day chunk, merged. IVA is never
 * recomputed from orders, tickets or CFDI totals.
 */
export async function fiscalForRange(
  tx: Tx,
  s: Session,
  range: DateRange,
  ports: Pick<ReportsPorts, "fiscalSummary">,
  restaurant?: ReportRestaurant,
): Promise<FiscalSummary | null> {
  const r = restaurant ?? (await restaurantOf(tx, s));
  if (!fiscalCurrency(r.currency)) return null;
  const parts: FiscalSummary[] = [];
  for (const chunk of rangeChunks(range))
    parts.push(await ports.fiscalSummary(tx, s, chunk));
  return mergeFiscalSummaries(parts);
}

/** The summary and the drawer rows it was built from (dayCorte and Hoy reuse both). */
export async function summaryWithDrawers(
  tx: Tx,
  s: Session,
  range: DateRange,
  requestId: string,
  ports: ReportsPorts,
): Promise<{ summary: SalesSummary; drawers: DrawerRow[] }> {
  permit(s, managers);
  const restaurant = await restaurantOf(tx, s);
  const w = windowOf(range, restaurant);
  const [sales, lines, collections, refunds, restocks, paidOuts] =
    await Promise.all([
      salesDays(tx, range),
      lineDays(tx, range),
      collectionDays(tx, s, range, w),
      refundDays(tx, s, range, w),
      restockDays(tx, range),
      paidOutDays(tx, s, range, w),
    ]);
  const drawers = await drawerList(tx, s, range, ports, restaurant);
  const tax = await fiscalForRange(tx, s, range, ports, restaurant);
  const summary = composeSalesSummary({
    range,
    currency: restaurant.currency,
    generatedAt: new Date().toISOString(),
    currentBusinessDate: currentBusinessDate(restaurant),
    requestId,
    sales,
    lines,
    collections,
    refunds,
    restocks,
    paidOuts,
    drawers,
    tax,
  });
  const codes = failedCheckCodes(summary.checks);
  // A failed check never throws: the UI shows the codes and this line carries the request id.
  if (codes.length)
    log.warn("report_check_failed", { tenantId: s.tenantId, codes, range });
  return { summary, drawers };
}

/** GET /api/reports/summary: the metric contract for a business-date range (≤ 92 days). */
export async function salesSummary(
  tx: Tx,
  s: Session,
  range: DateRange,
  requestId: string,
  ports: ReportsPorts,
): Promise<SalesSummary> {
  return (await summaryWithDrawers(tx, s, range, requestId, ports)).summary;
}
