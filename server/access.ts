import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type express from "express";
import type postgres from "postgres";
import { z } from "zod";
import { tenant, type Tx } from "./db.js";
import { cookieOptions, hash, operators, sign, verify } from "./auth.js";
import { withOwner } from "./owner-accounts.js";
import { selectFirstDevice, sellingAllowed } from "./free-limits.js";
import { issueOfflineLease, renewOfflineLease } from "./offline-leases.js";
import { googleConfig } from "./google-identity.js";
import { DomainError, type Session } from "../shared/domain.js";
import {
  ACCESS,
  decayPinState,
  emptyPinState,
  failPinState,
  isPinLocked,
  isRecentAuth,
  type DeviceKind,
  type EndReason,
  type PinState,
  type TerminalState,
} from "../shared/access.js";

const opaque = () => randomBytes(32).toString("hex");
const DAY = 86400_000;

/** Throttle scope for PIN attempts made on one paired device. */
export const deviceScope = (deviceId: string) => `device:${deviceId}`;

/** ACCESS_STEP_UP_SECONDS (30..1800), default 120: how fresh a PIN must be on terminals. */
export function stepUpSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.ACCESS_STEP_UP_SECONDS ?? "", 10);
  if (!Number.isFinite(raw)) return ACCESS.defaultStepUpSeconds;
  return Math.min(1800, Math.max(30, raw));
}

/**
 * ACCESS_IDLE_LOCK_DEFAULT_SECONDS: the terminal auto-lock when the device has
 * no explicit setting (0 = never; unset or invalid = 180). Browser suites run
 * with 0 because they fast-forward clocks well beyond 3 minutes.
 */
export function idleLockDefault(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ACCESS_IDLE_LOCK_DEFAULT_SECONDS ?? "");
  return env.ACCESS_IDLE_LOCK_DEFAULT_SECONDS?.trim() &&
    (ACCESS.idleLockChoices as readonly number[]).includes(raw)
    ? raw
    : ACCESS.defaultIdleLockSeconds;
}

/**
 * Refuses to start production with demo access enabled (D22): the demo form
 * and owner-password pairing must only exist on local and fictional staging.
 */
export function assertDemoAccessAllowed(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.DEMO_TENANT_ID?.trim() &&
    env.RAILWAY_ENVIRONMENT_NAME?.trim().toLowerCase() === "production"
  )
    throw Error("DEMO_TENANT_ID must not be set in production");
}

/** The fictional tenant whose demo form and owner password pairing are allowed. */
export function demoTenantId(env: NodeJS.ProcessEnv = process.env) {
  const value = env.DEMO_TENANT_ID?.trim();
  return value && z.uuid().safeParse(value).success ? value : null;
}

const credential = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strip();
export type DeviceCookie = z.infer<typeof credential>;

/** Verifies the signed gm_device cookie; null on any failure. */
export function readDeviceCookie(value?: string): DeviceCookie | null {
  if (!value) return null;
  try {
    return credential.parse(verify(value));
  } catch {
    return null;
  }
}
/** Verifies the signed gm_session cookie; null on any failure. */
export function readSessionCookie(value?: string): DeviceCookie | null {
  return readDeviceCookie(value);
}

export type DeviceRow = {
  id: string;
  name: string;
  kind: DeviceKind;
  idle_lock_seconds: number | null;
  free_slot: number | null;
};
/** An active, unexpired device whose token matches the cookie. */
export async function loadDevice(
  tx: Tx,
  c: DeviceCookie,
): Promise<DeviceRow | null> {
  const [d] = await tx<DeviceRow[]>`select id,name,idle_lock_seconds,free_slot,
      coalesce(kind, case when name='Owner browser' then 'personal' else 'terminal' end) as kind
    from devices
    where id=${c.id} and token_hash=${hash(c.token)} and active
      and coalesce(token_expires_at,'infinity')>now()`;
  return d ?? null;
}

// PIN verification ------------------------------------------------------

export type PinTarget = { employeeId: string } | { login: string };
export type PinCheck =
  | { outcome: "ok"; employee: { id: string; role: string; name: string } }
  | { outcome: "unknown" }
  | { outcome: "invalid" }
  | { outcome: "locked"; until: string }
  | { outcome: "hard_locked" };

