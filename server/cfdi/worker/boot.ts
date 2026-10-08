/**
 * cfdi worker boot hook (spec §4.10): called once by server/worker.ts between its "worker areas:
 * boot hooks" markers, after the jobs login is verified and before the runner starts. It decides
 * the provider from the environment (§2.2), verifies the credentials, derives the CSD upload key
 * and publishes cfdi_platform (no tenant data) for the web to read.
 *
 * A throw here is fatal for the worker, so provider problems are handled inside: a 401 publishes
 * `disabled` with a critical alert (handlers then fail fast and retry in 15 minutes); a network
 * failure publishes the decided provider (the shared sandbox keeps its last known organization)
 * and re-verifies in the background. Logs are info/warn only (acceptance G4).
 *
 * It then restarts, in the background, the global tick chain of every restaurant with CFDI enabled
 * that has no live tick (seedGlobalTicks, review CFDI-R3): a chain that went dead while the worker
 * was down or failing resumes at the next deploy, not at the next manager visit.
 */
import type postgres from "postgres";
import { buildInfo } from "../../build-info.js";
import { tenant } from "../../db.js";
import { log } from "../../logging.js";
import { sendAlert } from "../../ops/alerts.js";
import {
  cfdiWorkerConfig,
  parseCredentialKeyring,
  type CfdiWorkerConfig,
} from "../config.js";
import { classifyFacturapiError } from "../errors.js";
import { createFacturapiClient, type FacturapiClient } from "../facturapi.js";
import { ensureTick } from "../jobs.js";
import { loadSettings, type SharedIssuer } from "../store.js";
import { uploadKeyPair } from "../vault.js";
import { sharedIssuerOf } from "./org.js";
import {
  recordProviderResponse,
  setCfdiRuntime,
  type CfdiRuntime,
} from "./runtime.js";

type AppEnv = "development" | "test" | "staging" | "production";
const RETRY_MS = 60_000;

function normalized(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env))
    out[k] = v === undefined || v.trim() === "" ? undefined : v;
  return out;
}

const NO_ISSUER: SharedIssuer = {
  legalName: null,
  taxId: null,
  regime: null,
  postalCode: null,
};

/**
 * The platform row. Since 036 it also carries the worker's global grace (the web prints the
 * self-invoicing deadline with it, LD-51 F1) and the shared sandbox organization's legal data (the
 * stamping issuer in that mode, LD-51 F3).
 */
async function publish(
  sql: postgres.Sql,
  row: {
    provider: "disabled" | "sandbox_shared" | "organizations";
    liveEnabled: boolean;
    uploadKid: string | null;
    uploadPublicJwk: JsonWebKey | null;
    sharedOrgId: string | null;
    graceMinutes: number;
    sharedIssuer: SharedIssuer;
  },
): Promise<void> {
  const issuer = row.sharedIssuer;
  await sql`
    insert into cfdi_platform(id, provider, live_enabled, upload_kid, upload_public_jwk, shared_org_id,
      global_grace_minutes, shared_legal_name, shared_tax_id, shared_tax_system, shared_postal_code,
      worker_version, updated_at)
    values (1, ${row.provider}, ${row.liveEnabled}, ${row.uploadKid},
      ${row.uploadPublicJwk ? sql.json(row.uploadPublicJwk as never) : null}, ${row.sharedOrgId},
      ${row.graceMinutes}, ${issuer.legalName}, ${issuer.taxId}, ${issuer.regime}, ${issuer.postalCode},
      ${buildInfo().version.slice(0, 100)}, now())
    on conflict (id) do update set provider = excluded.provider, live_enabled = excluded.live_enabled,
      upload_kid = excluded.upload_kid, upload_public_jwk = excluded.upload_public_jwk,
      shared_org_id = excluded.shared_org_id, global_grace_minutes = excluded.global_grace_minutes,
      shared_legal_name = excluded.shared_legal_name, shared_tax_id = excluded.shared_tax_id,
      shared_tax_system = excluded.shared_tax_system, shared_postal_code = excluded.shared_postal_code,
      worker_version = excluded.worker_version, updated_at = excluded.updated_at`;
}

/**
 * Verifies the provider credentials and publishes the platform row. Returns false on a transient
 * failure (the caller retries later).
 */
