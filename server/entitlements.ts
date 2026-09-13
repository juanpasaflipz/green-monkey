import type { Tx } from "./db.js";
import { accessPlan } from "../shared/plans.js";
import { DomainError } from "../shared/domain.js";
export async function entitlement(tx: Tx) {
  const [row] =
    await tx`select status,access_until,source,trial_used from restaurant_entitlements`;
  const snapshot = row
    ? {
        status: row.status,
        accessUntil: row.access_until?.toISOString() ?? null,
        source: row.source,
      }
    : null;
  const [clock] = await tx`select clock_timestamp() as now`;
  const plan = accessPlan(snapshot, clock.now.getTime());
  return {
    plan,
    status: row?.status ?? "free",
    accessUntil: snapshot?.accessUntil ?? null,
    trialUsed: row?.trial_used ?? false,
    kiosk: plan === "pro",
    qrOrdering: plan === "pro",
  };
}
export async function requirePro(tx: Tx) {
  if ((await entitlement(tx)).plan !== "pro")
    throw new DomainError("pro_required", 403);
}
