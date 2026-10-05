import type express from "express";
import rateLimit from "express-rate-limit";
import type { PreAuthContext, RouteContext } from "../http.js";
import { cookieOptions, sign, type AuthRequest } from "../auth.js";
import {
  assertDemoAccessAllowed,
  demoTenantId,
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
    limit(120),
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
      return {
        device: { id: paired.device.id, name: paired.name, kind: "terminal" },
        restaurant: { name: paired.restaurant },
      };
    }),
  );
  app.post(
    "/api/access/pin",
    limit(30),
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
  app.post("/api/access/logout", limit(60), logout);
  app.post("/api/logout", limit(60), noStore, logout);
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
