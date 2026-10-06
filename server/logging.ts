import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type express from "express";

/**
 * Structured JSON logger. One line per call on stdout in the shape Railway
 * parses (`level`, `message`, attributes queryable as `@name:value`).
 *
 * Library module: it never imports server/config.ts. The environment is read
 * lazily on each call so DB suites and unit tests can import it freely.
 */
export type Attrs = Record<string, unknown>;
export type Level = "debug" | "info" | "warn" | "error";

export interface RequestContext {
  requestId: string;
  tenantId?: string;
  employeeId?: string;
  role?: string;
  route?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

const levels: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const SECRET_KEY =
  /pass(word)?|secret|token|cookie|authorization|csrf|pin|dsn|signature|api[-_]?key/i;
const DATABASE_URL = /postgres(ql)?:\/\/[^@\s]+@/gi;
const PROVIDER_SECRET = /\b(whsec|sk_live|sk_test|sk_user|rk)_[A-Za-z0-9_]+/g;
const MAX_STRING = 2000;
const MAX_DEPTH = 6;

function redactString(value: string): string {
  const scrubbed = value
    .replace(DATABASE_URL, "postgresql://[redacted]@")
    .replace(PROVIDER_SECRET, "[redacted]");
  return scrubbed.length > MAX_STRING
    ? scrubbed.slice(0, MAX_STRING) + "…[truncated]"
    : scrubbed;
}

function copy(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol")
    return undefined;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth >= MAX_DEPTH || seen.has(value)) return "[truncated]";
  seen.add(value);
  if (value instanceof Error)
    return { name: value.name, message: redactString(value.message) };
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => copy(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) out[key] = "[redacted]";
    else {
      const next = copy(item, depth + 1, seen);
      if (next !== undefined) out[key] = next;
    }
  }
  return out;
}

/** Deep copy with secret-looking keys, database URLs and provider keys removed. */
export function redact(value: unknown): unknown {
  return copy(value, 0, new WeakSet());
}

function processKind() {
  return process.env.PROCESS_KIND === "worker" ||
    /[\\/]worker\.(js|ts)$/.test(process.argv[1] ?? "")
    ? "worker"
    : "web";
}

function threshold(): number {
  const level = (process.env.LOG_LEVEL ?? "").trim().toLowerCase() as Level;
  return levels[level] ?? levels.info;
}

type Sink = (line: string) => void;
let sink: Sink = (line) => {
  process.stdout.write(line + "\n");
};

/** Test hook: capture log lines instead of writing to stdout. Pass null to restore. */
export function setLogSink(next: Sink | null) {
  sink =
    next ??
    ((line) => {
      process.stdout.write(line + "\n");
    });
}

/** Attributes describing an error without leaking request data. */
export function errorAttrs(error: unknown): Attrs {
  if (error === undefined || error === null) return {};
  const e = error as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    code?: unknown;
    type?: unknown;
  };
  const out: Attrs = {};
  if (typeof e.name === "string") out.errorName = e.name;
  if (typeof e.message === "string") out.errorMessage = redactString(e.message);
  else if (typeof error === "string") out.errorMessage = redactString(error);
  if (typeof e.stack === "string") out.stack = redactString(e.stack);
  if (typeof e.code === "string") {
    if (/^[0-9A-Z]{5}$/.test(e.code)) out.pgCode = e.code;
    else out.errorCode = e.code.slice(0, 64);
  }
  return out;
}

function emit(level: Level, message: string, bound: Attrs, attrs?: Attrs) {
  if (levels[level] < threshold()) return;
  const context = requestContext.getStore();
  const record: Attrs = {
    time: new Date().toISOString(),
    level,
    message,
    service: processKind(),
    env: process.env.APP_ENV?.trim() || "development",
    ...(context
      ? {
          requestId: context.requestId,
          ...(context.tenantId ? { tenantId: context.tenantId } : {}),
          ...(context.employeeId ? { employeeId: context.employeeId } : {}),
        }
      : {}),
    ...(redact(bound) as Attrs),
    ...(attrs ? (redact(attrs) as Attrs) : {}),
  };
  try {
    sink(JSON.stringify(record));
  } catch {
    /* Logging must never break request handling. */
  }
}

export interface Logger {
  debug(message: string, attrs?: Attrs): void;
  info(message: string, attrs?: Attrs): void;
  warn(message: string, attrs?: Attrs, error?: unknown): void;
  error(message: string, attrs?: Attrs, error?: unknown): void;
  child(bound: Attrs): Logger;
}

function logger(bound: Attrs): Logger {
  return {
    debug: (message, attrs) => emit("debug", message, bound, attrs),
    info: (message, attrs) => emit("info", message, bound, attrs),
    warn: (message, attrs, error) =>
      emit("warn", message, bound, { ...attrs, ...errorAttrs(error) }),
    error: (message, attrs, error) =>
      emit("error", message, bound, { ...attrs, ...errorAttrs(error) }),
    child: (more) => logger({ ...bound, ...more }),
  };
}

export const log: Logger = logger({});

type Reporter = (error: unknown, attrs: Attrs) => void;
const REPORTER = Symbol.for("green-monkey.error-reporter");

