/**
 * The customer self-invoicing portal (spec §2.7): public, no login, lazy-loaded by main.tsx for
 * /f/{CODE} and /factura. A state machine lookup → form → submitting → waiting → done | failed.
 * It calls the pre-auth /api/cfdi/portal routes with fetch directly (no session, no CSRF, no
 * cookies). Spanish by default, "English" toggles (or ?lang=en).
 */
import { useEffect, useId, useRef, useState } from "react";
import type { Locale } from "../../../shared/domain";
import {
  formatTicketCode,
  normalizeTicketCode,
  firstReceptorError,
  receptorIssues,
  type PortalDocumentStatus,
  type PortalTicketView,
  type Receptor,
  type ReceptorIssue,
} from "../../../shared/cfdi";
import { strings, translateError } from "../../i18n";
import { Button, Field } from "../../components/ui";
import { BrandLogo } from "../../components/BrandLogo";
import { emptyReceptor, ReceptorFields } from "./ReceptorFields";
import { portalFileUrl } from "./download";
import {
  dateLabel,
  docLabel,
  issueOfError,
  moneyLabel,
  shortDate,
  t as tr,
  withServerIssue,
} from "./format";
import "./cfdi.css";

type Step = "lookup" | "form" | "submitting" | "waiting" | "done" | "failed";
type CardAnswer = "04" | "28" | "unknown";

const POLL_MS = 2000;
const POLL_LIMIT_MS = 120_000;
const IN_FLIGHT = ["queued", "stamping", "pending"];

class PortalError extends Error {}
/** Not an API code: a non-JSON failure (proxy page, 5xx without a body). */
const REQUEST_FAILED = "request_failed";

async function portal<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/cfdi/portal/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new PortalError("network_unavailable");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = (data as { error?: unknown } | null)?.error;
    throw new PortalError(
      typeof code === "string"
        ? code
        : response.status === 429
          ? "rate_limited"
          : REQUEST_FAILED,
    );
  }
  return data as T;
}

