import type { AuthRequest } from "../auth.js";
import { tenant } from "../db.js";
import type { PreAuthContext, RouteContext } from "../http.js";
import {
  handle,
  portalAccess,
  portalFile,
  portalLimiter,
  PORTAL_LIMITS,
  portalRequestStatus,
  portalSubmit,
  portalTicket,
  sendFile,
} from "../cfdi/portal.js";
import {
  activate,
  cancelDocument,
  emailDocument,
  findTicket,
  getAlerts,
  getDocument,
  getSettings,
  getStatus,
  getTicket,
  listDocumentsRoute,
  listGlobals,
  requestInvoice,
  requestLive,
  retryDocument,
  retryOrganization,
  runGlobals,
  saveSettings,
  sendDocumentFile,
  substituteDocument,
  uploadCsd,
} from "../cfdi/service.js";

/**
 * cfdi area routes that run before authentication: the customer self-invoicing portal (spec
 * §4.7.2). No cookie authority, no session: per-IP limiters, bearer codes and sealed tokens.
 */
export function registerPreAuth(ctx: PreAuthContext) {
  const { app, sql } = ctx;
  const lookup = portalLimiter("cfdi_portal_lookup", PORTAL_LIMITS.lookup);
  const submit = portalLimiter("cfdi_portal_submit", PORTAL_LIMITS.submit);
  const access = portalLimiter("cfdi_portal_access", PORTAL_LIMITS.access);
  const status = portalLimiter("cfdi_portal_status", PORTAL_LIMITS.status);
  app.get(
    "/api/cfdi/portal/tickets/:code",
    lookup,
    handle(async (req, res) => {
      res.json(await portalTicket(sql, String(req.params.code)));
    }),
  );
  app.post(
    "/api/cfdi/portal/tickets/:code/invoices",
    submit,
    handle(async (req, res) => {
      res.json(await portalSubmit(sql, String(req.params.code), req.body));
    }),
  );
  app.post(
    "/api/cfdi/portal/tickets/:code/access",
    access,
    handle(async (req, res) => {
      res.json(await portalAccess(sql, String(req.params.code), req.body));
    }),
  );
  app.get(
    "/api/cfdi/portal/requests/:token",
    status,
    handle(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await portalRequestStatus(sql, String(req.params.token)));
    }),
  );
  app.get(
    "/api/cfdi/portal/files/:token/:format",
    status,
    handle(async (req, res) => {
      sendFile(
        res,
        await portalFile(
          sql,
          String(req.params.token),
          String(req.params.format),
        ),
      );
    }),
  );
}

/** cfdi area authenticated routes (spec §4.7.1); JSON through ctx.route, files through ctx.app. */
export function register(ctx: RouteContext) {
  const { app, sql, route } = ctx;
  route("get", "/cfdi/status", (tx, s) => getStatus(tx, s));
  route("get", "/cfdi/settings", (tx, s) => getSettings(tx, s));
  route("post", "/cfdi/activate", (tx, s, req) => activate(tx, s, req.body));
  route("post", "/cfdi/settings", (tx, s, req) =>
    saveSettings(tx, s, req.body),
  );
  route("post", "/cfdi/organization/retry", (tx, s, req) =>
    retryOrganization(tx, s, req.body),
  );
  route("post", "/cfdi/csd", (tx, s, req) => uploadCsd(tx, s, req.body));
  route("post", "/cfdi/live", (tx, s, req) => requestLive(tx, s, req.body));
  route("get", "/cfdi/tickets", (tx, s, req) => findTicket(tx, s, req));
  route("get", "/cfdi/tickets/:ticketId", (tx, s, req) =>
    getTicket(tx, s, req),
  );
  route("post", "/cfdi/invoices", (tx, s, req) =>
    requestInvoice(tx, s, req.body),
  );
  route("get", "/cfdi/documents", (tx, s, req) =>
    listDocumentsRoute(tx, s, req),
  );
  route("get", "/cfdi/documents/:id", (tx, s, req) => getDocument(tx, s, req));
  route("post", "/cfdi/documents/:id/email", (tx, s, req) =>
    emailDocument(tx, s, req.body, req),
  );
  route("post", "/cfdi/documents/:id/cancel", (tx, s, req) =>
    cancelDocument(tx, s, req.body, req),
  );
  route("post", "/cfdi/documents/:id/substitute", (tx, s, req) =>
    substituteDocument(tx, s, req.body, req),
  );
  route("post", "/cfdi/documents/:id/retry", (tx, s, req) =>
    retryDocument(tx, s, req.body, req),
  );
  route("get", "/cfdi/globals", (tx, s, req) => listGlobals(tx, s, req));
  route("post", "/cfdi/globals/run", (tx, s, req) =>
    runGlobals(tx, s, req.body),
  );
  route("get", "/cfdi/alerts", (tx, s) => getAlerts(tx, s));
  // Binary download: the bytes are read inside tenant() and written after it returns (rule 0.7).
  app.get("/api/cfdi/documents/:id/file/:format", async (req, res, next) => {
    try {
      const s = (req as unknown as AuthRequest).session;
      const file = await tenant(sql, s.tenantId, (tx) =>
        sendDocumentFile(tx, s, {
          id: String(req.params.id),
          format: String(req.params.format),
        }),
      );
      sendFile(res, file);
    } catch (e) {
      next(e);
    }
  });
}
