import type { LegalConfig } from "./legal.js";

/**
 * SaaS subscription tax (GAP-6), off by default. The web reads the mode for copy,
 * /api/account-config and the optional billing profile; the worker's Stripe
 * provider applies the tax parameters (server/billing-runtime.ts billingWorker).
 * STRIPE_TAX_RATE_ID is a worker variable: the web never reads it.
 */
export type SaasTaxConfig = {
  mode: "off" | "tax_rate";
  taxRateId: string | null;
  collectTaxId: boolean;
  taxProfileEnabled: boolean;
};
export const SAAS_TAX_RATE_PERCENT = 16;
const TAX_RATE_ID = /^txr_[A-Za-z0-9]+$/;

/** Throws Error("saas_tax_configuration_invalid") for an unknown mode or a missing worker rate id. */
export function saasTaxConfig(
  env: NodeJS.ProcessEnv,
  kind: "web" | "worker",
): SaasTaxConfig {
  const raw = env.SAAS_TAX_MODE?.trim() ?? "";
  if (!["", "off", "tax_rate"].includes(raw))
    throw Error("saas_tax_configuration_invalid");
  const mode = raw === "tax_rate" ? "tax_rate" : "off";
  const collect = env.SAAS_COLLECT_TAX_ID?.trim() ?? "";
  if (!["", "true", "false"].includes(collect))
    throw Error("saas_tax_configuration_invalid");
  let taxRateId: string | null = null;
  if (kind === "worker" && mode === "tax_rate") {
    taxRateId = env.STRIPE_TAX_RATE_ID?.trim() ?? "";
    if (!TAX_RATE_ID.test(taxRateId))
      throw Error("saas_tax_configuration_invalid");
  }
  return {
    mode,
    taxRateId,
    collectTaxId: mode === "tax_rate" && collect !== "false",
    taxProfileEnabled:
      kind === "web" && env.SAAS_TAX_PROFILE_ENABLED?.trim() === "true",
  };
}

/** Form fields for the no-card trial subscription (POST /v1/subscriptions). */
export function trialTaxParams(c: SaasTaxConfig): Record<string, string> {
  return c.mode === "tax_rate" && c.taxRateId
    ? { "default_tax_rates[0]": c.taxRateId }
    : {};
}

/** Form fields for subscription Checkout (POST /v1/checkout/sessions). */
export function checkoutTaxParams(c: SaasTaxConfig): Record<string, string> {
  if (c.mode !== "tax_rate" || !c.taxRateId) return {};
  return {
    "subscription_data[default_tax_rates][0]": c.taxRateId,
    ...(c.collectTaxId
      ? {
          "tax_id_collection[enabled]": "true",
          "customer_update[name]": "auto",
          "customer_update[address]": "auto",
          billing_address_collection: "required",
        }
      : {}),
  };
}

/**
 * Guard for the post-launch live billing mode: a live Stripe key must never be
 * accepted unless IVA is charged and the published legal entity carries an RFC.
 */
export function assertSaasTaxReady(
  env: NodeJS.ProcessEnv,
  legal: LegalConfig,
): void {
  const c = saasTaxConfig(env, "worker");
  if (
    c.mode !== "tax_rate" ||
    legal.status !== "published" ||
    !legal.entity?.rfc
  )
    throw Error("saas_tax_required_for_live_billing");
}

/** What the web may say about tax (no rate id). */
export function publicSaasTax(c: SaasTaxConfig) {
  return {
    mode: c.mode,
    ratePercent: c.mode === "tax_rate" ? SAAS_TAX_RATE_PERCENT : null,
    collectTaxId: c.collectTaxId,
    taxProfileEnabled: c.taxProfileEnabled,
    cfdiEnabled: false as const,
  };
}
