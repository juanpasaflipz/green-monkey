import { useEffect, useRef, useState } from "react";
import type { Locale } from "../../../shared/domain";
import {
  STATUS_POLL,
  type DinerHoldView,
  type PublicMenuView,
} from "../../../shared/public-ordering";
import { strings, type Key } from "../../i18n";
import { ApiError } from "../../api";
import { Button, Modal } from "../../components/ui";
import { fill, moneyFormatter } from "../menu/format";
import { dinerApi, guestError } from "./dinerApi";
import type { StoredHold } from "./DinerApp";

/** The next status poll in ms, or null when the hold needs no more polling. */
export function nextStatusPoll(
  v: DinerHoldView | null,
  elapsedMs: number,
): number | null {
  if (elapsedMs >= STATUS_POLL.maxMs) return null;
  if (!v) return STATUS_POLL.slowMs;
  if (v.state === "pending")
    return elapsedMs < STATUS_POLL.fastForMs
      ? STATUS_POLL.fastMs
      : STATUS_POLL.slowMs;
  if (v.state !== "accepted" || !v.order) return null;
  const served = v.order.progress === "served";
  const settled = !v.order.money || v.order.money.balance <= 0;
  return served && settled ? null : STATUS_POLL.acceptedMs;
}

const reasonKey: Record<string, Key> = {
  unavailable: "publicReasonUnavailableDiner",
  duplicate: "publicReasonDuplicateDiner",
  not_present: "publicReasonNotPresentDiner",
  closed: "publicReasonClosedDiner",
  other: "publicReasonOtherDiner",
};
const progressKey: Record<string, Key> = {
  preparing: "publicProgressPreparing",
  ready: "publicProgressReady",
  served: "publicProgressServed",
};

/**
 * One of this phone's orders: waiting, confirmed (with its progress and, for
 * a new check, the money), rejected, expired or cancelled. Polls only while
 * the page is visible and stops once nothing can change.
 */
