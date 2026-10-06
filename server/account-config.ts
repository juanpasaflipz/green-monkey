import { ConfigError } from "./config-error.js";
import { saasTaxConfig } from "./saas-tax.js";

/**
 * Account (031) startup checks, one pure call per process kind between the
 * "area config checks" markers of server/config-rules.ts (contract C-9). The
 * modules still read the values at runtime; this only refuses to start with a
 * value they would reject. Names only, never values.
 */
export function accountWebConfig(
  env: Record<string, string | undefined>,
  _appEnv: string,
): void {
  // Same rule as publicOrderingEnabled() in server/account-settings.ts.
  const flag = env.PUBLIC_ORDERING_ENABLED?.trim();
  if (flag && flag !== "true" && flag !== "false")
    throw new ConfigError("public_ordering_flag_invalid");
  saasTax(env, "web");
}

export function accountWorkerConfig(
  env: Record<string, string | undefined>,
  _appEnv: string,
): void {
  saasTax(env, "worker");
}

function saasTax(
  env: Record<string, string | undefined>,
  kind: "web" | "worker",
) {
  try {
    saasTaxConfig(env, kind);
  } catch {
    throw new ConfigError("saas_tax_configuration_invalid");
  }
}
