import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  loadAccountConfig,
  type AccountConfig,
} from "../features/accountConfig";
import { strings, type Key } from "../i18n";
import {
  LEGAL_CONTENT,
  LEGAL_DOCUMENTS,
  LEGAL_ROUTES,
  legalSegments,
  templateFields,
  type LegalDocumentKey,
  type LegalEntity,
  type LegalLocale,
} from "../../shared/legal";
import "./legal.css";

const TITLE_KEYS: Record<LegalDocumentKey, Key> = {
  privacy: "accountLegalPrivacy",
  terms: "accountLegalTerms",
  dpa: "accountLegalDpa",
};
const PATH = /(\/legal\/[a-z-]+)/;
const IS_PATH = /^\/legal\/[a-z-]+$/;

/** Text with entity tokens: values when published, highlighted chips otherwise. */
function LegalText({
  template,
  entity,
  locale,
}: {
  template: string;
  entity: LegalEntity | null;
  locale: LegalLocale;
}) {
  const t = strings[locale];
  return (
    <>
      {legalSegments(template, entity, locale).map((s, i) =>
        "text" in s ? (
          <Fragment key={i}>
            {s.text.split(PATH).map((part, j) =>
              IS_PATH.test(part) ? (
                <a key={j} href={part}>
                  {part}
                </a>
              ) : (
                <Fragment key={j}>{part}</Fragment>
              ),
            )}
          </Fragment>
        ) : (
          <mark key={i} className="legal-missing">
            {t.accountLegalPendingField}
          </mark>
        ),
      )}
    </>
  );
}

function initialLocale(route: { locale: LegalLocale | null } | undefined) {
  if (route?.locale) return route.locale;
  try {
    return localStorage.getItem("gm-locale") === "en" ? "en" : "es";
  } catch {
    return "es";
  }
}

/**
 * Platform legal pages (/legal, /legal/privacidad, /legal/terminos,
 * /legal/encargo-de-datos and the English aliases). Rendered outside the POS
 * shell, so they work in any browser and from the offline shell; the entity
 * values come from /api/account-config and are never shown while unpublished.
 */
