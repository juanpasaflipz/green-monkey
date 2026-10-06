/**
 * cfdi authenticated route functions (spec §4.7.1). Web only. Every function runs inside the
 * route's tenant transaction with the session `route()` passes; commands go through once()
 * (MON-3 idempotency) and return ids from inside it, building views afterwards (no receptor data
 * in `operations`, cfdi-rebase §2 item 12).
 *
 * Roles (spec §2.13): status for operators; issuing for owner/manager/cashier; the register,
 * globals and retries for managers; activation, settings, CSD and live for the owner with PIN
 * step-up; cancel/substitute/reissue for managers with step-up (globals: owner).
 */
import { createHash, randomUUID } from "node:crypto";
import type express from "express";
import { DomainError, businessDate, id } from "../../shared/domain.js";
import {
  activateInput,
  cancelInput,
  cfdiSettingsInput,
  csdUploadInput,
  documentsQuery,
  emailRequestInput,
  firstOfNextMonth,
  firstReceptorError,
  globalPeriodFor,
  globalsQuery,
  globalsRunInput,
  invoiceRequestInput,
  liveInput,
  needsCardForm,
  operationInput,
  substituteInput,
  egresoSubstituteInput,
  type CfdiSettingsView,
  type CfdiTicketView,
  type GlobalPeriodView,
  type Receptor,
} from "../../shared/cfdi.js";
import { parseFolio } from "../../shared/fiscal.js";
import type { Session } from "../../shared/domain.js";
import type { Tx } from "../db.js";
import { managers, operators, permit } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { audit, once } from "../orders.js";
import { inspectCsd, sealCsdUpload } from "./csd.js";
import {
  cfdiEnqueue,
  dedupe,
  enqueueStamp,
  ensureTick,
  GLOBAL_MAX_ATTEMPTS,
  INVOICE_MAX_ATTEMPTS,
} from "./jobs.js";
import { createInvoiceRequest, lockDocument } from "./requests.js";
import { enqueueRecovery, recoveryAction } from "./recovery.js";
import {
  attention,
  attentionOf,
  available,
  cfdiState,
  currentPeriodStart,
  documentView,
  fiscalComplete,
  fiscalFacts,
  hasCreditNotes,
  insertEvent,
  isStuck,
  listDocuments,
  loadDocument,
  loadSettings,
  periodViews,
  requireCfdi,
  statusView,
  ticketFacts,
  ticketIdByFolio,
  ticketView,
  UNFINISHED_SUBSTITUTE,
  modeStart,
  waitingSubstitute,
  type CfdiState,
  type DocumentRow,
  type Viewer,
} from "./store.js";

const issuers = ["owner", "manager", "cashier"];
const viewerOf = (s: Session): Viewer => ({
  role: s.role,
  employeeId: s.employeeId,
});
const today = (s: Session) =>
  businessDate(
    new Date().toISOString(),
    s.restaurant.timezone,
    s.restaurant.cutoff,
  );

/** Strict query parsing for GET routes (express query values are strings or arrays). */
function query(req: express.Request): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.query))
    if (typeof v === "string") out[k] = v;
  return out;
}

function daysBetween(from: string, to: string): number {
  return (
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) /
    86_400_000
  );
}

// ---------------------------------------------------------------------------------------------
// Status and settings
// ---------------------------------------------------------------------------------------------

/**
 * GET /cfdi/status (every operator at sign-in): also restarts the restaurant's global tick chain
 * when no tick is queued or running (ensureTick, review CFDI-R3), so a dead chain never stops the
 * globals and their overdue alerts for longer than the next sign-in.
 */
export async function getStatus(tx: Tx, s: Session) {
  permit(s, operators);
  const view = await statusView(tx, s.role);
  if (view.enabled) await ensureTick(tx, s.tenantId, "status");
  return view;
}

