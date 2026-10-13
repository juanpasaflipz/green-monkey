/**
 * Histórico POS Lite routes (040, docs/SALES_HISTORY.md). Authenticated only (register, after
 * authentication). The export file travels as a raw application/octet-stream body (the app's JSON
 * parser stops at 256 KB; a pos-lite history is about 1.3 MB): the managers check runs before
 * express.raw reads any byte, as kiosk's photo upload does (KV-SECURITY-1), so a cashier or a
 * kitchen session never makes the server buffer a body. Every reply is no-store.
 *
 *   POST /api/sales-history/preview   the file → what Importar would do (writes nothing)
 *   POST /api/sales-history/import    the same file + x-gm-file-hash → one import batch (step-up)
 *   GET  /api/sales-history?from&to   the history in force for a business-date range
 */
import express from "express";
import type { RouteContext } from "../http.js";
import { managers, permit, type AuthRequest } from "../auth.js";
import { tenant } from "../db.js";
import { DomainError } from "../../shared/domain.js";
import { SALES_HISTORY_MAX_BYTES } from "../../shared/sales-history.js";
import { snapshotTenant } from "../reports/snapshot.js";
import {
  importSalesHistory,
  previewSalesHistory,
  salesHistoryReport,
} from "../sales-history.js";

export const FILE_HASH_HEADER = "x-gm-file-hash";

export function register({ app, sql }: RouteContext) {
  const raw = express.raw({
    type: "application/octet-stream",
    limit: SALES_HISTORY_MAX_BYTES,
  });
  const admit: express.RequestHandler = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      permit((req as unknown as AuthRequest).session, managers);
      next();
    } catch (e) {
      next(e);
    }
  };
  const body: express.RequestHandler = (req, res, next) =>
    raw(req, res, (e?: unknown) => {
      if ((e as { type?: string } | undefined)?.type === "entity.too.large")
        return next(new DomainError("sales_history_file_too_large", 413));
      next(e);
    });
  app.post("/api/sales-history/preview", admit, body, async (req, res, next) => {
    try {
      const s = (req as unknown as AuthRequest).session;
      res.json(await tenant(sql, s.tenantId, (tx) => previewSalesHistory(tx, s, req.body)));
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/sales-history/import", admit, body, async (req, res, next) => {
    try {
      const s = (req as unknown as AuthRequest).session;
      res.json(
        await tenant(sql, s.tenantId, (tx) =>
          importSalesHistory(tx, s, req.body, req.get(FILE_HASH_HEADER)),
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  // One read-only snapshot (no tenant() retry needed), never cached.
  app.get("/api/sales-history", async (req, res, next) => {
    try {
      const s = (req as unknown as AuthRequest).session;
      const out = await snapshotTenant(sql, s.tenantId, (tx) =>
        salesHistoryReport(tx, s, req.query as { from?: unknown; to?: unknown }),
      );
      res.set("Cache-Control", "no-store");
      res.json(out);
    } catch (e) {
      next(e);
    }
  });
}