function scryptAsync(secret: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(secret, salt, 64, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}
/** Same format as password() in auth.ts, without blocking the event loop. */
export async function hashSecret(secret: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await scryptAsync(secret, salt)).toString("hex")}`;
}
/** Constant-time comparison against a password() / hashSecret() value. */
export async function secretMatches(secret: string, stored: string) {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const actual = await scryptAsync(secret, salt);
  const expected = Buffer.from(key, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

/**
 * Checks a PIN or password inside the caller's tenant transaction, keeping
 * throttling per employee and device scope (SEC-2). It never throws for a wrong
 * secret: callers return a marker so the counters commit, then reject outside.
 */
export async function checkPin(
  tx: Tx,
  target: PinTarget,
  secret: string,
  scope: string,
): Promise<PinCheck> {
  const [e] =
    "employeeId" in target
      ? await tx`select id,role,name,secret_hash,failed_attempts,locked_until,
            coalesce(locked_until='infinity',false) as hard,
            coalesce(locked_until>now(),false) as globally_locked, now() as db_now
          from employees where id=${target.employeeId} and active for update`
      : await tx`select id,role,name,secret_hash,failed_attempts,locked_until,
            coalesce(locked_until='infinity',false) as hard,
            coalesce(locked_until>now(),false) as globally_locked, now() as db_now
          from employees where login=${target.login} and active for update`;
  if (!e) return { outcome: "unknown" };
  if (e.hard) return { outcome: "hard_locked" };
  // Covers the 5-minute locks written by the previous revision during a deploy.
  if (e.globally_locked)
    return { outcome: "locked", until: e.locked_until.toISOString() };
  const now: Date = e.db_now;
  const [row] =
    await tx`select failures,lock_level,locked_until,last_failure_at
      from pin_throttles where employee_id=${e.id} and scope=${scope}`;
  const state = decayPinState(
    row
      ? {
          failures: row.failures,
          lockLevel: row.lock_level,
          lockedUntil: row.locked_until,
          lastFailureAt: row.last_failure_at,
        }
      : emptyPinState(),
    now,
  );
  // A locked scope never evaluates the secret.
  if (isPinLocked(state, now))
    return { outcome: "locked", until: state.lockedUntil!.toISOString() };
  if (await secretMatches(secret, e.secret_hash)) {
    if (
      row &&
      (row.failures || row.lock_level || row.locked_until || row.last_failure_at)
    )
      await tx`update pin_throttles set failures=0,lock_level=0,locked_until=null,last_failure_at=null
        where employee_id=${e.id} and scope=${scope}`;
    if (e.failed_attempts > 0 || e.locked_until)
      await tx`update employees set failed_attempts=0,locked_until=null
        where id=${e.id} and coalesce(locked_until<>'infinity',true)`;
    return {
      outcome: "ok",
      employee: { id: e.id, role: e.role, name: e.name },
    };
  }
  const next = failPinState(state, now);
  await writeThrottle(tx, e.id, scope, next);
  const [after] = await tx`update employees set
      failed_attempts=failed_attempts+1,
      locked_until=case when failed_attempts+1>=${ACCESS.pin.hardLockFailures}
        then 'infinity'::timestamptz else locked_until end
    where id=${e.id} returning coalesce(locked_until='infinity',false) as hard`;
  if (after.hard) return { outcome: "hard_locked" };
  if (next.lockedNow)
    return { outcome: "locked", until: next.lockedUntil!.toISOString() };
  return { outcome: "invalid" };
}
async function writeThrottle(
  tx: Tx,
  employeeId: string,
  scope: string,
  s: PinState,
) {
  await tx`insert into pin_throttles(tenant_id,employee_id,scope,failures,lock_level,locked_until,last_failure_at)
    values(current_setting('app.tenant_id')::uuid,${employeeId},${scope},${s.failures},${s.lockLevel},${s.lockedUntil},${s.lastFailureAt})
    on conflict(tenant_id,employee_id,scope) do update set failures=excluded.failures,
      lock_level=excluded.lock_level,locked_until=excluded.locked_until,last_failure_at=excluded.last_failure_at`;
}

/** Maps a rejected PIN check to the client-facing error for each entry point. */
export function pinError(
  c: Exclude<PinCheck, { outcome: "ok" }>,
  mode: "pin" | "login" | "approval",
): DomainError {
  if (c.outcome === "locked") return new DomainError("pin_locked", 423);
  if (c.outcome === "hard_locked")
    return new DomainError("pin_hard_locked", 423);
  if (mode === "approval") return new DomainError("approval_denied", 403);
  if (mode === "login") return new DomainError("invalid_login", 401);
  return c.outcome === "unknown"
    ? new DomainError("employee_unavailable", 401)
    : new DomainError("invalid_pin", 401);
}

// Sessions ---------------------------------------------------------------

/**
 * The only way to insert a sessions row: sliding 8 h expiry capped by an
 * absolute expiry (16 h for PIN sign-in, the owner session's expiry for Google
 * entry), a 4 h offline window bounded by the same cap, and its lease.
 */
export async function createSession(
  tx: Tx,
  i: {
    employeeId: string;
    deviceId: string;
    ownerAccountId?: string;
    ownerSessionId?: string;
    absoluteExpiresAt?: Date;
  },
): Promise<{ id: string; token: string; absoluteExpiresAt: Date }> {
  await selectFirstDevice(tx, i.deviceId);
  const selling = await sellingAllowed(tx, i.employeeId, i.deviceId);
  const id = randomUUID(),
    token = opaque(),
    csrf = randomBytes(24).toString("hex");
  const [row] = await tx`insert into sessions(tenant_id,id,employee_id,device_id,token_hash,csrf,
      created_at,last_seen_at,authenticated_at,expires_at,absolute_expires_at,offline_until,
      owner_account_id,owner_session_id,selling_authorized)
    select current_setting('app.tenant_id')::uuid,${id},${i.employeeId},${i.deviceId},${hash(token)},${csrf},
      now(),now(),now(),
      least(now()+make_interval(mins=>${ACCESS.sessionIdleMinutes}),a.cap),a.cap,
      least(now()+make_interval(hours=>${ACCESS.offlineWindowHours}),a.cap),
      ${i.ownerAccountId ?? null},${i.ownerSessionId ?? null},${selling}
    from (select coalesce(${i.absoluteExpiresAt ?? null}::timestamptz,
      now()+make_interval(hours=>${ACCESS.sessionAbsoluteHours})) as cap) a
    returning absolute_expires_at`;
  await issueOfflineLease(tx, id);
  await tx`update devices set last_seen_at=now(),
      token_expires_at=greatest(coalesce(token_expires_at,now()),now()+make_interval(days=>${ACCESS.deviceTokenDays}))
    where id=${i.deviceId}`;
  return { id, token, absoluteExpiresAt: row.absolute_expires_at };
}

/**
 * Ends sessions. A normal end (logout, switch, PIN reset, role change) keeps
 * queued offline evidence syncable for the same employee and device (OFF-7);
 * revoke=true is reserved for deactivation and device revocation. Setting
 * expires_at also makes the previous revision reject the session.
 */
export async function endSession(
  tx: Tx,
  sessionId: string,
  reason: EndReason,
  revoke = false,
): Promise<void> {
  await tx`update sessions set ended_at=coalesce(ended_at,now()),end_reason=coalesce(end_reason,${reason}),
      expires_at=least(expires_at,now()),revoked=revoked or ${revoke}
    where id=${sessionId} and ended_at is null`;
}
export async function endEmployeeSessions(
  tx: Tx,
  employeeId: string,
  reason: EndReason,
  o: { revoke: boolean; exceptSessionId?: string },
): Promise<number> {
  const rows = o.exceptSessionId
    ? await tx`update sessions set ended_at=now(),end_reason=${reason},
          expires_at=least(expires_at,now()),revoked=revoked or ${o.revoke}
        where employee_id=${employeeId} and ended_at is null and id<>${o.exceptSessionId}
        returning id`
    : await tx`update sessions set ended_at=now(),end_reason=${reason},
          expires_at=least(expires_at,now()),revoked=revoked or ${o.revoke}
        where employee_id=${employeeId} and ended_at is null returning id`;
  // Sessions already ended normally must still be revoked by a security end.
  if (o.revoke)
    await tx`update sessions set revoked=true where employee_id=${employeeId}
      and not revoked and ${o.exceptSessionId ?? null}::uuid is distinct from id`;
  return rows.length;
}
export async function endDeviceSessions(
  tx: Tx,
  deviceId: string,
  reason: EndReason,
  o: { revoke: boolean },
): Promise<number> {
  const rows = await tx`update sessions set ended_at=now(),end_reason=${reason},
      expires_at=least(expires_at,now()),revoked=revoked or ${o.revoke}
    where device_id=${deviceId} and ended_at is null returning id`;
  if (o.revoke)
    await tx`update sessions set revoked=true where device_id=${deviceId} and not revoked`;
  return rows.length;
}

/** The authentication row (sessions s.* plus employee role and lease flag). */
export type AuthRow = {
  id: string;
  device_id: string;
  role: string;
  expires_at: Date;
  offline_until: Date;
  absolute_expires_at: Date | null;
  lease_selling: boolean | null;
};
/**
 * Slides the expiry at most once a minute per session (GAP-4: no extra write on
 * most requests) and, while the device is in contact, appends an offline window
 * renewal for selling roles (OFF-3). Legacy sessions keep their fixed expiry.
 */
export async function touchSession(
  tx: Tx,
  row: AuthRow,
  selling: boolean,
): Promise<{ expiresAt: Date; offlineUntil: Date }> {
  const unchanged = { expiresAt: row.expires_at, offlineUntil: row.offline_until };
  if (!row.absolute_expires_at) return unchanged;
  const [t] = await tx`update sessions set last_seen_at=now(),
      expires_at=least(now()+make_interval(mins=>${ACCESS.sessionIdleMinutes}),absolute_expires_at)
    where id=${row.id} and ended_at is null and not revoked
      and (last_seen_at is null or last_seen_at<now()-make_interval(secs=>${ACCESS.touchSeconds}))
    returning expires_at,offline_until,absolute_expires_at`;
  if (!t) return unchanged;
  await tx`update devices set last_seen_at=now() where id=${row.device_id}`;
  let offlineUntil: Date = t.offline_until;
  if (operators.includes(row.role) && selling && row.lease_selling) {
    const renewed = await renewOfflineLease(tx, row.id, t.absolute_expires_at);
    if (renewed) {
      await tx`update sessions set offline_until=${renewed} where id=${row.id}`;
      offlineUntil = renewed;
    }
  }
  return { expiresAt: t.expires_at, offlineUntil };
}

/** Sensitive commands on shared terminals need a PIN entered recently (SEC-6). */
export function requireRecentAuth(s: Session, maxAgeSeconds = stepUpSeconds()) {
  if (!isRecentAuth(s.access, Date.now(), maxAgeSeconds))
    throw new DomainError("step_up_required", 403);
}

/**
 * Explains why a session cookie did not authenticate (failure path only), so
 * the client can show a specific lock or pairing screen instead of a generic error.
 */
export async function sessionFailure(
  tx: Tx,
  session: DeviceCookie,
  device: DeviceCookie,
): Promise<string> {
  if (!(await loadDevice(tx, device))) return "device_revoked";
  const [s] = await tx`select s.revoked,s.ended_at,s.expires_at<=now() as expired,
      s.device_id,e.active as employee_active
    from sessions s join employees e on e.tenant_id=s.tenant_id and e.id=s.employee_id
    where s.id=${session.id} and s.token_hash=${hash(session.token)}`;
  if (!s || s.device_id !== device.id) return "unauthorized";
  if (s.revoked || !s.employee_active) return "session_revoked";
  if (s.ended_at) return "session_ended";
  if (s.expired) return "session_expired";
  return "unauthorized";
}

/**
 * True when the request carries a valid, active shared-terminal device cookie.
 * failClosed (guards that refuse terminals): a failed lookup throws instead of
 * answering "not a terminal", so a database error never lets a terminal through.
 */
export async function isTerminalRequest(
  sql: postgres.Sql,
  cookies: Record<string, string | undefined>,
  failClosed = false,
): Promise<boolean> {
  const c = readDeviceCookie(cookies.gm_device);
  if (!c) return false;
  try {
    const device = await tenant(sql, c.tenantId, (tx) => loadDevice(tx, c));
    return device?.kind === "terminal";
  } catch (error) {
    if (failClosed) throw error;
    return false;
  }
}

function clearAccessCookies(res: express.Response) {
  res.clearCookie("gm_device", cookieOptions);
  res.clearCookie("gm_session", cookieOptions);
}
function setDeviceCookie(res: express.Response, device: DeviceCookie) {
  res.cookie("gm_device", sign(device), {
    ...cookieOptions,
    maxAge: ACCESS.deviceTokenDays * DAY,
  });
}
function setSessionCookie(
  res: express.Response,
  session: DeviceCookie,
  absoluteExpiresAt: Date,
) {
  res.cookie("gm_session", sign(session), {
    ...cookieOptions,
    maxAge: Math.max(0, absoluteExpiresAt.getTime() - Date.now()),
  });
}

/** What the sign-in gate needs: pairing state, roster and allowed entry methods. */
export async function terminalState(
  sql: postgres.Sql,
  req: express.Request,
  res: express.Response,
): Promise<TerminalState> {
  const google = Boolean(googleConfig(process.env));
  const demoId = demoTenantId();
  const demo = demoId ? { tenantId: demoId, login: "owner" as const } : null;
  const c = readDeviceCookie(req.cookies?.gm_device);
  if (!c) return { paired: false, google, demo };
  const state = await tenant(sql, c.tenantId, async (tx) => {
    const device = await loadDevice(tx, c);
    if (!device) return null;
    await tx`update devices set last_seen_at=now() where id=${device.id}
      and (last_seen_at is null or last_seen_at<now()-interval '5 minutes')`;
    const [restaurant] =
      await tx`select name from restaurants where id=${c.tenantId}`;
    const staff = await tx`select e.id,e.name,e.role,
        coalesce(e.locked_until='infinity',false) as hard,
        case when e.locked_until>now() and e.locked_until<>'infinity' then e.locked_until end as global_until,
        case when t.locked_until>now() then t.locked_until end as device_until
      from employees e
      left join pin_throttles t on t.tenant_id=e.tenant_id and t.employee_id=e.id and t.scope=${deviceScope(device.id)}
      where e.active and (e.pin_set_at is not null or e.login not like 'account-%')
      order by e.name,e.id`;
    return {
      device,
      restaurant: restaurant?.name ?? "",
      staff: staff.map((e) => {
        const until = [e.global_until, e.device_until]
          .filter(Boolean)
          .sort((a: Date, b: Date) => b.getTime() - a.getTime())[0] as
          | Date
          | undefined;
        return {
          id: e.id,
          name: e.name,
          role: e.role,
          lockedUntil: until ? until.toISOString() : null,
          hardLocked: e.hard,
        };
      }),
    };
  });
  if (!state) {
    clearAccessCookies(res);
    return { paired: false, google, demo };
  }
  return {
    paired: true,
    google: google && state.device.kind === "personal",
    // The demo form stays available on a device paired to the demo tenant only.
    demo: demo && demo.tenantId === c.tenantId ? demo : null,
    device: {
      id: state.device.id,
      name: state.device.name,
      kind: state.device.kind,
      idleLockSeconds: state.device.idle_lock_seconds,
    },
    restaurant: { name: state.restaurant },
    staff: state.staff,
  };
}

type SignInResult =
  | { revoked: true }
  | { rejected: Exclude<PinCheck, { outcome: "ok" }> }
  | { reused: string }
  | { session: { id: string; token: string; absoluteExpiresAt: Date } };

/** PIN or password sign-in on a paired device, reusing or ending the live session. */
async function signInOnDevice(
  sql: postgres.Sql,
  req: express.Request,
  device: DeviceCookie,
  target: PinTarget,
  secret: string,
): Promise<SignInResult> {
  return tenant(sql, device.tenantId, async (tx): Promise<SignInResult> => {
    const row = await loadDevice(tx, device);
    if (!row) return { revoked: true };
    const check = await checkPin(tx, target, secret, deviceScope(row.id));
    if (check.outcome !== "ok") return { rejected: check };
    const current = readSessionCookie(req.cookies?.gm_session);
    const [live] =
      current && current.tenantId === device.tenantId
        ? await tx`select id,employee_id,owner_account_id,
              coalesce(absolute_expires_at>now()+make_interval(mins=>${ACCESS.reuseMinRemainingMinutes}),false) as reusable
            from sessions where id=${current.id} and token_hash=${hash(current.token)}
              and device_id=${row.id} and ended_at is null and not revoked and expires_at>now()`
        : [];
    // The re-check in the UPDATE keeps a concurrent end or revoke from being
    // undone by sliding expires_at forward again; such a session is replaced.
    const [resumed] =
      live &&
      live.employee_id === check.employee.id &&
      !live.owner_account_id &&
      live.reusable
        ? await tx`update sessions set authenticated_at=now(),last_seen_at=now(),
              expires_at=least(now()+make_interval(mins=>${ACCESS.sessionIdleMinutes}),absolute_expires_at)
            where id=${live.id} and ended_at is null and not revoked and expires_at>now()
            returning id`
        : [];
    if (resumed) {
      await tx`update devices set last_seen_at=now(),
          token_expires_at=greatest(coalesce(token_expires_at,now()),now()+make_interval(days=>${ACCESS.deviceTokenDays}))
        where id=${row.id}`;
      return { reused: live.id };
    }
    if (live)
      await endSession(
        tx,
        live.id,
        live.employee_id === check.employee.id ? "replaced" : "switched",
      );
    return {
      session: await createSession(tx, {
        employeeId: check.employee.id,
        deviceId: row.id,
      }),
    };
  });
}
function finishSignIn(
  res: express.Response,
  device: DeviceCookie,
  result: SignInResult,
  mode: "pin" | "login",
): { sessionId: string; reused: boolean } {
  if ("revoked" in result) {
    clearAccessCookies(res);
    throw new DomainError("device_revoked", 401);
  }
  if ("rejected" in result) throw pinError(result.rejected, mode);
  setDeviceCookie(res, device);
  if ("reused" in result) return { sessionId: result.reused, reused: true };
  setSessionCookie(
    res,
    { id: result.session.id, tenantId: device.tenantId, token: result.session.token },
    result.session.absoluteExpiresAt,
  );
  return { sessionId: result.session.id, reused: false };
}

const pinBody = z
  .object({ employeeId: z.uuid(), secret: z.string().min(4).max(200) })
  .strict();
/** POST /api/access/pin: employee picker + PIN on a paired device. */
export async function pinSignIn(
  sql: postgres.Sql,
  req: express.Request,
  res: express.Response,
): Promise<{ sessionId: string; reused: boolean }> {
  const device = readDeviceCookie(req.cookies?.gm_device);
  if (!device) throw new DomainError("device_not_paired", 401);
  const p = pinBody.parse(req.body);
  const result = await signInOnDevice(
    sql,
    req,
    device,
    { employeeId: p.employeeId },
    p.secret,
  );
  return finishSignIn(res, device, result, "pin");
}

const loginBody = z
  .object({
    tenantId: z.uuid(),
    login: z.string().min(1).max(100),
    secret: z.string().min(4).max(200),
  })
  .strict();
/**
 * POST /api/login (legacy username + password/PIN). The tenant must match the
 * paired device; only the configured demo tenant may still pair a browser with
 * the owner password. Requests without a paired device for any other tenant are
 * refused before touching the database, so they cannot lock anyone out (SEC-2).
 */
export async function legacyLogin(
  sql: postgres.Sql,
  req: express.Request,
  res: express.Response,
): Promise<{ ok: true }> {
  const p = loginBody.parse(req.body);
  const cookie = readDeviceCookie(req.cookies?.gm_device);
  if (cookie && cookie.tenantId === p.tenantId) {
    const result = await signInOnDevice(
      sql,
      req,
      cookie,
      { login: p.login },
      p.secret,
    );
    finishSignIn(res, cookie, result, "login");
    return { ok: true };
  }
  if (p.tenantId !== demoTenantId())
    throw new DomainError("device_not_paired", 401);
  type DemoResult =
    | { rejected: Exclude<PinCheck, { outcome: "ok" }> }
    | { pair: true }
    | {
        device: DeviceCookie;
        session: { id: string; token: string; absoluteExpiresAt: Date };
      };
  const result = await tenant(sql, p.tenantId, async (tx): Promise<DemoResult> => {
    const check = await checkPin(tx, { login: p.login }, p.secret, "unpaired");
    if (check.outcome !== "ok") return { rejected: check };
    if (check.employee.role !== "owner") return { pair: true };
    const device = { id: randomUUID(), tenantId: p.tenantId, token: opaque() };
    await tx`insert into devices(tenant_id,id,name,token_hash,kind,paired_at,paired_by,token_expires_at)
      values(${p.tenantId},${device.id},'POS',${hash(device.token)},'terminal',now(),${check.employee.id},
        now()+make_interval(days=>${ACCESS.deviceTokenDays}))`;
    const session = await createSession(tx, {
      employeeId: check.employee.id,
      deviceId: device.id,
    });
    return { device, session };
  });
  if ("rejected" in result) throw pinError(result.rejected, "login");
  if ("pair" in result) throw new DomainError("pair_device", 403);
  setDeviceCookie(res, result.device);
  setSessionCookie(
    res,
    { id: result.session.id, tenantId: p.tenantId, token: result.session.token },
    result.session.absoluteExpiresAt,
  );
  return { ok: true };
}

const signOutBody = z.object({ sessionId: z.uuid().optional() }).strip();
/**
 * POST /api/access/logout (and /api/logout): always succeeds. Ends the cookie's
 * session normally (queued evidence stays syncable), clears gm_session and the
 * Google account cookie, and keeps the device paired.
 *
 * A logout finished later (remembered offline) names the session it was meant
 * for; when the cookie by then holds another session (a PIN sign-in on this
 * device already ended or replaced the old one), nothing is ended or cleared,
 * so it can never sign out the next person (ACC-FLOOR-5).
 */
export async function signOut(
  sql: postgres.Sql,
  req: express.Request,
  res: express.Response,
): Promise<{ ok: true }> {
  const c = readSessionCookie(req.cookies?.gm_session);
  const intended = signOutBody.safeParse(req.body ?? {});
  const sessionId = intended.success ? intended.data.sessionId : undefined;
  if (sessionId && c && c.id !== sessionId) return { ok: true };
  if (c) {
    try {
      await tenant(
        sql,
        c.tenantId,
        (tx) => tx`update sessions set ended_at=now(),end_reason='logout',expires_at=least(expires_at,now())
          where id=${c.id} and token_hash=${hash(c.token)} and ended_at is null`,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          route: "access.logout",
          message: error instanceof Error ? error.message : "logout_failed",
        }),
      );
    }
  }
  res.clearCookie("gm_session", cookieOptions);
  if (req.cookies?.gm_account) {
    try {
      await withOwner(sql, req.cookies.gm_account, undefined, (tx, account) =>
        tx`update owner_sessions set revoked=true where id=${account.sessionId}`,
      );
    } catch (error) {
      // An absent or expired account must not prevent POS logout.
      if (!(error instanceof DomainError && error.status === 401))
        console.error(
          JSON.stringify({
            level: "error",
            route: "access.logout",
            message: error instanceof Error ? error.message : "owner_logout_failed",
          }),
        );
    }
    res.clearCookie("gm_account", cookieOptions);
  }
  return { ok: true };
}

const stepUpBody = z.object({ secret: z.string().min(4).max(200) }).strict();
/** Re-verifies the current employee's PIN for sensitive commands on terminals. */
export async function stepUp(
  sql: postgres.Sql,
  s: Session,
  raw: unknown,
): Promise<{ authenticatedAt: string }> {
  const p = stepUpBody.parse(raw);
  type StepUpResult =
    | { rejected: Exclude<PinCheck, { outcome: "ok" }> }
    | { authenticatedAt: string };
  const result = await tenant(sql, s.tenantId, async (tx): Promise<StepUpResult> => {
    const check = await checkPin(
      tx,
      { employeeId: s.employeeId },
      p.secret,
      deviceScope(s.deviceId),
    );
    if (check.outcome !== "ok") return { rejected: check };
    const [row] =
      await tx`update sessions set authenticated_at=now(),last_seen_at=now() where id=${s.id}
        returning authenticated_at`;
    return { authenticatedAt: (row.authenticated_at as Date).toISOString() };
  });
  if ("rejected" in result) throw pinError(result.rejected, "pin");
  return result;
}
