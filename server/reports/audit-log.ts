// Reports (029): the Bitácora (spec §2.8), replacing the fixed newest-100 rows of GET /audit with
// keyset paging over any range of up to 31 days, filters (employee, activity group, order number),
// actor names and a short summary per row. Runs on the 022 index audit_tenant_id_created_at.
import type { Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import type { Session } from "../../shared/domain.js";
import {
  addDays,
  aggregateInt,
  auditGroupPrefixes,
  auditQuery,
  decodeReportCursor,
  encodeReportCursor,
  LIMITS,
  parseRange,
  type AuditRow,
  type Page,
} from "../../shared/reports.js";
import { businessDayCte, isoRequired, windowOf } from "./days.js";
import { restaurantOf } from "./restaurant.js";

type Row = Record<string, unknown>;
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/**
 * The row summary: the first numeric among detail.amount, .counted, .restored, .gross, and the
 * first non-empty text among detail.reason, .note, .reasonCode.
 */
export function auditSummary(detail: unknown): AuditRow["summary"] {
  const d =
    detail && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as Record<string, unknown>)
      : {};
  const amount = ["amount", "counted", "restored", "gross"]
    .map((k) => d[k])
    .find((v): v is number => typeof v === "number" && Number.isSafeInteger(v));
  const reason = ["reason", "note", "reasonCode"]
    .map((k) => d[k])
    .find((v): v is string => typeof v === "string" && v.trim() !== "");
  return { amount: amount ?? null, reason: reason ?? null };
}

/** GET /api/reports/audit: one page of the activity log, newest first. */
export async function auditLog(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<Page<AuditRow>> {
  permit(s, managers);
  const q = auditQuery.parse(raw);
  const range = parseRange(q, LIMITS.listDays);
  // The cursor time reaches SQL as text (::text::timestamptz): a parameter Postgres types as
  // timestamptz is sent by postgres.js as a JS Date, which drops the microseconds.
  const cursor = q.cursor ? decodeReportCursor(q.cursor) : null;
  const restaurant = await restaurantOf(tx, s);
  let orderIds: string[] | null = null;
  if (q.order !== undefined) {
    const found = await tx<Row[]>`
      select id from orders where number = ${q.order}
         and business_date between ${addDays(range.from, -1)}::date and ${addDays(range.to, 1)}::date`;
    if (!found.length) return { rows: [], next: null };
    orderIds = found.map((r) => String(r.id));
  }
  const w = windowOf(range, restaurant);
  const rows = await tx<Row[]>`
    with cfg as (${businessDayCte(tx, s.tenantId)})
    select a.id, a.created_at as at, a.created_at::text as at_text, a.operation, a.entity_id, a.detail,
      a.actor_id, e.name as actor_name, e.role as actor_role, o.number as order_number,
      o.business_date::text as order_date,
      ((a.created_at at time zone c.timezone) - make_interval(mins => c.cutoff))::date::text as business_date
    from audit a
    join cfg c on a.created_at >= c.valid_from and a.created_at < c.valid_until
    left join employees e on e.tenant_id = a.tenant_id and e.id = a.actor_id
    left join orders o on o.tenant_id = a.tenant_id
      and o.id = case when a.entity_id ~ ${UUID} then a.entity_id::uuid end
    where a.created_at >= ${w.ws} and a.created_at < ${w.we}
      and ((a.created_at at time zone c.timezone) - make_interval(mins => c.cutoff))::date
          between ${range.from}::date and ${range.to}::date
      ${q.employee ? tx`and a.actor_id = ${q.employee}` : tx``}
      ${q.group ? tx`and a.operation like any (${tx.array(auditGroupPrefixes(q.group))}::text[])` : tx``}
      ${orderIds ? tx`and a.entity_id = any (${tx.array(orderIds)}::text[])` : tx``}
      ${cursor ? tx`and (a.created_at, a.id) < (${cursor.t}::text::timestamptz, ${cursor.i}::uuid)` : tx``}
    order by a.created_at desc, a.id desc
    limit ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): AuditRow => ({
      id: String(r.id),
      at: isoRequired(r.at),
      businessDate: String(r.business_date),
      operation: String(r.operation),
      actorId: String(r.actor_id),
      actorName: (r.actor_name as string | null) ?? null,
      actorRole: (r.actor_role as string | null) ?? null,
      entityId: String(r.entity_id),
      orderNumber:
        r.order_number === null ? null : aggregateInt(r.order_number),
      orderDate: (r.order_date as string | null) ?? null,
      summary: auditSummary(r.detail),
      detail: r.detail ?? {},
    })),
    next:
      rows.length > q.limit && last
        ? encodeReportCursor({ t: String(last.at_text), i: String(last.id) })
        : null,
  };
}
