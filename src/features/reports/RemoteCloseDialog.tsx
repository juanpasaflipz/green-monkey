import { useEffect, useState, type FormEvent } from "react";
import {
  currencyExponent,
  minor,
  type Locale,
  type Session,
} from "../../../shared/domain";
import type { CorteDocument, DrawerRow } from "../../../shared/reports";
import { strings, translateError } from "../../i18n";
import { Button, Field, Modal } from "../../components/ui";
import { fetchDrawerCorte, remoteClose } from "./api";
import { CortePreview } from "./CortePreview";
import { DrawerCorteDocument } from "./documents";
import { differenceLabel, fill, money } from "./format";

/**
 * "Cerrar caja de {dispositivo}" (spec §2.11): a manager closes a drawer whose device was revoked
 * or that is open from an earlier business day, with a visible count and a reason. Count →
 * confirm → result (the corte Z). The expected cash shown is the drawer's live corte X, read when
 * the dialog opens and again before the confirm step; the close carries that reading's
 * fingerprint, and the server refuses it when the drawer changed since (reports_drawer_changed:
 * the dialog reads the drawer again and asks for a recount) or when its device is still in use
 * (reports_drawer_in_use: close it there). Review REPORTS-CORTES-1. The server asks for the PIN
 * (step-up) and api() retries the identical body; the operation id is kept across retries and
 * replaced only after a success.
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
  const [live, setLive] = useState<CorteDocument | null>(null);
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
  /** The drawer's corte X as it is now (expected cash and the fingerprint the close carries). */
  async function refresh(): Promise<CorteDocument | null> {
    try {
      const doc = await fetchDrawerCorte(drawer.id);
      setLive(doc);
      return doc;
    } catch (e) {
      setError(translateError((e as Error).message, locale));
      return null;
    }
  }
  useEffect(() => {
    void refresh();
  }, [drawer.id]);

  async function review(e: FormEvent) {
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
    setBusy(true);
    // The confirm step shows the live expected cash next to the count.
    const doc = await refresh();
    setBusy(false);
    if (doc) setStep("confirm");
  }
  async function submit() {
    if (countedAmount === null || !live?.fingerprint) return;
    setBusy(true);
    setError("");
    try {
      const doc = await remoteClose(drawer.id, {
        operationId,
        fingerprint: live.fingerprint,
        counted: countedAmount,
        reason: reason.trim(),
        externalReported: reported.trim() ? amount(reported) : null,
      });
      setOperationId(crypto.randomUUID());
      setResult(doc);
      setStep("done");
      closed();
    } catch (e) {
      const code = (e as Error).message;
      setError(translateError(code, locale));
      if (code === "reports_drawer_changed") {
        // Money moved since the dialog read the drawer: read it again and count again.
        setOperationId(crypto.randomUUID());
        setCounted("");
        await refresh();
        setStep("count");
      }
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
  const expected = live?.cash?.expected ?? null;
  const expectedText =
    expected === null
      ? live
        ? t.reportsNotShown
        : t.reportsRemoteCloseChecking
      : m(expected);
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
            {t.reportsRemoteCloseLive}: <strong>{expectedText}</strong>
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
          <Button
            type="submit"
            variant="primary"
            className="full"
            disabled={busy || !live?.fingerprint}
          >
            {t.reportsRemoteClose}
          </Button>
        </form>
      )}
      {step === "confirm" && countedAmount !== null && (
        <>
          <dl className="cash-figures">
            <dt>{t.reportsRemoteCloseLive}</dt>
            <dd>{expectedText}</dd>
            <dt>{t.reportsCountedCash}</dt>
            <dd>{m(countedAmount)}</dd>
            {expected !== null && (
              <>
                <dt>{t.reportsColDifference}</dt>
                <dd>
                  {`${differenceLabel(countedAmount - expected, locale)} ${
                    countedAmount === expected
                      ? ""
                      : m(countedAmount - expected)
                  }`.trim()}
                </dd>
              </>
            )}
          </dl>
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