async function settingsView(
  tx: Tx,
  s: Session,
  state?: CfdiState,
): Promise<CfdiSettingsView> {
  const st = state ?? (await cfdiState(tx));
  const status = await statusView(tx, s.role);
  const facts = await fiscalFacts(tx);
  const settings = st.settings;
  const org = st.organization;
  const day = today(s);
  let lastUpload: NonNullable<
    CfdiSettingsView["organization"]
  >["csd"]["lastUpload"] = null;
  let lastEvent: NonNullable<CfdiSettingsView["organization"]>["lastEvent"] =
    null;
  let updatedByName: string | null = null;
  if (settings) {
    const [u] = await tx`
      select id, status, error_code, created_at from cfdi_csd_uploads order by created_at desc limit 1`;
    if (u)
      lastUpload = {
        id: u.id,
        status: u.status,
        errorCode: u.error_code,
        createdAt: new Date(u.created_at).toISOString(),
      };
    const [e] = await tx`
      select kind, created_at, detail from cfdi_events
      where document_id is null and kind in ('org_error','live_failed','live_enabled','csd_rejected','csd_accepted','csd_rfc_mismatch')
      order by created_at desc limit 1`;
    if (e)
      lastEvent = {
        kind: e.kind,
        at: new Date(e.created_at).toISOString(),
        detail: e.detail,
      };
    const [n] =
      await tx`select name from employees where id = ${settings.updatedBy}`;
    updatedByName = n?.name ?? null;
  }
  const alerts = settings ? await attention(tx) : null;
  const minFrom = settings ? currentPeriodStart(settings, day) : day;
  const csdOk =
    org?.csdStatus === "valid" &&
    !!org.csdValidUntil &&
    Date.parse(org.csdValidUntil) > Date.now() + 7 * 86_400_000;
  return {
    ...status,
    canEdit: s.role === "owner",
    prerequisites: {
      platform: available(st.platform),
      fiscalComplete: fiscalComplete(facts),
      currency: facts.currency === "MXN",
      legalNameLength: !facts.legalName || facts.legalName.length <= 100,
      regime: facts.regime,
    },
    settings: settings
      ? {
          enabled: settings.enabled,
          mode: settings.mode,
          testFrom: settings.testFrom,
          liveFrom: settings.liveFrom,
          liveRequested:
            settings.liveRequestedAt && settings.liveRequestedFrom
              ? {
                  at: settings.liveRequestedAt,
                  from: settings.liveRequestedFrom,
                }
              : null,
          globalPeriodicity: settings.globalPeriodicity,
          nextPeriodicity: settings.nextPeriodicity,
          nextPeriodicityFrom: settings.nextPeriodicityFrom,
          globalAuto: settings.globalAuto,
          conceptMode: settings.conceptMode,
          conceptDescription: settings.conceptDescription,
          cardPaymentForm: settings.cardPaymentForm,
          defaultUse: settings.defaultUse,
          selfInvoiceEnabled: settings.selfInvoiceEnabled,
          selfInvoicePolicy: settings.selfInvoicePolicy,
          selfInvoiceDays: settings.selfInvoiceDays,
          portalReissueGlobal: settings.portalReissueGlobal,
          supportEmail: settings.supportEmail,
          version: settings.version,
          updatedAt: settings.updatedAt,
          updatedByName,
          resicoMonthly: facts.regime === "626",
        }
      : null,
    organization: org
      ? {
          source: org.source,
          status: org.status,
          provisioned: !!org.providerOrgId,
          errorCode: org.errorCode,
          taxId: org.legalTaxId ?? facts.rfc,
          legalSyncedVersion: org.legalSyncedVersion,
          fiscalProfileVersion: facts.version,
          csd: {
            status: org.csdStatus,
            serial: org.csdSerial,
            validUntil: org.csdValidUntil,
            lastUpload,
          },
          productionReady: org.productionReady,
          pendingSteps: org.pendingSteps,
          checkedAt: org.checkedAt,
          lastEvent,
        }
      : null,
    live: {
      platformEnabled: !!st.platform?.liveEnabled,
      canRequest:
        s.role === "owner" &&
        !!settings &&
        settings.mode === "test" &&
        !settings.liveRequestedAt &&
        !!st.platform?.liveEnabled &&
        org?.source === "own" &&
        org.status === "ready" &&
        org.productionReady &&
        csdOk &&
        fiscalComplete(facts),
      defaultFrom: minFrom,
      minFrom,
      maxFrom: day,
      failure:
        lastEvent?.kind === "live_failed"
          ? String((lastEvent.detail as { reason?: unknown }).reason ?? "")
          : null,
    },
    attention: alerts
      ? attentionOf(alerts)
      : {
          overdueGlobals: 0,
          failedDocuments: 0,
          stuckDocuments: 0,
          rejectedSubstitutions: 0,
          csdExpiresSoon: false,
        },
  };
}

/** GET /cfdi/settings: also schedules an organization refresh and a global tick (10-min buckets). */
export async function getSettings(tx: Tx, s: Session) {
  permit(s, managers);
  const state = await cfdiState(tx);
  if (state.settings && available(state.platform)) {
    const now = new Date();
    const stale =
      !state.organization?.checkedAt ||
      Date.parse(state.organization.checkedAt) < now.getTime() - 10 * 60_000;
    if (stale && state.organization?.status === "ready")
      await cfdiEnqueue(tx, s.tenantId, {
        kind: "cfdi_org",
        dedupeKey: dedupe.refresh(now),
        payload: { action: "refresh" },
      });
    await cfdiEnqueue(tx, s.tenantId, {
      kind: "cfdi_global",
      dedupeKey: dedupe.tickEnsure(now),
      payload: {},
    });
  }
  return settingsView(tx, s, state);
}

export async function activate(tx: Tx, s: Session, raw: unknown) {
  permit(s, ["owner"]);
  requireRecentAuth(s);
  const p = activateInput.parse(raw);
  await once(tx, s, p.operationId, "cfdi.activate", p, async () => {
    const state = await cfdiState(tx);
    if (!available(state.platform))
      throw new DomainError("cfdi_unavailable", 409);
    if (state.settings) throw new DomainError("cfdi_settings_changed", 409);
    const facts = await fiscalFacts(tx);
    if (!fiscalComplete(facts))
      throw new DomainError("cfdi_fiscal_profile_incomplete", 409);
    if (facts.currency !== "MXN")
      throw new DomainError("cfdi_currency_unsupported", 409);
    if ((facts.legalName ?? "").length > 100)
      throw new DomainError("cfdi_legal_name_too_long", 409);
    // A concurrent activation (another operationId) may have won: answer a conflict, not a 500.
    const created = await tx`
      insert into cfdi_settings(tenant_id, test_from, updated_by)
      values (${s.tenantId}, ${today(s)}::date, ${s.employeeId})
      on conflict (tenant_id) do nothing returning tenant_id`;
    if (!created.length) throw new DomainError("cfdi_settings_changed", 409);
    await tx`
      insert into cfdi_organizations(tenant_id, source)
      values (${s.tenantId}, ${state.platform!.provider === "sandbox_shared" ? "shared_sandbox" : "own"})`;
    await cfdiEnqueue(tx, s.tenantId, {
      kind: "cfdi_org",
      dedupeKey: dedupe.provision(p.operationId),
      payload: { action: "provision" },
    });
    await cfdiEnqueue(tx, s.tenantId, {
      kind: "cfdi_global",
      dedupeKey: dedupe.tickActivate(),
      payload: {},
    });
    await insertEvent(tx, s.tenantId, null, "activated", {}, s.employeeId);
    await audit(tx, s, "cfdi.activated", s.tenantId, {
      provider: state.platform!.provider,
    });
    return { ok: true };
  });
  return settingsView(tx, s);
}

