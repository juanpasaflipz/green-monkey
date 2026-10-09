import { z } from "zod";
import {
  BILLING_CONSENT,
  privacyContent,
  PRIVACY_SIMPLIFIED,
} from "./legal/privacy.js";
import { termsContent } from "./legal/terms.js";
import { dpaContent } from "./legal/dpa.js";

/**
 * Platform legal documents (account 031, FIT-12 / GAP-5): the privacy notice
 * (LFPDPPP Art. 15, with the Art. 16-II simplified section), the terms of
 * service and the data-processing agreement ("contrato de encargo").
 *
 * The legal entity is never hard-coded: templates carry {{entity.<field>}}
 * tokens that the server fills from configuration (server/legal.ts, LD-3).
 * How to publish a new version: docs/ACCOUNT_AND_LEGAL.md. A non-material edit
 * bumps `version` only; a material edit also bumps `requiresAcceptanceSince`
 * and is announced in the app from `announcedAt` at least 15 days before its
 * `effectiveFrom`, the day account commands start asking for it (428).
 */
export type LegalDocumentKey = "terms" | "privacy" | "dpa";
export type LegalLocale = "es" | "en";
export type LegalSection = {
  id: string;
  title: string;
  paragraphs: readonly string[];
};
export type LegalDocumentContent = Record<
  LegalLocale,
  { title: string; sections: readonly LegalSection[] }
>;
export type LegalDocumentMeta = {
  version: string;
  /**
   * Acceptances of older versions stop counting once `effectiveFrom` passes:
   * equal to `version` for a material change, unchanged for a non-material one.
   */
  requiresAcceptanceSince: string;
  /** The version this one replaces; null for the first published version. */
  previousVersion: string | null;
  /**
   * The previous version's requiresAcceptanceSince: an acceptance older than
   * it was already required before this version was announced, so the
   * announcement window does not relax it. null for the first version.
   */
  previousRequiresAcceptanceSince: string | null;
  /** YYYY-MM-DD: from this day owners see the new text announced in the app (LEGAL-3). */
  announcedAt: string;
  /**
   * YYYY-MM-DD (00:00 Mexico City): the version takes effect; a material
   * change gates account commands (428) only from this day, at least
   * MATERIAL_NOTICE_DAYS after announcedAt (terms §13).
   */
  effectiveFrom: string;
  path: string;
  enPath: string;
  changes: Record<LegalLocale, readonly string[]>;
};
/** Days between the announcement and the effect of a material change (terms §13, privacy §12). */
export const MATERIAL_NOTICE_DAYS = 15;
/** 00:00 in Mexico City (UTC-6, no daylight saving since 2022) of a YYYY-MM-DD day. */
export const legalInstant = (day: string) =>
  Date.parse(`${day}T00:00:00-06:00`);
/** A change after the first version that every account must accept again. */
export const materialChange = (meta: LegalDocumentMeta) =>
  meta.previousVersion !== null &&
  meta.requiresAcceptanceSince === meta.version;

export const LEGAL_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}(\.\d+)?$/;
export const legalVersion = z.string().regex(LEGAL_VERSION_PATTERN);
/** Versions the client accepted (signup, invitation, transfer, re-acceptance). */
export const legalAcceptedInput = z
  .object({
    terms: legalVersion,
    privacy: legalVersion,
    dpa: legalVersion.optional(),
    /**
     * The express consent for billing data (UX-3, LFPDPPP Art. 7): the
     * privacy version whose BILLING_CONSENT text the person consented to, in
     * its own checkbox. Required wherever the person becomes a primary owner
     * (signup, transfer) while the documents are published.
     */
    billingConsent: legalVersion.optional(),
  })
  .strict();
export type LegalAccepted = z.infer<typeof legalAcceptedInput>;

const FIRST = {
  es: ["Primera versión publicada."],
  en: ["First published version."],
} as const;
/**
 * The first published version (2026-10-06, after the account second opinion:
 * the simplified notice's domicilio and data clause, the billing consent, the
 * CFDI and backup processors, change notices and support transfers). Never
 * deployed before it, so it is still the first version: nothing to announce.
 */
