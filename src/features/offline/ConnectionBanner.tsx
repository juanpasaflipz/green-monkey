import { liveQuery } from "dexie";
import { useEffect, useState } from "react";
import { AlertTriangle, WifiOff } from "lucide-react";
import type { Locale, Session } from "../../../shared/domain";
import { setWorkOffline, serverNow, useConnectivity } from "../../connectivity";
import { db, scope } from "../../offline";
import {
  CLOCK_WARNING_MS,
  FISCAL_LATE_MS,
  offlineWindow,
} from "../../offline-policy";
import { Button } from "../../components/ui";
import { clockTime, translator } from "./format";
import "./offline.css";

/** Number of local kitchen tickets (sale/order/round records) in the last 24 h. */
function useTicketCount(session: Session) {
  const [count, setCount] = useState(0);
  const key = scope(session);
  useEffect(() => {
    const since = Date.now() - 86_400_000;
    const subscription = liveQuery(async () =>
      (await db.pending.where("scope").equals(key).toArray()).filter(
        (row) =>
          row.status !== "archived" &&
          "kind" in row.body &&
          (row.body.kind as string) !== "payment" &&
          Date.parse(row.body.recordedAt) >= since,
      ).length,
    ).subscribe({ next: setCount, error: () => {} });
    return () => subscription.unsubscribe();
  }, [key]);
  return count;
}

function useTick(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

/** Full-width connection banner for every role (§2.1, FOH-15). */
export function ConnectionBanner({
  session,
  locale,
  oldestUnresolvedAt,
  onOpenSync,
  onOpenTickets,
}: {
  session: Session;
  locale: Locale;
  queued: number;
  oldestUnresolvedAt: number | null;
  onOpenSync: () => void;
  onOpenTickets: () => void;
}) {
  const net = useConnectivity();
  const t = translator(locale);
  const tickets = useTicketCount(session);
  useTick(30_000);
  const kitchen = session.role === "kitchen";
  const now = serverNow();
  const fiscalLate =
    oldestUnresolvedAt !== null && now - oldestUnresolvedAt > FISCAL_LATE_MS;
  const skew =
    net.offsetMs !== null && Math.abs(net.offsetMs) > CLOCK_WARNING_MS
      ? Math.round(Math.abs(net.offsetMs) / 60_000)
      : null;
  const lease = offlineWindow(session.offlineUntil, now);
  const until = clockTime(session.offlineUntil, session.restaurant.timezone, locale);
  const extra = (
    <>
      {fiscalLate && <p className="connection-banner-line strong">{t("offlineFiscalLate")}</p>}
      {skew !== null && skew > 0 && (
        <p className="connection-banner-line">{t("offlineClockSkew", { min: skew })}</p>
      )}
    </>
  );
  if (net.canUseServer) {
    if (net.slow)
      return (
        <div className="connection-banner" role="status" aria-live="polite">
          <AlertTriangle size={20} aria-hidden="true" />
          <div className="connection-banner-text">
            <p>{t("offlineBannerSlow")}</p>
            {extra}
          </div>
          <div className="connection-banner-actions">
            <Button onClick={() => setWorkOffline(true)}>{t("offlineWorkOffline")}</Button>
          </div>
        </div>
      );
    if (!fiscalLate) return null;
    return (
      <div className="connection-banner" role="status" aria-live="polite">
        <AlertTriangle size={20} aria-hidden="true" />
        <div className="connection-banner-text">{extra}</div>
        <div className="connection-banner-actions">
          <Button onClick={onOpenSync}>{t("offlineViewSync")}</Button>
        </div>
      </div>
    );
  }
  const windowLine = kitchen ? null : lease.expired ? (
    <p className="connection-banner-line strong">{t("offlineWindowExpired", { time: until })}</p>
  ) : lease.minutesLeft <= 30 ? (
    <p className="connection-banner-line strong">{t("offlineWindowEnding", { time: until })}</p>
  ) : (
    <p className="connection-banner-line">{t("offlineWindowUntil", { time: until })}</p>
  );
  return (
    <div
      className={`connection-banner ${lease.expired && !kitchen ? "error" : ""}`}
      role="status"
      aria-live="polite"
    >
      <WifiOff size={20} aria-hidden="true" />
      <div className="connection-banner-text">
        <p>
          {kitchen
            ? t("offlineBannerKitchen")
            : net.manual
              ? t("offlineBannerManual")
              : t("offlineBannerOffline")}
        </p>
        {net.manual && net.serverReachable && (
          <p className="connection-banner-line">{t("offlineBannerAvailable")}</p>
        )}
        {windowLine}
        {extra}
      </div>
      <div className="connection-banner-actions">
        {net.manual && (
          <Button onClick={() => setWorkOffline(false)}>{t("offlineGoOnline")}</Button>
        )}
        {!kitchen && (
          <Button onClick={onOpenTickets}>{t("offlineTickets", { n: tickets })}</Button>
        )}
        <Button onClick={onOpenSync}>{t("offlineViewSync")}</Button>
      </div>
    </div>
  );
}
