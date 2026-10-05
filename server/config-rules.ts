/**
 * Pure process-configuration rules. server/config.ts applies them at startup;
 * tests call loadConfig() directly with a synthetic environment.
 */
export type ProcessKind = "web" | "worker";
export type AppEnv = "development" | "test" | "staging" | "production";
export type AlertKind = "ntfy" | "slack" | "discord" | "generic";

export interface Config {
  kind: ProcessKind;
  appEnv: AppEnv;
  /** staging or production */
  deployed: boolean;
  port: number;
  appUrl: string | null;
  logLevel: "debug" | "info" | "warn" | "error";
  /** web: DATABASE_URL; worker: WORKER_DATABASE_URL */
  databaseUrl: string;
  dbPoolMax: number;
  drainSeconds: number;
  sentryDsn: string | null;
  /** Worker only. */
  alertWebhook: { url: string; kind: AlertKind } | null;
  billingEnabled: boolean;
}

export class ConfigError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "ConfigError";
  }
}

/** Credentials that must never be present in a deployed process of each kind. */
export const forbiddenCredentials: Record<ProcessKind, readonly string[]> = {
  web: [
    "MIGRATION_DATABASE_URL",
    "BILLING_DATABASE_URL",
    "WORKER_DATABASE_URL",
    "BACKUP_DATABASE_URL",
    "PROVISION_DATABASE_URL",
    "STRIPE_SECRET_KEY",
  ],
  worker: [
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "BILLING_DATABASE_URL",
    "BACKUP_DATABASE_URL",
    "PROVISION_DATABASE_URL",
  ],
};

const appEnvs: readonly AppEnv[] = [
  "development",
  "test",
  "staging",
  "production",
];
const logLevels = ["debug", "info", "warn", "error"] as const;
const alertKinds: readonly AlertKind[] = ["ntfy", "slack", "discord", "generic"];
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Detects the process kind without depending on module evaluation order. */
export function detectKind(
  env: NodeJS.ProcessEnv,
  entry: string | undefined,
): ProcessKind {
  return env.PROCESS_KIND === "worker" ||
    /[\\/]worker\.(js|ts)$/.test(entry ?? "")
    ? "worker"
    : "web";
}

/** Loopback hosts and unix sockets need no TLS; everything else does. */
export function isLoopbackHost(hostname: string) {
  return (
    loopbackHosts.has(hostname.toLowerCase()) ||
    hostname === "" ||
    hostname.startsWith("/") ||
    hostname.startsWith("%2F")
  );
}

function positiveInt(value: string | undefined, fallback: number, code: string) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(code);
  return n;
}

