import { useId, useState } from "react";
import type { Locale, Order } from "../../../shared/domain";
import type { AttemptView } from "../../../shared/payments";
import { api } from "../../api";
import { Button, Field, Modal } from "../../components/ui";
import { strings, errorNotice, type Key } from "../../i18n";
import { attemptStatus, canRetrySettle, resolveOptions } from "./attempt-text";

type Outcome = "record" | "not_charged" | "refunded_at_provider";
const OUTCOME_KEYS: Record<Outcome, Key> = {
  record: "payResolveRecord",
  not_charged: "payResolveNotCharged",
  refunded_at_provider: "payResolveRefunded",
};

/**
 * Payments (037, P2; spec §4.3 resolveAttempt, critic R13): a terminal charge whose outcome is
 * unknown, or that was approved but could not be applied (review). Any operator can ask the
 * provider again or, when a review now fits, record the approved charge (no step-up). A manager
 * records it (from unknown with the provider's reference), says it was not charged, or that it
 * was refunded at the provider, with a note and the confirmation that they checked the provider's
 * history; the server asks for a recent PIN (api() prompts and retries).
 */
export function ResolveDialog({
  attempt,
  locale,
  money,
  manager,
  onClose,
  onResolved,
}: {
  attempt: AttemptView;
  locale: Locale;
  money: (n: number) => string;
  manager: boolean;
  onClose: () => void;
  /** The answer: the attempt now, and the order when a tender was recorded. */
  onResolved: (r: { attempt: AttemptView; order?: Order }) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const ids = useId();
  const options = manager ? resolveOptions(attempt) : [];
  const [outcome, setOutcome] = useState<Outcome | null>(options[0] ?? null);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const needsReference = outcome === "record" && !attempt.providerReference;
  const referenceOk =
    !needsReference || /^[A-Za-z0-9_-]{1,100}$/.test(reference.trim());
  const canSubmit =
    !!outcome && note.trim().length >= 10 && confirmed && referenceOk && !busy;
  const order =
    attempt.orderNumber !== null
      ? `#${attempt.orderNumber}`
      : (attempt.holdLabel ?? "—");

  async function send(body: Record<string, unknown>, done = true) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await api<{ attempt: AttemptView; order?: Order }>(
        `/payments/terminal/charges/${attempt.id}/resolve`,
        { operationId: crypto.randomUUID(), ...body },
      );
      if (done) onResolved(result);
      else setStatus(t("payRecheckSent"));
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("payResolveTitle")}
      close={() => !busy && onClose()}
      closeLabel={t("close")}
      footer={
        options.length ? (
          <Button
            variant="primary"
            className="full"
            disabled={!canSubmit}
            onClick={() =>
              void send({
                outcome,
                note: note.trim(),
                confirmed: true,
                ...(needsReference ? { reference: reference.trim() } : {}),
              })
            }
          >
            {busy ? t("loading") : t("payResolveSubmit")}
          </Button>
        ) : undefined
      }
    >
      <p>
        <strong>
          {t("payResolveCharge")
            .replace("{terminal}", attempt.terminalLabel)
            .replace("{amount}", money(attempt.amount + attempt.tip))
            .replace("{order}", order)}
        </strong>
      </p>
      <p role="status">
        {attemptStatus(attempt, locale, { manager, online: true }).message}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="notice" role="status">
          {status}
        </p>
      )}
      <div className="row wrap">
        <Button
          disabled={busy}
          onClick={() => void send({ outcome: "check" }, false)}
        >
          {t("payRecheck")}
        </Button>
        {canRetrySettle(attempt) && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void send({ outcome: "retry" })}
          >
            {t("payRetrySettle")}
          </Button>
        )}
      </div>
      {canRetrySettle(attempt) && (
        <p className="muted tiny">{t("payResolveRetryHint")}</p>
      )}
      {options.length > 0 ? (
        <>
          <p className="muted">{t("payResolveHint")}</p>
          <fieldset>
            <legend>{t("payResolveOutcome")}</legend>
            {options.map((o) => (
              <label className="option" key={o}>
                <input
                  type="radio"
                  name={`${ids}-outcome`}
                  checked={outcome === o}
                  disabled={busy}
                  onChange={() => setOutcome(o)}
                />
                {t(OUTCOME_KEYS[o])}
              </label>
            ))}
          </fieldset>
          {needsReference && (
            <Field label={t("payResolveReference")}>
              <input
                value={reference}
                maxLength={100}
                autoComplete="off"
                disabled={busy}
                aria-invalid={(!!reference && !referenceOk) || undefined}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
          )}
          <Field
            label={t(
              outcome === "refunded_at_provider"
                ? "payResolveRefundNote"
                : "payResolveNote",
            )}
          >
            <textarea
              value={note}
              maxLength={500}
              rows={3}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <label className="option">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t("payResolveConfirm")}
          </label>
        </>
      ) : (
        !canRetrySettle(attempt) &&
        !manager && <p className="muted">{t("payResolveManagerOnly")}</p>
      )}
      {manager && !options.length && !canRetrySettle(attempt) && (
        <p className="muted">{t("payResolveNoOptions")}</p>
      )}
    </Modal>
  );
}
