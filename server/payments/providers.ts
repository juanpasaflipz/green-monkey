// Provider accounts, web side (payments spec §4.4, §9.1): credentials intake (sealed on arrival to
// the worker's public key: the web never holds a usable secret), disconnect, device discovery and
// the MP mode switch requests, the Configuración view and the /capabilities entries (critic R30).
// Every write runs under the payments configuration key (advisory class 934, LO-3; ARCHITECTURE
// row 46). saveCredentials is not once(): its reply carries the notification URL (shown once,
// the public-links rule), which must never be stored in operations.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { managers, permit } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { audit, once } from "../orders.js";
import { enqueueJob } from "../jobs.js";
import {
  PAYMENTS_UPLOAD_TYP,
  sealUpload,
  UploadKeyError,
} from "../vault/seal-upload.js";
import { DomainError, type Session } from "../../shared/domain.js";
import {
  clipCredentialsInput,
  deviceModeInput,
  mpCredentialsInput,
  PROVIDERS,
  type CredentialsSaved,
  type Provider,
  type ProvidersView,
  type TerminalStatus,
} from "../../shared/payments.js";

const owners = ["owner"];
const KIND_OF: Record<Provider, string> = {
  mercadopago: "mercadopago_point",
  clip: "clip_pinpad",
};

/** The notification URL's token: 16 random bytes, base64url (22 characters, 128 bits). */
export const HOOK_TOKEN = /^[A-Za-z0-9_-]{22}$/;
export function hookHash(token: string): string {
  return createHash("sha256")
    .update(`gm-payments-hook-v1:${token}`)
    .digest("hex");
}
export function parseProvider(raw: unknown): Provider {
  if (raw === "mercadopago" || raw === "clip") return raw;
  throw new DomainError("not_found", 404);
}

