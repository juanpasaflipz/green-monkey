/**
 * payments worker boot hook (spec §4.0, §4.7): called once by server/worker.ts between its "worker
 * areas: boot hooks" markers. It reads PAYMENTS_PROVIDERS and the API bases (server/payments/
 * config.ts), derives the credentials-upload key pair from CREDENTIAL_ENCRYPTION_KEY and publishes
 * payments_platform (no tenant data): the providers this worker serves and the public key the web
 * seals credentials to. With no provider, it publishes an empty list, so the web reports
 * `worker_not_configured` and integrated charging stays off. Never throws for a provider problem
 * (no provider is called here); a configuration error was already fatal in config-rules.
 */
import type postgres from "postgres";
import { buildInfo } from "../../build-info.js";
import { log } from "../../logging.js";
import { sendAlert } from "../../ops/alerts.js";
import { parseCredentialKeyring } from "../../cfdi/config.js";
import { paymentsVault } from "../../vault/vault.js";
import { paymentsWorkerConfig } from "../config.js";
import { setPaymentsRuntime, type PaymentsRuntime } from "./runtime.js";

type AppEnv = "development" | "test" | "staging" | "production";

/** Publishes the platform row; exported for the DB suite. */
export async function publishPaymentsPlatform(
  sql: postgres.Sql,
  row: {
    providers: string[];
    uploadKid: string | null;
    uploadPublicJwk: JsonWebKey | null;
  },
): Promise<void> {
  const version = buildInfo().version.slice(0, 100) || "dev";
  await sql`
    insert into payments_platform(id, providers, upload_kid, upload_public_jwk, worker_version, updated_at)
    values (1, ${row.providers}, ${row.uploadKid},
      ${row.uploadPublicJwk ? sql.json(row.uploadPublicJwk as never) : null}, ${version}, now())
    on conflict (id) do update set providers=excluded.providers, upload_kid=excluded.upload_kid,
      upload_public_jwk=excluded.upload_public_jwk, worker_version=excluded.worker_version,
      updated_at=now()`;
}

export async function paymentsWorkerBoot(
  sql: postgres.Sql | null,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const clean: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env))
    clean[k] = v === undefined || v.trim() === "" ? undefined : v;
  const appEnv = (clean.APP_ENV ?? "development") as AppEnv;
  const config = paymentsWorkerConfig(clean, appEnv);
  if (!sql) {
    setPaymentsRuntime(null);
    return;
  }
  if (!config.providers.length) {
    setPaymentsRuntime(null);
    await publishPaymentsPlatform(sql, {
      providers: [],
      uploadKid: null,
      uploadPublicJwk: null,
    });
    log.info("payments_worker_disabled", { reason: "no_providers" });
    return;
  }
  const ring = parseCredentialKeyring(clean.CREDENTIAL_ENCRYPTION_KEY!);
  const runtime: PaymentsRuntime = {
    providers: config.providers,
    mercadopagoApiUrl: config.mercadopagoApiUrl,
    clipApiUrl: config.clipApiUrl,
    ring,
    appUrl: clean.APP_URL ? new URL(clean.APP_URL).origin : null,
    alert: sendAlert,
  };
  setPaymentsRuntime(runtime);
  await publishPaymentsPlatform(sql, {
    providers: config.providers,
    uploadKid: ring.active,
    uploadPublicJwk: paymentsVault.uploadKeyPair(ring).publicJwk,
  });
  log.info("payments_worker_ready", { providers: config.providers });
}