const FIRST_VERSION = {
  version: "2026-10-06",
  requiresAcceptanceSince: "2026-10-06",
  previousVersion: null,
  previousRequiresAcceptanceSince: null,
  announcedAt: "2026-10-06",
  effectiveFrom: "2026-10-06",
  changes: FIRST,
} as const;

/**
 * The Wave 4 version of the terms, the privacy notice and the DPA, one version for two tracks
 * (critic R40). Counsel reviews the text before the legal set is published (LD-3).
 * - Loyalty club (038, LD-74): club members' data categories, the processor line and the
 *   no-transfer line (privacy §5 and §6; DPA §2, §6 and §11).
 * - Integrated card payments (037 P2, P2-SECURITY-2): terms §5 describes integrated charging and
 *   the custody of the restaurant's provider credentials; the DPA adds the card brand/type/last-4
 *   category (§2) and the transmission to the restaurant's own Mercado Pago or Clip (§11); the
 *   privacy notice adds the encargado line (§6).
 * Both tracks shipped their lines as the unpublished 2026-10-09; at the P2 merge they became this
 * one version whose text is the union (change lines and pinned hashes recomputed, LD-79/LD-81).
 * Not a material change: no account had accepted a published version when it shipped (production
 * signup stays paused until the set is published, LD-72/LD-74), so it takes effect on
 * announcement. Were acceptances of a published 2026-10-06 to exist by the release, set
 * requiresAcceptanceSince to this version and effectiveFrom 15 days after announcedAt instead: the
 * club then waits for effectiveFrom (clubLegalCovered).
 */
const WAVE4_VERSION = {
  version: "2026-10-09",
  requiresAcceptanceSince: FIRST_VERSION.requiresAcceptanceSince,
  previousVersion: FIRST_VERSION.version,
  previousRequiresAcceptanceSince: FIRST_VERSION.requiresAcceptanceSince,
  announcedAt: "2026-10-09",
  effectiveFrom: "2026-10-09",
} as const;

export const LEGAL_DOCUMENTS: Record<LegalDocumentKey, LegalDocumentMeta> = {
  privacy: {
    ...WAVE4_VERSION,
    changes: {
      es: [
        "Socios del club de lealtad de los restaurantes: datos, proveedores y que no se transfieren (§5 y §6).",
        "Cobros con terminal integrada (Mercado Pago, Clip): datos de tarjeta y credenciales del restaurante (§6).",
      ],
      en: [
        "Restaurants' loyalty club members: data, providers and no transfers (§5 and §6).",
        "Integrated terminal payments (Mercado Pago, Clip): card data and the restaurant's credentials (§6).",
      ],
    },
    path: "/legal/privacidad",
    enPath: "/legal/privacy",
  },
  terms: {
    ...WAVE4_VERSION,
    changes: {
      es: [
        "Cobros con terminal integrada con tu cuenta de Mercado Pago o de Clip (§5).",
      ],
      en: [
        "Integrated terminal payments with your Mercado Pago or Clip account (§5).",
      ],
    },
    path: "/legal/terminos",
    enPath: "/legal/terms",
  },
  dpa: {
    ...WAVE4_VERSION,
    changes: {
      es: [
        "Socios del club de lealtad: categorías de datos (§2), subencargados (§6) y sin transferencias (§11).",
        "Cobros con terminal integrada: datos de tarjeta y credenciales (§2) y envío a Mercado Pago o Clip por instrucción del restaurante (§11).",
      ],
      en: [
        "Loyalty club members: data categories (§2), sub-processors (§6) and no transfers (§11).",
        "Integrated terminal payments: card data and credentials (§2) and sending to Mercado Pago or Clip on the restaurant's instructions (§11).",
      ],
    },
    path: "/legal/encargo-de-datos",
    enPath: "/legal/data-processing",
  },
};

