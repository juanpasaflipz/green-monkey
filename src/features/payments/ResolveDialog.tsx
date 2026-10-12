import { useId, useState } from "react";
import type { Locale, Order } from "../../../shared/domain";
import type { AttemptView } from "../../../shared/payments";
import { parseMoneyInput } from "../../../shared/service";
import { api } from "../../api";
import { Button, Field, Modal } from "../../components/ui";
import { strings, errorNotice, translateError, type Key } from "../../i18n";
import { attemptStatus, canRetrySettle, resolveChoices } from "./attempt-text";
import { kioskChargeFit } from "../../../shared/kiosk";

type Outcome =
  | "record"
  | "not_charged"
  | "refunded_at_provider"
  | "kiosk_accept"
  | "kiosk_reject";
const OUTCOME_KEYS: Record<Outcome, Key> = {
  record: "payResolveRecord",
  not_charged: "payResolveNotCharged",
  refunded_at_provider: "payResolveRefunded",
  kiosk_accept: "kioskAcceptWithCharge",
  kiosk_reject: "kioskRejectAndRefund",
};

/**
 * Kiosk (039, critic R13): a kiosk hold's charge approved without an order resolves through its
 * hold. «Sí se cobró: registrar» becomes «Aceptar con el pago del kiosco» (the hold as its card
 * includes it now; a total above the charge collects the rest) and «Se reembolsó» becomes
 * «Rechazar y reembolsar». No partial refund in v1.
 */
export type KioskResolve = {
  /** The hold's total as its card includes it now; null while a price is unknown. */
  total: number | null;
  /** rest = total − charge, never negative. */
  accept: (note: string, rest: number) => Promise<void>;
  reject: (note: string) => Promise<void>;
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
  kiosk,
  onClose,
  onResolved,
}: {
  attempt: AttemptView;
  locale: Locale;
  money: (n: number) => string;
  manager: boolean;
  kiosk?: KioskResolve;
  onClose: () => void;
  /** The answer: the attempt now, and the order when a tender was recorded. */
  onResolved: (r: { attempt: AttemptView; order?: Order }) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const ids = useId();
  const options: Outcome[] = resolveChoices(attempt, {
    manager,
    viaHold: !!kiosk,
  });

  const [outcome, setOutcome] = useState<Outcome | null>(options[0] ?? null);
  const [reference, setReference] = useState("");
  const [charged, setCharged] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [readerCleared, setReaderCleared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const needsReference = outcome === "record" && !attempt.providerReference;
  // «No se cobró» of a Clip request with an id while Clip cannot be read (P2V-FIXES-3): the
  // server accepts it only after a bounded wait and with this attestation.
  const offersReaderCleared =
    outcome === "not_charged" &&
    attempt.provider === "clip" &&
    !!attempt.providerReference;
  const referenceOk =
    !needsReference || /^[A-Za-z0-9_-]{1,100}$/.test(reference.trim());
  // No amount from the provider: the manager types the one its history shows (spec §4.3; the
  // server checks it equals the amount + tip sent to the terminal).
  const needsCharged = outcome === "record" && attempt.paidAmount === null;
  let chargedMinor: number | null = null;
  try {
    chargedMinor = charged.trim() ? parseMoneyInput(charged, 2) : null;
  } catch {
    chargedMinor = null;
  }
  const chargedOk =
    !needsCharged || (chargedMinor !== null && chargedMinor > 0);
  // «Aceptar con el pago del kiosco»: the hold's total against the charge (no partial refund).
  const kioskTotal = kiosk?.total ?? null;
  const fit = kioskChargeFit(kioskTotal, attempt.amount);
  const rest = fit.kind === "fits" ? fit.rest : null;
  const kioskOk = outcome !== "kiosk_accept" || rest !== null;
  const canSubmit =
    !!outcome &&
    note.trim().length >= 10 &&
    confirmed &&
    referenceOk &&
    chargedOk &&
    kioskOk &&
    !busy;
  const order =
    attempt.orderNumber !== null
      ? `#${attempt.orderNumber}`
      : (attempt.holdLabel ?? "—");

  /** The kiosk outcomes run through the hold; the inbox reloads and this dialog closes. */
  async function viaKiosk(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await run();
      onClose();
    } catch (e) {
      if ((e as Error).message !== "step_up_cancelled")
        setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
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
              kiosk && outcome === "kiosk_accept"
                ? void viaKiosk(() => kiosk.accept(note.trim(), rest ?? 0))
                : kiosk && outcome === "kiosk_reject"
                  ? void viaKiosk(() => kiosk.reject(note.trim()))
                  : void send({
                      outcome,
                      note: note.trim(),
                      confirmed: true,
                      ...(needsReference
                        ? { reference: reference.trim() }
                        : {}),
                      ...(needsCharged ? { charged: chargedMinor } : {}),
                      ...(offersReaderCleared && readerCleared
                        ? { readerCleared: true }
                        : {}),
                    })
            }
          >
            {busy
              ? t("loading")
              : outcome === "kiosk_accept" && rest !== null && rest > 0
                ? t("kioskAcceptCollectRest").replace("{rest}", money(rest))
                : outcome === "kiosk_accept" || outcome === "kiosk_reject"
                  ? t(OUTCOME_KEYS[outcome])
                  : t("payResolveSubmit")}
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
          {outcome === "kiosk_accept" && (
            <>
              <p>
                {kioskTotal === null
                  ? t("kioskAcceptPriceUnknown")
                  : t("kioskAcceptTotals")
                      .replace("{total}", money(kioskTotal))
                      .replace("{charge}", money(attempt.amount))}
              </p>
              {fit.kind === "below" && (
                <p className="warning-panel" role="alert">
                  {translateError("kiosk_charge_above_total", locale)}
                </p>
              )}
              {rest !== null && rest > 0 && (
                <p className="notice">
                  {t("kioskAcceptRest").replace("{rest}", money(rest))}
                </p>
              )}
            </>
          )}
          {outcome === "kiosk_reject" && (
            <p className="notice">
              {t("kioskRejectRefundHint")
                .replace("{amount}", money(attempt.amount + attempt.tip))
                .replace("{terminal}", attempt.terminalLabel)}
            </p>
          )}
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
          {needsCharged && (
            <Field label={t("payResolveCharged")}>
              <input
                value={charged}
                inputMode="decimal"
                autoComplete="off"
                disabled={busy}
                aria-invalid={(!!charged && !chargedOk) || undefined}
                onChange={(e) => setCharged(e.target.value)}
              />
            </Field>
          )}
          <Field
            label={t(
              outcome === "refunded_at_provider" || outcome === "kiosk_reject"
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
          {offersReaderCleared && (
            <label className="option">
              <input
                type="checkbox"
                checked={readerCleared}
                disabled={busy}
                onChange={(e) => setReaderCleared(e.target.checked)}
              />
              {t("payResolveReaderCleared")}
            </label>
          )}
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
