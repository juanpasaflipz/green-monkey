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
import { boundaries, DomainError } from "../../shared/domain.js";
import {
  docLabel,
  globalPeriodFor,
  maskEmail,
  maskRfc,
  needsCardForm,
  selfInvoiceDeadline,
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
  type PortalDocumentStatus,
  type Receptor,
  type TicketEligibility,
} from "../../shared/cfdi.js";
import { formatFolio, type CfdiTicketPayload } from "../../shared/fiscal.js";
import type { Tx } from "../db.js";
import { fiscalTablesPresent, ticketForCfdi } from "../compat/cfdi-fiscal.js";

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export type PlatformRow = {
  provider: CfdiProvider;
  liveEnabled: boolean;
  uploadKid: string | null;
  uploadPublicJwk: JsonWebKey | null;
  sharedOrgId: string | null;
  workerVersion: string;
  updatedAt: string;
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
  selfInvoicePolicy: "month" | "days";
  selfInvoiceDays: number;
  portalReissueGlobal: boolean;
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
    workerVersion: r.worker_version,
    updatedAt: iso(r.updated_at)!,
  };
}

export async function loadSettings(
  tx: Tx,
  o: { forUpdate?: boolean } = {},
): Promise<SettingsRow | null> {
  const [r] = await tx`
    select enabled, mode, test_from::text as test_from, live_from::text as live_from, live_enabled_at,
      live_requested_at, live_requested_from::text as live_requested_from, live_requested_by,
      global_periodicity, next_periodicity, next_periodicity_from::text as next_periodicity_from,
      global_auto, concept_mode, concept_description, card_payment_form, default_use,
      self_invoice_enabled, self_invoice_policy, self_invoice_days, portal_reissue_global,
      support_email, version, updated_by, updated_at
    from cfdi_settings ${o.forUpdate ? tx`for update` : tx``}`;
  if (!r) return null;
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
    selfInvoicePolicy: r.self_invoice_policy,
    selfInvoiceDays: r.self_invoice_days,
    portalReissueGlobal: r.portal_reissue_global,
    supportEmail: r.support_email,
    version: r.version,
    updatedBy: r.updated_by,
    updatedAt: iso(r.updated_at)!,
  };
}

/** The first business date the current mode covers (test_from, or live_from in live mode). */
export function modeFrom(s: SettingsRow): string {
  return s.mode === "live" ? (s.liveFrom ?? s.testFrom) : s.testFrom;
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
  const present = await fiscalTablesPresent(tx);
  const [r] = present
    ? await tx`
        select r.name, r.currency, r.timezone, r.cutoff, p.version, p.rfc, p.legal_name, p.regime,
          p.postal_code, p.address
        from restaurants r left join restaurant_fiscal_profiles p on p.tenant_id = r.id
        where r.id = nullif(current_setting('app.tenant_id', true), '')::uuid`
    : await tx`
        select r.name, r.currency, r.timezone, r.cutoff, null::int as version, null as rfc,
          null as legal_name, null as regime, null as postal_code, null::jsonb as address
        from restaurants r where r.id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
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
    select p.provider,
      s.enabled, s.mode, s.self_invoice_enabled, s.self_invoice_policy, s.self_invoice_days,
      s.version, o.status as org_status,
      (select timezone from restaurants where id = nullif(current_setting('app.tenant_id', true), '')::uuid) as timezone
    from (select 1) one
    left join cfdi_platform p on p.id = 1
    left join cfdi_settings s on true
    left join cfdi_organizations o on true`;
  const provider: CfdiProvider = r?.provider ?? "disabled";
  const isAvailable = provider !== "disabled";
  const enabled = isAvailable && !!r?.enabled;
  const ready = enabled && r?.org_status === "ready";
  return {
    available: isAvailable,
    provider,
    enabled,
    mode: r?.mode ?? null,
    ready,
    canInvoice: ready && ["owner", "manager", "cashier"].includes(role ?? ""),
    selfInvoice:
      enabled && r?.self_invoice_enabled !== undefined && r?.mode
        ? {
            enabled: r.self_invoice_enabled,
            policy: r.self_invoice_policy,
            days: r.self_invoice_days,
          }
        : null,
    timezone: r?.timezone ?? "America/Mexico_City",
    version: r?.version ?? 0,
  };
}

