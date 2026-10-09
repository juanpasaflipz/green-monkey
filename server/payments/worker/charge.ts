/**
 * Worker handlers of one integrated charge (spec §4.7): payments_push, payments_poll,
 * payments_cancel and payments_webhook (provider notifications and the "Volver a consultar"
 * re-read). Each step locks the attempt alone in its own transaction (LO-2c), never across a
 * provider call (JobHandler contract), and every state change comes from a provider read with the
 * restaurant's own credentials (spec §9.2: a webhook is only a hint).
 *
 * Money rules (spec §1.1 goal 2, §9.3):
 * - the attempt is `created` before any provider call; `sending` is committed before the call;
 * - MP retries a create with the same idempotency key (the attempt id); Clip has none, so a create
 *   whose answer is lost is `unknown`, never re-sent (plus a best-effort delete by serial);
 * - `unknown` is a recovery state: no automatic retry; a provider read or a manager resolves it;
 * - an approval is checked (reference, terminal, account, amount, currency) before it is
 *   `approved`; a mismatch is flagged for review, never settled.
 */
import type { JobContext, JobDeadHook, JobOutcome } from "../../jobs.js";
import type { Tx } from "../../db.js";
import { enqueueJob } from "../../jobs.js";
import { ProviderError } from "./http.js";
import {
  cancelPointOrder,
  createPointOrder,
  getAccount,
  getPaymentDetail,
  getPointOrder,
  mapPointOrder,
  provesNoOrder,
  verifyMpSignature,
  type MpClient,
  type ProviderRead,
} from "./mercadopago.js";
import {
  cancelBySerial,
  cancelPinPadPayment,
  createPinPadPayment,
  getPinPadPayment,
  listPinPadDevices,
  mapClipPayment,
  type CancelResult,
  type ClipClient,
} from "./clip.js";
import {
  accountUnusable,
  failAccount,
  lockAttempt,
  openAccount,
  paymentsRuntime,
  queueSettle,
  raise,
  readAttempt,
  tenantTag,
  workerEvent,
  type ActiveAccount,
  type PaymentsRuntime,
  type WorkerAttempt,
} from "./runtime.js";
import { PAYMENTS_LIMITS } from "../../../shared/payments.js";
import { sendAlert } from "../../ops/alerts.js";

const id = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v
    : null;

function mpClient(
  rt: PaymentsRuntime,
  account: ActiveAccount,
  signal: AbortSignal,
): MpClient {
  if (account.credentials.provider !== "mercadopago")
    throw new ProviderError("payments_provider_not_configured", null);
  return {
    baseUrl: rt.mercadopagoApiUrl,
    accessToken: account.credentials.accessToken,
    signal,
  };
}
function clipClient(
  rt: PaymentsRuntime,
  account: ActiveAccount,
  signal: AbortSignal,
): ClipClient {
  if (account.credentials.provider !== "clip")
    throw new ProviderError("payments_provider_not_configured", null);
  return {
    baseUrl: rt.clipApiUrl,
    apiKey: account.credentials.apiKey,
    secretKey: account.credentials.secretKey,
    signal,
  };
}

/** "PT10M" / "PT5M" in milliseconds. */
function isoMinutes(text: string): number {
  const m = /^PT(\d+)M$/.exec(text);
  return m ? Number(m[1]) * 60_000 : 10 * 60_000;
}
/**
 * When an attempt with no final status stops waiting (spec §2.4 step 7), counted from the latest
 * send: MP's order expires (expiration_time) and 2 minutes later the attempt is unknown. A Clip
 * request has no expiry (R10; P2-PROVIDERS-3): at its own deadline the worker withdraws it
 * (clipDeadline), and only a request the reader already holds becomes unknown.
 */
function deadline(a: WorkerAttempt): number {
  const start = new Date(a.sent_at ?? a.created_at).getTime();
  if (a.provider === "clip")
    return start + PAYMENTS_LIMITS.clipDeadlineMs[a.origin];
  return (
    start +
    isoMinutes(PAYMENTS_LIMITS.mpExpiration[a.origin]) +
    PAYMENTS_LIMITS.unknownAfterExpiryMs
  );
}
/**
 * A Clip request the reader held at its deadline: unknown (payments_attempt_timeout), and still
 * read every clipWatchMs, so a payment or a cancel on the reader settles it by itself.
 */
const clipWatch = (a: WorkerAttempt) =>
  a.provider === "clip" &&
  a.state === "unknown" &&
  a.error_code === "payments_attempt_timeout" &&
  Boolean(a.provider_reference);

type Loaded = {
  attempt: WorkerAttempt;
  /** null when the account cannot be used now (verifying, failed, disabled, or its box cannot be
   *  opened): `accountError` says why. The attempt still keeps its chain and its deadline. */
  account: ActiveAccount | null;
  accountError: string | null;
  feeBp: number | null;
};
type Usable = Loaded & { account: ActiveAccount };
const usable = (l: Loaded | null): l is Usable => Boolean(l?.account);
/**
 * Attempt, opened credentials and the terminal's fee rate, in one short transaction. An account
 * that cannot be used is reported (never thrown): a pending attempt must still reach its deadline
 * (P2-MONEY-1, P2-PROVIDERS-1, P2-CONCURRENCY-1). Any other failure throws, so the runner retries
 * the job with back-off instead of ending a chain.
 */
async function load(
  ctx: JobContext,
  rt: PaymentsRuntime,
  attemptId: string,
): Promise<Loaded | null> {
  return ctx.tenant(async (tx) => {
    const attempt = await readAttempt(tx, attemptId);
    if (!attempt) return null;
    let account: ActiveAccount | null = null;
    let accountError: string | null = null;
    try {
      account = await openAccount(tx, rt, ctx.job.tenantId, attempt.provider);
    } catch (e) {
      accountError = accountUnusable(e);
      if (!accountError) throw e;
    }
    const [t] =
      await tx`select fee_bp from payment_terminals where id=${attempt.terminal_id}`;
    return {
      attempt,
      account,
      accountError,
      feeBp: (t?.fee_bp as number | null) ?? null,
    };
  });
}

/**
 * A 401/403 on an order or terminal call does not prove the credentials are bad (MP answers 403
 * forbidden_checking_terminal_owner for a device linked to another account): the account fails
 * only when the provider's own verification call refuses them too (MP GET /users/me, Clip GET
 * /devices/status: what payments_credentials verifies with). true = refused, false = valid,
 * null = could not tell (network, 5xx).
 */
async function credentialsRefused(
  rt: PaymentsRuntime,
  account: ActiveAccount,
  signal: AbortSignal,
): Promise<boolean | null> {
  try {
    if (account.credentials.provider === "mercadopago")
      await getAccount(mpClient(rt, account, signal));
    else await listPinPadDevices(clipClient(rt, account, signal));
    return false;
  } catch (e) {
    if (
      e instanceof ProviderError &&
      e.code === "payments_credentials_rejected"
    )
      return true;
    return null;
  }
}

