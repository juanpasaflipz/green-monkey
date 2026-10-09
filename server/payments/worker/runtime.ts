/**
 * The payments worker runtime (spec §4.7): providers, API bases, the keyring and the alert sink,
 * set once by paymentsWorkerBoot (or by a DB suite with tests/fakes/payments-fake.ts) and read by
 * every handler. Worker only: it opens sealed provider credentials, so the web never imports it
 * (tests/import-graph.test.ts).
 *
 * Also the attempt write helpers every handler shares: each worker step locks the attempt row
 * alone in its own transaction (LO-2c, critic R4 "worker steps: 2c alone"), never across a
 * provider call, and writes a whitelisted event (spec §9.4: no raw payloads, tokens or signatures).
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "../../db.js";
import type { Alert } from "../../ops/alerts.js";
import type { Keyring } from "../../cfdi/config.js";
import { enqueueJob } from "../../jobs.js";
import { paymentsVault, type PaymentSecretPurpose } from "../../vault/vault.js";
import type { AttemptState, Provider } from "../../../shared/payments.js";

export type PaymentsRuntime = {
  providers: Provider[];
  mercadopagoApiUrl: string;
  clipApiUrl: string;
  ring: Keyring;
  /** Public origin for Clip's per-payment webhook_url (APP_URL); null omits it. */
  appUrl: string | null;
  alert: (a: Alert) => void | Promise<void>;
};

let current: PaymentsRuntime | null = null;
export function setPaymentsRuntime(r: PaymentsRuntime | null): void {
  current = r;
}
/** The runtime, or null when this worker serves no payments provider. */
export function paymentsRuntime(): PaymentsRuntime | null {
  return current && current.providers.length ? current : null;
}
/** Fires an alert without letting a failing sink break the handler. */
export function raise(rt: PaymentsRuntime, a: Alert): void {
  void Promise.resolve()
    .then(() => rt.alert(a))
    .catch(() => undefined);
}
/** "0b6a1a8e": enough for an operator to find the restaurant; never a name. */
export const tenantTag = (tenantId: string) => tenantId.slice(0, 8);

/** A coded failure: a thrown one retries the job with this code (server/jobs/runner.ts). */
export class PaymentsJobError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "PaymentsJobError";
  }
}

export type WorkerAttempt = {
  tenant_id: string;
  id: string;
  target: "order" | "kiosk_hold";
  origin: "pos" | "kiosk";
  order_id: string | null;
  terminal_id: string;
  provider: Provider;
  provider_device_id: string;
  terminal_label: string;
  amount: number;
  tip: number;
  state: AttemptState;
  provider_reference: string | null;
  provider_status: string | null;
  paid_amount: number | null;
  error_code: string | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  sent_at: Date | null;
};

export async function readAttempt(
  tx: Tx,
  attemptId: string,
): Promise<WorkerAttempt | null> {
  const [a] = await tx<WorkerAttempt[]>`
    select tenant_id,id,target,origin,order_id,terminal_id,provider,provider_device_id,
      terminal_label,amount,tip,state,provider_reference,provider_status,paid_amount,error_code,
      cancel_requested_at,created_at,sent_at
    from payment_attempts where id=${attemptId}`;
  return a ?? null;
}
/** LO-2c, alone in the step's own transaction. */
export async function lockAttempt(
  tx: Tx,
  attemptId: string,
): Promise<WorkerAttempt | null> {
  const [a] = await tx<WorkerAttempt[]>`
    select tenant_id,id,target,origin,order_id,terminal_id,provider,provider_device_id,
      terminal_label,amount,tip,state,provider_reference,provider_status,paid_amount,error_code,
      cancel_requested_at,created_at,sent_at
    from payment_attempts where id=${attemptId} for update`;
  return a ?? null;
}

/** Event detail keys a worker event may carry (spec §9.4 whitelist). */
const DETAIL_KEYS = new Set([
  "status",
  "code",
  "providerCode",
  "httpStatus",
  "paidAmount",
  "fee",
  "feeSource",
  "mismatch",
  "reference",
  "source",
  "requestId",
  "cancelled",
  "seq",
  "undocumented",
  "before",
]);
export async function workerEvent(
  tx: Tx,
  tenantId: string,
  attemptId: string,
  kind: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail))
    if (DETAIL_KEYS.has(k) && v !== undefined)
      clean[k] =
        typeof v === "string"
          ? v.slice(0, 100)
          : (v as number | boolean | null);
  await tx`insert into payment_attempt_events(tenant_id,id,attempt_id,kind,actor,detail)
    values(${tenantId},${randomUUID()},${attemptId},${kind},'worker',${tx.json(clean as never)})`;
}

