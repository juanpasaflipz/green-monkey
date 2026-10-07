// Configuración → "Datos fiscales" (fiscal 027, docs/FISCAL.md): the issuer data printed on
// every ticket, the tax region and default product tax, the folio status and the repair of
// missing tickets, plus the ticket register. The owner edits (with a fresh PIN through api()'s
// step-up); a manager sees it read-only.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import {
  businessDate,
  type Locale,
  type Session,
} from "../../../shared/domain";
import {
  BORDER_STIMULUS_VALID_UNTIL,
  fiscalProfileInput,
  fiscalProfileIssues,
  formatFolio,
  ISSUER_REGIMES,
  regimeAllowedFor,
  REGIMEN_FISCAL,
  TAX_CATEGORIES,
  TAX_REGIONS,
  validateRfc,
  type FiscalIssue,
  type FiscalProfileView,
  type TaxCategory,
  type TaxRegion,
} from "../../../shared/fiscal";
import { api } from "../../api";
import { Badge, Button } from "../../components/ui";
import { strings, errorNotice, translateError, type Key } from "../../i18n";
import { prefetchFiscalContext } from "./context";
import { categoryLabel, fill, fiscalDate, fiscalDateTime } from "./format";
import { TicketRegister } from "./TicketRegister";
import "./fiscal.css";

type Form = {
  rfc: string;
  legalName: string;
  regime: string;
  postalCode: string;
  street: string;
  neighborhood: string;
  municipality: string;
  state: string;
  multipleBranches: boolean;
  ticketSeries: string;
  taxRegion: TaxRegion;
  defaultTaxCategory: TaxCategory;
  borderConfirmed: boolean;
};
type TextField = Exclude<
  keyof Form,
  "multipleBranches" | "taxRegion" | "defaultTaxCategory" | "borderConfirmed"
>;

export function formOf(v: FiscalProfileView): Form {
  return {
    rfc: v.issuer?.rfc ?? "",
    legalName: v.issuer?.legalName ?? "",
    regime: v.issuer?.regime ?? "",
    postalCode: v.issuer?.postalCode ?? "",
    street: v.issuer?.address.street ?? "",
    neighborhood: v.issuer?.address.neighborhood ?? "",
    municipality: v.issuer?.address.municipality ?? "",
    state: v.issuer?.address.state ?? "",
    multipleBranches: v.multipleBranches,
    ticketSeries: v.ticketSeries,
    taxRegion: v.taxRegion,
    defaultTaxCategory: v.defaultTaxCategory,
    borderConfirmed: v.taxRegion !== "general",
  };
}

/** The POST body without its operation id; identity is null when every identity field is blank. */
export function bodyOf(f: Form, expectedVersion: number) {
  const identity = {
    rfc: f.rfc,
    legalName: f.legalName,
    regime: f.regime,
    postalCode: f.postalCode,
    address: {
      street: f.street,
      neighborhood: f.neighborhood,
      municipality: f.municipality,
      state: f.state,
    },
  };
  const blank = [
    f.rfc,
    f.legalName,
    f.regime,
    f.postalCode,
    f.street,
    f.neighborhood,
    f.municipality,
    f.state,
  ].every((v) => !v.trim());
  return {
    expectedVersion,
    identity: blank ? null : identity,
    ticketSeries: f.ticketSeries,
    taxRegion: f.taxRegion,
    defaultTaxCategory: f.defaultTaxCategory,
    borderConfirmed: f.taxRegion !== "general" && f.borderConfirmed,
    multipleBranches: f.multipleBranches,
  };
}

/**
 * Whether a save must stop for the RFC check-digit warning (FISCAL-UI-1): the RFC matches the
 * SAT pattern but its check digit does not, and the owner has neither saved this RFC before nor
 * confirmed it with a first tap.
 */
export function needsRfcConfirmation(
  rfc: string,
  savedRfc: string | null,
  confirmedRfc: string | null,
): boolean {
  const r = validateRfc(rfc);
  if (!r.ok || r.checkDigit || !r.rfc) return false;
  return r.rfc !== savedRfc && r.rfc !== confirmedRfc;
}

