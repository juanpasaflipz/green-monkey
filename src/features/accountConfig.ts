import type { LegalEntity } from "../../shared/legal";

/** GET /api/account-config (account 031): public legal, support, tax and ordering settings. */
export type AccountConfig = {
  legal: {
    status: "published" | "unpublished";
    signupOpen: boolean;
    entity: LegalEntity | null;
    missing?: string[];
    documents: Record<
      "privacy" | "terms" | "dpa",
      {
        version: string;
        requiresAcceptanceSince: string;
        announcedAt: string;
        effectiveFrom: string;
        path: string;
      }
    >;
  };
  support: {
    email: string | null;
    phone: string | null;
    whatsapp: string | null;
    hoursEs: string | null;
    hoursEn: string | null;
    url: string | null;
    configured: boolean;
  };
  saasTax: {
    mode: "off" | "tax_rate";
    ratePercent: number | null;
    collectTaxId: boolean;
    taxProfileEnabled: boolean;
    cfdiEnabled: false;
  };
  /** switchedOff: the operator's kill switch, not a deployment that never offered it. */
  publicOrdering: { enabled: boolean; switchedOff?: boolean };
};

let cached: Promise<AccountConfig> | null = null;
function fetchAccountConfig(init: RequestInit): Promise<AccountConfig> {
  return fetch("/api/account-config", { credentials: "same-origin", ...init })
    .then((response) => {
      if (!response.ok) throw Error(`account config HTTP ${response.status}`);
      return response.json() as Promise<AccountConfig>;
    })
    .catch((error) => {
      cached = null;
      throw error;
    });
}
/**
 * One fetch per page load (the server caches it for 5 minutes too). A failed
 * fetch is not cached, so the next caller retries.
 */
export function loadAccountConfig(): Promise<AccountConfig> {
  cached ??= fetchAccountConfig({});
  return cached;
}
/**
 * A fresh copy past this page's cache and the browser's (the response is
 * cacheable for 5 minutes): after a 409 legal_version_mismatch the documents
 * changed, so the next acceptance must use the versions served now (ACC-17).
 */
export function reloadAccountConfig(): Promise<AccountConfig> {
  cached = fetchAccountConfig({ cache: "no-store" });
  return cached;
}

/** The first configured support channel as a link, else the legal contact section. */
export function supportHref(c: AccountConfig | null): string {
  const s = c?.support;
  if (s?.url) return s.url;
  if (s?.email) return `mailto:${s.email}`;
  if (s?.whatsapp) return `https://wa.me/${s.whatsapp.replace(/\D/g, "")}`;
  if (s?.phone) return `tel:${s.phone}`;
  return "/legal#contacto";
}
