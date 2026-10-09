import { useState } from "react";
import "./payments.css";
import type { Locale, Order, Session } from "../../../shared/domain";
import type { AttemptView } from "../../../shared/payments";
import { api } from "../../api";
import { Button } from "../../components/ui";
import { strings, type Key } from "../../i18n";
import { usePoll } from "../../serviceHooks";
import { STATE_KEYS, canRetrySettle } from "./attempt-text";
import { ResolveDialog } from "./ResolveDialog";

/**
 * Payments (037, P2; spec §5.1, critic R28): "Cobros en terminal en curso" in Venta and Órdenes.
 * Lists the restaurant's live and review charges (GET /payments/terminal/active, every 10 s while
 * online and visible), each with its order, terminal, amount, state and age, and opens the
 * resolve dialog (Volver a consultar for anyone; the R13 retry for anyone when a review fits;
 * the manager outcomes with step-up). Nothing shows while there is none.
 */
export function ActiveCharges({
  session,
  locale,
  online,
  money,
  onRecorded,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
  money: (n: number) => string;
  /** A retry or a manager record wrote the tender: the caller refreshes what it shows. */
  onRecorded?: (order: Order) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const manager = ["owner", "manager"].includes(session.role);
  const [rows, setRows] = useState<AttemptView[]>([]);
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState<AttemptView | null>(null);
  const poll = usePoll(
    async () => setRows(await api<AttemptView[]>("/payments/terminal/active")),
    { intervalMs: 10_000, enabled: online },
    [session.id, online],
  );
  if (!rows.length) return null;
  const now = Date.now();
  return (
    <section
      className="active-charges warning-panel"
      aria-label={t("payActiveCharges").replace("{n}", String(rows.length))}
    >
      <div className="row between wrap">
        <strong role="status">
          {t("payActiveCharges").replace("{n}", String(rows.length))}
        </strong>
        <Button aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t("payActiveChargesHide") : t("payActiveChargesShow")}
        </Button>
      </div>
      {!online && <p>{t("payOfflineWaiting")}</p>}
      {open && (
        <ul className="active-charges-list">
          {rows.map((a) => {
            const minutes = Math.max(
              0,
              Math.floor((now - Date.parse(a.createdAt)) / 60_000),
            );
            const order =
              a.orderNumber !== null
                ? `#${a.orderNumber}`
                : (a.holdLabel ?? "—");
            const actionable = a.state === "unknown" || a.state === "review";
            return (
              <li key={a.id} className="row between wrap">
                <span>
                  <strong>{order}</strong> · {a.terminalLabel} ·{" "}
                  {money(a.amount + a.tip)} · {t(STATE_KEYS[a.state])} ·{" "}
                  <span className="muted">
                    {t("payAttemptAge").replace("{minutes}", String(minutes))}
                  </span>
                </span>
                {actionable &&
                  (manager || canRetrySettle(a) || a.state === "unknown") && (
                    <Button
                      disabled={!online}
                      aria-label={`${t("payResolve")} ${order}`}
                      onClick={() => setResolving(a)}
                    >
                      {t("payResolve")}
                    </Button>
                  )}
              </li>
            );
          })}
        </ul>
      )}
      {resolving && (
        <ResolveDialog
          attempt={resolving}
          locale={locale}
          money={money}
          manager={manager}
          onClose={() => {
            setResolving(null);
            poll.refresh();
          }}
          onResolved={(r) => {
            setResolving(null);
            if (r.order) onRecorded?.(r.order);
            poll.refresh();
          }}
        />
      )}
    </section>
  );
}
