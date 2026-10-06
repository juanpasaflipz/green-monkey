import { useRef, useState } from "react";
import type { Locale } from "../../../shared/domain";
import type { PaymentAttempt } from "../../../shared/offline-recovery";
import { api } from "../../api";
import { Button, Field } from "../../components/ui";
import { clearPaymentAttempt } from "../../offline";
import { translator } from "./format";

export type AttemptStatus = { state: string; retryAllowed?: boolean };

/**
 * OFFLINE-RECOVERY-05: a manager's way out for a payment attempt the server
 * never recorded and the device may not resend. "Registrar cobro verificado"
 * records the money the guest handed over in the attempt's original drawer;
 * "Descartar intento" says the guest was not charged. Either closes the
 * attempt on the server for good, then clears it here, so its order is no
 * longer blocked on this device.
 */
export function AttemptResolution({
  attemptKey,
  attempt,
  status,
  locale,
  busy,
  run,
  resolved,
}: {
  attemptKey: string;
  attempt: PaymentAttempt;
  status: AttemptStatus | undefined;
  locale: Locale;
  busy: boolean;
  run: (fn: () => Promise<void>) => void;
  resolved: (status: AttemptStatus) => void;
}) {
  const t = translator(locale);
  const [outcome, setOutcome] = useState<"recorded" | "discarded" | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const command = useRef(crypto.randomUUID());
  if (status?.state === "discarded")
    return (
      <>
        <p>{t("offlineAttemptDiscarded")}</p>
        <Button
          disabled={busy}
          onClick={() =>
            void run(() => clearPaymentAttempt(attemptKey, attempt))
          }
        >
          {t("offlineAttemptDismiss")}
        </Button>
      </>
    );
  const missing = status?.state === "missing" && !status.retryAllowed;
  if (!missing && status?.state !== "order_missing") return null;
  const open = (next: "recorded" | "discarded") => {
    command.current = crypto.randomUUID();
    setOutcome(next);
    setReason("");
    setConfirmed(false);
  };
  return (
    <>
      <div className="row">
        {missing && (
          <Button disabled={busy} onClick={() => open("recorded")}>
            {t("offlineAttemptRecord")}
          </Button>
        )}
        <Button disabled={busy} onClick={() => open("discarded")}>
          {t("offlineAttemptDiscard")}
        </Button>
      </div>
      {outcome && (
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const result = await api<{ state: string }>(
                "/offline/attempts/resolve",
                {
                  operationId: command.current,
                  attempt,
                  outcome,
                  reason,
                  confirmed,
                },
                { idempotent: true },
              );
              await clearPaymentAttempt(attemptKey, attempt);
              setOutcome(null);
              resolved({
                state: result.state === "discarded" ? "discarded" : "committed",
              });
            });
          }}
        >
          <p>
            {t(
              outcome === "recorded"
                ? "offlineAttemptRecordHint"
                : "offlineAttemptDiscardHint",
            )}
          </p>
          <Field label={t("offlineAttemptReason")}>
            <textarea
              required
              minLength={10}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <label className="row">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t("offlineAttemptConfirm")}
          </label>
          <Button
            type="submit"
            disabled={busy || !confirmed || reason.trim().length < 10}
          >
            {t(
              outcome === "recorded"
                ? "offlineAttemptSubmitRecord"
                : "offlineAttemptSubmitDiscard",
            )}
          </Button>
          <Button onClick={() => setOutcome(null)}>{t("offlineCancel")}</Button>
        </form>
      )}
    </>
  );
}