export default function LegalPage() {
  const path = location.pathname.replace(/\/+$/, "") || "/legal";
  const route = LEGAL_ROUTES[path] ?? LEGAL_ROUTES["/legal"];
  const [locale, setLocale] = useState<LegalLocale>(() => initialLocale(route));
  const [config, setConfig] = useState<AccountConfig | null>(null);
  const [offline, setOffline] = useState(false);
  const t = strings[locale];
  const doc = route.document === "index" ? null : route.document;
  const load = () => {
    setOffline(false);
    loadAccountConfig()
      .then(setConfig)
      .catch(() => setOffline(true));
  };
  useEffect(load, []);
  useEffect(() => {
    document.documentElement.lang = locale === "es" ? "es-MX" : "en";
    document.title =
      (doc ? t[TITLE_KEYS[doc]] : t.accountLegalIndexTitle) + " — Green Monkey";
  }, [locale, doc]);
  const unpublished = config?.legal.status === "unpublished";
  useEffect(() => {
    if (!unpublished) return;
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.append(meta);
    return () => meta.remove();
  }, [unpublished]);
  useEffect(() => {
    if (!config || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [config]);
  const entity = config?.legal.entity ?? null;
  const other = locale === "es" ? "en" : "es";
  const pathFor = (d: LegalDocumentKey, l: LegalLocale) =>
    l === "es" ? LEGAL_DOCUMENTS[d].path : LEGAL_DOCUMENTS[d].enPath;
  let body: ReactNode;
  if (offline)
    body = (
      <div className="legal-offline" role="status">
        <p>{t.accountLegalOffline}</p>
        <button type="button" className="button" onClick={load}>
          {locale === "es" ? "Reintentar" : "Retry"}
        </button>
      </div>
    );
  else if (!config) body = <p role="status">{t.accountLegalLoading}</p>;
  else if (!doc)
    body = (
      <>
        <p className="muted">{t.accountLegalIndexHint}</p>
        <ul className="legal-index">
          {(Object.keys(TITLE_KEYS) as LegalDocumentKey[]).map((d) => (
            <li key={d}>
              <a href={pathFor(d, locale)}>{t[TITLE_KEYS[d]]}</a>
              <span className="muted">
                {" · "}
                {t.accountLegalVersion.replace(
                  "{version}",
                  LEGAL_DOCUMENTS[d].version,
                )}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  else {
    const content = LEGAL_CONTENT[doc][locale];
    body = (
      <>
        <p className="muted">
          {t.accountLegalVersion.replace(
            "{version}",
            LEGAL_DOCUMENTS[doc].version,
          )}
        </p>
        <nav className="legal-toc" aria-label={content.title}>
          <ol>
            {content.sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>
        {content.sections.map((s) => (
          <section key={s.id} id={s.id} className="legal-section">
            <h2>{s.title}</h2>
            {s.paragraphs
              // A published entity without an RFC: the RFC line is omitted.
              .filter(
                (p) =>
                  !(
                    entity &&
                    !entity.rfc &&
                    templateFields(p).length === 1 &&
                    templateFields(p)[0] === "rfc"
                  ),
              )
              .map((p, i) => (
                <p key={i}>
                  <LegalText template={p} entity={entity} locale={locale} />
                </p>
              ))}
          </section>
        ))}
        <section className="legal-section">
          <h2>{t.accountLegalChanges}</h2>
          <ul>
            {LEGAL_DOCUMENTS[doc].changes[locale].map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          {locale === "en" && (
            <p className="muted">{t.accountLegalSpanishPrevails}</p>
          )}
        </section>
      </>
    );
  }
  return (
    <main className="legal-page" lang={locale === "es" ? "es-MX" : "en"}>
      <header className="legal-header">
        <a href="/" className="legal-brand">
          Green Monkey
        </a>
        <nav aria-label={t.accountLegalIndexTitle}>
          {doc && route.locale ? (
            <a href={pathFor(doc, other)} hrefLang={other}>
              {other === "en" ? "English" : "Español"}
            </a>
          ) : (
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                setLocale(other);
                try {
                  localStorage.setItem("gm-locale", other);
                } catch {
                  /* Private mode: the choice lasts for this page only. */
                }
              }}
            >
              {other === "en" ? "English" : "Español"}
            </button>
          )}
          <button
            type="button"
            className="button ghost legal-print"
            onClick={() => window.print()}
          >
            {t.accountLegalPrint}
          </button>
        </nav>
      </header>
      {unpublished && (
        <p className="legal-draft" role="alert">
          {t.accountLegalDraftBanner}
        </p>
      )}
      <h1>{doc ? t[TITLE_KEYS[doc]] : t.accountLegalIndexTitle}</h1>
      {body}
      {config && (
        <section id="contacto" className="legal-section legal-contact">
          <h2>{t.accountLegalContact}</h2>
          {entity ? (
            <p>
              <LegalText
                template="{{entity.privacyContactName}}: {{entity.privacyContactEmail}}"
                entity={entity}
                locale={locale}
              />
            </p>
          ) : (
            <p>
              <mark className="legal-missing">
                {t.accountLegalPendingField}
              </mark>
            </p>
          )}
          {config.support.configured ? (
            <ul className="legal-support">
              {config.support.email && (
                <li>
                  {t.accountHelpEmail}:{" "}
                  <a href={`mailto:${config.support.email}`}>
                    {config.support.email}
                  </a>
                </li>
              )}
              {config.support.phone && (
                <li>
                  {t.accountHelpPhone}:{" "}
                  <a href={`tel:${config.support.phone}`}>
                    {config.support.phone}
                  </a>
                </li>
              )}
              {config.support.whatsapp && (
                <li>
                  {t.accountHelpWhatsapp}:{" "}
                  <a
                    href={`https://wa.me/${config.support.whatsapp.replace(/\D/g, "")}`}
                    rel="noopener noreferrer"
                  >
                    {config.support.whatsapp}
                  </a>
                </li>
              )}
              {config.support.url && (
                <li>
                  <a href={config.support.url} rel="noopener noreferrer">
                    {t.accountHelpCenter}
                  </a>
                </li>
              )}
              {(locale === "es"
                ? config.support.hoursEs
                : config.support.hoursEn) && (
                <li>
                  {t.accountHelpHours}:{" "}
                  {locale === "es"
                    ? config.support.hoursEs
                    : config.support.hoursEn}
                </li>
              )}
            </ul>
          ) : (
            <p className="muted">{t.accountHelpNotConfigured}</p>
          )}
        </section>
      )}
      <footer className="legal-footer">
        {(Object.keys(TITLE_KEYS) as LegalDocumentKey[]).map((d) => (
          <a key={d} href={pathFor(d, locale)}>
            {t[TITLE_KEYS[d]]}
          </a>
        ))}
        <a href="/">{t.accountLegalBack}</a>
      </footer>
    </main>
  );
}
