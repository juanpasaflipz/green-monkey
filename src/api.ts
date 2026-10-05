import type { Session } from "../shared/domain";
export class ApiError extends Error {
  constructor(
    code: string,
    public status: number,
  ) {
    super(code);
  }
}
export type ApiOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  idempotent?: boolean;
};
let csrf = "";
let tenantId = "",
  sessionId = "";
export function setSession(s: Session) {
  csrf = s.csrf;
  tenantId = s.tenantId;
  sessionId = s.id;
  blocked = false;
  blockedBy = "";
}
export function clearSessionScope() {
  csrf = "";
  tenantId = "";
  sessionId = "";
  blocked = false;
  blockedBy = "";
}
async function request<T>(
  path: string,
  body: unknown,
  _options: ApiOptions,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
      ...(tenantId
        ? { "x-tenant-id": tenantId, "x-session-id": sessionId }
        : {}),
    },
    credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.error === "session_changed")
      window.dispatchEvent(new Event("gm-session-changed"));
    throw new ApiError(data.error ?? "error", response.status);
  }
  return data;
}

// ---- access (023): session policy ----
const SESSION_CODES = new Set([
  "unauthorized",
  "session_expired",
  "session_ended",
  "session_revoked",
  "device_revoked",
  "device_not_paired",
]);
/**
 * True for a 401 that authentication answered before any handler ran (or that
 * api() raised without sending while blocked): the command was not processed.
 */
export function isSessionRejection(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401 && SESSION_CODES.has(e.message);
}
/** After a session 401, stop calling the server until a new session is set. */
let blocked = false;
let blockedBy = "";
/** True while a session 401 keeps non-access calls from reaching the server. */
export function requestsBlocked() {
  return blocked;
}
/**
 * The session code that blocked calls, or null. App re-applies it as the lock
 * reason if no lock is showing, since a blocked call never dispatches again
 * (ACC-FLOOR-2).
 */
export function blockedReason(): string | null {
  return blocked ? blockedBy || "session_expired" : null;
}
/** While set, non-access calls wait: a PIN sign-in may be replacing the session cookie. */
let held: Promise<void> | null = null;
/**
 * Pauses non-access requests until the returned release runs (or maxMs passes),
 * so background polls never send the old x-session-id with a new gm_session
 * cookie while the lock screen signs someone in (session_changed race).
 */
export function holdRequests(maxMs = 15_000): () => void {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  held = gate;
  const release = () => {
    clearTimeout(timer);
    if (held === gate) held = null;
    open();
  };
  const timer = setTimeout(release, maxMs);
  return release;
}
let stepUp: null | ((sessionId: string) => Promise<void>) = null;
/**
 * One "Confirma con tu PIN" prompt at a time; concurrent requests of the same
 * session share it. A prompt is never shared across sessions (ACC-20).
 */
let stepUpInFlight: { sessionId: string; prompt: Promise<void> } | null = null;
/**
 * App registers the "Confirma con tu PIN" dialog. It receives the session the
 * prompt is for, and rejects when cancelled or when that session is replaced.
 */
export function registerStepUpHandler(
  fn: ((sessionId: string) => Promise<void>) | null,
) {
  stepUp = fn;
}
async function guarded<T>(
  path: string,
  body: unknown,
  options: ApiOptions,
): Promise<T> {
  try {
    return await request<T>(path, body, options);
  } catch (e) {
    if (
      e instanceof ApiError &&
      e.status === 401 &&
      SESSION_CODES.has(e.message) &&
      !path.startsWith("/access/")
    ) {
      if (sessionId) {
        blocked = true;
        blockedBy = e.message;
      }
      window.dispatchEvent(
        new CustomEvent("gm-unauthorized", { detail: e.message }),
      );
    }
    throw e;
  }
}
/**
 * Calls the API. A session 401 shows the lock screen once (gm-unauthorized)
 * and blocks further calls (FOH-7); a 403 step_up_required asks for the PIN
 * and retries the identical request once, so operationIds stay idempotent.
 * The step-up belongs to the session that sent the request: when another
 * employee switches in or the session ends meanwhile, nobody is asked and the
 * retry is never sent (session_changed, ACC-20), because it would run with the
 * new employee's cookie and CSRF token.
 */
export async function api<T = any>(
  path: string,
  body?: unknown,
  options: ApiOptions = {},
): Promise<T> {
  const access = path.startsWith("/access/");
  while (held && !access) await held;
  if (blocked && !access) throw new ApiError("session_expired", 401);
  const owner = sessionId;
  try {
    return await guarded<T>(path, body, options);
  } catch (e) {
    if (
      !(e instanceof ApiError) ||
      e.status !== 403 ||
      e.message !== "step_up_required" ||
      !stepUp
    )
      throw e;
    if (sessionId !== owner) throw new ApiError("session_changed", 409);
    if (stepUpInFlight?.sessionId !== owner) {
      const asked: Promise<void> = stepUp(owner).finally(() => {
        if (stepUpInFlight?.prompt === asked) stepUpInFlight = null;
      });
      stepUpInFlight = { sessionId: owner, prompt: asked };
    }
    await stepUpInFlight.prompt;
    if (sessionId !== owner) throw new ApiError("session_changed", 409);
    return guarded<T>(path, body, options);
  }
}