/** Fails the account (and alerts once) when the verification call refuses its credentials. */
async function failIfRefused(
  ctx: JobContext,
  rt: PaymentsRuntime,
  provider: WorkerAttempt["provider"],
  account: ActiveAccount,
): Promise<boolean> {
  if ((await credentialsRefused(rt, account, ctx.signal)) !== true)
    return false;
  const moved = await ctx.tenant((tx) =>
    failAccount(
      tx,
      provider,
      "payments_credentials_rejected",
      account.secretId,
    ),
  );
  if (moved)
    raise(rt, {
      key: `payments_account_failed_${tenantTag(ctx.job.tenantId)}`,
      severity: "warning",
      title: "payments provider credentials refused",
      body: `payments_account_failed tenant=${tenantTag(ctx.job.tenantId)} provider=${provider}`,
    });
  return true;
}

type Read = ProviderRead & {
  fee: number | null;
  feeSource: "provider" | "estimated" | null;
};

/** One provider read of an attempt with a reference (outside any transaction). */
async function readProvider(
  rt: PaymentsRuntime,
  l: Usable,
  signal: AbortSignal,
): Promise<Read | null> {
  const a = l.attempt;
  const expected = {
    attemptId: a.id,
    deviceId: a.provider_device_id,
    accountId: l.account.providerAccountId,
    amount: a.amount,
    tip: a.tip,
  };
  if (a.provider === "mercadopago") {
    const c = mpClient(rt, l.account, signal);
    const order = await getPointOrder(c, a.provider_reference!);
    if (!order) return null;
    const read = mapPointOrder(order, expected);
    let fee: number | null = null;
    let feeSource: Read["feeSource"] = null;
    if (
      (read.outcome === "approved" || read.outcome === "refunded") &&
      read.providerPaymentId
    ) {
      // Best effort (≤ 3 s): the real fee and the last 4 digits; else the estimate at settle.
      try {
        const detail = await getPaymentDetail(c, read.providerPaymentId);
        if (detail.fee !== null) {
          fee = detail.fee;
          feeSource = "provider";
        }
        read.cardLast4 ??= detail.last4;
        read.cardType ??= detail.cardType;
      } catch {
        // estimate below
      }
    }
    if (fee === null && read.paidAmount !== null && l.feeBp !== null) {
      fee = Number(
        (BigInt(read.paidAmount) * BigInt(l.feeBp) + 5000n) / 10000n,
      );
      feeSource = "estimated";
    }
    return { ...read, fee, feeSource };
  }
  const payment = await getPinPadPayment(
    clipClient(rt, l.account, signal),
    a.provider_reference!,
  );
  if (!payment) return null;
  const read = mapClipPayment(payment, expected, l.feeBp);
  return { ...read, feeSource: read.fee === null ? null : "estimated" };
}

/**
 * Applies a provider read under the attempt lock. "restart" = an unknown attempt is pending again
 * (its poll chain had stopped); "continue" = still pending; "stop" = final, approved or nothing to
 * do.
 */
async function applyRead(
  tx: Tx,
  rt: PaymentsRuntime,
  tenantId: string,
  attemptId: string,
  read: Read,
  source: string,
): Promise<"restart" | "continue" | "stop"> {
  const a = await lockAttempt(tx, attemptId);
  if (!a || (a.state !== "pending" && a.state !== "unknown")) return "stop";
  const status = read.providerStatus || null;
  if (read.outcome === "pending") {
    if (clipWatch(a)) {
      // The reader still holds it past its deadline: stays unknown (no flip back to pending).
      if (status !== a.provider_status) {
        await tx`update payment_attempts set provider_status=${status},version=version+1
          where id=${attemptId}`;
        await workerEvent(tx, tenantId, attemptId, "provider_status", {
          status,
          source,
        });
      }
      return "continue";
    }
    const restart = a.state === "unknown";
    if (restart || status !== a.provider_status) {
      await tx`update payment_attempts set state='pending',provider_status=${status},version=version+1
        where id=${attemptId}`;
      await workerEvent(
        tx,
        tenantId,
        attemptId,
        read.undocumented ? "provider_status_undocumented" : "provider_status",
        { status, source, before: restart ? "unknown" : undefined },
      );
    }
    return restart ? "restart" : "continue";
  }
  if (read.outcome === "approved" || read.outcome === "refunded") {
    if (read.paidAmount === null) {
      // Paid at the provider but no amount to record: a manager decides (never a guess). An
      // attempt already unknown (a deadline, an account error) takes the same status and code
      // (a same-state update): «No se cobró» refuses a charge the provider's latest read says
      // was paid (P2V-FIXES-5; before, it kept a stale provider_status such as at_terminal).
      if (a.state === "pending")
        await tx`update payment_attempts set state='unknown',provider_status=${status},
            error_code='payments_provider_mismatch',version=version+1
          where id=${attemptId}`;
      else
        await tx`update payment_attempts set provider_status=${status},
            error_code='payments_provider_mismatch',version=version+1
          where id=${attemptId} and state='unknown'`;
      await workerEvent(tx, tenantId, attemptId, "unknown", {
        status,
        mismatch: read.mismatch ?? "paid_amount_unknown",
        source,
      });
      raise(rt, unknownAlert(tenantId, "paid_amount_unknown"));
      return "stop";
    }
    const code =
      read.outcome === "refunded"
        ? "payments_refunded_before_settle"
        : read.mismatch
          ? "payments_provider_mismatch"
          : null;
    await tx`update payment_attempts set state='approved',provider_status=${status},
        paid_amount=${read.paidAmount},provider_payment_id=${read.providerPaymentId},
        fee=${read.fee},fee_source=${read.fee === null ? null : read.feeSource},
        card_type=${read.cardType},card_brand=${read.cardBrand},card_last4=${read.cardLast4},
        error_code=${code},decided_at=now(),version=version+1
      where id=${attemptId}`;
    await workerEvent(tx, tenantId, attemptId, "approved", {
      status,
      paidAmount: read.paidAmount,
      fee: read.fee,
      feeSource: read.feeSource,
      mismatch: read.mismatch,
      code,
      source,
    });
    await queueSettle(tx, tenantId, attemptId);
    return "stop";
  }
  const state =
    read.outcome === "declined"
      ? "declined"
      : read.outcome === "expired"
        ? "expired"
        : "cancelled";
  // A card refused at the terminal is its own code (P2-UX-14): «pide otra tarjeta», never the
  // API refusal's «el proveedor rechazó la solicitud». The provider's reason (MP status_detail,
  // e.g. insufficient_amount) stays in provider_status and the event.
  await tx`update payment_attempts set state=${state},provider_status=${status},
      error_code=${state === "declined" ? "payments_card_declined" : null},decided_at=now(),
      version=version+1
    where id=${attemptId}`;
  await workerEvent(tx, tenantId, attemptId, state, { status, source });
  return "stop";
}

function unknownAlert(tenantId: string, reason: string) {
  return {
    key: `payments_attempt_unknown_${tenantTag(tenantId)}`,
    severity: "warning" as const,
    title: "terminal charge outcome unknown",
    body: `payments_attempt_unknown tenant=${tenantTag(tenantId)} reason=${reason}`,
  };
}

