// Payments (037, P2): what the waiting panel, the active-charges banner and the resolve dialog
// say about one integrated charge, and which actions they offer (spec §5.3). Pure: no React.
import type { Locale } from "../../../shared/domain";
import {
  isLiveForOrder,
  type AttemptState,
  type AttemptView,
} from "../../../shared/payments";
import { strings, translateError, type Key } from "../../i18n";

export type AttemptAction =
  | "cancel"
  | "switch"
  | "recheck"
  | "retry"
  | "otherMethod"
  | "manualFallback"
  | "resolve"
  | "retrySettle";

export type AttemptStatus = {
  message: string;
  tone: "info" | "warning" | "error" | "success";
  /** The terminal or the order may still take or hold money (keep syncing, guard the close). */
  live: boolean;
  actions: AttemptAction[];
};

/** Approvals the settle never applies on its own (server/payments/terminal.ts FLAGGED). */
const FLAGGED = new Set([
  "payments_provider_mismatch",
  "payments_refunded_before_settle",
]);
/** A decline that means "the integration is down", not "the card was refused". */
const FALLBACK = new Set([
  "payments_terminal_offline",
  "payments_provider_unreachable",
  "payments_terminal_queue_busy",
  "payments_provider_unavailable",
]);

export const STATE_KEYS: Record<AttemptState, Key> = {
  created: "payStateCreated",
  sending: "payStateSending",
  pending: "payStatePending",
  approved: "payStateApproved",
  settled: "payApproved",
  declined: "payStateDeclined",
  cancelled: "payCancelled",
  expired: "payExpired",
  unknown: "payStateUnknown",
  review: "payStateReview",
  dismissed: "payResolveDone",
};

/** The R13 retry: from review, with the provider's paid amount, and not a flagged approval. */
export function canRetrySettle(a: AttemptView): boolean {
  return (
    a.state === "review" &&
    a.paidAmount !== null &&
    !(a.errorCode !== null && FLAGGED.has(a.errorCode))
  );
}

export function attemptStatus(
  a: AttemptView,
  locale: Locale,
  o: { manager: boolean; online: boolean },
): AttemptStatus {
  const t = (k: Key) => strings[locale][k];
  const terminal = (k: Key) => t(k).replace("{terminal}", a.terminalLabel);
  const live = isLiveForOrder(a.state);
  // Offline, a live charge only waits: recording it another way could charge twice.
  if (!o.online && live)
    return {
      message: t("payOfflineWaiting"),
      tone: "warning",
      live,
      actions: [],
    };
  switch (a.state) {
    case "created":
    case "sending":
      return {
        message: a.cancelRequested
          ? t("payCancelling")
          : terminal(
              a.state === "created" ? "payWaitingTerminal" : "paySending",
            ),
        tone: "info",
        live,
        actions: a.cancelRequested ? [] : ["cancel", "switch"],
      };
    case "pending":
      if (a.errorCode === "payments_cancel_on_terminal")
        return {
          message: t("payCancelOnTerminal"),
          tone: "warning",
          live,
          actions: ["recheck"],
        };
      return {
        message: a.cancelRequested
          ? t("payCancelling")
          : terminal("payWaitingTerminal"),
        tone: "info",
        live,
        actions: a.cancelRequested ? ["recheck"] : ["cancel", "switch"],
      };
    case "approved":
    case "settled":
      return { message: t("payApproved"), tone: "success", live, actions: [] };
    case "declined":
      return {
        message: t("payDeclined").replace(
          "{reason}",
          translateError(a.errorCode ?? "payments_provider_rejected", locale),
        ),
        tone: "error",
        live,
        actions: [
          "retry",
          "otherMethod",
          ...(a.errorCode && FALLBACK.has(a.errorCode)
            ? (["manualFallback"] as const)
            : []),
        ],
      };
    case "expired":
      return {
        message: t("payExpired"),
        tone: "error",
        live,
        actions: ["retry", "otherMethod"],
      };
    case "cancelled":
      return {
        message: t("payCancelled"),
        tone: "info",
        live,
        actions: ["retry", "otherMethod"],
      };
    case "unknown":
      // Never a blind retry: someone checks the terminal or a manager resolves. A push that
      // went dead (the worker could not record the provider's answer) names the terminal.
      return {
        message:
          a.errorCode === "payments_push_failed"
            ? terminal("payUnknownPushFailed")
            : t("payUnknown"),
        tone: "warning",
        live,
        actions: ["recheck", ...(o.manager ? (["resolve"] as const) : [])],
      };
    case "review":
      return {
        message: t("payReview"),
        tone: "warning",
        live,
        actions: [
          ...(canRetrySettle(a) ? (["retrySettle"] as const) : []),
          ...(o.manager ? (["resolve"] as const) : []),
        ],
      };
    case "dismissed":
      return {
        message: t("payResolveDone"),
        tone: "info",
        live,
        actions: ["otherMethod"],
      };
  }
}

/** The manager outcomes the resolve dialog offers for this attempt (server resolveAttempt). */
export function resolveOptions(
  a: AttemptView,
): ("record" | "not_charged" | "refunded_at_provider")[] {
  if (a.state === "unknown") return ["record", "not_charged"];
  if (a.state === "review")
    // Refunded at the provider before it was recorded: nothing to record (P2-MONEY-5).
    return a.errorCode === "payments_refunded_before_settle"
      ? ["refunded_at_provider"]
      : a.errorCode !== null && FLAGGED.has(a.errorCode)
        ? ["refunded_at_provider", "record"]
        : ["record", "refunded_at_provider"];
  return [];
}

/** sessionStorage key of the attempt this device is waiting for (a reload resumes it). */
export const waitingKey = (tenantId: string, deviceId: string) =>
  `gm-terminal-attempt:${tenantId}:${deviceId}`;
