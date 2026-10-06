import { useEffect, useId, useState } from "react";
import type { Locale } from "../../shared/domain";
import { strings } from "../i18n";
import { BILLING_CONSENT } from "../../shared/legal";
import type { AccountConfig } from "./accountConfig";
import "./account.css";

export type LegalAccepted = {
  terms: string;
  privacy: string;
  dpa?: string;
  billingConsent?: string;
};

/**
 * The acceptance checkboxes (account 031, FIT-12): terms (plus the DPA where
 * the person contracts for an organization), the privacy acknowledgment and,
 * where the person becomes a primary owner (signup, transfer), the express
 * consent for billing data in its own box (UX-3, recorded as its own row).
 * onChange receives the current versions once every required box is checked,
 * else null. Draft documents (test environments) say so in the heading.
 */
export function LegalAcceptance({
  mode,
  config,
  locale,
  organizationName,
  dpa,
  billingConsent,
  onChange,
}: {
  mode: "signup" | "invitation" | "reacceptance" | "transfer";
  config: AccountConfig;
  locale: Locale;
  organizationName?: string;
  /** Overrides: re-acceptance asks for the DPA only when a primary's is due. */
  dpa?: boolean;
  /** Overrides: re-acceptance asks for the consent only when none was recorded. */
  billingConsent?: boolean;
  onChange: (accepted: LegalAccepted | null) => void;
}) {
  const t = strings[locale];
  const id = useId();
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [consent, setConsent] = useState(false);
  const withDpa = dpa ?? (mode === "signup" || mode === "transfer");
  // Where the person becomes the primary owner, who bills the subscription.
  const withConsent =
    billingConsent ?? (mode === "signup" || mode === "transfer");
  const docs = config.legal.documents;
  const path = (d: "terms" | "privacy" | "dpa") =>
    locale === "es"
      ? docs[d].path
      : {
          terms: "/legal/terms",
          privacy: "/legal/privacy",
          dpa: "/legal/data-processing",
        }[d];
  useEffect(() => {
    onChange(
      terms && privacy && (consent || !withConsent)
        ? {
            terms: docs.terms.version,
            privacy: docs.privacy.version,
            ...(withDpa ? { dpa: docs.dpa.version } : {}),
            ...(withConsent ? { billingConsent: docs.privacy.version } : {}),
          }
        : null,
    );
  }, [terms, privacy, consent]);
  const link = (d: "terms" | "privacy" | "dpa", label: string) => (
    <a href={path(d)} target="_blank" rel="noopener">
      {label}
    </a>
  );
  return (
    <fieldset className="legal-acceptance" aria-describedby={id}>
      <legend>
        {config.legal.status === "published"
          ? t.accountLegalAcceptanceTitle
          : t.accountLegalDraftAcceptance}
      </legend>
      <p id={id} className="muted">
        {link("terms", t.accountLegalTerms)} ·{" "}
        {link("privacy", t.accountLegalPrivacy)}
        {withDpa && <> · {link("dpa", t.accountLegalDpa)}</>}
      </p>
      <label className="opening-day">
        <input
          type="checkbox"
          checked={terms}
          onChange={(e) => setTerms(e.target.checked)}
          required
        />
        {withDpa && organizationName
          ? `${t.accountAcceptTerms} ${t.accountAcceptDpa.replace("{org}", organizationName)}`
          : withDpa
            ? t.accountAcceptTermsDpa
            : t.accountAcceptTerms}
      </label>
      <label className="opening-day">
        <input
          type="checkbox"
          checked={privacy}
          onChange={(e) => setPrivacy(e.target.checked)}
          required
        />
        {t.accountAcknowledgePrivacy}
      </label>
      {withConsent && (
        <label className="opening-day">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            required
          />
          {BILLING_CONSENT[locale]}
        </label>
      )}
    </fieldset>
  );
}