/** The first privacy notice and DPA version whose text covers the loyalty club (LOYALTY-PRIVACY-4). */
export const CLUB_LEGAL_VERSION = WAVE4_VERSION.version;
/**
 * Whether the platform documents in force cover the loyalty club: published, and the privacy
 * notice and DPA at CLUB_LEGAL_VERSION or later, in effect. Enabling the club waits for it.
 */
export function clubLegalCovered(
  status: LegalStatus,
  now: number = Date.now(),
): boolean {
  if (status !== "published") return false;
  return (["privacy", "dpa"] as const).every((d) => {
    const m = LEGAL_DOCUMENTS[d];
    const order = compareLegalVersions(m.version, CLUB_LEGAL_VERSION);
    if (order < 0) return false;
    // A later version replaced the club's one, which was in effect before it was announced.
    return order > 0 || now >= legalInstant(m.effectiveFrom);
  });
}
/** Generated change entry when only the responsable's data changed (LEGAL-3). */
export const ENTITY_UPDATED_CHANGE: Record<LegalLocale, string> = {
  es: "Datos del responsable actualizados (nombre, domicilio, RFC, contacto o jurisdicción). El resto del texto no cambió.",
  en: "Controller details updated (name, address, RFC, contact or jurisdiction). The rest of the text did not change.",
};

export const LEGAL_CONTENT: Record<LegalDocumentKey, LegalDocumentContent> = {
  privacy: privacyContent,
  terms: termsContent,
  dpa: dpaContent,
};
export { BILLING_CONSENT, PRIVACY_SIMPLIFIED };
/** Evidence rows: the three documents plus the separately recorded billing consent (UX-3). */
export type LegalEvidenceKey = LegalDocumentKey | "billing_consent";

/** Client routes of the legal pages; the English aliases switch the page to English. */
export const LEGAL_ROUTES: Record<
  string,
  { document: LegalDocumentKey | "index"; locale: LegalLocale | null }
> = {
  "/legal": { document: "index", locale: null },
  "/legal/privacidad": { document: "privacy", locale: "es" },
  "/legal/privacy": { document: "privacy", locale: "en" },
  "/legal/terminos": { document: "terms", locale: "es" },
  "/legal/terms": { document: "terms", locale: "en" },
  "/legal/encargo-de-datos": { document: "dpa", locale: "es" },
  "/legal/data-processing": { document: "dpa", locale: "en" },
};

/** The responsable's identity (server-only configuration, LD-3). */
export type LegalEntity = {
  name: string;
  address: string;
  rfc: string | null;
  privacyContactEmail: string;
  /** null = the localized default ("Departamento de datos personales"). */
  privacyContactName: string | null;
  jurisdiction: string;
};
export const ENTITY_FIELDS = [
  "name",
  "address",
  "rfc",
  "privacyContactEmail",
  "privacyContactName",
  "jurisdiction",
] as const;
export type EntityField = (typeof ENTITY_FIELDS)[number];
const DEFAULT_CONTACT_NAME: Record<LegalLocale, string> = {
  es: "Departamento de datos personales",
  en: "Personal data department",
};

export type LegalSegment = { text: string } | { missing: EntityField };
const TOKEN = /\{\{entity\.([a-zA-Z]+)\}\}/g;

/** The entity fields a template refers to. */
export function templateFields(template: string): EntityField[] {
  return [...template.matchAll(TOKEN)]
    .map((m) => m[1])
    .filter((f): f is EntityField =>
      (ENTITY_FIELDS as readonly string[]).includes(f),
    );
}

/**
 * Splits a template into text and missing-token segments. With no entity
 * (unpublished documents) every token is missing, so draft pages never show a
 * value as if it were in force. A published entity without an RFC leaves the
 * RFC token missing: callers drop paragraphs that only exist to show it.
 */
