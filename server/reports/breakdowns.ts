// Reports (029): breakdowns of the sales lens (product, category, employee, hour, channel,
// service type) and of the collection lens (method), plus per-day rows (spec §4.5).
import type { Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import type { Label, Session } from "../../shared/domain.js";
import {
  aggregateInt,
  averageTicket,
  bps,
  breakdownQuery,
  composeSalesSummary,
  currentBusinessDate,
  hourRows,
  LIMITS,
  parseRange,
  TENDER_METHODS,
  type BreakdownResponse,
  type CategoryRow,
  type ChannelRow,
  type DateRange,
  type EmployeeRow,
  type MethodTotals,
  type ProductRow,
} from "../../shared/reports.js";
import { businessDayCte, windowOf } from "./days.js";
import { restaurantOf, type ReportRestaurant } from "./restaurant.js";
import {
  collectionDays,
  lineFacts,
  paidOutDays,
  refundDays,
  salesDays,
} from "./summary.js";

type Row = Record<string, unknown>;
const n = aggregateInt;
const label = (v: unknown): Label | null =>
  v && typeof v === "object" && "es" in v && "en" in v
    ? { es: String((v as Label).es), en: String((v as Label).en) }
    : null;

/** Recovery orders (no lines) of the range: the closing "sin detalle" row. */
async function recoveryOf(tx: Tx, range: DateRange) {
  const [r] = await tx<Row[]>`
    select count(*)::int as count, coalesce(sum(total), 0)::int8 as total from orders
     where business_date between ${range.from}::date and ${range.to}::date and state like 'recovery%'`;
  return { count: n(r.count), total: n(r.total) };
}

/**
 * The line facts with each line's category resolved: the line snapshot (menu 025) when it has
 * one; otherwise, for legacy lines, the product's current catalog category (snap = false).
 */
function categorizedLines(tx: Tx, range: DateRange) {
  return tx`
    lf as (${lineFacts(tx, range)}),
    lc as (
      select lf.*, lf.data->'name' as line_name,
        (jsonb_typeof(lf.data->'category') = 'object') as snap,
        case when jsonb_typeof(lf.data->'category') = 'object' then nullif(lf.data->>'categoryId', '')
             else nullif(cat.data->>'categoryId', '') end as category_id,
        case when jsonb_typeof(lf.data->'category') = 'object' then lf.data->'category'
             when mc.id is not null then jsonb_build_object('es', mc.name_es, 'en', mc.name_en)
             when jsonb_typeof(cat.data->'category') = 'object' then cat.data->'category' end as category
        from lf
        left join catalog cat on cat.id = lf.product_id
        left join menu_categories mc on mc.id = case
          when jsonb_typeof(lf.data->'category') <> 'object' or lf.data->'category' is null
          then case when cat.data->>'categoryId' ~ '^[0-9a-f-]{36}$' then (cat.data->>'categoryId')::uuid end end
    )`;
}

async function productRows(
  tx: Tx,
  range: DateRange,
): Promise<BreakdownResponse & { by: "product" }> {
  const [rows, refunds, recovery] = await Promise.all([
    tx<Row[]>`
      with ${categorizedLines(tx, range)}
      select product_id,
        (array_agg(line_name order by business_date desc, line_id desc))[1] as name,
        (array_agg(category_id order by business_date desc, line_id desc))[1] as category_id,
        (array_agg(category order by business_date desc, line_id desc))[1] as category,
        (array_agg(snap order by business_date desc, line_id desc))[1] as snap,
        coalesce(sum(qty - voided_units), 0)::int8 as units,
        coalesce(sum(total - voided_amount), 0)::int8 as gross,
        coalesce(sum(discount), 0)::int8 as discounts,
        coalesce(sum(unit_cost * (qty - voided_units)) filter (where unit_cost is not null), 0)::int8 as cost,
        count(*) filter (where unit_cost is null)::int as uncosted,
        count(*)::int as lines
      from lc group by product_id`,
    tx<Row[]>`
      select l.product_id, (array_agg(l.data->'name' order by b.business_date desc, l.id desc))[1] as name,
        coalesce(sum(cardinality(rl.units)), 0)::int8 as units, coalesce(sum(rl.amount), 0)::int8 as amount
      from refund_batches b
      join refund_lines rl on rl.tenant_id = b.tenant_id and rl.batch_id = b.id
      join order_lines l on l.tenant_id = rl.tenant_id and l.id = rl.line_id
      where b.business_date between ${range.from}::date and ${range.to}::date
      group by l.product_id`,
    recoveryOf(tx, range),
  ]);
  const refunded = new Map(refunds.map((r) => [String(r.product_id), r]));
  const sold = rows.map((r) => {
    const gross = n(r.gross);
    const discounts = n(r.discounts);
    const salesTotal = gross - discounts;
    const lines = n(r.lines);
    const uncosted = n(r.uncosted);
    const cost = uncosted === lines ? null : n(r.cost);
    const back = refunded.get(String(r.product_id));
    refunded.delete(String(r.product_id));
    return {
      productId: String(r.product_id),
      name: label(r.name) ?? { es: "", en: "" },
      categoryId: (r.category_id as string | null) ?? null,
      category: label(r.category),
      categorySnapshot: r.snap === true,
      units: n(r.units),
      grossSales: gross,
      discounts,
      salesTotal,
      shareBps: 0,
      cost,
      margin: uncosted === 0 && cost !== null ? salesTotal - cost : null,
      refundedUnits: back ? n(back.units) : 0,
      refunded: back ? n(back.amount) : 0,
    } satisfies ProductRow;
  });
  // Products refunded in the range without sales in it still show their refund.
  const onlyRefunded = [...refunded.values()].map((r): ProductRow => ({
    productId: String(r.product_id),
    name: label(r.name) ?? { es: "", en: "" },
    categoryId: null,
    category: null,
    categorySnapshot: false,
    units: 0,
    grossSales: 0,
    discounts: 0,
    salesTotal: 0,
    shareBps: 0,
    cost: null,
    margin: null,
    refundedUnits: n(r.units),
    refunded: n(r.amount),
  }));
  const all = [...sold, ...onlyRefunded].filter(
    (r) => r.units !== 0 || r.salesTotal !== 0 || r.refunded !== 0,
  );
  const total = all.reduce((a, r) => a + r.salesTotal, 0);
  const whole = total + recovery.total;
  for (const r of all) r.shareBps = bps(r.salesTotal, whole);
  all.sort(
    (a, b) =>
      b.salesTotal - a.salesTotal ||
      b.units - a.units ||
      a.name.es.localeCompare(b.name.es, "es") ||
      (a.productId < b.productId ? -1 : 1),
  );
  return { by: "product", rows: all, recovery, total };
}

async function categoryRows(
  tx: Tx,
  range: DateRange,
): Promise<BreakdownResponse & { by: "category" }> {
  const [rows, recovery] = await Promise.all([
    tx<Row[]>`
      with ${categorizedLines(tx, range)}
      select coalesce('id:' || category_id, 'name:' || (category->>'es'), 'none') as key,
        (array_agg(category_id order by snap desc, business_date desc, line_id desc))[1] as category_id,
        (array_agg(category order by snap desc, business_date desc, line_id desc))[1] as category,
        bool_and(snap) as snap,
        coalesce(sum(qty - voided_units), 0)::int8 as units,
        coalesce(sum(total - voided_amount), 0)::int8 as gross,
        coalesce(sum(discount), 0)::int8 as discounts,
        coalesce(sum(unit_cost * (qty - voided_units)) filter (where unit_cost is not null), 0)::int8 as cost,
        count(*) filter (where unit_cost is null)::int as uncosted,
        count(*)::int as lines
      from lc group by 1`,
    recoveryOf(tx, range),
  ]);
  const list = rows.map((r): CategoryRow => {
    const gross = n(r.gross);
    const discounts = n(r.discounts);
    const salesTotal = gross - discounts;
    const lines = n(r.lines);
    const uncosted = n(r.uncosted);
    const cost = uncosted === lines ? null : n(r.cost);
    return {
      key: String(r.key),
      categoryId: (r.category_id as string | null) ?? null,
      name: r.key === "none" ? null : label(r.category),
      snapshot: r.snap === true,
      units: n(r.units),
      grossSales: gross,
      discounts,
      salesTotal,
      shareBps: 0,
      cost,
      margin: uncosted === 0 && cost !== null ? salesTotal - cost : null,
    };
  });
  const all = list.filter((r) => r.units !== 0 || r.salesTotal !== 0);
  const total = all.reduce((a, r) => a + r.salesTotal, 0);
  const whole = total + recovery.total;
  for (const r of all) r.shareBps = bps(r.salesTotal, whole);
  all.sort((a, b) => b.salesTotal - a.salesTotal || (a.key < b.key ? -1 : 1));
  return { by: "category", rows: all, recovery, total };
}

/**
 * Personal: sales, orders, discounts and the check's tips per server (the assigned server,
 * else the creator). Unassigned QR and kiosk orders form the "QR / Kiosco" row (LD-15 Q4).
 */
export async function employeeRows(
  tx: Tx,
  range: DateRange,
): Promise<BreakdownResponse & { by: "employee" }> {
  const rows = await tx<Row[]>`
    with g as (
      select case when o.assigned_employee_id is null and o.channel in ('qr', 'kiosk') then null
                  else coalesce(o.assigned_employee_id, o.employee_id) end as employee_id,
        count(*) filter (where o.total > 0)::int as orders,
        coalesce(sum(o.total), 0)::int8 as sales_total,
        coalesce(sum(o.discount), 0)::int8 as discounts,
        coalesce(sum(p.tip), 0)::int8 as tips
      from orders o
      cross join lateral (select coalesce(sum(t.tip), 0)::int8 as tip from tenders t
                           where t.tenant_id = o.tenant_id and t.order_id = o.id) p
      where o.business_date between ${range.from}::date and ${range.to}::date
      group by 1)
    select g.*, e.name, e.role, e.active from g left join employees e on e.id = g.employee_id
    order by g.sales_total desc, e.name nulls last, g.employee_id nulls last`;
  const list = rows.map((r): EmployeeRow => {
    const salesTotal = n(r.sales_total);
    const orders = n(r.orders);
    return {
      employeeId: (r.employee_id as string | null) ?? null,
      name: (r.name as string | null) ?? "",
      role: r.employee_id === null ? "public" : String(r.role ?? ""),
      active: r.employee_id === null ? true : r.active === true,
      orders,
      salesTotal,
      averageTicket: averageTicket(salesTotal, orders),
      tips: n(r.tips),
      discounts: n(r.discounts),
    };
  });
  return {
    by: "employee",
    rows: list,
    total: list.reduce((a, r) => a + r.salesTotal, 0),
  };
}

/**
 * Por hora: the local wall-clock hour, in the zone in force at that instant, of the sale: the
 * offline sale time (sold_at) for synced offline orders, the original sale time of a manager's
 * financial recovery (offline_recoveries.original_sold_at, not the hour it was reconciled:
 * review REPORTS-SQL-4), else orders.created_at; rows from the cutoff hour.
 */
export async function hourBreakdown(
  tx: Tx,
  s: Session,
  range: DateRange,
  restaurant: ReportRestaurant,
): Promise<BreakdownResponse & { by: "hour" }> {
  const rows = await tx<Row[]>`
    with cfg as (${businessDayCte(tx, s.tenantId)})
    select extract(hour from (x.at at time zone c.timezone))::int as hour,
      count(*) filter (where o.total > 0)::int as orders, coalesce(sum(o.total), 0)::int8 as sales_total
    from orders o
    left join lateral (
      select sr.sold_at from offline_sync_records sr
       where sr.tenant_id = o.tenant_id and sr.order_id = o.id and sr.kind in ('sale', 'order')
       order by sr.sold_at limit 1) sr on true
    left join lateral (
      select r.original_sold_at from offline_recoveries r
       where o.state like 'recovery%' and r.tenant_id = o.tenant_id and r.order_id = o.id
       limit 1) orc on true
    cross join lateral (select coalesce(sr.sold_at, orc.original_sold_at, o.created_at) as at) x
    join cfg c on x.at >= c.valid_from and x.at < c.valid_until
    where o.business_date between ${range.from}::date and ${range.to}::date
    group by 1`;
  const hours = hourRows(
    rows.map((r) => ({
      hour: n(r.hour),
      orders: n(r.orders),
      salesTotal: n(r.sales_total),
    })),
    restaurant.cutoff,
  );
  return {
    by: "hour",
    rows: hours,
    cutoffHour: Math.floor(restaurant.cutoff / 60),
    total: hours.reduce((a, r) => a + r.salesTotal, 0),
  };
}

/** Por canal / Por tipo de servicio: orders and sales per orders.channel or orders.mode. */
export async function groupBreakdown(
  tx: Tx,
  range: DateRange,
  by: "channel" | "mode",
): Promise<BreakdownResponse & { by: "channel" | "mode" }> {
  const column = by === "channel" ? tx`o.channel` : tx`o.mode`;
  const rows = await tx<Row[]>`
    select ${column} as key, count(*) filter (where o.total > 0)::int as orders,
      coalesce(sum(o.total), 0)::int8 as sales_total
    from orders o where o.business_date between ${range.from}::date and ${range.to}::date
    group by 1 order by 3 desc, 1`;
  const total = rows.reduce((a, r) => a + n(r.sales_total), 0);
  return {
    by,
    rows: rows.map((r): ChannelRow => ({
      key: String(r.key),
      orders: n(r.orders),
      salesTotal: n(r.sales_total),
      shareBps: bps(n(r.sales_total), total),
    })),
    total,
  };
}

async function methodRows(
  tx: Tx,
  s: Session,
  range: DateRange,
  restaurant: ReportRestaurant,
): Promise<BreakdownResponse & { by: "method" }> {
  const w = windowOf(range, restaurant);
  const [collections, refunds] = await Promise.all([
    collectionDays(tx, s, range, w),
    refundDays(tx, s, range, w),
  ]);
  const rows = TENDER_METHODS.map((method): MethodTotals => {
    const c = collections.filter((x) => x.method === method);
    const r = refunds.filter((x) => x.method === method);
    const amount = c.reduce((a, x) => a + x.amount, 0);
    const tips = c.reduce((a, x) => a + x.tips, 0);
    const refunded = r.reduce((a, x) => a + x.amount, 0);
    return {
      method,
      count: c.reduce((a, x) => a + x.count, 0),
      amount,
      tips,
      refunds: refunded,
      refundCount: r.reduce((a, x) => a + x.count, 0),
      net: amount + tips - refunded,
    };
  });
  return {
    by: "method",
    rows,
    total: rows.reduce((a, r) => a + r.amount, 0),
  };
}

async function dayRows(
  tx: Tx,
  s: Session,
  range: DateRange,
  restaurant: ReportRestaurant,
): Promise<BreakdownResponse & { by: "day" }> {
  const w = windowOf(range, restaurant);
  const [sales, collections, refunds, paidOuts] = await Promise.all([
    salesDays(tx, range),
    collectionDays(tx, s, range, w),
    refundDays(tx, s, range, w),
    paidOutDays(tx, s, range, w),
  ]);
  // Per-day rows need neither fiscal figures nor checks (spec §4.5 "day").
  const { days, sales: totals } = composeSalesSummary({
    range,
    currency: restaurant.currency,
    generatedAt: new Date().toISOString(),
    currentBusinessDate: currentBusinessDate(restaurant),
    sales,
    lines: [],
    collections,
    refunds,
    restocks: [],
    paidOuts,
    drawers: [],
    tax: null,
  });
  return { by: "day", rows: days, total: totals.salesTotal };
}

/** GET /api/reports/breakdown (≤ 92 days). */
export async function breakdown(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<BreakdownResponse> {
  permit(s, managers);
  const q = breakdownQuery.parse(raw);
  const range = parseRange(q, LIMITS.aggregateDays);
  switch (q.by) {
    case "product":
      return productRows(tx, range);
    case "category":
      return categoryRows(tx, range);
    case "employee":
      return employeeRows(tx, range);
    case "hour":
      return hourBreakdown(tx, s, range, await restaurantOf(tx, s));
    case "channel":
    case "mode":
      return groupBreakdown(tx, range, q.by);
    case "method":
      return methodRows(tx, s, range, await restaurantOf(tx, s));
    case "day":
      return dayRows(tx, s, range, await restaurantOf(tx, s));
  }
}

/** The product rows of a range sorted by units (Hoy's "Más vendidos hoy"). */
export async function topProducts(
  tx: Tx,
  range: DateRange,
  limit = 5,
): Promise<ProductRow[]> {
  const { rows } = await productRows(tx, range);
  return rows
    .filter((r) => r.units > 0)
    .sort((a, b) => b.units - a.units || b.salesTotal - a.salesTotal)
    .slice(0, limit);
}
