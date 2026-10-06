import "dotenv/config";
import { writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { provisionStripeSandboxCatalog } from "../server/stripe-catalog.js";

try {
  const result = await provisionStripeSandboxCatalog(
    process.env.STRIPE_SECRET_KEY ?? "",
    process.env.STRIPE_EXPECTED_ACCOUNT_ID ?? "",
  );
  // Non-secret IDs are written atomically after both returned Price objects pass
  // validation. Rerun reconciles by fixed product ID and unique lookup keys.
  const temporary = ".env.stripe-price-ids.tmp-" + randomUUID();
  await writeFile(
    temporary,
    `STRIPE_PRICE_PRO_MONTHLY=${result.monthlyPriceId}\nSTRIPE_PRICE_PRO_ANNUAL=${result.annualPriceId}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await rename(temporary, ".env.stripe-price-ids");
  console.log(
    `Verified sandbox product and both prices for ${result.accountId}. IDs saved to .env.stripe-price-ids. No subscriptions or charges created.`,
  );
} catch (error) {
  const code =
    error instanceof Error && /^stripe_[a-z_0-9]+$/.test(error.message)
      ? error.message
      : "stripe_catalog_setup_failed";
  console.error(code);
  process.exitCode = 1;
}
