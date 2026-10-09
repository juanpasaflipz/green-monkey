// Reports (029): the loss-prevention exceptions report (GAP-3, spec §2.7): every void,
// discount, discount removal, refund, cash paid-out, drawer and terminal difference, receipt and
// corte Z reprint, open-price line, archived or reconciled offline sale and reviewable platform
// tender (payments 037, LD-75) of a range, with
// actor, approver, amount, order, reason and device, newest first with keyset paging.
import type { Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import type { Session } from "../../shared/domain.js";
import {
  aggregateInt,
  decodeReportCursor,
  encodeReportCursor,
  exceptionQuery,
  exceptionSummary,
  exceptionTotals,
  LIMITS,
  parseExceptionKinds,
  parseRange,
  type DateRange,
  type ExceptionKind,
  type ExceptionPage,
  type ExceptionRow,
  type ExceptionTotals,
} from "../../shared/reports.js";
import { businessDayCte, isoRequired, windowOf } from "./days.js";
import { restaurantOf, type ReportRestaurant } from "./restaurant.js";

type Row = Record<string, unknown>;
const n = aggregateInt;
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/**
 * The CTE body `ex(kind, id, at, at_text, actor_id, approver_id, account_id, amount, order_id,
 * reason_code, note, device_id, detail, day)`: one row per exception whose bucketing date is in
 * the range. Rows are bucketed by the business date of their event time under the settings in
 * force then, except refunds (the batch's business date) and open-price lines (the order's
 * business date). Each branch scans its time index within the wide window (or the business-date
 * index). Requires `cfg` in the same WITH list. Audit entity ids are text and cast only when
 * they look like a uuid; detail numbers are read only when they are JSON numbers.
 */
export function exceptionsCte(
  tx: Tx,
  range: DateRange,
  w: { ws: string; we: string },
) {
  const day = (instant: string) =>
    tx.unsafe(
      `((${instant} at time zone c.timezone) - make_interval(mins => c.cutoff))::date`,
    );
  const cfgOn = (instant: string) =>
    tx.unsafe(
      `join cfg c on ${instant} >= c.valid_from and ${instant} < c.valid_until`,
    );
  return tx`
    select 'void'::text as kind, v.id, v.created_at as at, v.actor_id, v.approver_id, null::uuid as account_id,
      v.amount::int8 as amount, v.order_id, null::text as reason_code, v.reason as note, null::uuid as device_id,
      jsonb_build_object('units', cardinality(v.units), 'name', l.data->'name',
        'preparationState', v.preparation_state, 'stockDisposition', v.stock_disposition) as detail,
      ${day("v.created_at")} as day
      from line_voids v
      join order_lines l on l.tenant_id = v.tenant_id and l.id = v.line_id
      ${cfgOn("v.created_at")}
     where v.created_at >= ${w.ws} and v.created_at < ${w.we}
    union all
    select 'discount', x.id, x.created_at, x.actor_id, x.approver_id, null, x.amount::int8, x.order_id,
      x.reason_code, x.note, x.device_id,
      jsonb_build_object('discountKind', x.kind, 'scope', x.scope, 'percentBps', x.percent_bps, 'units', x.units,
        'lineName', l.data->'name', 'reversed', x.reversed_at is not null),
      ${day("x.created_at")}
      from discounts x
      left join order_lines l on l.tenant_id = x.tenant_id and l.id = x.line_id
      ${cfgOn("x.created_at")}
     where x.created_at >= ${w.ws} and x.created_at < ${w.we}
    union all
    select 'discount_reversal', a.id, a.created_at, a.actor_id, x.reversal_approver_id, null,
      coalesce(x.reversed_amount,
               case when jsonb_typeof(a.detail->'restored') = 'number' then (a.detail->>'restored')::int8 end, 0)::int8,
      coalesce(x.order_id, case when a.entity_id ~ ${UUID} then a.entity_id::uuid end),
      x.reason_code, coalesce(x.reversal_note, a.detail->>'note', ''), x.device_id,
      jsonb_build_object('discountId', x.id, 'discountKind', x.kind),
      ${day("a.created_at")}
      from audit a
      left join discounts x on x.tenant_id = a.tenant_id
        and x.id = case when a.detail->>'discountId' ~ ${UUID} then (a.detail->>'discountId')::uuid end
      ${cfgOn("a.created_at")}
     where a.created_at >= ${w.ws} and a.created_at < ${w.we} and a.operation = 'discount.reversed'
    union all
    select 'refund', b.id, b.created_at, b.actor_id, b.approver_id, null, b.amount::int8, b.order_id,
      b.reason_code, b.note, b.device_id,
      jsonb_build_object('mode', b.mode, 'cash', b.cash_amount, 'external', b.external_amount,
        'platform', b.platform_amount, 'restock', b.restock),
      b.business_date
      from refund_batches b
     where b.business_date between ${range.from}::date and ${range.to}::date
    union all
    select 'refund', r.id, r.created_at, r.actor_id, null, null, r.amount::int8, t.order_id,
      null, r.reason, cs.device_id,
      jsonb_build_object('mode', 'legacy',
        'cash', case when r.method = 'cash' then r.amount else 0 end,
        'external', case when r.method = 'external' then r.amount else 0 end,
        'platform', case when r.method = 'platform' then r.amount else 0 end, 'restock', false),
      ${day("r.created_at")}
      from refunds r
      join tenders t on t.tenant_id = r.tenant_id and t.id = r.tender_id
      left join cash_sessions cs on cs.tenant_id = r.tenant_id and cs.id = r.session_id
      ${cfgOn("r.created_at")}
     where r.created_at >= ${w.ws} and r.created_at < ${w.we} and r.batch_id is null
    union all
    select 'paid_out', a.id, a.created_at, a.actor_id, null, null,
      coalesce(case when jsonb_typeof(a.detail->'amount') = 'number' then (a.detail->>'amount')::int8 end, 0),
      null, null, coalesce(a.detail->>'reason', ''), cs.device_id, '{}'::jsonb,
      ${day("a.created_at")}
      from audit a
      left join cash_sessions cs on cs.tenant_id = a.tenant_id
        and cs.id = case when a.entity_id ~ ${UUID} then a.entity_id::uuid end
      ${cfgOn("a.created_at")}
     where a.created_at >= ${w.ws} and a.created_at < ${w.we} and a.operation = 'cash.paidout'
    union all
    select 'drawer_difference', cs.id, cs.closed_at, coalesce(cs.closed_by, lc.actor_id), rv.reviewer_id, null,
      (cs.counted - cs.expected)::int8, null, null, coalesce(cs.reason, ''), cs.device_id,
      jsonb_build_object('countMode', cs.count_mode, 'reviewNote', rv.note),
      ${day("cs.closed_at")}
      from cash_sessions cs
      left join cash_count_reviews rv on rv.tenant_id = cs.tenant_id and rv.drawer_id = cs.id
      left join lateral (
        select a.actor_id from audit a
         where cs.closed_by is null and a.tenant_id = cs.tenant_id and a.operation = 'cash.close'
           and a.entity_id = cs.id::text
           and a.created_at >= cs.closed_at - interval '1 hour' and a.created_at <= cs.closed_at + interval '1 minute'
         order by a.created_at limit 1) lc on true
      ${cfgOn("cs.closed_at")}
     where cs.closed_at >= ${w.ws} and cs.closed_at < ${w.we} and cs.counted <> cs.expected
    union all
    select 'terminal_difference', cs.id, cs.closed_at, coalesce(cs.closed_by, lc.actor_id), null, null,
      (cs.external_reported - cs.external_expected)::int8, null, null, '', cs.device_id, '{}'::jsonb,
      ${day("cs.closed_at")}
      from cash_sessions cs
      left join lateral (
        select a.actor_id from audit a
         where cs.closed_by is null and a.tenant_id = cs.tenant_id and a.operation = 'cash.close'
           and a.entity_id = cs.id::text
           and a.created_at >= cs.closed_at - interval '1 hour' and a.created_at <= cs.closed_at + interval '1 minute'
         order by a.created_at limit 1) lc on true
      ${cfgOn("cs.closed_at")}
     where cs.closed_at >= ${w.ws} and cs.closed_at < ${w.we}
       and cs.external_reported is not null and cs.external_expected is not null
       and cs.external_reported <> cs.external_expected
       -- payments (037): a close that typed batch totals per terminal is listed per terminal below.
       and not exists (select 1 from drawer_terminal_counts dc
                        where dc.tenant_id = cs.tenant_id and dc.drawer_id = cs.id)
    union all
    select 'terminal_difference', dc.id, cs.closed_at, coalesce(cs.closed_by, lc.actor_id), null, null,
      (dc.reported - dc.expected)::int8, null, null, '', cs.device_id,
      jsonb_build_object('terminalId', dc.terminal_id, 'terminal', pt.name),
      ${day("cs.closed_at")}
      from drawer_terminal_counts dc
      join cash_sessions cs on cs.tenant_id = dc.tenant_id and cs.id = dc.drawer_id
      left join payment_terminals pt on pt.tenant_id = dc.tenant_id and pt.id = dc.terminal_id
      left join lateral (
        select a.actor_id from audit a
         where cs.closed_by is null and a.tenant_id = cs.tenant_id and a.operation = 'cash.close'
           and a.entity_id = cs.id::text
           and a.created_at >= cs.closed_at - interval '1 hour' and a.created_at <= cs.closed_at + interval '1 minute'
         order by a.created_at limit 1) lc on true
      ${cfgOn("cs.closed_at")}
     where cs.closed_at >= ${w.ws} and cs.closed_at < ${w.we}
       and dc.reported is not null and dc.reported <> dc.expected
    union all
    select 'reprint', a.id, a.created_at, a.actor_id, null, null, 0::int8,
      case when a.entity_id ~ ${UUID} then a.entity_id::uuid end, null, coalesce(a.detail->>'reason', ''),
      null, jsonb_build_object('document', a.detail->'document'),
      ${day("a.created_at")}
      from audit a
      ${cfgOn("a.created_at")}
     where a.created_at >= ${w.ws} and a.created_at < ${w.we} and a.operation = 'receipt.reprinted'
    union all
    select 'corte_reprint', p.id, p.created_at, p.actor_id, null, null, 0::int8, null, null, '', p.device_id,
      jsonb_build_object('printNumber', p.print_number, 'drawerId', p.subject,
        'zNumber', (select count(*)::int from cash_sessions z, cash_sessions me
                     where me.tenant_id = p.tenant_id and me.id::text = p.subject and me.closed_at is not null
                       and z.tenant_id = me.tenant_id and z.closed_at is not null
                       and (z.closed_at, z.id) <= (me.closed_at, me.id))),
      ${day("p.created_at")}
      from report_prints p
      ${cfgOn("p.created_at")}
     where p.created_at >= ${w.ws} and p.created_at < ${w.we} and p.kind = 'corte_z' and p.print_number > 1
    union all
    select 'open_price', l.id, coalesce(rd.created_at, o.created_at), null, null,
      coalesce(o.assigned_employee_id, o.employee_id), (l.data->>'total')::int8, o.id, null, '', null,
      jsonb_build_object('quantity', (l.data->>'quantity')::int, 'name', l.data->'name',
        'unitPrice', (l.data->>'unitPrice')::int8),
      o.business_date
      from orders o
      join order_lines l on l.tenant_id = o.tenant_id and l.order_id = o.id
      left join lateral (
        select r.created_at from rounds r
         where r.tenant_id = l.tenant_id and r.order_id = l.order_id and r.number = l.round
           and r.station = l.data->>'station' limit 1) rd on true
     where o.business_date between ${range.from}::date and ${range.to}::date
       and jsonb_typeof(l.data->'openAmount') = 'number'
    union all
    select 'offline_archive', a.id, a.created_at, a.actor_id, null, null,
      coalesce(oa.amount + oa.tip,
        coalesce(case when jsonb_typeof(a.detail->'amount') = 'number' then (a.detail->>'amount')::int8 end, 0)
        + coalesce(case when jsonb_typeof(a.detail->'tip') = 'number' then (a.detail->>'tip')::int8 end, 0))::int8,
      null, null, coalesce(oa.reason, a.detail->>'reason', ''), oa.claimed_device_id,
      jsonb_build_object('recordKind', coalesce(oa.kind, a.detail->>'kind'), 'localError', oa.local_error),
      ${day("a.created_at")}
      from audit a
      left join offline_archives oa on oa.tenant_id = a.tenant_id
        and oa.operation_id = case when a.entity_id ~ ${UUID} then a.entity_id::uuid end
      ${cfgOn("a.created_at")}
     where a.created_at >= ${w.ws} and a.created_at < ${w.we} and a.operation = 'offline.archived'
    union all
    select 'offline_reconcile', a.id, a.created_at, a.actor_id, null, null,
      (case when a.operation = 'offline.payment_reconciled'
            then coalesce(case when jsonb_typeof(a.detail->'amount') = 'number' then (a.detail->>'amount')::int8 end, 0)
                 + coalesce(case when jsonb_typeof(a.detail->'tip') = 'number' then (a.detail->>'tip')::int8 end, 0)
            else coalesce(rt.amount + rt.tip, 0) end)::int8,
      case when a.entity_id ~ ${UUID} then a.entity_id::uuid end, null, coalesce(a.detail->>'reason', ''), null,
      jsonb_build_object('path', a.operation, 'method', coalesce(a.detail->>'method', rt.method)),
      ${day("a.created_at")}
      from audit a
      left join offline_recoveries orc on a.operation = 'offline.reconciled' and orc.tenant_id = a.tenant_id
        and orc.id = case when a.detail->>'recoveryId' ~ ${UUID} then (a.detail->>'recoveryId')::uuid end
      left join tenders rt on rt.tenant_id = orc.tenant_id and rt.id = orc.tender_id
      ${cfgOn("a.created_at")}
     where a.created_at >= ${w.ws} and a.created_at < ${w.we}
       and a.operation in ('offline.reconciled', 'offline.payment_reconciled')
    union all
    -- payments (037, LD-75, PAYMENTS-SECURITY-1): platform tenders a manager reviews: «Otra», an
    -- order not rung at that platform's price list, or offline evidence that broke an online
    -- rule. The actor is the one payment.recorded names for the tender, else the drawer's.
    select 'platform_tender', t.id, t.created_at, coalesce(pa.actor_id, cs.employee_id), null, null,
      t.amount::int8, t.order_id,
      case when pa.detail ? 'platformRulesSkipped' then 'payments_platform_rule_skipped'
           when t.platform = 'other' then 'payments_platform_other'
           else 'payments_platform_no_price_list' end,
      '', cs.device_id,
      jsonb_build_object('platform', t.platform, 'label', t.platform_label, 'priceList', o.price_platform,
        'reference', t.external_reference, 'source', t.source, 'rulesSkipped', pa.detail->'platformRulesSkipped'),
      ${day("t.created_at")}
      from tenders t
      join orders o on o.tenant_id = t.tenant_id and o.id = t.order_id
      left join cash_sessions cs on cs.tenant_id = t.tenant_id and cs.id = t.session_id
      left join lateral (
        select a.actor_id, a.detail from audit a
         where a.tenant_id = t.tenant_id and a.operation = 'payment.recorded'
           -- same transaction as the tender (both now()); the window keeps the time index.
           and a.created_at >= t.created_at - interval '1 minute' and a.created_at <= t.created_at + interval '1 minute'
           and a.entity_id = t.order_id::text and a.detail->>'tenderId' = t.id::text
         limit 1) pa on true
      ${cfgOn("t.created_at")}
     where t.created_at >= ${w.ws} and t.created_at < ${w.we} and t.method = 'platform'
       and (t.platform = 'other' or o.price_platform is distinct from t.platform
            or pa.detail ? 'platformRulesSkipped')
    union all
    -- payments (037 P2): an approved terminal charge the order could not take (review), at the
    -- time it went to review; the actor is who started the charge.
    select 'terminal_attempt_review', e.id, e.created_at, pa.employee_id, null, null,
      coalesce(pa.paid_amount, pa.amount + pa.tip)::int8, pa.order_id, e.detail->>'code', '', pa.device_id,
      jsonb_build_object('attemptId', pa.id, 'terminal', pa.terminal_label, 'provider', pa.provider,
        'state', pa.state, 'target', pa.target),
      ${day("e.created_at")}
      from payment_attempt_events e
      join payment_attempts pa on pa.tenant_id = e.tenant_id and pa.id = e.attempt_id
      ${cfgOn("e.created_at")}
     where e.created_at >= ${w.ws} and e.created_at < ${w.we} and e.kind = 'review'
    union all
    -- ...and every manager resolution (recorded, not charged, refunded at the provider), with the
    -- manager and the reason.
    select 'terminal_attempt_dismissed', pa.id, pa.resolved_at, pa.employee_id, pa.resolved_by, null,
      (pa.amount + pa.tip)::int8, pa.order_id, pa.resolution, coalesce(pa.resolution_note, ''), pa.device_id,
      jsonb_build_object('attemptId', pa.id, 'terminal', pa.terminal_label, 'provider', pa.provider,
        'resolution', pa.resolution, 'target', pa.target),
      ${day("pa.resolved_at")}
      from payment_attempts pa
      ${cfgOn("pa.resolved_at")}
     where pa.resolved_at >= ${w.ws} and pa.resolved_at < ${w.we} and pa.resolution is not null
    union all
    -- ...and charges whose outcome is still unknown after 10 minutes (spec §8).
    select 'terminal_attempt_unknown_open', pa.id, pa.created_at, pa.employee_id, null, null,
      (pa.amount + pa.tip)::int8, pa.order_id, pa.error_code, '', pa.device_id,
      jsonb_build_object('attemptId', pa.id, 'terminal', pa.terminal_label, 'provider', pa.provider,
        'target', pa.target),
      ${day("pa.created_at")}
      from payment_attempts pa
      ${cfgOn("pa.created_at")}
     where pa.created_at >= ${w.ws} and pa.created_at < ${w.we} and pa.state = 'unknown'
       and pa.created_at < now() - interval '10 minutes'`;
}

type Filters = { kinds: ExceptionKind[]; employee?: string };

function filtered(tx: Tx, range: DateRange, f: Filters) {
  return tx`
    ex.day between ${range.from}::date and ${range.to}::date
    and ex.kind = any (${tx.array(f.kinds)}::text[])
    ${
      f.employee
        ? tx`and (ex.actor_id = ${f.employee} or ex.approver_id = ${f.employee} or ex.account_id = ${f.employee})`
        : tx``
    }`;
}

/** Totals per kind and the per-employee summary rows: every matching row, minimal columns. */
async function summaryRows(
  tx: Tx,
  s: Session,
  range: DateRange,
  restaurant: ReportRestaurant,
  f: Filters,
): Promise<ExceptionRow[]> {
  const w = windowOf(range, restaurant);
  const rows = await tx<Row[]>`
    with cfg as (${businessDayCte(tx, s.tenantId)}), ex as (${exceptionsCte(tx, range, w)})
    select ex.kind, ex.id, ex.actor_id, ex.approver_id, ex.account_id, ex.amount,
      actor.name as actor_name, approver.name as approver_name, account.name as account_name
      from ex
      left join employees actor on actor.tenant_id = ${s.tenantId} and actor.id = ex.actor_id
      left join employees approver on approver.tenant_id = ${s.tenantId} and approver.id = ex.approver_id
      left join employees account on account.tenant_id = ${s.tenantId} and account.id = ex.account_id
     where ${filtered(tx, range, f)}`;
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind as ExceptionKind,
    at: "",
    businessDate: "",
    actorId: (r.actor_id as string | null) ?? null,
    actorName: (r.actor_name as string | null) ?? null,
    approverId: (r.approver_id as string | null) ?? null,
    approverName: (r.approver_name as string | null) ?? null,
    accountId: (r.account_id as string | null) ?? null,
    accountName: (r.account_name as string | null) ?? null,
    amount: n(r.amount),
    orderId: null,
    orderNumber: null,
    orderDate: null,
    reasonCode: null,
    note: "",
    deviceName: null,
    detail: {},
  }));
}