async function schedulePoll(
  tx: Tx,
  tenantId: string,
  attemptId: string,
  chain: string,
  seq: number,
  afterMs: number,
) {
  await enqueueJob(
    tx,
    { tenantId },
    {
      kind: "payments_poll",
      dedupeKey: `${attemptId}:${chain}:${seq}`,
      payload: { attemptId, chain, seq },
      runAt: new Date(Date.now() + afterMs),
    },
  );
}
const newChain = () => Math.random().toString(36).slice(2, 10);

/**
 * Starts a poll chain for a pending attempt unless one is already queued or running (a re-read
 * that found it still pending, or an unknown attempt the provider shows pending again): one chain
 * per attempt, never two (P2-CONCURRENCY-1 fix 2).
 */
async function ensureChain(tx: Tx, tenantId: string, attemptId: string) {
  const [live] = await tx`select 1 from jobs
    where kind='payments_poll' and state in ('queued','available','running')
      and payload->>'attemptId'=${attemptId} limit 1`;
  if (live) return;
  const [a] =
    await tx`select provider from payment_attempts where id=${attemptId}`;
  await schedulePoll(
    tx,
    tenantId,
    attemptId,
    newChain(),
    1,
    fastPollMs(a?.provider as string),
  );
}

/** The fresh-charge read cadence of a provider (PAYMENTS_LIMITS.pollFastMs, P2-PROVIDERS-8). */
function fastPollMs(provider: string): number {
  return provider === "clip"
    ? PAYMENTS_LIMITS.pollFastMs.clip
    : PAYMENTS_LIMITS.pollFastMs.mercadopago;
}

/**
 * A cashier's cancel must outlive its own job (P2-PROVIDERS-5, P2-CONCURRENCY-4): spec §4.7 has
 * the poll honour cancel_requested_at by handing off to payments_cancel. The push does it when it
 * records the provider's answer, every poll link does it while no cancel job is queued, and it
 * stops once the provider refused (cancel on the device) or accepted it for the device (202).
 */
async function handOffCancel(
  tx: Tx,
  tenantId: string,
  a: WorkerAttempt,
  why: string,
) {
  if (
    !a.cancel_requested_at ||
    (a.state !== "pending" && a.state !== "unknown") ||
    a.error_code === "payments_cancel_on_terminal" ||
    a.error_code === "payments_cancel_sent"
  )
    return;
  const [queued] = await tx`select 1 from jobs
    where kind='payments_cancel' and state in ('queued','available','running')
      and payload->>'attemptId'=${a.id} limit 1`;
  if (queued) return;
  await enqueueJob(
    tx,
    { tenantId },
    {
      kind: "payments_cancel",
      dedupeKey: `${a.id}:cancel:${why}`,
      payload: { attemptId: a.id },
    },
  );
}

/** MP's create body for an attempt: identical on every send (the idempotency key's contract). */
async function mpCreateInput(tx: Tx, a: WorkerAttempt) {
  const [o] = a.order_id
    ? await tx`select number from orders where id=${a.order_id}`
    : [];
  return {
    attemptId: a.id,
    total: a.amount + a.tip,
    terminalId: a.provider_device_id,
    expiration: PAYMENTS_LIMITS.mpExpiration[a.origin],
    description: o ? `Orden ${o.number}` : a.terminal_label,
  };
}

/**
 * Queues the recovery of an attempt left unknown without a provider reference (a payments_webhook
 * job, source "recover"): MP re-POSTs the identical create to learn the order id; Clip withdraws by
 * serial. Never a second Clip create.
 */
async function queueRecovery(
  tx: Tx,
  tenantId: string,
  attemptId: string,
  why: string,
  afterMs = 30_000,
) {
  await enqueueJob(
    tx,
    { tenantId },
    {
      kind: "payments_webhook",
      dedupeKey: `recover:${attemptId}:${why}`,
      payload: { attemptId, source: "recover" },
      runAt: new Date(Date.now() + afterMs),
    },
  );
}

/**
 * Adopts a provider id for an unknown attempt that has none, only after the provider's own record
 * names this attempt (MP external_reference / Clip reference = the attempt id) and its device, and
 * the id is no other attempt's: unknown → pending with the reference (a worker transition), and a
 * chain reads it from there.
 */
async function adoptReference(
  tx: Tx,
  tenantId: string,
  attemptId: string,
  found: {
    reference: string;
    externalReference: string | null;
    deviceId: string | null;
  },
  source: string,
): Promise<boolean> {
  const a = await lockAttempt(tx, attemptId);
  if (!a || a.state !== "unknown" || a.provider_reference) return false;
  const identity =
    /^[A-Za-z0-9_-]{1,100}$/.test(found.reference) &&
    found.externalReference === a.id &&
    (found.deviceId === null || found.deviceId === a.provider_device_id);
  const [taken] = identity
    ? await tx`select id from payment_attempts where provider=${a.provider}
        and lower(provider_reference)=lower(${found.reference}) limit 1`
    : [];
  if (!identity || taken) {
    await workerEvent(tx, tenantId, attemptId, "recover_mismatch", {
      source,
      mismatch: identity ? "reference_taken" : "identity",
    });
    return false;
  }
  await tx`update payment_attempts set state='pending',provider_reference=${found.reference},
      error_code=null,version=version+1 where id=${attemptId}`;
  await workerEvent(tx, tenantId, attemptId, "reference_recovered", {
    reference: found.reference,
    source,
    before: "unknown",
  });
  await ensureChain(tx, tenantId, attemptId);
  await handOffCancel(
    tx,
    tenantId,
    { ...a, state: "pending", provider_reference: found.reference },
    "adopt",
  );
  return true;
}

/**
 * An MP attempt left unknown with no reference (its create answer was lost, a re-POST was refused,
 * or the push died): re-POST the identical body with X-Idempotency-Key = the attempt id. MP
 * "devuelva el resultado original sin procesar la operación nuevamente" (MP MX, "Migrar payment
 * intent a Orders"), so an order an earlier send created comes back and is adopted; one that never
 * reached MP is created now, while the charge is still meant for the terminal. Only within the
 * order lifetime counted from the last send: later, a new order would surprise the terminal, and a
 * manager decides from the device's history. sent_at moves to this send (P2-MONEY-2).
 */
async function recoverMpReference(
  ctx: JobContext,
  rt: PaymentsRuntime,
  l: Usable,
  source: string,
): Promise<boolean> {
  const tenantId = ctx.job.tenantId;
  const attemptId = l.attempt.id;
  const input = await ctx.tenant(async (tx) => {
    const a = await lockAttempt(tx, attemptId);
    if (
      !a ||
      a.provider !== "mercadopago" ||
      a.state !== "unknown" ||
      a.provider_reference
    )
      return null;
    const last = new Date(a.sent_at ?? a.created_at).getTime();
    if (
      Date.now() >
      last + isoMinutes(PAYMENTS_LIMITS.mpExpiration[a.origin])
    ) {
      await workerEvent(tx, tenantId, attemptId, "recover_skipped", {
        code: "payments_recover_window_closed",
        source,
      });
      return null;
    }
    await tx`update payment_attempts set sent_at=now(),version=version+1 where id=${attemptId}`;
    await workerEvent(tx, tenantId, attemptId, "resent", { source });
    return mpCreateInput(tx, a);
  });
  if (!input) return false;
  let created: Awaited<ReturnType<typeof createPointOrder>>;
  try {
    created = await createPointOrder(
      mpClient(rt, l.account, ctx.signal),
      input,
    );
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    await ctx.tenant((tx) =>
      workerEvent(tx, tenantId, attemptId, "recover_failed", {
        code: e.code,
        providerCode: e.providerCode,
        httpStatus: e.status,
        source,
      }),
    );
    return false;
  }
  return ctx.tenant((tx) =>
    adoptReference(
      tx,
      tenantId,
      attemptId,
      {
        reference: created.id,
        externalReference: created.externalReference,
        deviceId: created.terminalId,
      },
      source,
    ),
  );
}

