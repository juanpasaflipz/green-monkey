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
      this.kind === "network" || this.kind === "timeout" || this.kind === "server"
    );
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
}
export function clearSessionScope() {
  csrf = "";
  tenantId = "";
  sessionId = "";
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
export function setTransportObserver(fn: ((o: TransportOutcome) => void) | null) {
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
            "Content-Type": "application/json",
            "x-csrf-token": csrf,
            ...(tenantId
              ? { "x-tenant-id": tenantId, "x-session-id": sessionId }
              : {}),
          },
          credentials: "same-origin",
          signal: controller.signal,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        text = await response.text();
      } catch (e) {
        if (options.signal?.aborted && !timedOut) throw e;
        throw timedOut
          ? new ApiError("request_timeout", 0, "timeout")
          : new ApiError("network_unavailable", 0, "network");
      }
      let data: any;
      if ((response.headers.get("content-type") ?? "").includes("application/json"))
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
          data.requestId,
        );
      }
      if (response.status === 429)
        throw new ApiError("rate_limited", 429, "server");
      if (response.status >= 500)
        throw new ApiError("server_unavailable", response.status, "server");
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

export async function api<T = any>(
  path: string,
  body?: unknown,
  options: ApiOptions = {},
): Promise<T> {
  return request<T>(path, body, options);
}
