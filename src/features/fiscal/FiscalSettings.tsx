// Configuración → "Datos fiscales" (fiscal 027, docs/FISCAL.md): the issuer data printed on
// every ticket, the tax region and default product tax, the folio status and the repair of
// missing tickets, plus the ticket register. The owner edits (with a fresh PIN through api()'s
// step-up); a manager sees it read-only.
import {
  useEffect,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import type { Locale, Session } from "../../../shared/domain";
import {
  BORDER_STIMULUS_VALID_UNTIL,
  fiscalProfileInput,
  fiscalProfileIssues,
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
import { strings, translateError, type Key } from "../../i18n";
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
  ticketSeries: string;
  taxRegion: TaxRegion;
  defaultTaxCategory: TaxCategory;
  borderConfirmed: boolean;
};

function formOf(v: FiscalProfileView): Form {
  return {
    rfc: v.issuer?.rfc ?? "",
    legalName: v.issuer?.legalName ?? "",
    regime: v.issuer?.regime ?? "",
    postalCode: v.issuer?.postalCode ?? "",
    street: v.issuer?.address.street ?? "",
    neighborhood: v.issuer?.address.neighborhood ?? "",
    municipality: v.issuer?.address.municipality ?? "",
    state: v.issuer?.address.state ?? "",
    ticketSeries: v.ticketSeries,
    taxRegion: v.taxRegion,
    defaultTaxCategory: v.defaultTaxCategory,
    borderConfirmed: v.taxRegion !== "general",
  };
}

/** The POST body; identity is null when every identity field is blank. */
function bodyOf(f: Form, expectedVersion: number, operationId: string) {
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
    operationId,
    expectedVersion,
    identity: blank ? null : identity,
    ticketSeries: f.ticketSeries,
    taxRegion: f.taxRegion,
    defaultTaxCategory: f.defaultTaxCategory,
    borderConfirmed: f.taxRegion !== "general" && f.borderConfirmed,
  };
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
  const [data, setData] = useState<FiscalProfileView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  // One operation id per form until a save succeeds (a retry reuses it, MON-3).
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [repairId, setRepairId] = useState(() => crypto.randomUUID());
  const [repaired, setRepaired] = useState<number | null>(null);

  async function load() {
    try {
      const view = await api<FiscalProfileView>("/fiscal/profile");
      setData(view);
      setForm(formOf(view));
      setSubmitted(false);
      setOperationId(crypto.randomUUID());
    } catch (e) {
      setError(translateError((e as Error).message, locale));
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
  const body = bodyOf(form, data.version, operationId);
  const parsed = fiscalProfileInput.safeParse(body);
  const issues: FiscalIssue[] =
    submitted && parsed.success ? fiscalProfileIssues(parsed.data) : [];
  const issue = (field: FiscalIssue["field"]) =>
    issues.find((i) => i.field === field);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm({ ...form, [key]: value });
    setSaved(false);
  };
  const rfc = validateRfc(form.rfc);
  const regimes = ISSUER_REGIMES.filter(
    (code) => !rfc.kind || regimeAllowedFor(code, rfc.kind),
  );
  const border = form.taxRegion !== "general";
  const today = new Date().toISOString().slice(0, 10);
  const expired = today > BORDER_STIMULUS_VALID_UNTIL;
  const validUntil = fiscalDate(BORDER_STIMULUS_VALID_UNTIL);

  async function save() {
    setSubmitted(true);
    setError("");
    setSaved(false);
    if (!parsed.success) {
      setError(translateError("invalid_input", locale));
      return;
    }
    if (fiscalProfileIssues(parsed.data).some((i) => !i.warning)) return;
    setBusy(true);
    try {
      const view = await api<FiscalProfileView>("/fiscal/profile", body, {
        idempotent: true,
      });
      setData(view);
      setForm(formOf(view));
      setSubmitted(false);
      setOperationId(crypto.randomUUID());
      setSaved(true);
      void prefetchFiscalContext(session);
    } catch (e) {
      const code = (e as Error).message;
      setError(translateError(code, locale));
      if (code === "fiscal_profile_changed") {
        const view = await api<FiscalProfileView>("/fiscal/profile").catch(
          () => null,
        );
        if (view) {
          setData(view);
          setOperationId(crypto.randomUUID());
        }
      }
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
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }

  /** A text input with its label, hint and inline error or warning. */
  const text = (
    field: keyof Form & FiscalIssue["field"],
    label: string,
    input: InputHTMLAttributes<HTMLInputElement>,
    hint?: ReactNode,
  ) => {
    const found = issue(field);
    const describedBy = [
      hint ? `${id}-${field}-hint` : "",
      found ? `${id}-${field}-error` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div>
        <label className="field">
          <span>{label}</span>
          <input
            {...input}
            value={form[field] as string}
            aria-invalid={found && !found.warning ? true : undefined}
            aria-describedby={describedBy || undefined}
            onChange={(e) =>
              set(
                field,
                (input.autoCapitalize === "characters"
                  ? e.target.value.toUpperCase()
                  : e.target.value) as never,
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
        {found && (
          <p
            id={`${id}-${field}-error`}
            role="alert"
            className={found.warning ? "fiscal-warning tiny" : "error tiny"}
          >
            {found.warning
              ? t.fiscalRfcCheckDigit
              : translateError(found.code, locale)}
          </p>
        )}
      </div>
    );
  };
  const address = (
    key: "street" | "neighborhood" | "municipality" | "state",
    label: string,
    max: number,
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        value={form[key]}
        maxLength={max}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );
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
                  aria-describedby={
                    regimeIssue ? `${id}-regime-error` : undefined
                  }
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
              {regimeIssue && (
                <p
                  id={`${id}-regime-error`}
                  role="alert"
                  className="error tiny"
                >
                  {translateError(regimeIssue.code, locale)}
                </p>
              )}
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
            <legend>{t.fiscalAddress}</legend>
            <div className="form-grid">
              {address("street", t.fiscalStreet, 120)}
              {address("neighborhood", t.fiscalNeighborhood, 80)}
              {address("municipality", t.fiscalMunicipality, 80)}
              {address("state", t.fiscalState, 60)}
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
                    onChange={() =>
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
                      })
                    }
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
                    aria-describedby={`${id}-border-hint`}
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
                {issue("borderConfirmed") && (
                  <p role="alert" className="error tiny">
                    {translateError(issue("borderConfirmed")!.code, locale)}
                  </p>
                )}
              </div>
            )}
            <label className="field">
              <span>{t.fiscalDefaultCategory}</span>
              <select
                value={form.defaultTaxCategory}
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
            {issue("defaultTaxCategory") && (
              <p role="alert" className="error tiny">
                {translateError(issue("defaultTaxCategory")!.code, locale)}
              </p>
            )}
            <p className="muted">{t.fiscalPricesInclusive}</p>
          </fieldset>
          {editable && (
            <Button variant="primary" type="submit">
              {t.fiscalSave}
            </Button>
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
      {data.missingTickets > 0 && (
        <div className="warning-panel">
          <p>{fill(t.fiscalMissingTickets, { n: data.missingTickets })}</p>
          <Button disabled={busy} onClick={() => void repair()}>
            {t.fiscalIssueMissing}
          </Button>
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