/**
 * A provider notification for an unknown attempt with no reference (matched by MP's
 * data.external_reference, or a Clip id while this account has such attempts): read the notified
 * id with the restaurant's credentials and adopt it if the provider's record names this attempt
 * (P2-PROVIDERS-9).
 */
async function adoptNotified(
  ctx: JobContext,
  rt: PaymentsRuntime,
  l: Usable,
  dataId: string,
  source: string,
): Promise<boolean> {
  const a = l.attempt;
  let found: {
    reference: string;
    externalReference: string | null;
    deviceId: string | null;
  } | null = null;
  try {
    if (a.provider === "mercadopago") {
      const order = await getPointOrder(
        mpClient(rt, l.account, ctx.signal),
        dataId,
      );
      if (order) {
        const point = (
          order.config as { point?: { terminal_id?: unknown } } | undefined
        )?.point;
        found = {
          reference: typeof order.id === "string" ? order.id : dataId,
          externalReference:
            typeof order.external_reference === "string"
              ? order.external_reference
              : null,
          deviceId:
            typeof point?.terminal_id === "string" ? point.terminal_id : null,
        };
      }
    } else {
      const payment = await getPinPadPayment(
        clipClient(rt, l.account, ctx.signal),
        dataId,
      );
      if (payment)
        found = {
          reference:
            typeof payment.pinpad_request_id === "string"
              ? payment.pinpad_request_id
              : dataId,
          externalReference:
            typeof payment.reference === "string" ? payment.reference : null,
          deviceId:
            typeof payment.serial_number_pos === "string"
              ? payment.serial_number_pos
              : null,
        };
    }
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    return false;
  }
  if (!found) return false;
  const f = found;
  return ctx.tenant((tx) =>
    adoptReference(tx, ctx.job.tenantId, a.id, f, source),
  );
}

// ---------------------------------------------------------------------------------------------

/**
 * An MP create answered 429 (P2-PROVIDERS-8). MP's Orders API limits order creation per client
 * and asks to wait for Retry-After before sending the request again: a 429 is refused before it is
 * processed, so it makes no order. Each try is a `sent`/`resent` event written before the call and
 * each 429 a `rate_limited` event, so "every try of this attempt got 429" survives claims, a
 * crashed claim (a try with no answer recorded) and a requeue. While that holds the push backs off
 * (PAYMENTS_LIMITS.mpRateLimitWaitsMs, or MP's Retry-After when longer: about 30 s over its three
 * claims) and then declines the attempt `payments_provider_unavailable`, which offers the cashier
 * the manual fallback instead of «Sin confirmar». Any other try (network error, timeout, 5xx, a
 * claim that died) may have reached MP: `ambiguous`, and the caller keeps the unknown path.
 */
async function rateLimited(
  tx: Tx,
  tenantId: string,
  attemptId: string,
  claim: number,
  retryAfterMs: number | null,
): Promise<
  | { verdict: "retry"; afterMs: number }
  | { verdict: "declined" | "ambiguous" | "moved" }
> {
  const now = await lockAttempt(tx, attemptId);
  if (now?.state !== "sending") return { verdict: "moved" };
  await workerEvent(tx, tenantId, attemptId, "rate_limited", {
    httpStatus: 429,
  });
  const [h] = await tx`select
      count(*) filter (where kind in ('sent','resent'))::int as tries,
      count(*) filter (where kind = 'rate_limited')::int as limited,
      coalesce(extract(epoch from now() - min(created_at)
        filter (where kind in ('sent','resent'))) * 1000, 0)::float8 as elapsed
    from payment_attempt_events where attempt_id=${attemptId}`;
  if (h.tries !== h.limited) return { verdict: "ambiguous" };
  const waits = PAYMENTS_LIMITS.mpRateLimitWaitsMs;
  const wait = Math.max(waits[claim - 1] ?? Infinity, retryAfterMs ?? 0);
  if (
    claim <= waits.length &&
    Number(h.elapsed) + wait <= PAYMENTS_LIMITS.mpRateLimitBudgetMs
  )
    return { verdict: "retry", afterMs: wait };
  await tx`update payment_attempts set state='declined',error_code='payments_provider_unavailable',
      decided_at=now(),version=version+1 where id=${attemptId}`;
  await workerEvent(tx, tenantId, attemptId, "declined", {
    code: "payments_provider_unavailable",
    source: "rate_limited",
    before: "sending",
    httpStatus: 429,
  });
  return { verdict: "declined" };
}

