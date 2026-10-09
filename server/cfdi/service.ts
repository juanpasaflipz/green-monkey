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
  periodicityChangeBlock,
  periodicityOn,
  PERIODICITY_REBUILD_WAIT_MS,
  substituteInput,
  egresoSubstituteInput,
  cancellationAllowed,
  type CfdiSettingsView,
  type CfdiTicketView,
  type GlobalPeriodView,
  type PendingSelfInvoice,
  type Periodicity,
  type PeriodicityChangeBlock,
  type Receptor,
  type SelfInvoiceTerms,
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
  graceMinutes,
  hasCreditNotes,
  insertEvent,
  isStuck,
  listDocuments,
  loadDocument,
  loadSettings,
  periodicityChangeBlocked,
  platform,
  periodViews,
  printedDeadlineCut,
  selfInvoiceChangeFrom,
  selfInvoiceWindow,
  sharedIssuerComplete,
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
  type SelfInvoiceSettings,
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

/** Two self-invoicing terms are the same (a pending change's `from` aside). */
function sameTerms(
  a: SelfInvoiceTerms,
  b: SelfInvoiceTerms | null | undefined,
): boolean {
  return (
    !!b && a.policy === b.policy && a.days === b.days && a.reissue === b.reissue
  );
}

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
  let periodicityDeferred: NonNullable<
    CfdiSettingsView["settings"]
  >["periodicityDeferred"] = null;
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
    // Why the pending periodicity waits (CFDIFIX-5): the latest deferral, while it is still the
    // pending change (the owner may have chosen again since).
    if (settings.nextPeriodicity) {
      const [d] = await tx`
        select created_at, detail from cfdi_events
        where document_id is null and kind = 'periodicity_deferred'
        order by created_at desc limit 1`;
      const x = d?.detail as Record<string, unknown> | undefined;
      if (
        x &&
        x.from === settings.globalPeriodicity &&
        x.to === settings.nextPeriodicity &&
        x.nextFrom === settings.nextPeriodicityFrom &&
        typeof x.reason === "string"
      )
        periodicityDeferred = {
          at: new Date(d.created_at).toISOString(),
          from: x.from as Periodicity,
          to: x.to as Periodicity,
          nextFrom: x.nextFrom as string,
          reason: x.reason as PeriodicityChangeBlock,
          source: x.source === "tick" ? "tick" : "save",
        };
    }
  }
  const alerts = settings ? await attention(tx) : null;
  const minFrom = settings ? currentPeriodStart(settings, day) : day;
  const csdOk =
    org?.csdStatus === "valid" &&
    !!org.csdValidUntil &&
    Date.parse(org.csdValidUntil) > Date.now() + 7 * 86_400_000;
  // Shared sandbox (LD-51 F3): the issuer is the platform's test organization, as the worker read
  // it from Facturapi; the restaurant's profile is not used to stamp.
  const shared = org?.source === "shared_sandbox";
  const sharedIssuer = shared
    ? {
        legalName: st.platform?.sharedIssuer?.legalName ?? null,
        taxId: st.platform?.sharedIssuer?.taxId ?? org.legalTaxId,
        regime: st.platform?.sharedIssuer?.regime ?? null,
        postalCode: st.platform?.sharedIssuer?.postalCode ?? null,
        // Stamping takes the shared organization's facts as a whole or not at all
        // (stampingFacts, CFDIFIX-FISCAL-6): the panel says which taxpayer stamps (UX-6).
        complete: sharedIssuerComplete(st.platform?.sharedIssuer ?? null),
      }
    : null;
  return {
    ...status,
    canEdit: s.role === "owner",
    globalGraceMinutes: graceMinutes(st.platform),
    businessDate: day,
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
          platformPaymentForm: settings.platformPaymentForm,
          defaultUse: settings.defaultUse,
          selfInvoiceEnabled: settings.selfInvoiceEnabled,
          selfInvoicePolicy: settings.selfInvoicePolicy,
          selfInvoiceDays: settings.selfInvoiceDays,
          portalReissueGlobal: settings.portalReissueGlobal,
          selfInvoicePending: settings.nextSelfInvoice,
          supportEmail: settings.supportEmail,
          version: settings.version,
          updatedAt: settings.updatedAt,
          updatedByName,
          resicoMonthly: facts.regime === "626",
          periodicityDeferred,
        }
      : null,
    organization: org
      ? {
          source: org.source,
          status: org.status,
          provisioned: !!org.providerOrgId,
          errorCode: org.errorCode,
          // The RFC Facturapi reports for the issuer, never the profile's before it does: an
          // organization still resolving shows it as pending (LD-51 F9).
          taxId: sharedIssuer ? sharedIssuer.taxId : org.legalTaxId,
          sharedIssuer,
          legalSyncedVersion: org.legalSyncedVersion,
          fiscalProfileVersion: facts.version,
          csd: {
            // A certificate past its end date reads expired before a refresh marks it (UX-16).
            status:
              org.csdStatus === "valid" &&
              !!org.csdValidUntil &&
              Date.parse(org.csdValidUntil) <= Date.now()
                ? "expired"
                : org.csdStatus,
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
    // While paused a tick would only exit and use up the bucket's key (CFDI-WORKER-4). The
    // abandoned-CSD sweep still runs: the tick does it before it checks the switch.
    await cfdiEnqueue(tx, s.tenantId, {
      kind: "cfdi_global",
      dedupeKey: state.settings.enabled
        ? dedupe.tickEnsure(now)
        : `${dedupe.tickEnsure(now)}:paused`,
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
    // The periodicity is chosen at activation (LD-51 F2); RESICO (626) is monthly (D4, SAT-4).
    const periodicity =
      facts.regime === "626" ? ("month" as const) : p.globalPeriodicity;
    // A concurrent activation (another operationId) may have won: answer a conflict, not a 500.
    const created = await tx`
      insert into cfdi_settings(tenant_id, test_from, global_periodicity, updated_by)
      values (${s.tenantId}, ${today(s)}::date, ${periodicity}, ${s.employeeId})
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
      globalPeriodicity: periodicity,
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
    // RESICO (626) issues monthly globals (decision D4): the periodicity is coerced, never refused,
    // so a restaurant that became RESICO can still save its other settings (CFDI-SAT-4, UX-1).
    const wanted =
      facts.regime === "626" ? ("month" as const) : p.globalPeriodicity;
    const day = today(s);
    const effective = periodicityOn(day, before);
    const grace = graceMinutes(await platform(tx));
    const now = new Date();
    // 1. Self-invoicing first (CFDIFIX-R2-4): the periodicity guard below reads the terms this save
    // stores. A change (window, days or the portal's reissue) is guarded like a periodicity change
    // (LD-55 CFDIFIX-FISCAL-5 / UX-4): it applies at once unless it brings forward the deadline of
    // a receipt already printed, or that a terminal not refreshed yet may print today
    // (CFDIFIX-R2-5); then it waits until the first business day after the latest such deadline
    // (selfInvoiceChangeFrom), and receipts printed meanwhile print the deadline both terms allow
    // (effectiveSelfInvoiceDeadline's pending). Choosing the terms in force cancels a waiting
    // change.
    const inForce: SelfInvoiceTerms = {
      policy: before.selfInvoicePolicy,
      days: before.selfInvoiceDays,
      reissue: before.portalReissueGlobal,
    };
    const wantedTerms: SelfInvoiceTerms = {
      policy: p.selfInvoicePolicy,
      days: p.selfInvoiceDays,
      reissue: p.portalReissueGlobal,
    };
    let terms = wantedTerms;
    let selfInvoiceNext: PendingSelfInvoice | null = null;
    if (!sameTerms(wantedTerms, inForce)) {
      const from = await selfInvoiceChangeFrom(
        tx,
        before,
        wantedTerms,
        facts,
        grace,
        now,
      );
      if (from) {
        terms = inForce;
        selfInvoiceNext = { ...wantedTerms, from };
      }
    }
    const stored: SelfInvoiceSettings = {
      selfInvoicePolicy: terms.policy,
      selfInvoiceDays: terms.days,
      portalReissueGlobal: terms.reissue,
      nextSelfInvoice: selfInvoiceNext,
    };
    // Nothing printed before the save ends earlier than it said (CFDIFIX-R2-2): what this save
    // stores is checked against every deadline receipts print now, the waiting change's included.
    // Cancelling a waiting change that lengthened some deadlines, or replacing it, would cut the
    // receipts printed while it waited (the guard above compares the wanted terms alone): refused,
    // and the panel names the waiting change's date, from which its terms are in force and a new
    // change is guarded as any other.
    if (await printedDeadlineCut(tx, before, stored, facts, grace, now))
      throw new DomainError("cfdi_self_invoice_pending_printed", 409);
    // 2. The periodicity. A change applies at once while the current month is unshaped: no
    // global document of its periods, no unclaimed ticket in a period, old or new, past its
    // 24-hour deadline, and no unclaimed ticket of the month whose self-invoicing deadline (the one
    // its receipt printed: the terms in force with the change that waits) the change, with the
    // terms this save stores, would bring forward (LD-51 F2, CFDIFIX-1, CFDIFIX-R2-3/R2-4;
    // periodicityChangeBlock). The tick then rebuilds the month's period rows. Otherwise it
    // applies from the first day of next month and the month keeps one periodicity
    // (CFDI-R2-1); the reason is recorded for the panel (periodicity_deferred). Choosing the
    // periodicity in force cancels a pending change (one that is already in force today stays:
    // the tick promotes it); a deferred change first promotes a pending one already in force
    // today, so the month keeps the periodicity it is under (CFDIFIX-FISCAL-2). The settings row
    // is locked FOR UPDATE above; the tick's rebuild and the global builder take it too, so
    // neither runs on a month this decision reads differently.
    let periodicity = before.globalPeriodicity;
    let next = before.nextPeriodicity;
    let nextFrom = before.nextPeriodicityFrom;
    let rebuild = false;
    let shortens = false;
    let deferred: PeriodicityChangeBlock | null = null;
    if (wanted === effective) {
      if (!(nextFrom && nextFrom <= day)) {
        next = null;
        nextFrom = null;
      }
    } else {
      deferred = await periodicityChangeBlocked(
        tx,
        before,
        wanted,
        day,
        facts,
        grace,
        { now, after: stored },
      );
      if (deferred) {
        periodicity = effective;
        next = wanted;
        nextFrom = firstOfNextMonth(day);
      } else {
        periodicity = wanted;
        next = null;
        nextFrom = null;
        rebuild = true;
        // Whether the change brings forward the deadline of a ticket sold today: a terminal that
        // has not refreshed its status yet prints the old one (CFDIFIX-CONCURRENCY-2), under the
        // terms in force with the change that waits; after the save, the terms it stores.
        shortens =
          periodicityChangeBlock({
            hasGlobals: false,
            dates: [day],
            from: effective,
            to: wanted,
            timezone: facts.timezone,
            cutoff: facts.cutoff,
            selfInvoice: { ...selfInvoiceWindow(before), graceMinutes: grace },
            after: selfInvoiceWindow(stored),
            now,
          }) === "deadline";
      }
    }
    await tx`
      update cfdi_settings set enabled = ${p.enabled}, global_periodicity = ${periodicity},
        next_periodicity = ${next}, next_periodicity_from = ${nextFrom}::date, global_auto = ${p.globalAuto},
        concept_mode = ${p.conceptMode}, concept_description = ${p.conceptDescription},
        card_payment_form = ${p.cardPaymentForm}, default_use = ${p.defaultUse},
        platform_payment_form = ${p.platformPaymentForm ?? before.platformPaymentForm},
        self_invoice_enabled = ${p.selfInvoiceEnabled}, self_invoice_policy = ${terms.policy},
        self_invoice_days = ${terms.days}, portal_reissue_global = ${terms.reissue},
        next_self_invoice_policy = ${selfInvoiceNext?.policy ?? null},
        next_self_invoice_days = ${selfInvoiceNext?.days ?? null},
        next_portal_reissue_global = ${selfInvoiceNext?.reissue ?? null},
        next_self_invoice_from = ${selfInvoiceNext?.from ?? null}::date,
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
      platformPaymentForm: p.platformPaymentForm ?? before.platformPaymentForm,
      defaultUse: p.defaultUse,
      selfInvoiceEnabled: p.selfInvoiceEnabled,
      selfInvoicePolicy: terms.policy,
      selfInvoiceDays: terms.days,
      portalReissueGlobal: terms.reissue,
      selfInvoicePending: selfInvoiceNext,
    };
    const was = {
      enabled: before.enabled,
      globalPeriodicity: before.globalPeriodicity,
      nextPeriodicity: before.nextPeriodicity,
      nextPeriodicityFrom: before.nextPeriodicityFrom,
      globalAuto: before.globalAuto,
      conceptMode: before.conceptMode,
      cardPaymentForm: before.cardPaymentForm,
      platformPaymentForm: before.platformPaymentForm,
      defaultUse: before.defaultUse,
      selfInvoiceEnabled: before.selfInvoiceEnabled,
      selfInvoicePolicy: before.selfInvoicePolicy,
      selfInvoiceDays: before.selfInvoiceDays,
      portalReissueGlobal: before.portalReissueGlobal,
      selfInvoicePending: before.nextSelfInvoice,
    };
    await audit(tx, s, "cfdi.settings.saved", s.tenantId, {
      before: was,
      after,
    });
    // A change stored as pending (again, or anew) says why it did not apply at once (CFDIFIX-5).
    if (
      deferred &&
      (before.nextPeriodicity !== next ||
        before.nextPeriodicityFrom !== nextFrom)
    )
      await insertEvent(
        tx,
        s.tenantId,
        null,
        "periodicity_deferred",
        {
          from: effective,
          to: wanted,
          nextFrom,
          reason: deferred,
          source: "save",
        },
        s.employeeId,
      );
    // A self-invoicing change that waits says until when and why (the panel shows it).
    if (
      selfInvoiceNext &&
      !(
        sameTerms(selfInvoiceNext, before.nextSelfInvoice) &&
        selfInvoiceNext.from === before.nextSelfInvoice?.from
      )
    )
      await insertEvent(
        tx,
        s.tenantId,
        null,
        "self_invoice_deferred",
        { to: wantedTerms, from: selfInvoiceNext.from },
        s.employeeId,
      );
    await cfdiEnqueue(tx, s.tenantId, {
      kind: "cfdi_global",
      dedupeKey: dedupe.tickEnsure(new Date()),
      payload: {},
    });
    // A periodicity applied at once: the tick rebuilds the month's period rows, with a key of its
    // own (the bucket's may be used up by a tick that already ran). The event records when it
    // applied: the rebuild re-checks the change as of that moment (CFDIFIX-CONCURRENCY-3), and a
    // change that brings forward a deadline of today waits until every terminal has refreshed
    // its status, so the re-check sees the tickets they printed with the old one
    // (CFDIFIX-CONCURRENCY-2; PERIODICITY_REBUILD_WAIT_MS, the tick skips the rebuild until then).
    if (rebuild) {
      const rebuildAt = new Date(
        Date.now() + (shortens ? PERIODICITY_REBUILD_WAIT_MS : 0),
      );
      await insertEvent(
        tx,
        s.tenantId,
        null,
        "periodicity_applied",
        {
          from: effective,
          to: wanted,
          shortens,
          rebuildAt: rebuildAt.toISOString(),
        },
        s.employeeId,
      );
      await cfdiEnqueue(tx, s.tenantId, {
        kind: "cfdi_global",
        dedupeKey: `tick:periodicity:${before.version + 1}`,
        payload: {},
        runAt: shortens ? rebuildAt : undefined,
      });
    }
    // Turned back on: the chain ended while paused, and the bucket's key may be used up by a
    // tick that ran (and exited) while paused, so the restart has a key of its own (WORKER-4).
    if (p.enabled && !before.enabled)
      await cfdiEnqueue(tx, s.tenantId, {
        kind: "cfdi_global",
        dedupeKey: `tick:enabled:${before.version + 1}`,
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
    // A paused restaurant has no tick chain; the tick's abandoned-upload sweep must still close
    // this upload if its job is cancelled or lost (CFDI-INT-7): a paused tick re-arms hourly
    // while an upload is open.
    if (!state.settings.enabled) await ensureTick(tx, s.tenantId, "csd");
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
  // CFF art. 29-A (CFDI-SAT-3): SAT refuses the cancellation after the month the annual return
  // of the CFDI's year is due (a substitution ends in one too).
  const facts = await fiscalFacts(tx);
  if (!cancellationAllowed(current.stampedAt, facts.rfc, facts.timezone))
    throw new DomainError("cfdi_cancel_deadline_passed", 409);
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
          parent_document_id, refund_id, credit_ticket_id, receptor, receptor_rfc, payment_form_override,
          created_by)
        values (${s.tenantId}, ${substitute}, 'egreso', 'staff', ${current.mode}, 'queued', ${doc.id},
          ${current.parentDocumentId}, ${current.refundId}, ${current.creditTicketId},
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