/** The code from /f/{CODE} (or null on /factura). */
export function codeFromPath(pathname: string): string | null {
  const m = /^\/f\/([^/?#]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Error text for the portal: API codes translated, transport failures in plain words. */
export function portalMessage(code: string, locale: Locale): string {
  return code === REQUEST_FAILED
    ? strings[locale].cfdiPortalRequestFailed
    : translateError(code, locale);
}

export default function SelfInvoicePortal() {
  const params = new URLSearchParams(location.search);
  const [locale, setLocale] = useState<Locale>(
    params.get("lang") === "en" ? "en" : "es",
  );
  const t = strings[locale];
  const formId = useId();
  const [step, setStep] = useState<Step>("lookup");
  const [code, setCode] = useState(() => {
    const c = codeFromPath(location.pathname);
    return c ? formatTicketCode(normalizeTicketCode(c) ?? c.toUpperCase()) : "";
  });
  const [ticket, setTicket] = useState<PortalTicketView | null>(null);
  const [receptor, setReceptor] = useState<Receptor>(emptyReceptor());
  const [cardForm, setCardForm] = useState<CardAnswer | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [issues, setIssues] = useState<ReceptorIssue[]>([]);
  const [serverIssue, setServerIssue] = useState<ReceptorIssue | null>(null);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [requestToken, setRequestToken] = useState<string | null>(null);
  const [doc, setDoc] = useState<PortalDocumentStatus | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rfc, setRfc] = useState("");
  const [askRfc, setAskRfc] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  async function lookup(raw = code) {
    const normalized = normalizeTicketCode(raw);
    if (!normalized) {
      setError(translateError("cfdi_portal_code_not_found", locale));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const v = await portal<PortalTicketView>(
        `tickets/${encodeURIComponent(normalized)}`,
      );
      setTicket(v);
      setCode(formatTicketCode(normalized));
      setReceptor((r) => ({ ...r, use: v.defaultUse }));
      setStep("lookup");
      setDoc(null);
      setAskRfc(false);
    } catch (e) {
      setTicket(null);
      setError(portalMessage((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }

  // A printed QR opens /f/{CODE}: look it up once.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (codeFromPath(location.pathname)) void lookup();
  }, []);

  // Poll the request while it is in flight (2 s, at most 2 min).
  const pollToken = step === "waiting" ? requestToken : null;
  useEffect(() => {
    if (!pollToken) return;
    const begun = Date.now();
    let stopped = false;
    let inFlight = false;
    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };
    const timer = setInterval(async () => {
      if (stopped || inFlight) return;
      if (Date.now() - begun > POLL_LIMIT_MS) {
        stop();
        setTimedOut(true);
        return;
      }
      inFlight = true;
      try {
        const next = await portal<PortalDocumentStatus>(
          `requests/${encodeURIComponent(pollToken)}`,
        );
        if (stopped) return;
        setDoc(next);
        if (!IN_FLIGHT.includes(next.status)) {
          stop();
          setStep(next.status === "valid" ? "done" : "failed");
        }
      } catch {
        // Rate limits or a lost connection: try again on the next tick.
      } finally {
        inFlight = false;
      }
    }, POLL_MS);
    return stop;
  }, [pollToken]);

  async function submit() {
    if (!ticket) return;
    const all = receptorIssues(receptor, { requireEmail: true });
    setIssues(all);
    if (firstReceptorError(receptor, { requireEmail: true })) return;
    if (!privacy) {
      setError(t.cfdiPortalPrivacyRequired);
      return;
    }
    setStep("submitting");
    setError("");
    try {
      const r = await portal<{
        requestToken: string;
        document: PortalDocumentStatus;
      }>(
        `tickets/${encodeURIComponent(normalizeTicketCode(code) ?? "")}/invoices`,
        {
          operationId,
          receptor: { ...receptor, email: receptor.email?.trim() ?? null },
          cardForm: ticket.needsCardForm ? (cardForm ?? "unknown") : null,
          privacyAccepted: true,
          locale,
        },
      );
      setRequestToken(r.requestToken);
      setDoc(r.document);
      setTimedOut(false);
      setStep(
        r.document.status === "valid"
          ? "done"
          : IN_FLIGHT.includes(r.document.status)
            ? "waiting"
            : "failed",
      );
    } catch (e) {
      setError(portalMessage((e as Error).message, locale));
      setStep("form");
    }
  }

  async function access() {
    setBusy(true);
    setError("");
    try {
      const r = await portal<{ requestToken: string }>(
        `tickets/${encodeURIComponent(normalizeTicketCode(code) ?? "")}/access`,
        { rfc: rfc.trim().toUpperCase() },
      );
      const status = await portal<PortalDocumentStatus>(
        `requests/${encodeURIComponent(r.requestToken)}`,
      );
      setRequestToken(r.requestToken);
      setDoc(status);
      setStep("done");
    } catch (e) {
      setError(portalMessage((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }

  function correct() {
    setServerIssue(issueOfError(doc?.error ?? null));
    setOperationId(crypto.randomUUID());
    setDoc(null);
    setError("");
    setStep("form");
  }

  function reset() {
    setTicket(null);
    setCode("");
    setDoc(null);
    setRequestToken(null);
    setError("");
    setIssues([]);
    setServerIssue(null);
    setOperationId(crypto.randomUUID());
    setStep("lookup");
    history.replaceState(null, "", "/factura" + location.search);
  }

  const contact = ticket?.supportEmail
    ? ` ${tr(locale, "cfdiPortalContact", { email: ticket.supportEmail })}`
    : "";
  const canForm =
    !!ticket &&
    (ticket.eligibility === "available" ||
      (ticket.eligibility === "in_global" && ticket.reissueAllowed));

  return (
    <div className="cfdi-portal">
      <header className="row between">
        <div className="brand">
          <BrandLogo />
        </div>
        <Button onClick={() => setLocale(locale === "es" ? "en" : "es")}>
          {t.cfdiPortalLanguage}
        </Button>
      </header>
      <h1>{ticket?.tradeName ?? t.cfdiPortalTitle}</h1>

      {(step === "lookup" || !ticket) && (
        <form
          className="panel cfdi-portal-lookup"
          onSubmit={(e) => {
            e.preventDefault();
            void lookup();
          }}
        >
          {ticket && <h2>{t.cfdiPortalTitle}</h2>}
          <Field label={t.cfdiPortalCode}>
            <input
              value={code}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
              maxLength={20}
              placeholder="XXXX-XXXX-XXXX"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !code.trim()}
          >
            {t.cfdiPortalFind}
          </Button>
        </form>
      )}

      {ticket && (
        <section className="panel cfdi-portal-ticket" aria-live="polite">
          <p>
            <strong>
              {tr(locale, "cfdiPortalTicket", {
                folio: ticket.folio,
                date: dateLabel(ticket.businessDate, locale),
                total: moneyLabel(ticket.total, locale),
              })}
            </strong>
          </p>
          {ticket.deadline && ticket.eligibility === "available" && (
            <p>
              {tr(locale, "cfdiPortalDeadline", {
                date: shortDate(ticket.deadline, ticket.timezone, locale),
              })}
            </p>
          )}
          {ticket.mode === "test" && (
            <p className="cfdi-warning">{t.cfdiPortalTestMode}</p>
          )}
          {step === "lookup" && (
            <>
              {ticket.eligibility === "invoiced" && (
                <>
                  <p role="status">{t.cfdiPortalInvoiced}</p>
                  {!askRfc ? (
                    <Button onClick={() => setAskRfc(true)}>
                      {t.cfdiPortalDownloadMine}
                    </Button>
                  ) : (
                    <form
                      className="row wrap"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void access();
                      }}
                    >
                      <Field label={t.cfdiPortalRfcPrompt}>
                        <input
                          value={rfc}
                          maxLength={13}
                          autoComplete="off"
                          autoCapitalize="characters"
                          spellCheck={false}
                          onChange={(e) => setRfc(e.target.value.toUpperCase())}
                        />
                      </Field>
                      <Button
                        type="submit"
                        disabled={busy || rfc.trim().length < 12}
                      >
                        {t.cfdiPortalDownloadMine}
                      </Button>
                    </form>
                  )}
                </>
              )}
              {ticket.eligibility === "in_global" && !ticket.reissueAllowed && (
                <p role="status">
                  {t.cfdiPortalInGlobal}
                  {contact}
                </p>
              )}
              {ticket.eligibility === "global_in_progress" && (
                <p role="status">{t.cfdiPortalGlobalProgress}</p>
              )}
              {ticket.eligibility === "invoicing" && (
                <p role="status">{t.cfdiPortalInvoicing}</p>
              )}
              {ticket.eligibility === "expired" && (
                <p role="status">
                  {tr(locale, "cfdiPortalExpired", {
                    date: ticket.deadline
                      ? shortDate(ticket.deadline, ticket.timezone, locale)
                      : "",
                  })}
                  {contact}
                </p>
              )}
              {ticket.eligibility === "fully_refunded" && (
                <p role="status">{t.cfdiPortalRefunded}</p>
              )}
              {["before_start", "disabled", "not_ready"].includes(
                ticket.eligibility,
              ) && (
                <p role="status">
                  {t.cfdiPortalUnavailable}
                  {contact}
                </p>
              )}
              {canForm && (
                <Button variant="primary" onClick={() => setStep("form")}>
                  {t.cfdiGenerate}
                </Button>
              )}
            </>
          )}
        </section>
      )}

      {ticket && (step === "form" || step === "submitting") && (
        <form
          id={formId}
          className="panel cfdi-portal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h2>{t.cfdiPortalYourData}</h2>
          <ReceptorFields
            value={receptor}
            onChange={(r) => {
              setReceptor(r);
              setServerIssue(null);
              if (issues.length)
                setIssues(receptorIssues(r, { requireEmail: true }));
            }}
            issues={withServerIssue(issues, serverIssue)}
            locale={locale}
            requireEmail
            disabled={step === "submitting"}
          />
          {ticket.needsCardForm && (
            <fieldset className="cfdi-radios">
              <legend>{t.cfdiCardQuestion}</legend>
              {(["04", "28", "unknown"] as const).map((f) => (
                <label key={f}>
                  <input
                    type="radio"
                    name="cfdi-portal-card"
                    checked={cardForm === f}
                    onChange={() => setCardForm(f)}
                  />
                  <span>
                    {f === "04"
                      ? t.cfdiCredit
                      : f === "28"
                        ? t.cfdiDebit
                        : t.cfdiCardUnknown}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <label className="option">
            <input
              type="checkbox"
              checked={privacy}
              onChange={(e) => setPrivacy(e.target.checked)}
            />
            {ticket.privacyUrl ? (
              <a
                href={ticket.privacyUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t.cfdiPortalPrivacy}
              </a>
            ) : (
              t.cfdiPortalPrivacy
            )}
          </label>
          {!ticket.privacyUrl && (
            <p className="muted tiny">
              {t.cfdiPortalPrivacyFallback}
              {contact}
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={step === "submitting"}
          >
            {t.cfdiGenerate}
          </Button>
        </form>
      )}

      {(step === "submitting" || (step === "waiting" && !timedOut)) && (
        <p role="status" className="panel">
          {t.cfdiPortalGenerating}
        </p>
      )}
      {step === "waiting" && timedOut && (
        <p role="status" className="panel">
          {t.cfdiPortalPending}
        </p>
      )}

      {step === "done" && doc && (
        <section className="panel cfdi-portal-done" role="status">
          <p>
            <strong>
              {doc.emailMasked
                ? tr(locale, "cfdiPortalDone", { email: doc.emailMasked })
                : t.cfdiPortalDoneNoEmail}
            </strong>
          </p>
          {docLabel(doc.series, doc.folioNumber) && (
            <p className="muted">
              {docLabel(doc.series, doc.folioNumber)} · {doc.rfcMasked}
            </p>
          )}
          {doc.downloadToken && (
            <div className="row wrap">
              <a
                className="button secondary"
                href={portalFileUrl(doc.downloadToken, "pdf")}
                download
              >
                {t.cfdiDownloadPdf}
              </a>
              <a
                className="button secondary"
                href={portalFileUrl(doc.downloadToken, "xml")}
                download
              >
                {t.cfdiDownloadXml}
              </a>
            </div>
          )}
        </section>
      )}

      {step === "failed" && (
        <section className="panel cfdi-portal-failed" role="alert">
          <p className="error">
            {portalMessage(doc?.error?.code ?? REQUEST_FAILED, locale)}
          </p>
          <Button variant="primary" onClick={correct}>
            {t.cfdiPortalFixData}
          </Button>
        </section>
      )}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {ticket &&
        step !== "lookup" &&
        step !== "form" &&
        step !== "submitting" && (
          <Button variant="ghost" onClick={reset}>
            {t.cfdiPortalNewCode}
          </Button>
        )}

      <footer className="muted tiny cfdi-portal-footer">
        {ticket?.sandbox
          ? t.cfdiPortalFooterSandbox
          : ticket?.issuerLegalName && ticket.issuerRfc
            ? tr(locale, "cfdiPortalFooter", {
                legalName: ticket.issuerLegalName,
                rfc: ticket.issuerRfc,
              })
            : null}
      </footer>
    </div>
  );
}
