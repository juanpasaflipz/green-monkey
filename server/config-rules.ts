/**
 * Pure process-configuration rules. server/config.ts applies them at startup
 * (preloaded through server/instrument.ts); tests call loadConfig() directly.
 *
 * Process model (wave 1):
 *   web     serves the API with the runtime role (DATABASE_URL) and, when
 *           billing is enabled, the billing capability login for owner
 *           billing commands (BILLING_DATABASE_URL) plus the webhook secret.
 *           It never holds the migration owner, backup or provisioning
 *           credentials, nor the Stripe secret key.
 *   worker  runs the billing provider loop (Stripe secret key) and the
 *           watchdog. Its Railway preDeploy runs migrate + grants, so the
 *           migration credential lives in the worker service, not in web.
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
  /** web: DATABASE_URL (runtime role); worker: null */
  databaseUrl: string | null;
  /** BILLING_DATABASE_URL when billing is enabled */
  billingDatabaseUrl: string | null;
  dbPoolMax: number;
  drainSeconds: number;
  sentryDsn: string | null;
  alertWebhook: { url: string; kind: AlertKind } | null;
  /** web only: private URL of the worker's /healthz for /api/ops/status */
  workerUrl: string | null;
  billingEnabled: boolean;
}

export class ConfigError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "ConfigError";
  }
}

/** Credentials that must never be present in a deployed process of each kind (DB-1, OPS-8). */
export const forbiddenCredentials: Record<ProcessKind, readonly string[]> = {
  web: [
    "MIGRATION_DATABASE_URL",
    "BACKUP_DATABASE_URL",
    "PROVISION_DATABASE_URL",
    "STRIPE_SECRET_KEY",
  ],
  worker: ["DATABASE_URL", "BACKUP_DATABASE_URL", "PROVISION_DATABASE_URL"],
};

const appEnvs: readonly AppEnv[] = [
  "development",
  "test",
  "staging",
  "production",
];
const logLevels = ["debug", "info", "warn", "error"] as const;
const alertKinds: readonly AlertKind[] = [
  "ntfy",
  "slack",
  "discord",
  "generic",
];
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

function positiveInt(
  value: string | undefined,
  fallback: number,
  code: string,
) {
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

function httpUrl(value: string, code: string, requireHttps: boolean) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(code);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new ConfigError(code);
  if (requireHttps && parsed.protocol !== "https:")
    throw new ConfigError(code.replace(/^invalid_/, "") + "_https_required");
  return parsed;
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

  const logLevel = (
    env.LOG_LEVEL ?? "info"
  ).toLowerCase() as Config["logLevel"];
  if (!logLevels.includes(logLevel)) throw new ConfigError("invalid_log_level");

  const appUrl = env.APP_URL
    ? httpUrl(env.APP_URL, "invalid_app_url", deployed).origin
    : null;
  if (deployed && !appUrl) throw new ConfigError("missing_app_url");

  // Cookie Secure and CSP follow NODE_ENV; a deployed process must not serve
  // development cookies (SEC-9).
  if (deployed && env.NODE_ENV !== "production")
    throw new ConfigError("node_env_production_required");

  const billingEnabled = env.BILLING_SANDBOX_ENABLED === "true";
  const billingDatabaseUrl = billingEnabled
    ? databaseUrl(env.BILLING_DATABASE_URL, "BILLING_DATABASE_URL")
    : null;
  let alertWebhook: Config["alertWebhook"] = null;
  if (env.ALERT_WEBHOOK_URL) {
    const parsed = httpUrl(
      env.ALERT_WEBHOOK_URL,
      "invalid_alert_webhook_url",
      false,
    );
    if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname))
      throw new ConfigError("alert_webhook_https_required");
    const alertKind = (env.ALERT_WEBHOOK_KIND ?? "ntfy") as AlertKind;
    if (!alertKinds.includes(alertKind))
      throw new ConfigError("invalid_alert_webhook_kind");
    alertWebhook = { url: parsed.href, kind: alertKind };
  }
  const common = {
    kind,
    appEnv,
    deployed,
    appUrl,
    logLevel,
    billingDatabaseUrl,
    sentryDsn: env.SENTRY_DSN ?? null,
    alertWebhook,
    billingEnabled,
  };

  if (kind === "web") {
    const url = databaseUrl(env.DATABASE_URL, "DATABASE_URL");
    // Session, device, ordering and invitation tokens are signed with
    // JWT_SECRET until the keyring (OPS-10) lands.
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32)
      throw new ConfigError("missing_jwt_secret");
    if (billingEnabled && !env.STRIPE_WEBHOOK_SECRET)
      throw new ConfigError("missing_stripe_webhook_secret");
    return Object.freeze({
      ...common,
      port: positiveInt(env.PORT, 3001, "invalid_port"),
      databaseUrl: url,
      dbPoolMax: positiveInt(env.DB_POOL_MAX, 20, "invalid_db_pool_max"),
      drainSeconds: positiveInt(
        env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS,
        20,
        "invalid_draining_seconds",
      ),
      workerUrl: env.WORKER_URL
        ? httpUrl(env.WORKER_URL, "invalid_worker_url", false).origin
        : null,
    });
  }

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
  // PROCESS_KIND=worker (Railway, containers) means PORT belongs to this
  // process. A local `npm run worker` shares .env with the web server, so it
  // uses WORKER_PORT or 3002 instead of the web PORT.
  const port =
    env.WORKER_PORT ?? (env.PROCESS_KIND === "worker" ? env.PORT : undefined);
  return Object.freeze({
    ...common,
    port: positiveInt(port, 3002, "invalid_port"),
    databaseUrl: null,
    dbPoolMax: positiveInt(env.DB_POOL_MAX, 4, "invalid_db_pool_max"),
    drainSeconds: positiveInt(
      env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS,
      30,
      "invalid_draining_seconds",
    ),
    workerUrl: null,
  });
}
