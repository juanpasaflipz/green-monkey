// Staff routes of kiosk self-checkout and menu photos (039; specs/kiosk-w4.md §4.6), registered
// after public ordering's staff routes and before the /api 404 (critic R31). Every response is
// no-store. The photo upload is the only raw body in the API (express.raw on that route only).
import express from "express";
import type postgres from "postgres";
import type { RouteContext } from "../http.js";
import { managers, permit, type AuthRequest } from "../auth.js";
import { DomainError, id } from "../../shared/domain.js";
import { MEDIA_LIMITS } from "../../shared/media.js";
import {
  createPairing,
  kioskSettingsView,
  listSuggestions,
  revokeKioskDevice,
  saveKioskSettings,
  saveStation,
  saveSuggestions,
} from "../kiosk-settings.js";
import {
  admitUpload,
  recordMediaImport,
  removeProductImage,
  uploadProductImage,
} from "../media.js";
import { kioskReport } from "../kiosk-report.js";
import { snapshotTenant } from "../reports/snapshot.js";

/**
 * POST /api/menu/products/:id/image. Admission runs before express.raw (KV-SECURITY-1): an
 * owner or manager, and a free upload slot (admitUpload: one per restaurant, MEDIA_LIMITS
 * .uploadSlots per process), else the body is never read (403, 429 media_busy). Exported for the
 * kiosk DB suite, which mounts it behind its own session.
 */
export function uploadRoute(app: express.Express, sql: postgres.Sql) {
  const raw = express.raw({
    type: ["application/octet-stream", "image/webp"],
    limit: MEDIA_LIMITS.maxUploadBytes,
  });
  app.post(
    "/api/menu/products/:id/image",
    (req, res, next) => {
      try {
        const s = (req as unknown as AuthRequest).session;
        permit(s, managers);
        const release = admitUpload(s.tenantId);
        if (!release) throw new DomainError("media_busy", 429);
        res.once("finish", release);
        res.once("close", release);
        next();
      } catch (e) {
        res.set("Cache-Control", "no-store");
        next(e);
      }
    },
    (req, res, next) =>
      raw(req, res, (e?: unknown) => {
        if ((e as { type?: string } | undefined)?.type === "entity.too.large")
          return next(new DomainError("media_too_large", 413));
        next(e);
      }),
    async (req, res, next) => {
      try {
        const s = (req as unknown as AuthRequest).session;
        if (!Buffer.isBuffer(req.body))
          throw new DomainError("media_type_unsupported", 415);
        res.set("Cache-Control", "no-store");
        res.json(
          await uploadProductImage(
            sql,
            s,
            {
              operationId: req.get("x-gm-operation-id"),
              productId: id.parse(req.params.id),
              // «Importar fotos»: the run and its item, named in the photo's audit row.
              ...(req.get("x-gm-import")
                ? {
                    importRef: {
                      batchId: req.get("x-gm-import"),
                      sourceId: req.get("x-gm-import-item") ?? "",
                    },
                  }
                : {}),
            },
            req.body,
          ),
        );
      } catch (e) {
        next(e);
      }
    },
  );
}

export function register({ app, sql, route }: RouteContext) {
  // Finanzas › Kiosco: one read-only snapshot, never cached (loyalty's report pattern).
  app.get("/api/kiosk/report", async (req, res, next) => {
    try {
      const s = (req as unknown as AuthRequest).session;
      const out = await snapshotTenant(sql, s.tenantId, (tx) =>
        kioskReport(tx, s, req.query as { from?: unknown; to?: unknown }),
      );
      res.set("Cache-Control", "no-store");
      res.json(out);
    } catch (e) {
      next(e);
    }
  });
  app.use(
    [
      "/api/kiosk",
      "/api/menu/products/:id/image",
      "/api/menu/products/:id/suggestions",
    ],
    (_req, res, next) => {
      res.set("Cache-Control", "no-store");
      next();
    },
  );
  uploadRoute(app, sql);
  route("get", "/kiosk/settings", (tx, s) => kioskSettingsView(tx, s));
  route("post", "/kiosk/settings", (tx, s, req) =>
    saveKioskSettings(tx, s, req.body),
  );
  route("post", "/kiosk/stations/:id", (tx, s, req) =>
    saveStation(tx, s, String(req.params.id), req.body),
  );
  route("post", "/kiosk/stations/:id/pairing", (tx, s, req) =>
    createPairing(tx, s, String(req.params.id)),
  );
  route("post", "/kiosk/devices/:id/revoke", (tx, s, req) =>
    revokeKioskDevice(tx, s, String(req.params.id), req.body),
  );
  route("get", "/kiosk/suggestions", (tx, s) => listSuggestions(tx, s));
  route("post", "/kiosk/cart-suggestions", (tx, s, req) =>
    saveSuggestions(tx, s, null, req.body),
  );
  route("post", "/menu/products/:id/suggestions", (tx, s, req) =>
    saveSuggestions(tx, s, String(req.params.id), req.body),
  );
  route("post", "/menu/media-import", (tx, s, req) =>
    recordMediaImport(tx, s, req.body),
  );
  route("post", "/menu/products/:id/image/remove", (tx, s, req) =>
    removeProductImage(tx, s, String(req.params.id), req.body),
  );
}