/** payments_push: created → sending → pending (or declined / unknown). */
export async function pushHandler(ctx: JobContext): Promise<JobOutcome> {
  const rt = paymentsRuntime();
  const attemptId = id((ctx.job.payload as { attemptId?: unknown })?.attemptId);
  if (!attemptId) return { status: "dead", code: "invalid_payload" };
  if (!rt)
    return {
      status: "retry",
      code: "payments_provider_unavailable",
      afterMs: 60_000,
    };
  const tenantId = ctx.job.tenantId;
  let unknownWithoutCall = false;
  const step = await ctx.tenant(async (tx) => {
    const a = await lockAttempt(tx, attemptId);
    if (!a || (a.state !== "created" && a.state !== "sending")) return null;
    // Nothing can be sent now. A `created` attempt never reached the provider: declined. A
    // `sending` one (an earlier run committed it before its call) may be on the terminal: unknown,
    // never a decline that would free the order and the terminal.
    const giveUp = async (code: string) => {
      if (a.state === "created") {
        await tx`update payment_attempts set state='sending',sent_at=now(),version=version+1
          where id=${attemptId}`;
        await tx`update payment_attempts set state='declined',error_code=${code},decided_at=now(),
            version=version+1 where id=${attemptId}`;
        await workerEvent(tx, tenantId, attemptId, "declined", { code });
        return null;
      }
      const unknownCode =
        a.provider === "clip"
          ? "payments_clip_create_outcome_unknown"
          : "payments_provider_unreachable";
      await tx`update payment_attempts set state='unknown',error_code=${unknownCode},
          version=version+1 where id=${attemptId}`;
      await workerEvent(tx, tenantId, attemptId, "unknown", {
        code: unknownCode,
        before: "sending",
        source: code,
      });
      unknownWithoutCall = true;
      return null;
    };
    if (!rt.providers.includes(a.provider))
      return giveUp("payments_provider_unavailable");
    let account: ActiveAccount;
    try {
      account = await openAccount(tx, rt, tenantId, a.provider);
    } catch (e) {
      const code = accountUnusable(e);
      if (!code) throw e;
      return giveUp(code);
    }
    if (a.state === "sending" && a.provider === "clip") {
      // A previous run died between committing `sending` and recording Clip's answer: Clip has
      // no idempotency key, so the charge may be on the reader. Never re-POST (spec §2.5).
      await tx`update payment_attempts set state='unknown',error_code='payments_clip_create_outcome_unknown',
          version=version+1 where id=${attemptId}`;
      await workerEvent(tx, tenantId, attemptId, "unknown", {
        code: "payments_clip_create_outcome_unknown",
        before: "sending",
      });
      return { a, account, description: "", clipUnknown: true };
    }
    if (a.state === "created") {
      await tx`update payment_attempts set state='sending',sent_at=now(),version=version+1
        where id=${attemptId}`;
      await workerEvent(tx, tenantId, attemptId, "sent");
    } else {
      // An MP re-POST (same key, identical body): sent_at is the latest send, so the deadline and
      // «No se cobró»'s margin cover an order this send creates (P2-MONEY-2).
      await tx`update payment_attempts set sent_at=now(),version=version+1 where id=${attemptId}`;
      await workerEvent(tx, tenantId, attemptId, "resent", { source: "push" });
    }
    const description = (await mpCreateInput(tx, a)).description;
    return { a, account, description, clipUnknown: false };
  });
  if (unknownWithoutCall) raise(rt, unknownAlert(tenantId, "create"));
  if (!step) return { status: "done" };
  const { a, account } = step;
  if (step.clipUnknown) {
    await withdrawBySerial(ctx, rt, a, account);
    raise(rt, unknownAlert(tenantId, "clip_create"));
    return { status: "done" };
  }
  let reference: string;
  try {
    if (a.provider === "mercadopago")
      reference = (
        await createPointOrder(mpClient(rt, account, ctx.signal), {
          attemptId,
          total: a.amount + a.tip,
          terminalId: a.provider_device_id,
          expiration: PAYMENTS_LIMITS.mpExpiration[a.origin],
          description: step.description,
        })
      ).id;
    else
      reference = (
        await createPinPadPayment(clipClient(rt, account, ctx.signal), {
          amount: a.amount,
          tip: a.tip,
          reference: attemptId,
          serial: a.provider_device_id,
          webhookUrl: rt.appUrl
            ? `${rt.appUrl}/api/payments/webhooks/clip/${account.credentials.hookToken}`
            : null,
        })
      ).pinpadRequestId;
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    if (e.code === "payments_credentials_rejected") {
      // A 401/403 on the create: the account fails only if its verification call is refused too;
      // otherwise MP refused this terminal (403 forbidden_checking_terminal_owner: a device linked
      // to another account), which declines this charge and leaves the account alone.
      if (
        !(await failIfRefused(ctx, rt, a.provider, account)) &&
        e.status === 403
      )
        e.code = "payments_terminal_not_linked";
    }
    if (a.provider === "mercadopago" && e.status === 429) {
      const limited = await ctx.tenant((tx) =>
        rateLimited(tx, tenantId, attemptId, ctx.job.attempts, e.retryAfterMs),
      );
      if (limited.verdict === "retry")
        return { status: "retry", code: e.code, afterMs: limited.afterMs };
      if (limited.verdict !== "ambiguous") return { status: "done" };
      // An earlier try may have reached MP: the path below, as for any retryable failure.
    }
    if (e.retryable && a.provider === "mercadopago" && ctx.job.attempts < 3)
      // Same idempotency key on the next run: MP returns the same order if it exists.
      return {
        status: "retry",
        code: e.code,
        afterMs: e.retryAfterMs ?? 2000,
      };
    // A re-POST (an earlier run of this push committed `sending` and may have reached MP) is never
    // declined unless MP's answer proves no order exists (a 400 validation error the identical
    // body would have had the first time): a 409 already_queued_order_for_terminal, a 401/403 or a
    // 409 idempotency_key_already_used may all be about the order the first send created
    // (P2-MONEY-4, P2-PROVIDERS-2).
    const resend = a.provider === "mercadopago" && a.state === "sending";
    // A Clip create answered 429 was refused before Clip processed it: no payment request exists
    // (unambiguous, LD-82). A Clip create is sent once and never again (no idempotency key), so the
    // charge declines payments_provider_unavailable, which offers the cashier the manual fallback,
    // instead of «Sin confirmar» and a withdrawal of nothing.
    const clipRefused = a.provider === "clip" && e.status === 429;
    const unknown =
      !clipRefused &&
      (e.retryable ||
        e.code === "payments_clip_create_outcome_unknown" ||
        (resend && !provesNoOrder(e)));
    const code = unknown
      ? a.provider === "clip"
        ? "payments_clip_create_outcome_unknown"
        : "payments_provider_unreachable"
      : clipRefused
        ? "payments_provider_unavailable"
        : e.code;
    await ctx.tenant(async (tx) => {
      const now = await lockAttempt(tx, attemptId);
      if (now?.state !== "sending") return;
      await tx`update payment_attempts set state=${unknown ? "unknown" : "declined"},
          error_code=${code},decided_at=${unknown ? null : new Date()},version=version+1
        where id=${attemptId}`;
      await workerEvent(
        tx,
        tenantId,
        attemptId,
        unknown ? "unknown" : "declined",
        {
          code,
          providerCode: e.providerCode,
          httpStatus: e.status,
        },
      );
    });
    if (unknown) {
      if (a.provider === "clip") await withdrawBySerial(ctx, rt, a, account);
      // MP: one automatic recovery (the identical re-POST) half a minute later (P2-MONEY-2).
      else
        await ctx.tenant((tx) =>
          queueRecovery(tx, tenantId, attemptId, "push"),
        );
      raise(rt, unknownAlert(tenantId, "create"));
    }
    return { status: "done" };
  }
  await ctx.tenant(async (tx) => {
    const now = await lockAttempt(tx, attemptId);
    if (now?.state !== "sending") return;
    await tx`update payment_attempts set state='pending',provider_reference=${reference},
        version=version+1 where id=${attemptId}`;
    await workerEvent(tx, tenantId, attemptId, "pending", { reference });
    // A cancel requested while this push was sending: hand it on now (the provider has an id).
    await handOffCancel(
      tx,
      tenantId,
      { ...now, state: "pending", provider_reference: reference },
      "push",
    );
    await schedulePoll(
      tx,
      tenantId,
      attemptId,
      "p",
      1,
      fastPollMs(a.provider),
    );
  });
  return { status: "done" };
}

/**
 * payments_push went dead (its last claim threw, its lease expired on that claim, or a manager
 * cancelled it in Operaciones) with the attempt still `sending`: the provider may hold the charge
 * (MP keeps the order under the attempt id, Clip's create may have reached the reader), so the
 * attempt becomes `unknown` (`payments_push_failed`) through the worker's own transition, alerted
 * like any unknown outcome. The POS then offers «Volver a consultar» and a manager's «Resolver
 * cobro», and Excepciones lists it after 10 minutes. A recovery job follows (queueRecovery): MP
 * re-POSTs the identical create under the same idempotency key (the attempt id) to learn the order
 * id; Clip only withdraws by serial, a Clip create is never repeated. A `created` attempt never
 * reached the provider (`sending` is committed before the call) and is declined.
 *
 * It runs in the dead write's transaction (P2-CONCURRENCY-6): jobs row first, then the attempt
 * (LO-2c). A throw rolls the dead write back and the runner's lease-expiry pass tries both again,
 * so a dead push never leaves its attempt `sending`.
 */
