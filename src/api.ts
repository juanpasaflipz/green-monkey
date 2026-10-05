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
}
export function clearSessionScope() {
  csrf = "";
  tenantId = "";
  sessionId = "";
  blocked = false;
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
/** After a session 401, stop calling the server until a new session is set. */
let blocked = false;
let stepUp: null | (() => Promise<void>) = null;
/** App registers the "Confirma con tu PIN" dialog; it rejects when cancelled. */
export function registerStepUpHandler(fn: (() => Promise<void>) | null) {
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
      if (sessionId) blocked = true;
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
 */
export async function api<T = any>(
  path: string,
  body?: unknown,
  options: ApiOptions = {},
): Promise<T> {
  if (blocked && !path.startsWith("/access/"))
    throw new ApiError("session_expired", 401);
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
    await stepUp();
    return guarded<T>(path, body, options);
  }
}