export async function saveSettings(tx: Tx, s: Session, raw: unknown) {
  permit(s, ["owner"]);
  requireRecentAuth(s);
  const p = cfdiSettingsInput.parse(raw);
  await once(tx, s, p.operationId, "cfdi.settings", p, async () => {
    const before = await loadSettings(tx, { forUpdate: true });
    if (!before) throw new DomainError("cfdi_disabled", 409);
    if (before.version !== p.expectedVersion)
      throw new DomainError("cfdi_settings_changed", 409);
    const facts = await fiscalFacts(tx);
    if (facts.regime === "626" && p.globalPeriodicity !== "month")
      throw new DomainError("cfdi_resico_monthly", 400);
    // Once any period row exists (built or not; the global tick adds the current period's row
    // right after activation), a periodicity change applies from the first day of next month:
    // the rows already there keep theirs and the tick never re-derives a past date, so a period
    // never mixes periodicities (CFDI-R2-1). Choosing the current one again cancels it. The
    // settings row is locked FOR UPDATE above; the tick adds rows under the same lock.
    let periodicity = before.globalPeriodicity;
    let next: typeof before.nextPeriodicity = null;
    let nextFrom: string | null = null;
    if (p.globalPeriodicity !== before.globalPeriodicity) {
      const [built] =
        await tx`select 1 as one from cfdi_global_periods limit 1`;
      if (built) {
        next = p.globalPeriodicity;
        nextFrom = firstOfNextMonth(today(s));
      } else periodicity = p.globalPeriodicity;
    }
    await tx`
      update cfdi_settings set enabled = ${p.enabled}, global_periodicity = ${periodicity},
        next_periodicity = ${next}, next_periodicity_from = ${nextFrom}::date, global_auto = ${p.globalAuto},
        concept_mode = ${p.conceptMode}, concept_description = ${p.conceptDescription},
        card_payment_form = ${p.cardPaymentForm}, default_use = ${p.defaultUse},
        self_invoice_enabled = ${p.selfInvoiceEnabled}, self_invoice_policy = ${p.selfInvoicePolicy},
        self_invoice_days = ${p.selfInvoiceDays}, portal_reissue_global = ${p.portalReissueGlobal},
        support_email = ${p.supportEmail}, version = version + 1, updated_by = ${s.employeeId},
        updated_at = now()`;
    const after = {
      enabled: p.enabled,
      globalPeriodicity: periodicity,
      nextPeriodicity: next,
      nextPeriodicityFrom: nextFrom,
      globalAuto: p.globalAuto,
      conceptMode: p.conceptMode,
      cardPaymentForm: p.cardPaymentForm,
      defaultUse: p.defaultUse,
      selfInvoiceEnabled: p.selfInvoiceEnabled,
      selfInvoicePolicy: p.selfInvoicePolicy,
      selfInvoiceDays: p.selfInvoiceDays,
      portalReissueGlobal: p.portalReissueGlobal,
    };
    const was = {
      enabled: before.enabled,
      globalPeriodicity: before.globalPeriodicity,
      nextPeriodicity: before.nextPeriodicity,
      nextPeriodicityFrom: before.nextPeriodicityFrom,
      globalAuto: before.globalAuto,
      conceptMode: before.conceptMode,
      cardPaymentForm: before.cardPaymentForm,
      defaultUse: before.defaultUse,
      selfInvoiceEnabled: before.selfInvoiceEnabled,
      selfInvoicePolicy: before.selfInvoicePolicy,
      selfInvoiceDays: before.selfInvoiceDays,
      portalReissueGlobal: before.portalReissueGlobal,
    };
    await audit(tx, s, "cfdi.settings.saved", s.tenantId, {
      before: was,
      after,
    });
    await cfdiEnqueue(tx, s.tenantId, {
      kind: "cfdi_global",
      dedupeKey: dedupe.tickEnsure(new Date()),
      payload: {},
    });
    return { ok: true };
  });
  return settingsView(tx, s);
}

