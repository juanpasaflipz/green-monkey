/**
 * cfdi_org (spec §4.8.1): the issuer organization lifecycle at Facturapi.
 *   provision  sandbox: adopt the shared test organization; own: find-or-create the organization
 *              (no idempotency key exists: search by its marker name first), send the legal data,
 *              fetch and seal its test key, then refresh;
 *   refresh    organization facts (production readiness, pending steps, certificate);
 *   sync_legal legal data from the fiscal profile (also run inline before a stamp);
 *   go_live    re-check readiness, create and seal the live key once, switch settings to live.
 * Network calls run outside any transaction; every write re-reads state (idempotent).
 */
import { randomUUID } from "node:crypto";
import type { JobContext, JobOutcome } from "../../jobs.js";
import type { Tx } from "../../db.js";
import { cfdiEnqueue, dedupe, retryOrExhaust } from "../jobs.js";
import { keyKindOf, type FOrganization } from "../facturapi.js";
import type { FLegalInput } from "../facturapi-schema.js";
import {
  fiscalFacts,
  loadOrganization,
  loadSettings,
  type FiscalFacts,
  type OrganizationRow,
  type SharedIssuer,
} from "../store.js";
import { sealSecret } from "../vault.js";
import {
  AUTH_CODES,
  classify,
  event,
  markKeyInvalid,
  runtimeOr,
} from "./common.js";
import { userKey, type CfdiRuntime } from "./runtime.js";

type Action = "provision" | "refresh" | "sync_legal" | "go_live";

/** The organization's name at Facturapi: findable after a lost create response. */
export function organizationMarker(
  tradeName: string,
  tenantId: string,
): string {
  return `${tradeName.trim().slice(0, 80)} · GM-${tenantId.slice(0, 8)}`;
}

const cut = (s: string | undefined, n: number) =>
  s && s.trim() ? s.trim().slice(0, n) : undefined;

/** OrganizationLegalInput from the fiscal profile (name and legal_name ≤ 100, spec R14). */
export function legalFrom(f: FiscalFacts): FLegalInput {
  if (!f.legalName || !f.regime || !f.postalCode)
    throw Object.assign(new Error("cfdi_fiscal_profile_incomplete"), {
      code: "cfdi_fiscal_profile_incomplete",
    });
  const address: FLegalInput["address"] = { zip: f.postalCode };
  const street = cut(f.address.street, 100);
  const neighborhood = cut(f.address.neighborhood, 80);
  const municipality = cut(f.address.municipality, 80);
  const state = cut(f.address.state, 60);
  if (street) address.street = street;
  if (neighborhood) address.neighborhood = neighborhood;
  if (municipality) address.municipality = municipality;
  if (state) address.state = state;
  return {
    name: f.tradeName.trim().slice(0, 100) || f.legalName.slice(0, 100),
    legal_name: f.legalName.slice(0, 100),
    tax_system: f.regime,
    address,
  };
}

const RFC = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

/**
 * The shared sandbox organization's legal data as Facturapi reports it (LD-51 F3), each fact only
 * when it has the shape cfdi_platform accepts (036), else null: the stamp then falls back to the
 * restaurant's own fact for that one.
 */
export function sharedIssuerOf(org: FOrganization): SharedIssuer {
  const legal = org.legal;
  const name = legal?.legal_name?.trim() ?? "";
  const rfc = legal?.tax_id?.trim().toUpperCase() ?? "";
  const regime = legal?.tax_system?.trim() ?? "";
  const zip = legal?.address?.zip?.trim() ?? "";
  return {
    legalName: name && name.length <= 300 ? name : null,
    taxId: RFC.test(rfc) ? rfc : null,
    regime: /^\d{3}$/.test(regime) ? regime : null,
    postalCode: /^\d{5}$/.test(zip) ? zip : null,
  };
}

/** Publishes the shared sandbox issuer on cfdi_platform (no tenant data; the worker's row). */
export async function publishSharedIssuer(
  tx: Tx,
  issuer: SharedIssuer,
): Promise<void> {
  await tx`
    update cfdi_platform set shared_legal_name = ${issuer.legalName}, shared_tax_id = ${issuer.taxId},
      shared_tax_system = ${issuer.regime}, shared_postal_code = ${issuer.postalCode}
    where id = 1 and provider = 'sandbox_shared'`;
}