export const pushDead: JobDeadHook = async (ctx) => {
  const attemptId = id((ctx.job.payload as { attemptId?: unknown })?.attemptId);
  if (!attemptId) return;
  const tenantId = ctx.job.tenantId;
  const tx = ctx.tx;
  const a = await lockAttempt(tx, attemptId);
  if (a?.state === "created") {
    // Never sent (no worker runtime for three claims, or its first step kept failing): nothing
    // reached the provider, so it is declined and the order and terminal are free again
    // (P2-MONEY-7; before, it stayed created, live, and only its own device could cancel it).
    await tx`update payment_attempts set state='sending',sent_at=now(),version=version+1
      where id=${attemptId}`;
    await tx`update payment_attempts set state='declined',error_code='payments_provider_unavailable',
        decided_at=now(),version=version+1 where id=${attemptId}`;
    await workerEvent(tx, tenantId, attemptId, "declined", {
      code: "payments_provider_unavailable",
      before: "created",
    });
    return;
  }
  if (a?.state !== "sending") return;
  await tx`update payment_attempts set state='unknown',error_code='payments_push_failed',
      version=version+1 where id=${attemptId}`;
  await workerEvent(tx, tenantId, attemptId, "unknown", {
    code: "payments_push_failed",
    before: "sending",
  });
  // Not a dead end (P2-CONCURRENCY-5): MP re-POSTs the identical create to learn the order id;
  // Clip withdraws whatever the reader has not taken (delete by serial). Never a Clip create.
  await queueRecovery(tx, tenantId, attemptId, "dead", 5_000);
  ctx.afterCommit(() => {
    const rt = paymentsRuntime();
    if (rt) raise(rt, unknownAlert(tenantId, "push_failed"));
  });
};

/**
 * A Clip create with an unknown outcome: withdraw whatever the reader has not picked up yet
 * (documented delete by serial number). Best effort; recorded as an event either way.
 */
async function withdrawBySerial(
  ctx: JobContext,
  rt: PaymentsRuntime,
  a: WorkerAttempt,
  account: ActiveAccount,
) {
  let r: CancelResult | null = null;
  try {
    r = await cancelBySerial(
      clipClient(rt, account, ctx.signal),
      a.provider_device_id,
    );
  } catch {
    r = null;
  }
  const tenantId = ctx.job.tenantId;
  await ctx.tenant(async (tx) => {
    await workerEvent(tx, tenantId, a.id, "cancel_by_serial", {
      cancelled: r ? r.cancelled : null,
      providerCode: r && !r.cancelled ? r.code : null,
    });
    const now = await lockAttempt(tx, a.id);
    if (!r || now?.state !== "unknown" || now.provider_reference) return;
    // The evidence «No se cobró» needs for a Clip request with no id (P2-MONEY-3): Clip withdrew
    // this attempt's own request (its 200 body names it) → cancelled, nothing was charged; the
    // reader holds a payment (400 PAYMENT_PENDING) → it may still charge; anything else → nothing
    // of this attempt waits on the reader.
    if (r.cancelled && r.reference === a.id && r.pinpadRequestId) {
      const [taken] =
        await tx`select id from payment_attempts where provider='clip'
        and lower(provider_reference)=lower(${r.pinpadRequestId}) limit 1`;
      if (!taken) {
        await tx`update payment_attempts set state='cancelled',provider_reference=${r.pinpadRequestId},
            provider_status='serial_withdrawn',error_code=null,decided_at=now(),version=version+1
          where id=${a.id}`;
        await workerEvent(tx, tenantId, a.id, "cancelled", {
          source: "serial",
          reference: r.pinpadRequestId,
        });
        return;
      }
    }
    const status =
      !r.cancelled && r.code === "PAYMENT_PENDING"
        ? "serial_pending"
        : "serial_clear";
    await tx`update payment_attempts set provider_status=${status},version=version+1
      where id=${a.id}`;
  });
}

/**
 * A pending Clip request past its deadline (P2-PROVIDERS-3): withdraw it (DELETE /payment/{id},
 * which works until the reader picks it up). Withdrawn → cancelled. Refused (the reader holds it)
 * or unreachable → unknown (payments_attempt_timeout), alerted, and watched: read every
 * clipWatchMs until the reader settles it either way.
 */
async function clipDeadline(ctx: JobContext, rt: PaymentsRuntime, l: Usable) {
  const tenantId = ctx.job.tenantId;
  const attemptId = l.attempt.id;
  let r: CancelResult | null = null;
  try {
    r = await cancelPinPadPayment(
      clipClient(rt, l.account, ctx.signal),
      l.attempt.provider_reference!,
    );
  } catch {
    r = null;
  }
  const unknown = await ctx.tenant(async (tx) => {
    const a = await lockAttempt(tx, attemptId);
    if (a?.state !== "pending") return false;
    if (r?.cancelled) {
      await tx`update payment_attempts set state='cancelled',error_code=null,decided_at=now(),
          version=version+1 where id=${attemptId}`;
      await workerEvent(tx, tenantId, attemptId, "cancelled", {
        source: "deadline",
      });
      return false;
    }
    await tx`update payment_attempts set state='unknown',error_code='payments_attempt_timeout',
        version=version+1 where id=${attemptId}`;
    await workerEvent(tx, tenantId, attemptId, "unknown", {
      code: "payments_attempt_timeout",
      providerCode: r && !r.cancelled ? r.code : null,
      source: "deadline",
    });
    await schedulePoll(
      tx,
      tenantId,
      attemptId,
      newChain(),
      1,
      PAYMENTS_LIMITS.clipWatchMs,
    );
    return true;
  });
  if (unknown) raise(rt, unknownAlert(tenantId, "no_final_status"));
}

/**
 * payments_poll on a worker that serves no provider: PAYMENTS_PROVIDERS unset or emptied while
 * charges are live (P2V-GATE-4). Nothing can be read or withdrawn, but the chain still carries a
 * pending attempt to its deadline (one link a minute, never a retry that would use up the job's
 * claims), where it becomes unknown (payments_provider_unavailable), alerted, for a manager to
 * resolve: the same path as an account that cannot be used. A watched Clip request keeps its
 * watch, so reads resume once the providers are back.
 */
