// Reports (029): paged row lists (spec §4.5 lists.ts): the orders of a range by business date
// and the tenders of a range by collection date, newest first with keyset paging (≤ 31 days).
import type { Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import type { Session } from "../../shared/domain.js";
import { formatFolio } from "../../shared/fiscal.js";
import {
  aggregateInt,
  decodeReportCursor,
  encodeReportCursor,
  LIMITS,
  orderListQuery,
  parseRange,
  tenderListQuery,
  type OrderReportRow,
  type Page,
  type TenderReportRow,
} from "../../shared/reports.js";
import { businessDayCte, isoRequired, windowOf } from "./days.js";
import { restaurantOf } from "./restaurant.js";
import { collectionCtes } from "./summary.js";

type Row = Record<string, unknown>;
const n = aggregateInt;

/**
 * GET /api/reports/orders: orders with business_date in the range; `state` filters the check
 * state, `employee` the assigned server (else the creator), `channel` the channel.
 */
export async function orderRows(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<Page<OrderReportRow>> {
  permit(s, managers);
  const q = orderListQuery.parse(raw);
  const range = parseRange(q, LIMITS.listDays);
  // The cursor time reaches SQL as text (::text::timestamptz): a parameter Postgres types as
  // timestamptz is sent by postgres.js as a JS Date, which drops the microseconds.
  const cursor = q.cursor ? decodeReportCursor(q.cursor) : null;
  const rows = await tx<Row[]>`
    select o.id, o.number, o.business_date::text as business_date, o.created_at, o.created_at::text as at_text,
      o.channel, o.mode, tb.name as table_name, w.name as waiter_name, o.state, o.check_state,
      o.discount, o.total, p.paid, p.tip, p.refunded, f.series, f.number as folio_number
    from orders o
    cross join lateral (
      select coalesce(sum(t.amount), 0)::int8 as paid, coalesce(sum(t.tip), 0)::int8 as tip,
        coalesce((select sum(r.amount) from refunds r join tenders t2 on t2.tenant_id = r.tenant_id and t2.id = r.tender_id
                   where t2.tenant_id = o.tenant_id and t2.order_id = o.id), 0)::int8 as refunded
        from tenders t where t.tenant_id = o.tenant_id and t.order_id = o.id) p
    left join dining_tables tb on tb.tenant_id = o.tenant_id and tb.id = o.table_id
    left join employees w on w.tenant_id = o.tenant_id and w.id = coalesce(o.assigned_employee_id, o.employee_id)
    left join fiscal_tickets f on f.tenant_id = o.tenant_id and f.order_id = o.id
    where o.business_date between ${range.from}::date and ${range.to}::date
      ${q.state ? tx`and o.check_state = ${q.state}` : tx``}
      ${q.employee ? tx`and coalesce(o.assigned_employee_id, o.employee_id) = ${q.employee}` : tx``}
      ${q.channel ? tx`and o.channel = ${q.channel}` : tx``}
      ${cursor ? tx`and (o.created_at, o.id) < (${cursor.t}::text::timestamptz, ${cursor.i}::uuid)` : tx``}
    order by o.created_at desc, o.id desc
    limit ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): OrderReportRow => {
      const total = n(r.total);
      const discount = n(r.discount);
      const paid = n(r.paid);
      return {
        id: String(r.id),
        number: n(r.number),
        businessDate: String(r.business_date),
        createdAt: isoRequired(r.created_at),
        channel: String(r.channel),
        mode: String(r.mode),
        tableName: (r.table_name as string | null) ?? null,
        waiterName: (r.waiter_name as string | null) ?? null,
        state: String(r.state),
        checkState: String(r.check_state),
        grossSales: total + discount,
        discount,
        total,
        paid,
        outstanding: total - paid,
        tips: n(r.tip),
        refunded: n(r.refunded),
        folio:
          r.series === null || r.series === undefined
            ? null
            : formatFolio(String(r.series), n(r.folio_number)),
      };
    }),
    next:
      rows.length > q.limit && last
        ? encodeReportCursor({ t: String(last.at_text), i: String(last.id) })
        : null,
  };
}

/**
 * GET /api/reports/tenders: tenders whose collection date is in the range (the S3 rule: the
 * offline ledger's sale day, the recovery order's date, else the business date of created_at),
 * newest first; `method` and `drawer` filter. `offline` marks tenders an offline ledger row
 * carries; `source` is tenders.source ("offline_recovery" prints as Recuperado).
 */
export async function tenderRows(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<Page<TenderReportRow>> {
  permit(s, managers);
  const q = tenderListQuery.parse(raw);
  const range = parseRange(q, LIMITS.listDays);
  // The cursor time reaches SQL as text (::text::timestamptz): a parameter Postgres types as
  // timestamptz is sent by postgres.js as a JS Date, which drops the microseconds.
  const cursor = q.cursor ? decodeReportCursor(q.cursor) : null;
  const restaurant = await restaurantOf(tx, s);
  const w = windowOf(range, restaurant);
  const rows = await tx<Row[]>`
    with cfg as (${businessDayCte(tx, s.tenantId)}), ${collectionCtes(tx, range, w)}
    select x.id, x.created_at, x.created_at::text as at_text, x.day::text as collection_date, x.order_id,
      x.order_number, x.order_date::text as order_date, x.method, x.amount, x.tip, x.external_reference,
      x.session_id, dev.name as device_name, x.offline, x.source,
      coalesce((select sum(r.amount) from refunds r where r.tenant_id = x.tenant_id and r.tender_id = x.id), 0)::int8
        as refunded
    from x
    left join cash_sessions cs on cs.tenant_id = x.tenant_id and cs.id = x.session_id
    left join devices dev on dev.tenant_id = cs.tenant_id and dev.id = cs.device_id
    where x.day between ${range.from}::date and ${range.to}::date
      ${q.method ? tx`and x.method = ${q.method}` : tx``}
      ${q.drawer ? tx`and x.session_id = ${q.drawer}` : tx``}
      ${cursor ? tx`and (x.created_at, x.id) < (${cursor.t}::text::timestamptz, ${cursor.i}::uuid)` : tx``}
    order by x.created_at desc, x.id desc
    limit ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): TenderReportRow => ({
      id: String(r.id),
      at: isoRequired(r.created_at),
      collectionDate: String(r.collection_date),
      orderId: String(r.order_id),
      orderNumber: n(r.order_number),
      orderDate: String(r.order_date),
      method: r.method === "external" ? "external" : "cash",
      amount: n(r.amount),
      tip: n(r.tip),
      reference: (r.external_reference as string | null) ?? null,
      drawerId: (r.session_id as string | null) ?? null,
      deviceName: (r.device_name as string | null) ?? null,
      refunded: n(r.refunded),
      offline: r.offline === true,
      source: String(r.source ?? "normal"),
    })),
    next:
      rows.length > q.limit && last
        ? encodeReportCursor({ t: String(last.at_text), i: String(last.id) })
        : null,
  };
}
