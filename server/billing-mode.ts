import { isProductionEnv } from "./production.js";

/**
 * Which Stripe billing runs in this process.
 *
 * - "off": no billing (the default). Pilots get Pro from a support grant.
 * - "sandbox": BILLING_SANDBOX_ENABLED=true. Stripe test mode; no real charge.
 * - "live": BILLING_LIVE_ENABLED=true. Real charges. Production only, and the
 *   worker refuses to start it without IVA and a published legal entity with
 *   an RFC (assertSaasTaxReady, server/saas-tax.ts).
 *
 * The two switches never combine: one process talks to one Stripe mode, so a
 * test key or a test event can never touch live subscriptions, nor the reverse.
 */
import type { BillingMode } from "../shared/plans.js";
export type { BillingMode };

const flag = (env: NodeJS.ProcessEnv, name: string) => {
  const raw = env[name]?.trim() ?? "";
  if (raw === "true") return true;
  if (raw === "" || raw === "false") return false;
  throw Error("billing_mode_invalid");
};

/** Throws Error("billing_mode_invalid" | "billing_mode_conflict" | "billing_live_production_only"). */
export function billingMode(env: NodeJS.ProcessEnv): BillingMode {
  // The sandbox switch keeps its historical reading: anything but "true" is off.
  const sandbox = env.BILLING_SANDBOX_ENABLED?.trim() === "true";
  const live = flag(env, "BILLING_LIVE_ENABLED");
  if (sandbox && live) throw Error("billing_mode_conflict");
  if (live && !isProductionEnv(env))
    throw Error("billing_live_production_only");
  return live ? "live" : sandbox ? "sandbox" : "off";
}