async function pollWithoutProviders(
  ctx: JobContext,
  attemptId: string,
  chain: string,
  seq: number,
): Promise<JobOutcome> {
  const tenantId = ctx.job.tenantId;
  const unknown = await ctx.tenant(async (tx) => {
    const a = await lockAttempt(tx, attemptId);
    if (!a || !a.provider_reference) return false;
    if (clipWatch(a)) {
      await schedulePoll(
        tx,
        tenantId,
        attemptId,
        chain,
        seq + 1,
        PAYMENTS_LIMITS.clipWatchMs,
      );
      return false;
    }
    if (a.state !== "pending") return false;
    if (Date.now() <= deadline(a)) {
      await schedulePoll(
        tx,
        tenantId,
        attemptId,
        chain,
        seq + 1,
        PAYMENTS_LIMITS.providersOffPollMs,
      );
      return false;
    }
    await tx`update payment_attempts set state='unknown',error_code='payments_provider_unavailable',
        version=version+1 where id=${attemptId}`;
    await workerEvent(tx, tenantId, attemptId, "unknown", {
      code: "payments_provider_unavailable",
      source: "no_providers",
    });
    return true;
  });
  // No runtime, so no payments alert sink: the operations sink (ALERT_WEBHOOK_URL).
  if (unknown)
    void sendAlert(unknownAlert(tenantId, "providers_off")).catch(
      () => undefined,
    );
  return { status: "done" };
}

/** payments_poll: one read of a pending attempt, then the next link of its chain. */
export async function pollHandler(ctx: JobContext): Promise<JobOutcome> {
  const rt = paymentsRuntime();
  const p = ctx.job.payload as {
    attemptId?: unknown;
    chain?: unknown;
    seq?: unknown;
  };
  const attemptId = id(p?.attemptId);
  const chain =
    typeof p?.chain === "string" && /^[a-z0-9]{1,12}$/.test(p.chain)
      ? p.chain
      : "p";
  const seq = Number.isInteger(p?.seq) ? (p.seq as number) : 1;
  if (!attemptId) return { status: "dead", code: "invalid_payload" };
  if (!rt) return pollWithoutProviders(ctx, attemptId, chain, seq);
  const tenantId = ctx.job.tenantId;
  // A database failure throws here: the runner retries this link with back-off (never "done",
  // which would end the chain with the attempt pending).
  const loaded = await load(ctx, rt, attemptId);
  const a = loaded?.attempt;
  if (
    !loaded ||
    !a ||
    (a.state !== "pending" && !clipWatch(a)) ||
    !a.provider_reference
  )
    return { status: "done" };
  let withdraw = false;
  /** The chain's next link, or `unknown` once the deadline passed (the only pending → unknown). */
  const next = async (
    afterMs: number,
    timeoutCode = "payments_attempt_timeout",
  ) =>
    ctx.tenant(async (tx) => {
      const now = await readAttempt(tx, attemptId);
      if (now && clipWatch(now)) {
        await schedulePoll(
          tx,
          tenantId,
          attemptId,
          chain,
          seq + 1,
          PAYMENTS_LIMITS.clipWatchMs,
        );
        return;
      }
      if (now?.state !== "pending") return;
      if (Date.now() > deadline(now)) {
        if (
          now.provider === "clip" &&
          timeoutCode === "payments_attempt_timeout"
        ) {
          // Withdraw it first (outside this transaction: a provider call).
          withdraw = true;
          return;
        }
        const locked = await lockAttempt(tx, attemptId);
        if (locked?.state !== "pending") return;
        await tx`update payment_attempts set state='unknown',error_code=${timeoutCode},
            version=version+1 where id=${attemptId}`;
        await workerEvent(tx, tenantId, attemptId, "unknown", {
          code: timeoutCode,
        });
        raise(
          rt,
          unknownAlert(
            tenantId,
            timeoutCode === "payments_attempt_timeout"
              ? "no_final_status"
              : "account_unusable",
          ),
        );
        return;
      }
      await handOffCancel(tx, tenantId, now, `poll:${chain}:${seq}`);
      await schedulePoll(tx, tenantId, attemptId, chain, seq + 1, afterMs);
    });
  if (!usable(loaded)) {
    // The account is verifying, failed or disabled, or its box cannot be opened: no read is
    // possible, but the chain lives on (slow cadence) so the attempt still reaches its deadline,
    // and resumes reading as soon as the owner reconnects.
    await next(PAYMENTS_LIMITS.pollSlowMs, loaded.accountError!);
    return { status: "done" };
  }
  const elapsed = Date.now() - new Date(a.sent_at ?? a.created_at).getTime();
  const cadence =
    elapsed < PAYMENTS_LIMITS.pollFastForMs
      ? fastPollMs(a.provider)
      : PAYMENTS_LIMITS.pollSlowMs;
  // Every branch below ends here: a Clip request past its deadline is withdrawn (or becomes a
  // watched unknown) whatever the read said, including a failed read or a 404 (P2V-FIXES-1).
  // Before, only a successful read reached the withdrawal, so a 5xx/429/timeout/404 on the first
  // link past the deadline ended the chain with the attempt pending for good.
  const finish = async (): Promise<JobOutcome> => {
    if (withdraw) await clipDeadline(ctx, rt, loaded);
    return { status: "done" };
  };
  let read: Read | null;
  try {
    read = await readProvider(rt, loaded, ctx.signal);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    if (e.code === "payments_credentials_rejected")
      await failIfRefused(ctx, rt, a.provider, loaded.account);
    // A read failure never changes the attempt: keep polling, never sooner than the slow
    // cadence (P2V-FIXES-4: MP's 429 limit is per access token, shared by every live charge of
    // the restaurant, so a 3.5 s default back-off read faster than the 5 s fresh cadence), or
    // the provider's Retry-After when longer.
    await next(
      Math.max(e.retryAfterMs ?? 0, cadence, PAYMENTS_LIMITS.pollSlowMs),
    );
    return finish();
  }
  if (!read) {
    await next(PAYMENTS_LIMITS.pollSlowMs);
    return finish();
  }
  const outcome = await ctx.tenant((tx) =>
    applyRead(tx, rt, tenantId, attemptId, read, "poll"),
  );
  if (outcome === "continue" || outcome === "restart") await next(cadence);
  return finish();
}

/**
 * payments_cancel: re-read first (a just-approved charge is approved, not cancelled), then cancel
 * at the provider. Only a provider-confirmed cancel or final status frees the order (pos-lite
 * freed it when MP's cancel failed: P3). A refusal keeps the attempt pending with
 * payments_cancel_on_terminal ("cancélalo en la terminal").
 */
