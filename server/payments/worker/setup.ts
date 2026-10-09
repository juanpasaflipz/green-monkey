/**
 * Worker handlers of the provider setup (spec §4.7): payments_credentials (open the sealed upload,
 * verify with the provider, re-seal at rest, activate), payments_devices (the device cache for
 * "Buscar terminales"), payments_device_mode (MP PDV / STANDALONE) and payments_wipe (disconnect).
 * The plaintext lives only in these handlers' locals: never in a table, a job payload, an event
 * or a log line (acceptance 4).
 */
import { randomUUID } from "node:crypto";
import type { JobContext, JobOutcome } from "../../jobs.js";
import type { Tx } from "../../db.js";
import { enqueueJob } from "../../jobs.js";
import { paymentsVault } from "../../vault/vault.js";
import { ProviderError } from "./http.js";
import {
  getAccount,
  listTerminals,
  setTerminalMode,
  type MpClient,
} from "./mercadopago.js";
import { listPinPadDevices, type ClipClient } from "./clip.js";
import {
  openAccount,
  parseCredentials,
  paymentsRuntime,
  type Credentials,
  type PaymentsRuntime,
} from "./runtime.js";
import type { Provider } from "../../../shared/payments.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const providerOf = (v: unknown): Provider | null =>
  v === "mercadopago" || v === "clip" ? v : null;

function mp(
  rt: PaymentsRuntime,
  c: Credentials,
  signal: AbortSignal,
): MpClient {
  if (c.provider !== "mercadopago")
    throw new ProviderError("payments_provider_not_configured", null);
  return { baseUrl: rt.mercadopagoApiUrl, accessToken: c.accessToken, signal };
}
function clip(
  rt: PaymentsRuntime,
  c: Credentials,
  signal: AbortSignal,
): ClipClient {
  if (c.provider !== "clip")
    throw new ProviderError("payments_provider_not_configured", null);
  return {
    baseUrl: rt.clipApiUrl,
    apiKey: c.apiKey,
    secretKey: c.secretKey,
    signal,
  };
}

async function wipeSecret(tx: Tx, secretId: string | null) {
  if (!secretId) return;
  await tx`update payment_secrets set payload_secret=null,wiped_at=now()
    where id=${secretId} and wiped_at is null`;
}

/** The upload (and its account row) is still the one this job was queued for. */
async function currentUpload(tx: Tx, provider: Provider, uploadId: string) {
  const [a] = await tx`select state,upload_secret_id,credential_secret_id
    from payment_provider_accounts where provider=${provider} for update`;
  return a && a.state === "verifying" && a.upload_secret_id === uploadId
    ? a
    : null;
}

async function fail(
  ctx: JobContext,
  provider: Provider,
  uploadId: string,
  code: string,
) {
  await ctx.tenant(async (tx) => {
    const a = await currentUpload(tx, provider, uploadId);
    if (!a) return;
    await tx`update payment_provider_accounts set state='failed',error_code=${code},
        version=version+1,updated_at=now()
      where provider=${provider}`;
    await wipeSecret(tx, uploadId);
  });
}

