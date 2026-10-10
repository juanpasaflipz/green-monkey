// Staff routes of kiosk self-checkout and menu photos (039; specs/kiosk-w4.md §4.6), registered
// after public ordering's staff routes and before the /api 404 (critic R31). Every response is
// no-store. The photo upload is the only raw body in the API (express.raw on that route only).
import express from "express";
import type postgres from "postgres";
import type { RouteContext } from "../http.js";
import type { AuthRequest } from "../auth.js";
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
import { removeProductImage, uploadProductImage } from "../media.js";

function uploadRoute(app: express.Express, sql: postgres.Sql) {
  const raw = express.raw({
    type: ["application/octet-stream", "image/webp"],
    limit: MEDIA_LIMITS.maxUploadBytes,
  });
  app.post(
    "/api/menu/products/:id/image",
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
  route("post", "/menu/products/:id/image/remove", (tx, s, req) =>
    removeProductImage(tx, s, String(req.params.id), req.body),
  );
}
