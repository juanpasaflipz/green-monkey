/**
 * POS shell plan notices (account 031, GAP-1). Pure: the server computes it for
 * GET /api/account/shell and BillingControls reuses the trial and payment rules.
 * Highest priority first: an open drawer still selling after the lapse, a failed
 * payment, the trial or a support grant ending soon, Pro just ended, and finally
 * "this device or employee is not selected" when selling is blocked.
 */
export type PlanNoticeKind =
  | "drawer_continuation"
  | "payment_failed"
  | "trial_ending"
  | "grant_ending"
  | "pro_ended"
  | "blocked";
export type PlanNoticeSeverity = "info" | "warning" | "critical";
export type PlanNotice = {
  kind: PlanNoticeKind;
  severity: PlanNoticeSeverity;
  /** The relevant instant (trial or grant end, Pro end), when there is one. */
  at: string | null;
  continuationUntil: string | null;
};
export const NOTICE_THRESHOLDS = {
  infoMs: 7 * 864e5,
  warningMs: 3 * 864e5,
  criticalMs: 864e5,
  endedWindowMs: 7 * 864e5,
} as const;

function endingSeverity(remainingMs: number): PlanNoticeSeverity | null {
  if (remainingMs <= 0 || remainingMs > NOTICE_THRESHOLDS.infoMs) return null;
  if (remainingMs <= NOTICE_THRESHOLDS.criticalMs) return "critical";
  if (remainingMs <= NOTICE_THRESHOLDS.warningMs) return "warning";
  return "info";
}

export function planNotice(
  e: {
    plan: "free" | "pro";
    status: string;
    accessUntil: string | null;
    source: string | null;
  },
  selling: {
    allowed: boolean;
    basis: string;
    continuationUntil: string | null;
  },
  now: number,
): PlanNotice | null {
  const notice = (
    kind: PlanNoticeKind,
    severity: PlanNoticeSeverity,
    at: string | null = null,
  ): PlanNotice => ({
    kind,
    severity,
    at,
    continuationUntil: selling.continuationUntil,
  });
  if (selling.basis === "drawer_continuation")
    return notice("drawer_continuation", "critical", selling.continuationUntil);
  if (e.status === "past_due" && e.plan === "free")
    return notice("payment_failed", "critical");
  const until = e.accessUntil ? Date.parse(e.accessUntil) : NaN;
  if (Number.isFinite(until)) {
    const severity = endingSeverity(until - now);
    if (severity && e.status === "trialing")
      return notice("trial_ending", severity, e.accessUntil);
    if (severity && e.source === "support" && e.status === "active")
      return notice("grant_ending", severity, e.accessUntil);
    if (
      e.plan === "free" &&
      ["trialing", "active", "canceled"].includes(e.status) &&
      until <= now &&
      now - until <= NOTICE_THRESHOLDS.endedWindowMs
    )
      return notice("pro_ended", "warning", e.accessUntil);
  }
  if (!selling.allowed) return notice("blocked", "warning");
  return null;
}