export function DinerStatus({
  token,
  locale,
  menu,
  statusKey,
  holds,
  focusHeading = false,
  onSelect,
  onForget,
  onNewOrder,
  onRestore,
}: {
  token: string;
  /** Move focus to the status heading on mount (after a send or "Tus pedidos"). */
  focusHeading?: boolean;
  locale: Locale;
  /** null when the page's code no longer opens the menu (replaced). */
  menu: PublicMenuView | null;
  statusKey: string;
  holds: StoredHold[];
  onSelect: (key: string) => void;
  onForget: (key: string) => void;
  onNewOrder: () => void;
  onRestore: (key: string) => void;
}) {
  const t = (k: Key, values?: Record<string, string | number>) =>
    values ? fill(strings[locale][k], values) : strings[locale][k];
  const [view, setView] = useState<DinerHoldView | null>(null);
  const restaurant = view?.restaurant ?? menu?.restaurant;
  const money = moneyFormatter(locale, restaurant?.currency ?? "MXN");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const forget = useRef(onForget);
  forget.current = onForget;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, []);

  useEffect(() => {
    setView(null);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last: DinerHoldView | null = null;
    let stopped = false;
    const started = Date.now();
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const delay = nextStatusPoll(last, Date.now() - started);
      if (delay === null) {
        stopped = true;
        return;
      }
      if (live && document.visibilityState === "visible")
        timer = setTimeout(() => void load(), delay);
    };
    const load = async () => {
      try {
        const v = await dinerApi.status(token, statusKey);
        if (!live) return;
        last = v;
        setView(v);
        setError("");
      } catch (e) {
        if (!live) return;
        if (e instanceof ApiError && e.message === "public_hold_not_found") {
          forget.current(statusKey);
          return;
        }
        setError(guestError((e as Error).message, locale));
      }
      schedule();
    };
    const visibility = () => {
      if (document.visibilityState === "visible" && !stopped && !timer)
        void load();
      else if (document.visibilityState !== "visible" && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener("visibilitychange", visibility);
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [token, statusKey]);

  async function cancel() {
    setBusy(true);
    try {
      setView(await dinerApi.cancel(token, statusKey));
      setError("");
    } catch (e) {
      setError(guestError((e as Error).message, locale));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale === "es" ? "es-MX" : "en-US", {
      timeZone: restaurant?.timezone,
      hour: "2-digit",
      minute: "2-digit",
      // 21:42 in Spanish (es-MX), 9:42 PM in English.
      hourCycle: locale === "es" ? "h23" : undefined,
    }).format(new Date(iso));
  const others = holds.filter((h) => h.key !== statusKey);

  return (
    <section className="diner-status">
      <h2 ref={heading} tabIndex={-1} className="diner-status-heading">
        {t("publicOrderStatus")}
      </h2>
      {/* One live region stays mounted from loading to loaded, and only its
          text changes, so the confirmation is read (UX-6). */}
      <div className="diner-status-head" role="status">
        {!view ? (
          <p>{error || t("loading")}</p>
        ) : (
          <>
            <p className="diner-status-title">
              <strong className="diner-code">{view.label}</strong>
              {" · "}
              {view.state === "pending"
                ? view.policy === "pay_first"
                  ? t("publicStatusPayFirst")
                  : t("publicStatusPending")
                : view.state === "accepted" && view.order
                  ? view.order.target === "new"
                    ? t("publicStatusAccepted", { number: view.order.number })
                    : t("publicStatusAppended")
                  : view.state === "rejected"
                    ? t("publicStatusRejected")
                    : view.state === "expired"
                      ? t("publicStatusExpired")
                      : t("publicStatusCancelled")}
            </p>
            {view.state === "accepted" && view.order && (
              <p className="diner-progress">
                {t(progressKey[view.order.progress])}
              </p>
            )}
            {view.state === "rejected" && (
              <p>{t(reasonKey[view.rejectReason ?? "other"])}</p>
            )}
          </>
        )}
      </div>
      {view && (
        <>
          {view.state === "accepted" && view.priceChanged && (
            <p className="diner-price-changed">
              {t("publicPriceChangedAccepted", { amount: money(view.total) })}
            </p>
          )}
          {view.state === "accepted" && view.order?.money && (
            <p className="diner-money">
              {view.order.money.balance > 0
                ? t("publicBalanceDue", {
                    amount: money(view.order.money.balance),
                  })
                : t("publicPaid")}
              {view.order.fiscal &&
                " · " + t("publicFolio", { folio: view.order.fiscal.folio })}
            </p>
          )}
          {view.order?.fiscal?.selfInvoiceCode && (
            <p>
              <a
                href={"/f/" + view.order.fiscal.selfInvoiceCode}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("publicInvoiceLink")}
              </a>
            </p>
          )}
          <ul className="diner-lines">
            {view.lines.map((l) => (
              <li
                key={l.id}
                className={"diner-line" + (l.excluded ? " excluded" : "")}
              >
                <div className="diner-line-main">
                  <span className="diner-line-name">
                    {fill(strings[locale].publicQuantity, { n: l.quantity })}{" "}
                    {l.name[locale]}
                  </span>
                  {l.optionNames.length > 0 && (
                    <small className="muted">
                      {l.optionNames.map((o) => o[locale]).join(" · ")}
                    </small>
                  )}
                </div>
                <strong className="diner-line-total">{money(l.total)}</strong>
              </li>
            ))}
          </ul>
          {view.lines.some((l) => l.excluded) && (
            <p className="muted">
              {t("publicExcluded", {
                items: view.lines
                  .filter((l) => l.excluded)
                  .map((l) => l.name[locale])
                  .join(", "),
              })}
            </p>
          )}
          {!(view.state === "accepted" && view.order?.money) && (
            <p className="diner-total">
              <span>{t("publicTotal")}</span>
              <strong>{money(view.total)}</strong>
            </p>
          )}
          {view.state === "pending" && (
            <>
              <p className="muted">
                {t("publicStatusExpiresAt", { time: time(view.expiresAt) })}
              </p>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                {t("publicCancelOrder")}
              </Button>
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row wrap diner-status-actions">
            {view.state === "rejected" && (
              <Button variant="primary" onClick={() => onRestore(statusKey)}>
                {t("publicBackToMenu")}
              </Button>
            )}
            {view.state === "expired" && (
              <Button variant="primary" onClick={() => onRestore(statusKey)}>
                {t("publicTryAgain")}
              </Button>
            )}
            {view.state !== "rejected" && view.state !== "expired" && (
              <Button
                variant={view.state === "cancelled" ? "primary" : "secondary"}
                onClick={onNewOrder}
              >
                {t("publicOrderAgain")}
              </Button>
            )}
          </div>
        </>
      )}
      {others.length > 0 && (
        <nav className="diner-history" aria-label={t("publicYourOrders")}>
          <h2>{t("publicYourOrders")}</h2>
          <div className="row wrap">
            {holds.map((h) => (
              <Button
                key={h.key}
                aria-current={h.key === statusKey ? "true" : undefined}
                onClick={() => onSelect(h.key)}
              >
                {h.label}
              </Button>
            ))}
          </div>
        </nav>
      )}
      {confirming && (
        <Modal
          title={t("publicCancelConfirm")}
          close={() => setConfirming(false)}
          closeLabel={t("publicKeepOrder")}
          footer={
            <div className="row wrap">
              <Button variant="danger" disabled={busy} onClick={cancel}>
                {t("publicCancelOrder")}
              </Button>
              <Button onClick={() => setConfirming(false)}>
                {t("publicKeepOrder")}
              </Button>
            </div>
          }
        >
          <p>{view?.label}</p>
        </Modal>
      )}
    </section>
  );
}
