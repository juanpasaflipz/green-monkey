import type express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { PreAuthContext, RouteContext } from "../http.js";
import { cookieOptions, sign, type AuthRequest } from "../auth.js";
import {
  assertDemoAccessAllowed,
  demoTenantId,
  endOwnerAccount,
  legacyLogin,
  pinSignIn,
  readDeviceCookie,
  signOut,
  stepUp,
  terminalState,
} from "../access.js";
import {
  cancelPairingCode,
  createPairingCode,
  listPairingCodes,
  redeemPairingCode,
} from "../access-pairing.js";
import {
  endDeviceSession,
  listDevices,
  revokeDevice,
  updateDevice,
} from "../access-devices.js";
import {
  createStaff,
  listApprovers,
  listStaff,
  resetStaffPin,
  setStaffActive,
  unlockStaff,
  updateStaff,
} from "../access-staff.js";
import { id } from "../../shared/domain.js";
import { ACCESS } from "../../shared/access.js";

/** Per-IP limits; req.ip is the real client behind Railway via trustProxy. */
function limit(max: number, skipSuccessfulRequests = false) {
  return rateLimit({
    windowMs: 60_000,
    limit: max,
    skipSuccessfulRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too_many_attempts" },
  });
}

/** The verified (signed) gm_device of a request, as a limiter key; null without one. */
export function deviceLimitKey(req: express.Request): string | null {
  const device = readDeviceCookie(req.cookies?.gm_device);
  return device ? `device:${device.tenantId}:${device.id}` : null;
}
/**
 * The backstop key of a device request: its restaurant plus the client IP
 * (IPv6 per /56), or null without a valid gm_device. Keyed by restaurant so
 * devices paired in another restaurant (anyone can pair devices in their own
 * Free restaurant) never spend this restaurant's backstop from a shared IP
 * such as guest Wi-Fi, a food-court network or carrier NAT (ACC-R-1).
 */
export function backstopLimitKey(req: express.Request): string | null {
  const device = readDeviceCookie(req.cookies?.gm_device);
  return device
    ? `tenant:${device.tenantId}:${ipKeyGenerator(req.ip ?? "", 56)}`
    : null;
}
/**
 * Limits for routes every terminal uses (A9/ACC-FLOOR-4). A restaurant's
 * terminals usually share one public IP with its guest Wi-Fi, so a request
 * with a valid signed gm_device spends only its own device's budget, and
 * requests without one share a separate per-IP budget that can never block a
 * paired terminal. A much higher ceiling per restaurant and IP on device
 * requests remains as a backstop, so another restaurant's devices on the same
 * IP never count toward it (ACC-R-1). PIN guessing itself is bounded per
 * employee and device by checkPin.
 */
function limitPerDevice(perDevice: number, perAnonymousIp: number) {
  return [
    rateLimit({
      windowMs: 60_000,
      limit: (req) => (deviceLimitKey(req) ? perDevice : perAnonymousIp),
      keyGenerator: (req) =>
        deviceLimitKey(req) ?? `ip:${ipKeyGenerator(req.ip ?? "", 56)}`,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "too_many_attempts" },
    }),
    rateLimit({
      windowMs: 60_000,
      limit: perDevice * 20,
      skip: (req) => !backstopLimitKey(req),
      keyGenerator: (req) => backstopLimitKey(req)!,
      requestPropertyName: "rateLimitBackstop",
      standardHeaders: false,
      legacyHeaders: false,
      message: { error: "too_many_attempts" },
    }),
  ];
}

const noStore: express.RequestHandler = (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};
type Handler = (
  req: express.Request,
  res: express.Response,
) => Promise<unknown>;
const json =
  (fn: Handler): express.RequestHandler =>
  async (req, res, next) => {
    try {
      res.json(await fn(req, res));
    } catch (e) {
      next(e);
    }
  };

/** access area routes that must run before authentication. */
export function registerPreAuth({ app, sql }: PreAuthContext) {
  assertDemoAccessAllowed();
  const demo = demoTenantId();
  if (demo) console.log(`DEMO ACCESS ENABLED for tenant ${demo}`);
  // Access responses carry credentials or roster data: never cache them.
  app.use("/api/access", noStore);
  app.get(
    "/api/access/terminal",
    limitPerDevice(120, 120),
    json((req, res) => terminalState(sql, req, res)),
  );
  app.post(
    "/api/access/pair",
    limit(10, true),
    json(async (req, res) => {
      const paired = await redeemPairingCode(
        sql,
        req.body,
        readDeviceCookie(req.cookies?.gm_device),
      );
      res.cookie("gm_device", sign(paired.device), {
        ...cookieOptions,
        maxAge: ACCESS.deviceTokenDays * 86400_000,
      });
      res.clearCookie("gm_session", cookieOptions);
      // A terminal never keeps an owner's Google sign-in (ACC-R-3).
      await endOwnerAccount(sql, req, res, "access.pair");
      return {
        device: { id: paired.device.id, name: paired.name, kind: "terminal" },
        restaurant: { name: paired.restaurant },
      };
    }),
  );
  app.post(
    "/api/access/pin",
    limitPerDevice(30, 30),
    json((req, res) => pinSignIn(sql, req, res)),
  );
  app.post(
    "/api/login",
    limit(10, true),
    noStore,
    json((req, res) => legacyLogin(sql, req, res)),
  );
  // Logout runs before authentication and always succeeds (FOH-7).
  const logout = json((req, res) => signOut(sql, req, res));
  app.post("/api/access/logout", limitPerDevice(60, 60), logout);
  app.post("/api/logout", limitPerDevice(60, 60), noStore, logout);
}

/** access area authenticated routes; use ctx.route for tenant-scoped handlers. */
export function register({ app, sql, route }: RouteContext) {
  // Runs in its own transaction so a wrong PIN still counts (see checkPin).
  app.post("/api/access/step-up", async (req, res, next) => {
    try {
      res.json(await stepUp(sql, (req as AuthRequest).session, req.body));
    } catch (e) {
      next(e);
    }
  });
  route("get", "/access/approvers", (tx, s) => listApprovers(tx, s));
  route("get", "/access/staff", (tx, s) => listStaff(tx, s));
  route("post", "/access/staff", (tx, s, req) => createStaff(tx, s, req.body));
  route("post", "/access/staff/:id", (tx, s, req) =>
    updateStaff(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/access/staff/:id/active", (tx, s, req) =>
    setStaffActive(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/access/staff/:id/pin", (tx, s, req) =>
    resetStaffPin(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/access/staff/:id/unlock", (tx, s, req) =>
    unlockStaff(tx, s, id.parse(req.params.id), req.body),
  );
  route("get", "/access/devices", (tx, s) => listDevices(tx, s));
  route("post", "/access/devices/:id", (tx, s, req) =>
    updateDevice(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/access/devices/:id/end-session", (tx, s, req) =>
    endDeviceSession(tx, s, id.parse(req.params.id), req.body),
  );
  route("post", "/access/devices/:id/revoke", (tx, s, req) =>
    revokeDevice(tx, s, id.parse(req.params.id), req.body),
  );
  route("get", "/access/pairing-codes", (tx, s) => listPairingCodes(tx, s));
  route("post", "/access/pairing-codes", (tx, s, req) =>
    createPairingCode(tx, s, req.body),
  );
  route("post", "/access/pairing-codes/:id/cancel", (tx, s, req) =>
    cancelPairingCode(tx, s, id.parse(req.params.id), req.body),
  );
}
