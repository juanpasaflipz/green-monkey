import { sellingAllowed } from "./free-limits.js";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
  createHash,
} from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type postgres from "postgres";
import { tenant } from "./db.js";
import { DomainError, type Session } from "../shared/domain.js";
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
export function sign(data: unknown) {
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${body}.${createHmac("sha256", process.env.JWT_SECRET!).update(body).digest("base64url")}`;
}
export function verify(value: string) {
  const [body, signature] = value.split(".");
  if (!body || !signature) throw new DomainError("unauthorized", 401);
  const expected = createHmac("sha256", process.env.JWT_SECRET!)
    .update(body)
    .digest();
  const supplied = Buffer.from(signature, "base64url");
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    throw new DomainError("unauthorized", 401);
  return JSON.parse(Buffer.from(body, "base64url").toString());
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
      const c = verify(req.cookies.gm_session ?? "");
      const device = verify(req.cookies.gm_device ?? "");
      if (c.tenantId !== device.tenantId)
        throw new DomainError("unauthorized", 401);
      if (
        (req.headers["x-tenant-id"] &&
          req.headers["x-tenant-id"] !== c.tenantId) ||
        (req.headers["x-session-id"] && req.headers["x-session-id"] !== c.id)
      )
        throw new DomainError("session_changed", 409);
      const session = await tenant(sql, c.tenantId, async (tx) => {
        const [s] =
          await tx`select s.*,e.name,e.role,r.name as restaurant_name,r.currency,r.timezone,r.cutoff,r.config_version,
            (select contract_version from offline_leases l where l.session_id=s.id) as offline_lease_version,
            (select configuration_version from offline_leases l where l.session_id=s.id) as offline_lease_config_version
          from sessions s join employees e on e.tenant_id=s.tenant_id and e.id=s.employee_id
          join devices d on d.tenant_id=s.tenant_id and d.id=s.device_id
          join restaurants r on r.id=s.tenant_id
          where s.id=${c.id} and s.token_hash=${hash(c.token)} and not s.revoked and s.expires_at>now()
            and e.active and d.active and d.id=${device.id} and d.token_hash=${hash(device.token)}`;
        if (!s) throw new DomainError("unauthorized", 401);
        if (s.owner_account_id) {
          await tx`select set_config('app.account_id',${s.owner_account_id},true)`;
          const [owner] =
            await tx`select a.id from owner_sessions os join owner_accounts a on a.id=os.account_id
            where os.id=${s.owner_session_id} and os.account_id=${s.owner_account_id}
              and not os.revoked and os.expires_at>now() and a.active`;
          if (!owner) throw new DomainError("unauthorized", 401);
        }
        return {
          sellingAllowed: await sellingAllowed(tx, s.employee_id, s.device_id),
          id: s.id,
          tenantId: s.tenant_id,
          employeeId: s.employee_id,
          name: s.name,
          role: s.role,
          deviceId: s.device_id,
          expiresAt: s.expires_at.toISOString(),
          offlineUntil: s.offline_until.toISOString(),
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
        } as Session;
      });
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
