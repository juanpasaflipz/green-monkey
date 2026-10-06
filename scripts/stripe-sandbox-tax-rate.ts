/**
 * npm run stripe:tax-rate:sandbox — creates or reconciles the sandbox IVA 16 %
 * Tax Rate for SAAS_TAX_MODE=tax_rate (account 031, GAP-6) and writes its id to
 * .env.stripe-tax-rate (mode 0600) as STRIPE_TAX_RATE_ID for the worker. Needs
 * STRIPE_SECRET_KEY (sandbox) and STRIPE_EXPECTED_ACCOUNT_ID. Creates no
 * subscription or charge.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { provisionStripeSandboxTaxRate } from "../server/stripe-catalog.js";

try {
  const result = await provisionStripeSandboxTaxRate(
    process.env.STRIPE_SECRET_KEY ?? "",
    process.env.STRIPE_EXPECTED_ACCOUNT_ID ?? "",
  );
  const temporary = ".env.stripe-tax-rate.tmp-" + randomUUID();
  await writeFile(temporary, `STRIPE_TAX_RATE_ID=${result.taxRateId}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, ".env.stripe-tax-rate");
  console.log(
    `Verified the sandbox IVA 16% tax rate for ${result.accountId}. Id saved to .env.stripe-tax-rate.`,
  );
} catch (error) {
  const code =
    error instanceof Error && /^stripe_[a-z_0-9]+$/.test(error.message)
      ? error.message
      : "stripe_tax_rate_setup_failed";
  console.error(code);
  process.exitCode = 1;
}