export function legalSegments(
  template: string,
  entity: LegalEntity | null,
  locale: LegalLocale,
): LegalSegment[] {
  const out: LegalSegment[] = [];
  let last = 0;
  for (const m of template.matchAll(TOKEN)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ text: template.slice(last, index) });
    const field = m[1] as EntityField;
    let value: string | null = null;
    if (entity && (ENTITY_FIELDS as readonly string[]).includes(field))
      value =
        field === "privacyContactName"
          ? (entity.privacyContactName ?? DEFAULT_CONTACT_NAME[locale])
          : entity[field];
    out.push(value ? { text: value } : { missing: field });
    last = index + m[0].length;
  }
  if (last < template.length) out.push({ text: template.slice(last) });
  return out;
}

/** Plain-text rendering (tests, print previews); missing tokens become the marker. */
export function legalText(
  template: string,
  entity: LegalEntity | null,
  locale: LegalLocale,
  marker = "[…]",
): string {
  return legalSegments(template, entity, locale)
    .map((s) => ("text" in s ? s.text : marker))
    .join("");
}

/** Orders "YYYY-MM-DD" and "YYYY-MM-DD.n" versions (the suffix is numeric). */
export function compareLegalVersions(a: string, b: string): number {
  const [da, sa = "0"] = a.split(".");
  const [db, sb = "0"] = b.split(".");
  if (da !== db) return da < db ? -1 : 1;
  return Number(sa) - Number(sb);
}

export type AcceptanceRow = {
  version: string;
  entityHash: string;
  published: boolean;
};
export type LegalStatus = "published" | "unpublished";

/**
 * Where an account stands with one document (LEGAL-3):
 * - "required": never accepted; accepted as an unpublished draft; or a
 *   material change is in effect (effectiveFrom passed) and the acceptance is
 *   older than requiresAcceptanceSince. Account commands answer 428.
 * - "announced": that material change is announced but not yet in effect:
 *   a banner links the new text; accepting early is allowed, nothing is gated.
 * - "entity_updated": only the responsable's data changed (entity hash): a
 *   generated "datos del responsable actualizados" notice, not material.
 *   An operator who considers an entity change material publishes a material
 *   version of the documents instead (docs/ACCOUNT_AND_LEGAL.md).
 * - "updated": a newer non-material version: shown, never asked again.
 * - "accepted". Unpublished documents are never required: nothing is in force.
 */
export type AcceptanceStatus =
  "required" | "announced" | "entity_updated" | "updated" | "accepted";
export function acceptanceStatus(
  document: LegalDocumentKey,
  row: AcceptanceRow | null | undefined,
  current: { status: LegalStatus; entityHash: string },
  now: number = Date.now(),
): AcceptanceStatus {
  if (current.status !== "published") return "accepted";
  if (!row || !row.published) return "required";
  const meta = LEGAL_DOCUMENTS[document];
  if (compareLegalVersions(row.version, meta.requiresAcceptanceSince) < 0) {
    const missedEarlier =
      meta.previousRequiresAcceptanceSince !== null &&
      compareLegalVersions(row.version, meta.previousRequiresAcceptanceSince) <
        0;
    if (missedEarlier || now >= legalInstant(meta.effectiveFrom))
      return "required";
    // The banner starts at announcedAt (LEGAL-3); before it nothing changes.
    return now >= legalInstant(meta.announcedAt) ? "announced" : "accepted";
  }
  if (row.entityHash !== current.entityHash) return "entity_updated";
  if (compareLegalVersions(row.version, meta.version) < 0) return "updated";
  return "accepted";
}
/** Whether the document gates account commands now (428). */
export function acceptancePending(
  document: LegalDocumentKey,
  row: AcceptanceRow | null | undefined,
  current: { status: LegalStatus; entityHash: string },
  now: number = Date.now(),
): boolean {
  return acceptanceStatus(document, row, current, now) === "required";
}

/** The account-level documents (terms, privacy) still to accept. */
export function pendingDocuments(
  accepted: Partial<Record<"terms" | "privacy", AcceptanceRow>>,
  current: { status: LegalStatus; entityHash: string },
  now: number = Date.now(),
): Array<"terms" | "privacy"> {
  return (["terms", "privacy"] as const).filter((d) =>
    acceptancePending(d, accepted[d], current, now),
  );
}
