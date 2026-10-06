/**
 * cfdi process configuration (spec §4.10). Pure: server/config-rules.ts calls one function per
 * process between its "area config checks" markers (contract C-9) with the normalized environment
 * (an empty string is unset); the worker boot hook and the web portal read the typed values.
 * Errors are ConfigError codes naming variables, never values.
 *
 * Wave 2.0 (d) already refuses FACTURAPI_API_KEY, FACTURAPI_TEST_KEY, CREDENTIAL_ENCRYPTION_KEY,
 * CFDI_LIVE_ENABLED and WORKER_DATABASE_URL in a deployed web process, and MIGRATION_DATABASE_URL
 * in both; this module does not repeat those rules.
 */
import { ConfigError } from "../config-error.js";

type Env = Record<string, string | undefined>;
type AppEnv = "development" | "test" | "staging" | "production";

export type CfdiProviderMode = "disabled" | "sandbox_shared" | "organizations";
export type CfdiWorkerConfig = {
  provider: CfdiProviderMode;
  userKey: string | null;
  testKey: string | null;
  /** Kids of CREDENTIAL_ENCRYPTION_KEY (active first); null without a User key. */
  keyring: { active: string; kids: string[] } | null;
  liveEnabled: boolean;
  graceMinutes: number;
  /** FACTURAPI_BASE_URL (development/test, loopback only) or null for the official URL. */
  baseUrl: string | null;
};
export type CfdiWebConfig = { linkExpiryHours: number };

export type Keyring = {
  /** Kid that seals. */
  active: string;
  kids: string[];
  /** Raw secrets by kid (never logged). */
  secrets: ReadonlyMap<string, Uint8Array>;
};

const KID = /^[a-z0-9-]{1,32}$/;

/**
 * Parses CREDENTIAL_ENCRYPTION_KEY = "kid:secret[,kid:secret…]" (spec §4.5): kid ^[a-z0-9-]{1,32}$,
 * secret base64url of ≥ 32 bytes, kids unique, the first entry active. Throws
 * Error("invalid_credential_encryption_key") naming no value. Pure (server/cfdi/vault.ts derives
 * the keys; this module only validates, so the web process never loads the vault).
 */
export function parseCredentialKeyring(raw: string): Keyring {
  const invalid = () =>
    Object.assign(new Error("invalid_credential_encryption_key"), {
      code: "invalid_credential_encryption_key",
    });
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (!entries.length) throw invalid();
  const secrets = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const colon = entry.indexOf(":");
    if (colon < 1) throw invalid();
    const kid = entry.slice(0, colon);
    const encoded = entry.slice(colon + 1);
    if (!KID.test(kid) || secrets.has(kid)) throw invalid();
    if (!/^[A-Za-z0-9_-]{43,}={0,2}$/.test(encoded)) throw invalid();
    const secret = Buffer.from(encoded, "base64url");
    if (secret.length < 32) throw invalid();
    secrets.set(kid, new Uint8Array(secret));
  }
  const kids = [...secrets.keys()];
  return { active: kids[0], kids, secrets };
}

const value = (env: Env, name: string) => {
  const v = env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
};
const deployedEnv = (appEnv: AppEnv) =>
  appEnv === "staging" || appEnv === "production";

function integer(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  code: string,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d{1,6}$/.test(raw)) throw new ConfigError(code);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(code);
  return n;
}

function loopback(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    /^https?:$/.test(parsed.protocol) &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash &&
    (host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host))
  );
}

/** Web: the portal link lifetime; FACTURAPI_BASE_URL never in a deployed web. */
export function cfdiWebConfig(env: Env, appEnv: AppEnv): CfdiWebConfig {
  if (deployedEnv(appEnv) && value(env, "FACTURAPI_BASE_URL"))
    throw new ConfigError("cfdi_base_url_not_allowed");
  return {
    linkExpiryHours: integer(
      value(env, "CFDI_INVOICE_LINK_EXPIRY_HOURS"),
      72,
      1,
      168,
      "invalid_cfdi_invoice_link_expiry_hours",
    ),
  };
}

/** Worker: provider keys, keyring, live switch, grace and the dev/test base URL. */
export function cfdiWorkerConfig(env: Env, appEnv: AppEnv): CfdiWorkerConfig {
  const userKey = value(env, "FACTURAPI_API_KEY") ?? null;
  const testKey = value(env, "FACTURAPI_TEST_KEY") ?? null;
  const rawKeyring = value(env, "CREDENTIAL_ENCRYPTION_KEY");
  const liveRaw = value(env, "CFDI_LIVE_ENABLED");
  const baseUrl = value(env, "FACTURAPI_BASE_URL") ?? null;
  const deployed = deployedEnv(appEnv);

  if (userKey && !/^sk_user_[A-Za-z0-9_.-]{1,500}$/.test(userKey))
    throw new ConfigError("invalid_facturapi_api_key");
  if (testKey && !/^sk_test_[A-Za-z0-9_.-]{1,500}$/.test(testKey))
    throw new ConfigError("invalid_facturapi_test_key");
  let keyring: CfdiWorkerConfig["keyring"] = null;
  if (userKey) {
    if (!rawKeyring) throw new ConfigError("missing_credential_encryption_key");
    try {
      const ring = parseCredentialKeyring(rawKeyring);
      keyring = { active: ring.active, kids: ring.kids };
    } catch {
      throw new ConfigError("invalid_credential_encryption_key");
    }
  } else if (rawKeyring) {
    try {
      parseCredentialKeyring(rawKeyring);
    } catch {
      throw new ConfigError("invalid_credential_encryption_key");
    }
  }
  // Keys in a deployed worker that never runs cfdi would only sit there (spec §4.10).
  if (deployed && (userKey || testKey) && !value(env, "WORKER_DATABASE_URL"))
    throw new ConfigError("cfdi_worker_database_required");
  if (liveRaw !== undefined && liveRaw !== "true" && liveRaw !== "false")
    throw new ConfigError("invalid_cfdi_live_enabled");
  const liveEnabled = liveRaw === "true";
  if (liveEnabled && (appEnv !== "production" || !userKey))
    throw new ConfigError("cfdi_live_not_allowed");
  if (testKey && !userKey && appEnv === "production")
    throw new ConfigError("cfdi_shared_sandbox_not_allowed");
  if (
    baseUrl &&
    !((appEnv === "development" || appEnv === "test") && loopback(baseUrl))
  )
    throw new ConfigError("cfdi_base_url_not_allowed");
  const graceMinutes = integer(
    value(env, "CFDI_GLOBAL_GRACE_MINUTES"),
    60,
    0,
    600,
    "invalid_cfdi_global_grace_minutes",
  );
  const provider: CfdiProviderMode = userKey
    ? "organizations"
    : testKey
      ? "sandbox_shared"
      : "disabled";
  return {
    provider,
    userKey,
    testKey,
    keyring,
    liveEnabled,
    graceMinutes,
    baseUrl,
  };
}
