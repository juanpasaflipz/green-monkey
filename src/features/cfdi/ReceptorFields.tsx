/**
 * The receptor form shared by the staff dialog and the customer portal (spec §2.5, §2.7): RFC,
 * name, régimen (filtered by RFC kind), postal code, uso (filtered by régimen) and email. Errors
 * are cfdi_* codes from receptorIssues (translated), warnings are amber hints that never block.
 */
import { useId } from "react";
import type { Locale } from "../../../shared/domain";
import { REGIMEN_FISCAL } from "../../../shared/sat";
import {
  CFDI_USES,
  regimesFor,
  usesFor,
  type CfdiUse,
  type Receptor,
  type ReceptorField,
  type ReceptorIssue,
} from "../../../shared/cfdi";
import { strings, translateError, type Key } from "../../i18n";

const USE_KEYS: Record<CfdiUse, Key> = {
  G03: "cfdiUseG03",
  G01: "cfdiUseG01",
  S01: "cfdiUseS01",
};

export function emptyReceptor(use: CfdiUse = "G03"): Receptor {
  return {
    rfc: "",
    legalName: "",
    regime: "",
    postalCode: "",
    use,
    email: null,
  };
}

export function ReceptorFields({
  value,
  onChange,
  issues,
  locale,
  requireEmail,
  disabled = false,
  shared = false,
}: {
  value: Receptor;
  onChange: (next: Receptor) => void;
  issues: ReceptorIssue[];
  locale: Locale;
  requireEmail: boolean;
  disabled?: boolean;
  /**
   * A staff dialog on a shared POS terminal: no autofill history for the customer's email or
   * postal code, which the next employee would be offered (CFDI-SECRETS-6). The portal runs on
   * the customer's own device and keeps the autofill tokens.
   */
  shared?: boolean;
}) {
  const id = useId();
  const t = strings[locale];
  const set = (patch: Partial<Receptor>) => onChange({ ...value, ...patch });
  const regimes = regimesFor(value.rfc);
  const uses = Object.hasOwn(REGIMEN_FISCAL, value.regime)
    ? usesFor(value.regime)
    : [...CFDI_USES];
  const issueFor = (field: ReceptorField) =>
    issues.find((i) => i.field === field) ?? null;
  const message = (field: ReceptorField) => {
    const issue = issueFor(field);
    if (!issue) return null;
    const text = issue.warning
      ? (t as Record<string, string>)[issue.code]
      : translateError(issue.code, locale);
    return (
      <span
        id={`${id}-${field}-issue`}
        className={issue.warning ? "cfdi-warning" : "error"}
        role={issue.warning ? undefined : "alert"}
      >
        {text}
      </span>
    );
  };
  // Hints and issues sit after the label, not inside it: inside, they became part of the
  // control's accessible name ("RFC El RFC no tiene…"); they are its description instead.
  const aria = (field: ReceptorField) => {
    const issue = issueFor(field);
    const described = [
      field === "legalName" ? `${id}-legalName-hint` : null,
      issue ? `${id}-${field}-issue` : null,
    ].filter(Boolean);
    return {
      ...(issue && !issue.warning ? { "aria-invalid": true as const } : {}),
      ...(described.length ? { "aria-describedby": described.join(" ") } : {}),
    };
  };
  return (
    <div className="cfdi-receptor">
      <div className="cfdi-receptor-field">
        <label className="field">
          <span>{t.cfdiRfc}</span>
          <input
            value={value.rfc}
            disabled={disabled}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={13}
            onChange={(e) => {
              const rfc = e.target.value.toUpperCase().replace(/\s/g, "");
              const allowed = regimesFor(rfc);
              set({
                rfc,
                regime: allowed.includes(value.regime) ? value.regime : "",
              });
            }}
            {...aria("rfc")}
          />
        </label>
        {message("rfc")}
      </div>
      <div className="cfdi-receptor-field">
        <label className="field">
          <span>{t.cfdiLegalName}</span>
          <input
            value={value.legalName}
            disabled={disabled}
            autoComplete="off"
            maxLength={254}
            onChange={(e) => set({ legalName: e.target.value })}
            {...aria("legalName")}
          />
        </label>
        <small id={`${id}-legalName-hint`} className="muted">
          {t.cfdiLegalNameHint}
        </small>
        {message("legalName")}
      </div>
      <div className="cfdi-receptor-field">
        <label className="field">
          <span>{t.cfdiRegime}</span>
          <select
            value={value.regime}
            disabled={disabled}
            onChange={(e) => {
              const regime = e.target.value;
              const allowed = Object.hasOwn(REGIMEN_FISCAL, regime)
                ? usesFor(regime)
                : [...CFDI_USES];
              set({
                regime,
                use: allowed.includes(value.use)
                  ? value.use
                  : (allowed[0] ?? value.use),
              });
            }}
            {...aria("regime")}
          >
            <option value="">{t.cfdiRegimeChoose}</option>
            {regimes.map((code) => (
              <option key={code} value={code}>
                {code} — {REGIMEN_FISCAL[code][locale]}
              </option>
            ))}
          </select>
        </label>
        {message("regime")}
      </div>
      <div className="cfdi-receptor-field">
        <label className="field">
          <span>{t.cfdiPostalCode}</span>
          <input
            value={value.postalCode}
            disabled={disabled}
            inputMode="numeric"
            autoComplete={shared ? "off" : "postal-code"}
            maxLength={5}
            onChange={(e) =>
              set({ postalCode: e.target.value.replace(/\D/g, "").slice(0, 5) })
            }
            {...aria("postalCode")}
          />
        </label>
        {message("postalCode")}
      </div>
      <div className="cfdi-receptor-field">
        <label className="field">
          <span>{t.cfdiUse}</span>
          <select
            value={value.use}
            disabled={disabled}
            onChange={(e) => set({ use: e.target.value as CfdiUse })}
            {...aria("use")}
          >
            {uses.map((use) => (
              <option key={use} value={use}>
                {t[USE_KEYS[use]]}
              </option>
            ))}
          </select>
        </label>
        {message("use")}
      </div>
      <div className="cfdi-receptor-field">
        <label className="field">
          <span>{requireEmail ? t.cfdiEmail : t.cfdiEmailOptional}</span>
          <input
            type="email"
            value={value.email ?? ""}
            disabled={disabled}
            autoComplete={shared ? "off" : "email"}
            maxLength={254}
            onChange={(e) =>
              set({ email: e.target.value.trim() ? e.target.value : null })
            }
            {...aria("email")}
          />
        </label>
        {message("email")}
      </div>
    </div>
  );
}