export type MpCredentials = {
  provider: "mercadopago";
  accessToken: string;
  webhookSecret: string;
  hookToken: string;
};
export type ClipCredentials = {
  provider: "clip";
  apiKey: string;
  secretKey: string;
  hookToken: string;
};
export type Credentials = MpCredentials | ClipCredentials;

/** Parses an opened credentials box (upload or at-rest); null when malformed. */
export function parseCredentials(text: string): Credentials | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const s = (k: string) =>
    typeof v[k] === "string" && (v[k] as string).length > 0
      ? (v[k] as string)
      : null;
  const hookToken = s("hookToken");
  if (!hookToken) return null;
  if (v.provider === "mercadopago" && s("accessToken") && s("webhookSecret"))
    return {
      provider: "mercadopago",
      accessToken: s("accessToken")!,
      webhookSecret: s("webhookSecret")!,
      hookToken,
    };
  if (v.provider === "clip" && s("apiKey") && s("secretKey"))
    return {
      provider: "clip",
      apiKey: s("apiKey")!,
      secretKey: s("secretKey")!,
      hookToken,
    };
  return null;
}

export type ActiveAccount = {
  providerAccountId: string | null;
  credentials: Credentials;
};

/**
 * The provider account's opened credentials (inside a tenant transaction; the plaintext lives only
 * in the caller's locals and is never logged). A secret sealed under an older listed kid is
 * re-sealed under the active one on the way (key rotation reaches every restaurant that charges,
 * server/vault/rekey.ts). Throws PaymentsJobError payments_provider_not_configured when the account
 * is not active, payments_vault_* when the box cannot be opened.
 */
export async function openAccount(
  tx: Tx,
  rt: PaymentsRuntime,
  tenantId: string,
  provider: Provider,
): Promise<ActiveAccount> {
  const [account] =
    await tx`select state,credential_secret_id,provider_account_id
    from payment_provider_accounts where provider=${provider}`;
  if (!account || account.state !== "active" || !account.credential_secret_id)
    throw new PaymentsJobError("payments_provider_not_configured");
  const purpose: PaymentSecretPurpose =
    provider === "mercadopago" ? "mp_credentials" : "clip_credentials";
  const [secret] = await tx`select id,kid,payload_secret from payment_secrets
    where id=${account.credential_secret_id} and purpose=${purpose} and wiped_at is null`;
  if (!secret) throw new PaymentsJobError("payments_provider_not_configured");
  const binding = { tenantId, purpose, id: secret.id as string };
  const plain = await paymentsVault.openSecret(
    rt.ring,
    secret.payload_secret as string,
    binding,
  );
  if (secret.kid !== rt.ring.active) {
    const sealed = await paymentsVault.sealSecret(rt.ring, plain, binding);
    await tx`update payment_secrets set kid=${sealed.kid},payload_secret=${sealed.jwe}
      where id=${secret.id}`;
  }
  const credentials = parseCredentials(plain);
  if (!credentials || credentials.provider !== provider)
    throw new PaymentsJobError("payments_vault_malformed");
  return {
    providerAccountId: (account.provider_account_id as string | null) ?? null,
    credentials,
  };
}

/** The account's credentials were refused by the provider: it fails until the owner reconnects. */
export async function failAccount(
  tx: Tx,
  provider: Provider,
  code: string,
): Promise<void> {
  await tx`update payment_provider_accounts set state='failed',error_code=${code},
      version=version+1,updated_at=now()
    where provider=${provider} and state='active'`;
}

/** Queues the web's payments_settle (LO-R8: keyed by the attempt, the step's own id). */
export async function queueSettle(
  tx: Tx,
  tenantId: string,
  attemptId: string,
): Promise<void> {
  await enqueueJob(
    tx,
    { tenantId },
    {
      kind: "payments_settle",
      dedupeKey: attemptId,
      payload: { attemptId },
    },
  );
}