/** payments_credentials: verifying → active (or failed). The upload is wiped in every branch. */
export async function credentialsHandler(ctx: JobContext): Promise<JobOutcome> {
  const rt = paymentsRuntime();
  const p = ctx.job.payload as { provider?: unknown; uploadSecretId?: unknown };
  const provider = providerOf(p?.provider);
  const uploadId =
    typeof p?.uploadSecretId === "string" && uuid.test(p.uploadSecretId)
      ? p.uploadSecretId
      : null;
  if (!provider || !uploadId)
    return { status: "dead", code: "invalid_payload" };
  if (!rt)
    return {
      status: "retry",
      code: "payments_provider_unavailable",
      afterMs: 60_000,
    };
  const tenantId = ctx.job.tenantId;
  const opened = await ctx.tenant(async (tx) => {
    const a = await currentUpload(tx, provider, uploadId);
    if (!a) return { superseded: true as const };
    const [box] = await tx`select payload_secret from payment_secrets
      where id=${uploadId} and purpose='credentials_upload' and wiped_at is null`;
    if (!box) return { credentials: null };
    try {
      const plain = await paymentsVault.openUpload(
        rt.ring,
        box.payload_secret as string,
        {
          tenantId,
          id: uploadId,
        },
      );
      return {
        credentials: parseCredentials(
          new TextDecoder("utf-8", { fatal: true }).decode(plain),
        ),
      };
    } catch {
      return { credentials: null };
    }
  });
  if ("superseded" in opened) return { status: "done" };
  const credentials = opened.credentials;
  if (!credentials || credentials.provider !== provider) {
    await fail(ctx, provider, uploadId, "payments_credentials_invalid_format");
    return { status: "done" };
  }
  let label: string;
  let accountId: string | null = null;
  try {
    if (credentials.provider === "mercadopago") {
      const me = await getAccount(mp(rt, credentials, ctx.signal));
      if (me.siteId !== "MLM") {
        await fail(ctx, provider, uploadId, "payments_account_country");
        return { status: "done" };
      }
      accountId = /^[A-Za-z0-9_-]{1,64}$/.test(me.id) ? me.id : null;
      label = (me.nickname ?? `Mercado Pago ${me.id}`).slice(0, 80);
    } else {
      const devices = await listPinPadDevices(
        clip(rt, credentials, ctx.signal),
      );
      label = `Clip · ${devices.length} ${devices.length === 1 ? "lector" : "lectores"}`;
    }
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    if (e.retryable && ctx.job.attempts < 3)
      return { status: "retry", code: e.code, afterMs: e.retryAfterMs ?? 5000 };
    await fail(
      ctx,
      provider,
      uploadId,
      e.retryable
        ? "payments_provider_unreachable"
        : e.code === "payments_credentials_rejected" || (e.status ?? 0) < 500
          ? "payments_credentials_rejected"
          : e.code,
    );
    return { status: "done" };
  }
  await ctx.tenant(async (tx) => {
    const a = await currentUpload(tx, provider, uploadId);
    if (!a) return;
    const secretId = randomUUID();
    const purpose =
      provider === "mercadopago" ? "mp_credentials" : "clip_credentials";
    const sealed = await paymentsVault.sealSecret(
      rt.ring,
      JSON.stringify(credentials),
      {
        tenantId,
        purpose,
        id: secretId,
      },
    );
    await tx`insert into payment_secrets(tenant_id,id,purpose,kid,payload_secret)
      values(${tenantId},${secretId},${purpose},${sealed.kid},${sealed.jwe})`;
    const previous = (a.credential_secret_id as string | null) ?? null;
    await tx`update payment_provider_accounts set state='active',account_label=${label},
        provider_account_id=${accountId},credential_secret_id=${secretId},verified_at=now(),
        error_code=null,version=version+1,updated_at=now()
      where provider=${provider}`;
    await wipeSecret(tx, uploadId);
    if (previous && previous !== secretId) await wipeSecret(tx, previous);
    await enqueueJob(
      tx,
      { tenantId },
      {
        kind: "payments_devices",
        dedupeKey: `devices:${provider}:${secretId}`,
        payload: { provider },
      },
    );
    // The owner repaired the account while charges were in flight (saveCredentials allows it):
    // re-read each of them now, which resumes a pending attempt's chain and lets an unknown one
    // settle by itself if the provider has an answer.
    const live = await tx`select id from payment_attempts
      where provider=${provider} and state in ('pending','unknown') order by created_at limit 50`;
    for (const r of live)
      await enqueueJob(
        tx,
        { tenantId },
        {
          kind: "payments_webhook",
          dedupeKey: `check:${r.id as string}:account:${secretId}`,
          payload: { attemptId: r.id, source: "check" },
        },
      );
  });
  return { status: "done" };
}

