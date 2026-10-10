/**
 * Pure process-configuration rules. server/config.ts applies them at startup
 * (preloaded through server/instrument.ts); tests call loadConfig() directly.
 *
 * Process model (Wave 2.0):
 *   web     serves the API with the runtime role (DATABASE_URL) and, while
 *           sandbox billing is on, the billing capability login for owner
 *           billing commands (BILLING_DATABASE_URL) plus the webhook secret.
 *           It holds the signing keys (SIGNING_KEYS, required when deployed,
 *           never a committed placeholder). It never holds the migration owner,
 *           backup, provisioning, worker or support credentials, the Stripe
 *           secret key or the worker kinds' provider keys.
 *   worker  runs the jobs runner for worker-only kinds on its own login
 *           (WORKER_DATABASE_URL, a member of gm_jobs_worker; required when
 *           deployed), the billing provider loop (Stripe secret key) and the
 *           watchdog, and holds the provider keys of its kinds. It holds no
 *           signing key.
 * Migrations, grants and retention run in GitHub Actions as gm_migrator
 * (.github/actions/deploy, .github/workflows/retention.yml): no runtime
 * process holds the schema-owner credential (DB-1).
 *
 * This module enforces process boundaries only. Areas validate their own
 * values with one pure call between the "area config checks" markers below
 * (contract C-9), throwing ConfigError from server/config-error.ts.
 */
import { ConfigError } from "./config-error.js";
import { parseSigningKeys } from "./keyring.js";
import { cfdiWebConfig, cfdiWorkerConfig } from "./cfdi/config.js";
import { isProductionEnv } from "./production.js";
import { fiscalWebConfig } from "./fiscal-config.js";
import { accountWebConfig, accountWorkerConfig } from "./account-config.js";
import { paymentsWorkerConfig } from "./payments/config.js";

export { ConfigError };

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
  /** worker: WORKER_DATABASE_URL (jobs login), required when deployed, null when unset in development/test; web: null */
  workerDatabaseUrl: string | null;
}

/**
 * Credentials that must never be present in a deployed process of each kind
 * (DB-1, OPS-8, critic #4). The worker parses external input and holds
 * provider keys, so it holds no signing key either (P-15).
 */
export const forbiddenCredentials: Record<ProcessKind, readonly string[]> = {
  web: [
    "MIGRATION_DATABASE_URL",
    "BACKUP_DATABASE_URL",
    "PROVISION_DATABASE_URL",
    "STRIPE_SECRET_KEY",
    "WORKER_DATABASE_URL",
    "SUPPORT_DATABASE_URL",
    "FACTURAPI_API_KEY",
    "FACTURAPI_TEST_KEY",
    "CREDENTIAL_ENCRYPTION_KEY",
    "CFDI_LIVE_ENABLED",
  ],
  worker: [
    "DATABASE_URL",
    "BACKUP_DATABASE_URL",
    "PROVISION_DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "SUPPORT_DATABASE_URL",
    "SIGNING_KEYS",
    "JWT_SECRET",
  ],
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
  // DB-1 is still open for billing: the billing login reads billing tables
  // across tenants (gm_billing_worker policies), and web uses it only for
  // owner billing commands while billing is enabled. Production web never
  // holds it otherwise; the billing_requests inbox that removes it from web
  // altogether belongs to the post-launch billing area that builds the live
  // Stripe adapter (LD-15 account Q7; RUNBOOK.md, Open follow-ups).
  if (
    appEnv === "production" &&
    kind === "web" &&
    env.BILLING_DATABASE_URL &&
    env.BILLING_SANDBOX_ENABLED !== "true"
  )
    throw new ConfigError(
      "forbidden_credential_in_process: BILLING_DATABASE_URL",
    );

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
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32)
      throw new ConfigError("missing_jwt_secret");
    // JWT_SECRET stays required: it verifies legacy-format tokens and keys the lookup
    // digests (pairing codes, PIN fingerprints, invitation and transfer tokens); wave 3
    // retires it (access A1 with account's HMACs).
    // A deployed web (staging included) or Railway's production environment never runs
    // on committed or text placeholder secrets (PLATFORM-CI-1, KEYS-5).
    const live = deployed || isProductionEnv(env);
    if (live && isPlaceholderSecret(env.JWT_SECRET))
      throw new ConfigError("placeholder_jwt_secret");
    if (env.SIGNING_KEYS) {
      let ring: ReturnType<typeof parseSigningKeys>;
      try {
        ring = parseSigningKeys(env.SIGNING_KEYS);
      } catch {
        throw new ConfigError("invalid_signing_keys");
      }
      if (live && ring.some(isPlaceholderSigningKey))
        throw new ConfigError("placeholder_signing_keys");
    } else if (live)
      // Staging rehearses production, so it refuses the same configuration
      // (PLATFORM-KEYS-3): without keys the keyring would fall back to a key
      // derived from JWT_SECRET (staging) or refuse every signature at runtime
      // (production, RAILWAY_ENVIRONMENT_NAME too).
      throw new ConfigError("missing_signing_keys");
    if (billingEnabled && !env.STRIPE_WEBHOOK_SECRET)
      throw new ConfigError("missing_stripe_webhook_secret");
    // >>> area config checks: web (one pure call per area: fn(env, appEnv), throws ConfigError)
    fiscalWebConfig(env, appEnv);
    cfdiWebConfig(env, appEnv);
    accountWebConfig(env, appEnv);
    // <<< area config checks: web
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
      workerDatabaseUrl: null,
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
  // >>> area config checks: worker (one pure call per area: fn(env, appEnv), throws ConfigError)
  cfdiWorkerConfig(env, appEnv);
  accountWorkerConfig(env, appEnv);
  paymentsWorkerConfig(env, appEnv);
  // <<< area config checks: worker
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
    // A deployed worker without its jobs login would run no worker kind while
    // every health signal stays green (PLATFORM-OPS-4): refuse to start.
    workerDatabaseUrl:
      env.WORKER_DATABASE_URL || deployed
        ? databaseUrl(env.WORKER_DATABASE_URL, "WORKER_DATABASE_URL")
        : null,
  });
}

/**
 * Committed or human-typed stand-ins that must never sign anything in a deployed
 * environment: the CI and local fixture markers (the literals .gitleaks.toml allowlists)
 * and the documented placeholders.
 */
const PLACEHOLDER_MARKERS = [
  "synthetic",
  "local-only",
  "replace-me",
  "replace-with",
  "never-use",
  "demo-green-monkey",
  "changeme",
];

/** A JWT_SECRET that is a committed or documented placeholder. */
export function isPlaceholderSecret(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * A keyring entry that is not production material (PLATFORM-CI-1, KEYS-5): a fixture kid
 * (ci-*, local-*, test-*), a secret that decodes to a placeholder marker, or a secret that
 * is printable ASCII text throughout. scripts/ops/generate-signing-key.mjs writes 32 random
 * bytes, which are all printable with probability (95/256)^32, about 2e-14.
 */
export function isPlaceholderSigningKey(key: {
  kid: string;
  secret: Buffer;
}): boolean {
  if (/^(ci|local|test)-/.test(key.kid)) return true;
  const text = key.secret.toString("latin1");
  return isPlaceholderSecret(text) || /^[\x20-\x7e]+$/.test(text);
}
