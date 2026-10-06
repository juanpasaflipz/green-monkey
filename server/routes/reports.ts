import type express from "express";
import type { PreAuthContext, RouteContext } from "../http.js";
import type { Tx } from "../db.js";
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
import { reportsPorts, type ReportsPorts } from "../reports/ports.js";
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

/** reports area authenticated routes, reading fiscal (027) and discounts (028) through the ports. */
export function register(ctx: RouteContext) {
  registerReports(ctx, reportsPorts);
}

type Read = (tx: Tx, s: Session, req: express.Request) => Promise<unknown>;
type Command = (s: Session, req: express.Request) => Promise<unknown>;

/** Every report route (tests pass their own ports). */
export function registerReports({ app, sql }: RouteContext, p: ReportsPorts) {
  // The helpers are named get and post, the verbs they register, so tests/lock-scan.ts splits
  // every registration below into its own unit (one request, one transaction) instead of
  // chaining all the routes of this function as one transaction.
  /** A report read: one read-only snapshot, never cached (platform C-8). */
  const get = (path: string, fn: Read) =>
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
   * A report command (print, remote close). Each runs its own transactions (cortes.ts: the
   * document from a REPEATABLE READ snapshot, the print number or the close in tenant()); a
   * statement timeout answers reports_timeout (422) like the reads.
   */
  const post = (path: string, fn: Command) =>
    app.post("/api" + path, async (req, res, next) => {
      try {
        const s = (req as AuthRequest).session;
        const out = await fn(s, req);
        res.set("Cache-Control", "no-store");
        res.json(out);
      } catch (e) {
        next(mapReportErrors(e));
      }
    });
  const dateParam = (req: express.Request) =>
    parseRange({ from: req.params.date, to: req.params.date }, 1).from;

  get("/reports/audit", (tx, s, req) => auditLog(tx, s, req.query));
  get("/reports/filters", (tx, s) => reportFilters(tx, s));
  get("/reports/tenders", (tx, s, req) => tenderRows(tx, s, req.query));
  get("/reports/summary", (tx, s, req) =>
    salesSummary(
      tx,
      s,
      parseRange(summaryQuery.parse(req.query), LIMITS.aggregateDays),
      requestIdOf(req),
      p,
    ),
  );
  get("/reports/breakdown", (tx, s, req) => breakdown(tx, s, req.query));
  get("/reports/orders", (tx, s, req) => orderRows(tx, s, req.query));
  get("/reports/exceptions", (tx, s, req) => exceptionRows(tx, s, req.query));
  get("/reports/drawers", (tx, s, req) =>
    drawerList(
      tx,
      s,
      parseRange(drawerListQuery.parse(req.query), LIMITS.aggregateDays),
      p,
    ),
  );
  get("/reports/drawers/:id/corte", (tx, s, req) =>
    drawerCorte(tx, s, id.parse(req.params.id), p),
  );
  get("/reports/days/:date/corte", (tx, s, req) =>
    dayCorte(tx, s, dateParam(req), requestIdOf(req), p),
  );
  get("/reports/today", (tx, s, req) =>
    todaySummary(tx, s, requestIdOf(req), p),
  );
  // Moved from server/index.ts: the old daily report shape for PWA bundles (spec §4.5 legacy).
  get("/report", (tx, s, req) => legacyDailyReport(tx, s, req.query));
  post("/reports/drawers/:id/corte", (s, req) =>
    printDrawerCorte(sql, s, id.parse(req.params.id), req.body, p),
  );
  post("/reports/drawers/:id/close", (s, req) =>
    closeDrawerRemotely(sql, s, id.parse(req.params.id), req.body, p),
  );
  post("/reports/days/:date/corte", (s, req) =>
    printDayCorte(sql, s, dateParam(req), req.body, p, requestIdOf(req)),
  );
}
