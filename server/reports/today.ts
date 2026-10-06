// Reports (029): Hoy, the live view of the current business date (spec §2.4), and its alerts.
import type { Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import type { Session } from "../../shared/domain.js";
import {
  addDays,
  aggregateInt,
  currentBusinessDate,
  failedCheckCodes,
  type DrawerRow,
  type ReportAlert,
  type SalesSummary,
  type TodaySummary,
} from "../../shared/reports.js";
import { topProducts } from "./breakdowns.js";
import { exceptionDayTotals } from "./exceptions.js";
import { fiscalCurrency, type ReportsPorts } from "./ports.js";
import { restaurantOf, type ReportRestaurant } from "./restaurant.js";
import { summaryWithDrawers } from "./summary.js";

type Row = Record<string, unknown>;
const n = aggregateInt;

/**
 * The alerts of Hoy, in display order: failed checks; orphan drawers of a revoked or inactive
 * device; drawers open since an earlier business day on an active device; paid sales without a
 * fiscal ticket; unreviewed drawer differences of the last 31 days; offline rounds awaiting a
 * kitchen decision.
 */
export async function collectAlerts(
  tx: Tx,
  s: Session,
  summary: SalesSummary,
  drawers: readonly DrawerRow[],
  ports: Pick<ReportsPorts, "missingTicketCount">,
  restaurant: ReportRestaurant,
): Promise<ReportAlert[]> {
  const alerts: ReportAlert[] = [];
  const failed = failedCheckCodes(summary.checks);
  if (failed.length)
    alerts.push({ code: "checks_mismatch", count: failed.length });
  const [counts] = await tx<Row[]>`
    select
      (select count(*)::int from cash_sessions c
        where c.closed_at >= now() - interval '31 days' and c.counted <> c.expected
          and not exists (select 1 from cash_count_reviews r
                           where r.tenant_id = c.tenant_id and r.drawer_id = c.id)) as unreviewed,
      (select count(*)::int from offline_kitchen_reviews where state = 'pending') as offline_pending,
      (select coalesce(array_agg(id::text), '{}') from devices where revoked_at is not null) as revoked`;
  const revoked = new Set((counts.revoked as string[] | null) ?? []);
  const open = drawers.filter((d) => d.status === "open");
  const gone = (d: DrawerRow) => !d.deviceActive || revoked.has(d.deviceId);
  for (const d of open.filter(gone))
    alerts.push({
      code: "drawer_revoked_device",
      count: 1,
      deviceName: d.deviceName,
      since: d.businessDate,
    });
  for (const d of open.filter((x) => !gone(x) && x.openSinceEarlierDay))
    alerts.push({
      code: "drawer_open_long",
      count: 1,
      deviceName: d.deviceName,
      since: d.businessDate,
    });
  if (fiscalCurrency(restaurant.currency)) {
    const missing = await ports.missingTicketCount(tx);
    if (missing > 0) alerts.push({ code: "missing_tickets", count: missing });
  }
  if (n(counts.unreviewed) > 0)
    alerts.push({ code: "drawer_unreviewed", count: n(counts.unreviewed) });
  if (n(counts.offline_pending) > 0)
    alerts.push({
      code: "offline_review_pending",
      count: n(counts.offline_pending),
    });
  // cfdi (030): alerts.push(...cfdiAlerts mapped)
  return alerts;
}

/** GET /api/reports/today. */
export async function todaySummary(
  tx: Tx,
  s: Session,
  requestId: string,
  ports: ReportsPorts,
): Promise<TodaySummary> {
  permit(s, managers);
  const restaurant = await restaurantOf(tx, s);
  const date = currentBusinessDate(restaurant);
  const range = { from: date, to: date };
  const [{ summary, drawers }, [week], top, exceptions] = await Promise.all([
    summaryWithDrawers(tx, s, range, requestId, ports),
    tx<Row[]>`
      select count(*)::int as day_orders,
        coalesce(sum(total) filter (where created_at < now() - interval '7 days'), 0)::int8 as until_now
        from orders where business_date = ${addDays(date, -7)}::date`,
    topProducts(tx, range, 5),
    exceptionDayTotals(tx, s, range, restaurant),
  ]);
  return {
    businessDate: date,
    cutoff: restaurant.cutoff,
    generatedAt: new Date().toISOString(),
    summary,
    lastWeek:
      n(week.day_orders) > 0
        ? { date: addDays(date, -7), salesTotalUntilNow: n(week.until_now) }
        : null,
    openDrawers: drawers
      .filter((d) => d.status === "open")
      .map((d) => ({
        id: d.id,
        deviceName: d.deviceName,
        openedAt: d.openedAt,
        openedByName: d.openedByName,
        payments: d.payments,
        expected: d.expected,
      })),
    topProducts: top,
    exceptions,
    alerts: await collectAlerts(tx, s, summary, drawers, ports, restaurant),
  };
}