/** payments_devices: refresh the device cache (MP every mode; Clip readers and their status). */
export async function devicesHandler(ctx: JobContext): Promise<JobOutcome> {
  const rt = paymentsRuntime();
  const provider = providerOf(
    (ctx.job.payload as { provider?: unknown })?.provider,
  );
  if (!provider) return { status: "dead", code: "invalid_payload" };
  if (!rt)
    return {
      status: "retry",
      code: "payments_provider_unavailable",
      afterMs: 60_000,
    };
  const tenantId = ctx.job.tenantId;
  let credentials: Credentials;
  try {
    credentials = (
      await ctx.tenant((tx) => openAccount(tx, rt, tenantId, provider))
    ).credentials;
  } catch {
    return { status: "done" };
  }
  let rows: {
    id: string;
    mode: "PDV" | "STANDALONE" | null;
    status: string | null;
    store: string | null;
    pos: string | null;
  }[];
  try {
    rows =
      credentials.provider === "mercadopago"
        ? (await listTerminals(mp(rt, credentials, ctx.signal))).map((t) => ({
            id: t.id,
            mode: t.operatingMode,
            status: null,
            store: t.storeId,
            pos: t.posId,
          }))
        : (await listPinPadDevices(clip(rt, credentials, ctx.signal))).map(
            (d) => ({
              id: d.serial,
              mode: null,
              status: d.status,
              store: null,
              pos: null,
            }),
          );
  } catch (e) {
    if (e instanceof ProviderError && e.retryable && ctx.job.attempts < 2)
      return { status: "retry", code: e.code, afterMs: e.retryAfterMs ?? 5000 };
    return { status: "done" };
  }
  await ctx.tenant(async (tx) => {
    for (const r of rows.slice(0, 200))
      await tx`insert into payment_provider_devices(tenant_id,provider,device_id,operating_mode,status,
          store_id,pos_id,seen_at)
        values(${tenantId},${provider},${r.id},${r.mode},${r.status},${r.store},${r.pos},now())
        on conflict (tenant_id,provider,device_id) do update set operating_mode=excluded.operating_mode,
          status=excluded.status,store_id=excluded.store_id,pos_id=excluded.pos_id,seen_at=excluded.seen_at`;
  });
  return { status: "done" };
}

/** payments_device_mode: MP PATCH /terminals/v1/setup, then a device refresh. */
export async function deviceModeHandler(ctx: JobContext): Promise<JobOutcome> {
  const rt = paymentsRuntime();
  const p = ctx.job.payload as { deviceId?: unknown; mode?: unknown };
  const deviceId =
    typeof p?.deviceId === "string" &&
    /^[A-Za-z0-9_.:-]{1,100}$/.test(p.deviceId)
      ? p.deviceId
      : null;
  const mode = p?.mode === "PDV" || p?.mode === "STANDALONE" ? p.mode : null;
  if (!deviceId || !mode) return { status: "dead", code: "invalid_payload" };
  if (!rt)
    return {
      status: "retry",
      code: "payments_provider_unavailable",
      afterMs: 60_000,
    };
  const tenantId = ctx.job.tenantId;
  let credentials: Credentials;
  try {
    credentials = (
      await ctx.tenant((tx) => openAccount(tx, rt, tenantId, "mercadopago"))
    ).credentials;
    await setTerminalMode(mp(rt, credentials, ctx.signal), deviceId, mode);
  } catch (e) {
    if (e instanceof ProviderError && e.retryable && ctx.job.attempts < 2)
      return { status: "retry", code: e.code, afterMs: e.retryAfterMs ?? 5000 };
    // A refusal ("one PDV terminal per caja") shows in the next device list: mode unchanged.
    ctx.log.info("payments_device_mode_refused", {
      code: (e as { code?: string }).code ?? "error",
    });
    return { status: "done" };
  }
  await ctx.tenant((tx) =>
    enqueueJob(
      tx,
      { tenantId },
      {
        kind: "payments_devices",
        dedupeKey: `devices:mercadopago:mode:${ctx.job.id}`,
        payload: { provider: "mercadopago" },
      },
    ),
  );
  return { status: "done" };
}

/** payments_wipe: a disabled account's secrets are wiped (rows kept as history). */
export async function wipeHandler(ctx: JobContext): Promise<JobOutcome> {
  const provider = providerOf(
    (ctx.job.payload as { provider?: unknown })?.provider,
  );
  if (!provider) return { status: "dead", code: "invalid_payload" };
  await ctx.tenant(async (tx) => {
    const [a] = await tx`select state,upload_secret_id,credential_secret_id
      from payment_provider_accounts where provider=${provider} for update`;
    if (!a || a.state !== "disabled") return;
    await wipeSecret(tx, a.credential_secret_id as string | null);
    await wipeSecret(tx, a.upload_secret_id as string | null);
  });
  return { status: "done" };
}
