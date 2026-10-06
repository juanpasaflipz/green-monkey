import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tx } from "./db.js";
import { log } from "./logging.js";
import { isProductionEnv } from "./production.js";
import { LEGAL_CI_ENV } from "./legal-ci.js";
import { DomainError } from "../shared/domain.js";
import { validateRfc } from "../shared/sat.js";
import {
  BILLING_CONSENT,
  LEGAL_CONTENT,
  LEGAL_DOCUMENTS,
  acceptanceStatus,
  type AcceptanceRow,
  type LegalDocumentKey,
  type LegalEntity,
  type LegalEvidenceKey,
} from "../shared/legal.js";

export type { LegalDocumentKey, LegalEntity };

/** Support channels from configuration; every field optional (D15). */
export type SupportContact = {
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  hoursEs: string | null;
  hoursEn: string | null;
  url: string | null;
  configured: boolean;
};
export type LegalConfig = {
  status: "published" | "unpublished";
  /** null unless published: no entity value ever reaches a client otherwise. */
  entity: LegalEntity | null;
  /** sha256 of the canonical entity JSON, or of "unpublished". */
  entityHash: string;
  /** Required variables that are unset. Names only. */
  missing: string[];
  /** Variables that are set but refused (format or placeholder). Names only. */
  invalid: string[];
  unpublishedSignupAllowed: boolean;
  support: SupportContact;
};

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/**
 * Placeholder markers refused in every environment (LD-3). Tokens that never
 * occur in a real name or address match anywhere; dictionary words match only
 * as whole words, so "Todos Santos, B.C.S." or "Comida para Todos S.A. de C.V."
 * publish (ACC-11). TODO is refused only in capitals: "todo" is Spanish.
 */
const PLACEHOLDER_TOKENS = /replace|placeholder|changeme|lorem|xxx/i;
const PLACEHOLDER_WORDS =
  /(?<![\p{L}\p{N}])(?:example|tbd|sample|dummy|acme)(?![\p{L}\p{N}])/iu;
const PLACEHOLDER_MARKER = /(?<![\p{L}\p{N}])TODO(?![\p{L}\p{N}])/u;
const placeholder = (value: string) =>
  PLACEHOLDER_TOKENS.test(value) ||
  PLACEHOLDER_WORDS.test(value) ||
  PLACEHOLDER_MARKER.test(value);
/** Fixture words refused in compiled/deployed processes (NODE_ENV=production). */
const FIXTURE_WORDS = /\b(test|prueba|demo|fixture|ficticio|ficticia)\b/i;
const EXAMPLE_DOMAIN = /@(?:[^@]+\.)?example\.(?:com|org|net)$/i;
/**
 * The identifying values of the fictional CI set (entity, address, contacts,
 * and any address at its domain) are placeholders wherever production is
 * served (ACC-18). Its jurisdiction and hours are ordinary values a real
 * company may share, so they are not refused.
 */
const CI_IDENTIFYING: ReadonlySet<string> = new Set(
  [
    LEGAL_CI_ENV.LEGAL_ENTITY_NAME,
    LEGAL_CI_ENV.LEGAL_ENTITY_ADDRESS,
    LEGAL_CI_ENV.LEGAL_PRIVACY_CONTACT_EMAIL,
    LEGAL_CI_ENV.SUPPORT_EMAIL,
    LEGAL_CI_ENV.SUPPORT_PHONE,
  ].map((v) => v.toLowerCase()),
);
const CI_DOMAIN = LEGAL_CI_ENV.SUPPORT_EMAIL.slice(
  LEGAL_CI_ENV.SUPPORT_EMAIL.indexOf("@"),
).toLowerCase();
const ciValue = (v: string) =>
  CI_IDENTIFYING.has(v.toLowerCase()) || v.toLowerCase().endsWith(CI_DOMAIN);
const RESERVED_TLD = /\.(?:test|invalid|local|example)$/i;
const E164 = /^\+[1-9]\d{7,14}$/;

type Check = (value: string) => boolean;
const text =
  (min: number, max: number): Check =>
  (v) =>
    v.length >= min && v.length <= max;
const email: Check = (v) =>
  v.length <= 254 &&
  z.email().safeParse(v).success &&
  !EXAMPLE_DOMAIN.test(v) &&
  !RESERVED_TLD.test(v);
