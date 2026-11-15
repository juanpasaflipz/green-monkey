/**
 * npm run stripe:live:setup -- --confirm-live=<acct_…>
 *
 * The owner runs this once, on their own machine, against the live Stripe
 * account (docs/BILLING_LIVE.md "Owner setup"). It creates or reconciles the
 * Green Monkey Pro product, its two MXN prices and the IVA 16 % Tax Rate, and
 * writes their ids (not secrets) to .env.stripe-live (mode 0600) for the
 * production worker. It creates no customer, subscription or charge.
 *
 * Needs STRIPE_SECRET_KEY (sk_live_ or rk_live_) and STRIPE_EXPECTED_ACCOUNT_ID
 * in the environment. The --confirm-live value must repeat the account id, so
 * the command never writes to a live account by accident.
 */
import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import {
  provisionStripeCatalog,
  provisionStripeTaxRate,
} from "../server/stripe-catalog.js";

const secret = process.env.STRIPE_SECRET_KEY ?? "";
const account = process.env.STRIPE_EXPECTED_ACCOUNT_ID ?? "";
const confirm = process.argv
  .slice(2)
  .find((a) => a.startsWith("--confirm-live="))
  ?.slice("--confirm-live=".length);

try {
  if (!/^acct_[A-Za-z0-9]+$/.test(account) || confirm !== account)
    throw Error("stripe_live_confirmation_required");
  const catalog = await provisionStripeCatalog(secret, account, "live");
  const tax = await provisionStripeTaxRate(secret, account, "live");
  const temporary = ".env.stripe-live.tmp-" + randomUUID();
  await writeFile(
    temporary,
    [
      `STRIPE_EXPECTED_ACCOUNT_ID=${catalog.accountId}`,
      `STRIPE_PRICE_PRO_MONTHLY=${catalog.monthlyPriceId}`,
      `STRIPE_PRICE_PRO_ANNUAL=${catalog.annualPriceId}`,
      `STRIPE_TAX_RATE_ID=${tax.taxRateId}`,
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  await rename(temporary, ".env.stripe-live");
  console.log(
    `Verified the live product, both prices and the IVA 16% rate for ${catalog.accountId}. Ids saved to .env.stripe-live. No customer, subscription or charge was created.`,
  );
} catch (error) {
  const code =
    error instanceof Error && /^stripe_[a-z_0-9]+$/.test(error.message)
      ? error.message
      : "stripe_live_setup_failed";
  console.error(code);
  process.exitCode = 1;
}
