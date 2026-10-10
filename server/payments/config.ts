/**
 * Payments process configuration (spec §4.6 config-rules row). Pure: server/config-rules.ts calls
 * paymentsWorkerConfig between its "area config checks" markers, and the worker's payments boot
 * reads the same values. The web needs nothing new: it reuses WORKER_URL for /wake and never holds
 * a provider secret (each restaurant's credentials are sealed to the worker, spec §9.1).
 *
 *   PAYMENTS_PROVIDERS     comma list ⊆ {mercadopago, clip}; empty or unset = integrated charging
 *                          off. Requires CREDENTIAL_ENCRYPTION_KEY (the worker opens the sealed
 *                          credentials) and, when deployed, WORKER_DATABASE_URL.
 *   MERCADOPAGO_API_URL    default https://api.mercadopago.com
 *   CLIP_API_URL           default https://api.payclip.io/f2f/pinpad/v1
 *                          Both may point at a loopback fake (tests/fakes/payments-fake.ts) only in
 *                          development and test; staging and production use the defaults.
 */
import { ConfigError } from "../config-error.js";
import { parseCredentialKeyring } from "../cfdi/config.js";
import type { Provider } from "../../shared/payments.js";

type Env = Record<string, string | undefined>;
type AppEnv = "development" | "test" | "staging" | "production";

export const MERCADOPAGO_API_URL = "https://api.mercadopago.com";
export const CLIP_API_URL = "https://api.payclip.io/f2f/pinpad/v1";

export type PaymentsWorkerConfig = {
  providers: Provider[];
  mercadopagoApiUrl: string;
  clipApiUrl: string;
};

const value = (env: Env, name: string) => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

function loopbackHttp(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    /^https?:$/.test(u.protocol) &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash &&
    (host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host))
  );
}

function apiUrl(env: Env, name: string, fallback: string, appEnv: AppEnv) {
  const raw = value(env, name);
  if (raw === undefined || raw.replace(/\/+$/, "") === fallback)
    return fallback;
  if ((appEnv === "development" || appEnv === "test") && loopbackHttp(raw))
    return raw.replace(/\/+$/, "");
  throw new ConfigError("payments_api_url_not_allowed");
}

/** Worker: which providers this worker serves, and their API bases. */
export function paymentsWorkerConfig(
  env: Env,
  appEnv: AppEnv,
): PaymentsWorkerConfig {
  const raw = value(env, "PAYMENTS_PROVIDERS");
  const providers: Provider[] = [];
  if (raw)
    for (const part of raw.split(",")) {
      const p = part.trim();
      if (p !== "mercadopago" && p !== "clip")
        throw new ConfigError("invalid_payments_providers");
      if (!providers.includes(p)) providers.push(p);
    }
  if (providers.length) {
    const keyring = value(env, "CREDENTIAL_ENCRYPTION_KEY");
    if (!keyring) throw new ConfigError("missing_credential_encryption_key");
    try {
      parseCredentialKeyring(keyring);
    } catch {
      throw new ConfigError("invalid_credential_encryption_key");
    }
    if (
      (appEnv === "staging" || appEnv === "production") &&
      !value(env, "WORKER_DATABASE_URL")
    )
      throw new ConfigError("payments_worker_database_required");
  }
  return {
    providers,
    mercadopagoApiUrl: apiUrl(
      env,
      "MERCADOPAGO_API_URL",
      MERCADOPAGO_API_URL,
      appEnv,
    ),
    clipApiUrl: apiUrl(env, "CLIP_API_URL", CLIP_API_URL, appEnv),
  };
}