/** Installed by server/instrument.ts when SENTRY_DSN is configured. */
export function setErrorReporter(reporter: Reporter | null) {
  (globalThis as Record<symbol, unknown>)[REPORTER] = reporter ?? undefined;
}

/** Logs an unexpected error and forwards it to the error tracker when enabled. */
export function reportError(
  error: unknown,
  attrs: Attrs & { event?: string } = {},
) {
  const { event, ...rest } = attrs;
  log.error(event ?? "unhandled_error", rest, error);
  const reporter = (globalThis as Record<symbol, unknown>)[REPORTER] as
    Reporter | undefined;
  if (!reporter) return;
  try {
    reporter(error, redact(rest) as Attrs);
  } catch {
    /* The tracker is optional; its failure must not mask the original error. */
  }
}

// ---- HTTP request context, access log and error logging -------------------

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const QUIET_PATHS = new Set(["/health", "/api/health", "/api/ops/status"]);

type RequestWithContext = express.Request & {
  requestId?: string;
  session?: { tenantId?: string; employeeId?: string; role?: string };
};

/** The request's id: Railway's X-Railway-Request-Id when well formed, else a UUID. */
export function requestIdOf(req: express.Request): string {
  const r = req as RequestWithContext;
  if (r.requestId) return r.requestId;
  const header = req.get("x-railway-request-id");
  r.requestId = header && REQUEST_ID.test(header) ? header : randomUUID();
  return r.requestId;
}

/**
 * Route template for logs, never the raw path: public ordering URLs carry
 * capability tokens (/api/public/:token/...) that must not reach log storage.
 */
export function routeLabel(req: express.Request): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? `${req.baseUrl}${path}` : "unmatched";
}

/**
 * The client address. With trust proxy, req.ip is the nearest untrusted
 * X-Forwarded-For hop. When the peer is itself a trusted proxy that sent no
 * usable hop, X-Real-IP (set by Railway's edge) is used; a client-supplied
 * X-Real-IP from an untrusted peer is ignored.
 */
export function clientIp(req: express.Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const trust = req.app?.get("trust proxy fn") as
    ((addr: string, i: number) => boolean) | undefined;
  const peer = req.socket.remoteAddress ?? "";
  const realIp = req.get("x-real-ip")?.trim() ?? "";
  if (trust && peer && trust(peer, 0) && ip === peer && isIP(realIp))
    return realIp;
  return ip;
}

/** Short, non-reversible label for an address in logs. */
export const ipHash = (ip: string) =>
  createHash("sha256").update(ip).digest("hex").slice(0, 12);

/**
 * Request id + access log (OPS-4). Sets X-Request-Id, runs the rest of the
 * request inside the async logging context, and logs one http_request line on
 * finish: method, route template, status, latency, tenant and role, never
 * URLs, query strings, bodies or cookies. Successful reads log at debug so
 * KDS polling does not flood the logs; every write and every error is logged.
 * onTenantWrite receives the tenant of each successful authenticated write,
 * onTenantRead the tenant of each successful authenticated read (the jobs
 * runner uses it to resume a tenant it has not seen since a restart).
 */
export function requestLog(
  onTenantWrite?: (tenantId: string) => void,
  onTenantRead?: (tenantId: string) => void,
): express.RequestHandler {
  return (req, res, next) => {
    const requestId = requestIdOf(req);
    res.setHeader("X-Request-Id", requestId);
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const r = req as RequestWithContext;
      const status = res.statusCode;
      const read = req.method === "GET" || req.method === "HEAD";
      const attrs = {
        requestId,
        method: req.method,
        route: routeLabel(req),
        status,
        durationMs: Number((process.hrtime.bigint() - started) / 1000n) / 1000,
        tenantId: r.session?.tenantId,
        role: r.session?.role,
        edge: req.get("x-railway-edge") ?? undefined,
      };
      if (status >= 500) log.error("http_request", attrs);
      else if (status < 400 && (read || QUIET_PATHS.has(req.path)))
        log.debug("http_request", attrs);
      else log.info("http_request", attrs);
      if (status < 400 && r.session?.tenantId)
        try {
          if (read) onTenantRead?.(r.session.tenantId);
          else onTenantWrite?.(r.session.tenantId);
        } catch {
          /* observers never affect the response */
        }
    });
    requestContext.run({ requestId }, () => next());
  };
}

/**
 * Logs an error the API answered (SEC-8): 5xx with name, message, stack,
 * route template and SQLSTATE through reportError; DomainError 5xx at warn;
 * malformed or oversized bodies at info; other 4xx at debug.
 */
export function logRequestError(
  error: unknown,
  req: express.Request,
  response: { status: number; code: string },
) {
  const attrs = {
    requestId: requestIdOf(req),
    method: req.method,
    route: routeLabel(req),
    status: response.status,
    code: response.code,
  };
  if (response.code === "internal_error")
    reportError(error, { event: "request_failed", ...attrs });
  else if (response.status >= 500) log.warn("domain_error_5xx", attrs);
  else if (
    response.code === "invalid_json" ||
    response.code === "payload_too_large"
  )
    log.info("request_rejected", attrs);
  else log.debug("request_rejected", attrs);
}