export async function cancelHandler(ctx: JobContext): Promise<JobOutcome> {
  const rt = paymentsRuntime();
  const attemptId = id((ctx.job.payload as { attemptId?: unknown })?.attemptId);
  if (!attemptId) return { status: "dead", code: "invalid_payload" };
  if (!rt)
    return {
      status: "retry",
      code: "payments_provider_unavailable",
      afterMs: 30_000,
    };
  const tenantId = ctx.job.tenantId;
  const head = await ctx.tenant((tx) => readAttempt(tx, attemptId));
  if (!head) return { status: "done" };
  if (head.state === "created" || head.state === "sending")
    // The push has not recorded the provider's answer yet. It hands the request on itself when it
    // does (handOffCancel), and so does every poll link: this wait is only for latency.
    return { status: "retry", code: "payments_cancel_waiting", afterMs: 5000 };
  if (head.state !== "pending" && head.state !== "unknown")
    return { status: "done" };
  const loaded = await load(ctx, rt, attemptId);
  if (!loaded) return { status: "done" };
  if (!usable(loaded))
    // No provider call possible now: try again later (the owner may be reconnecting).
    return {
      status: "retry",
      code: loaded.accountError ?? "payments_provider_not_configured",
      afterMs: 30_000,
    };
  let l: Usable = loaded;
  if (!l.attempt.provider_reference) {
    if (l.attempt.provider === "clip") {
      await withdrawBySerial(ctx, rt, l.attempt, l.account);
      return { status: "done" };
    }
    // MP: learn the order id first (identical re-POST; or a concurrent recovery adopted it), then
    // cancel it like any pending order.
    await recoverMpReference(ctx, rt, l, "cancel");
    const again = await load(ctx, rt, attemptId);
    if (!usable(again) || !again.attempt.provider_reference)
      return { status: "done" };
    l = again;
  }
  const a = l.attempt;
  const read = await readProvider(rt, l, ctx.signal);
  if (read && read.outcome !== "pending") {
    await ctx.tenant((tx) =>
      applyRead(tx, rt, tenantId, attemptId, read, "cancel"),
    );
    return { status: "done" };
  }
  const result =
    a.provider === "mercadopago"
      ? await cancelPointOrder(mpClient(rt, l.account, ctx.signal), {
          orderId: a.provider_reference!,
          // One key per cancel operation, stable across this job's retries (P2-PROVIDERS-6).
          key: ctx.job.id,
        })
      : {
          ...(await cancelPinPadPayment(
            clipClient(rt, l.account, ctx.signal),
            a.provider_reference!,
          )),
          requested: false,
        };
  if (!result.cancelled && !result.requested) {
    // Refused: read once more and apply what the provider says (MP's 409 order_already_canceled
    // is a cancel; a charge paid meanwhile is an approval), before telling staff to cancel on
    // the device.
    const again = await readProvider(rt, l, ctx.signal).catch(() => null);
    if (again && again.outcome !== "pending") {
      const final = again;
      await ctx.tenant((tx) =>
        applyRead(tx, rt, tenantId, attemptId, final, "cancel"),
      );
      return { status: "done" };
    }
  }
  await ctx.tenant(async (tx) => {
    const now = await lockAttempt(tx, attemptId);
    if (now?.state !== "pending" && now?.state !== "unknown") return;
    if (result.cancelled) {
      await tx`update payment_attempts set state='cancelled',error_code=null,decided_at=now(),
          version=version+1 where id=${attemptId}`;
      await workerEvent(tx, tenantId, attemptId, "cancelled", {
        source: "cancel",
      });
    } else if (result.requested) {
      // MP asked the device (202): the order stays at_terminal until it confirms; the poll's
      // read decides (cancelled, or paid if the diner was faster). Never cancelled from here.
      if (now.state === "pending")
        await tx`update payment_attempts set error_code='payments_cancel_sent',version=version+1
          where id=${attemptId}`;
      await workerEvent(tx, tenantId, attemptId, "cancel_sent", {
        source: "cancel",
      });
    } else {
      // An unknown attempt keeps its own code (a watched Clip request stays watched).
      if (now.state === "pending")
        await tx`update payment_attempts set error_code='payments_cancel_on_terminal',version=version+1
          where id=${attemptId}`;
      await workerEvent(tx, tenantId, attemptId, "cancel_refused", {
        providerCode: "code" in result ? result.code : null,
      });
    }
  });
  return { status: "done" };
}

/**
 * payments_webhook: an MP notification (verified here, with the sealed secret, before anything
 * else), a Clip hint or a "Volver a consultar" request. Then the same provider read as a poll.
 */
export async function webhookHandler(ctx: JobContext): Promise<JobOutcome> {
  const rt = paymentsRuntime();
  const p = ctx.job.payload as {
    attemptId?: unknown;
    source?: unknown;
    dataId?: unknown;
    requestId?: unknown;
    ts?: unknown;
    v1?: unknown;
  };
  const attemptId = id(p?.attemptId);
  const source =
    p?.source === "mercadopago" ||
    p?.source === "clip" ||
    p?.source === "check" ||
    p?.source === "recover"
      ? p.source
      : null;
  if (!attemptId || !source) return { status: "dead", code: "invalid_payload" };
  if (!rt)
    return {
      status: "retry",
      code: "payments_provider_unavailable",
      afterMs: 30_000,
    };
  const tenantId = ctx.job.tenantId;
  const loaded = await load(ctx, rt, attemptId);
  if (!loaded) return { status: "done" };
  const a = loaded.attempt;
  if (!usable(loaded)) {
    // Nothing can be verified or read now. A pending attempt keeps (or regains) its chain, which
    // carries it to its deadline.
    if (a.state === "pending")
      await ctx.tenant((tx) => ensureChain(tx, tenantId, attemptId));
    return { status: "done" };
  }
  if (source === "mercadopago") {
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const valid =
      a.provider === "mercadopago" &&
      loaded.account.credentials.provider === "mercadopago" &&
      verifyMpSignature({
        secret: loaded.account.credentials.webhookSecret,
        dataId: str(p.dataId),
        requestId: str(p.requestId),
        ts: str(p.ts),
        v1: str(p.v1),
      });
    await ctx.tenant((tx) =>
      workerEvent(
        tx,
        tenantId,
        attemptId,
        valid ? "webhook" : "webhook_rejected",
        {
          source,
          requestId: str(p.requestId)?.slice(0, 64) ?? null,
        },
      ),
    );
    if (!valid) return { status: "done" };
  } else if (source === "clip")
    await ctx.tenant((tx) =>
      workerEvent(tx, tenantId, attemptId, "webhook", { source }),
    );
  let l: Usable = loaded;
  if (a.state === "unknown" && !a.provider_reference) {
    // No reference to read (P2-MONEY-2, P2-UX-4): recover one. A verified MP notification or a
    // Clip hint names an id to check against this attempt; a re-check or the automatic recovery
    // re-POSTs MP's identical create, or withdraws a Clip request by serial (never a Clip create).
    const dataId =
      typeof p.dataId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(p.dataId)
        ? p.dataId
        : null;
    let adopted = false;
    if ((source === "mercadopago" || source === "clip") && dataId)
      adopted = await adoptNotified(ctx, rt, l, dataId, source);
    else if (source === "check" || source === "recover") {
      if (a.provider === "mercadopago")
        adopted = await recoverMpReference(ctx, rt, l, source);
      else await withdrawBySerial(ctx, rt, a, l.account);
    }
    if (!adopted) return { status: "done" };
    const again = await load(ctx, rt, attemptId);
    if (!usable(again)) return { status: "done" };
    l = again;
  }
  if (
    (l.attempt.state !== "pending" && l.attempt.state !== "unknown") ||
    !l.attempt.provider_reference
  )
    return { status: "done" };
  let read: Read | null;
  try {
    read = await readProvider(rt, l, ctx.signal);
  } catch (e) {
    if (e instanceof ProviderError && e.retryable)
      return { status: "retry", code: e.code, afterMs: e.retryAfterMs ?? 3000 };
    return { status: "done" };
  }
  if (!read) return { status: "done" };
  await ctx.tenant(async (tx) => {
    const outcome = await applyRead(tx, rt, tenantId, attemptId, read, source);
    // Still (or again) pending: make sure a chain carries it to its deadline.
    if (outcome === "restart" || outcome === "continue")
      await ensureChain(tx, tenantId, attemptId);
  });
  return { status: "done" };
}