const regionKeys: Record<TaxRegion, Key> = {
  general: "fiscalRegionGeneral",
  border_north: "fiscalRegionBorderNorth",
  border_south: "fiscalRegionBorderSouth",
};

export function FiscalSettings({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = strings[locale];
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [data, setData] = useState<FiscalProfileView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A short message next to the save button: why the save stopped (FISCAL-UI-3).
  const [blocked, setBlocked] = useState("");
  const [saved, setSaved] = useState(false);
  // The RFC the owner chose to keep despite the check-digit warning (FISCAL-UI-1).
  const [confirmedRfc, setConfirmedRfc] = useState<string | null>(null);
  // One operation id per body until a save succeeds: a retry of the same body reuses it
  // (MON-3), and a body changed after a failed attempt gets a new one (FISCAL-CONCURRENCY-4).
  const [attempt, setAttempt] = useState(() => ({
    operationId: crypto.randomUUID(),
    body: null as string | null,
  }));
  const [repairId, setRepairId] = useState(() => crypto.randomUUID());
  const [repaired, setRepaired] = useState<number | null>(null);

  /** Shows the server's current profile in the panel and in the form. */
  function show(view: FiscalProfileView) {
    setData(view);
    setForm(formOf(view));
    setSubmitted(false);
    setBlocked("");
    setAttempt({ operationId: crypto.randomUUID(), body: null });
  }

  async function load() {
    try {
      show(await api<FiscalProfileView>("/fiscal/profile"));
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  if (!data || !form)
    return (
      <section
        className="panel fiscal-settings"
        aria-labelledby={`${id}-title`}
      >
        <h2 id={`${id}-title`}>{t.fiscalTitle}</h2>
        <p role={error ? "alert" : "status"} className={error ? "error" : ""}>
          {error || t.fiscalLoading}
        </p>
        {error && <Button onClick={() => void load()}>{t.fiscalReload}</Button>}
      </section>
    );

  const editable = data.canEdit;
  const savedRfc = data.issuer?.rfc ?? null;
  const formRfc = form.rfc;
  const body = bodyOf(form, data.version);
  const parsed = fiscalProfileInput.safeParse({
    operationId: attempt.operationId,
    ...body,
  });
  // Warnings (the RFC check digit) show as soon as the RFC is complete; errors after a save.
  const issues: FiscalIssue[] = parsed.success
    ? fiscalProfileIssues(parsed.data).filter((i) => submitted || i.warning)
    : [];
  const issue = (field: FiscalIssue["field"]) =>
    issues.find((i) => i.field === field && !i.warning) ??
    issues.find((i) => i.field === field);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm({ ...form, [key]: value });
    setSaved(false);
    setBlocked("");
  };
  const rfc = validateRfc(form.rfc);
  const regimes = ISSUER_REGIMES.filter(
    (code) => !rfc.kind || regimeAllowedFor(code, rfc.kind),
  );
  const border = form.taxRegion !== "general";
  // The restaurant's own date, not UTC (FISCAL-UI-12).
  const today = businessDate(
    new Date().toISOString(),
    session.restaurant.timezone,
    0,
  );
  const expired = today > BORDER_STIMULUS_VALID_UNTIL;
  const validUntil = fiscalDate(BORDER_STIMULUS_VALID_UNTIL);
  const confirming =
    !!rfc.rfc &&
    rfc.ok &&
    !rfc.checkDigit &&
    rfc.rfc === confirmedRfc &&
    rfc.rfc !== savedRfc;

  /** Moves focus to the first control marked invalid once React has rendered it. */
  function focusFirstInvalid() {
    requestAnimationFrame(() =>
      formRef.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus(),
    );
  }

  async function save() {
    setSubmitted(true);
    setError("");
    setSaved(false);
    setBlocked("");
    if (!parsed.success) {
      setError(translateError("invalid_input", locale));
      return;
    }
    if (fiscalProfileIssues(parsed.data).some((i) => !i.warning)) {
      setBlocked(t.fiscalFixFields);
      focusFirstInvalid();
      return;
    }
    if (needsRfcConfirmation(formRfc, savedRfc, confirmedRfc)) {
      // First tap with a new check-digit warning: stop, keep it visible, ask to confirm.
      setConfirmedRfc(rfc.rfc);
      setBlocked(t.fiscalRfcConfirm);
      return;
    }
    const fingerprint = JSON.stringify(body);
    const operationId =
      attempt.body === null || attempt.body === fingerprint
        ? attempt.operationId
        : crypto.randomUUID();
    setAttempt({ operationId, body: fingerprint });
    setBusy(true);
    try {
      const view = await api<FiscalProfileView>(
        "/fiscal/profile",
        { operationId, ...body },
        { idempotent: true },
      );
      show(view);
      setSaved(true);
      void prefetchFiscalContext(session);
    } catch (e) {
      const code = (e as Error).message;
      if (code === "fiscal_profile_changed" || code === "operation_conflict") {
        // Another device saved (or this body met an earlier one under the same id): show the
        // current data instead of keeping the stale form, so the next tap cannot overwrite the
        // other change with old values (FISCAL-UI-2, FISCAL-CONCURRENCY-4).
        const view = await api<FiscalProfileView>("/fiscal/profile").catch(
          () => null,
        );
        if (view) {
          show(view);
          setError(t.fiscalChangedReloaded);
          return;
        }
      }
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }

  async function repair() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ issued: number; remaining: number }>(
        "/fiscal/tickets/repair",
        { operationId: repairId },
        { idempotent: true },
      );
      setRepaired(result.issued);
      setRepairId(crypto.randomUUID());
      setData(await api<FiscalProfileView>("/fiscal/profile"));
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }

  /** The id of a field's inline error (or warning) when it has one. */
  const errorId = (field: FiscalIssue["field"]) =>
    issue(field) ? `${id}-${field}-error` : "";
  const message = (field: FiscalIssue["field"]) => {
    const found = issue(field);
    if (!found) return null;
    return (
      <p
        id={`${id}-${field}-error`}
        role="alert"
        className={found.warning ? "fiscal-warning tiny" : "error tiny"}
      >
        {found.warning
          ? t.fiscalRfcCheckDigit
          : translateError(found.code, locale)}
      </p>
    );
  };
  const invalid = (field: FiscalIssue["field"]) => {
    const found = issue(field);
    return found && !found.warning ? true : undefined;
  };

  /** A text input with its label, hint and inline error or warning. */
  const text = (
    field: TextField,
    label: string,
    input: InputHTMLAttributes<HTMLInputElement>,
    hint?: ReactNode,
  ) => {
    const issueField = field as FiscalIssue["field"];
    const describedBy = [hint ? `${id}-${field}-hint` : "", errorId(issueField)]
      .filter(Boolean)
      .join(" ");
    return (
      <div>
        <label className="field">
          <span>{label}</span>
          <input
            {...input}
            value={form[field]}
            aria-invalid={invalid(issueField)}
            aria-describedby={describedBy || undefined}
            onChange={(e) =>
              set(
                field,
                input.autoCapitalize === "characters"
                  ? e.target.value.toUpperCase()
                  : e.target.value,
              )
            }
          />
        </label>
        {hint && (
          <p
            className="muted tiny fiscal-field-hint"
            id={`${id}-${field}-hint`}
          >
            {hint}
          </p>
        )}
        {message(issueField)}
      </div>
    );
  };
  const regimeIssue = issue("regime");

  return (
    <section className="panel fiscal-settings" aria-labelledby={`${id}-title`}>
      <div className="fiscal-title">
        <h2 id={`${id}-title`}>{t.fiscalTitle}</h2>
        <Badge tone={data.complete ? "green" : "amber"}>
          {data.complete ? t.fiscalComplete : t.fiscalIncompleteShort}
        </Badge>
      </div>
      <p className="muted">{t.fiscalIntro}</p>
      {!data.currencySupported && (
        <p className="fiscal-warning">{t.fiscalCurrencyUnsupported}</p>
      )}
      {!editable && <p className="muted">{t.fiscalOwnerOnly}</p>}
      <form
        ref={formRef}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!editable || busy}>
          <legend className="sr-only">{t.fiscalIdentity}</legend>
          <div className="form-grid">
            {text(
              "rfc",
              t.fiscalRfc,
              {
                maxLength: 13,
                autoCapitalize: "characters",
                autoComplete: "off",
                spellCheck: false,
              },
              t.fiscalRfcHint,
            )}
            {text(
              "legalName",
              t.fiscalLegalName,
              { maxLength: 254, autoComplete: "organization" },
              t.fiscalLegalNameHint,
            )}
            <div>
              <label className="field">
                <span>{t.fiscalRegime}</span>
                <select
                  value={form.regime}
                  aria-invalid={regimeIssue ? true : undefined}
                  aria-describedby={errorId("regime") || undefined}
                  onChange={(e) => set("regime", e.target.value)}
                >
                  <option value="">{t.fiscalRegimeChoose}</option>
                  {[
                    ...regimes,
                    ...(form.regime && !regimes.includes(form.regime)
                      ? [form.regime]
                      : []),
                  ].map((code) => (
                    <option key={code} value={code}>
                      {code} — {REGIMEN_FISCAL[code]?.[locale] ?? code}
                    </option>
                  ))}
                </select>
              </label>
              {message("regime")}
            </div>
            {text(
              "postalCode",
              t.fiscalPostalCode,
              {
                maxLength: 5,
                inputMode: "numeric",
                autoComplete: "postal-code",
              },
              t.fiscalPostalCodeHint,
            )}
          </div>
          <fieldset>
            <legend>
              {form.multipleBranches
                ? t.fiscalAddressRequired
                : t.fiscalAddress}
            </legend>
            <label className="option">
              <input
                type="checkbox"
                checked={form.multipleBranches}
                aria-describedby={`${id}-branches-hint`}
                onChange={(e) => set("multipleBranches", e.target.checked)}
              />
              <span>{t.fiscalMultipleBranches}</span>
            </label>
            <p
              id={`${id}-branches-hint`}
              className="muted tiny fiscal-field-hint"
            >
              {t.fiscalMultipleBranchesHint}
            </p>
            <div className="form-grid">
              {text("street", t.fiscalStreet, { maxLength: 120 })}
              {text("neighborhood", t.fiscalNeighborhood, { maxLength: 80 })}
              {text("municipality", t.fiscalMunicipality, { maxLength: 80 })}
              {text("state", t.fiscalState, { maxLength: 60 })}
            </div>
          </fieldset>
          {text(
            "ticketSeries",
            t.fiscalSeries,
            {
              maxLength: 10,
              autoCapitalize: "characters",
              autoComplete: "off",
            },
            t.fiscalSeriesHint,
          )}
          <fieldset>
            <legend>{t.fiscalTaxes}</legend>
            <fieldset>
              <legend>{t.fiscalRegion}</legend>
              {TAX_REGIONS.map((region) => (
                <label className="option" key={region}>
                  <input
                    type="radio"
                    name={`${id}-region`}
                    checked={form.taxRegion === region}
                    onChange={() => {
                      setForm({
                        ...form,
                        taxRegion: region,
                        // A newly chosen border region needs a new attestation.
                        borderConfirmed:
                          region !== "general" && region === data.taxRegion,
                        // IVA 8% exists only in a border region.
                        defaultTaxCategory:
                          region === "general" &&
                          form.defaultTaxCategory === "iva8"
                            ? "iva16"
                            : form.defaultTaxCategory,
                      });
                      setSaved(false);
                      setBlocked("");
                    }}
                  />
                  <span>{t[regionKeys[region]]}</span>
                </label>
              ))}
            </fieldset>
            {!border &&
              data.taxRegion !== "general" &&
              data.iva8Products > 0 && (
                <p className="fiscal-warning">
                  {fill(t.fiscalIva8Products, { n: data.iva8Products })}
                </p>
              )}
            {border && (
              <div>
                <label className="option">
                  <input
                    type="checkbox"
                    checked={form.borderConfirmed}
                    aria-invalid={invalid("borderConfirmed")}
                    aria-describedby={[
                      `${id}-border-hint`,
                      errorId("borderConfirmed"),
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onChange={(e) => set("borderConfirmed", e.target.checked)}
                  />
                  <span>{t.fiscalBorderConfirm}</span>
                </label>
                <p
                  id={`${id}-border-hint`}
                  className={expired ? "fiscal-warning tiny" : "muted tiny"}
                >
                  {fill(expired ? t.fiscalBorderExpired : t.fiscalBorderValid, {
                    date: validUntil,
                  })}
                </p>
                {message("borderConfirmed")}
              </div>
            )}
            <label className="field">
              <span>{t.fiscalDefaultCategory}</span>
              <select
                value={form.defaultTaxCategory}
                aria-invalid={invalid("defaultTaxCategory")}
                aria-describedby={
                  [
                    border && form.defaultTaxCategory !== "iva8"
                      ? `${id}-default-hint`
                      : "",
                    errorId("defaultTaxCategory"),
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                onChange={(e) =>
                  set("defaultTaxCategory", e.target.value as TaxCategory)
                }
              >
                {TAX_CATEGORIES.filter((c) => border || c !== "iva8").map(
                  (category) => (
                    <option key={category} value={category}>
                      {categoryLabel(category, locale)}
                    </option>
                  ),
                )}
              </select>
            </label>
            {border && form.defaultTaxCategory !== "iva8" && (
              // FISCAL-UI-4: the region alone does not change the default product tax.
              <p id={`${id}-default-hint`} className="fiscal-warning tiny">
                {fill(t.fiscalBorderDefaultHint, {
                  category: categoryLabel(form.defaultTaxCategory, locale),
                })}
              </p>
            )}
            {message("defaultTaxCategory")}
            <p className="muted">{t.fiscalPricesInclusive}</p>
          </fieldset>
          {editable && (
            <div className="row wrap">
              <Button variant="primary" type="submit">
                {confirming ? t.fiscalSaveAnyway : t.fiscalSave}
              </Button>
              {blocked && (
                <p role="alert" className="error tiny">
                  {blocked}
                </p>
              )}
            </div>
          )}
        </fieldset>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">{t.fiscalSaved}</p>}
      <p>
        {data.lastFolio
          ? fill(t.fiscalLastFolio, { folio: data.lastFolio })
          : data.previousFolio
            ? fill(t.fiscalPreviousSeries, {
                folio: data.previousFolio,
                first: formatFolio(data.ticketSeries, 1),
              })
            : t.fiscalNoTickets}
      </p>
      {data.updatedAt && data.updatedByName && (
        <p className="muted tiny">
          {fill(t.fiscalUpdatedBy, {
            name: data.updatedByName,
            date: fiscalDateTime(
              data.updatedAt,
              session.restaurant.timezone,
              locale,
            ),
          })}
        </p>
      )}
      {data.currencySupported && data.missingTickets > 0 && (
        <div className="warning-panel">
          <p>{fill(t.fiscalMissingTickets, { n: data.missingTickets })}</p>
          {data.ticketsEnabled ? (
            <Button disabled={busy} onClick={() => void repair()}>
              {t.fiscalIssueMissing}
            </Button>
          ) : (
            // FISCAL-UI-5: the kill switch is on; a repair would issue nothing.
            <p>{t.fiscalTicketsPaused}</p>
          )}
        </div>
      )}
      {repaired !== null && (
        <p role="status">{fill(t.fiscalIssuedMissing, { n: repaired })}</p>
      )}
      <details className="fiscal-register">
        <summary>{t.fiscalRegister}</summary>
        <TicketRegister session={session} locale={locale} />
      </details>
    </section>
  );
}
