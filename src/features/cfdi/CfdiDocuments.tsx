/**
 * "Facturas emitidas" (spec §2.11): the documents register with filters and paging, a ticket
 * search by folio that opens the invoice dialog, and the detail modal with its actions (§2.8):
 * downloads, resend by email, cancel, substitute and retry. Each action dialog keeps its own
 * operationId until it succeeds (MON-3); step-up is asked by api().
 */
import { useCallback, useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import {
  CARD_PAYMENT_FORMS,
  DOCUMENT_STATUS_FILTERS,
  firstReceptorError,
  receptorIssues,
  type CardForm,
  type CfdiDocumentKind,
  type CfdiDocumentSummary,
  type CfdiDocumentView,
  type CfdiTicketView,
  type Receptor,
  type ReceptorIssue,
} from "../../../shared/cfdi";
import { api } from "../../api";
import { strings, translateError, type Key } from "../../i18n";
import { Badge, Button, Empty, Field, Modal } from "../../components/ui";
import { InvoiceDialog } from "./InvoiceDialog";
import { emptyReceptor, ReceptorFields } from "./ReceptorFields";
import { fileUrl } from "./download";
import {
  cancellationLabel,
  cfdiStatusLabel,
  dateTimeLabel,
  documentLabel,
  eventLabel,
  kindLabel,
  moneyLabel,
  paymentFormLabel,
  periodLabel,
  periodKeyLabel,
  shiftDate,
  statusTone,
  t as tr,
  todayFor,
} from "./format";

const STATUS_KEYS: Record<(typeof DOCUMENT_STATUS_FILTERS)[number], Key> = {
  open: "cfdiStatusOpen",
  valid: "cfdiStatusValid",
  failed: "cfdiStatusFailed",
  canceled: "cfdiStatusCanceled",
};

/** "A-000123", or for several tickets "A-000101 … A-000187 (87)". */
export function ticketsLabel(d: CfdiDocumentSummary): string {
  const [first, last] = d.ticketFolios;
  if (!first) return "";
  if (d.ticketCount <= 1 || !last) return first;
  return `${first} … ${last} (${d.ticketCount})`;
}

export function CfdiDocuments({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = strings[locale];
  const today = todayFor(session);
  const [from, setFrom] = useState(() => shiftDate(today, -6));
  const [to, setTo] = useState(today);
  const [kind, setKind] = useState<CfdiDocumentKind | "">("");
  const [status, setStatus] = useState<
    (typeof DOCUMENT_STATUS_FILTERS)[number] | ""
  >("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CfdiDocumentSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [folio, setFolio] = useState("");
  const [ticket, setTicket] = useState<CfdiTicketView | null>(null);
  const [ticketError, setTicketError] = useState("");

  const fetchPage = useCallback(
    async (after: string | null) => {
      const params = new URLSearchParams({ from, to });
      if (kind) params.set("kind", kind);
      if (status) params.set("status", status);
      if (q.trim()) params.set("q", q.trim());
      if (after) params.set("after", after);
      return api<{ rows: CfdiDocumentSummary[]; next: string | null }>(
        `/cfdi/documents?${params}`,
      );
    },
    [from, to, kind, status, q],
  );

  const search = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const page = await fetchPage(null);
      setRows(page.rows);
      setNext(page.next);
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }, [fetchPage, locale]);

  // The first page loads once; later searches run from the Filtrar button.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded) return;
    setLoaded(true);
    void search();
  }, [loaded, search]);

  async function more() {
    if (!next) return;
    setBusy(true);
    try {
      const page = await fetchPage(next);
      setRows((r) => [...(r ?? []), ...page.rows]);
      setNext(page.next);
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }

  async function findTicket() {
    setTicketError("");
    try {
      const v = await api<CfdiTicketView>(
        `/cfdi/tickets?folio=${encodeURIComponent(folio.trim())}`,
      );
      setTicket(v);
    } catch (e) {
      setTicketError(translateError((e as Error).message, locale));
    }
  }

  return (
    <section className="cfdi-documents" aria-label={t.cfdiDocumentsTitle}>
      <form
        className="row wrap cfdi-ticket-search"
        onSubmit={(e) => {
          e.preventDefault();
          void findTicket();
        }}
      >
        <Field label={t.cfdiSearchTicket}>
          <input
            value={folio}
            maxLength={40}
            autoComplete="off"
            onChange={(e) => setFolio(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={!folio.trim()}>
          {t.cfdiSearchTicketButton}
        </Button>
      </form>
      {ticketError && (
        <p className="error" role="alert">
          {ticketError}
        </p>
      )}
      <form
        className="cfdi-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Field label={t.cfdiFrom}>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label={t.cfdiTo}>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <Field label={t.cfdiFilterKind}>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as CfdiDocumentKind | "")}
          >
            <option value="">{t.cfdiAll}</option>
            <option value="invoice">{t.cfdiKindInvoice}</option>
            <option value="global">{t.cfdiKindGlobal}</option>
            <option value="egreso">{t.cfdiKindEgreso}</option>
          </select>
        </Field>
        <Field label={t.cfdiFilterStatus}>
          <select
            value={status}
            onChange={(e) =>
              setStatus(
                e.target.value as (typeof DOCUMENT_STATUS_FILTERS)[number] | "",
              )
            }
          >
            <option value="">{t.cfdiAll}</option>
            {DOCUMENT_STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {t[STATUS_KEYS[s]]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t.cfdiSearch}>
          <input
            type="search"
            value={q}
            maxLength={60}
            onChange={(e) => setQ(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {t.cfdiFilter}
        </Button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rows && rows.length === 0 && <Empty title={t.cfdiEmptyDocuments} />}
      {rows && rows.length > 0 && (
        <div className="cfdi-table-wrap">
          <table className="cfdi-table">
            <thead>
              <tr>
                <th scope="col">{t.cfdiColDate}</th>
                <th scope="col">{t.cfdiColKind}</th>
                <th scope="col">{t.cfdiColFolio}</th>
                <th scope="col">{t.cfdiColReceptor}</th>
                <th scope="col">{t.cfdiColTickets}</th>
                <th scope="col" className="numeric">
                  {t.cfdiColTotal}
                </th>
                <th scope="col">{t.cfdiColStatus}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    {dateTimeLabel(
                      d.createdAt,
                      session.restaurant.timezone,
                      locale,
                    )}
                  </td>
                  <td>{kindLabel(d.kind, locale)}</td>
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={() => setSelected(d.id)}
                    >
                      {documentLabel(d)}
                    </button>
                  </td>
                  <td>
                    {d.kind === "global" ? (
                      t.cfdiPublic
                    ) : (
                      <>
                        {d.receptorName ?? ""}
                        {d.receptorRfc && (
                          <span className="muted tiny"> {d.receptorRfc}</span>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    {d.kind === "global" && d.periodKey
                      ? `${periodKeyLabel(d.periodKey, locale)} · `
                      : ""}
                    {ticketsLabel(d)}
                  </td>
                  <td className="numeric">
                    {d.total !== null
                      ? moneyLabel(d.total, locale)
                      : d.expectedTotal !== null
                        ? moneyLabel(d.expectedTotal, locale)
                        : ""}
                  </td>
                  <td>
                    <Badge tone={statusTone(d.status, d.stuck)}>
                      {cfdiStatusLabel(d.status, locale, d.stuck)}
                    </Badge>
                    {d.mode === "test" && (
                      <Badge tone="amber">{t.cfdiTestBadge}</Badge>
                    )}
                    {d.late && <Badge tone="amber">{t.cfdiPeriodLate}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <Button disabled={busy} onClick={() => void more()}>
          {t.cfdiLoadMore}
        </Button>
      )}
      {selected && (
        <DocumentDetail
          documentId={selected}
          session={session}
          locale={locale}
          close={() => setSelected(null)}
          open={setSelected}
          changed={() => void search()}
        />
      )}
      {ticket && (
        <InvoiceDialog
          ticketId={ticket.ticketId}
          session={session}
          locale={locale}
          close={() => {
            setTicket(null);
            void search();
          }}
        />
      )}
    </section>
  );
}

export function DocumentDetail({
  documentId,
  session,
  locale,
  close,
  open,
  changed,
}: {
  documentId: string;
  session: Session;
  locale: Locale;
  close: () => void;
  open: (id: string) => void;
  changed: () => void;
}) {
  const t = strings[locale];
  const tz = session.restaurant.timezone;
  const [doc, setDoc] = useState<CfdiDocumentView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"cancel" | "substitute" | null>(null);
  const [email, setEmail] = useState("");
  const [emailOperation, setEmailOperation] = useState(() =>
    crypto.randomUUID(),
  );
  const [retryOperation, setRetryOperation] = useState(() =>
    crypto.randomUUID(),
  );

  const load = useCallback(async () => {
    try {
      const v = await api<CfdiDocumentView>(
        `/cfdi/documents/${encodeURIComponent(documentId)}`,
      );
      setDoc(v);
      setEmail(v.receptor?.email ?? "");
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    }
  }, [documentId, locale]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(path: string, body: unknown, after: () => void) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const v = await api<CfdiDocumentView>(path, body);
      setDoc(v);
      after();
      changed();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }

  const label = doc ? documentLabel(doc) : "";
  const title = doc
    ? tr(locale, "cfdiDocumentTitle", {
        kind: kindLabel(doc.kind, locale),
        doc: label,
      })
    : t.cfdiDetails;
  const rejected =
    doc?.cancellation?.motive === "01" &&
    ["rejected", "expired"].includes(doc.cancellation.status);
  const acuse = doc?.files.includes("cancel_pdf")
    ? "cancel_pdf"
    : doc?.files.includes("cancel_xml")
      ? "cancel_xml"
      : null;

  return (
    <Modal title={title} close={close} closeLabel={t.cfdiClose} wide>
      {!doc && !error && <p className="muted">…</p>}
      {doc && (
        <div className="cfdi-detail">
          <div className="row wrap">
            <Badge tone={statusTone(doc.status, doc.stuck)}>
              {cfdiStatusLabel(doc.status, locale, doc.stuck)}
            </Badge>
            {doc.mode === "test" && (
              <Badge tone="amber">{t.cfdiTestBadge}</Badge>
            )}
            {doc.late && <Badge tone="amber">{t.cfdiPeriodLate}</Badge>}
          </div>
          {doc.stuck && <p className="cfdi-warning">{t.cfdiStuckHint}</p>}
          {rejected && (
            <p className="error" role="alert">
              {tr(locale, "cfdiSubstitutionRejected", {
                doc: label,
                folio: doc.ticketFolios[0] ?? "",
              })}
            </p>
          )}
          <dl className="cfdi-facts">
            {doc.uuid && (
              <>
                <dt>{t.cfdiUuid}</dt>
                <dd className="mono">{doc.uuid.toUpperCase()}</dd>
              </>
            )}
            <dt>{t.cfdiColDate}</dt>
            <dd>{dateTimeLabel(doc.stampedAt ?? doc.createdAt, tz, locale)}</dd>
            <dt>{t.cfdiColReceptor}</dt>
            <dd>
              {doc.kind === "global"
                ? t.cfdiPublic
                : `${doc.receptorName ?? ""} ${doc.receptorRfc ?? ""}`.trim()}
            </dd>
            {doc.global && (
              <>
                <dt>{t.cfdiPeriod}</dt>
                <dd>
                  {periodLabel(doc.global, locale)}
                  {doc.part && doc.part > 1
                    ? ` · ${tr(locale, "cfdiPeriodPart", { n: doc.part })}`
                    : ""}
                </dd>
              </>
            )}
            <dt>{t.cfdiColTickets}</dt>
            <dd>{ticketsLabel(doc)}</dd>
            {doc.paymentForm && (
              <>
                <dt>{t.cfdiPaymentForm}</dt>
                <dd>{paymentFormLabel(doc.paymentForm)}</dd>
              </>
            )}
            {doc.use && doc.kind !== "global" && (
              <>
                <dt>{t.cfdiCfdiUse}</dt>
                <dd>{doc.use}</dd>
              </>
            )}
            {doc.tax !== null && (
              <>
                <dt>{t.cfdiTax}</dt>
                <dd>{moneyLabel(doc.tax, locale)}</dd>
              </>
            )}
            {!!doc.withheld && (
              <>
                <dt>{t.cfdiWithheld}</dt>
                <dd>{moneyLabel(doc.withheld, locale)}</dd>
              </>
            )}
            {(doc.total ?? doc.expectedTotal) !== null && (
              <>
                <dt>{t.cfdiColTotal}</dt>
                <dd>{moneyLabel((doc.total ?? doc.expectedTotal)!, locale)}</dd>
              </>
            )}
            {doc.amountCheck && (
              <>
                <dt>{t.cfdiAmountCheck}</dt>
                <dd>
                  {doc.amountCheck === "exact"
                    ? t.cfdiAmountExact
                    : tr(locale, "cfdiAmountDiffers", {
                        amount: moneyLabel(
                          Math.abs((doc.total ?? 0) - (doc.expectedTotal ?? 0)),
                          locale,
                        ),
                      })}
                </dd>
              </>
            )}
            {doc.createdByName && (
              <>
                <dt>{t.cfdiOpInvoiceRequested}</dt>
                <dd>{doc.createdByName}</dd>
              </>
            )}
          </dl>
          {doc.parentDocumentId && (
            <p>
              <button
                type="button"
                className="link"
                onClick={() => open(doc.parentDocumentId!)}
              >
                {tr(locale, "cfdiCreditNoteOf", { doc: ticketsLabel(doc) })}
              </button>
            </p>
          )}
          {doc.creditNotes.length > 0 && (
            <p>
              {t.cfdiCreditNotes}:{" "}
              {doc.creditNotes.map((id, i) => (
                <button
                  key={id}
                  type="button"
                  className="link"
                  onClick={() => open(id)}
                >
                  {`${t.cfdiKindEgreso} ${i + 1}`}
                </button>
              ))}
            </p>
          )}
          {doc.replacesDocumentId && (
            <p>
              <button
                type="button"
                className="link"
                onClick={() => open(doc.replacesDocumentId!)}
              >
                {t.cfdiEventSubstitution}
              </button>
            </p>
          )}
          {doc.replacedByDocumentId && (
            <p>
              <button
                type="button"
                className="link"
                onClick={() => open(doc.replacedByDocumentId!)}
              >
                {t.cfdiEventSubstitution}
              </button>
            </p>
          )}
          {doc.cancellation && (
            <p>
              {tr(locale, "cfdiCancellation", {
                status: cancellationLabel(doc.cancellation.status, locale),
              })}
              {doc.cancellation.errorCode &&
                ` · ${translateError(doc.cancellation.errorCode, locale)}`}
            </p>
          )}
          {doc.error && (
            <div className="cfdi-failed" role="alert">
              <p className="error">{translateError(doc.error.code, locale)}</p>
              {doc.error.message && (
                <p className="muted">
                  {t.cfdiProviderDetail}: {doc.error.message}
                  {doc.error.path ? ` (${doc.error.path})` : ""}
                </p>
              )}
            </div>
          )}
          {doc.emailError && (
            <p className="cfdi-warning">
              {t.cfdiEventEmailFailed}: {translateError(doc.emailError, locale)}
            </p>
          )}
          <div className="row wrap cfdi-actions">
            {doc.files.includes("pdf") && (
              <a
                className="button secondary"
                href={fileUrl(doc.id, "pdf")}
                download
              >
                {t.cfdiDownloadPdf}
              </a>
            )}
            {doc.files.includes("xml") && (
              <a
                className="button secondary"
                href={fileUrl(doc.id, "xml")}
                download
              >
                {t.cfdiDownloadXml}
              </a>
            )}
            {acuse && (
              <a
                className="button secondary"
                href={fileUrl(doc.id, acuse)}
                download
              >
                {t.cfdiDownloadAcuse}
              </a>
            )}
            {doc.verificationUrl && (
              <a
                className="button ghost"
                href={doc.verificationUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t.cfdiVerifySat}
              </a>
            )}
            {doc.canRetry && (
              <Button
                disabled={busy}
                onClick={() =>
                  void act(
                    `/cfdi/documents/${doc.id}/retry`,
                    { operationId: retryOperation },
                    () => setRetryOperation(crypto.randomUUID()),
                  )
                }
              >
                {t.cfdiRetry}
              </Button>
            )}
            {doc.canSubstitute && (
              <Button disabled={busy} onClick={() => setDialog("substitute")}>
                {t.cfdiSubstitute}
              </Button>
            )}
            {doc.canCancel && (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => setDialog("cancel")}
              >
                {t.cfdiCancel}
              </Button>
            )}
          </div>
          {doc.canEmail && (
            <form
              className="row wrap cfdi-email"
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  `/cfdi/documents/${doc.id}/email`,
                  {
                    operationId: emailOperation,
                    email: email.trim() || null,
                  },
                  () => {
                    setEmailOperation(crypto.randomUUID());
                    setNotice(t.cfdiEmailQueued);
                  },
                );
              }}
            >
              <Field label={t.cfdiEmail}>
                <input
                  type="email"
                  value={email}
                  maxLength={254}
                  autoComplete="off"
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailOperation(crypto.randomUUID());
                  }}
                />
              </Field>
              <Button type="submit" disabled={busy}>
                {t.cfdiResendEmail}
              </Button>
            </form>
          )}
          {notice && (
            <p role="status" className="muted">
              {notice}
            </p>
          )}
          <details className="cfdi-timeline">
            <summary>{t.cfdiTimeline}</summary>
            <ol>
              {doc.events.map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <time dateTime={e.at}>{dateTimeLabel(e.at, tz, locale)}</time>{" "}
                  {eventLabel(e.kind, locale)}
                </li>
              ))}
            </ol>
          </details>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {doc && dialog === "cancel" && (
        <CancelDialog
          doc={doc}
          locale={locale}
          close={() => setDialog(null)}
          done={(v) => {
            setDoc(v);
            setDialog(null);
            changed();
          }}
        />
      )}
      {doc && dialog === "substitute" && (
        <SubstituteDialog
          doc={doc}
          locale={locale}
          close={() => setDialog(null)}
          done={(v) => {
            setDialog(null);
            changed();
            open(v.id);
          }}
        />
      )}
    </Modal>
  );
}

/** Nominative invoice over $1,000 stamped more than 24 h ago: the receptor must accept (§2.8). */
export function needsAcceptance(doc: CfdiDocumentView, now = Date.now()) {
  return (
    doc.kind === "invoice" &&
    (doc.total ?? 0) > 100_000 &&
    !!doc.stampedAt &&
    Date.parse(doc.stampedAt) < now - 24 * 3600_000
  );
}

function CancelDialog({
  doc,
  locale,
  close,
  done,
}: {
  doc: CfdiDocumentView;
  locale: Locale;
  close: () => void;
  done: (v: CfdiDocumentView) => void;
}) {
  const t = strings[locale];
  const [motive, setMotive] = useState<"02" | "03">("02");
  const [reason, setReason] = useState("");
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const global = doc.kind === "global";
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const v = await api<CfdiDocumentView>(
        `/cfdi/documents/${doc.id}/cancel`,
        {
          operationId,
          motive,
          reason: reason.trim(),
        },
      );
      done(v);
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={tr(locale, "cfdiCancelTitle", { doc: documentLabel(doc) })}
      close={close}
      closeLabel={t.cfdiClose}
    >
      <form
        className="cfdi-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t.cfdiMotive}>
          <select
            value={motive}
            onChange={(e) => {
              setMotive(e.target.value as "02" | "03");
              setOperationId(crypto.randomUUID());
            }}
          >
            <option value="02">{t.cfdiMotive02}</option>
            {!global && <option value="03">{t.cfdiMotive03}</option>}
          </select>
        </Field>
        <Field label={t.cfdiCancelReason}>
          <textarea
            value={reason}
            maxLength={300}
            required
            onChange={(e) => {
              setReason(e.target.value);
              setOperationId(crypto.randomUUID());
            }}
          />
        </Field>
        {doc.kind === "invoice" && (
          <p className="muted">{t.cfdiCancelBackToGlobal}</p>
        )}
        {motive === "03" && <p className="muted">{t.cfdiCancelRefundHint}</p>}
        {needsAcceptance(doc) && (
          <p className="cfdi-warning">{t.cfdiCancelAcceptance}</p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row wrap">
          <Button
            type="submit"
            variant="danger"
            disabled={busy || !reason.trim()}
          >
            {t.cfdiConfirmCancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SubstituteDialog({
  doc,
  locale,
  close,
  done,
}: {
  doc: CfdiDocumentView;
  locale: Locale;
  close: () => void;
  done: (v: CfdiDocumentView) => void;
}) {
  const t = strings[locale];
  const [receptor, setReceptor] = useState<Receptor>(
    () => doc.receptor ?? emptyReceptor(),
  );
  const card = (CARD_PAYMENT_FORMS as readonly string[]).includes(
    doc.paymentForm ?? "",
  )
    ? (doc.paymentForm as CardForm)
    : null;
  const [cardForm, setCardForm] = useState<CardForm | null>(card);
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<ReceptorIssue[]>([]);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = documentLabel(doc);
  async function submit() {
    setIssues(receptorIssues(receptor, { requireEmail: false }));
    if (firstReceptorError(receptor, { requireEmail: false })) return;
    setBusy(true);
    setError("");
    try {
      const v = await api<CfdiDocumentView>(
        `/cfdi/documents/${doc.id}/substitute`,
        {
          operationId,
          receptor: { ...receptor, email: receptor.email?.trim() || null },
          cardForm,
          reason: reason.trim(),
        },
      );
      done(v);
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={tr(locale, "cfdiSubstituteTitle", { doc: label })}
      close={close}
      closeLabel={t.cfdiClose}
      wide
    >
      <form
        className="cfdi-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="muted">
          {tr(locale, "cfdiSubstituteHint", { doc: label })}
        </p>
        <ReceptorFields
          value={receptor}
          onChange={(r) => {
            setReceptor(r);
            setOperationId(crypto.randomUUID());
            if (issues.length)
              setIssues(receptorIssues(r, { requireEmail: false }));
          }}
          issues={issues}
          locale={locale}
          requireEmail={false}
          disabled={busy}
        />
        {card && (
          <fieldset className="cfdi-radios">
            <legend>{t.cfdiCardQuestionStaff}</legend>
            {CARD_PAYMENT_FORMS.map((f) => (
              <label key={f}>
                <input
                  type="radio"
                  name="cfdi-substitute-card"
                  checked={cardForm === f}
                  onChange={() => {
                    setCardForm(f);
                    setOperationId(crypto.randomUUID());
                  }}
                />
                <span>{f === "04" ? t.cfdiCredit : t.cfdiDebit}</span>
              </label>
            ))}
          </fieldset>
        )}
        <Field label={t.cfdiCancelReason}>
          <textarea
            value={reason}
            maxLength={300}
            required
            onChange={(e) => {
              setReason(e.target.value);
              setOperationId(crypto.randomUUID());
            }}
          />
        </Field>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row wrap">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !reason.trim()}
          >
            {t.cfdiConfirmSubstitute}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
