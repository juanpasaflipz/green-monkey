import { useEffect, useState } from "react";
import type { Locale, Session } from "../../shared/domain";
import type { PlanNotice as Notice } from "../../shared/plan-notice";
import { api } from "../api";
import { Button } from "../components/ui";
import { strings, type Key } from "../i18n";
import "./account.css";

type Shell = {
  plan: "free" | "pro";
  status: string;
  accessUntil: string | null;
  source: string | null;
  notice: Notice | null;
  selling: {
    allowed: boolean;
    basis: string;
    continuationUntil: string | null;
  };
  freeSelection: {
    deviceName: string | null;
    thisDevice: boolean;
    mode: string;
  };
  account: null | {
    legalPending: boolean;
    legalAnnounced: string | null;
    transfers: Array<{
      id: string;
      initiatedBy: string;
      toEmailMasked: string;
      availableAt: string;
      expiresAt: string;
      organizationName: string;
    }>;
    supportActions: Array<{ action: string; createdAt: string }>;
  };
};
const POLL_MS = 300_000;
/** Today in the restaurant's time zone (UX-12), so a dismissal lasts the local day. */
let zone = "America/Mexico_City";
const today = () => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};
function dismissed(key: string) {
  try {
    return localStorage.getItem(key) === today();
  } catch {
    return false;
  }
}
function dismiss(key: string) {
  try {
    localStorage.setItem(key, today());
  } catch {
    /* Storage unavailable: the notice simply stays. */
  }
}

/**
 * POS shell plan notices (account 031, GAP-1): drawer continuation, payment
 * failure, trial or support-grant ending, Pro ended and "not selected" on
 * Free, plus the owner's account notices. Polls GET /api/account/shell every
 * 5 minutes while online and on gm-session-refresh; kitchen screens show none.
 */
