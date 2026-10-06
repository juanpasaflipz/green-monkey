import { useState, type FormEvent } from "react";
import {
  currencyExponent,
  minor,
  type Locale,
  type Session,
} from "../../../shared/domain";
import type { CorteDocument, DrawerRow } from "../../../shared/reports";
import { strings, translateError } from "../../i18n";
import { Button, Field, Modal } from "../../components/ui";
import { remoteClose } from "./api";
import { CortePreview } from "./CortePreview";
import { DrawerCorteDocument } from "./documents";
import { fill, money } from "./format";

/**
 * "Cerrar caja de {dispositivo}" (spec §2.11): a manager closes a drawer whose device was revoked
 * or that is open from an earlier business day, with a visible count and a reason. Count →
 * confirm → result (the corte Z). The server asks for the PIN (step-up) and api() retries the
 * identical body; the operation id is kept across retries and replaced only after a success.
 */
export function RemoteCloseDialog({
  session,
  locale,
  drawer,
  close,
  closed,
}: {
  session: Session;
  locale: Locale;
  drawer: DrawerRow;
  close: () => void;
  closed: () => void;
}) {
  const t = strings[locale];
  const m = money(session.restaurant.currency, locale);
  const exponent = currencyExponent(session.restaurant.currency);
  const [step, setStep] = useState<"count" | "confirm" | "done">("count");
  const [counted, setCounted] = useState("");
  const [reported, setReported] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<CorteDocument | null>(null);
  const [printing, setPrinting] = useState(false);
  const amount = (text: string): number | null => {
    try {
      return text.trim() === "" ? null : minor(text.trim(), exponent);
    } catch {
      return null;
    }
  };
  const countedAmount = amount(counted);

  function review(e: FormEvent) {
    e.preventDefault();
    if (
      countedAmount === null ||
      (reported.trim() && amount(reported) === null)
    ) {
      setError(translateError("invalid_input", locale));
      return;
    }
    if (reason.trim().length < 3) {
      setError(translateError("reason_required", locale));
      return;
    }
    setError("");
    setStep("confirm");
  }
  async function submit() {
    if (countedAmount === null) return;
    setBusy(true);
    setError("");
    try {
      const doc = await remoteClose(drawer.id, {
        operationId,
        counted: countedAmount,
        reason: reason.trim(),
        externalReported: reported.trim() ? amount(reported) : null,
      });
      setOperationId(crypto.randomUUID());
      setResult(doc);
      setStep("done");
      closed();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }

  if (printing && result)
    return (
      <CortePreview
        session={session}
        locale={locale}
        target={{ kind: "drawer", drawerId: drawer.id }}
        close={close}
      />
    );
  return (
    <Modal
      title={fill(t.reportsRemoteCloseTitle, { device: drawer.deviceName })}
      close={close}
      closeLabel={t.close}
      wide={step === "done"}
    >
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {step === "count" && (
        <form onSubmit={review}>
          <p className="muted">{t.reportsRemoteCloseHint}</p>
          <p>
            {t.reportsDocExpected}:{" "}
            <strong>
              {drawer.expected === null
                ? t.reportsNotShown
                : m(drawer.expected)}
            </strong>
          </p>
          <Field label={t.reportsCountedCash}>
            <input
              inputMode="decimal"
              required
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
            />
          </Field>
          <Field label={t.reportsTerminalReportedInput}>
            <input
              inputMode="decimal"
              value={reported}
              onChange={(e) => setReported(e.target.value)}
            />
          </Field>
          <Field label={t.reportsRemoteCloseReason}>
            <textarea
              required
              minLength={3}
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" className="full">
            {t.reportsRemoteClose}
          </Button>
        </form>
      )}
      {step === "confirm" && countedAmount !== null && (
        <>
          <p>
            {fill(t.reportsRemoteCloseConfirm, { amount: m(countedAmount) })}
          </p>
          <div className="row wrap">
            <Button onClick={() => setStep("count")} disabled={busy}>
              {t.reportsBack}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              {fill(t.reportsRemoteCloseSubmit, { amount: m(countedAmount) })}
            </Button>
          </div>
        </>
      )}
      {step === "done" && result && (
        <>
          <div className="report-preview paper-80">
            <DrawerCorteDocument doc={result} locale={locale} />
          </div>
          <Button variant="primary" onClick={() => setPrinting(true)}>
            {t.reportsPrintCorteZ}
          </Button>
        </>
      )}
    </Modal>
  );
}