async function lockPaymentsConfig(tx: Tx, s: Session) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + ":payments"},934))`;
}
async function assertNoLiveForProvider(tx: Tx, provider: Provider) {
  const [live] = await tx`select id from payment_attempts
    where provider=${provider}
      and state in ('created','sending','pending','unknown','approved','review') limit 1`;
  if (live) throw new DomainError("payments_attempts_live", 409);
}

/**
 * POST /payments/providers/:provider/credentials (owner, step-up; allowed while charges are live).
 * Checks the format, seals
 * {provider, credentials, hookToken} to the worker's published key bound to {tenant,
 * credentials_upload, row}, stores only the box and the hook hash, and queues the worker's
 * verification. The plaintext never touches the database, a log or operations.
 */
export async function saveCredentials(
  tx: Tx,
  s: Session,
  provider: Provider,
  raw: unknown,
  o: { appEnv: string; appUrl: string },
): Promise<CredentialsSaved> {
  permit(s, owners);
  requireRecentAuth(s);
  const parsed =
    provider === "mercadopago"
      ? mpCredentialsInput.safeParse(raw)
      : clipCredentialsInput.safeParse(raw);
  if (!parsed.success)
    throw new DomainError("payments_credentials_invalid_format");
  // Point devices need production credentials (MP uses test tokens only for listing).
  if (
    provider === "mercadopago" &&
    (o.appEnv === "staging" || o.appEnv === "production") &&
    (parsed.data as { accessToken: string }).accessToken.startsWith("TEST-")
  )
    throw new DomainError("payments_credentials_invalid_format");
  await lockPaymentsConfig(tx, s);
  // Never refused while charges are live (P2-MONEY-1, P2-PROVIDERS-1): a failed or rotated
  // account is repaired here mid-service. In-flight attempts keep their poll chains (and their
  // deadlines) while the new credentials are verified, and the worker re-reads each of them once
  // the account is active again. Only a disconnect waits for them (spec §2.5).
  const [platform] =
    await tx`select providers,upload_kid,upload_public_jwk from payments_platform where id=1`;
  if (
    !platform?.upload_kid ||
    !platform.upload_public_jwk ||
    !(platform.providers as string[]).includes(provider)
  )
    throw new DomainError("payments_upload_unavailable", 503);
  const hookToken = randomBytes(16).toString("base64url");
  const uploadId = randomUUID();
  let box: string;
  try {
    box = await sealUpload(
      {
        kid: platform.upload_kid as string,
        jwk: platform.upload_public_jwk as JsonWebKey,
      },
      JSON.stringify({ provider, ...parsed.data, hookToken }),
      {
        typ: PAYMENTS_UPLOAD_TYP,
        tenantId: s.tenantId,
        purpose: "credentials_upload",
        id: uploadId,
      },
    );
  } catch (e) {
    if (e instanceof UploadKeyError)
      throw new DomainError("payments_upload_unavailable", 503);
    throw e;
  }
  await tx`insert into payment_secrets(tenant_id,id,purpose,kid,payload_secret)
    values(${s.tenantId},${uploadId},'credentials_upload',${platform.upload_kid},${box})`;
  await tx`insert into payment_provider_accounts(tenant_id,provider,state,hook_hash,upload_secret_id,updated_by)
    values(${s.tenantId},${provider},'verifying',${hookHash(hookToken)},${uploadId},${s.employeeId})
    on conflict (tenant_id,provider) do update set state='verifying',hook_hash=excluded.hook_hash,
      upload_secret_id=excluded.upload_secret_id,error_code=null,
      version=payment_provider_accounts.version+1,updated_at=now(),updated_by=excluded.updated_by`;
  await enqueueJob(tx, s, {
    kind: "payments_credentials",
    dedupeKey: `account:${provider}:${uploadId}`,
    payload: { provider, uploadSecretId: uploadId },
  });
  await audit(tx, s, "payment.credentials_saved", s.tenantId, { provider });
  return {
    provider,
    state: "verifying",
    webhookUrl: `${o.appUrl.replace(/\/+$/, "")}/api/payments/webhooks/${provider}/${hookToken}`,
  };
}

/** POST /payments/providers/:provider/disable (owner, step-up): refused while attempts are live. */
export async function disableProvider(
  tx: Tx,
  s: Session,
  provider: Provider,
): Promise<ProvidersView> {
  permit(s, owners);
  requireRecentAuth(s);
  await lockPaymentsConfig(tx, s);
  await assertNoLiveForProvider(tx, provider);
  const [row] = await tx`update payment_provider_accounts set state='disabled',
      version=version+1,updated_at=now(),updated_by=${s.employeeId}
    where provider=${provider} and state<>'disabled' returning version`;
  if (row) {
    await enqueueJob(tx, s, {
      kind: "payments_wipe",
      dedupeKey: `wipe:${provider}:${row.version}`,
      payload: { provider },
    });
    await audit(tx, s, "payment.provider_disabled", s.tenantId, { provider });
  }
  return providersView(tx, s);
}

/** POST /payments/providers/:provider/devices/refresh (managers): at most one per minute. */
export async function requestDevices(
  tx: Tx,
  s: Session,
  provider: Provider,
): Promise<ProvidersView> {
  permit(s, managers);
  await lockPaymentsConfig(tx, s);
  const [account] =
    await tx`select state from payment_provider_accounts where provider=${provider}`;
  if (account?.state !== "active")
    throw new DomainError("payments_provider_not_configured", 409);
  await enqueueJob(tx, s, {
    kind: "payments_devices",
    dedupeKey: `devices:${provider}:${Math.floor(Date.now() / 60_000)}`,
    payload: { provider },
  });
  return providersView(tx, s);
}

/** POST /payments/providers/mercadopago/devices/:deviceId/mode (managers, step-up). */
export async function requestDeviceMode(
  tx: Tx,
  s: Session,
  deviceId: string,
  raw: unknown,
): Promise<ProvidersView> {
  permit(s, managers);
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(deviceId))
    throw new DomainError("invalid_input");
  const p = deviceModeInput.parse(raw);
  requireRecentAuth(s);
  return once(
    tx,
    s,
    p.operationId,
    "payments.device_mode",
    { deviceId, ...p },
    async () => {
      await lockPaymentsConfig(tx, s);
      const [account] =
        await tx`select state from payment_provider_accounts where provider='mercadopago'`;
      if (account?.state !== "active")
        throw new DomainError("payments_provider_not_configured", 409);
      await enqueueJob(tx, s, {
        kind: "payments_device_mode",
        dedupeKey: `mode:${deviceId}:${p.operationId}`,
        payload: { deviceId, mode: p.mode },
      });
      await audit(tx, s, "payment.device_mode_requested", s.tenantId, {
        deviceId,
        mode: p.mode,
      });
      return providersView(tx, s);
    },
  );
}

/** GET /payments/providers (managers): accounts and devices seen in the last 30 days. */
export async function providersView(
  tx: Tx,
  s: Session,
): Promise<ProvidersView> {
  permit(s, managers);
  const [[platform], accounts, devices, terminals] = await Promise.all([
    tx`select providers from payments_platform where id=1`,
    tx`select provider,state,account_label,verified_at,error_code from payment_provider_accounts`,
    tx`select provider,device_id,operating_mode,status,seen_at from payment_provider_devices
      where seen_at > now() - interval '30 days' order by provider,device_id limit 200`,
    tx`select id,kind,provider_device_id from payment_terminals
      where archived_at is null and provider_device_id is not null`,
  ]);
  const served = ((platform?.providers as string[] | undefined) ?? []).slice();
  return {
    accounts: PROVIDERS.map((provider) => {
      const a = accounts.find((x) => x.provider === provider);
      return {
        provider,
        available: served.includes(provider),
        state: a ? a.state : "not_connected",
        label: a?.account_label ?? null,
        verifiedAt: a?.verified_at
          ? new Date(a.verified_at).toISOString()
          : null,
        errorCode: a?.error_code ?? null,
      };
    }),
    devices: devices.map((d) => ({
      provider: d.provider,
      deviceId: d.device_id,
      operatingMode: d.operating_mode ?? null,
      status: d.status ?? null,
      seenAt: new Date(d.seen_at).toISOString(),
      terminalId:
        terminals.find(
          (t) =>
            t.kind === KIND_OF[d.provider as Provider] &&
            t.provider_device_id === d.device_id,
        )?.id ?? null,
    })),
  };
}

/**
 * Integrated availability per provider (plain reads): the worker serves it and the account is
 * active. Used by paymentOptions and /capabilities.
 */
export async function integratedProviders(tx: Tx): Promise<{
  served: Provider[];
  accounts: Map<Provider, { state: string; error_code: string | null }>;
}> {
  const [[platform], accounts] = await Promise.all([
    tx`select providers from payments_platform where id=1`,
    tx`select provider,state,error_code from payment_provider_accounts`,
  ]);
  return {
    served: ((platform?.providers as Provider[] | undefined) ?? []).filter(
      (p) => PROVIDERS.includes(p),
    ),
    accounts: new Map(
      accounts.map((a) => [
        a.provider as Provider,
        { state: a.state as string, error_code: a.error_code ?? null },
      ]),
    ),
  };
}

/** /capabilities entries (critic R30: {enabled, reason?}, snake_case reasons). */
export async function providerCapabilities(
  tx: Tx,
): Promise<Record<Provider, { enabled: boolean; reason?: string }>> {
  const { served, accounts } = await integratedProviders(tx);
  const one = (provider: Provider) => {
    if (!served.includes(provider))
      return { enabled: false, reason: "worker_not_configured" };
    const a = accounts.get(provider);
    if (!a || a.state === "disabled")
      return { enabled: false, reason: "not_connected" };
    if (a.state === "verifying") return { enabled: false, reason: "verifying" };
    if (a.state === "failed")
      return {
        enabled: false,
        reason: a.error_code ?? "payments_credentials_rejected",
      };
    return { enabled: true };
  };
  return { mercadopago: one("mercadopago"), clip: one("clip") };
}

/** The connectivity dot of an integrated terminal from the provider's last device report. */
export function terminalStatus(
  device: { status: string | null; seen_at: Date } | undefined,
  now = Date.now(),
): TerminalStatus {
  if (!device || now - new Date(device.seen_at).getTime() > 10 * 60_000)
    return "no_data";
  if (device.status === "active") return "online";
  if (device.status === "inactive" || device.status === "expired")
    return "offline";
  return "no_data";
}
