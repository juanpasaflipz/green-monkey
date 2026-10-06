import { useEffect, useId, useState } from "react";
import type { Locale } from "../../shared/domain";
import { strings } from "../i18n";
import type { AccountConfig } from "./accountConfig";
import "./account.css";

export type LegalAccepted = { terms: string; privacy: string; dpa?: string };

/**
 * The acceptance checkboxes (account 031, FIT-12): terms (plus the DPA where
 * the person contracts for an organization) and the privacy acknowledgment.
 * onChange receives the current versions once every required box is checked,
 * else null. Draft documents (test environments) say so in the heading.
 */
export function LegalAcceptance({
  mode,
  config,
  locale,
  organizationName,
  onChange,
}: {
  mode: "signup" | "invitation" | "reacceptance" | "transfer";
  config: AccountConfig;
  locale: Locale;
  organizationName?: string;
  onChange: (accepted: LegalAccepted | null) => void;
}) {
  const t = strings[locale];
  const id = useId();
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const withDpa = mode === "signup" || mode === "transfer";
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
      terms && privacy
        ? {
            terms: docs.terms.version,
            privacy: docs.privacy.version,
            ...(withDpa ? { dpa: docs.dpa.version } : {}),
          }
        : null,
    );
  }, [terms, privacy]);
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
        {mode === "transfer" && organizationName
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
    </fieldset>
  );
}
