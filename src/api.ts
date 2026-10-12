import type { Session } from "../shared/domain";

export type ApiErrorKind = "domain" | "auth" | "network" | "timeout" | "server";
export class ApiError extends Error {
  constructor(
    code: string,
    public status: number,
    public kind: ApiErrorKind = "domain",
    public requestId?: string,
  ) {
    super(code);
  }
  /** Worth retrying later: the server was not reached or failed, not a domain answer. */
  get transient() {
    return (
      this.kind === "network" ||
      this.kind === "timeout" ||
      this.kind === "server"
    );
  }
}
/**
 * The server's request id of an answer (the error body's `requestId`, else the
 * X-Request-Id header): the "Referencia de soporte" an error notice shows (errorNotice).
 */
export function responseRequestId(
  response: Response,
  body: unknown,
): string | undefined {
  const id = (body as { requestId?: unknown } | null | undefined)?.requestId;
  return typeof id === "string"
    ? id
    : (response.headers.get("x-request-id") ?? undefined);
}

/**
 * The ApiError of a failed answer read outside api() (the owner console's own fetches):
 * the body's error code (else `fallback`), the status, and the request id.
 */
export function responseError(
  response: Response,
  body: unknown,
  fallback: string,
): ApiError {
  const code = (body as { error?: unknown } | null | undefined)?.error;
  return new ApiError(
    typeof code === "string" && code ? code : fallback,
    response.status,
    response.status === 401
      ? "auth"
      : response.status >= 500
        ? "server"
        : "domain",
    responseRequestId(response, body),
  );
}
export type ApiOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  idempotent?: boolean;
  /** Extra request headers (public ordering's x-gm-link-token / x-gm-status-token). */
  headers?: Record<string, string>;
  /** A raw request body instead of JSON (kiosk 039: the menu photo upload); POST. */
  raw?: { body: Blob; type: string };
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

// ---- offline (026): transport ----
export type TransportOutcome = {
  ok: boolean;
  kind?: ApiErrorKind;
  latencyMs: number;
  path: string;
};
let observer: ((o: TransportOutcome) => void) | null = null;
/** Receives every request outcome; src/connectivity.ts registers it. */
export function setTransportObserver(
  fn: ((o: TransportOutcome) => void) | null,
) {
  observer = fn;
}
let retryGate: (() => boolean) | null = null;
/** A retry is attempted only while this says the server is reachable. */
export function setRetryGate(fn: (() => boolean) | null) {
  retryGate = fn;
}

const RETRY_STATUSES = new Set([0, 502, 503, 504]);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Answers given before any handler runs: authentication's (contract §3.9: the
 * same set offline's sync classifier treats as auth), and body-parser's for a
 * body that did not arrive intact (request_aborted, request_size_invalid,
 * LD-48). The request was not processed.
 */
function answeredBeforeHandler(failure: ApiError) {
  return (
    failure.status === 401 ||
    failure.message === "session_changed" ||
    failure.message === "missing_tenant" ||
    failure.message === "request_aborted" ||
    failure.message === "request_size_invalid"
  );
}

/**
 * One API call with a timeout (GET 8 s, POST 15 s), typed failure kinds and a
 * bounded retry: GETs once on network/502/503/504, POSTs only when the caller
 * marks them idempotent (they carry an operationId). Timeouts are never
 * retried here; the caller decides.
 */
