import { AsyncLocalStorage } from "node:async_hooks";

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

const levels: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY =
  /pass(word)?|secret|token|cookie|authorization|csrf|pin|dsn|signature|api[-_]?key/i;
const DATABASE_URL = /postgres(ql)?:\/\/[^@\s]+@/gi;
const PROVIDER_SECRET = /\b(whsec|sk_live|sk_test|rk)_[A-Za-z0-9_]+/g;
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
    | Reporter
    | undefined;
  if (!reporter) return;
  try {
    reporter(error, redact(rest) as Attrs);
  } catch {
    /* The tracker is optional; its failure must not mask the original error. */
  }
}
