// Payments (037) routes. P1: the payment dialog's options, Configuración (terminals, platforms,
// platform prices) and each device's default terminal. P2: integrated charges (start, read, sync,
// cancel, resolve, the active list), provider accounts (credentials, disconnect, devices, MP mode)
// and the pre-auth provider webhooks (critic R31: before authentication).
import type express from "express";
import type postgres from "postgres";
import type { PreAuthContext, RouteContext } from "../http.js";
import type { AuthRequest } from "../auth.js";
import { operators, permit } from "../auth.js";
import { tenant, type Tx } from "../db.js";
import { id, type Session } from "../../shared/domain.js";
import {
  archiveTerminal,
  paymentOptions,
  paymentSettingsView,
  savePlatformPrices,
  savePlatforms,
  saveTerminal,
  setDeviceTerminal,
} from "../payments/settings.js";
import {
  activeAttempts,
  getAttempt,
  requestCancel,
  resolveAttempt,
  startTerminalCharge,
  syncAttemptCore,
} from "../payments/terminal.js";
import {
  disableProvider,
  parseProvider,
  providersView,
  requestDeviceMode,
  requestDevices,
  saveCredentials,
} from "../payments/providers.js";
import {
  webhookBody,
  webhookBodyErrors,
  webhookRoute,
} from "../payments/webhooks.js";
import { wakeWorker } from "../payments/wake.js";

/** Provider webhooks, before authentication (spec §9.2). */
export function registerPreAuth({ app, sql }: PreAuthContext) {
  app.post("/api/payments/webhooks/:provider/:hook", webhookRoute(sql));
}
/** Before the app's JSON parser (server/index.ts): the webhook path's 16 KB body (P2-SECURITY-6). */
export function registerWebhookBody(app: express.Express) {
  app.use("/api/payments/webhooks", ...webhookBody, webhookBodyErrors);
}

/**
 * An authenticated JSON route whose effects need the commit first: it runs one tenant
 * transaction, answers, then wakes the worker (a wake before the commit would find nothing).
 * `noStore` keeps a reply that carries a one-time URL out of every cache.
 */
function committed(
  app: express.Express,
  sql: postgres.Sql,
  path: string,
  fn: (tx: Tx, s: Session, req: express.Request) => Promise<unknown>,
  o: { noStore?: boolean } = {},
) {
  app.post("/api" + path, async (req, res, next) => {
    try {
      const s = (req as unknown as AuthRequest).session;
      const result = await tenant(sql, s.tenantId, (tx) => fn(tx, s, req));
      if (o.noStore) res.set("Cache-Control", "no-store");
      res.json(result);
      wakeWorker();
    } catch (e) {
      next(e);
    }
  });
}

export function register({ app, sql, route }: RouteContext) {
  route("get", "/payments/options", (tx, s) => paymentOptions(tx, s));
  route("get", "/payments/settings", (tx, s) => paymentSettingsView(tx, s));
  route("post", "/payments/terminals", (tx, s, req) =>
    saveTerminal(tx, s, req.body),
  );
  route("post", "/payments/terminals/:id/archive", (tx, s, req) =>
    archiveTerminal(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/payments/platforms", (tx, s, req) =>
    savePlatforms(tx, s, req.body),
  );
  route("post", "/payments/platform-prices", (tx, s, req) =>
    savePlatformPrices(tx, s, req.body),
  );
  route("post", "/payments/devices/:deviceId/terminal", (tx, s, req) =>
    setDeviceTerminal(tx, s, id.parse(req.params.deviceId), req.body),
  );

  // Integrated charges (P2).
  route("get", "/payments/terminal/active", (tx, s) => activeAttempts(tx, s));
  route("get", "/payments/terminal/charges/:id", (tx, s, req) =>
    getAttempt(tx, s, id.parse(req.params.id)),
  );
  committed(app, sql, "/payments/terminal/charges", (tx, s, req) =>
    startTerminalCharge(tx, s, req.body),
  );
  committed(app, sql, "/payments/terminal/charges/:id/cancel", (tx, s, req) =>
    requestCancel(tx, s, id.parse(req.params.id), req.body),
  );
  committed(app, sql, "/payments/terminal/charges/:id/resolve", (tx, s, req) =>
    resolveAttempt(tx, s, id.parse(req.params.id), req.body),
  );
  // Sync: settles an approved attempt (its own transactions) or wakes the worker; no provider call.
  app.post(
    "/api/payments/terminal/charges/:id/sync",
    async (req, res, next) => {
      try {
        const s = (req as unknown as AuthRequest).session;
        permit(s, operators);
        res.json(
          await syncAttemptCore(sql, s.tenantId, id.parse(req.params.id)),
        );
      } catch (e) {
        next(e);
      }
    },
  );

  // Provider accounts (P2).
  route("get", "/payments/providers", (tx, s) => providersView(tx, s));
  committed(
    app,
    sql,
    "/payments/providers/:provider/credentials",
    (tx, s, req) =>
      saveCredentials(tx, s, parseProvider(req.params.provider), req.body, {
        appEnv: process.env.APP_ENV ?? "development",
        appUrl: process.env.APP_URL?.trim()
          ? new URL(process.env.APP_URL).origin
          : `${req.protocol}://${req.get("host")}`,
      }),
    { noStore: true },
  );
  committed(app, sql, "/payments/providers/:provider/disable", (tx, s, req) =>
    disableProvider(tx, s, parseProvider(req.params.provider)),
  );
  committed(
    app,
    sql,
    "/payments/providers/:provider/devices/refresh",
    (tx, s, req) => requestDevices(tx, s, parseProvider(req.params.provider)),
  );
  committed(
    app,
    sql,
    "/payments/providers/mercadopago/devices/:deviceId/mode",
    (tx, s, req) =>
      requestDeviceMode(tx, s, String(req.params.deviceId), req.body),
  );
}