async function request<T>(
  path: string,
  body: unknown,
  options: ApiOptions,
): Promise<T> {
  const method = body === undefined ? "GET" : "POST";
  const timeoutMs = options.timeoutMs ?? (method === "GET" ? 8000 : 15000);
  let firstFailure: ApiError | null = null;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forward = () => controller.abort();
    options.signal?.addEventListener("abort", forward, { once: true });
    const started = Date.now();
    let failure: ApiError;
    try {
      let response: Response, text: string;
      try {
        response = await fetch("/api" + path, {
          method,
          headers: {
            "Content-Type": options.raw ? options.raw.type : "application/json",
            "x-csrf-token": csrf,
            ...(tenantId
              ? { "x-tenant-id": tenantId, "x-session-id": sessionId }
              : {}),
            ...(options.headers ?? {}),
          },
          credentials: "same-origin",
          signal: controller.signal,
          ...(options.raw
            ? { body: options.raw.body }
            : body !== undefined
              ? { body: JSON.stringify(body) }
              : {}),
        });
        text = await response.text();
      } catch (e) {
        if (options.signal?.aborted && !timedOut) throw e;
        throw timedOut
          ? new ApiError("request_timeout", 0, "timeout")
          : new ApiError("network_unavailable", 0, "network");
      }
      let data: any;
      if (
        (response.headers.get("content-type") ?? "").includes(
          "application/json",
        )
      )
        try {
          data = JSON.parse(text);
        } catch {
          data = undefined;
        }
      if (response.ok) {
        // A 2xx that is not JSON is a captive portal or proxy page.
        if (data === undefined)
          throw new ApiError("invalid_response", response.status, "server");
        observer?.({ ok: true, latencyMs: Date.now() - started, path });
        return data as T;
      }
      const requestId = responseRequestId(response, data);
      if (typeof data?.error === "string") {
        if (data.error === "session_changed" && typeof window !== "undefined")
          window.dispatchEvent(new Event("gm-session-changed"));
        throw new ApiError(
          data.error,
          response.status,
          response.status === 401
            ? "auth"
            : response.status >= 500
              ? "server"
              : "domain",
          requestId,
        );
      }
      if (response.status === 429)
        throw new ApiError("rate_limited", 429, "server", requestId);
      if (response.status >= 500)
        throw new ApiError(
          "server_unavailable",
          response.status,
          "server",
          requestId,
        );
      throw new ApiError("invalid_response", response.status, "domain");
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      failure = e;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", forward);
    }
    observer?.({
      ok: false,
      kind: failure.kind,
      latencyMs: Date.now() - started,
      path,
    });
    // A retried POST answered before any handler ran (a 401, 409
    // session_changed or missing_tenant, or a body that did not arrive
    // intact, answeredBeforeHandler): the first attempt may have
    // committed before its response was lost, so its outcome stays unknown.
    // Report the first (transient) failure, never an answer that callers read
    // as "not processed" (Selling clears a payment attempt on a session 401,
    // ACC-FLOOR-1, and on any 409 but operation_conflict; OFF-INT-1).
    if (firstFailure && method === "POST" && answeredBeforeHandler(failure))
      throw firstFailure;
    firstFailure ??= failure;
    const retryable =
      attempt === 0 &&
      (method === "GET" || options.idempotent === true) &&
      (failure.kind === "network" ||
        (failure.kind === "server" && RETRY_STATUSES.has(failure.status))) &&
      (retryGate?.() ?? true);
    if (!retryable) throw failure;
    await wait(method === "GET" ? 400 : 800);
  }
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
/** Raised by api() itself without sending: an offline soft unlock re-locked (ACC-R-2). */
const UNSENT_CODES = new Set(["session_locked"]);
/**
 * True for a 401 that authentication answered before any handler ran (or that
 * api() raised without sending, while blocked or re-locking): the command was
 * not processed.
 */
export function isSessionRejection(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.status === 401 &&
    (SESSION_CODES.has(e.message) || UNSENT_CODES.has(e.message))
  );
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
let softUnlockCheck: null | (() => Promise<boolean>) = null;
/**
 * The only calls a soft unlock never holds back: the lock screen's own roster,
 * PIN sign-in, step-up and sign-out, and offline evidence (/offline/sync, and
 * the legacy /sync alias), which also syncs behind any lock. Authenticated
 * /access/* reads such as the staff or device lists are checked like every
 * other call (ACC-R6-3).
 */
const SOFT_UNLOCK_EXEMPT = new Set([
  "/access/terminal",
  "/access/pin",
  "/access/step-up",
  "/access/logout",
  "/offline/sync",
  "/sync",
]);
/**
 * While the offline "Continuar como" is in effect, App checks before each
 * call whether the server answers again (ACC-R-2). When it does, App re-locks
 * and the call is refused unsent (session_locked), so a locked session never
 * works online, even in the seconds before the background health probe
 * notices. SOFT_UNLOCK_EXEMPT lists the calls that are not checked.
 */
export function registerSoftUnlockCheck(fn: (() => Promise<boolean>) | null) {
  softUnlockCheck = fn;
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
      if (typeof window !== "undefined")
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
  // Kind "auth" (contracts 3.9): offline sync classifies it as auth, never
  // as a conflict, so blocked calls never push queued sales to review (OFF-7).
  if (blocked && !access) throw new ApiError("session_expired", 401, "auth");
  if (
    softUnlockCheck &&
    !SOFT_UNLOCK_EXEMPT.has(path) &&
    (await softUnlockCheck())
  )
    throw new ApiError("session_locked", 401, "auth");
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
