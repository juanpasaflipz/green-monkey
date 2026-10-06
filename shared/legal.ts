import { z } from "zod";
import { privacyContent, PRIVACY_SIMPLIFIED } from "./legal/privacy.js";
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
 * bumps `version` only; a material edit also bumps `requiresAcceptanceSince`,
 * which makes every owner re-accept at the next account sign-in.
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
  requiresAcceptanceSince: string;
  path: string;
  enPath: string;
  changes: Record<LegalLocale, readonly string[]>;
};

export const LEGAL_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}(\.\d+)?$/;
export const legalVersion = z.string().regex(LEGAL_VERSION_PATTERN);
/** Versions the client accepted (signup, invitation, transfer, re-acceptance). */
export const legalAcceptedInput = z
  .object({
    terms: legalVersion,
    privacy: legalVersion,
    dpa: legalVersion.optional(),
  })
  .strict();
export type LegalAccepted = z.infer<typeof legalAcceptedInput>;

const FIRST = {
  es: ["Primera versión publicada."],
  en: ["First published version."],
} as const;

export const LEGAL_DOCUMENTS: Record<LegalDocumentKey, LegalDocumentMeta> = {
  privacy: {
    version: "2026-10-05",
    requiresAcceptanceSince: "2026-10-05",
    path: "/legal/privacidad",
    enPath: "/legal/privacy",
    changes: FIRST,
  },
  terms: {
    version: "2026-10-05",
    requiresAcceptanceSince: "2026-10-05",
    path: "/legal/terminos",
    enPath: "/legal/terms",
    changes: FIRST,
  },
  dpa: {
    version: "2026-10-05",
    requiresAcceptanceSince: "2026-10-05",
    path: "/legal/encargo-de-datos",
    enPath: "/legal/data-processing",
    changes: FIRST,
  },
};

export const LEGAL_CONTENT: Record<LegalDocumentKey, LegalDocumentContent> = {
  privacy: privacyContent,
  terms: termsContent,
  dpa: dpaContent,
};
export { PRIVACY_SIMPLIFIED };

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
 * Whether a document needs (re-)acceptance: never accepted; accepted before its
 * requiresAcceptanceSince; accepted for another legal entity; or accepted as an
 * unpublished draft after the documents were published. Unpublished documents
 * are never pending: nothing is in force to accept.
 */
export function acceptancePending(
  document: LegalDocumentKey,
  row: AcceptanceRow | null | undefined,
  current: { status: LegalStatus; entityHash: string },
): boolean {
  if (current.status !== "published") return false;
  if (!row) return true;
  if (
    compareLegalVersions(
      row.version,
      LEGAL_DOCUMENTS[document].requiresAcceptanceSince,
    ) < 0
  )
    return true;
  if (row.entityHash !== current.entityHash) return true;
  return !row.published;
}

/** The account-level documents (terms, privacy) still to accept. */
export function pendingDocuments(
  accepted: Partial<Record<"terms" | "privacy", AcceptanceRow>>,
  current: { status: LegalStatus; entityHash: string },
): Array<"terms" | "privacy"> {
  return (["terms", "privacy"] as const).filter((d) =>
    acceptancePending(d, accepted[d], current),
  );
}
