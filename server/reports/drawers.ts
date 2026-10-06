// Reports (029): the drawer statement (spec §4.5 drawerList) behind the Cortes table, the Cajas
// card, Hoy's open drawers and every corte X/Z document.
import type { Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import type { Session } from "../../shared/domain.js";
import {
  aggregateInt,
  currentBusinessDate,
  drawerRow,
  parseRange,
  LIMITS,
  type DateRange,
  type DrawerFacts,
  type DrawerRow,
} from "../../shared/reports.js";
import { businessDayCte, iso, isoRequired, windowOf } from "./days.js";
import type { ReportsPorts } from "./ports.js";
import { restaurantOf, type ReportRestaurant } from "./restaurant.js";

type Row = Record<string, unknown>;
const n = aggregateInt;
const nullable = (v: unknown) => (v === null || v === undefined ? null : n(v));

/** One drawer's facts plus what the access rules need. */
export type LoadedDrawer = DrawerFacts & {
  /** No other drawer of the same device was opened after this one (spec §2.12, LD-15 Q6). */
  latestOnDevice: boolean;
};

/**
 * Every figure of the drawers selected by `filter`: the drawers opened in a business-date range
 * plus every drawer still open, or one drawer by id. Sums cover the drawer's own tenders (cash and
 * external, with the part recorded after the close), refunds by method, cash movements (paid-outs
 * and pay-ins), its review and its corte Z print count. The closer is cash_sessions.closed_by
 * (028), or for a drawer closed before 028 the actor of its cash.close audit row. Z numbers are
 * the position among closed drawers ordered by (closed_at, id): computed and gapless, and stable
 * once the closes involved have committed (closed drawers are immutable, 028). Two closes whose
 * commits land in the opposite order of their closed_at can renumber a drawer read between the
 * two commits (docs/REPORTS.md "Numbering", review RPT-R13).
 */
export async function loadDrawers(
  tx: Tx,
  s: Session,
  restaurant: ReportRestaurant,
  filter: { range: DateRange } | { id: string },
): Promise<LoadedDrawer[]> {
  const byRange = "range" in filter;
  const w = byRange ? windowOf(filter.range, restaurant) : null;
  const rows = await tx<Row[]>`
    with cfg as (${businessDayCte(tx, s.tenantId)}),
    d as (
      select c.*, ((c.opened_at at time zone g.timezone) - make_interval(mins => g.cutoff))::date as day
        from cash_sessions c
        join cfg g on c.opened_at >= g.valid_from and c.opened_at < g.valid_until
       where ${
         byRange
           ? tx`((c.opened_at >= ${w!.ws} and c.opened_at < ${w!.we}) or c.closed_at is null)`
           : tx`c.id = ${(filter as { id: string }).id}`
       }
    ),
    z as (
      select id, row_number() over (order by closed_at, id)::int as z_number
        from cash_sessions where closed_at is not null
    )
    select d.id, d.day::text as business_date, z.z_number, d.device_id, dev.name as device_name,
      dev.active as device_active, (dev.revoked_at is not null) as device_revoked,
      d.opened_at, opener.name as opened_by_name, d.closed_at,
      coalesce(closer.name, legacy_closer.name) as closed_by_name, d.opening,
      t.cash_count, t.cash_amount, t.cash_tips, t.cash_late_count, t.cash_late_amount, t.cash_late_tips,
      t.ext_count, t.ext_amount, t.ext_tips, t.ext_late_count, t.ext_late_amount, t.ext_late_tips,
      rf.cash_refunds, rf.ext_refunds, mv.paid_out_count, mv.paid_outs, mv.pay_ins,
      d.expected, d.counted, d.reason, d.count_mode, d.external_expected, d.external_reported,
      rv.note as review_note, rv.created_at as review_at, rv.reviewer_name,
      coalesce(zp.prints, 0) as z_prints,
      not exists (select 1 from cash_sessions nx
                   where nx.tenant_id = d.tenant_id and nx.device_id = d.device_id
                     and (nx.opened_at, nx.id) > (d.opened_at, d.id)) as latest_on_device
    from d
    left join z on z.id = d.id
    join devices dev on dev.tenant_id = d.tenant_id and dev.id = d.device_id
    join employees opener on opener.tenant_id = d.tenant_id and opener.id = d.employee_id
    left join employees closer on closer.tenant_id = d.tenant_id and closer.id = d.closed_by
    left join lateral (
      select a.actor_id from audit a
       where d.closed_by is null and d.closed_at is not null
         and a.tenant_id = d.tenant_id and a.operation = 'cash.close' and a.entity_id = d.id::text
         and a.created_at >= d.closed_at - interval '1 hour' and a.created_at <= d.closed_at + interval '1 minute'
       order by a.created_at limit 1) lc on true
    left join employees legacy_closer on legacy_closer.tenant_id = d.tenant_id and legacy_closer.id = lc.actor_id
    cross join lateral (
      select count(*) filter (where t.method = 'cash')::int as cash_count,
        coalesce(sum(t.amount) filter (where t.method = 'cash'), 0)::int8 as cash_amount,
        coalesce(sum(t.tip) filter (where t.method = 'cash'), 0)::int8 as cash_tips,
        count(*) filter (where t.method = 'cash' and t.created_at > d.closed_at)::int as cash_late_count,
        coalesce(sum(t.amount) filter (where t.method = 'cash' and t.created_at > d.closed_at), 0)::int8 as cash_late_amount,
        coalesce(sum(t.tip) filter (where t.method = 'cash' and t.created_at > d.closed_at), 0)::int8 as cash_late_tips,
        count(*) filter (where t.method = 'external')::int as ext_count,
        coalesce(sum(t.amount) filter (where t.method = 'external'), 0)::int8 as ext_amount,
        coalesce(sum(t.tip) filter (where t.method = 'external'), 0)::int8 as ext_tips,
        count(*) filter (where t.method = 'external' and t.created_at > d.closed_at)::int as ext_late_count,
        coalesce(sum(t.amount) filter (where t.method = 'external' and t.created_at > d.closed_at), 0)::int8 as ext_late_amount,
        coalesce(sum(t.tip) filter (where t.method = 'external' and t.created_at > d.closed_at), 0)::int8 as ext_late_tips
      from tenders t where t.tenant_id = d.tenant_id and t.session_id = d.id) t
    cross join lateral (
      select coalesce(sum(r.amount) filter (where r.method = 'cash'), 0)::int8 as cash_refunds,
        coalesce(sum(r.amount) filter (where r.method = 'external'), 0)::int8 as ext_refunds
      from refunds r where r.tenant_id = d.tenant_id and r.session_id = d.id) rf
    cross join lateral (
      select count(*) filter (where m.amount < 0)::int as paid_out_count,
        coalesce(-sum(m.amount) filter (where m.amount < 0), 0)::int8 as paid_outs,
        coalesce(sum(m.amount) filter (where m.amount > 0), 0)::int8 as pay_ins
      from cash_movements m where m.tenant_id = d.tenant_id and m.session_id = d.id) mv
    left join lateral (
      select r.note, r.created_at, e.name as reviewer_name
        from cash_count_reviews r join employees e on e.tenant_id = r.tenant_id and e.id = r.reviewer_id
       where r.tenant_id = d.tenant_id and r.drawer_id = d.id limit 1) rv on true
    left join lateral (
      select max(p.print_number)::int as prints from report_prints p
       where p.tenant_id = d.tenant_id and p.kind = 'corte_z' and p.subject = d.id::text) zp on true
    ${
      byRange
        ? tx`where d.day between ${filter.range.from}::date and ${filter.range.to}::date or d.closed_at is null`
        : tx``
    }
    order by d.opened_at desc, d.id desc`;
  return rows.map((r) => ({
    id: String(r.id),
    businessDate: String(r.business_date),
    zNumber: r.z_number === null ? null : n(r.z_number),
    deviceId: String(r.device_id),
    deviceName: String(r.device_name),
    deviceActive: r.device_active === true,
    deviceRevoked: r.device_revoked === true,
    openedAt: isoRequired(r.opened_at),
    openedByName: String(r.opened_by_name),
    closedAt: iso(r.closed_at),
    closedByName: r.closed_by_name === null ? null : String(r.closed_by_name),
    opening: n(r.opening),
    cash: {
      count: n(r.cash_count),
      amount: n(r.cash_amount),
      tips: n(r.cash_tips),
      refunds: n(r.cash_refunds),
      lateCount: n(r.cash_late_count),
      lateAmount: n(r.cash_late_amount),
      lateTips: n(r.cash_late_tips),
    },
    external: {
      count: n(r.ext_count),
      amount: n(r.ext_amount),
      tips: n(r.ext_tips),
      refunds: n(r.ext_refunds),
      lateCount: n(r.ext_late_count),
      lateAmount: n(r.ext_late_amount),
      lateTips: n(r.ext_late_tips),
    },
    paidOuts: { count: n(r.paid_out_count), amount: n(r.paid_outs) },
    payIns: n(r.pay_ins),
    stored: {
      expected: nullable(r.expected),
      counted: nullable(r.counted),
      reason: r.reason === null ? null : String(r.reason),
      countMode:
        r.count_mode === "blind" || r.count_mode === "visible"
          ? r.count_mode
          : null,
      externalExpected: nullable(r.external_expected),
      externalReported: nullable(r.external_reported),
    },
    review:
      r.review_at === null || r.review_at === undefined
        ? null
        : {
            reviewerName: String(r.reviewer_name),
            note: String(r.review_note),
            at: isoRequired(r.review_at),
          },
    zPrints: n(r.z_prints),
    latestOnDevice: r.latest_on_device === true,
  }));
}

/**
 * GET /api/reports/drawers: the Cortes table for a range (≤ 92 days), plus every drawer still
 * open. Expected cash of an open drawer is null for a viewer who may not see it during the
 * shift; closed drawers show the stored figures (LD-15 reports Q5 option 2: blind count protects
 * cashiers and servers, who never reach this view).
 */
export async function drawerList(
  tx: Tx,
  s: Session,
  range: DateRange,
  ports: Pick<ReportsPorts, "moneyControls" | "canSeeExpected">,
  restaurant?: ReportRestaurant,
): Promise<DrawerRow[]> {
  permit(s, managers);
  const r = parseRange(range, LIMITS.aggregateDays);
  const settings = restaurant ?? (await restaurantOf(tx, s));
  const [drawers, controls] = await Promise.all([
    loadDrawers(tx, s, settings, { range: r }),
    ports.moneyControls(tx),
  ]);
  const ctx = {
    canSeeExpected: ports.canSeeExpected(s.role, controls),
    currentBusinessDate: currentBusinessDate(settings),
  };
  return drawers.map((f) => drawerRow(f, ctx));
}
