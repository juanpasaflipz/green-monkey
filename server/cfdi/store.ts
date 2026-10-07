/**
 * cfdi SQL shared by the web and the worker (spec §4.1). Every function runs inside the caller's
 * tenant transaction (RLS) and is replay-safe (no side effect outside the transaction).
 *
 * Process boundary: loaded by both processes, so it imports only db types, shared modules, cfdi's
 * pure modules and fiscal's read contract; never server/auth.ts, server/tokens.ts,
 * server/orders.ts, a route module or the worker registry (tests/import-graph.test.ts). Session-
 * dependent decisions take a plain `viewer` ({role, employeeId}), never a Session.
 *
 * The worker has no SELECT on employees: functions that join employees (documentView) are web-only
 * callers' (spec §3.1).
 */
import {
  boundaries,
  businessDate as businessDate_,
  DomainError,
} from "../../shared/domain.js";
import {
  cancellationAllowed,
  cancellationDeadline,
  DEFAULT_GLOBAL_GRACE_MINUTES,
  docLabel,
  effectiveSelfInvoiceDeadline,
  globalBuildAt,
  globalPeriodFor,
  maskEmail,
  maskRfc,
  needsCardForm,
  businessDayStart,
  periodicityChangeBlock,
  periodicityOn,
  selfInvoiceChangeFrom as changeFromDeadline,
  type CfdiAlertsView,
  type CfdiAttention,
  type CfdiDocumentFile,
  type CfdiDocumentSummary,
  type CfdiDocumentView,
  type CfdiMode,
  type CfdiProvider,
  type CfdiStatusView,
  type CfdiTicketView,
  type CfdiUse,
  type CardForm,
  type GlobalPeriodView,
  type Periodicity,
  type PendingSelfInvoice,
  type PeriodicityChangeBlock,
  type PortalDocumentStatus,
  type Receptor,
  type SelfInvoiceGlobalBound,
  type SelfInvoiceTerms,
  type TicketEligibility,
} from "../../shared/cfdi.js";
import { formatFolio, type CfdiTicketPayload } from "../../shared/fiscal.js";
import type { Tx } from "../db.js";
import { ticketForCfdi } from "../fiscal-read.js";

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export type PlatformRow = {
  provider: CfdiProvider;
  liveEnabled: boolean;
  uploadKid: string | null;
  uploadPublicJwk: JsonWebKey | null;
  sharedOrgId: string | null;
  /** The worker's CFDI_GLOBAL_GRACE_MINUTES (036); null from a worker that predates it. */
  globalGraceMinutes: number | null;
  /** The shared sandbox organization's legal data as Facturapi reports it (036, LD-51 F3). */
  sharedIssuer: SharedIssuer | null;
  workerVersion: string;
  updatedAt: string;
};
export type SharedIssuer = {
  legalName: string | null;
  taxId: string | null;
  regime: string | null;
  postalCode: string | null;
};
export type SettingsRow = {
  enabled: boolean;
  mode: CfdiMode;
  testFrom: string;
  liveFrom: string | null;
  liveEnabledAt: string | null;
  liveRequestedAt: string | null;
  liveRequestedFrom: string | null;
  liveRequestedBy: string | null;
  globalPeriodicity: Periodicity;
  nextPeriodicity: Periodicity | null;
  nextPeriodicityFrom: string | null;
  globalAuto: boolean;
  conceptMode: "grouped" | "itemized";
  conceptDescription: string;
  cardPaymentForm: CardForm;
  defaultUse: CfdiUse;
  selfInvoiceEnabled: boolean;
  /** The self-invoicing terms in force today (a pending change already due is applied). */
  selfInvoicePolicy: "month" | "days";
  selfInvoiceDays: number;
  portalReissueGlobal: boolean;
  /**
   * A self-invoicing change that waits because it would bring forward a printed deadline (036,
   * LD-55 CFDIFIX-FISCAL-5 / UX-4); null when none waits or it is due (then it is in force above).
   */
  nextSelfInvoice: PendingSelfInvoice | null;
  supportEmail: string | null;
  version: number;
  updatedBy: string;
  updatedAt: string;
};
export type OrganizationRow = {
  source: "own" | "shared_sandbox";
  status: "provisioning" | "ready" | "error";
  providerOrgId: string | null;
  errorCode: string | null;
  legalSyncedVersion: number | null;
  legalTaxId: string | null;
  csdStatus: "missing" | "processing" | "valid" | "expired" | "error";
  csdSerial: string | null;
  csdValidUntil: string | null;
  productionReady: boolean;
  pendingSteps: { type: string; description: string }[];
  testSecretId: string | null;
  liveSecretId: string | null;
  checkedAt: string | null;
};
/** The restaurant and its fiscal profile (027), as cfdi reads them. */
export type FiscalFacts = {
  tradeName: string;
  currency: string;
  timezone: string;
  cutoff: number;
  /** restaurant_fiscal_profiles.version; 0 without a profile. */
  version: number;
  rfc: string | null;
  legalName: string | null;
  regime: string | null;
  postalCode: string | null;
  address: {
    street?: string;
    neighborhood?: string;
    municipality?: string;
    state?: string;
  };
};
export type DocumentRow = {
  id: string;
  kind: "invoice" | "global" | "egreso";
  source: string;
  mode: CfdiMode;
  status: string;
  dependsOn: string | null;
  replacesDocumentId: string | null;
  parentDocumentId: string | null;
  refundId: string | null;
  receptor: Receptor | null;
  receptorRfc: string | null;
  cardPaymentForm: CardForm | null;
  /** A substitute credit note's FormaPago chosen by the manager (CFDI-SAT-2). */
  paymentFormOverride: "01" | CardForm | null;
  /** A route-III credit note to a global for this ticket's net amount (CFDI-SAT-3). */
  creditTicketId: string | null;
  confirmPreStart: boolean;
  periodKey: string | null;
  globalInfo: {
    periodicity: Periodicity;
    months: string;
    year: number;
    from: string;
    to: string;
  } | null;
  part: number | null;
  request: Record<string, unknown> | null;
  paymentForm: string | null;
  cfdiUse: string | null;
  series: string | null;
  nettedRefundIds: string[];
  expectedTotal: number | null;
  expectedTax: number | null;
  expectedWithholding: number;
  conceptCount: number | null;
  ticketCount: number | null;
  providerOrgId: string | null;
  providerInvoiceId: string | null;
  uuid: string | null;
  livemode: boolean | null;
  folioNumber: number | null;
  total: number | null;
  subtotal: number | null;
  tax: number | null;
  withheld: number | null;
  amountCheck: "exact" | "differs" | null;
  stampedAt: string | null;
  verificationUrl: string | null;
  emailedAt: string | null;
  emailError: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorPath: string | null;
  attempts: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString();

// ---------------------------------------------------------------------------------------------
// Platform, settings, organization, fiscal profile
// ---------------------------------------------------------------------------------------------

/** cfdi_platform (no tenant data); null when no worker ever published it. */
export async function platform(tx: Tx): Promise<PlatformRow | null> {
  const [r] = await tx`select * from cfdi_platform where id = 1`;
  if (!r) return null;
  return {
    provider: r.provider,
    liveEnabled: r.live_enabled,
    uploadKid: r.upload_kid,
    uploadPublicJwk: r.upload_public_jwk,
    sharedOrgId: r.shared_org_id,
    globalGraceMinutes: r.global_grace_minutes ?? null,
    sharedIssuer:
      r.shared_legal_name ||
      r.shared_tax_id ||
      r.shared_tax_system ||
      r.shared_postal_code
        ? {
            legalName: r.shared_legal_name ?? null,
            taxId: r.shared_tax_id ?? null,
            regime: r.shared_tax_system ?? null,
            postalCode: r.shared_postal_code ?? null,
          }
        : null,
    workerVersion: r.worker_version,
    updatedAt: iso(r.updated_at)!,
  };
}

/** The worker's global grace in minutes (the documented default before a worker published one). */
export function graceMinutes(p: PlatformRow | null): number {
  return p?.globalGraceMinutes ?? DEFAULT_GLOBAL_GRACE_MINUTES;
}

/**
 * The restaurant's settings; `forUpdate` locks the row (a save, the tick's plan), `forShare` takes
 * the lock the global builder holds so a periodicity save and a build serialize (LD-51 F2).
 */
export async function loadSettings(
  tx: Tx,
  o: { forUpdate?: boolean; forShare?: boolean } = {},
): Promise<SettingsRow | null> {
  const [r] = await tx`
    select enabled, mode, test_from::text as test_from, live_from::text as live_from, live_enabled_at,
      live_requested_at, live_requested_from::text as live_requested_from, live_requested_by,
      global_periodicity, next_periodicity, next_periodicity_from::text as next_periodicity_from,
      global_auto, concept_mode, concept_description, card_payment_form, default_use,
      self_invoice_enabled, self_invoice_policy, self_invoice_days, portal_reissue_global,
      next_self_invoice_policy, next_self_invoice_days, next_portal_reissue_global,
      next_self_invoice_from::text as next_self_invoice_from,
      support_email, version, updated_by, updated_at
    from cfdi_settings ${o.forUpdate ? tx`for update` : o.forShare ? tx`for share` : tx``}`;
  if (!r) return null;
  // A pending self-invoicing change applies from its business date: in force once it is due, so
  // every reader (the portal, the staff view, the save) sees the terms of the day (LD-55).
  let next: PendingSelfInvoice | null = r.next_self_invoice_from
    ? {
        policy: r.next_self_invoice_policy,
        days: r.next_self_invoice_days,
        reissue: r.next_portal_reissue_global,
        from: r.next_self_invoice_from,
      }
    : null;
  let terms: SelfInvoiceTerms = {
    policy: r.self_invoice_policy,
    days: r.self_invoice_days,
    reissue: r.portal_reissue_global,
  };
  if (next) {
    const [d] = await tx`
      select ((now() at time zone timezone) - make_interval(mins => cutoff))::date::text as today
      from restaurants where id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    if (d && next.from <= d.today) {
      terms = { policy: next.policy, days: next.days, reissue: next.reissue };
      next = null;
    }
  }
  return {
    enabled: r.enabled,
    mode: r.mode,
    testFrom: r.test_from,
    liveFrom: r.live_from,
    liveEnabledAt: iso(r.live_enabled_at),
    liveRequestedAt: iso(r.live_requested_at),
    liveRequestedFrom: r.live_requested_from,
    liveRequestedBy: r.live_requested_by,
    globalPeriodicity: r.global_periodicity,
    nextPeriodicity: r.next_periodicity,
    nextPeriodicityFrom: r.next_periodicity_from,
    globalAuto: r.global_auto,
    conceptMode: r.concept_mode,
    conceptDescription: r.concept_description,
    cardPaymentForm: r.card_payment_form,
    defaultUse: r.default_use,
    selfInvoiceEnabled: r.self_invoice_enabled,
    selfInvoicePolicy: terms.policy,
    selfInvoiceDays: terms.days,
    portalReissueGlobal: terms.reissue,
    nextSelfInvoice: next,
    supportEmail: r.support_email,
    version: r.version,
    updatedBy: r.updated_by,
    updatedAt: iso(r.updated_at)!,
  };
}

/** The first business date the current mode covers (test_from, or live_from in live mode). */
export function modeFrom(s: SettingsRow): string {
  return modeStart(s, s.mode);
}
/** The first business date a mode covers (test from activation, live from its start date). */
export function modeStart(s: SettingsRow, mode: CfdiMode): string {
  return mode === "live" ? (s.liveFrom ?? s.testFrom) : s.testFrom;
}

export async function loadOrganization(
  tx: Tx,
): Promise<OrganizationRow | null> {
  const [r] = await tx`select * from cfdi_organizations`;
  if (!r) return null;
  return {
    source: r.source,
    status: r.status,
    providerOrgId: r.provider_org_id,
    errorCode: r.error_code,
    legalSyncedVersion: r.legal_synced_version,
    legalTaxId: r.legal_tax_id,
    csdStatus: r.csd_status,
    csdSerial: r.csd_serial,
    csdValidUntil: iso(r.csd_valid_until),
    productionReady: r.production_ready,
    pendingSteps: r.pending_steps ?? [],
    testSecretId: r.test_secret_id,
    liveSecretId: r.live_secret_id,
    checkedAt: iso(r.checked_at),
  };
}

/** The restaurant row and its fiscal profile; profile fields are null without one. */
export async function fiscalFacts(tx: Tx): Promise<FiscalFacts> {
  const [r] = await tx`
    select r.name, r.currency, r.timezone, r.cutoff, p.version, p.rfc, p.legal_name, p.regime,
      p.postal_code, p.address
    from restaurants r left join restaurant_fiscal_profiles p on p.tenant_id = r.id
    where r.id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
  if (!r) throw new DomainError("missing_tenant", 403);
  return {
    tradeName: r.name,
    currency: r.currency,
    timezone: r.timezone,
    cutoff: r.cutoff,
    version: r.version ?? 0,
    rfc: r.rfc,
    legalName: r.legal_name,
    regime: r.regime,
    postalCode: r.postal_code,
    address: r.address ?? {},
  };
}

/** A complete issuer identity (RFC, legal name, régimen, postal code). */
export function fiscalComplete(f: FiscalFacts): boolean {
  return !!(f.rfc && f.legalName && f.regime && f.postalCode);
}

/**
 * Whether the shared sandbox organization's facts are whole: the RFC, régimen and postal code
 * Facturapi reported for it (LD-55 CFDIFIX-FISCAL-6).
 */
export function sharedIssuerComplete(shared: SharedIssuer | null): boolean {
  return !!(shared?.taxId && shared.regime && shared.postalCode);
}

/**
 * The issuer facts a stamp uses (LD-51 F3). An own organization stamps with the restaurant's
 * fiscal profile (legal data synced to Facturapi). In the shared sandbox the issuer is the
 * platform's test organization: its régimen and RFC decide the RESICO retention and its postal
 * code is LugarExpedicion (and DomicilioFiscalReceptor of a global), as Facturapi reports them.
 * Those facts are taken as a whole or not at all (LD-55 CFDIFIX-FISCAL-6): when the worker could
 * not read one of them, the restaurant's profile is used for all three, so the RESICO decision
 * and LugarExpedicion never mix two taxpayers (the panel says which one stamps).
 */
export function stampingFacts(
  facts: FiscalFacts,
  platformRow: PlatformRow | null,
  org: Pick<OrganizationRow, "source"> | null,
): FiscalFacts {
  const shared = platformRow?.sharedIssuer ?? null;
  if (org?.source !== "shared_sandbox" || !sharedIssuerComplete(shared))
    return facts;
  return {
    ...facts,
    rfc: shared!.taxId,
    regime: shared!.regime,
    postalCode: shared!.postalCode,
  };
}

// ---------------------------------------------------------------------------------------------
// Guards and status
// ---------------------------------------------------------------------------------------------

export type CfdiState = {
  platform: PlatformRow | null;
  settings: SettingsRow | null;
  organization: OrganizationRow | null;
};

/** Platform, settings and organization in one call (3 PK reads). */
export async function cfdiState(tx: Tx): Promise<CfdiState> {
  return {
    platform: await platform(tx),
    settings: await loadSettings(tx),
    organization: await loadOrganization(tx),
  };
}

export function available(p: PlatformRow | null): boolean {
  return !!p && p.provider !== "disabled";
}

/**
 * The common route guard (spec §4.7): cfdi_unavailable (no worker published a provider),
 * cfdi_disabled (no settings, or paused when needEnabled), cfdi_not_ready (organization not ready
 * when needReady).
 */
export function requireCfdi(
  state: CfdiState,
  o: { needEnabled?: boolean; needReady?: boolean } = {},
): asserts state is CfdiState & {
  platform: PlatformRow;
  settings: SettingsRow;
} {
  if (!available(state.platform))
    throw new DomainError("cfdi_unavailable", 409);
  if (!state.settings || (o.needEnabled && !state.settings.enabled))
    throw new DomainError("cfdi_disabled", 409);
  if (o.needReady && state.organization?.status !== "ready")
    throw new DomainError("cfdi_not_ready", 409);
}

/** GET /cfdi/status (session-free part): what buttons and the printed ticket block need. */
export async function statusView(
  tx: Tx,
  role: string | null,
): Promise<CfdiStatusView> {
  const [r] = await tx`
    select p.provider, p.global_grace_minutes,
      s.enabled, s.mode, s.self_invoice_enabled, s.self_invoice_policy, s.self_invoice_days,
      s.portal_reissue_global, s.global_periodicity, s.next_periodicity,
      s.next_periodicity_from::text as next_periodicity_from,
      s.next_self_invoice_policy, s.next_self_invoice_days, s.next_portal_reissue_global,
      s.next_self_invoice_from::text as next_self_invoice_from,
      s.version, o.status as org_status, rr.timezone, rr.cutoff
    from (select 1) one
    left join cfdi_platform p on p.id = 1
    left join cfdi_settings s on true
    left join cfdi_organizations o on true
    left join restaurants rr on rr.id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
  const provider: CfdiProvider = r?.provider ?? "disabled";
  const isAvailable = provider !== "disabled";
  const enabled = isAvailable && !!r?.enabled;
  const ready = enabled && r?.org_status === "ready";
  const timezone: string = r?.timezone ?? "America/Mexico_City";
  const cutoff: number = r?.cutoff ?? 0;
  // The terms in force today, and a change that waits (LD-55 CFDIFIX-FISCAL-5 / UX-4): a due one
  // is in force, as loadSettings resolves it.
  let terms: SelfInvoiceTerms | null = r?.mode
    ? {
        policy: r.self_invoice_policy,
        days: r.self_invoice_days,
        reissue: r.portal_reissue_global,
      }
    : null;
  let pending: PendingSelfInvoice | null = r?.next_self_invoice_from
    ? {
        policy: r.next_self_invoice_policy,
        days: r.next_self_invoice_days,
        reissue: r.next_portal_reissue_global,
        from: r.next_self_invoice_from,
      }
    : null;
  if (
    pending &&
    pending.from <= businessDate_(new Date().toISOString(), timezone, cutoff)
  ) {
    terms = pending;
    pending = null;
  }
  const globalBound: SelfInvoiceGlobalBound | null = r?.mode
    ? {
        globalPeriodicity: r.global_periodicity,
        nextPeriodicity: r.next_periodicity ?? null,
        nextPeriodicityFrom: r.next_periodicity_from ?? null,
        cutoff,
        graceMinutes: r.global_grace_minutes ?? DEFAULT_GLOBAL_GRACE_MINUTES,
      }
    : null;
  return {
    available: isAvailable,
    provider,
    enabled,
    mode: r?.mode ?? null,
    ready,
    canInvoice: ready && ["owner", "manager", "cashier"].includes(role ?? ""),
    selfInvoice:
      enabled && r?.self_invoice_enabled !== undefined && terms
        ? {
            enabled: r.self_invoice_enabled,
            policy: terms.policy,
            days: terms.days,
            // LD-51 F1: without the portal's global reissue, a ticket is self-invoiceable only
            // until its global is built; the receipt prints that bound offline from this.
            globalBound: terms.reissue ? null : globalBound,
            pending: pending
              ? {
                  policy: pending.policy,
                  days: pending.days,
                  globalBound: pending.reissue ? null : globalBound,
                  fromAt: businessDayStart(pending.from, timezone, cutoff),
                }
              : null,
          }
        : null,
    timezone,
    version: r?.version ?? 0,
  };
}

/**
 * Public ordering (wave 3, LD-18 / public-rebase): whether the restaurant offers self-invoicing on
 * its tickets (available && enabled && ready && self_invoice_enabled), and the certificate is
 * usable as the portal requires it (csdUsable, CFDI-UX-2), so a QR diner is never offered a link
 * the portal then refuses (CFDI-INT-4). One statement.
 */
export async function selfInvoiceOffered(tx: Tx): Promise<boolean> {
  const [r] = await tx`
    select exists(
      select 1 from cfdi_platform p, cfdi_settings s, cfdi_organizations o
      where p.id = 1 and p.provider <> 'disabled' and s.enabled and s.self_invoice_enabled
        and o.status = 'ready'
        and (o.source <> 'own' or (o.csd_status <> 'expired'
          and (o.csd_valid_until is null or o.csd_valid_until > now())
          and (s.mode = 'test' or o.csd_status = 'valid')))) as offered`;
  return !!r?.offered;
}

// ---------------------------------------------------------------------------------------------
// Events and claims
// ---------------------------------------------------------------------------------------------

export async function insertEvent(
  tx: Tx,
  tenantId: string,
  documentId: string | null,
  kind: string,
  detail: Record<string, unknown> = {},
  actorId: string | null = null,
): Promise<void> {
  await tx`
    insert into cfdi_events(tenant_id, id, document_id, kind, detail, actor_id)
    values (${tenantId}, gen_random_uuid(), ${documentId}, ${kind}, ${tx.json(detail as never)}, ${actorId})`;
}

export type CoverageClaim = {
  documentId: string;
  state: "pending" | "active";
  kind: "invoice" | "global" | "egreso";
  status: string;
  series: string | null;
  folioNumber: number | null;
  periodKey: string | null;
  createdBy: string | null;
  createdAt: string;
};

/** The ticket's open claims in a mode, with their documents' kind and status (one statement). */
export async function ticketCoverage(
  tx: Tx,
  ticketId: string,
  mode: CfdiMode,
): Promise<CoverageClaim[]> {
  const rows = await tx`
    select c.document_id, c.state, d.kind, d.status, d.series, d.folio_number, d.period_key,
      d.created_by, d.created_at
    from cfdi_document_tickets c
    join cfdi_documents d on d.tenant_id = c.tenant_id and d.id = c.document_id
    where c.ticket_id = ${ticketId} and c.mode = ${mode} and c.state <> 'released'
    order by c.created_at`;
  return rows.map((r) => ({
    documentId: r.document_id,
    state: r.state,
    kind: r.kind,
    status: r.status,
    series: r.series,
    folioNumber: r.folio_number,
    periodKey: r.period_key,
    createdBy: r.created_by,
    createdAt: iso(r.created_at)!,
  }));
}

/** Worker: releases a document's open claims (pending and active) with a reason. */
export async function releaseClaims(
  tx: Tx,
  documentId: string,
  reason: "failed" | "canceled" | "superseded" | "not_included",
  ticketIds?: string[],
): Promise<number> {
  const rows = await tx`
    update cfdi_document_tickets set state = 'released', released_reason = ${reason},
      released_at = now()
    where document_id = ${documentId} and state <> 'released'
      ${ticketIds ? tx`and ticket_id = any(${ticketIds}::uuid[])` : tx``}
    returning ticket_id`;
  return rows.length;
}

/**
 * Egreso statuses that relate a credit note to its parent at SAT, now or once it stamps. SAT
 * refuses to cancel a CFDI while a valid CFDI relates to it (spec §2.8 cfdi_has_credit_notes).
 */
const LIVE_CREDIT_NOTES = [
  "queued",
  "stamping",
  "pending",
  "valid",
  "canceling",
];

/**
 * Whether credit notes block the cancellation of a document. Every path that starts a
 * cancellation reads it under the document's key (the staff request, the late invoice's
 * reissue request, cfdi_cancel and cfdi_reissue before they call the provider), and cfdi_refund
 * creates a credit note only under that key with no cancellation open, so a cancellation and a
 * credit note of the same document never both start (CFDI-R3-2).
 */
export async function hasCreditNotes(
  tx: Tx,
  documentId: string,
): Promise<boolean> {
  const [r] = await tx`
    select 1 as one from cfdi_documents
    where parent_document_id = ${documentId} and kind = 'egreso'
      and status = any(${LIVE_CREDIT_NOTES}::text[])
    limit 1`;
  return !!r;
}

/**
 * The newest substitute of `documentId` that still waits for its ticket (pending claims), among
 * the given statuses. `valid` alone: the substitute a cancellation of the original hands the
 * ticket to (onCanceled, the motive-01 re-request). Every unfinished status: the substitute that
 * makes a second substitution refuse (CFDI-R3-1), so one sale never gets two valid substitutes.
 */
export async function waitingSubstitute(
  tx: Tx,
  documentId: string,
  statuses: readonly string[] = ["valid"],
): Promise<string | null> {
  // A valid substitute that is itself being canceled (an open cancellation of its own) is never
  // handed the ticket nor offered to a motive-01 re-request (CFDI-R4-1).
  const handOver = statuses.length === 1 && statuses[0] === "valid";
  const [r] = await tx`
    select d.id from cfdi_documents d
    where d.replaces_document_id = ${documentId} and d.status = any(${[...statuses]}::text[])
      and (d.kind = 'egreso' or exists (select 1 from cfdi_document_tickets c where c.tenant_id = d.tenant_id
        and c.document_id = d.id and c.state = 'pending'))
      ${
        handOver
          ? tx`and not exists (select 1 from cfdi_cancellations x where x.tenant_id = d.tenant_id
              and x.document_id = d.id and x.status in ('queued','requested'))`
          : tx``
      }
    order by d.created_at desc limit 1`;
  return (r?.id as string | undefined) ?? null;
}

/** Substitute statuses that are not final: the substitute may still become (or is) valid. */
export const UNFINISHED_SUBSTITUTE = [
  "waiting",
  "queued",
  "stamping",
  "pending",
  "valid",
  "canceling",
] as const;

/** Worker: pending claims of a document become active (substitution or reissue completed). */
export async function activatePendingClaims(
  tx: Tx,
  documentId: string,
): Promise<number> {
  const rows = await tx`
    update cfdi_document_tickets set state = 'active'
    where document_id = ${documentId} and state = 'pending'
    returning ticket_id`;
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

function documentRow(r: Record<string, any>): DocumentRow {
  return {
    id: r.id,
    kind: r.kind,
    source: r.source,
    mode: r.mode,
    status: r.status,
    dependsOn: r.depends_on,
    replacesDocumentId: r.replaces_document_id,
    parentDocumentId: r.parent_document_id,
    refundId: r.refund_id,
    receptor: r.receptor,
    receptorRfc: r.receptor_rfc,
    cardPaymentForm: r.card_payment_form,
    paymentFormOverride: r.payment_form_override ?? null,
    creditTicketId: r.credit_ticket_id ?? null,
    confirmPreStart: r.confirm_pre_start,
    periodKey: r.period_key,
    globalInfo: r.global_info,
    part: r.part,
    request: r.request,
    paymentForm: r.payment_form,
    cfdiUse: r.cfdi_use,
    series: r.series,
    nettedRefundIds: r.netted_refund_ids ?? [],
    expectedTotal: r.expected_total,
    expectedTax: r.expected_tax,
    expectedWithholding: r.expected_withholding ?? 0,
    conceptCount: r.concept_count,
    ticketCount: r.ticket_count,
    providerOrgId: r.provider_org_id,
    providerInvoiceId: r.provider_invoice_id,
    uuid: r.uuid,
    livemode: r.livemode,
    folioNumber: r.folio_number,
    total: r.total,
    subtotal: r.subtotal,
    tax: r.tax,
    withheld: r.withheld,
    amountCheck: r.amount_check,
    stampedAt: iso(r.stamped_at),
    verificationUrl: r.verification_url,
    emailedAt: iso(r.emailed_at),
    emailError: r.email_error,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    errorPath: r.error_path,
    attempts: r.attempts,
    createdBy: r.created_by,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

/** One document (RLS: this tenant); `forUpdate` locks the row (worker transitions). */
export async function loadDocument(
  tx: Tx,
  id: string,
  o: { forUpdate?: boolean } = {},
): Promise<DocumentRow | null> {
  const [r] = await tx`
    select * from cfdi_documents where id = ${id}
    ${o.forUpdate ? tx`for update` : tx``}`;
  return r ? documentRow(r) : null;
}

/** Stuck: queued or stamping with no change for 30 minutes (spec §4.7.1 status view rule). */
export const STUCK_MINUTES = 30;
export function isStuck(d: { status: string; updatedAt: string }): boolean {
  return (
    (d.status === "queued" || d.status === "stamping") &&
    Date.parse(d.updatedAt) < Date.now() - STUCK_MINUTES * 60_000
  );
}

const folioOf = (s: unknown, n: unknown) =>
  typeof s === "string" && n !== null && n !== undefined
    ? formatFolio(s, Number(n))
    : null;

type SummaryRow = Record<string, any>;

function summaryOf(r: SummaryRow): CfdiDocumentSummary {
  const d = documentRow(r);
  const first = folioOf(r.first_series, r.first_number);
  const last = folioOf(r.last_series, r.last_number);
  const folios = first
    ? last && last !== first
      ? [first, last]
      : [first]
    : [];
  return {
    id: d.id,
    kind: d.kind,
    source: d.source,
    mode: d.mode,
    status: d.status,
    createdAt: d.createdAt,
    series: d.series,
    folioNumber: d.folioNumber,
    uuid: d.uuid,
    stampedAt: d.stampedAt,
    receptorName:
      d.kind === "global"
        ? null
        : (d.receptor?.legalName ?? r.parent_receptor_name ?? null),
    receptorRfc:
      d.kind === "global"
        ? null
        : (d.receptorRfc ?? r.parent_receptor_rfc ?? null),
    total: d.total,
    expectedTotal: d.expectedTotal,
    ticketFolios: folios,
    ticketCount: Number(r.claim_count ?? 0),
    periodKey: d.periodKey,
    part: d.part,
    stuck: isStuck(d),
    late: !!r.late,
  };
}

/**
 * Summary rows with ticket folios (first and last by folio, of the document's claims or of its
 * parent's for a credit note), claim count and lateness. `where` filters cfdi_documents d.
 */
async function summaryRows(
  tx: Tx,
  where: ReturnType<Tx>,
  tail: ReturnType<Tx> = tx``,
): Promise<SummaryRow[]> {
  const folios = tx`
      (select t.series from cfdi_document_tickets c join fiscal_tickets t on t.tenant_id = c.tenant_id and t.id = c.ticket_id
        where c.tenant_id = d.tenant_id and c.document_id = coalesce(d.parent_document_id, d.id)
        order by t.series, t.number limit 1) as first_series,
      (select t.number from cfdi_document_tickets c join fiscal_tickets t on t.tenant_id = c.tenant_id and t.id = c.ticket_id
        where c.tenant_id = d.tenant_id and c.document_id = coalesce(d.parent_document_id, d.id)
        order by t.series, t.number limit 1) as first_number,
      (select t.series from cfdi_document_tickets c join fiscal_tickets t on t.tenant_id = c.tenant_id and t.id = c.ticket_id
        where c.tenant_id = d.tenant_id and c.document_id = coalesce(d.parent_document_id, d.id)
        order by t.series desc, t.number desc limit 1) as last_series,
      (select t.number from cfdi_document_tickets c join fiscal_tickets t on t.tenant_id = c.tenant_id and t.id = c.ticket_id
        where c.tenant_id = d.tenant_id and c.document_id = coalesce(d.parent_document_id, d.id)
        order by t.series desc, t.number desc limit 1) as last_number,`;
  return tx`
    select d.*, ${folios}
      to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_cursor,
      (select count(*) from cfdi_document_tickets c
        where c.tenant_id = d.tenant_id and c.document_id = coalesce(d.parent_document_id, d.id)) as claim_count,
      (select p.receptor->>'legalName' from cfdi_documents p where p.tenant_id = d.tenant_id and p.id = d.parent_document_id) as parent_receptor_name,
      (select p.receptor_rfc from cfdi_documents p where p.tenant_id = d.tenant_id and p.id = d.parent_document_id) as parent_receptor_rfc,
      (d.kind = 'global' and exists (select 1 from cfdi_global_periods g
        where g.tenant_id = d.tenant_id and g.mode = d.mode and g.period_key = d.period_key and d.created_at > g.due_at)) as late
    from cfdi_documents d
    where ${where}
    ${tail}`;
}

export async function documentSummaries(
  tx: Tx,
  ids: string[],
): Promise<CfdiDocumentSummary[]> {
  if (!ids.length) return [];
  const rows = await summaryRows(
    tx,
    tx`d.id = any(${ids}::uuid[])`,
    tx`order by d.created_at, d.id`,
  );
  return rows.map(summaryOf);
}

export type DocumentsQuery = {
  from: string;
  to: string;
  kind?: "invoice" | "global" | "egreso";
  status?: "open" | "valid" | "failed" | "canceled";
  q?: string;
  after?: string;
  limit: number;
  timezone: string;
  /** The restaurant's business-day cutoff (minutes after midnight). */
  cutoff: number;
};

/**
 * The register (spec §2.11): created in the business days `from`..`to` (the restaurant's cutoff,
 * like every other POS date: an invoice issued at 00:30 belongs to the day still open), filters,
 * search and a keyset cursor.
 */
export async function listDocuments(
  tx: Tx,
  q: DocumentsQuery,
): Promise<{ rows: CfdiDocumentSummary[]; next: string | null }> {
  const statuses: Record<NonNullable<DocumentsQuery["status"]>, string[]> = {
    open: ["waiting", "queued", "stamping", "pending", "canceling"],
    valid: ["valid"],
    failed: ["failed"],
    canceled: ["canceled"],
  };
  const [afterAt, afterId] = (q.after ?? "").split("|");
  const cursor =
    afterAt && afterId && /^[0-9a-f-]{36}$/.test(afterId)
      ? tx`and (d.created_at, d.id) < (${afterAt}::timestamptz, ${afterId}::uuid)`
      : tx``;
  const term = q.q?.trim() ?? "";
  const folioParts = /^([A-Z0-9]{1,10})-(\d{1,16})$/.exec(term.toUpperCase());
  const search = !term
    ? tx``
    : tx`and (
        d.receptor_rfc = ${term.toUpperCase()}
        or d.uuid::text = ${term.toLowerCase()}
        or (d.series || '-' || d.folio_number::text) = ${term.toUpperCase()}
        or exists (select 1 from cfdi_document_tickets c join fiscal_tickets t
          on t.tenant_id = c.tenant_id and t.id = c.ticket_id
          where c.tenant_id = d.tenant_id and c.document_id = coalesce(d.parent_document_id, d.id)
            and ${
              folioParts
                ? tx`t.series = ${folioParts[1]} and t.number = ${Number(folioParts[2])}`
                : /^\d{1,16}$/.test(term)
                  ? tx`t.series = '' and t.number = ${Number(term)}`
                  : tx`false`
            }))`;
  const rows = await summaryRows(
    tx,
    tx`d.created_at >= ${boundaries(q.from, q.timezone, q.cutoff).start}::timestamptz
      and d.created_at < ${boundaries(q.to, q.timezone, q.cutoff).end}::timestamptz
      ${q.kind ? tx`and d.kind = ${q.kind}` : tx``}
      ${q.status ? tx`and d.status = any(${statuses[q.status]}::text[])` : tx``}
      ${search} ${cursor}`,
    tx`order by d.created_at desc, d.id desc limit ${q.limit + 1}`,
  );
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  // The cursor keeps created_at's microseconds: a millisecond ISO string would skip rows created
  // within the same millisecond as the page's last row.
  return {
    rows: page.map(summaryOf),
    next:
      rows.length > q.limit && last
        ? `${last.created_cursor}|${last.id}`
        : null,
  };
}

export type Viewer = { role: string; employeeId: string };

/** The full document (detail modal); web only (joins employees for names). */
export async function documentView(
  tx: Tx,
  id: string,
  viewer: Viewer | null,
): Promise<CfdiDocumentView> {
  const [row] = await summaryRows(tx, tx`d.id = ${id}`);
  if (!row) throw new DomainError("not_found", 404);
  const d = documentRow(row);
  const summary = summaryOf(row);
  const [extra] = await tx`
    select
      (select e.name from employees e where e.tenant_id = ${row.tenant_id} and e.id = ${d.createdBy}) as created_by_name,
      (select r.id from cfdi_documents r where r.replaces_document_id = ${id} order by r.created_at desc limit 1) as replaced_by,
      coalesce((select jsonb_agg(c.id order by c.created_at) from cfdi_documents c
        where c.parent_document_id = ${id} and c.kind = 'egreso'), '[]') as credit_notes,
      coalesce((select jsonb_agg(c.id) from cfdi_documents c
        where c.parent_document_id = ${id} and c.kind = 'egreso' and c.status in ('queued','stamping','pending','valid','canceling')), '[]') as active_credit_notes,
      (select s.id from cfdi_documents s where s.replaces_document_id = ${id} and s.status = 'valid'
        and (s.kind = 'egreso' or exists (select 1 from cfdi_document_tickets c where c.tenant_id = s.tenant_id
          and c.document_id = s.id and c.state = 'pending'))
        and not exists (select 1 from cfdi_cancellations x where x.tenant_id = s.tenant_id
          and x.document_id = s.id and x.status in ('queued','requested'))
        order by s.created_at desc limit 1) as waiting_substitute,
      exists (select 1 from cfdi_cancellations x where x.substitute_document_id = ${id}
        and x.status in ('queued','requested')) as substitution_open,
      exists (select 1 from cfdi_documents s where s.replaces_document_id = ${id}
        and s.status = any(${[...UNFINISHED_SUBSTITUTE]}::text[])
        and (s.kind = 'egreso' or exists (select 1 from cfdi_document_tickets c where c.tenant_id = s.tenant_id
          and c.document_id = s.id and c.state = 'pending'))) as substitute_unfinished,
      (select p.rfc from restaurant_fiscal_profiles p where p.tenant_id = ${row.tenant_id}) as issuer_rfc,
      (select r.timezone from restaurants r where r.id = ${row.tenant_id}) as timezone,
      -- A ticket of this document is from before the mode's start: no global covers it.
      exists (select 1 from cfdi_document_tickets c
        join fiscal_tickets t on t.tenant_id = c.tenant_id and t.id = c.ticket_id
        join cfdi_settings s on s.tenant_id = c.tenant_id
        where c.document_id = ${id} and c.state <> 'released'
          and t.business_date < (case when ${d.mode} = 'live' then coalesce(s.live_from, s.test_from)
                                 else s.test_from end)) as pre_start,
      -- A credit note's parent is still valid with no cancellation open: it can be corrected.
      exists (select 1 from cfdi_documents p where p.id = ${d.parentDocumentId} and p.status = 'valid'
        and not exists (select 1 from cfdi_cancellations x where x.tenant_id = p.tenant_id
          and x.document_id = p.id and x.status in ('queued','requested'))) as parent_valid,
      (select to_jsonb(x) from (select motive, status, reason, created_at, processed_at, substitute_document_id, error_code
        from cfdi_cancellations where document_id = ${id} order by created_at desc limit 1) x) as cancellation,
      coalesce((select jsonb_agg(f.format order by f.format) from cfdi_files f where f.document_id = ${id}), '[]') as files,
      coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'at', e.created_at, 'detail', e.detail) order by e.created_at, e.id)
        from cfdi_events e where e.document_id = ${id}), '[]') as events`;
  const cancellation = extra.cancellation as {
    motive: string;
    status: string;
    reason: string;
    created_at: string;
    processed_at: string | null;
    substitute_document_id: string | null;
    error_code: string | null;
  } | null;
  const openCancellation =
    cancellation &&
    (cancellation.status === "queued" || cancellation.status === "requested");
  const manager = !!viewer && ["owner", "manager"].includes(viewer.role);
  const owner = viewer?.role === "owner";
  const creatorRecent =
    !!viewer &&
    d.createdBy === viewer.employeeId &&
    Date.parse(d.createdAt) > Date.now() - 24 * 3600_000;
  const valid = d.status === "valid";
  // CFF art. 29-A (CFDI-SAT-3): no cancellation (nor substitution, which ends in one) after the
  // month the annual return of the CFDI's year is due.
  const cancelDeadline = d.stampedAt
    ? cancellationDeadline(
        d.stampedAt,
        extra.issuer_rfc ?? null,
        extra.timezone ?? "America/Mexico_City",
      )
    : null;
  const inTime = !cancelDeadline || Date.now() < Date.parse(cancelDeadline);
  // A substitute named by its original's open motive-01 cancellation waits for that to end
  // (CFDI-R4-1): canceling it would leave the original's cancellation without a substitute.
  const actionable =
    valid &&
    inTime &&
    !openCancellation &&
    !extra.substitution_open &&
    (d.kind === "global" ? owner : manager);
  // A credit note is never canceled with motive 02/03 (CFDI-MONEY-1, SAT-2): it is corrected by a
  // substitute credit note (relation 04) and then canceled with motive 01.
  const creditNotesBlock =
    actionable &&
    d.kind !== "egreso" &&
    (extra.active_credit_notes as string[]).length > 0;
  const canCancel = actionable && d.kind !== "egreso" && !creditNotesBlock;
  // A valid substitute still waiting for the ticket (a credit note's: still live next to it)
  // while no cancellation of this document is open (rejected, expired or refused by the
  // provider): two valid CFDIs for one sale (CFDI-R3-1). The same condition as attention()'s.
  const waitingSubstituteId: string | null =
    openCancellation || !valid ? null : (extra.waiting_substitute ?? null);
  return {
    ...summary,
    receptor: d.receptor,
    paymentForm: d.paymentForm ?? (d.cardPaymentForm || null),
    use: d.cfdiUse ?? d.receptor?.use ?? null,
    verificationUrl: d.verificationUrl,
    global: d.globalInfo,
    expectedTax: d.expectedTax,
    tax: d.tax,
    withheld: d.withheld,
    amountCheck: d.amountCheck,
    parentDocumentId: d.parentDocumentId,
    refundId: d.refundId,
    replacesDocumentId: d.replacesDocumentId,
    replacedByDocumentId: extra.replaced_by ?? null,
    creditNotes: extra.credit_notes,
    cancellation: cancellation
      ? {
          motive: cancellation.motive,
          status: cancellation.status,
          reason: cancellation.reason,
          requestedAt: iso(cancellation.created_at)!,
          processedAt: iso(cancellation.processed_at),
          substituteDocumentId: cancellation.substitute_document_id,
          errorCode: cancellation.error_code,
        }
      : null,
    error: d.errorCode
      ? { code: d.errorCode, message: d.errorMessage, path: d.errorPath }
      : null,
    emailedAt: d.emailedAt,
    emailError: d.emailError,
    files: extra.files as CfdiDocumentFile[],
    events: (
      extra.events as {
        kind: string;
        at: string;
        detail: Record<string, unknown>;
      }[]
    ).map((e) => ({ kind: e.kind, at: iso(e.at)!, detail: e.detail })),
    createdByName: extra.created_by_name ?? null,
    waitingSubstituteId,
    preStart: !!extra.pre_start,
    cancelDeadline,
    creditNotesBlock,
    canCancel,
    canSubstitute:
      (d.kind === "invoice" && canCancel && !extra.substitute_unfinished) ||
      (d.kind === "egreso" &&
        actionable &&
        !!extra.parent_valid &&
        !extra.substitute_unfinished),
    canRequestAgain:
      actionable &&
      d.kind !== "global" &&
      (extra.active_credit_notes as string[]).length === 0 &&
      !!waitingSubstituteId,
    canRetry:
      manager &&
      (summary.stuck ||
        (d.status === "failed" &&
          (d.kind === "global" || d.kind === "egreso"))),
    canEmail:
      valid &&
      d.kind !== "global" &&
      (manager || (viewer?.role === "cashier" && creatorRecent)),
  };
}

/** What the public portal may show about a document: status, masked receptor, no amounts. */
export function portalStatus(
  d: DocumentRow,
  downloadToken: string | null,
  filesReady = false,
): PortalDocumentStatus {
  const status = (
    ["waiting"].includes(d.status)
      ? "queued"
      : d.status === "canceling"
        ? "valid"
        : d.status
  ) as PortalDocumentStatus["status"];
  return {
    status,
    series: d.series,
    folioNumber: d.folioNumber,
    uuid: d.uuid,
    stampedAt: d.stampedAt,
    emailMasked: maskEmail(d.receptor?.email ?? null),
    rfcMasked: maskRfc(d.receptorRfc ?? ""),
    error: d.errorCode
      ? { code: d.errorCode, message: d.errorMessage, path: d.errorPath }
      : null,
    downloadToken: status === "valid" ? downloadToken : null,
    filesReady: status === "valid" && filesReady,
  };
}

/** Whether the document's PDF and XML are stored (cfdi_deliver ran). */
export async function filesStored(
  tx: Tx,
  documentId: string,
): Promise<boolean> {
  const [r] = await tx`
    select count(*)::int as n from cfdi_files where document_id = ${documentId}
      and format in ('pdf','xml')`;
  return r?.n === 2;
}

/**
 * The restaurant's own certificate can stamp (CFDI-UX-2): never one past its end date (a refresh
 * may not have marked it expired yet), and in live mode only a valid one; test-mode stamps need no
 * certificate of the restaurant's. The portal offers self-invoicing only then.
 */
export function csdUsable(
  o: OrganizationRow | null,
  mode: CfdiMode,
  now = Date.now(),
): boolean {
  if (!o || o.source !== "own") return true;
  if (o.csdStatus === "expired") return false;
  if (o.csdValidUntil && Date.parse(o.csdValidUntil) <= now) return false;
  return mode === "test" || o.csdStatus === "valid";
}

// ---------------------------------------------------------------------------------------------
// Tickets and eligibility
// ---------------------------------------------------------------------------------------------

export type TicketFacts = {
  payload: CfdiTicketPayload;
  refunded: number;
  net: number;
  coverage: CoverageClaim[];
};

/** Whether a ticket exists in this tenant (before calling fiscal's reader). */
export async function ticketExists(tx: Tx, ticketId: string): Promise<boolean> {
  const [r] =
    await tx`select 1 as one from fiscal_tickets where id = ${ticketId}`;
  return !!r;
}

/** The ticket's fiscal payload (fiscal's ticketForCfdi), refunds so far and coverage in a mode. */
export async function ticketFacts(
  tx: Tx,
  ticketId: string,
  mode: CfdiMode,
): Promise<TicketFacts> {
  if (!(await ticketExists(tx, ticketId)))
    throw new DomainError("cfdi_ticket_not_found", 404);
  const payload = await ticketForCfdi(tx, ticketId);
  const refunded = payload.refunds
    .flatMap((r) => r.groups)
    .reduce((s, g) => s + g.gross, 0);
  return {
    payload,
    refunded,
    net: payload.ticket.gross - refunded,
    coverage: await ticketCoverage(tx, ticketId, mode),
  };
}

/** Ticket id by folio ("A-000123", "123"). */
export async function ticketIdByFolio(
  tx: Tx,
  folio: { series: string; number: number },
): Promise<string | null> {
  const [r] = await tx`
    select id from fiscal_tickets where series = ${folio.series} and number = ${folio.number}`;
  return r?.id ?? null;
}

/**
 * Eligibility of a ticket for a nominative invoice (spec §4.7.1 step 5 order). A global under
 * reissue (canceling with motive 04) still reads as in_global, so later requests join that
 * reissue. The portal's deadline ("expired") is applied by its callers with the restaurant
 * timezone (ticketView, the portal submission).
 */
export function eligibility(
  t: TicketFacts,
  s: { settings: SettingsRow | null; organization: OrganizationRow | null },
): TicketEligibility {
  if (!s.settings || !s.settings.enabled) return "disabled";
  if (s.organization?.status !== "ready") return "not_ready";
  const invoice = t.coverage.find((c) => c.kind === "invoice");
  // An invoice whose cancellation waits for the receptor is still the ticket's CFDI (CFDI-UX-9).
  if (invoice)
    return t.coverage.some(
      (c) =>
        c.kind === "invoice" &&
        (c.status === "valid" || c.status === "canceling"),
    )
      ? "invoiced"
      : "invoicing";
  const global = t.coverage.find(
    (c) => c.kind === "global" && c.state === "active",
  );
  if (global)
    return global.status === "valid" || global.status === "canceling"
      ? "in_global"
      : "global_in_progress";
  if (t.net <= 0) return "fully_refunded";
  if (t.payload.ticket.businessDate < modeFrom(s.settings))
    return "before_start";
  return "available";
}

/**
 * The self-invoicing deadline of a ticket, or null when self-invoicing is off (LD-51 F1): the
 * policy deadline, or the moment its global is built when that comes first and the portal does
 * not reissue globals (portal_reissue_global off). The period row's close is used when the tick
 * created it (a row keeps its periodicity after a later change); otherwise the periodicity in force
 * on the ticket's date. A ticket before the mode's start belongs to no global: the policy alone.
 */
export async function ticketDeadline(
  tx: Tx,
  t: TicketFacts,
  state: Pick<CfdiState, "settings" | "platform">,
  facts: Pick<FiscalFacts, "timezone" | "cutoff">,
): Promise<string | null> {
  return (await ticketDeadlineInfo(tx, t, state, facts))?.deadline ?? null;
}

/**
 * The instant each business date's global is built (LD-51 F1): its period row's close + grace when
 * the tick created the row (a row keeps its periodicity after a later change), otherwise the
 * periodicity in force on the date. A row of the current month left by a periodicity that applied
 * at once is replaced by the tick's rebuild (LD-51 F2): the periodicity in force decides until
 * then. Dates before the mode's start belong to no global and are left out. One read.
 */
export async function globalBuildTimes(
  tx: Tx,
  s: SettingsRow,
  dates: readonly string[],
  facts: Pick<FiscalFacts, "timezone" | "cutoff">,
  grace: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const covered = [...new Set(dates)].filter((d) => d >= modeFrom(s)).sort();
  if (!covered.length) return out;
  const rows = await tx`
    select closes_at, periodicity, date_from::text as from_date, date_to::text as to_date
    from cfdi_global_periods
    where mode = ${s.mode} and date_to >= ${covered[0]}::date
      and date_from <= ${covered[covered.length - 1]}::date`;
  const today = businessDate_(
    new Date().toISOString(),
    facts.timezone,
    facts.cutoff,
  );
  for (const date of covered) {
    const found = rows.find(
      (r) => r.from_date <= date && r.to_date >= date,
    );
    const row =
      found &&
      !(
        found.from_date >= today.slice(0, 8) + "01" &&
        found.periodicity !== periodicityOn(found.from_date, s)
      )
        ? found
        : null;
    out.set(
      date,
      row
        ? new Date(
            new Date(row.closes_at).getTime() + grace * 60_000,
          ).toISOString()
        : globalBuildAt(
            date,
            {
              globalPeriodicity: s.globalPeriodicity,
              nextPeriodicity: s.nextPeriodicity,
              nextPeriodicityFrom: s.nextPeriodicityFrom,
              cutoff: facts.cutoff,
              graceMinutes: grace,
            },
            facts.timezone,
          ),
    );
  }
  return out;
}

/**
 * The self-invoicing deadline of a business date under settings `s` (the terms in force and the
 * change that waits, LD-55), given its global's build time (globalBuildTimes; absent for a date
 * before the mode's start, which belongs to no global).
 */
export function deadlineOf(
  businessDate: string,
  s: Pick<
    SettingsRow,
    | "selfInvoicePolicy"
    | "selfInvoiceDays"
    | "portalReissueGlobal"
    | "nextSelfInvoice"
  >,
  globalAt: string | undefined,
  facts: Pick<FiscalFacts, "timezone" | "cutoff">,
): { deadline: string; bound: "policy" | "global" } {
  const next = s.nextSelfInvoice;
  return effectiveSelfInvoiceDeadline(businessDate, {
    policy: s.selfInvoicePolicy,
    days: s.selfInvoiceDays,
    timezone: facts.timezone,
    global: !s.portalReissueGlobal && globalAt ? { globalAt } : null,
    pending: next
      ? {
          policy: next.policy,
          days: next.days,
          global: !next.reissue && globalAt ? { globalAt } : null,
          fromAt: businessDayStart(next.from, facts.timezone, facts.cutoff),
        }
      : null,
  });
}

/** ticketDeadline with what ended it: the policy, or the ticket's global (LD-51 F1). */
export async function ticketDeadlineInfo(
  tx: Tx,
  t: TicketFacts,
  state: Pick<CfdiState, "settings" | "platform">,
  facts: Pick<FiscalFacts, "timezone" | "cutoff">,
): Promise<{ deadline: string; bound: "policy" | "global" } | null> {
  const s = state.settings;
  if (!s || !s.selfInvoiceEnabled) return null;
  const businessDate = t.payload.ticket.businessDate;
  const needsGlobal =
    !s.portalReissueGlobal ||
    (!!s.nextSelfInvoice && !s.nextSelfInvoice.reissue);
  const builds = needsGlobal
    ? await globalBuildTimes(
        tx,
        s,
        [businessDate],
        facts,
        graceMinutes(state.platform),
      )
    : new Map<string, string>();
  return deadlineOf(businessDate, s, builds.get(businessDate), facts);
}

/**
 * When a self-invoicing change (window, days or portal reissue) may apply (LD-55
 * CFDIFIX-FISCAL-5 / UX-4, guarded like a periodicity change): null when it brings forward no
 * deadline a receipt already printed (every ticket not covered by a valid or canceling invoice,
 * fully refunded ones aside, whose current deadline has not passed: unclaimed tickets, tickets in a
 * global the portal may reissue, tickets whose invoice is still on its way and may fail); otherwise
 * the business date from which it applies: the first business day starting at or after the latest
 * deadline it would bring forward (the first of next month for the default month-end window). The
 * current deadline is the one receipts print: the terms in force with any change that already
 * waits. One read per distinct business date set plus the period rows.
 */
export async function selfInvoiceChangeFrom(
  tx: Tx,
  s: SettingsRow,
  wanted: SelfInvoiceTerms,
  facts: Pick<FiscalFacts, "timezone" | "cutoff">,
  grace: number,
  now = new Date(),
): Promise<string | null> {
  const today = businessDate_(now.toISOString(), facts.timezone, facts.cutoff);
  // Deadlines run at most 90 days (policy "days") or to the month's end: 100 days back covers both.
  const rows = await tx`
    select distinct t.business_date::text as d from fiscal_tickets t
    where t.business_date >= (${today}::date - 100)
      and not exists (select 1 from cfdi_document_tickets c
        join cfdi_documents x on x.tenant_id = c.tenant_id and x.id = c.document_id
        where c.tenant_id = t.tenant_id and c.ticket_id = t.id and c.mode = ${s.mode}
          and c.state <> 'released' and x.kind = 'invoice' and x.status in ('valid','canceling'))
      and t.gross > coalesce((select sum(a.gross) from fiscal_adjustments a
        where a.tenant_id = t.tenant_id and a.order_id = t.order_id), 0)
    order by 1`;
  const dates = rows.map((r) => r.d as string);
  if (!dates.length) return null;
  const builds = await globalBuildTimes(tx, s, dates, facts, grace);
  const target = {
    selfInvoicePolicy: wanted.policy,
    selfInvoiceDays: wanted.days,
    portalReissueGlobal: wanted.reissue,
    nextSelfInvoice: null,
  };
  let latest: number | null = null;
  for (const date of dates) {
    const printed = Date.parse(
      deadlineOf(date, s, builds.get(date), facts).deadline,
    );
    if (printed <= now.getTime()) continue;
    const after = Date.parse(
      deadlineOf(date, target, builds.get(date), facts).deadline,
    );
    if (after < printed && (latest === null || printed > latest))
      latest = printed;
  }
  if (latest === null) return null;
  const from = changeFromDeadline(
    new Date(latest).toISOString(),
    facts.timezone,
    facts.cutoff,
  );
  return from > today ? from : firstAfter(today);
}

const firstAfter = (date: string) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** The ticket view shared by staff (documents listed) and the portal (documents omitted). */
export async function ticketView(
  tx: Tx,
  t: TicketFacts,
  state: CfdiState,
  facts: FiscalFacts,
  o: { viewer: Viewer | null; portal: boolean; now?: Date },
): Promise<CfdiTicketView> {
  const settings = state.settings;
  const now = o.now ?? new Date();
  const window = await ticketDeadlineInfo(tx, t, state, facts);
  const deadline = window?.deadline ?? null;
  let status = eligibility(t, state);
  if (
    o.portal &&
    (status === "available" || status === "in_global") &&
    !csdUsable(state.organization, settings?.mode ?? "test", now.getTime())
  )
    status = "not_ready";
  // The portal's deadline applies to a ticket it could reissue from a global too (CFDI-UX-10).
  if (
    o.portal &&
    (status === "available" ||
      (status === "in_global" && !!settings?.portalReissueGlobal)) &&
    deadline &&
    Date.parse(deadline) < now.getTime()
  )
    status = "expired";
  const covering =
    t.coverage.find(
      (c) =>
        c.kind === "invoice" &&
        (c.status === "valid" || c.status === "canceling"),
    ) ??
    t.coverage.find((c) => c.kind === "invoice") ??
    t.coverage.find((c) => c.kind === "global" && c.state === "active") ??
    null;
  // Spec §2.13: managers see every document of the ticket; a cashier only the documents they
  // created in the last 24 hours (the same rule as GET /cfdi/documents/:id), so no receptor name
  // or RFC reaches a cashier through the ticket (CFDI-R9).
  const manager = !!o.viewer && ["owner", "manager"].includes(o.viewer.role);
  const recentOwn = (createdBy: string | null, createdAt: string) =>
    !!o.viewer &&
    createdBy === o.viewer.employeeId &&
    Date.parse(createdAt) > now.getTime() - 24 * 3600_000;
  const documents = o.portal
    ? []
    : await documentSummaries(
        tx,
        (
          await tx`
            select distinct d.id from cfdi_documents d
            where (d.id in (select c.document_id from cfdi_document_tickets c where c.ticket_id = ${t.payload.ticket.id})
               or d.parent_document_id in (select c.document_id from cfdi_document_tickets c where c.ticket_id = ${t.payload.ticket.id}))
              ${
                manager
                  ? tx``
                  : tx`and d.created_by = ${o.viewer?.employeeId ?? null}
                       and d.created_at > ${new Date(now.getTime() - 24 * 3600_000)}`
              }`
        ).map((r) => r.id as string),
      );
  const issuer = t.payload.ticket.issuer;
  const reissue = await reissueRoute(tx, t, facts);
  return {
    ticketId: t.payload.ticket.id,
    orderId: t.payload.ticket.orderId,
    folio: t.payload.ticket.folio,
    issuedAt: t.payload.ticket.issuedAt,
    businessDate: t.payload.ticket.businessDate,
    currency: "MXN",
    originalTotal: t.payload.ticket.gross,
    refunded: t.refunded,
    total: Math.max(0, t.net),
    tradeName: issuer?.tradeName ?? facts.tradeName,
    issuerLegalName:
      state.organization?.source === "shared_sandbox"
        ? null
        : (issuer?.legalName ?? facts.legalName),
    issuerRfc:
      state.organization?.source === "shared_sandbox"
        ? null
        : (issuer?.rfc ?? facts.rfc),
    mode: settings?.mode ?? "test",
    eligibility: status,
    deadline,
    deadlineBound: window?.bound ?? null,
    needsCardForm: needsCardForm(t.payload.payments),
    cardPaymentForm: settings?.cardPaymentForm ?? "04",
    defaultUse: settings?.defaultUse ?? "G03",
    covering: covering
      ? {
          documentId: covering.documentId,
          kind: covering.kind === "global" ? "global" : "invoice",
          status: covering.status,
          label:
            covering.kind === "global"
              ? (covering.periodKey ?? "")
              : (docLabel(covering.series, covering.folioNumber) ?? ""),
          periodKey: covering.periodKey,
          canOpen:
            !o.portal &&
            (manager || recentOwn(covering.createdBy, covering.createdAt)),
        }
      : null,
    reissueAllowed: o.portal
      ? !!settings?.portalReissueGlobal
      : !!o.viewer && ["owner", "manager"].includes(o.viewer.role),
    reissueRoute: reissue?.route ?? null,
    reissueReason: reissue?.reason ?? null,
    documents,
  };
}

/**
 * How a ticket in a global gets its nominative invoice. "cancel": the global is canceled with
 * motive 04 and replaced without the ticket (SAT cancellation FAQ Q10). "credit_note": a credit
 * note to the global for the ticket's net amount, then the invoice (Guía de llenado del CFDI
 * global, Apéndice 2, III), whenever SAT would refuse that cancellation: past the global's CFF
 * art. 29-A deadline (`deadline`, CFDI-SAT-3), or while a credit note relates to the global and no
 * cancellation of it is open (`credit_notes`): SAT refuses to cancel a CFDI that a valid CFDI
 * relates to, and a credit note is never canceled on its own (LD-33 MONEY-1), so a refund
 * credited against a global must not stop the other tickets of its period from being invoiced
 * (CFDI-INT-1). createInvoiceRequest decides with this under the global's document key, the key
 * cfdi_refund creates credit notes under; the ticket view shows the same answer.
 */
export async function globalRoute(
  tx: Tx,
  globalId: string,
  facts: Pick<FiscalFacts, "rfc" | "timezone">,
): Promise<{
  route: "cancel" | "credit_note";
  reason: "deadline" | "credit_notes" | null;
}> {
  const [g] = await tx`
    select d.stamped_at,
      exists (select 1 from cfdi_cancellations x where x.tenant_id = d.tenant_id
        and x.document_id = d.id and x.status in ('queued','requested')) as canceling
    from cfdi_documents d where d.id = ${globalId}`;
  const stampedAt = g?.stamped_at ? iso(g.stamped_at) : null;
  if (!cancellationAllowed(stampedAt, facts.rfc, facts.timezone))
    return { route: "credit_note", reason: "deadline" };
  if (g && !g.canceling && (await hasCreditNotes(tx, globalId)))
    return { route: "credit_note", reason: "credit_notes" };
  return { route: "cancel", reason: null };
}

/** globalRoute for the ticket's valid global; null when the ticket is in no valid global. */
export async function reissueRoute(
  tx: Tx,
  t: TicketFacts,
  facts: Pick<FiscalFacts, "rfc" | "timezone">,
): Promise<Awaited<ReturnType<typeof globalRoute>> | null> {
  const g = t.coverage.find((c) => c.kind === "global" && c.state === "active");
  if (!g || !["valid", "canceling"].includes(g.status)) return null;
  return globalRoute(tx, g.documentId, facts);
}

// ---------------------------------------------------------------------------------------------
// Attention, alerts, coverage and periods
// ---------------------------------------------------------------------------------------------

/**
 * SQL predicate over a period row aliased `g`: the period has a ticket of its dates, on or after
 * `from` (the mode's start), with a net amount left and no live claim in the period's mode. A
 * closed period that has one is due (CFDI-MONEY-2, SAT-1): a cancellation released it, an
 * offline sale synced late, or a repair issued it after the build.
 */
export function unclaimedTickets(tx: Tx, from: ReturnType<Tx>) {
  return tx`exists (select 1 from fiscal_tickets t where t.tenant_id = g.tenant_id
    and t.business_date between g.date_from and g.date_to and t.business_date >= ${from}
    and not exists (select 1 from cfdi_document_tickets c where c.tenant_id = t.tenant_id
      and c.ticket_id = t.id and c.mode = g.mode and c.state <> 'released')
    and t.gross > coalesce((select sum(a.gross) from fiscal_adjustments a
      where a.tenant_id = t.tenant_id and a.order_id = t.order_id), 0))`;
}

/** Counts for the panel badge, Today and the worker's alerts (one statement). */
export async function attention(tx: Tx): Promise<CfdiAlertsView> {
  const [r] = await tx`
    select s.mode,
      (select count(*) from cfdi_global_periods g where g.mode = s.mode
        and ((g.due_at < now() and (g.status = 'open'
               or exists (select 1 from cfdi_documents d where d.tenant_id = g.tenant_id and d.mode = g.mode
                   and d.kind = 'global' and d.period_key = g.period_key
                   and d.status in ('queued','stamping','pending'))
               or ${unclaimedTickets(
                 tx,
                 tx`(case when s.mode = 'live' then coalesce(s.live_from, s.test_from) else s.test_from end)`,
               )}))
          or exists (select 1 from cfdi_documents d where d.tenant_id = g.tenant_id and d.mode = g.mode
                   and d.kind = 'global' and d.period_key = g.period_key and d.status = 'failed'
                   and not exists (select 1 from cfdi_documents n where n.tenant_id = d.tenant_id and n.mode = d.mode
                     and n.kind = 'global' and n.period_key = d.period_key and n.part > d.part)))) as overdue,
      (select count(*) from cfdi_documents d where d.status = 'failed'
        and d.created_at > now() - interval '30 days'
        and ((d.kind in ('global','egreso')
          and not exists (select 1 from cfdi_documents n where n.tenant_id = d.tenant_id and n.mode = d.mode
            and ((d.kind = 'global' and n.kind = 'global' and n.period_key = d.period_key and n.part > d.part)
              or (d.kind = 'egreso' and n.kind = 'egreso' and n.refund_id = d.refund_id and n.created_at > d.created_at))))
          -- A customer's portal invoice that failed after they left (CFDI-UX-3): until a newer
          -- document of that ticket exists, the restaurant sees it.
          or (d.kind = 'invoice' and d.source = 'portal'
            and not exists (select 1 from cfdi_document_tickets c
              join cfdi_document_tickets c2 on c2.tenant_id = c.tenant_id and c2.ticket_id = c.ticket_id
                and c2.mode = c.mode
              join cfdi_documents n on n.tenant_id = c2.tenant_id and n.id = c2.document_id
              where c.tenant_id = d.tenant_id and c.document_id = d.id and n.created_at > d.created_at)))) as failed,
      (select count(*) from cfdi_documents d where d.status in ('queued','stamping')
        and d.updated_at < now() - interval '30 minutes') as stuck,
      -- Valid substitutes still waiting for their ticket while the original has no open
      -- cancellation: rejected, expired or refused by the provider, whatever came after
      -- (CFDI-R3-1). Never clears while two valid CFDIs exist for one sale.
      (select count(*) from cfdi_documents s where s.status = 'valid'
        and s.replaces_document_id is not null
        and ((s.kind = 'invoice' and exists (select 1 from cfdi_document_tickets c where c.tenant_id = s.tenant_id
              and c.document_id = s.id and c.state = 'pending'))
          or (s.kind = 'egreso' and exists (select 1 from cfdi_documents o where o.tenant_id = s.tenant_id
              and o.id = s.replaces_document_id and o.status = 'valid')))
        and not exists (select 1 from cfdi_cancellations x where x.tenant_id = s.tenant_id
          and x.document_id = s.replaces_document_id and x.status in ('queued','requested'))) as rejected,
      exists (select 1 from cfdi_organizations o where o.csd_status = 'valid'
        and o.csd_valid_until < now() + interval '30 days') as csd_soon
    from cfdi_settings s`;
  if (!r)
    return {
      overdueGlobals: 0,
      failedDocuments: 0,
      stuckDocuments: 0,
      rejectedSubstitutions: 0,
      csdExpiresSoon: false,
      mode: null,
    };
  return {
    overdueGlobals: Number(r.overdue),
    failedDocuments: Number(r.failed),
    stuckDocuments: Number(r.stuck),
    rejectedSubstitutions: Number(r.rejected),
    csdExpiresSoon: !!r.csd_soon,
    mode: r.mode,
  };
}

export function attentionOf(a: CfdiAlertsView): CfdiAttention {
  return {
    overdueGlobals: a.overdueGlobals,
    failedDocuments: a.failedDocuments,
    stuckDocuments: a.stuckDocuments,
    rejectedSubstitutions: a.rejectedSubstitutions,
    csdExpiresSoon: a.csdExpiresSoon,
  };
}

/** The global-period register (spec §2.10) for a business-date range in one mode. */
export async function periodViews(
  tx: Tx,
  q: {
    from: string;
    to: string;
    mode: CfdiMode;
    canRun: boolean;
    globalAuto: boolean;
    /** The mode's start date (modeFrom): tickets before it belong to no period. */
    modeFrom: string;
  },
): Promise<GlobalPeriodView[]> {
  // The period's eligible tickets in no CFDI yet, with fiscal's net figures (ticket less its
  // refund adjustments): an open or "Por emitir" period counts the tickets it will take (LD-51 F11).
  const rows = await tx`
    select g.*, g.date_from::text as from_date, g.date_to::text as to_date,
      (select jsonb_build_object('n', count(*), 'gross', coalesce(sum(x.net), 0), 'tax', coalesce(sum(x.tax), 0))
        from (select t.gross - coalesce(a.gross, 0) as net, t.tax - coalesce(a.tax, 0) as tax
          from fiscal_tickets t
          left join lateral (select sum(f.gross) as gross, sum(f.tax) as tax from fiscal_adjustments f
            where f.tenant_id = t.tenant_id and f.order_id = t.order_id) a on true
          where t.tenant_id = g.tenant_id and t.business_date between g.date_from and g.date_to
            and t.business_date >= ${q.modeFrom}::date
            and not exists (select 1 from cfdi_document_tickets c where c.tenant_id = t.tenant_id
              and c.ticket_id = t.id and c.mode = g.mode and c.state <> 'released')) x
        where x.net > 0) as pending,
      coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'part', d.part, 'status', d.status,
          'uuid', d.uuid, 'late', d.created_at > g.due_at, 'total', coalesce(d.total, d.expected_total, 0),
          'tax', coalesce(d.tax, d.expected_tax, 0), 'tickets', d.ticket_count) order by d.part)
        from cfdi_documents d where d.tenant_id = g.tenant_id and d.mode = g.mode and d.kind = 'global'
          and d.period_key = g.period_key), '[]') as docs
    from cfdi_global_periods g
    where g.mode = ${q.mode} and g.date_to >= ${q.from}::date and g.date_from <= ${q.to}::date
    order by g.date_from desc`;
  const now = Date.now();
  return rows.map((g) => {
    const docs = g.docs as {
      id: string;
      part: number;
      status: string;
      uuid: string | null;
      late: boolean;
      total: number;
      tax: number;
      tickets: number | null;
    }[];
    // A failed part replaced by a later part is history, not the period's state.
    const current = docs.filter(
      (d) =>
        d.status !== "canceled" &&
        !(d.status === "failed" && docs.some((n) => n.part > d.part)),
    );
    const pending = g.pending as { n: number; gross: number; tax: number };
    const unclaimed = Number(pending.n) > 0;
    const closed = Date.parse(g.closes_at) <= now;
    const overdue = Date.parse(g.due_at) < now;
    const unfinished = current.some((d) =>
      ["queued", "stamping", "pending", "waiting"].includes(d.status),
    );
    const failed = current.some((d) => d.status === "failed");
    // A built or empty period that has a ticket in no CFDI is due again (CFDI-MONEY-2, SAT-1).
    const status: GlobalPeriodView["status"] = failed
      ? "failed"
      : g.status === "open" || (closed && unclaimed)
        ? closed
          ? overdue
            ? "overdue"
            : "due"
          : "open"
        : g.status === "empty"
          ? "empty"
          : overdue && unfinished
            ? "overdue"
            : "built";
    const counted = current.filter((d) => d.status !== "failed");
    return {
      mode: g.mode,
      periodKey: g.period_key,
      periodicity: g.periodicity,
      from: g.from_date,
      to: g.to_date,
      closesAt: iso(g.closes_at)!,
      dueAt: iso(g.due_at)!,
      status,
      ticketCount:
        counted.reduce((s, d) => s + (d.tickets ?? 0), 0) + Number(pending.n),
      total: counted.reduce((s, d) => s + d.total, 0) + Number(pending.gross),
      tax: counted.reduce((s, d) => s + d.tax, 0) + Number(pending.tax),
      unclaimedTickets: Number(pending.n),
      lateTickets: g.late_tickets,
      documents: docs.map((d) => ({
        id: d.id,
        part: d.part,
        status: d.status,
        uuid: d.uuid,
        late: d.late,
      })),
      canRun:
        q.canRun &&
        closed &&
        (status === "due" ||
          status === "overdue" ||
          status === "failed" ||
          (!q.globalAuto && g.status === "open")),
    };
  });
}

/**
 * The current month's shape for a periodicity change (LD-51 F2), read in the caller's tenant
 * transaction: whether any global document of the month's periods exists in the settings' mode,
 * and the business dates (on or after the mode's start, through `today`) of the month's eligible
 * tickets not covered by a CFDI of that mode. A ticket counts as covered only by a document that
 * is valid or canceling: one whose invoice is still queued, stamping, pending or waiting may fail
 * and return to the portal with the deadline its receipt printed (LD-55 CFDIFIX-FISCAL-3), so its
 * date counts.
 */
export async function monthShape(
  tx: Tx,
  s: SettingsRow,
  today: string,
): Promise<{ hasGlobals: boolean; dates: string[] }> {
  const monthStart = today.slice(0, 8) + "01";
  const start = modeFrom(s) > monthStart ? modeFrom(s) : monthStart;
  const [g] = await tx`
    select exists (select 1 from cfdi_documents d
      join cfdi_global_periods p on p.tenant_id = d.tenant_id and p.mode = d.mode
        and p.period_key = d.period_key
      where d.kind = 'global' and d.mode = ${s.mode} and p.date_from >= ${monthStart}::date) as has`;
  const rows = await tx`
    select distinct t.business_date::text as d from fiscal_tickets t
    where t.business_date between ${start}::date and ${today}::date
      and not exists (select 1 from cfdi_document_tickets c
        join cfdi_documents x on x.tenant_id = c.tenant_id and x.id = c.document_id
        where c.tenant_id = t.tenant_id and c.ticket_id = t.id and c.mode = ${s.mode}
          and c.state <> 'released' and x.status in ('valid','canceling'))
      and t.gross > coalesce((select sum(a.gross) from fiscal_adjustments a
        where a.tenant_id = t.tenant_id and a.order_id = t.order_id), 0)
    order by 1`;
  return { hasGlobals: !!g?.has, dates: rows.map((r) => r.d as string) };
}

/**
 * Why changing to `to` must wait for next month, or null when it may apply at once (LD-51 F2,
 * shared/cfdi.ts periodicityChangeBlock): decided by the web under the settings row lock and
 * checked again by the tick, under the same lock and the period keys, before it rebuilds the
 * month's rows. `s` carries the periodicity in force today and the self-invoicing policy that
 * applies after the change; `graceMinutes` is the worker's (published in cfdi_platform).
 */
export async function periodicityChangeBlocked(
  tx: Tx,
  s: SettingsRow,
  to: Periodicity,
  today: string,
  facts: Pick<FiscalFacts, "timezone" | "cutoff">,
  graceMinutes: number,
  now = new Date(),
): Promise<PeriodicityChangeBlock | null> {
  const shape = await monthShape(tx, s, today);
  return periodicityChangeBlock({
    ...shape,
    from: periodicityOn(today, s),
    to,
    timezone: facts.timezone,
    cutoff: facts.cutoff,
    selfInvoice: {
      policy: s.selfInvoicePolicy,
      days: s.selfInvoiceDays,
      graceMinutes,
    },
    now,
  });
}

/** The period of a business date under the settings (for live-mode bounds and the register). */
export function currentPeriodStart(s: SettingsRow, today: string): string {
  const p =
    s.nextPeriodicity && s.nextPeriodicityFrom && today >= s.nextPeriodicityFrom
      ? s.nextPeriodicity
      : s.globalPeriodicity;
  return globalPeriodFor(today, p).from;
}
