/**
 * Histórico de plataformas routes (041, docs/DELIVERY_HISTORY.md). Authenticated only (register,
 * after authentication). The gm-delivery-sales file travels as a raw application/octet-stream body
 * (040's pattern, routes/sales-history.ts): the managers check runs before express.raw reads any
 * byte, so a cashier or a kitchen session never makes the server buffer a body. Every reply is
 * no-store.
 *
 *   POST /api/delivery-history/preview   the file → what Importar would do (writes nothing)
 *   POST /api/delivery-history/import    the same file + x-gm-file-hash → one import batch (step-up)
 *   GET  /api/delivery-history?from&to   the rows in force for a calendar-date range
 */
import express from "express";
import type { RouteContext } from "../http.js";
import { managers, permit, type AuthRequest } from "../auth.js";
import { tenant } from "../db.js";
import { DomainError } from "../../shared/domain.js";
import { DELIVERY_HISTORY_MAX_BYTES } from "../../shared/delivery-history.js";
import { snapshotTenant } from "../reports/snapshot.js";
import {
  deliveryHistoryReport,
  importDeliveryHistory,
  previewDeliveryHistory,
} from "../delivery-history.js";
import { FILE_HASH_HEADER } from "./sales-history.js";

export { FILE_HASH_HEADER };

export function register({ app, sql }: RouteContext) {
  const raw = express.raw({
    type: "application/octet-stream",
    limit: DELIVERY_HISTORY_MAX_BYTES,
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
        return next(new DomainError("delivery_history_file_too_large", 413));
      next(e);
    });
  app.post("/api/delivery-history/preview", admit, body, async (req, res, next) => {
    try {
      const s = (req as unknown as AuthRequest).session;
      res.json(await tenant(sql, s.tenantId, (tx) => previewDeliveryHistory(tx, s, req.body)));
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/delivery-history/import", admit, body, async (req, res, next) => {
    try {
      const s = (req as unknown as AuthRequest).session;
      res.json(
        await tenant(sql, s.tenantId, (tx) =>
          importDeliveryHistory(tx, s, req.body, req.get(FILE_HASH_HEADER)),
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  // One read-only snapshot (no tenant() retry needed), never cached.
  app.get("/api/delivery-history", async (req, res, next) => {
    try {
      const s = (req as unknown as AuthRequest).session;
      const out = await snapshotTenant(sql, s.tenantId, (tx) =>
        deliveryHistoryReport(tx, s, req.query as { from?: unknown; to?: unknown }),
      );
      res.set("Cache-Control", "no-store");
      res.json(out);
    } catch (e) {
      next(e);
    }
  });
}