function databaseUrl(value: string | undefined, name: string) {
  if (!value) throw new ConfigError(`missing_${name.toLowerCase()}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`invalid_${name.toLowerCase()}`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol))
    throw new ConfigError(`invalid_${name.toLowerCase()}`);
  if (
    !isLoopbackHost(url.hostname) &&
    url.searchParams.get("sslmode") === "disable"
  )
    throw new ConfigError("database_tls_required");
  return value;
}

/**
 * Validates the environment for one process kind. Empty strings count as
 * unset. Errors name variables only, never their values.
 */
export function loadConfig(
  rawEnv: NodeJS.ProcessEnv,
  kind: ProcessKind,
): Config {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(rawEnv))
    env[key] = value === undefined || value.trim() === "" ? undefined : value;

  const appEnv = (env.APP_ENV ?? "development") as AppEnv;
  if (!appEnvs.includes(appEnv)) throw new ConfigError("invalid_app_env");
  const deployed = appEnv === "staging" || appEnv === "production";

  if (deployed)
    for (const name of forbiddenCredentials[kind])
      if (env[name])
        throw new ConfigError(`forbidden_credential_in_process: ${name}`);

  const logLevel = (env.LOG_LEVEL ?? "info").toLowerCase() as Config["logLevel"];
  if (!logLevels.includes(logLevel)) throw new ConfigError("invalid_log_level");

  let appUrl: string | null = null;
  if (env.APP_URL) {
    let parsed: URL;
    try {
      parsed = new URL(env.APP_URL);
    } catch {
      throw new ConfigError("invalid_app_url");
    }
    if (deployed && parsed.protocol !== "https:")
      throw new ConfigError("app_url_https_required");
    appUrl = parsed.origin;
  } else if (deployed) throw new ConfigError("missing_app_url");

  // Cookie Secure and CSP follow NODE_ENV; a deployed process must not serve
  // development cookies (SEC-9).
  if (deployed && env.NODE_ENV !== "production")
    throw new ConfigError("node_env_production_required");

  const billingEnabled = env.BILLING_SANDBOX_ENABLED === "true";
  const sentryDsn = env.SENTRY_DSN ?? null;

  if (kind === "web") {
    const url = databaseUrl(env.DATABASE_URL, "DATABASE_URL");
    // Session, device, ordering and invitation tokens are signed with
    // JWT_SECRET until the keyring (OPS-10) lands.
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32)
      throw new ConfigError("missing_jwt_secret");
    if (deployed && billingEnabled && !env.STRIPE_WEBHOOK_SECRET)
      throw new ConfigError("missing_stripe_webhook_secret");
    return Object.freeze({
      kind,
      appEnv,
      deployed,
      port: positiveInt(env.PORT, 3001, "invalid_port"),
      appUrl,
      logLevel,
      databaseUrl: url,
      dbPoolMax: positiveInt(env.DB_POOL_MAX, 20, "invalid_db_pool_max"),
      drainSeconds: positiveInt(
        env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS,
        20,
        "invalid_draining_seconds",
      ),
      sentryDsn,
      alertWebhook: null,
      billingEnabled,
    });
  }

  const url = databaseUrl(env.WORKER_DATABASE_URL, "WORKER_DATABASE_URL");
  if (billingEnabled)
    for (const name of [
      "STRIPE_SECRET_KEY",
      "STRIPE_EXPECTED_ACCOUNT_ID",
      "STRIPE_PRICE_PRO_MONTHLY",
      "STRIPE_PRICE_PRO_ANNUAL",
      "STRIPE_PORTAL_CONFIG_ID",
    ])
      if (!env[name]) throw new ConfigError(`missing_${name.toLowerCase()}`);
  if (billingEnabled && !appUrl) throw new ConfigError("missing_app_url");
  let alertWebhook: Config["alertWebhook"] = null;
  if (env.ALERT_WEBHOOK_URL) {
    let parsed: URL;
    try {
      parsed = new URL(env.ALERT_WEBHOOK_URL);
    } catch {
      throw new ConfigError("invalid_alert_webhook_url");
    }
    if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname))
      throw new ConfigError("alert_webhook_https_required");
    const alertKind = (env.ALERT_WEBHOOK_KIND ?? "ntfy") as AlertKind;
    if (!alertKinds.includes(alertKind))
      throw new ConfigError("invalid_alert_webhook_kind");
    alertWebhook = { url: parsed.href, kind: alertKind };
  }
  // PROCESS_KIND=worker (Railway, containers) means PORT belongs to this
  // process. A local `npm run worker` shares .env with the web server, so it
  // uses WORKER_PORT or 3002 instead of the web PORT.
  const port =
    env.WORKER_PORT ?? (env.PROCESS_KIND === "worker" ? env.PORT : undefined);
  return Object.freeze({
    kind,
    appEnv,
    deployed,
    port: positiveInt(port, 3002, "invalid_port"),
    appUrl,
    logLevel,
    databaseUrl: url,
    dbPoolMax: positiveInt(env.DB_POOL_MAX, 6, "invalid_db_pool_max"),
    drainSeconds: positiveInt(
      env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS,
      30,
      "invalid_draining_seconds",
    ),
    sentryDsn,
    alertWebhook,
    billingEnabled,
  });
}