export async function verifyAndPublish(
  sql: postgres.Sql,
  runtime: CfdiRuntime,
): Promise<boolean> {
  const c = runtime.config;
  const keys =
    c.provider === "organizations" && runtime.ring
      ? uploadKeyPair(runtime.ring)
      : null;
  try {
    let sharedOrgId: string | null = null;
    let sharedIssuer = NO_ISSUER;
    if (c.provider === "organizations" && c.userKey)
      await runtime.client.listOrganizations(
        { kind: "user", secret: c.userKey },
        "GM-",
      );
    else if (c.provider === "sandbox_shared" && c.testKey) {
      const me = await runtime.client.me({ kind: "test", secret: c.testKey });
      sharedOrgId = me.id;
      sharedIssuer = sharedIssuerOf(me);
    }
    runtime.providerOk = true;
    await publish(sql, {
      provider: c.provider,
      liveEnabled: c.liveEnabled && c.provider === "organizations",
      uploadKid: keys ? runtime.ring!.active : null,
      uploadPublicJwk: keys?.publicJwk ?? null,
      sharedOrgId,
      graceMinutes: c.graceMinutes,
      sharedIssuer,
    });
    log.info("cfdi_worker_ready", {
      provider: c.provider,
      live: c.liveEnabled,
    });
    return true;
  } catch (e) {
    const failure = classifyFacturapiError(e);
    if (!failure.retry && !failure.unknownOutcome) {
      // Refused credentials (401/403): the feature is off until the keys are fixed.
      runtime.providerOk = false;
      await publish(sql, {
        provider: "disabled",
        liveEnabled: false,
        uploadKid: null,
        uploadPublicJwk: null,
        sharedOrgId: null,
        graceMinutes: c.graceMinutes,
        sharedIssuer: NO_ISSUER,
      });
      log.warn("cfdi_provider_refused", { code: failure.code });
      void sendAlert({
        key: "cfdi_provider_auth_failed",
        severity: "critical",
        title: "CFDI provider credentials refused",
        body: `cfdi_provider_auth_failed code=${failure.code}`,
      }).catch(() => undefined);
      return true;
    }
    // Network or provider outage: keep the decided provider (and the last shared organization
    // with its legal data).
    const [previous] = await sql`
      select shared_org_id, shared_legal_name, shared_tax_id, shared_tax_system, shared_postal_code
      from cfdi_platform where id = 1`;
    const sharedOrgId = previous?.shared_org_id ?? null;
    if (c.provider === "organizations" || sharedOrgId) {
      runtime.providerOk = true;
      await publish(sql, {
        provider: c.provider,
        liveEnabled: c.liveEnabled && c.provider === "organizations",
        uploadKid: keys ? runtime.ring!.active : null,
        uploadPublicJwk: keys?.publicJwk ?? null,
        sharedOrgId,
        graceMinutes: c.graceMinutes,
        sharedIssuer:
          c.provider === "sandbox_shared" && previous
            ? {
                legalName: previous.shared_legal_name ?? null,
                taxId: previous.shared_tax_id ?? null,
                regime: previous.shared_tax_system ?? null,
                postalCode: previous.shared_postal_code ?? null,
              }
            : NO_ISSUER,
      });
    }
    log.warn("cfdi_provider_unreachable", { code: failure.code });
    return false;
  }
}

/**
 * Restarts the global tick chain of every restaurant with CFDI enabled and no live tick. The
 * restaurants come from their cfdi_global jobs, which the worker sees across tenants through the
 * jobs_worker_discover policy (030; no new privilege): a chain that ticks every 6 hours at most
 * leaves jobs for retention's 30 days. Each restaurant is then checked in its own tenant
 * transaction. Returns the number of chains restarted.
 */
export async function seedGlobalTicks(
  sql: postgres.Sql,
  now = new Date(),
): Promise<number> {
  const rows = await sql<{ tenant_id: string }[]>`
    select distinct tenant_id from jobs where kind = 'cfdi_global' limit 5000`;
  let seeded = 0;
  for (const { tenant_id: tenantId } of rows)
    if (
      await tenant(sql, tenantId, async (tx) =>
        (await loadSettings(tx))?.enabled
          ? ensureTick(tx, tenantId, "boot", now)
          : false,
      )
    )
      seeded++;
  return seeded;
}

/** Boots cfdi in this worker; a no-op without WORKER_DATABASE_URL or Facturapi keys. */
export async function cfdiWorkerBoot(
  workerSql: postgres.Sql | null,
  env: NodeJS.ProcessEnv,
  o: { client?: FacturapiClient; retry?: boolean; seed?: boolean } = {},
): Promise<CfdiRuntime | null> {
  if (!workerSql) {
    log.info("cfdi_worker_disabled", { reason: "no_worker_database" });
    setCfdiRuntime(null);
    return null;
  }
  const e = normalized(env);
  const appEnv = (e.APP_ENV ?? "development") as AppEnv;
  const config: CfdiWorkerConfig = cfdiWorkerConfig(e, appEnv);
  if (config.provider === "disabled") {
    await publish(workerSql, {
      provider: "disabled",
      liveEnabled: false,
      uploadKid: null,
      uploadPublicJwk: null,
      sharedOrgId: null,
      graceMinutes: config.graceMinutes,
      sharedIssuer: NO_ISSUER,
    });
    log.info("cfdi_worker_disabled", { reason: "provider_not_configured" });
    setCfdiRuntime(null);
    return null;
  }
  const runtime: CfdiRuntime = {
    config,
    ring:
      config.keyring && e.CREDENTIAL_ENCRYPTION_KEY
        ? parseCredentialKeyring(e.CREDENTIAL_ENCRYPTION_KEY)
        : null,
    client:
      o.client ??
      createFacturapiClient({
        baseUrl: config.baseUrl ?? undefined,
        // LD-51 F13: each provider answer's X-Facturapi-Log-Id reaches the job's info line.
        onResponse: recordProviderResponse,
      }),
    alert: sendAlert,
    providerOk: false,
  };
  setCfdiRuntime(runtime);
  const ok = await verifyAndPublish(workerSql, runtime);
  if (!ok && o.retry !== false) {
    const again = () => {
      const timer = setTimeout(() => {
        void verifyAndPublish(workerSql, runtime)
          .then((done) => {
            if (!done) again();
          })
          .catch((error) => {
            log.warn("cfdi_provider_check_failed", {}, error);
            again();
          });
      }, RETRY_MS);
      timer.unref();
    };
    again();
  }
  if (o.seed !== false)
    void seedGlobalTicks(workerSql)
      .then((seeded) => log.info("cfdi_ticks_seeded", { seeded }))
      .catch((error) => log.warn("cfdi_ticks_seed_failed", {}, error));
  return runtime;
}