/** Organization facts Facturapi reports, as stored on cfdi_organizations. */
async function storeFacts(
  tx: Tx,
  org: FOrganization,
  o: { keepProcessing: boolean },
) {
  const cert = org.certificate;
  const until = cert?.expires_at ? new Date(cert.expires_at) : null;
  const csdStatus = cert?.has_certificate
    ? until && until.getTime() <= Date.now()
      ? "expired"
      : "valid"
    : "missing";
  await tx`
    update cfdi_organizations set
      provider_org_id = ${org.id},
      status = 'ready', error_code = null,
      production_ready = ${org.is_production_ready},
      pending_steps = ${tx.json(org.pending_steps.slice(0, 20).map((s) => ({ type: String(s.type).slice(0, 60), description: String(s.description ?? "").slice(0, 500) })) as never)},
      legal_tax_id = coalesce(${org.legal?.tax_id ?? null}, legal_tax_id),
      csd_status = case when ${o.keepProcessing} and csd_status = 'processing' then csd_status
                        when csd_status = 'error' and ${csdStatus} = 'missing' then csd_status
                        else ${csdStatus} end,
      csd_serial = coalesce(${cert?.serial_number ?? null}, csd_serial),
      csd_valid_until = coalesce(${until}, csd_valid_until),
      checked_at = now()`;
}

async function failOrg(tx: Tx, ctx: JobContext, code: string, detail = {}) {
  await tx`update cfdi_organizations set status = 'error', error_code = ${code}`;
  await event(tx, ctx, null, "org_error", { code, ...detail });
}

async function refresh(
  rt: CfdiRuntime,
  ctx: JobContext,
  org: OrganizationRow,
): Promise<FOrganization | null> {
  if (org.source === "shared_sandbox") {
    if (!rt.config.testKey) return null;
    const me = await rt.client.me({ kind: "test", secret: rt.config.testKey });
    await ctx.tenant(async (tx) => {
      await storeFacts(tx, me, { keepProcessing: true });
      // The stamping issuer of every restaurant in this mode (LD-51 F3), kept current.
      await publishSharedIssuer(tx, sharedIssuerOf(me));
    });
    return me;
  }
  if (!org.providerOrgId) return null;
  const fetched = await rt.client.getOrganization(
    userKey(rt),
    org.providerOrgId,
  );
  await ctx.tenant((tx) => storeFacts(tx, fetched, { keepProcessing: true }));
  return fetched;
}

/** Sends the fiscal profile's legal data and records the profile version sent. */
export async function syncLegal(
  rt: CfdiRuntime,
  ctx: JobContext,
  orgId: string,
  facts: FiscalFacts,
): Promise<void> {
  await rt.client.updateLegal(userKey(rt), orgId, legalFrom(facts));
  await ctx.tenant(
    (tx) =>
      tx`update cfdi_organizations set legal_synced_version = ${facts.version}`,
  );
}

async function provision(
  rt: CfdiRuntime,
  ctx: JobContext,
  org: OrganizationRow,
  facts: FiscalFacts,
): Promise<void> {
  const tenantId = ctx.job.tenantId;
  if (org.source === "shared_sandbox") {
    await refresh(rt, ctx, org);
    return;
  }
  const user = userKey(rt);
  let orgId = org.providerOrgId;
  if (!orgId) {
    const marker = organizationMarker(facts.tradeName, tenantId);
    // POST /organizations has no idempotency key: a retry after a lost response finds it by name.
    const found = (await rt.client.listOrganizations(user, marker)).find(
      (o) =>
        o.legal?.name === marker || (o as { name?: unknown }).name === marker,
    );
    const created =
      found ?? (await rt.client.createOrganization(user, { name: marker }));
    orgId = created.id;
    await ctx.tenant(
      (tx) => tx`
        update cfdi_organizations set provider_org_id = ${orgId}
        where provider_org_id is null`,
    );
  }
  await syncLegal(rt, ctx, orgId, facts);
  const current = await ctx.tenant((tx) => loadOrganization(tx));
  if (current && !current.testSecretId && rt.ring) {
    const secret = await rt.client.getTestApiKey(user, orgId);
    if (keyKindOf(secret) !== "test")
      throw Object.assign(new Error("cfdi_key_prefix"), {
        code: "cfdi_key_prefix",
      });
    const id = randomUUID();
    const sealed = await sealSecret(rt.ring, secret, {
      tenantId,
      purpose: "org_test_key",
      id,
    });
    await ctx.tenant(async (tx) => {
      const [row] =
        await tx`select test_secret_id from cfdi_organizations for update`;
      if (row?.test_secret_id) return;
      await tx`
        insert into cfdi_secrets(tenant_id, id, purpose, kid, payload_secret)
        values (${tenantId}, ${id}, 'org_test_key', ${sealed.kid}, ${sealed.jwe})`;
      await tx`update cfdi_organizations set test_secret_id = ${id}`;
    });
  }
  await refresh(rt, ctx, { ...org, providerOrgId: orgId });
}

