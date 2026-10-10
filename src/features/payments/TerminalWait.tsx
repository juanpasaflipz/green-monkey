import { useEffect, useState } from "react";
import "./payments.css";
import type { Locale } from "../../../shared/domain";
import type { AttemptView } from "../../../shared/payments";
import { Button } from "../../components/ui";
import { strings, type Key } from "../../i18n";
import { attemptStatus, type AttemptAction } from "./attempt-text";

/**
 * Payments (037, P2; spec §5.3): the waiting panel inside the payment dialog while a charge is on
 * an integrated terminal. It shows the terminal, the amount in large type, the elapsed time and
 * the attempt's status line (a polite live region), and offers only the actions that state allows
 * (attempt-text.ts): Cancelar cobro and Cambiar de terminal while it waits, Volver a consultar
 * and Resolver (managers) when the outcome is unknown, Reintentar and Otra forma de pago after a
 * decline, «Registrar el cobro aprobado» (any operator, R13) when a review now fits.
 */
export function TerminalWait({
  attempt,
  locale,
  money,
  online,
  manager,
  busy,
  onAction,
}: {
  attempt: AttemptView;
  locale: Locale;
  money: (n: number) => string;
  online: boolean;
  manager: boolean;
  busy: boolean;
  onAction: (action: AttemptAction) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const status = attemptStatus(attempt, locale, { manager, online });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!status.live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status.live]);
  const seconds = Math.max(
    0,
    Math.floor((now - Date.parse(attempt.createdAt)) / 1000),
  );
  const labels: Record<AttemptAction, Key> = {
    cancel: "payCancelCharge",
    switch: "paySwitchTerminal",
    recheck: "payRecheck",
    retry: "payRetryCharge",
    otherMethod: "payOtherMethod",
    manualFallback: "payManualFallback",
    resolve: "payResolve",
    retrySettle: "payRetrySettle",
  };
  return (
    <section
      className={`terminal-wait ${status.tone}`}
      aria-label={attempt.terminalLabel}
    >
      <p className="muted">{attempt.terminalLabel}</p>
      <div className="large-money">{money(attempt.amount + attempt.tip)}</div>
      {attempt.tip > 0 && (
        <p className="muted">
          {t("payChargeTotal").replace(
            "{amount}",
            `${money(attempt.amount)} + ${money(attempt.tip)}`,
          )}
        </p>
      )}
      <p
        className={
          status.tone === "error"
            ? "error"
            : status.tone === "warning"
              ? "warning-panel"
              : "notice"
        }
        role="status"
        aria-live="polite"
      >
        {status.message}
      </p>
      {status.live && (
        <p className="muted" aria-hidden="true">
          {t("payElapsed").replace("{seconds}", String(seconds))}
        </p>
      )}
      {attempt.cardLast4 && (
        <p className="muted">
          {(attempt.cardBrand ?? "").toUpperCase()} •••• {attempt.cardLast4}
        </p>
      )}
      {status.actions.includes("manualFallback") && (
        <p className="muted tiny">{t("payManualFallbackHint")}</p>
      )}
      {status.actions.includes("switch") && (
        <p className="muted tiny">{t("paySwitchHint")}</p>
      )}
      {status.actions.length > 0 && (
        <div className="row wrap">
          {status.actions.map((action) => (
            <Button
              key={action}
              variant={
                action === "retrySettle" || action === "retry"
                  ? "primary"
                  : action === "cancel"
                    ? "danger"
                    : "secondary"
              }
              disabled={
                busy ||
                (!online &&
                  action !== "manualFallback" &&
                  action !== "otherMethod")
              }
              onClick={() => onAction(action)}
            >
              {t(labels[action])}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