export function PlanNotice({
  session,
  locale,
  online,
  navigate,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
  navigate: (view: string) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const [shell, setShell] = useState<Shell | null>(null);
  const [, setTick] = useState(0);
  const kitchen = session.role === "kitchen";
  useEffect(() => {
    if (kitchen) return;
    let alive = true;
    const load = () => {
      if (!online) return;
      api<Shell>("/account/shell")
        .then((s) => {
          if (!alive) return;
          setShell(s);
        })
        // Locked, switched or offline sessions keep the last answer (I-15).
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, POLL_MS);
    window.addEventListener("gm-session-refresh", load);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("gm-session-refresh", load);
    };
  }, [kitchen, online, session.id]);
  if (kitchen) return null;
  const tag = locale === "es" ? "es-MX" : "en-US";
  zone = session.restaurant.timezone;
  const date = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(tag, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: zone,
        }).format(new Date(iso))
      : "";
  const time = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(tag, {
          timeStyle: "short",
          timeZone: zone,
        }).format(new Date(iso))
      : "";
  // Until the first answer (or when it fails), the session's own flag still
  // tells a blocked employee why sales cannot start.
  if (!shell)
    return session.sellingAllowed === false ? (
      <p role="status" className="warning">
        {t("accountNoticeBlockedFallback")}
      </p>
    ) : null;
  const managerView = ["owner", "manager"].includes(session.role);
  const device = shell.freeSelection.deviceName ?? t("accountNoticeNoDevice");
  const n = shell.notice;
  let text = "";
  let cta: { label: Key; view: string } | null = null;
  if (n) {
    switch (n.kind) {
      case "drawer_continuation":
        text = t("accountNoticeContinuation").replace("{time}", time(n.at));
        if (managerView)
          cta = { label: "accountNoticeReviewPlan", view: "settings" };
        break;
      case "payment_failed":
        text = managerView
          ? t("accountNoticePaymentFailed")
          : t("accountNoticePaymentFailedStaff");
        if (session.role === "owner")
          cta = { label: "accountNoticeUpdatePayment", view: "settings" };
        break;
      case "trial_ending":
        if (managerView) {
          text = t("accountNoticeTrialEnding")
            .replace("{date}", date(n.at))
            .replace("{device}", device);
          cta = { label: "accountNoticeReviewPlan", view: "settings" };
        } else if (n.severity === "critical")
          text = t("accountNoticeTrialEndingStaff").replace(
            "{time}",
            time(n.at),
          );
        break;
      case "grant_ending":
        if (managerView)
          text = t("accountNoticeGrantEnding").replace("{date}", date(n.at));
        break;
      case "pro_ended":
        text = t("accountNoticeProEnded")
          .replace("{date}", date(n.at))
          .replace("{device}", device);
        if (managerView)
          cta = { label: "accountNoticeReviewPlan", view: "settings" };
        break;
      case "blocked":
        text = t("accountNoticeBlocked").replace("{device}", device);
        if (session.role === "owner")
          cta = { label: "accountNoticeChangeSelection", view: "settings" };
        break;
    }
  }
  const key = n ? `gm-notice:${session.tenantId}:${n.kind}:${n.at ?? ""}` : "";
  const showPlan = Boolean(text) && !(n?.severity === "info" && dismissed(key));
  const legalKey = `gm-notice:${session.tenantId}:legal:`;
  const account = shell.account;
  const labels = (action: string) =>
    strings[locale][`accountSupportAction_${action}` as Key] ?? action;
  return (
    <>
      {showPlan && (
        <div
          role={n!.severity === "critical" ? "alert" : "status"}
          className={`plan-notice ${n!.severity}`}
        >
          <p>{text}</p>
          <div className="row">
            {cta && (
              <Button onClick={() => navigate(cta!.view)}>
                {t(cta.label)}
              </Button>
            )}
            {n!.severity === "info" && (
              <Button
                variant="ghost"
                onClick={() => {
                  dismiss(key);
                  setTick((x) => x + 1);
                }}
              >
                {t("accountNoticeDismiss")}
              </Button>
            )}
          </div>
        </div>
      )}
      {account?.transfers.map((transfer) => {
        // Only transfers the primary did not start are warnings (ACC-1): the
        // server sends no others, and an unknown kind is never shown as one.
        const warning: Key | null =
          transfer.initiatedBy === "support"
            ? "accountTransferSupportInitiated"
            : transfer.initiatedBy === "recovery_code"
              ? "accountTransferRecoveryInitiated"
              : null;
        if (!warning) return null;
        return (
          <div role="alert" className="plan-notice critical" key={transfer.id}>
            <p>
              {t(warning)
                .replace("{email}", transfer.toEmailMasked)
                .replace("{date}", date(transfer.availableAt))}
            </p>
            {/* A PIN-entered owner seat (shared terminal) cannot open the
                account console here; it is told where to cancel (ACC-5). */}
            {session.access?.ownerAccount === false ? (
              <p>{t("accountTransferCancelElsewhere")}</p>
            ) : (
              <div className="row">
                <Button onClick={() => (location.href = "/app?account=1")}>
                  {t("accountTransferCancel")}
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {account?.legalPending && !dismissed(legalKey) && (
        <div role="status" className="plan-notice info">
          <p>{t("accountNoticeLegalPending")}</p>
          <Button
            variant="ghost"
            onClick={() => {
              dismiss(legalKey);
              setTick((x) => x + 1);
            }}
          >
            {t("accountNoticeDismiss")}
          </Button>
        </div>
      )}
      {account?.legalAnnounced &&
        !account.legalPending &&
        !dismissed(`${legalKey}announced:${account.legalAnnounced}`) && (
          // A material change announced 15 days ahead (LEGAL-3).
          <div role="status" className="plan-notice info">
            <p>
              {t("accountNoticeLegalAnnounced").replace(
                "{date}",
                new Intl.DateTimeFormat(tag, { dateStyle: "long" }).format(
                  new Date(`${account.legalAnnounced}T12:00:00-06:00`),
                ),
              )}
            </p>
            <div className="row">
              <a
                className="button"
                href="/legal"
                target="_blank"
                rel="noopener"
              >
                {t("accountLegalIndexTitle")}
              </a>
              <Button
                variant="ghost"
                onClick={() => {
                  dismiss(`${legalKey}announced:${account.legalAnnounced}`);
                  setTick((x) => x + 1);
                }}
              >
                {t("accountNoticeDismiss")}
              </Button>
            </div>
          </div>
        )}
      {account?.supportActions.slice(0, 1).map((a) => (
        <p role="status" className="plan-notice info" key={a.createdAt}>
          {t("accountNoticeSupportAction")
            .replace("{date}", date(a.createdAt))
            .replace("{action}", labels(a.action))}
        </p>
      ))}
    </>
  );
}
