import type express from "express";
import type { PreAuthContext, RouteContext } from "../http.js";
import { tenant, type Tx } from "../db.js";
import type { AuthRequest } from "../auth.js";
import { requestIdOf } from "../logging.js";
import { id, type Session } from "../../shared/domain.js";
import {
  drawerListQuery,
  LIMITS,
  parseRange,
  summaryQuery,
} from "../../shared/reports.js";
import { mapReportErrors, snapshotTenant } from "../reports/snapshot.js";
import type { ReportsPorts } from "../reports/ports.js";
import { salesSummary } from "../reports/summary.js";
import { breakdown } from "../reports/breakdowns.js";
import { orderRows, tenderRows } from "../reports/lists.js";
import { exceptionRows } from "../reports/exceptions.js";
import { auditLog } from "../reports/audit-log.js";
import { drawerList } from "../reports/drawers.js";
import {
  closeDrawerRemotely,
  dayCorte,
  drawerCorte,
  printDayCorte,
  printDrawerCorte,
} from "../reports/cortes.js";
import { todaySummary } from "../reports/today.js";
import { legacyDailyReport } from "../reports/legacy.js";
import { reportFilters } from "../reports/filters.js";

/** reports area routes that must run before authentication. */
export function registerPreAuth(_ctx: PreAuthContext) {}

/**
 * reports area authenticated routes. Phase A (before fiscal 027 and discounts 028 merge): the
 * routes whose statements read only wave-1 tables. The rest need fiscal's and discounts'
 * functions; they register once `ports` is built from those modules at reports' merge
 * (docs/REPORTS.md "Merge wiring").
 */
export function register(ctx: RouteContext) {
  registerReports(ctx, null);
}

type Handler = (tx: Tx, s: Session, req: express.Request) => Promise<unknown>;

/** Every report route; the ones that need fiscal (027) or discounts (028) only with `ports`. */
export function registerReports(
  { app, sql }: RouteContext,
  ports: ReportsPorts | null,
) {
  /** A report read: one read-only snapshot, never cached (platform C-8). */
  const read = (path: string, fn: Handler) =>
    app.get("/api" + path, async (req, res, next) => {
      try {
        const s = (req as AuthRequest).session;
        const out = await snapshotTenant(sql, s.tenantId, (tx) =>
          fn(tx, s, req),
        );
        res.set("Cache-Control", "no-store");
        res.json(out);
      } catch (e) {
        next(e);
      }
    });
  /**
   * A report command (print, remote close): one tenant() transaction whose handler raises the
   * statement timeout first; a timeout answers reports_timeout (422) like the reads.
   */
  const write = (path: string, fn: Handler) =>
    app.post("/api" + path, async (req, res, next) => {
      try {
        const s = (req as AuthRequest).session;
        const out = await tenant(sql, s.tenantId, (tx) => fn(tx, s, req));
        res.set("Cache-Control", "no-store");
        res.json(out);
      } catch (e) {
        next(mapReportErrors(e));
      }
    });
  const dateParam = (req: express.Request) =>
    parseRange({ from: req.params.date, to: req.params.date }, 1).from;

  read("/reports/audit", (tx, s, req) => auditLog(tx, s, req.query));
  read("/reports/filters", (tx, s) => reportFilters(tx, s));
  read("/reports/tenders", (tx, s, req) => tenderRows(tx, s, req.query));
  if (!ports) return;
  const p = ports;
  read("/reports/summary", (tx, s, req) =>
    salesSummary(
      tx,
      s,
      parseRange(summaryQuery.parse(req.query), LIMITS.aggregateDays),
      requestIdOf(req),
      p,
    ),
  );
  read("/reports/breakdown", (tx, s, req) => breakdown(tx, s, req.query));
  read("/reports/orders", (tx, s, req) => orderRows(tx, s, req.query));
  read("/reports/exceptions", (tx, s, req) => exceptionRows(tx, s, req.query));
  read("/reports/drawers", (tx, s, req) =>
    drawerList(
      tx,
      s,
      parseRange(drawerListQuery.parse(req.query), LIMITS.aggregateDays),
      p,
    ),
  );
  read("/reports/drawers/:id/corte", (tx, s, req) =>
    drawerCorte(tx, s, id.parse(req.params.id), p),
  );
  read("/reports/days/:date/corte", (tx, s, req) =>
    dayCorte(tx, s, dateParam(req), requestIdOf(req), p),
  );
  read("/reports/today", (tx, s, req) =>
    todaySummary(tx, s, requestIdOf(req), p),
  );
  // Moved from server/index.ts: the old daily report shape for PWA bundles (spec §4.5 legacy).
  read("/report", (tx, s, req) => legacyDailyReport(tx, s, req.query));
  write("/reports/drawers/:id/corte", (tx, s, req) =>
    printDrawerCorte(tx, s, id.parse(req.params.id), req.body, p),
  );
  write("/reports/drawers/:id/close", (tx, s, req) =>
    closeDrawerRemotely(tx, s, id.parse(req.params.id), req.body, p),
  );
  write("/reports/days/:date/corte", (tx, s, req) =>
    printDayCorte(tx, s, dateParam(req), req.body, p),
  );
}
