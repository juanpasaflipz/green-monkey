/**
 * Staff invoice dialog (spec §2.5): the ticket's eligibility, the receptor form, one operationId
 * kept until success or "Corregir" (MON-3), then a 2 s poll of the document for up to 90 s
 * ("Timbrando con el SAT…"). A manager can replace a global that already holds the ticket
 * ("Sustituir global y facturar", step-up by api()). Polling stops on unmount and when the
 * session changes or locks (api() rejects; the dialog only stops).
 */
import { useEffect, useRef, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import {
  firstReceptorError,
  receptorIssues,
  type CardForm,
  type CfdiDocumentView,
  type CfdiTicketView,
  type Receptor,
  type ReceptorIssue,
} from "../../../shared/cfdi";
import { api } from "../../api";
import { strings, translateError } from "../../i18n";
import { Button, Modal } from "../../components/ui";
import { emptyReceptor, ReceptorFields } from "./ReceptorFields";
import { DocumentDetail } from "./CfdiDocuments";
import { fileUrl } from "./download";
import {
  dateLabel,
  docLabel,
  issueOfError,
  moneyLabel,
  periodKeyLabel,
  t as tr,
  withServerIssue,
} from "./format";
import "./cfdi.css";

const POLL_MS = 2000;
const POLL_LIMIT_MS = 90_000;
const IN_FLIGHT = ["waiting", "queued", "stamping", "pending"];

export function InvoiceDialog({
  ticketId,
  session,
  locale,
  close,
  done,
}: {
  ticketId: string;
  session: Session;
  locale: Locale;
  close: () => void;
  done?: (doc: CfdiDocumentView) => void;
}) {
  const t = strings[locale];
  const [ticket, setTicket] = useState<CfdiTicketView | null>(null);
  const [receptor, setReceptor] = useState<Receptor>(emptyReceptor());
  const [cardForm, setCardForm] = useState<CardForm>("04");
  const [confirmPreStart, setConfirmPreStart] = useState(false);
  const [issues, setIssues] = useState<ReceptorIssue[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [emailOperation, setEmailOperation] = useState(() =>
    crypto.randomUUID(),
  );
  const [doc, setDoc] = useState<CfdiDocumentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [timedOut, setTimedOut] = useState(false);
  const [emailNotice, setEmailNotice] = useState("");
  const [serverIssue, setServerIssue] = useState<ReceptorIssue | null>(null);
  /** A manager opens the covering invoice's detail to substitute it (§2.5 "Already invoiced"). */
  const [detail, setDetail] = useState<string | null>(null);
  const alive = useRef(true);
  const manager = ["owner", "manager"].includes(session.role);

  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    api<CfdiTicketView>(
      `/cfdi/tickets/${encodeURIComponent(ticketId)}`,
      undefined,
      {
        signal: abort.signal,
      },
    )
      .then((v) => {
        if (!alive.current) return;
        setTicket(v);
        setReceptor((r) => ({ ...r, use: v.defaultUse }));
      })
      .catch((e) => {
        if (alive.current)
          setError(translateError((e as Error).message, locale));
      });
    return () => {
      alive.current = false;
      abort.abort();
    };
  }, [ticketId, locale]);

  // `done` may be a new function on every parent render; the poll reads the latest one.
  const doneRef = useRef(done);
  useEffect(() => {
    doneRef.current = done;
  }, [done]);

  // Poll the document while it is in flight (2 s, single-flight, at most 90 s).
  const pollId = doc && IN_FLIGHT.includes(doc.status) ? doc.id : null;
  useEffect(() => {
    if (!pollId) return;
    const started = Date.now();
    let stopped = false;
    let busy = false;
    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };
    const timer = setInterval(async () => {
      if (stopped || busy) return;
      if (Date.now() - started > POLL_LIMIT_MS) {
        stop();
        setTimedOut(true);
        return;
      }
      busy = true;
      try {
        const next = await api<CfdiDocumentView>(
          `/cfdi/documents/${encodeURIComponent(pollId)}`,
        );
        if (!alive.current || stopped) return;
        setDoc(next);
        if (!IN_FLIGHT.includes(next.status)) {
          stop();
          if (next.status === "valid") doneRef.current?.(next);
        }
      } catch {
        // A locked or changed session, or a lost connection: stop quietly.
        stop();
      } finally {
        busy = false;
      }
    }, POLL_MS);
    return stop;
  }, [pollId]);

  async function submit(reissueGlobal = false) {
    setSubmitted(true);
    const all = receptorIssues(receptor, { requireEmail: false });
    setIssues(all);
    if (firstReceptorError(receptor, { requireEmail: false })) return;
    setBusy(true);
    setError("");
    try {
      const created = await api<CfdiDocumentView>("/cfdi/invoices", {
        operationId,
        ticketId,
        receptor: { ...receptor, email: receptor.email?.trim() || null },
        cardForm: ticket?.needsCardForm ? cardForm : null,
        confirmPreStart,
        reissueGlobal,
      });
      if (!alive.current) return;
      setTimedOut(false);
      setDoc(created);
    } catch (e) {
      if (alive.current) setError(translateError((e as Error).message, locale));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  function correct() {
    setServerIssue(issueOfError(doc?.error ?? null));
    setDoc(null);
    setTimedOut(false);
    setError("");
    setOperationId(crypto.randomUUID());
  }

  async function sendEmail() {
    if (!doc) return;
    setBusy(true);
    try {
      await api(`/cfdi/documents/${doc.id}/email`, {
        operationId: emailOperation,
        email: null,
      });
      setEmailOperation(crypto.randomUUID());
      setEmailNotice(t.cfdiEmailQueued);
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }

  const title = ticket
    ? tr(locale, "cfdiInvoiceTitle", {
        folio: ticket.folio,
        total: moneyLabel(ticket.total, locale),
        date: dateLabel(ticket.businessDate, locale),
      })
    : t.cfdiInvoice;
  const period = ticket?.covering
    ? periodKeyLabel(ticket.covering.periodKey, locale)
    : "";
  const inFlight = !!doc && IN_FLIGHT.includes(doc.status);
  const showForm =
    !!ticket &&
    !doc &&
    (ticket.eligibility === "available" ||
      ticket.eligibility === "before_start" ||
      (ticket.eligibility === "in_global" && manager));

  return (
    <Modal title={title} close={close} closeLabel={t.cfdiClose} wide>
      <div className="cfdi-dialog">
        {ticket?.mode === "test" && (
          <p className="cfdi-test-note">{t.cfdiTestDocument}</p>
        )}
        {ticket && ticket.refunded > 0 && ticket.total > 0 && (
          <p className="muted">
            {tr(locale, "cfdiNetOfRefunds", {
              amount: moneyLabel(ticket.total, locale),
            })}
          </p>
        )}
        {ticket?.eligibility === "invoiced" && ticket.covering && (
          <div role="status">
            <p>
              {tr(locale, "cfdiAlreadyInvoiced", {
                doc: ticket.covering.label,
              })}
            </p>
            <div className="row wrap">
              <a
                className="button secondary"
                href={fileUrl(ticket.covering.documentId, "pdf")}
                download
              >
                {t.cfdiDownloadPdf}
              </a>
              <a
                className="button secondary"
                href={fileUrl(ticket.covering.documentId, "xml")}
                download
              >
                {t.cfdiDownloadXml}
              </a>
              {manager && ticket.covering.kind === "invoice" && (
                <Button onClick={() => setDetail(ticket.covering!.documentId)}>
                  {t.cfdiSubstitute}
                </Button>
              )}
            </div>
          </div>
        )}
        {ticket?.eligibility === "invoicing" && (
          <p role="status">{t.cfdiInvoicingNow}</p>
        )}
        {ticket?.eligibility === "global_in_progress" && (
          <p role="status">{t.cfdiGlobalInProgress}</p>
        )}
        {ticket?.eligibility === "fully_refunded" && (
          <p role="status">{t.cfdiFullyRefunded}</p>
        )}
        {ticket &&
          (ticket.eligibility === "disabled" ||
            ticket.eligibility === "not_ready") && (
            <p role="status">
              {translateError(
                ticket.eligibility === "disabled"
                  ? "cfdi_disabled"
                  : "cfdi_not_ready",
                locale,
              )}
            </p>
          )}
        {ticket?.eligibility === "in_global" && !manager && (
          <p role="status">{tr(locale, "cfdiInGlobalCashier", { period })}</p>
        )}
        {ticket?.eligibility === "in_global" && manager && !doc && (
          <p className="cfdi-warning">
            {tr(locale, "cfdiInGlobalManager", { period })}
          </p>
        )}
        {showForm && (
          <>
            {ticket.eligibility === "before_start" && (
              <>
                <p className="cfdi-warning">{t.cfdiBeforeStart}</p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={confirmPreStart}
                    onChange={(e) => setConfirmPreStart(e.target.checked)}
                  />
                  <span>{t.cfdiConfirmPreStart}</span>
                </label>
              </>
            )}
            <ReceptorFields
              value={receptor}
              onChange={(r) => {
                setReceptor(r);
                setServerIssue(null);
                if (submitted)
                  setIssues(receptorIssues(r, { requireEmail: false }));
              }}
              issues={withServerIssue(issues, serverIssue)}
              locale={locale}
              requireEmail={false}
              disabled={busy}
            />
            {ticket.needsCardForm && (
              <fieldset className="cfdi-radios">
                <legend>{t.cfdiCardQuestionStaff}</legend>
                <label>
                  <input
                    type="radio"
                    name="cfdi-card"
                    checked={cardForm === "04"}
                    onChange={() => setCardForm("04")}
                  />
                  <span>{t.cfdiCredit}</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="cfdi-card"
                    checked={cardForm === "28"}
                    onChange={() => setCardForm("28")}
                  />
                  <span>{t.cfdiDebit}</span>
                </label>
              </fieldset>
            )}
            <div className="row wrap">
              {ticket.eligibility === "in_global" ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void submit(true)}
                >
                  {t.cfdiReissueAndInvoice}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={
                    busy ||
                    (ticket.eligibility === "before_start" && !confirmPreStart)
                  }
                  onClick={() => void submit(false)}
                >
                  {t.cfdiGenerate}
                </Button>
              )}
            </div>
          </>
        )}
        {inFlight && !timedOut && (
          <p role="status" aria-live="polite">
            {t.cfdiStamping}
          </p>
        )}
        {inFlight && timedOut && <p role="status">{t.cfdiStillPending}</p>}
        {doc?.status === "valid" && (
          <div role="status" className="cfdi-result">
            <p>
              <strong>
                {tr(locale, "cfdiGenerated", {
                  doc: docLabel(doc.series, doc.folioNumber) ?? "",
                  uuid: (doc.uuid ?? "").toUpperCase(),
                })}
              </strong>
            </p>
            <div className="row wrap">
              <a
                className="button secondary"
                href={fileUrl(doc.id, "pdf")}
                download
              >
                {t.cfdiDownloadPdf}
              </a>
              <a
                className="button secondary"
                href={fileUrl(doc.id, "xml")}
                download
              >
                {t.cfdiDownloadXml}
              </a>
              {doc.receptor?.email && (
                <Button disabled={busy} onClick={() => void sendEmail()}>
                  {t.cfdiSendEmail}
                </Button>
              )}
            </div>
            {emailNotice && <p className="muted">{emailNotice}</p>}
          </div>
        )}
        {doc?.status === "failed" && doc.error && (
          <div role="alert" className="cfdi-failed">
            <p className="error">{translateError(doc.error.code, locale)}</p>
            {doc.error.message && (
              <p className="muted">
                {t.cfdiProviderDetail}: {doc.error.message}
              </p>
            )}
            <Button onClick={correct}>{t.cfdiFix}</Button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      {detail && (
        <DocumentDetail
          documentId={detail}
          session={session}
          locale={locale}
          close={() => setDetail(null)}
          open={setDetail}
          changed={() => {}}
        />
      )}
    </Modal>
  );
}
