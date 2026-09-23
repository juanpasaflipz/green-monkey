export type BillingStatus =
  "free" | "trialing" | "active" | "past_due" | "canceled" | "paused";
export interface Entitlement {
  status: BillingStatus;
  accessUntil: string | null;
  source: "stripe" | "fixture";
}
export function accessPlan(
  entitlement: Entitlement | null,
  now = Date.now(),
): "free" | "pro" {
  if (
    !entitlement ||
    !["trialing", "active", "past_due"].includes(entitlement.status)
  )
    return "free";
  const until = entitlement.accessUntil
    ? Date.parse(entitlement.accessUntil)
    : NaN;
  return Number.isFinite(until) && now < until ? "pro" : "free";
}
export const PLAN_FEATURES = {
  free: [
    "cash",
    "external_terminal_recording",
    "tables",
    "split_payments",
    "refunds",
    "receipts",
    "offline_cash",
    "history",
    "export",
  ],
  pro: [
    "kiosk",
    "qr_ordering",
    "advanced_inventory",
    "advanced_reporting",
    "multiple_registers",
    "expanded_team",
  ],
} as const;

/** Owner-approved commercial policy, September 13, 2026. These are subscription
 * amounts, never restaurant tender totals. Checkout must verify configured Stripe
 * Price records against this policy before offering a purchase.
 */
export const PRO_OFFER = {
  currency: "MXN",
  monthlyMinor: 79_900,
  annualMinor: 799_000,
  trialDays: 14,
  trialRequiresCard: false,
  trialStartsAt: "restaurant_creation",
  billingUnit: "restaurant_location",
  taxBehavior: "exclusive",
  perEmployeeFee: false,
  kioskIncluded: true,
  freeBetaUntilQualified: true,
} as const;
export const PRO_ANNUAL_SAVING_MINOR =
  PRO_OFFER.monthlyMinor * 12 - PRO_OFFER.annualMinor;

export const FREE_LIMITS = { devices: 1, employees: 2 } as const;