async function goLive(
  rt: CfdiRuntime,
  ctx: JobContext,
  org: OrganizationRow,
): Promise<void> {
  const tenantId = ctx.job.tenantId;
  const settings = await ctx.tenant((tx) => loadSettings(tx));
  if (!settings?.liveRequestedAt || settings.mode === "live") return;
  const fail = (reason: string) =>
    ctx.tenant(async (tx) => {
      await tx`
        update cfdi_settings set live_requested_at = null, live_requested_from = null,
          live_requested_by = null, updated_at = now()
        where live_requested_at is not null and mode = 'test'`;
      await event(tx, ctx, null, "live_failed", { reason });
    });
  if (!rt.config.liveEnabled || org.source !== "own" || !org.providerOrgId)
    return fail("platform");
  const fetched = await refresh(rt, ctx, org);
  if (!fetched?.is_production_ready)
    return fail(
      fetched?.pending_steps.map((s) => s.description || s.type).join("; ") ||
        "pending_steps",
    );
  const current = await ctx.tenant((tx) => loadOrganization(tx));
  if (current && !current.liveSecretId && rt.ring) {
    const secret = await rt.client.createLiveApiKey(
      userKey(rt),
      org.providerOrgId,
    );
    if (keyKindOf(secret) !== "live")
      throw Object.assign(new Error("cfdi_key_prefix"), {
        code: "cfdi_key_prefix",
      });
    const id = randomUUID();
    const sealed = await sealSecret(rt.ring, secret, {
      tenantId,
      purpose: "org_live_key",
      id,
    });
    await ctx.tenant(async (tx) => {
      const [row] =
        await tx`select live_secret_id from cfdi_organizations for update`;
      if (row?.live_secret_id) return;
      await tx`
        insert into cfdi_secrets(tenant_id, id, purpose, kid, payload_secret)
        values (${tenantId}, ${id}, 'org_live_key', ${sealed.kid}, ${sealed.jwe})`;
      await tx`update cfdi_organizations set live_secret_id = ${id}`;
    });
  }
  await ctx.tenant(async (tx) => {
    const [r] = await tx`
      update cfdi_settings set mode = 'live', live_from = live_requested_from,
        live_enabled_at = now(), live_enabled_by = live_requested_by,
        live_requested_at = null, live_requested_from = null, live_requested_by = null,
        version = version + 1, updated_at = now()
      where mode = 'test' and live_requested_at is not null
      returning live_from::text as live_from`;
    if (!r) return;
    await event(tx, ctx, null, "live_enabled", { liveFrom: r.live_from });
    await cfdiEnqueue(tx, tenantId, {
      kind: "cfdi_global",
      dedupeKey: dedupe.tickLive(),
      payload: {},
    });
  });
}

export async function orgJob(ctx: JobContext): Promise<JobOutcome> {
  const { rt, outcome } = await runtimeOr(ctx);
  if (!rt) return outcome;
  const action = (ctx.job.payload as { action?: Action } | null)?.action;
  const loaded = await ctx.tenant(async (tx) => ({
    org: await loadOrganization(tx),
    facts: await fiscalFacts(tx),
  }));
  const org = loaded.org;
  if (!org) return { status: "done" };
  try {
    if (action === "provision") await provision(rt, ctx, org, loaded.facts);
    else if (action === "refresh") await refresh(rt, ctx, org);
    else if (action === "sync_legal") {
      if (org.source === "own" && org.providerOrgId)
        await syncLegal(rt, ctx, org.providerOrgId, loaded.facts);
    } else if (action === "go_live") await goLive(rt, ctx, org);
    else return { status: "dead", code: "cfdi_invalid_payload" };
    return { status: "done" };
  } catch (e) {
    const failure = classify(e);
    const code = (e as { code?: unknown })?.code;
    if (code === "cfdi_fiscal_profile_incomplete") {
      await ctx.tenant((tx) =>
        failOrg(tx, ctx, "cfdi_fiscal_profile_incomplete"),
      );
      return { status: "done" };
    }
    if (AUTH_CODES.has(failure.code)) {
      await markKeyInvalid(rt, ctx, "cfdi_org_key_invalid");
      return { status: "done" };
    }
    if (!failure.retry && !failure.unknownOutcome) {
      // Refresh and go-live failures never break a ready organization.
      if (action === "provision" || action === "sync_legal")
        await ctx.tenant((tx) =>
          failOrg(tx, ctx, failure.code, {
            providerCode: failure.providerCode ?? null,
          }),
        );
      else
        await ctx.tenant((tx) =>
          event(tx, ctx, null, "org_check_failed", {
            action,
            code: failure.code,
          }),
        );
      return { status: "done" };
    }
    return retryOrExhaust(ctx.job, {
      code: failure.code,
      afterMs: failure.afterMs,
    });
  }
}
