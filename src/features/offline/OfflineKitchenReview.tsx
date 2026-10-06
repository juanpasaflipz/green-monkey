import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { api } from "../../api";
import { useConnectivity } from "../../connectivity";
import { Button, Modal } from "../../components/ui";
import { errorNotice } from "../../i18n";
import { lanePollDelay } from "../../offline-policy";
import { clockTime, translator } from "./format";
import "./offline.css";

type ReviewItem = {
  roundId: string;
  orderId: string;
  orderNumber: number;
  provisionalNumber: string | null;
  station: string;
  round: number;
  soldAt: string;
  syncedAt: string;
  kitchenDelivery: string;
  deviceName: string | null;
  mode: string;
  tableName: string | null;
  name: string;
  lines: {
    id: string;
    quantity: number;
    voidedQuantity: number;
    name: { es: string; en: string };
    optionNames: { es: string; en: string }[];
    note: string;
  }[];
};

/**
 * KDS lane for rounds created by offline sync (OFF-4). They stay out of the live
 * columns until someone says whether the kitchen already prepared them. The
 * lane shows the KDS's selected station only, so clearing one station never
 * marks another station's rounds as served (OFF-R23).
 *
 * Refresh (GAP-4): on mount, when the page becomes visible, when the device
 * can use the server again and after each decision; then every 10 s while
 * there is something to review and every 30 s while there is nothing, only
 * while the page is visible.
 */
export function OfflineKitchenReview({
  session,
  locale,
  station,
  onDecided,
}: {
  session: Session;
  locale: Locale;
  /** The KDS's selected station: "all", "kitchen" or "bar" (service's Kitchen). */
  station: string;
  onDecided?: () => void;
}) {
  const t = translator(locale);
  const net = useConnectivity();
  const [all, setAll] = useState<ReviewItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const inflight = useRef(false);
  const canPrepare = ["owner", "manager", "kitchen"].includes(session.role);
  const canServe = canPrepare || session.role === "server";
  /** Loads the lane; resolves with the number of items still to review. */
  const load = useCallback(async (): Promise<number | null> => {
    if (inflight.current) return null;
    inflight.current = true;
    try {
      const result = await api<{ items: ReviewItem[] }>("/offline/kitchen");
      setAll(result.items);
      return result.items.length;
    } catch {
      /* The next poll retries; the live KDS keeps working. */
      return null;
    } finally {
      inflight.current = false;
    }
  }, []);
  /** Items at the last successful load: the next delay depends on it. */
  const count = useRef(0);
  useEffect(() => {
    if (!net.canUseServer) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One timeout chain, re-armed after each load with the adaptive delay.
    const arm = () => {
      clearTimeout(timer);
      if (!live) return;
      timer = setTimeout(() => void tick(), lanePollDelay(count.current));
    };
    const tick = async () => {
      if (document.visibilityState === "visible") {
        const loaded = await load();
        if (loaded !== null) count.current = loaded;
      }
      arm();
    };
    const visible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", visible);
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [net.canUseServer, load]);
  // "all" (service's KDS) shows every station, so clearing it clears what is
  // on screen; a single-station screen never clears the other one (OFF-R23).
  const items =
    station === "all" ? all : all.filter((item) => item.station === station);
  const others = all.length - items.length;
  async function decide(
    roundId: string,
    decision: "prepare" | "already_served",
  ) {
    const result = await api<{ alreadyDecided: boolean }>(
      `/offline/kitchen/${roundId}/decision`,
      { operationId: crypto.randomUUID(), decision },
      { idempotent: true },
    );
    if (result.alreadyDecided) setError(t("offlineDecided"));
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
      const loaded = await load();
      if (loaded !== null) count.current = loaded;
      onDecided?.();
    }
  }
  if (!all.length) return null;
  const time = (iso: string) =>
    clockTime(iso, session.restaurant.timezone, locale);
  const otherStation = t(station === "bar" ? "kitchen" : "bar");
  return (
    <section
      className="offline-review-lane"
      aria-labelledby="offline-review-title"
    >
      <header>
        <div>
          <h2 id="offline-review-title">
            {t("offlineKitchenReviewTitle", { n: items.length })}
          </h2>
          <p>{t("offlineKitchenReviewHint")}</p>
          {others > 0 && (
            <p className="muted">
              {t("offlineKitchenOtherStation", {
                n: others,
                station: otherStation,
              })}
            </p>
          )}
        </div>
        {canServe && items.length > 0 && (
          <Button disabled={busy} onClick={() => setConfirmAll(true)}>
            {t("offlineKitchenAllServed")}
          </Button>
        )}
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="offline-review-grid">
        {items.map((item) => (
          <article className="offline-review-card" key={item.roundId}>
            <h3>
              {item.provisionalNumber
                ? t("offlineMapped", {
                    provisional: item.provisionalNumber,
                    number: item.orderNumber,
                  })
                : `#${item.orderNumber}`}
            </h3>
            <p>
              {t(item.station === "bar" ? "bar" : "kitchen")} ·{" "}
              {t("offlineTicketRound", { n: item.round })} ·{" "}
              {t(item.mode as "takeaway")}
              {item.tableName ? ` · ${item.tableName}` : ""}
              {item.name ? ` · ${item.name}` : ""}
            </p>
            <ul>
              {item.lines.map((line) => (
                <li key={line.id}>
                  {Math.max(0, line.quantity - line.voidedQuantity)} ×{" "}
                  {line.name[locale]}
                  {line.optionNames.length
                    ? ` (${line.optionNames.map((o) => o[locale]).join(", ")})`
                    : ""}
                  {line.note ? ` — ${line.note}` : ""}
                </li>
              ))}
            </ul>
            <p className="muted">
              {t("offlineKitchenSold", {
                time: time(item.soldAt),
                synced: time(item.syncedAt),
              })}
              <br />
              {item.kitchenDelivery === "print_requested"
                ? t("offlineKitchenDeliveryPrinted")
                : t("offlineKitchenDeliveryList")}
            </p>
            <div className="row">
              {canServe && (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(() => decide(item.roundId, "already_served"))
                  }
                >
                  {t("offlineKitchenAlreadyServed")}
                </Button>
              )}
              {canPrepare && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(() => decide(item.roundId, "prepare"))
                  }
                >
                  {t("offlineKitchenPrepare")}
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      {confirmAll && (
        <Modal
          title={t("offlineKitchenAllServed")}
          close={() => setConfirmAll(false)}
          closeLabel={t("close")}
        >
          <p>{t("offlineKitchenAllServedConfirm", { n: items.length })}</p>
          <div className="row">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                const pending = [...items];
                setConfirmAll(false);
                void run(async () => {
                  // Sequential: each decision is its own idempotent command.
                  for (const item of pending)
                    await decide(item.roundId, "already_served");
                });
              }}
            >
              {t("offlineKitchenAlreadyServed")}
            </Button>
            <Button onClick={() => setConfirmAll(false)}>
              {t("offlineCancel")}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