/**
 * Public ordering (wave 3, LD-18 / public-rebase): whether the restaurant offers self-invoicing on
 * its tickets (available && enabled && ready && self_invoice_enabled). One statement.
 */
export async function selfInvoiceOffered(tx: Tx): Promise<boolean> {
  const [r] = await tx`
    select exists(
      select 1 from cfdi_platform p, cfdi_settings s, cfdi_organizations o
      where p.id = 1 and p.provider <> 'disabled' and s.enabled and s.self_invoice_enabled
        and o.status = 'ready') as offered`;
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
  const [r] = await tx`
    select d.id from cfdi_documents d
    where d.replaces_document_id = ${documentId} and d.status = any(${[...statuses]}::text[])
      and exists (select 1 from cfdi_document_tickets c where c.tenant_id = d.tenant_id
        and c.document_id = d.id and c.state = 'pending')
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
  const fiscal = await fiscalTablesPresent(tx);
  const folios = fiscal
    ? tx`
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
        order by t.series desc, t.number desc limit 1) as last_number,`
    : tx`null as first_series, null as first_number, null as last_series, null as last_number,`;
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
  const fiscal = await fiscalTablesPresent(tx);
  const search = !term
    ? tx``
    : tx`and (
        d.receptor_rfc = ${term.toUpperCase()}
        or d.uuid::text = ${term.toLowerCase()}
        or (d.series || '-' || d.folio_number::text) = ${term.toUpperCase()}
        ${
          fiscal
            ? tx`or exists (select 1 from cfdi_document_tickets c join fiscal_tickets t
                on t.tenant_id = c.tenant_id and t.id = c.ticket_id
                where c.tenant_id = d.tenant_id and c.document_id = coalesce(d.parent_document_id, d.id)
                  and ${
                    folioParts
                      ? tx`t.series = ${folioParts[1]} and t.number = ${Number(folioParts[2])}`
                      : /^\d{1,16}$/.test(term)
                        ? tx`t.series = '' and t.number = ${Number(term)}`
                        : tx`false`
                  })`
            : tx``
        })`;
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
        and exists (select 1 from cfdi_document_tickets c where c.tenant_id = s.tenant_id
          and c.document_id = s.id and c.state = 'pending')
        order by s.created_at desc limit 1) as waiting_substitute,
      exists (select 1 from cfdi_documents s where s.replaces_document_id = ${id}
        and s.status = any(${[...UNFINISHED_SUBSTITUTE]}::text[])
        and exists (select 1 from cfdi_document_tickets c where c.tenant_id = s.tenant_id
          and c.document_id = s.id and c.state = 'pending')) as substitute_unfinished,
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
  const canCancel =
    valid &&
    !openCancellation &&
    (d.kind === "global" ? owner : manager) &&
    (extra.active_credit_notes as string[]).length === 0;
  // A valid substitute still waiting for the ticket while no cancellation of this document is open
  // (rejected, expired or refused by the provider): two valid CFDIs for one sale (CFDI-R3-1). The
  // same condition as attention()'s count.
  const waitingSubstituteId: string | null = openCancellation
    ? null
    : (extra.waiting_substitute ?? null);
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
    canCancel,
    canSubstitute:
      canCancel && d.kind === "invoice" && !extra.substitute_unfinished,
    canRequestAgain: canCancel && d.kind === "invoice" && !!waitingSubstituteId,
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
  };
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
  if (!(await fiscalTablesPresent(tx))) return false;
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
  if (!(await fiscalTablesPresent(tx))) return null;
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
  if (invoice)
    return t.coverage.some((c) => c.kind === "invoice" && c.status === "valid")
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

/** The self-invoicing deadline of a ticket, or null when self-invoicing is off. */
export function ticketDeadline(
  t: TicketFacts,
  settings: SettingsRow | null,
  timezone: string,
): string | null {
  return settings && settings.selfInvoiceEnabled
    ? selfInvoiceDeadline(
        t.payload.ticket.businessDate,
        settings.selfInvoicePolicy,
        settings.selfInvoiceDays,
        timezone,
      )
    : null;
}

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
  const deadline = ticketDeadline(t, settings, facts.timezone);
  let status = eligibility(t, state);
  if (
    o.portal &&
    status === "available" &&
    deadline &&
    Date.parse(deadline) < now.getTime()
  )
    status = "expired";
  const covering =
    t.coverage.find((c) => c.kind === "invoice" && c.status === "valid") ??
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
    documents,
  };
}

// ---------------------------------------------------------------------------------------------
// Attention, alerts, coverage and periods
// ---------------------------------------------------------------------------------------------

/** Counts for the panel badge, Today and the worker's alerts (one statement). */
export async function attention(tx: Tx): Promise<CfdiAlertsView> {
  const [r] = await tx`
    select s.mode,
      (select count(*) from cfdi_global_periods g where g.mode = s.mode
        and ((g.due_at < now() and (g.status = 'open'
               or exists (select 1 from cfdi_documents d where d.tenant_id = g.tenant_id and d.mode = g.mode
                   and d.kind = 'global' and d.period_key = g.period_key
                   and d.status in ('queued','stamping','pending'))))
          or exists (select 1 from cfdi_documents d where d.tenant_id = g.tenant_id and d.mode = g.mode
                   and d.kind = 'global' and d.period_key = g.period_key and d.status = 'failed'
                   and not exists (select 1 from cfdi_documents n where n.tenant_id = d.tenant_id and n.mode = d.mode
                     and n.kind = 'global' and n.period_key = d.period_key and n.part > d.part)))) as overdue,
      (select count(*) from cfdi_documents d where d.status = 'failed' and d.kind in ('global','egreso')
        and d.created_at > now() - interval '30 days'
        and not exists (select 1 from cfdi_documents n where n.tenant_id = d.tenant_id and n.mode = d.mode
          and ((d.kind = 'global' and n.kind = 'global' and n.period_key = d.period_key and n.part > d.part)
            or (d.kind = 'egreso' and n.kind = 'egreso' and n.refund_id = d.refund_id and n.created_at > d.created_at)))) as failed,
      (select count(*) from cfdi_documents d where d.status in ('queued','stamping')
        and d.updated_at < now() - interval '30 minutes') as stuck,
      -- Valid substitutes still waiting for their ticket while the original has no open
      -- cancellation: rejected, expired or refused by the provider, whatever came after
      -- (CFDI-R3-1). Never clears while two valid CFDIs exist for one sale.
      (select count(*) from cfdi_documents s where s.kind = 'invoice' and s.status = 'valid'
        and s.replaces_document_id is not null
        and exists (select 1 from cfdi_document_tickets c where c.tenant_id = s.tenant_id
          and c.document_id = s.id and c.state = 'pending')
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
  },
): Promise<GlobalPeriodView[]> {
  const rows = await tx`
    select g.*, g.date_from::text as from_date, g.date_to::text as to_date,
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
    const closed = Date.parse(g.closes_at) <= now;
    const overdue = Date.parse(g.due_at) < now;
    const unfinished = current.some((d) =>
      ["queued", "stamping", "pending", "waiting"].includes(d.status),
    );
    const failed = current.some((d) => d.status === "failed");
    const status: GlobalPeriodView["status"] = failed
      ? "failed"
      : g.status === "open"
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
      ticketCount: counted.reduce((s, d) => s + (d.tickets ?? 0), 0),
      total: counted.reduce((s, d) => s + d.total, 0),
      tax: counted.reduce((s, d) => s + d.tax, 0),
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

/** The period of a business date under the settings (for live-mode bounds and the register). */
export function currentPeriodStart(s: SettingsRow, today: string): string {
  const p =
    s.nextPeriodicity && s.nextPeriodicityFrom && today >= s.nextPeriodicityFrom
      ? s.nextPeriodicity
      : s.globalPeriodicity;
  return globalPeriodFor(today, p).from;
}