const https: Check = (v) => {
  if (v.length > 300 || /\s/.test(v)) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Reads the legal entity and support contact (pure). Refuses empty and
 * malformed values, brackets/braces, placeholder words and example domains;
 * with NODE_ENV=production (staging, production and the compiled CI runs) also
 * test/demo words; in production (isProductionEnv) also the identifying
 * values of the fictional CI set (LEGAL_CI_ENV), which CI publishes with
 * APP_ENV unset. The
 * documents are published only when every required field is valid; otherwise
 * no entity value is returned at all.
 */
export function legalConfig(env: NodeJS.ProcessEnv): LegalConfig {
  const strict = env.NODE_ENV === "production";
  const production = isProductionEnv(env);
  const missing: string[] = [];
  const invalid: string[] = [];
  const read = (name: string, check: Check, required: boolean) => {
    const raw = env[name]?.trim() ?? "";
    if (!raw) {
      if (required) missing.push(name);
      return null;
    }
    if (
      !check(raw) ||
      /[<>[\]{}]/.test(raw) ||
      placeholder(raw) ||
      (strict && FIXTURE_WORDS.test(raw)) ||
      (production && ciValue(raw))
    ) {
      invalid.push(name);
      return null;
    }
    return raw;
  };
  const name = read("LEGAL_ENTITY_NAME", text(3, 200), true);
  const address = read("LEGAL_ENTITY_ADDRESS", text(10, 300), true);
  // R-31: the fiscal core's validateRfc (real date, check digit, no generic RFC),
  // so legal and fiscal agree on what an RFC is.
  const rfc = read(
    "LEGAL_ENTITY_RFC",
    (v) => {
      const r = validateRfc(v);
      return r.ok && r.rfc === v;
    },
    false,
  );
  const privacyContactEmail = read("LEGAL_PRIVACY_CONTACT_EMAIL", email, true);
  const privacyContactName = read(
    "LEGAL_PRIVACY_CONTACT_NAME",
    text(3, 120),
    false,
  );
  const jurisdiction = read("LEGAL_JURISDICTION", text(2, 100), true);
  const support = {
    email: read("SUPPORT_EMAIL", email, false),
    phone: read("SUPPORT_PHONE", (v) => E164.test(v), false),
    whatsapp: read("SUPPORT_WHATSAPP", (v) => E164.test(v), false),
    hoursEs: read("SUPPORT_HOURS", text(1, 120), false),
    hoursEn: read("SUPPORT_HOURS_EN", text(1, 120), false),
    url: read("SUPPORT_URL", https, false),
  };
  const published = Boolean(
    name &&
    address &&
    privacyContactEmail &&
    jurisdiction &&
    !invalid.some((n) =>
      [
        "LEGAL_ENTITY_NAME",
        "LEGAL_ENTITY_ADDRESS",
        "LEGAL_PRIVACY_CONTACT_EMAIL",
        "LEGAL_JURISDICTION",
      ].includes(n),
    ),
  );
  const entity: LegalEntity | null = published
    ? {
        name: name!,
        address: address!,
        rfc,
        privacyContactEmail: privacyContactEmail!,
        privacyContactName,
        jurisdiction: jurisdiction!,
      }
    : null;
  return {
    status: published ? "published" : "unpublished",
    entity,
    entityHash: sha256(entity ? canonicalEntity(entity) : "unpublished"),
    missing,
    invalid,
    // LD-3: the override never applies to production, whatever it says.
    unpublishedSignupAllowed:
      env.LEGAL_UNPUBLISHED_SIGNUP?.trim() === "allow" && !isProductionEnv(env),
    support: {
      ...support,
      configured: Boolean(
        support.email || support.phone || support.whatsapp || support.url,
      ),
    },
  };
}

function canonicalEntity(e: LegalEntity) {
  return JSON.stringify([
    e.name,
    e.address,
    e.rfc,
    e.privacyContactEmail,
    e.privacyContactName,
    e.jurisdiction,
  ]);
}

/**
 * The LD-3 production readiness signal for legal values: the web still starts
 * (POS operation never depends on legal copy) but logs which variables keep the
 * documents unpublished. Names only, never values.
 */
export function logLegalStartup(c: LegalConfig, env: NodeJS.ProcessEnv) {
  const production = isProductionEnv(env);
  if (c.status === "unpublished")
    (production ? log.error : log.warn)("legal_documents_unpublished", {
      fields: [...c.missing, ...c.invalid],
    });
  else if (c.invalid.length)
    log.warn("legal_optional_values_invalid", { fields: c.invalid });
  if (env.LEGAL_UNPUBLISHED_SIGNUP?.trim() === "allow") {
    if (production) log.error("legal_unpublished_signup_ignored", {});
    else if (c.status === "unpublished")
      log.warn("legal_unpublished_signup_allowed", {});
  }
}

/** New Google accounts and restaurants may be created. */
export function signupOpen(c: LegalConfig): boolean {
  return c.status === "published" || c.unpublishedSignupAllowed;
}

const contentHashes = new Map<LegalEvidenceKey, string>();
/**
 * sha256 of {version, es, en}: what exactly the person accepted. The billing
 * consent hashes its checkbox text with the privacy version it belongs to.
 */
export function legalContentHash(doc: LegalEvidenceKey): string {
  let value = contentHashes.get(doc);
  if (!value) {
    value = sha256(
      JSON.stringify(
        doc === "billing_consent"
          ? {
              version: LEGAL_DOCUMENTS.privacy.version,
              es: BILLING_CONSENT.es,
              en: BILLING_CONSENT.en,
            }
          : {
              version: LEGAL_DOCUMENTS[doc].version,
              es: LEGAL_CONTENT[doc].es,
              en: LEGAL_CONTENT[doc].en,
            },
      ),
    );
    contentHashes.set(doc, value);
  }
  return value;
}
/** The version an evidence row must carry: the billing consent follows the privacy notice. */
export const evidenceVersion = (doc: LegalEvidenceKey) =>
  LEGAL_DOCUMENTS[doc === "billing_consent" ? "privacy" : doc].version;

export type LegalNotice = {
  document: LegalDocumentKey;
  /**
   * announced: a material change takes effect on effectiveFrom (accepting
   * early is allowed); updated: a newer non-material version; entity_updated:
   * only the responsable's data changed. None of them gates anything.
   */
  kind: "announced" | "updated" | "entity_updated";
  version: string;
  effectiveFrom: string;
};
export type LegalState = {
  status: LegalConfig["status"];
  signupOpen: boolean;
  /** Gating now (428): never accepted, a draft acceptance, or a material change in effect. */
  pending: Array<"terms" | "privacy">;
  /** Organizations where this account is primary and the DPA is pending. */
  dpaPending: string[];
  /** Non-gating notices (LEGAL-3); the DPA's only for primaries. */
  notices: LegalNotice[];
  /** Primary organizations whose DPA has a notice (accepting it records one row each). */
  dpaNoticeOrganizations: string[];
  accepted: Partial<
    Record<"terms" | "privacy", { version: string; acceptedAt: string }>
  >;
  /** Whether the express billing consent (UX-3) was ever recorded for this account. */
  billingConsent: boolean;
};

type AcceptanceDbRow = {
  document: LegalEvidenceKey;
  organization_id: string | null;
  version: string;
  entity_hash: string;
  published: boolean;
  accepted_at: Date;
};
const toRow = (r: AcceptanceDbRow): AcceptanceRow => ({
  version: r.version,
  entityHash: r.entity_hash,
  published: r.published,
});

/**
 * Pending documents for one account (app.account_id must be set). The DPA is
 * pending per organization where the account is primary; co-owners never accept
 * it. Unpublished documents are never pending. `now` defaults to the server
 * clock: a material change gates from its effectiveFrom (LEGAL-3).
 */
export async function legalState(
  tx: Tx,
  accountId: string,
  c: LegalConfig,
  now: number = Date.now(),
): Promise<LegalState> {
  const rows = await tx<AcceptanceDbRow[]>`
    select distinct on (document, organization_id) document,organization_id,version,entity_hash,published,accepted_at
      from legal_acceptances where account_id=${accountId}
     order by document, organization_id, accepted_at desc, id`;
  const accountRow = (d: "terms" | "privacy") =>
    rows.find((r) => r.document === d && !r.organization_id);
  const current = { status: c.status, entityHash: c.entityHash };
  const primary =
    await tx`select id from organizations where created_by_account=${accountId} order by id`;
  const accepted: LegalState["accepted"] = {};
  for (const d of ["terms", "privacy"] as const) {
    const r = accountRow(d);
    if (r)
      accepted[d] = {
        version: r.version,
        acceptedAt: r.accepted_at.toISOString(),
      };
  }
  const statusOf = (d: LegalDocumentKey, r: AcceptanceDbRow | undefined) =>
    acceptanceStatus(d, r && toRow(r), current, now);
  const notices: LegalNotice[] = [];
  const notice = (d: LegalDocumentKey, status: string) => {
    if (
      (status === "announced" ||
        status === "updated" ||
        status === "entity_updated") &&
      !notices.some((n) => n.document === d)
    )
      notices.push({
        document: d,
        kind: status,
        version: LEGAL_DOCUMENTS[d].version,
        effectiveFrom: LEGAL_DOCUMENTS[d].effectiveFrom,
      });
  };
  const pending: Array<"terms" | "privacy"> = [];
  for (const d of ["terms", "privacy"] as const) {
    const status = statusOf(d, accountRow(d));
    if (status === "required") pending.push(d);
    else notice(d, status);
  }
  const dpaPending: string[] = [];
  const dpaNoticeOrganizations: string[] = [];
  for (const o of primary) {
    const id = o.id as string;
    const status = statusOf(
      "dpa",
      rows.find((x) => x.document === "dpa" && x.organization_id === id),
    );
    if (status === "required") dpaPending.push(id);
    else if (status !== "accepted") {
      dpaNoticeOrganizations.push(id);
      notice("dpa", status);
    }
  }
  return {
    status: c.status,
    signupOpen: signupOpen(c),
    pending,
    dpaPending,
    notices,
    dpaNoticeOrganizations,
    accepted,
    billingConsent: rows.some((r) => r.document === "billing_consent"),
  };
}

/**
 * The legalAccepted fields a primary-making command (signup, transfer)
 * needs while the documents are published: the billing consent as well as
 * the documents (UX-3). Returns the evidence row to record, or null.
 */
export function billingConsentEvidence(
  accepted: { billingConsent?: string } | undefined,
  c: LegalConfig,
): { document: "billing_consent"; version: string } | null {
  if (c.status === "published" && !accepted?.billingConsent)
    throw new DomainError("legal_acceptance_required", 428);
  return accepted?.billingConsent
    ? { document: "billing_consent", version: accepted.billingConsent }
    : null;
}

export type AcceptanceContext =
  "signup" | "invitation" | "reacceptance" | "transfer";

/**
 * Records acceptance evidence (append-only legal_acceptances): one row per
 * document with the content and entity hashes and the owner session that
 * accepted. Versions must equal the current ones; a DPA needs primary
 * ownership of its organization.
 */
export async function recordAcceptances(
  tx: Tx,
  account: { id: string; sessionId: string },
  input: {
    documents: Array<{
      document: LegalEvidenceKey;
      version: string;
      organizationId?: string;
    }>;
    locale: "es" | "en";
    context: AcceptanceContext;
  },
  c: LegalConfig,
): Promise<void> {
  if (!signupOpen(c)) throw new DomainError("signup_paused", 503);
  for (const d of input.documents)
    if (d.version !== evidenceVersion(d.document))
      throw new DomainError("legal_version_mismatch", 409);
  for (const d of input.documents) {
    let organizationId: string | null = null;
    if (d.document === "dpa") {
      organizationId = z.uuid().parse(d.organizationId);
      const [primary] =
        await tx`select 1 from organizations where id=${organizationId} and created_by_account=${account.id}`;
      if (!primary) {
        const [coOwner] =
          await tx`select 1 from organization_co_owners where organization_id=${organizationId} and account_id=${account.id} and removed_at is null`;
        throw new DomainError(
          coOwner ? "co_owner_primary_only" : "forbidden",
          403,
        );
      }
    }
    await tx`insert into legal_acceptances(id,account_id,owner_session_id,document,version,content_hash,entity_hash,published,locale,context,organization_id)
      values(${randomUUID()},${account.id},${account.sessionId},${d.document},${d.version},${legalContentHash(d.document)},${c.entityHash},${c.status === "published"},${input.locale},${input.context},${organizationId})`;
  }
}

/** Account administration is gated until current documents are accepted (428). */
export async function requireCurrentLegal(
  tx: Tx,
  accountId: string,
  c: LegalConfig,
): Promise<void> {
  if (c.status !== "published") return;
  const state = await legalState(tx, accountId, c);
  if (state.pending.length || state.dpaPending.length)
    throw new DomainError("legal_acceptance_required", 428);
}

/** The documents block of /api/account-config. */
export function legalDocumentsSummary() {
  return Object.fromEntries(
    (Object.keys(LEGAL_DOCUMENTS) as LegalDocumentKey[]).map((k) => [
      k,
      {
        version: LEGAL_DOCUMENTS[k].version,
        requiresAcceptanceSince: LEGAL_DOCUMENTS[k].requiresAcceptanceSince,
        announcedAt: LEGAL_DOCUMENTS[k].announcedAt,
        effectiveFrom: LEGAL_DOCUMENTS[k].effectiveFrom,
        path: LEGAL_DOCUMENTS[k].path,
      },
    ]),
  ) as Record<
    LegalDocumentKey,
    {
      version: string;
      requiresAcceptanceSince: string;
      announcedAt: string;
      effectiveFrom: string;
      path: string;
    }
  >;
}
