import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { api } from "../../api";
import { useConnectivity } from "../../connectivity";
import { Button, Modal } from "../../components/ui";
import { translateError } from "../../i18n";
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
 * columns until someone says whether the kitchen already prepared them.
 */
export function OfflineKitchenReview({
  session,
  locale,
  onDecided,
}: {
  session: Session;
  locale: Locale;
  onDecided?: () => void;
}) {
  const t = translator(locale);
  const net = useConnectivity();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const inflight = useRef(false);
  const canPrepare = ["owner", "manager", "kitchen"].includes(session.role);
  const canServe = canPrepare || session.role === "server";
  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const result = await api<{ items: ReviewItem[] }>("/offline/kitchen");
      setItems(result.items);
    } catch {
      /* The next poll retries; the live KDS keeps working. */
    } finally {
      inflight.current = false;
    }
  }, []);
  useEffect(() => {
    if (!net.canUseServer) return;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10_000);
    return () => clearInterval(timer);
  }, [net.canUseServer, load]);
  async function decide(roundId: string, decision: "prepare" | "already_served") {
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
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
      await load();
      onDecided?.();
    }
  }
  if (!items.length) return null;
  const time = (iso: string) => clockTime(iso, session.restaurant.timezone, locale);
  return (
    <section className="offline-review-lane" aria-labelledby="offline-review-title">
      <header>
        <div>
          <h2 id="offline-review-title">
            {t("offlineKitchenReviewTitle", { n: items.length })}
          </h2>
          <p>{t("offlineKitchenReviewHint")}</p>
        </div>
        {canServe && (
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
              {t("offlineTicketRound", { n: item.round })} · {t(item.mode as "takeaway")}
              {item.tableName ? ` · ${item.tableName}` : ""}
              {item.name ? ` · ${item.name}` : ""}
            </p>
            <ul>
              {item.lines.map((line) => (
                <li key={line.id}>
                  {Math.max(0, line.quantity - line.voidedQuantity)} × {line.name[locale]}
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
                  onClick={() => void run(() => decide(item.roundId, "already_served"))}
                >
                  {t("offlineKitchenAlreadyServed")}
                </Button>
              )}
              {canPrepare && (
                <Button
                  disabled={busy}
                  onClick={() => void run(() => decide(item.roundId, "prepare"))}
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
            <Button onClick={() => setConfirmAll(false)}>{t("offlineCancel")}</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