export async function retryOrganization(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = operationInput.parse(raw);
  await once(tx, s, p.operationId, "cfdi.org.retry", p, async () => {
    const state = await cfdiState(tx);
    requireCfdi(state);
    await cfdiEnqueue(tx, s.tenantId, {
      kind: "cfdi_org",
      dedupeKey: dedupe.provision(p.operationId),
      payload: { action: "provision" },
    });
    return { ok: true };
  });
  return settingsView(tx, s);
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export async function uploadCsd(tx: Tx, s: Session, raw: unknown) {
  permit(s, ["owner"]);
  requireRecentAuth(s);
  const p = csdUploadInput.parse(raw);
  const cer = Buffer.from(p.cer, "base64");
  const key = Buffer.from(p.key, "base64");
  // The password never reaches once()'s fingerprint, the operations table or a log line.
  const fingerprint = {
    operationId: p.operationId,
    cerSha256: sha256(cer),
    keySha256: sha256(key),
  };
  return once(tx, s, p.operationId, "cfdi.csd", fingerprint, async () => {
    const state = await cfdiState(tx);
    requireCfdi(state);
    if (
      state.platform.provider !== "organizations" ||
      state.organization?.source !== "own"
    )
      throw new DomainError("cfdi_csd_not_supported", 409);
    // The box is useful only to an organization that exists at Facturapi: before that, its job
    // could only wait and the sealed key would sit in cfdi_secrets (CFDI-SECRETS-1).
    if (!state.organization.providerOrgId)
      throw new DomainError("cfdi_not_ready", 409);
    const [busy] = await tx`
      select 1 as one from cfdi_csd_uploads where status in ('queued','processing') limit 1`;
    if (busy) throw new DomainError("cfdi_csd_upload_in_progress", 409);
    const facts = await fiscalFacts(tx);
    const inspection = inspectCsd({ cer, key, password: p.password });
    if (!facts.rfc || inspection.rfc !== facts.rfc.toUpperCase())
      throw new DomainError("cfdi_csd_rfc_mismatch", 400);
    const kid = state.platform.uploadKid;
    const jwk = state.platform.uploadPublicJwk;
    if (!kid || !jwk) throw new DomainError("cfdi_unavailable", 409);
    const secretId = randomUUID();
    const uploadId = randomUUID();
    const box = await sealCsdUpload(
      { kid, jwk },
      { cer, key, password: p.password },
      { tenantId: s.tenantId, id: secretId },
    );
    await tx`
      insert into cfdi_secrets(tenant_id, id, purpose, kid, payload_secret)
      values (${s.tenantId}, ${secretId}, 'csd_upload', ${kid}, ${box})`;
    await tx`
      insert into cfdi_csd_uploads(tenant_id, id, secret_id, status, cert_serial, cert_rfc,
        cert_valid_from, cert_valid_until, requested_by)
      values (${s.tenantId}, ${uploadId}, ${secretId}, 'queued', ${inspection.serial}, ${inspection.rfc},
        ${inspection.validFrom}, ${inspection.validUntil}, ${s.employeeId})`;
    await cfdiEnqueue(tx, s.tenantId, {
      kind: "cfdi_csd",
      dedupeKey: dedupe.csd(uploadId),
      payload: { uploadId },
    });
    await insertEvent(
      tx,
      s.tenantId,
      null,
      "csd_requested",
      { uploadId },
      s.employeeId,
    );
    await audit(tx, s, "cfdi.csd.uploaded", uploadId, {
      serial: inspection.serial,
      validUntil: inspection.validUntil,
      passwordChecked: inspection.passwordChecked,
    });
    return {
      uploadId,
      status: "queued" as const,
      certificate: {
        rfc: inspection.rfc,
        serial: inspection.serial,
        validFrom: inspection.validFrom,
        validUntil: inspection.validUntil,
      },
    };
  });
}

export async function requestLive(tx: Tx, s: Session, raw: unknown) {
  permit(s, ["owner"]);
  requireRecentAuth(s);
  const p = liveInput.parse(raw);
  await once(tx, s, p.operationId, "cfdi.live", p, async () => {
    const state = await cfdiState(tx);
    requireCfdi(state, { needEnabled: true });
    const settings = (await loadSettings(tx, { forUpdate: true }))!;
    if (settings.version !== p.expectedVersion || settings.mode === "live")
      throw new DomainError("cfdi_settings_changed", 409);
    if (!state.platform.liveEnabled)
      throw new DomainError("cfdi_live_not_enabled", 409);
    const org = state.organization;
    const facts = await fiscalFacts(tx);
    const csdOk =
      org?.csdStatus === "valid" &&
      !!org.csdValidUntil &&
      Date.parse(org.csdValidUntil) > Date.now() + 7 * 86_400_000;
    if (
      !org ||
      org.source !== "own" ||
      org.status !== "ready" ||
      !csdOk ||
      !org.productionReady ||
      !fiscalComplete(facts)
    )
      throw new DomainError("cfdi_live_requirements", 409);
    const day = today(s);
    const minFrom = currentPeriodStart(settings, day);
    if (p.liveFrom < minFrom || p.liveFrom > day)
      throw new DomainError("cfdi_live_from_invalid", 400);
    await tx`
      update cfdi_settings set live_requested_at = now(), live_requested_from = ${p.liveFrom}::date,
        live_requested_by = ${s.employeeId}, version = version + 1, updated_by = ${s.employeeId},
        updated_at = now()`;
    await cfdiEnqueue(tx, s.tenantId, {
      kind: "cfdi_org",
      dedupeKey: dedupe.goLive(p.operationId),
      payload: { action: "go_live" },
    });
    await insertEvent(
      tx,
      s.tenantId,
      null,
      "live_requested",
      { liveFrom: p.liveFrom },
      s.employeeId,
    );
    await audit(tx, s, "cfdi.live.requested", s.tenantId, {
      liveFrom: p.liveFrom,
    });
    return { ok: true };
  });
  return settingsView(tx, s);
}

// ---------------------------------------------------------------------------------------------
// Tickets and invoices
// ---------------------------------------------------------------------------------------------

async function staffTicketView(
  tx: Tx,
  s: Session,
  ticketId: string,
): Promise<CfdiTicketView> {
  const state = await cfdiState(tx);
  requireCfdi(state);
  const facts = await fiscalFacts(tx);
  const t = await ticketFacts(tx, ticketId, state.settings.mode);
  return ticketView(tx, t, state, facts, {
    viewer: viewerOf(s),
    portal: false,
  });
}

export async function getTicket(tx: Tx, s: Session, req: express.Request) {
  permit(s, issuers);
  const parsed = id.safeParse(req.params.ticketId);
  if (!parsed.success) throw new DomainError("cfdi_ticket_not_found", 404);
  return staffTicketView(tx, s, parsed.data);
}

export async function findTicket(tx: Tx, s: Session, req: express.Request) {
  permit(s, issuers);
  const folio = String(query(req).folio ?? "").slice(0, 40);
  const parsed = parseFolio(folio);
  if (!parsed) throw new DomainError("cfdi_ticket_not_found", 404);
  const ticketId = await ticketIdByFolio(tx, parsed);
  if (!ticketId) throw new DomainError("cfdi_ticket_not_found", 404);
  return staffTicketView(tx, s, ticketId);
}

function receptorOrThrow(r: Receptor, requireEmail: boolean) {
  const issue = firstReceptorError(r, { requireEmail });
  if (issue) throw new DomainError(issue.code, 400);
}

export async function requestInvoice(tx: Tx, s: Session, raw: unknown) {
  permit(s, issuers);
  const p = invoiceRequestInput.parse(raw);
  if (p.reissueGlobal) {
    permit(s, managers);
    requireRecentAuth(s);
  }
  receptorOrThrow(p.receptor, false);
  const r = await once(tx, s, p.operationId, "cfdi.invoice", p, async () => {
    const created = await createInvoiceRequest(tx, {
      tenantId: s.tenantId,
      actorId: s.employeeId,
      source: "staff",
      ticketId: p.ticketId,
      receptor: p.receptor,
      cardForm: p.cardForm,
      confirmPreStart: p.confirmPreStart,
      reissueGlobal: p.reissueGlobal,
    });
    await audit(tx, s, "cfdi.invoice.requested", created.documentId, {
      ticketId: p.ticketId,
      documentId: created.documentId,
      reissueGlobal: p.reissueGlobal,
    });
    return { documentId: created.documentId };
  });
  return staffView(tx, r.documentId, s);
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

/**
 * documentView for staff, plus Reintentar for a manager when the document's job is gone (a
 * pending stamp or a cancellation no poll follows, a cancellation never sent, missing files;
 * review CFDI-R2).
 */
async function staffView(tx: Tx, documentId: string, s: Session) {
  const view = await documentView(tx, documentId, viewerOf(s));
  if (view.canRetry || !managers.includes(s.role)) return view;
  const doc = await loadDocument(tx, documentId);
  const action = doc ? await recoveryAction(tx, doc) : null;
  return action && action.kind !== "release"
    ? { ...view, canRetry: true }
    : view;
}

/** Managers, or the cashier who created the document in the last 24 hours. */
async function visibleDocument(
  tx: Tx,
  s: Session,
  documentId: string,
): Promise<DocumentRow> {
  permit(s, issuers);
  const ok = id.safeParse(documentId);
  if (!ok.success) throw new DomainError("not_found", 404);
  const doc = await loadDocument(tx, ok.data);
  if (!doc) throw new DomainError("not_found", 404);
  if (
    !managers.includes(s.role) &&
    (doc.createdBy !== s.employeeId ||
      Date.parse(doc.createdAt) < Date.now() - 24 * 3600_000)
  )
    throw new DomainError("not_found", 404);
  return doc;
}

export async function listDocumentsRoute(
  tx: Tx,
  s: Session,
  req: express.Request,
) {
  permit(s, managers);
  const q = documentsQuery.parse(query(req));
  if (q.to < q.from || daysBetween(q.from, q.to) > 92)
    throw new DomainError("cfdi_range_invalid", 400);
  await tx`select set_config('statement_timeout', '30s', true)`;
  return listDocuments(tx, {
    ...q,
    timezone: s.restaurant.timezone,
    cutoff: s.restaurant.cutoff,
  });
}

export async function getDocument(tx: Tx, s: Session, req: express.Request) {
  const doc = await visibleDocument(tx, s, String(req.params.id));
  return staffView(tx, doc.id, s);
}

const CONTENT_TYPES: Record<string, string> = {
  xml: "application/xml",
  pdf: "application/pdf",
  cancel_xml: "application/xml",
  cancel_pdf: "application/pdf",
};

/** The binary download (called by the route outside route(); the response is written after). */
export async function sendDocumentFile(
  tx: Tx,
  s: Session,
  params: { id?: string; format?: string },
): Promise<{ content: Buffer; contentType: string; filename: string }> {
  const format = String(params.format ?? "");
  if (!CONTENT_TYPES[format]) throw new DomainError("not_found", 404);
  const doc = await visibleDocument(tx, s, String(params.id ?? ""));
  const [file] = await tx`
    select content from cfdi_files where document_id = ${doc.id} and format = ${format}`;
  if (!file) throw new DomainError("cfdi_file_not_ready", 409);
  const rfc =
    doc.kind === "global" ? "XAXX010101000" : (doc.receptorRfc ?? "CFDI");
  const name =
    `${rfc}_${doc.series ?? ""}${doc.folioNumber ?? doc.id.slice(0, 8)}`.replace(
      /[^A-Za-z0-9_&-]/g,
      "",
    );
  const ext = format.endsWith("pdf") ? "pdf" : "xml";
  return {
    content: Buffer.from(file.content),
    contentType: CONTENT_TYPES[format],
    filename: `${name}${format.startsWith("cancel") ? "_acuse" : ""}.${ext}`,
  };
}

export async function emailDocument(
  tx: Tx,
  s: Session,
  raw: unknown,
  req: express.Request,
) {
  const doc = await visibleDocument(tx, s, String(req.params.id));
  const p = emailRequestInput.parse(raw);
  await once(
    tx,
    s,
    p.operationId,
    "cfdi.email",
    { ...p, documentId: doc.id },
    async () => {
      if (doc.kind === "global" || !["valid", "canceling"].includes(doc.status))
        throw new DomainError("cfdi_not_valid", 409);
      const parent =
        doc.kind === "egreso" && doc.parentDocumentId
          ? await loadDocument(tx, doc.parentDocumentId)
          : null;
      const to =
        p.email ?? doc.receptor?.email ?? parent?.receptor?.email ?? null;
      if (!to) throw new DomainError("cfdi_email_required", 400);
      // The address stays with the document's history, never in the job payload (spec R16).
      const requestId = randomUUID();
      await insertEvent(
        tx,
        s.tenantId,
        doc.id,
        "email_requested",
        { requestId, to },
        s.employeeId,
      );
      await cfdiEnqueue(tx, s.tenantId, {
        kind: "cfdi_deliver",
        dedupeKey: dedupe.email(p.operationId),
        payload: { documentId: doc.id, email: true, requestId },
      });
      await audit(tx, s, "cfdi.email.requested", doc.id, {
        documentId: doc.id,
      });
      return { ok: true };
    },
  );
  return staffView(tx, doc.id, s);
}

/**
 * Common cancel/substitute checks under the document's advisory key (LO-3), the key cfdi_refund
 * takes before it creates a credit note (CFDI-R3-2).
 */
async function cancellable(tx: Tx, s: Session, doc: DocumentRow) {
  await lockDocument(tx, s.tenantId, doc.id);
  const current = (await loadDocument(tx, doc.id))!;
  if (current.status !== "valid") throw new DomainError("cfdi_not_valid", 409);
  const [open] = await tx`
    select 1 as one from cfdi_cancellations
    where document_id = ${doc.id} and status in ('queued','requested')`;
  if (open) throw new DomainError("cfdi_cancel_in_progress", 409);
  // The substitute named by an open motive-01 cancellation of its original: canceling it first
  // would leave that cancellation waiting forever (CFDI-R4-1).
  const [named] = await tx`
    select 1 as one from cfdi_cancellations
    where substitute_document_id = ${doc.id} and status in ('queued','requested')`;
  if (named) throw new DomainError("cfdi_substitution_in_progress", 409);
  if (await hasCreditNotes(tx, doc.id))
    throw new DomainError("cfdi_has_credit_notes", 409);
  return current;
}

export async function cancelDocument(
  tx: Tx,
  s: Session,
  raw: unknown,
  req: express.Request,
) {
  permit(s, managers);
  const doc = await visibleDocument(tx, s, String(req.params.id));
  if (doc.kind === "global") permit(s, ["owner"]);
  requireRecentAuth(s);
  const p = cancelInput.parse(raw);
  if (doc.kind === "global" && p.motive !== "02")
    throw new DomainError("cfdi_invalid_motive", 400);
  // A credit note is corrected, never just canceled: canceling it with 02/03 would leave its
  // refund without a CFDI (CFDI-MONEY-1, SAT-2). Motive 01 asks again for a substitution's.
  if (doc.kind === "egreso" && p.motive !== "01")
    throw new DomainError("cfdi_not_cancellable", 409);
  await once(
    tx,
    s,
    p.operationId,
    "cfdi.cancel",
    { ...p, documentId: doc.id },
    async () => {
      await cancellable(tx, s, doc);
      // Motive 01 asks again for a substitution's cancellation (the register's "vuelve a
      // solicitar la cancelación", CFDI-R3-1): the substitute is already valid, so cfdi_cancel
      // sends it at once, and onCanceled hands it the ticket.
      const substitute =
        p.motive === "01" ? await waitingSubstitute(tx, doc.id) : null;
      if (p.motive === "01" && !substitute)
        throw new DomainError("cfdi_substitute_missing", 409);
      const cancellationId = randomUUID();
      await tx`
      insert into cfdi_cancellations(tenant_id, id, document_id, motive, substitute_document_id, source,
        reason, requested_by)
      values (${s.tenantId}, ${cancellationId}, ${doc.id}, ${p.motive}, ${substitute},
        ${substitute ? "substitution" : "staff"}, ${p.reason}, ${s.employeeId})`;
      await cfdiEnqueue(tx, s.tenantId, {
        kind: "cfdi_cancel",
        dedupeKey: dedupe.cancel(cancellationId),
        payload: { cancellationId },
      });
      await insertEvent(
        tx,
        s.tenantId,
        doc.id,
        "cancel_queued",
        substitute ? { motive: p.motive, substitute } : { motive: p.motive },
        s.employeeId,
      );
      await audit(tx, s, "cfdi.cancel.requested", doc.id, {
        documentId: doc.id,
        motive: p.motive,
        reason: p.reason,
      });
      return { ok: true };
    },
  );
  return staffView(tx, doc.id, s);
}

export async function substituteDocument(
  tx: Tx,
  s: Session,
  raw: unknown,
  req: express.Request,
) {
  permit(s, managers);
  const doc = await visibleDocument(tx, s, String(req.params.id));
  requireRecentAuth(s);
  if (doc.kind === "egreso") return substituteCreditNote(tx, s, doc, raw);
  const p = substituteInput.parse(raw);
  if (doc.kind !== "invoice")
    throw new DomainError("cfdi_not_substitutable", 409);
  receptorOrThrow(p.receptor, false);
  const r = await once(
    tx,
    s,
    p.operationId,
    "cfdi.substitute",
    { ...p, documentId: doc.id },
    async () => {
      const state = await cfdiState(tx);
      requireCfdi(state, { needEnabled: true, needReady: true });
      const current = await cancellable(tx, s, doc);
      // A substitute that is still unfinished (typically valid after a rejected, expired or
      // refused motive-01 cancellation) keeps this one: a second substitute would leave two valid
      // CFDIs for the sale and the first one's claim pending forever (CFDI-R3-1). The way out is
      // asking again (motive 01 with that substitute) or canceling the substitute.
      if (await waitingSubstitute(tx, doc.id, UNFINISHED_SUBSTITUTE))
        throw new DomainError("cfdi_substitution_pending", 409);
      const [claim] = await tx`
        select ticket_id from cfdi_document_tickets where document_id = ${doc.id} and state = 'active'`;
      if (!claim) throw new DomainError("cfdi_not_valid", 409);
      const t = await ticketFacts(tx, claim.ticket_id, current.mode);
      if (
        needsCardForm(t.payload.payments) &&
        !p.cardForm &&
        !current.cardPaymentForm
      )
        throw new DomainError("cfdi_card_form_required", 400);
      const substitute = randomUUID();
      await tx`
        insert into cfdi_documents(tenant_id, id, kind, source, mode, status, replaces_document_id,
          receptor, receptor_rfc, card_payment_form, confirm_pre_start, created_by)
        values (${s.tenantId}, ${substitute}, 'invoice', 'staff', ${current.mode}, 'queued', ${doc.id},
          ${tx.json(p.receptor as never)}, ${p.receptor.rfc}, ${p.cardForm ?? current.cardPaymentForm},
          true, ${s.employeeId})`;
      await tx`
        insert into cfdi_document_tickets(tenant_id, document_id, ticket_id, mode, state)
        values (${s.tenantId}, ${substitute}, ${claim.ticket_id}, ${current.mode}, 'pending')`;
      await tx`
        insert into cfdi_cancellations(tenant_id, id, document_id, motive, substitute_document_id, source,
          reason, requested_by)
        values (${s.tenantId}, ${randomUUID()}, ${doc.id}, '01', ${substitute}, 'substitution',
          ${p.reason}, ${s.employeeId})`;
      await enqueueStamp(tx, s.tenantId, substitute, {
        maxAttempts: INVOICE_MAX_ATTEMPTS,
      });
      await insertEvent(
        tx,
        s.tenantId,
        substitute,
        "requested",
        { source: "staff", replaces: doc.id },
        s.employeeId,
      );
      await insertEvent(
        tx,
        s.tenantId,
        doc.id,
        "substitution_requested",
        { substitute },
        s.employeeId,
      );
      await audit(tx, s, "cfdi.substitute.requested", doc.id, {
        documentId: doc.id,
        substitute,
      });
      return { documentId: substitute };
    },
  );
  return staffView(tx, r.documentId, s);
}

/**
 * Corrects a credit note (CFDI-SAT-2): a substitute credit note for the same refund and parent,
 * related 04 to this one, with the FormaPago the manager chose; once it stamps, this one is
 * canceled with motive 01 (egresos need no receptor acceptance). Same guards as an invoice's
 * substitution, plus a parent that is still valid with no cancellation open.
 */
async function substituteCreditNote(
  tx: Tx,
  s: Session,
  doc: DocumentRow,
  raw: unknown,
) {
  const p = egresoSubstituteInput.parse(raw);
  const r = await once(
    tx,
    s,
    p.operationId,
    "cfdi.substitute",
    { ...p, documentId: doc.id },
    async () => {
      const state = await cfdiState(tx);
      requireCfdi(state, { needEnabled: true, needReady: true });
      const current = await cancellable(tx, s, doc);
      if (await waitingSubstitute(tx, doc.id, UNFINISHED_SUBSTITUTE))
        throw new DomainError("cfdi_substitution_pending", 409);
      const [parent] = await tx`
        select p.status, exists (select 1 from cfdi_cancellations x where x.tenant_id = p.tenant_id
          and x.document_id = p.id and x.status in ('queued','requested')) as canceling
        from cfdi_documents p where p.id = ${current.parentDocumentId}`;
      if (!parent || parent.status !== "valid" || parent.canceling)
        throw new DomainError("cfdi_credit_note_parent_not_valid", 409);
      const substitute = randomUUID();
      await tx`
        insert into cfdi_documents(tenant_id, id, kind, source, mode, status, replaces_document_id,
          parent_document_id, refund_id, receptor, receptor_rfc, payment_form_override, created_by)
        values (${s.tenantId}, ${substitute}, 'egreso', 'staff', ${current.mode}, 'queued', ${doc.id},
          ${current.parentDocumentId}, ${current.refundId},
          ${current.receptor ? tx.json(current.receptor as never) : null}, ${current.receptorRfc},
          ${p.paymentForm}, ${s.employeeId})`;
      await tx`
        insert into cfdi_cancellations(tenant_id, id, document_id, motive, substitute_document_id, source,
          reason, requested_by)
        values (${s.tenantId}, ${randomUUID()}, ${doc.id}, '01', ${substitute}, 'substitution',
          ${p.reason}, ${s.employeeId})`;
      await enqueueStamp(tx, s.tenantId, substitute, {
        maxAttempts: INVOICE_MAX_ATTEMPTS,
      });
      await insertEvent(
        tx,
        s.tenantId,
        substitute,
        "requested",
        { source: "staff", replaces: doc.id },
        s.employeeId,
      );
      await insertEvent(
        tx,
        s.tenantId,
        doc.id,
        "substitution_requested",
        { substitute },
        s.employeeId,
      );
      await audit(tx, s, "cfdi.substitute.requested", doc.id, {
        documentId: doc.id,
        substitute,
      });
      return { documentId: substitute };
    },
  );
  return staffView(tx, r.documentId, s);
}

export async function retryDocument(
  tx: Tx,
  s: Session,
  raw: unknown,
  req: express.Request,
) {
  permit(s, managers);
  const doc = await visibleDocument(tx, s, String(req.params.id));
  const p = operationInput.parse(raw);
  await once(
    tx,
    s,
    p.operationId,
    "cfdi.retry",
    { ...p, documentId: doc.id },
    async () => {
      const current = (await loadDocument(tx, doc.id))!;
      if (isStuck(current))
        await enqueueStamp(tx, s.tenantId, current.id, {
          maxAttempts:
            current.kind === "global"
              ? GLOBAL_MAX_ATTEMPTS
              : INVOICE_MAX_ATTEMPTS,
          suffix:
            ":r" + (current.attempts + 1) + ":" + p.operationId.slice(0, 8),
        });
      else if (current.status === "failed" && current.kind === "global")
        await cfdiEnqueue(tx, s.tenantId, {
          kind: "cfdi_global",
          dedupeKey: dedupe.run(p.operationId),
          payload: { periodKey: current.periodKey, force: true },
        });
      else if (
        current.status === "failed" &&
        current.kind === "egreso" &&
        current.refundId
      )
        await cfdiEnqueue(tx, s.tenantId, {
          kind: "cfdi_refund",
          dedupeKey: dedupe.refundForce(current.refundId, p.operationId),
          payload: { refundId: current.refundId, force: true },
        });
      else {
        // A state whose job is gone (CFDI-R2): poll the provider again, resend the
        // cancellation or the reissue step, or fetch the files. A cancellation, reissue or
        // delivery that is still queued is left alone; a poll always runs now.
        const action = await recoveryAction(tx, current);
        if (!action || action.kind === "release")
          throw new DomainError("cfdi_not_retryable", 409);
        await enqueueRecovery(tx, s.tenantId, current, action, {
          tag:
            "r" +
            p.operationId
              .replace(/[^0-9a-f]/gi, "")
              .toLowerCase()
              .slice(0, 12),
          unlessLive: action.kind !== "reconcile",
          worker: false,
        });
      }
      await insertEvent(
        tx,
        s.tenantId,
        current.id,
        "retry_requested",
        {},
        s.employeeId,
      );
      await audit(tx, s, "cfdi.document.retried", current.id, {
        documentId: current.id,
      });
      return { ok: true };
    },
  );
  return staffView(tx, doc.id, s);
}

// ---------------------------------------------------------------------------------------------
// Globals and alerts
// ---------------------------------------------------------------------------------------------

export async function listGlobals(
  tx: Tx,
  s: Session,
  req: express.Request,
): Promise<GlobalPeriodView[]> {
  permit(s, managers);
  const q = globalsQuery.parse(query(req));
  if (q.to < q.from || daysBetween(q.from, q.to) > 366)
    throw new DomainError("cfdi_range_invalid", 400);
  const state = await cfdiState(tx);
  if (!state.settings) return [];
  await tx`select set_config('statement_timeout', '30s', true)`;
  const mode = q.mode ?? state.settings.mode;
  return periodViews(tx, {
    from: q.from,
    to: q.to,
    mode,
    canRun: true,
    globalAuto: state.settings.globalAuto,
    modeFrom: modeStart(state.settings, mode),
  });
}

export async function runGlobals(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = globalsRunInput.parse(raw);
  await once(tx, s, p.operationId, "cfdi.globals.run", p, async () => {
    const state = await cfdiState(tx);
    requireCfdi(state, { needEnabled: true });
    if (p.periodKey) {
      const [period] = await tx`
        select closes_at from cfdi_global_periods
        where mode = ${state.settings.mode} and period_key = ${p.periodKey}`;
      if (!period || Date.parse(period.closes_at) > Date.now())
        throw new DomainError("cfdi_period_not_closed", 409);
    }
    await cfdiEnqueue(tx, s.tenantId, {
      kind: "cfdi_global",
      dedupeKey: dedupe.run(p.operationId),
      payload: p.periodKey ? { periodKey: p.periodKey, force: true } : {},
    });
    await audit(tx, s, "cfdi.globals.run", s.tenantId, {
      periodKey: p.periodKey,
    });
    return { ok: true };
  });
  const settings = await loadSettings(tx);
  if (!settings) return [];
  const day = today(s);
  const from = globalPeriodFor(day, "month").from;
  return periodViews(tx, {
    from: plusMonths(from, -2),
    to: day,
    mode: settings.mode,
    canRun: true,
    globalAuto: settings.globalAuto,
    modeFrom: modeStart(settings, settings.mode),
  });
}

function plusMonths(date: string, n: number): string {
  const [y, m] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}

export async function getAlerts(tx: Tx, s: Session) {
  permit(s, managers);
  const state = await cfdiState(tx);
  if (!state.settings)
    return {
      overdueGlobals: 0,
      failedDocuments: 0,
      stuckDocuments: 0,
      rejectedSubstitutions: 0,
      csdExpiresSoon: false,
    };
  return attentionOf(await attention(tx));
}