/** The Excepciones tiles of a range (Hoy and the corte del día use one day). */
export async function exceptionDayTotals(
  tx: Tx,
  s: Session,
  range: DateRange,
  restaurant?: ReportRestaurant,
): Promise<ExceptionTotals[]> {
  const r = restaurant ?? (await restaurantOf(tx, s));
  return exceptionTotals(
    await summaryRows(tx, s, range, r, { kinds: parseExceptionKinds("") }),
  );
}

/**
 * GET /api/reports/exceptions (≤ 31 days): one page, newest first, keyset (at, kind, id); the
 * summary (tiles and per employee) comes with the first page only. The employee filter matches
 * the actor, the approver or, for open-price lines, the check's server.
 */
export async function exceptionRows(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<ExceptionPage> {
  permit(s, managers);
  const q = exceptionQuery.parse(raw);
  const range = parseRange(q, LIMITS.listDays);
  const f: Filters = {
    kinds: parseExceptionKinds(q.kinds),
    employee: q.employee,
  };
  // The cursor time reaches SQL as text (::text::timestamptz): a parameter Postgres types as
  // timestamptz is sent by postgres.js as a JS Date, which drops the microseconds.
  const cursor = q.cursor ? decodeReportCursor(q.cursor) : null;
  const restaurant = await restaurantOf(tx, s);
  const w = windowOf(range, restaurant);
  const [rows, summary] = await Promise.all([
    tx<Row[]>`
      with cfg as (${businessDayCte(tx, s.tenantId)}), ex as (${exceptionsCte(tx, range, w)})
      select ex.kind, ex.id, ex.at, ex.at::text as at_text, ex.day::text as business_date,
        ex.actor_id, actor.name as actor_name, ex.approver_id, approver.name as approver_name,
        ex.account_id, account.name as account_name, ex.amount, ex.order_id, o.number as order_number,
        o.business_date::text as order_date, ex.reason_code, ex.note, dev.name as device_name, ex.detail
        from ex
        left join employees actor on actor.tenant_id = ${s.tenantId} and actor.id = ex.actor_id
        left join employees approver on approver.tenant_id = ${s.tenantId} and approver.id = ex.approver_id
        left join employees account on account.tenant_id = ${s.tenantId} and account.id = ex.account_id
        left join orders o on o.tenant_id = ${s.tenantId} and o.id = ex.order_id
        left join devices dev on dev.tenant_id = ${s.tenantId} and dev.id = ex.device_id
       where ${filtered(tx, range, f)}
         ${
           cursor
             ? tx`and (ex.at, ex.kind, ex.id) < (${cursor.t}::text::timestamptz, ${cursor.k ?? ""}::text, ${cursor.i}::uuid)`
             : tx``
         }
       order by ex.at desc, ex.kind desc, ex.id desc
       limit ${q.limit + 1}`,
    cursor
      ? Promise.resolve(null)
      : summaryRows(tx, s, range, restaurant, f).then(exceptionSummary),
  ]);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): ExceptionRow => ({
      id: String(r.id),
      kind: r.kind as ExceptionKind,
      at: isoRequired(r.at),
      businessDate: String(r.business_date),
      actorId: (r.actor_id as string | null) ?? null,
      actorName: (r.actor_name as string | null) ?? null,
      approverId: (r.approver_id as string | null) ?? null,
      approverName: (r.approver_name as string | null) ?? null,
      accountId: (r.account_id as string | null) ?? null,
      accountName: (r.account_name as string | null) ?? null,
      amount: n(r.amount),
      orderId: (r.order_id as string | null) ?? null,
      orderNumber: r.order_number === null ? null : n(r.order_number),
      orderDate: (r.order_date as string | null) ?? null,
      reasonCode: (r.reason_code as string | null) ?? null,
      note: String(r.note ?? ""),
      deviceName: (r.device_name as string | null) ?? null,
      detail: (r.detail as Record<string, unknown>) ?? {},
    })),
    next:
      rows.length > q.limit && last
        ? encodeReportCursor({
            t: String(last.at_text),
            i: String(last.id),
            k: last.kind as ExceptionKind,
          })
        : null,
    summary,
  };
}
