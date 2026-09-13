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
