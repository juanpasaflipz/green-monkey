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
import type { JobContext, JobOutcome } from "../../jobs.js";
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
/** When an attempt with no final status becomes unknown (spec §2.4 step 7). */
function deadline(a: WorkerAttempt): number {
  const start = new Date(a.sent_at ?? a.created_at).getTime();
  return (
    start +
    isoMinutes(PAYMENTS_LIMITS.mpExpiration[a.origin]) +
    PAYMENTS_LIMITS.unknownAfterExpiryMs
  );
}

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
    if (e instanceof ProviderError && e.code === "payments_credentials_rejected")
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
      // Paid at the provider but no amount to record: a manager decides (never a guess).
      if (a.state === "pending")
        await tx`update payment_attempts set state='unknown',provider_status=${status},
            error_code='payments_provider_mismatch',version=version+1
          where id=${attemptId}`;
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
  await tx`update payment_attempts set state=${state},provider_status=${status},
      error_code=${state === "declined" ? "payments_provider_rejected" : null},decided_at=now(),
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
  if (!live)
    await schedulePoll(
      tx,
      tenantId,
      attemptId,
      newChain(),
      1,
      PAYMENTS_LIMITS.pollFastMs,
    );
}

// ---------------------------------------------------------------------------------------------

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
    }
    const [o] = a.order_id
      ? await tx`select number from orders where id=${a.order_id}`
      : [];
    const description = o ? `Orden ${o.number}` : a.terminal_label;
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
      if (!(await failIfRefused(ctx, rt, a.provider, account)) && e.status === 403)
        e.code = "payments_terminal_not_linked";
    }
    if (e.retryable && a.provider === "mercadopago" && ctx.job.attempts < 3)
      // Same idempotency key on the next run: MP returns the same order if it exists.
      return {
        status: "retry",
        code: e.code,
        afterMs: e.retryAfterMs ?? 2000,
      };
    const unknown =
      e.retryable || e.code === "payments_clip_create_outcome_unknown";
    const code = unknown
      ? a.provider === "clip"
        ? "payments_clip_create_outcome_unknown"
        : "payments_provider_unreachable"
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
    await schedulePoll(
      tx,
      tenantId,
      attemptId,
      "p",
      1,
      PAYMENTS_LIMITS.pollFastMs,
    );
  });
  return { status: "done" };
}

/**
 * payments_push went dead (its last claim threw, or its lease expired on that claim) with the
 * attempt still `sending`: the provider may hold the charge (MP keeps the order under the attempt
 * id, Clip's create may have reached the reader), so the attempt becomes `unknown`
 * (`payments_push_failed`) through the worker's own transition, alerted like any unknown outcome.
 * The POS then offers «Volver a consultar» and a manager's «Resolver cobro», and Excepciones lists
 * it after 10 minutes. Nothing is sent again: MP's idempotency key stays the attempt id and a
 * Clip create is never repeated. A `created` attempt never reached the provider (`sending` is
 * committed before the call) and stays cancellable from the POS.
 */
export async function pushDead(ctx: {
  job: JobContext["job"];
  tenant: JobContext["tenant"];
}): Promise<void> {
  const attemptId = id((ctx.job.payload as { attemptId?: unknown })?.attemptId);
  if (!attemptId) return;
  const tenantId = ctx.job.tenantId;
  const moved = await ctx.tenant(async (tx) => {
    const a = await lockAttempt(tx, attemptId);
    if (a?.state !== "sending") return false;
    await tx`update payment_attempts set state='unknown',error_code='payments_push_failed',
        version=version+1 where id=${attemptId}`;
    await workerEvent(tx, tenantId, attemptId, "unknown", {
      code: "payments_push_failed",
      before: "sending",
    });
    return true;
  });
  const rt = paymentsRuntime();
  if (moved && rt) raise(rt, unknownAlert(tenantId, "push_failed"));
}

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
  let cancelled: boolean | null = null;
  let providerCode: string | null = null;
  try {
    const r = await cancelBySerial(
      clipClient(rt, account, ctx.signal),
      a.provider_device_id,
    );
    cancelled = r.cancelled;
    providerCode = r.cancelled ? null : r.code;
  } catch {
    cancelled = null;
  }
  await ctx.tenant((tx) =>
    workerEvent(tx, ctx.job.tenantId, a.id, "cancel_by_serial", {
      cancelled,
      providerCode,
    }),
  );
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
  if (!rt)
    return {
      status: "retry",
      code: "payments_provider_unavailable",
      afterMs: 60_000,
    };
  const tenantId = ctx.job.tenantId;
  // A database failure throws here: the runner retries this link with back-off (never "done",
  // which would end the chain with the attempt pending).
  const loaded = await load(ctx, rt, attemptId);
  const a = loaded?.attempt;
  if (!loaded || !a || a.state !== "pending" || !a.provider_reference)
    return { status: "done" };
  /** The chain's next link, or `unknown` once the deadline passed (the only pending → unknown). */
  const next = async (afterMs: number, timeoutCode = "payments_attempt_timeout") =>
    ctx.tenant(async (tx) => {
      const now = await readAttempt(tx, attemptId);
      if (now?.state !== "pending") return;
      if (Date.now() > deadline(now)) {
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
      ? PAYMENTS_LIMITS.pollFastMs
      : PAYMENTS_LIMITS.pollSlowMs;
  let read: Read | null;
  try {
    read = await readProvider(rt, loaded, ctx.signal);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    if (e.code === "payments_credentials_rejected")
      await failIfRefused(ctx, rt, a.provider, loaded.account);
    // A read failure never changes the attempt: keep polling (429: MP's observed back-off).
    await next(e.retryAfterMs ?? Math.max(cadence, PAYMENTS_LIMITS.pollSlowMs));
    return { status: "done" };
  }
  if (!read) {
    await next(PAYMENTS_LIMITS.pollSlowMs);
    return { status: "done" };
  }
  const outcome = await ctx.tenant((tx) =>
    applyRead(tx, rt, tenantId, attemptId, read, "poll"),
  );
  if (outcome === "continue" || outcome === "restart") await next(cadence);
  return { status: "done" };
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
    // The push has not recorded the provider's answer yet.
    return { status: "retry", code: "payments_cancel_waiting", afterMs: 2000 };
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
  const a = loaded.attempt;
  if (!a.provider_reference) {
    if (a.provider === "clip")
      await withdrawBySerial(ctx, rt, a, loaded.account);
    return { status: "done" };
  }
  const read = await readProvider(rt, loaded, ctx.signal);
  if (read && read.outcome !== "pending") {
    await ctx.tenant((tx) =>
      applyRead(tx, rt, tenantId, attemptId, read, "cancel"),
    );
    return { status: "done" };
  }
  const result =
    a.provider === "mercadopago"
      ? await cancelPointOrder(mpClient(rt, loaded.account, ctx.signal), {
          orderId: a.provider_reference,
          attemptId,
          atTerminal: read?.atTerminal ?? false,
        })
      : await cancelPinPadPayment(
          clipClient(rt, loaded.account, ctx.signal),
          a.provider_reference,
        );
  await ctx.tenant(async (tx) => {
    const now = await lockAttempt(tx, attemptId);
    if (now?.state !== "pending" && now?.state !== "unknown") return;
    if (result.cancelled) {
      await tx`update payment_attempts set state='cancelled',error_code=null,decided_at=now(),
          version=version+1 where id=${attemptId}`;
      await workerEvent(tx, tenantId, attemptId, "cancelled", {
        source: "cancel",
      });
    } else {
      await tx`update payment_attempts set error_code='payments_cancel_on_terminal',version=version+1
        where id=${attemptId}`;
      await workerEvent(tx, tenantId, attemptId, "cancel_refused", {
        providerCode: result.code,
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
    p?.source === "mercadopago" || p?.source === "clip" || p?.source === "check"
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
  if ((a.state !== "pending" && a.state !== "unknown") || !a.provider_reference)
    return { status: "done" };
  let read: Read | null;
  try {
    read = await readProvider(rt, loaded, ctx.signal);
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
