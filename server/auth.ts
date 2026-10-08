import { sellingAccess } from "./free-limits.js";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type postgres from "postgres";
import { tenant } from "./db.js";
import { DomainError, type Session } from "../shared/domain.js";
import { effectiveIdleLock } from "../shared/access.js";
import { signToken, verifyToken } from "./keyring.js";
import {
  idleLockDefault,
  readDeviceCookie,
  readSessionCookie,
  sessionFailure,
  touchSession,
  type AuthRow,
} from "./access.js";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function password(s: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(s, salt, 64).toString("hex")}`;
}
export function matches(s: string, stored: string) {
  const [salt, key] = stored.split(":");
  const actual = scryptSync(s, salt, 64);
  const expected = Buffer.from(key, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
/** Cookies and links: "v2.<kid>.<body>.<mac>" under the keyring's first key (server/keyring.ts). */
export function sign(data: unknown) {
  return signToken("sign", data);
}
/**
 * The signed data, or DomainError("unauthorized", 401). Accepts listed kids and,
 * outside production while JWT_SECRET is set, the legacy formats; exactly one
 * spelling per token (server/keyring.ts).
 */
export function verify(value: string): any {
  const data = verifyToken("sign", value, { legacy: true });
  if (data === null) throw new DomainError("unauthorized", 401);
  return data;
}
export type AuthRequest = Request & { session: Session };
export const cookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};
export function authentication(sql: postgres.Sql) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const device = readDeviceCookie(req.cookies.gm_device);
      if (!device) throw new DomainError("device_not_paired", 401);
      const c = readSessionCookie(req.cookies.gm_session);
      if (!c || c.tenantId !== device.tenantId)
        throw new DomainError("unauthorized", 401);
      if (
        (req.headers["x-tenant-id"] &&
          req.headers["x-tenant-id"] !== c.tenantId) ||
        (req.headers["x-session-id"] && req.headers["x-session-id"] !== c.id)
      )
        throw new DomainError("session_changed", 409);
      type Outcome = { failure: string } | { session: Session };
      const result = await tenant(
        sql,
        c.tenantId,
        async (tx): Promise<Outcome> => {
          const [s] =
            await tx`select s.*,e.name,e.role,r.name as restaurant_name,r.currency,r.timezone,r.cutoff,r.config_version,
            d.name as device_name,
            coalesce(d.kind, case when d.name='Owner browser' then 'personal' else 'terminal' end) as device_kind,
            d.idle_lock_seconds,l.contract_version as offline_lease_version,
            l.configuration_version as offline_lease_config_version,l.selling_authorized as lease_selling
          from sessions s join employees e on e.tenant_id=s.tenant_id and e.id=s.employee_id
          join devices d on d.tenant_id=s.tenant_id and d.id=s.device_id
          join restaurants r on r.id=s.tenant_id
          left join offline_leases l on l.tenant_id=s.tenant_id and l.session_id=s.id
          where s.id=${c.id} and s.token_hash=${hash(c.token)} and not s.revoked and s.ended_at is null
            and s.expires_at>now() and e.active and d.active and coalesce(d.token_expires_at,'infinity')>now()
            and d.id=${device.id} and d.token_hash=${hash(device.token)}`;
          // Failure path only: one diagnostic query names the reason (FOH-7).
          if (!s) return { failure: await sessionFailure(tx, c, device) };
          if (s.owner_account_id) {
            await tx`select set_config('app.account_id',${s.owner_account_id},true)`;
            const [owner] =
              await tx`select a.id from owner_sessions os join owner_accounts a on a.id=os.account_id
            where os.id=${s.owner_session_id} and os.account_id=${s.owner_account_id}
              and not os.revoked and os.expires_at>now() and a.active`;
            if (!owner) return { failure: "unauthorized" };
          }
          const access = await sellingAccess(tx, s.employee_id, s.device_id);
          const selling = access.allowed;
          // Drawer continuation (account 031, LD-15 Q5) keeps a register selling
          // but never renews its offline window.
          const touched = await touchSession(
            tx,
            s as AuthRow,
            selling && access.basis !== "drawer_continuation",
          );
          return {
            session: {
              sellingAllowed: selling,
              id: s.id,
              tenantId: s.tenant_id,
              employeeId: s.employee_id,
              name: s.name,
              role: s.role,
              deviceId: s.device_id,
              expiresAt: touched.expiresAt.toISOString(),
              offlineUntil: touched.offlineUntil.toISOString(),
              offlineLeaseVersion: s.offline_lease_version,
              offlineLeaseConfigVersion: s.offline_lease_config_version ?? null,
              csrf: s.csrf,
              restaurant: {
                name: s.restaurant_name,
                currency: s.currency,
                timezone: s.timezone,
                cutoff: s.cutoff,
                configVersion: s.config_version,
              },
              access: {
                absoluteExpiresAt: s.absolute_expires_at?.toISOString() ?? null,
                authenticatedAt: s.authenticated_at?.toISOString() ?? null,
                deviceName: s.device_name,
                deviceKind: s.device_kind,
                idleLockSeconds: effectiveIdleLock(
                  s.idle_lock_seconds,
                  s.role,
                  s.device_kind,
                  idleLockDefault(),
                  Boolean(s.owner_account_id),
                ),
                ownerAccount: Boolean(s.owner_account_id),
              },
            } as Session,
          };
        },
      );
      if ("failure" in result) {
        res.clearCookie("gm_session", cookieOptions);
        if (result.failure === "device_revoked")
          res.clearCookie("gm_device", cookieOptions);
        throw new DomainError(result.failure, 401);
      }
      const session = result.session;
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers["x-csrf-token"] !== session.csrf
      )
        throw new DomainError("forbidden", 403);
      (req as AuthRequest).session = session;
      next();
    } catch (e) {
      next(e);
    }
  };
}
export function permit(s: Session, roles: string[]) {
  if (!roles.includes(s.role)) throw new DomainError("forbidden", 403);
}
export const operators = ["owner", "manager", "cashier", "server"];
export const managers = ["owner", "manager"];
