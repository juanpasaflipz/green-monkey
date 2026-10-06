import { useEffect, useState } from "react";
import type { Locale, Session } from "../../shared/domain";
import { Button, Modal } from "../components/ui";
import { strings } from "../i18n";
import { loadAccountConfig, type AccountConfig } from "./accountConfig";
import "./account.css";

/**
 * Help and support (account 031, GAP-5): the support channels from
 * configuration, the legal documents and, inside the POS, the restaurant and
 * device ids support asks for. Shown from the topbar and the login screen.
 */
export function HelpDialog({
  locale,
  session,
  close,
}: {
  locale: Locale;
  session?: Session;
  close: () => void;
}) {
  const t = strings[locale];
  const [config, setConfig] = useState<AccountConfig | null>(null);
  const [version, setVersion] = useState<{
    version: string;
    commit: string;
  } | null>(null);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    void loadAccountConfig()
      .then(setConfig)
      .catch(() => null);
    void fetch("/api/version")
      .then((r) => (r.ok ? r.json() : null))
      .then(setVersion)
      .catch(() => null);
  }, []);
  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied("");
    }
  }
  const s = config?.support;
  const hours = locale === "es" ? s?.hoursEs : s?.hoursEn;
  const legal = (path: string, en: string, label: string) => (
    <li>
      <a href={locale === "es" ? path : en} target="_blank" rel="noopener">
        {label}
      </a>
    </li>
  );
  return (
    <Modal
      title={t.accountHelpTitle}
      close={close}
      closeLabel={t.accountHelpClose}
    >
      {s?.configured ? (
        <ul className="help-channels">
          {s.email && (
            <li>
              {t.accountHelpEmail}: <a href={`mailto:${s.email}`}>{s.email}</a>
            </li>
          )}
          {s.phone && (
            <li>
              {t.accountHelpPhone}: <a href={`tel:${s.phone}`}>{s.phone}</a>
            </li>
          )}
          {s.whatsapp && (
            <li>
              {t.accountHelpWhatsapp}:{" "}
              <a
                href={`https://wa.me/${s.whatsapp.replace(/\D/g, "")}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {s.whatsapp}
              </a>
            </li>
          )}
          {s.url && (
            <li>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {t.accountHelpCenter}
              </a>
            </li>
          )}
          {hours && (
            <li>
              {t.accountHelpHours}: {hours}
            </li>
          )}
        </ul>
      ) : (
        <p className="muted">
          {config ? t.accountHelpNotConfigured : t.accountLoading}
        </p>
      )}
      <h3>{t.accountHelpLegal}</h3>
      <ul>
        {legal("/legal/privacidad", "/legal/privacy", t.accountLegalPrivacy)}
        {legal("/legal/terminos", "/legal/terms", t.accountLegalTerms)}
        {legal(
          "/legal/encargo-de-datos",
          "/legal/data-processing",
          t.accountLegalDpa,
        )}
      </ul>
      {session && (
        <dl className="help-ids">
          <dt>{t.accountHelpRestaurantId}</dt>
          <dd>
            <code>{session.tenantId}</code>{" "}
            <Button
              variant="ghost"
              onClick={() => void copy("tenant", session.tenantId)}
            >
              {t.accountHelpCopy}
            </Button>
          </dd>
          <dt>{t.accountHelpDeviceId}</dt>
          <dd>
            <code>{session.deviceId.slice(0, 8)}</code>
          </dd>
        </dl>
      )}
      <p className="muted" aria-live="polite">
        {copied ? t.accountHelpCopied : ""}
      </p>
      {version && (
        <p className="muted">
          {t.accountHelpVersion}: {version.version} ·{" "}
          {version.commit.slice(0, 12)}
        </p>
      )}
    </Modal>
  );
}
