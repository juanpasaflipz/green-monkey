// Integrated terminal charges, web side (payments spec §4.3; critic R10 and R13): start, sync,
// cancel, settle (exactly once), manager resolution and operator retry, the active list, and the
// settler registry the kiosk (039) extends. Provider calls never happen here: the worker
// (server/payments/worker/**) pushes, polls and cancels; this module only writes attempt rows,
// queues worker jobs and records the tender.
//
// Lock order (ARCHITECTURE rows 41-46, critic R4):
//   startCharge (POS)   1 → 2 → 3 (933 terminal key) → 5 → 11 → attempt insert (LO-R8)
//   requestCancel       1 → 2 → 2c
//   settle (order)      1 (settle_operation_id) → 2 → 2c → 5 → 11 (the attempt's drawer by id)
//                       → tender → refresh [12] → receipt job
//   resolve dismissals  1 → 2 → 2c → 5
//   record / retry      the settle sequence (the settle key is the operation key: no second LO-1)
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { tenant, type Tx } from "../db.js";
import { managers, operators, permit } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { audit, drawer, getOrder, once } from "../orders.js";
import { assertCheckWritable, refreshCheckState } from "../checks.js";
import { requirePro } from "../entitlements.js";
import { enqueueJob } from "../jobs.js";
import { assertNoLiveAttempt } from "./guards.js";
import { insertTender, tenderTerminal } from "./tenders.js";
import { wakeWorker, wakeWorkerFor } from "./wake.js";
import { allocatePayment } from "../../shared/settlement.js";
import {
  DomainError,
  id,
  type Order,
  type Session,
} from "../../shared/domain.js";
import {
  isLiveForOrder,
  isLiveForTerminal,
  PAYMENTS_LIMITS,
  resolveAttemptInput,
  startChargeInput,
  type AttemptState,
  type AttemptView,
  type CardType,
  type Provider,
} from "../../shared/payments.js";
import { z } from "zod";

/** A payment_attempts row as this module reads it. */
export type AttemptRow = {
  tenant_id: string;
  id: string;
  operation_id: string;
  settle_operation_id: string;
  target: "order" | "kiosk_hold";
  origin: "pos" | "kiosk";
  order_id: string | null;
  hold_id: string | null;
  terminal_id: string;
  provider: Provider;
  provider_device_id: string;
  terminal_label: string;
  amount: number;
  tip: number;
  currency: string;
  items: string[] | null;
  employee_id: string;
  device_id: string;
  session_id: string | null;
  cash_session_id: string;
  state: AttemptState;
  provider_reference: string | null;
  provider_payment_id: string | null;
  provider_status: string | null;
  paid_amount: number | null;
  fee: number | null;
  fee_source: "provider" | "estimated" | null;
  card_type: CardType | null;
  card_brand: string | null;
  card_last4: string | null;
  error_code: string | null;
  cancel_requested_at: Date | null;
  tender_id: string | null;
  resolution: string | null;
  created_at: Date;
  sent_at: Date | null;
  decided_at: Date | null;
  version: number;
};

const KIND_PROVIDER: Record<string, Provider | null> = {
  manual: null,
  mercadopago_point: "mercadopago",
  clip_pinpad: "clip",
};
/** Approval data the worker flagged: the settle sends these to review, never to a tender. */
const FLAGGED = new Set([
  "payments_provider_mismatch",
  "payments_refunded_before_settle",
]);

/** "PT10M" in milliseconds (MP's expiration_time as PAYMENTS_LIMITS spells it). */
const isoMinutes = (text: string) => {
  const m = /^PT(\d+)M$/.exec(text);
  return m ? Number(m[1]) * 60_000 : 10 * 60_000;
};

/**
 * Whether the provider may still take this unknown charge (P2-MONEY-3, P2-PROVIDERS-3; the fix
 * round's invariant): «No se cobró» needs a provider answer that it cannot, or the expiry margin.
 * - MP: until its order's expiration_time plus the 2-minute margin, counted from the latest send
 *   (a lost create answer or a re-POST may have put an order on the device).
 * - Clip with a request id: its requests never expire, so the reader may still take it until a
 *   read or a withdrawal says it cannot (that moves the attempt to cancelled or declined itself).
 * - Clip without an id: until the worker's delete by serial number said nothing of it waits on
 *   the reader (provider_status serial_clear).
 */
export function providerMayStillCharge(a: AttemptRow, now = Date.now()) {
  if (a.provider === "mercadopago")
    return (
      now <
      new Date(a.sent_at ?? a.created_at).getTime() +
        isoMinutes(PAYMENTS_LIMITS.mpExpiration[a.origin]) +
        PAYMENTS_LIMITS.unknownAfterExpiryMs
    );
  if (a.provider_reference) return true;
  return a.provider_status !== "serial_clear";
}

/** The attempt as the dialog, banner and resolve dialog see it (never secrets or raw data). */
export function attemptView(
  a: AttemptRow,
  extra: { orderNumber?: number | null; holdLabel?: string | null } = {},
): AttemptView {
  return {
    id: a.id,
    state: a.state,
    target: a.target,
    origin: a.origin,
    orderId: a.order_id,
    holdId: a.hold_id,
    orderNumber: extra.orderNumber ?? null,
    holdLabel: extra.holdLabel ?? null,
    terminalId: a.terminal_id,
    terminalLabel: a.terminal_label,
    provider: a.provider,
    amount: a.amount,
    tip: a.tip,
    paidAmount: a.paid_amount,
    providerReference: a.provider_reference,
    providerStatus: a.provider_status,
    cardType: a.card_type,
    cardBrand: a.card_brand,
    cardLast4: a.card_last4,
    errorCode: a.error_code,
    cancelRequested: Boolean(a.cancel_requested_at),
    resolution: a.resolution,
    createdAt: new Date(a.created_at).toISOString(),
    decidedAt: a.decided_at ? new Date(a.decided_at).toISOString() : null,
  };
}

async function readAttempt(tx: Tx, attemptId: string) {
  const [a] = await tx<
    AttemptRow[]
  >`select * from payment_attempts where id=${attemptId}`;
  if (!a) throw new DomainError("payments_attempt_not_found", 404);
  return a;
}
/** LO-2c: the attempt row, alone or after LO-1/LO-2 (never after an order lock). */
async function lockAttempt(tx: Tx, attemptId: string) {
  const [a] = await tx<
    AttemptRow[]
  >`select * from payment_attempts where id=${attemptId} for update`;
  if (!a) throw new DomainError("payments_attempt_not_found", 404);
  return a;
}
async function viewOf(tx: Tx, a: AttemptRow): Promise<AttemptView> {
  const [o] = a.order_id
    ? await tx`select number from orders where id=${a.order_id}`
    : [];
  const [h] = a.hold_id
    ? await tx`select channel,number from public_order_holds where id=${a.hold_id}`
    : [];
  return attemptView(a, {
    orderNumber: (o?.number as number | undefined) ?? null,
    holdLabel: h ? holdLabel(h.channel as string, h.number as number) : null,
  });
}
/** "Kiosco · K-14" / "QR · Q-3" (critic R8: hold targets are labelled by their hold). */
export function holdLabel(channel: string, number: number | null) {
  const prefix = channel === "kiosk" ? "K" : "Q";
  const name = channel === "kiosk" ? "Kiosco" : "QR";
  return `${name} · ${prefix}-${number ?? "?"}`;
}
async function event(
  tx: Tx,
  s: Pick<Session, "tenantId">,
  attemptId: string,
  kind: string,
  employeeId: string | null,
  detail: Record<string, unknown> = {},
) {
  await tx`insert into payment_attempt_events(tenant_id,id,attempt_id,kind,actor,employee_id,detail)
    values(${s.tenantId},${randomUUID()},${attemptId},${kind},${employeeId ? "employee" : "job"},
      ${employeeId},${tx.json(detail as never)})`;
}

// ---------------------------------------------------------------------------------------------
// Start

export type ChargeTarget =
  { kind: "order"; orderId: string } | { kind: "kiosk_hold"; holdId: string };

export type StartChargeInput = {
  operationId: string;
  target: ChargeTarget;
  terminalId: string;
  amount: number;
  tip: number;
  items?: string[];
  origin: "pos" | "kiosk";
};

/**
 * The start core (critic R10): checks and inserts one `created` attempt plus its push job. It takes
 * the 933 terminal key itself. The caller owns once() (the POS wrapper below; the kiosk's own
 * command) and, for a hold target, already holds LO-2b (hold, then checkout) and checks the hold.
 * Returns the attempt; the caller wakes the worker after commit.
 */
export async function startCharge(
  tx: Tx,
  s: Session,
  input: StartChargeInput,
): Promise<AttemptRow> {
  // LO-3: one start per terminal at a time (class 933, critic R3).
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + ":terminal:" + input.terminalId},933))`;
  const terminal = await tenderTerminal(tx, input.terminalId);
  if (!terminal) throw new DomainError("payments_terminal_not_found", 404);
  if (!terminal.active || terminal.archived_at)
    throw new DomainError("payments_terminal_inactive", 409);
  const provider = KIND_PROVIDER[terminal.kind] ?? null;
  if (!provider) throw new DomainError("payments_terminal_not_integrated", 409);
  const [platform] =
    await tx`select providers from payments_platform where id=1`;
  if (!platform || !(platform.providers as string[]).includes(provider))
    throw new DomainError("payments_provider_unavailable", 503);
  const [account] =
    await tx`select state from payment_provider_accounts where provider=${provider}`;
  if (account?.state !== "active")
    throw new DomainError("payments_provider_not_configured", 409);
  const [device] =
    await tx`select provider_device_id from payment_terminals where id=${terminal.id}`;
  // Q5: integrated charging is a Pro feature (manual terminals and platforms are on every plan).
  await requirePro(tx);
  if (s.restaurant.currency !== "MXN")
    throw new DomainError("payments_currency_unsupported", 409);
  if (
    provider === "mercadopago" &&
    input.amount + input.tip < PAYMENTS_LIMITS.mpMinAmount
  )
    throw new DomainError("payments_amount_below_min", 409);
  let orderId: string | null = null;
  if (input.target.kind === "order") {
    orderId = input.target.orderId;
    const [row] =
      await tx`select id,state,check_state from orders where id=${orderId} for update`;
    if (!row) throw new DomainError("not_found", 404);
    assertCheckWritable(row as { check_state: string; state: string });
    await assertNoLiveAttempt(tx, orderId);
    const o = await getOrder(tx, orderId);
    if (input.amount > o.total - o.paid)
      throw new DomainError("overpayment", 409);
    if (input.items) {
      if (!o.itemSplitAvailable)
        throw new DomainError("unallocated_history", 409);
      // A dry run: the allocations are recomputed at settle against the units then.
      allocatePayment(o.paymentUnits!, input.amount, input.items);
    }
  } else if (input.items) throw new DomainError("invalid_input");
  const d = await drawer(tx, s);
  const [busy] = await tx`select a.id from payment_attempts a
    where a.terminal_id=${terminal.id} and a.state in ('created','sending','pending','unknown') limit 1`;
  if (busy) throw new DomainError("payments_terminal_busy", 409);
  const attemptId = randomUUID();
  const [attempt] = await tx<AttemptRow[]>`
    insert into payment_attempts(tenant_id,id,operation_id,settle_operation_id,target,origin,order_id,hold_id,
      terminal_id,provider,provider_device_id,terminal_label,amount,tip,currency,items,employee_id,device_id,
      session_id,cash_session_id)
    values(${s.tenantId},${attemptId},${input.operationId},${randomUUID()},${input.target.kind},${input.origin},
      ${orderId},${input.target.kind === "kiosk_hold" ? input.target.holdId : null},${terminal.id},${provider},
      ${device.provider_device_id},${terminal.name.trim()},${input.amount},${input.tip},'MXN',
      ${input.items ?? null},${s.employeeId},${s.deviceId},${input.origin === "pos" ? s.id : null},${d.id})
    returning *`;
  await event(
    tx,
    s,
    attemptId,
    "created",
    input.origin === "pos" ? s.employeeId : null,
    {
      amount: input.amount,
      tip: input.tip,
    },
  );
  await enqueueJob(tx, s, {
    kind: "payments_push",
    dedupeKey: attemptId,
    payload: { attemptId },
  });
  return attempt;
}

/** POST /payments/terminal/charges (operators): the POS wrapper of startCharge. */
export async function startTerminalCharge(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<AttemptView> {
  permit(s, operators);
  const p = startChargeInput.parse(raw);
  return once(tx, s, p.operationId, "payments.start", p, async () => {
    const a = await startCharge(tx, s, {
      operationId: p.operationId,
      target: { kind: "order", orderId: p.orderId },
      terminalId: p.terminalId,
      amount: p.amount,
      tip: p.tip,
      items: p.items,
      origin: "pos",
    });
    await audit(tx, s, "payment.terminal_started", p.orderId, {
      attemptId: a.id,
      terminalId: a.terminal_id,
      provider: a.provider,
      amount: a.amount,
      tip: a.tip,
    });
    return viewOf(tx, a);
  });
}

// ---------------------------------------------------------------------------------------------
// Read and sync

/** GET /payments/terminal/charges/:id (operators). */
export async function getAttempt(tx: Tx, s: Session, attemptId: string) {
  permit(s, operators);
  id.parse(attemptId);
  return viewOf(tx, await readAttempt(tx, attemptId));
}

/** GET /payments/terminal/active (operators): live and review attempts, oldest first. */
export async function activeAttempts(tx: Tx, s: Session) {
  permit(s, operators);
  const rows = await tx<
    (AttemptRow & {
      order_number: number | null;
      hold_channel: string | null;
      hold_number: number | null;
    })[]
  >`select a.*, o.number as order_number, h.channel as hold_channel, h.number as hold_number
    from payment_attempts a
    left join orders o on o.tenant_id=a.tenant_id and o.id=a.order_id
    left join public_order_holds h on h.tenant_id=a.tenant_id and h.id=a.hold_id
    where a.state in ('created','sending','pending','unknown','approved','review')
    order by a.created_at, a.id limit 50`;
  return rows.map((r) =>
    attemptView(r, {
      orderNumber: r.order_number,
      holdLabel: r.hold_channel
        ? holdLabel(r.hold_channel, r.hold_number)
        : null,
    }),
  );
}

/** Runs fn in one tenant transaction (tenant(sql, …) or a job's ctx.tenant). */
export type TenantRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * The sync core (critic R10): no permit. Settles an approved attempt (settleAttemptWith) or wakes
 * the worker (debounced per attempt) while it is in flight. Never calls a provider. Returns the
 * view, plus the order when this call (or an earlier one) recorded the tender.
 */
export async function syncAttemptWith(
  run: TenantRunner,
  attemptId: string,
): Promise<{ attempt: AttemptView; order?: Order }> {
  const a = await run((tx) => readAttempt(tx, attemptId));
  if (a.state === "approved") {
    await settleAttemptWith(run, attemptId, "sync");
  } else if (isLiveForTerminal(a.state)) wakeWorkerFor(attemptId);
  return run(async (tx) => {
    const now = await readAttempt(tx, attemptId);
    const attempt = await viewOf(tx, now);
    if (now.state === "settled" && now.order_id)
      return { attempt, order: await getOrder(tx, now.order_id) };
    return { attempt };
  });
}
export function syncAttemptCore(
  sql: postgres.Sql,
  tenantId: string,
  attemptId: string,
) {
  return syncAttemptWith((fn) => tenant(sql, tenantId, fn), attemptId);
}

// ---------------------------------------------------------------------------------------------
// Cancel

const cancelInput = z.object({ operationId: id }).strict();

/**
 * POST …/cancel (operators). created → cancelled at once (nothing was sent: the push handler
 * re-checks the state under the attempt lock before calling the provider). In flight: records the
 * request and queues payments_cancel (the worker re-reads first, so a just-approved charge stays
 * approved). Approved or later: payments_not_cancellable. Final: the view, unchanged.
 */
export async function requestCancel(
  tx: Tx,
  s: Session,
  attemptId: string,
  raw: unknown,
): Promise<AttemptView> {
  permit(s, operators);
  id.parse(attemptId);
  const p = cancelInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "payments.cancel",
    { attemptId },
    async () => {
      const a = await lockAttempt(tx, attemptId);
      if (
        a.state === "approved" ||
        a.state === "settled" ||
        a.state === "review"
      )
        throw new DomainError("payments_not_cancellable", 409);
      if (!isLiveForTerminal(a.state)) return viewOf(tx, a);
      if (a.state === "created") {
        const [done] = await tx<AttemptRow[]>`update payment_attempts
          set state='cancelled',cancel_requested_at=now(),cancel_requested_by=${s.employeeId},
            version=version+1
          where id=${attemptId} returning *`;
        await event(tx, s, attemptId, "cancelled", s.employeeId, {
          before: "created",
        });
        await audit(
          tx,
          s,
          "payment.terminal_cancelled",
          a.order_id ?? attemptId,
          {
            attemptId,
          },
        );
        return viewOf(tx, done);
      }
      const [row] = await tx<AttemptRow[]>`update payment_attempts
        set cancel_requested_at=coalesce(cancel_requested_at,now()),
          cancel_requested_by=coalesce(cancel_requested_by,${s.employeeId}),version=version+1
        where id=${attemptId} returning *`;
      await event(tx, s, attemptId, "cancel_requested", s.employeeId);
      await enqueueJob(tx, s, {
        kind: "payments_cancel",
        dedupeKey: `${attemptId}:cancel:${p.operationId}`,
        payload: { attemptId },
      });
      await audit(
        tx,
        s,
        "payment.terminal_cancel_requested",
        a.order_id ?? attemptId,
        { attemptId },
      );
      return viewOf(tx, row);
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Settle (exactly once) and the settler registry

export type SettleVia = "job" | "sync" | "retry" | "manager";
export type SettleOutcome =
  { state: "settled"; order: Order } | { state: "review"; errorCode: string };
export type ManagerRecord = {
  employeeId: string;
  note: string;
  reference: string | null;
};

/**
 * A target's settler (critic R10). `actor` builds the attribution session; `settle` records the
 * money (it may throw a DomainError, rolling back); `refused` runs in a second transaction after
 * such a throw and moves the attempt to review with the code. The order target is built in.
 */
export type AttemptSettler = {
  actor(tx: Tx, attempt: AttemptRow): Promise<Session>;
  settle(
    tx: Tx,
    s: Session,
    attempt: AttemptRow,
    via: SettleVia,
    manager?: ManagerRecord,
  ): Promise<SettleOutcome>;
  refused(tx: Tx, attempt: AttemptRow, code: string): Promise<void>;
};
const settlers = new Map<string, AttemptSettler>();
export function registerAttemptSettler(
  target: "kiosk_hold",
  settler: AttemptSettler,
): void {
  if (settlers.has(target))
    throw Error(`attempt settler already registered: ${target}`);
  settlers.set(target, settler);
}

/**
 * The attribution session of a settle that no staff request carries (the payments_settle job, a
 * kiosk sync): the attempt's employee and device, the employee's role and the restaurant row. It
 * authorizes nothing (the start did); once(), audit and refreshCheckState read it.
 */
export async function jobSession(tx: Tx, a: AttemptRow): Promise<Session> {
  const [e] =
    await tx`select name,role from employees where id=${a.employee_id}`;
  const [r] =
    await tx`select name,currency,timezone,cutoff from restaurants where id=${a.tenant_id}`;
  if (!e || !r) throw new DomainError("not_found", 404);
  return {
    id: a.session_id ?? `job:${a.id}`,
    tenantId: a.tenant_id,
    employeeId: a.employee_id,
    name: e.name as string,
    role: e.role as string,
    deviceId: a.device_id,
    expiresAt: "",
    offlineUntil: "",
    csrf: "",
    restaurant: {
      name: r.name as string,
      currency: r.currency as string,
      timezone: r.timezone as string,
      cutoff: r.cutoff as number,
    },
  };
}

const settleFingerprint = (attemptId: string) =>
  createHash("sha256").update(JSON.stringify({ attemptId })).digest("hex");

/**
 * Exactly once under the attempt's settle_operation_id (spec §4.3 settleAttempt, critic R10
 * applyApprovedAttempt is its tail). LO-1 is the settle key itself, so the job, the sync route, the
 * operator retry and the manager record serialize on it and the first one to commit wins; the
 * operations row is written only when the tender is, so a review outcome can be retried later.
 * `operations.kind = 'payment'` keeps payment recovery and reports consistent.
 */
export async function settleAttempt(
  tx: Tx,
  s: Session,
  attemptId: string,
  via: SettleVia,
  manager?: ManagerRecord,
): Promise<SettleOutcome> {
  const [head] =
    await tx`select settle_operation_id from payment_attempts where id=${attemptId}`;
  if (!head) throw new DomainError("payments_attempt_not_found", 404);
  const key = head.settle_operation_id as string;
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + key},0))`;
  const [prior] =
    await tx`select kind,hash,result from operations where id=${key}`;
  if (prior) {
    if (prior.kind !== "payment" || prior.hash !== settleFingerprint(attemptId))
      throw new DomainError("operation_conflict", 409);
    return { state: "settled", order: prior.result as Order };
  }
  const [restaurant] =
    await tx`select currency,timezone,cutoff from restaurants where id=${s.tenantId} for share`;
  if (
    !restaurant ||
    restaurant.currency !== s.restaurant.currency ||
    restaurant.timezone !== s.restaurant.timezone ||
    restaurant.cutoff !== s.restaurant.cutoff
  )
    throw new DomainError("settings_changed", 409);
  await lockAttempt(tx, attemptId);
  const order = await applyApprovedAttempt(
    tx,
    s,
    { id: attemptId },
    via,
    manager,
  );
  if (order.state === "settled")
    await tx`insert into operations(tenant_id,id,kind,hash,result)
      values(${s.tenantId},${key},'payment',${settleFingerprint(attemptId)},${tx.json(order.order as never)})`;
  return order;
}

/**
 * The tail of the order-target settle (critic R10): checks, the tender into the attempt's own
 * drawer (by id, open or closed: a late tender), allocations, settled, the event and audit, the
 * check refresh (fiscal ticket at zero balance) and the receipt job. A check that fails moves the
 * attempt to review and returns (no throw: the review persists). The caller holds LO-1/LO-2 and
 * the attempt row (2c).
 */
export async function applyApprovedAttempt(
  tx: Tx,
  s: Session,
  attempt: Pick<AttemptRow, "id">,
  via: SettleVia,
  manager?: ManagerRecord,
): Promise<SettleOutcome> {
  // LO-2c: the caller already holds the row (a free re-lock); read it fresh under the lock.
  const a = await lockAttempt(tx, attempt.id);
  if (a.state === "settled" && a.order_id)
    return { state: "settled", order: await getOrder(tx, a.order_id) };
  const allowed: AttemptState[] = manager
    ? ["unknown", "review"]
    : via === "retry"
      ? ["review", "approved"]
      : ["approved"];
  if (!allowed.includes(a.state) || a.target !== "order" || !a.order_id)
    throw new DomainError("payments_not_approved", 409);
  const orderId = a.order_id;
  const [row] =
    await tx`select id,state,check_state from orders where id=${orderId} for update`;
  if (!row) throw new DomainError("not_found", 404);
  const charged = manager ? a.amount + a.tip : (a.paid_amount ?? 0);
  let failure: string | null = null;
  if (!manager && a.error_code && FLAGGED.has(a.error_code))
    failure = a.error_code;
  else if (
    row.check_state === "closed" ||
    row.state === "cancelled" ||
    String(row.state).startsWith("recovery")
  )
    failure = "payments_settle_order_changed";
  const o = failure ? null : await getOrder(tx, orderId);
  if (!failure && o && a.amount > o.total - o.paid)
    failure = "payments_settle_order_changed";
  if (!failure && !manager && charged < a.amount + a.tip)
    failure = "payments_paid_short";
  let allocations: ReturnType<typeof allocatePayment> = [];
  if (!failure && o) {
    try {
      if (a.items && !o.itemSplitAvailable)
        failure = "payments_allocation_changed";
      else if (o.itemSplitAvailable)
        allocations = allocatePayment(
          o.paymentUnits!,
          a.amount,
          a.items ?? undefined,
        );
    } catch {
      failure = "payments_allocation_changed";
    }
  }
  if (failure) {
    if (manager || a.state === "review") {
      // A manager record or a retry from review that still does not fit refuses; the attempt
      // keeps its state (nothing to persist).
      throw new DomainError(
        failure === "payments_provider_mismatch" ||
          failure === "payments_refunded_before_settle"
          ? failure
          : "payments_settle_order_changed",
        409,
      );
    }
    await tx`update payment_attempts set state='review',error_code=${failure},version=version+1
      where id=${a.id}`;
    await event(tx, s, a.id, "review", null, { code: failure, via });
    await audit(tx, s, "payment.terminal_review", orderId, {
      attemptId: a.id,
      code: failure,
      via,
    });
    return { state: "review", errorCode: failure };
  }
  // The attempt's own drawer (LO-11), open or closed: money taken on it belongs to it.
  const [d] =
    await tx`select id from cash_sessions where id=${a.cash_session_id} for update`;
  if (!d) throw new DomainError("not_found", 404);
  const terminal = await tenderTerminal(tx, a.terminal_id);
  const reference = manager?.reference ?? a.provider_reference;
  if (!reference) throw new DomainError("payments_reference_required", 409);
  const tip = charged - a.amount;
  const tenderId = await insertTender(tx, s, {
    orderId,
    drawerId: d.id as string,
    method: "external",
    amount: a.amount,
    tip,
    received: charged,
    reference: (a.provider_payment_id ?? reference).slice(0, 100),
    terminal: terminal ? { ...terminal, name: a.terminal_label } : null,
    integrated: {
      attemptId: a.id,
      provider: a.provider,
      providerReference: reference,
      cardType: manager ? null : a.card_type,
      cardBrand: manager ? null : a.card_brand,
      cardLast4: manager ? null : a.card_last4,
      fee: manager ? null : a.fee,
      feeSource: manager ? null : a.fee_source,
    },
  });
  for (const allocation of allocations)
    await tx`insert into tender_allocations(tenant_id,order_id,tender_id,line_id,unit_index,amount)
      values(${s.tenantId},${orderId},${tenderId},${allocation.lineId},${allocation.unit},${allocation.amount})`;
  if (manager)
    await tx`update payment_attempts set state='settled',tender_id=${tenderId},settled_at=now(),
        provider_reference=coalesce(provider_reference,${reference}),resolution='recorded',
        resolution_note=${manager.note},resolved_by=${manager.employeeId},resolved_at=now(),
        version=version+1
      where id=${a.id}`;
  else
    await tx`update payment_attempts set state='settled',tender_id=${tenderId},settled_at=now(),
        version=version+1
      where id=${a.id}`;
  await event(tx, s, a.id, "settled", manager?.employeeId ?? null, {
    tenderId,
    via,
  });
  await audit(tx, s, "payment.recorded", orderId, {
    method: "external",
    amount: a.amount,
    tip,
    provider: a.provider,
    terminalId: a.terminal_id,
    attemptId: a.id,
    via,
  });
  await refreshCheckState(tx, s, orderId);
  const receipt = await getOrder(tx, orderId);
  await tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,error_code)
    values(${s.tenantId},${randomUUID()},'receipt',${a.settle_operation_id},${tx.json({ orderId, receipt })},
      'blocked','printer_not_paired')
    on conflict (tenant_id,kind,dedupe_key) do nothing`;
  return { state: "settled", order: receipt };
}

/**
 * Settles an approved attempt in its own transaction(s) (critic R10 settleAttemptEntry): the order
 * target settles (or moves to review) in one transaction; another target's settler may throw a
 * DomainError, rolled back, and then a second transaction runs its `refused` (review with the
 * code). Called by the payments_settle job, the sync paths and the operator retry. Never gated by
 * PUBLIC_ORDERING_ENABLED or KIOSK_SELF_CHECKOUT_ENABLED (kiosk §2.14).
 */
export async function settleAttemptWith(
  run: TenantRunner,
  attemptId: string,
  via: SettleVia,
): Promise<SettleOutcome | { state: AttemptState }> {
  const head = await run((tx) => readAttempt(tx, attemptId));
  if (head.target === "order")
    return run(async (tx) => {
      const a = await readAttempt(tx, attemptId);
      if (a.state === "settled" && a.order_id)
        return {
          state: "settled" as const,
          order: await getOrder(tx, a.order_id),
        };
      if (a.state !== "approved" && !(via === "retry" && a.state === "review"))
        return { state: a.state };
      return settleAttempt(tx, await jobSession(tx, a), attemptId, via);
    });
  const settler = settlers.get(head.target);
  if (!settler) return { state: head.state };
  try {
    return await run(async (tx) => {
      const a = await readAttempt(tx, attemptId);
      if (a.state !== "approved" && !(via === "retry" && a.state === "review"))
        return { state: a.state };
      return settler.settle(tx, await settler.actor(tx, a), a, via);
    });
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    await run(async (tx) => {
      const a = await readAttempt(tx, attemptId);
      if (a.state === "approved") await settler.refused(tx, a, e.code);
    });
    return { state: "review", errorCode: e.code };
  }
}
export function settleAttemptEntry(
  sql: postgres.Sql,
  tenantId: string,
  attemptId: string,
  via: SettleVia,
) {
  return settleAttemptWith((fn) => tenant(sql, tenantId, fn), attemptId, via);
}

// ---------------------------------------------------------------------------------------------
// Resolve (spec §4.3 resolveAttempt; critic R13 retry)

/**
 * POST …/resolve.
 * - check (operators): queue a provider re-read now (a one-shot payments_webhook) and wake.
 * - retry (operators, no step-up; R13): from review with provider data, when the checks pass now.
 * - record (managers, step-up): from unknown or review; from unknown without a provider reference
 *   the typed reference is required. The tender takes the estimate as its fee.
 * - not_charged (managers, step-up): unknown → dismissed; refused if the provider last said paid,
 *   or while it may still take the charge (providerMayStillCharge).
 * - refunded_at_provider (managers, step-up): review → dismissed; the note names the refund.
 * Record and retry run the settle sequence under the settle key (no second operation key).
 */
export async function resolveAttempt(
  tx: Tx,
  s: Session,
  attemptId: string,
  raw: unknown,
): Promise<{ attempt: AttemptView; order?: Order }> {
  permit(s, operators);
  id.parse(attemptId);
  const p = resolveAttemptInput.parse(raw);
  if (p.outcome !== "check" && p.outcome !== "retry") {
    permit(s, managers);
    requireRecentAuth(s);
    if (!p.note) throw new DomainError("payments_note_required");
    if (!p.confirmed) throw new DomainError("invalid_input");
  }
  if (p.outcome === "retry" || p.outcome === "record") {
    const a = await readAttempt(tx, attemptId);
    if (p.outcome === "retry") {
      if (
        a.state !== "review" ||
        a.paid_amount === null ||
        (a.error_code !== null && FLAGGED.has(a.error_code))
      )
        throw new DomainError("payments_not_approved", 409);
    } else {
      if (a.state !== "unknown" && a.state !== "review")
        throw new DomainError("payments_not_approved", 409);
      if (!a.provider_reference && !p.reference)
        throw new DomainError("payments_reference_required");
      // A typed reference already on another charge is refused, never a 500 (unique index
      // payment_attempts_reference).
      if (!a.provider_reference && p.reference) {
        const [taken] = await tx`select id from payment_attempts
          where provider=${a.provider} and lower(provider_reference)=lower(${p.reference})
            and id<>${a.id} limit 1`;
        if (taken) throw new DomainError("payments_reference_taken", 409);
      }
    }
    const result = await settleAttempt(
      tx,
      s,
      attemptId,
      p.outcome === "record" ? "manager" : "retry",
      p.outcome === "record"
        ? {
            employeeId: s.employeeId,
            note: p.note!,
            reference: a.provider_reference ? null : (p.reference ?? null),
          }
        : undefined,
    ).catch((e: unknown) => {
      // The same reference recorded concurrently on another charge.
      if (
        (e as { code?: string; constraint_name?: string }).code === "23505" &&
        (e as { constraint_name?: string }).constraint_name ===
          "payment_attempts_reference"
      )
        throw new DomainError("payments_reference_taken", 409);
      throw e;
    });
    if (result.state === "review")
      throw new DomainError("payments_settle_order_changed", 409);
    if (p.outcome === "record")
      await audit(tx, s, "payment.terminal_resolved", a.order_id ?? attemptId, {
        attemptId,
        outcome: "recorded",
        note: p.note,
      });
    const now = await readAttempt(tx, attemptId);
    return { attempt: await viewOf(tx, now), order: result.order };
  }
  return once(
    tx,
    s,
    p.operationId,
    "payments.resolve",
    { attemptId, ...p },
    async () => {
      const a = await lockAttempt(tx, attemptId);
      if (p.outcome === "check") {
        if (isLiveForTerminal(a.state) || a.state === "review") {
          await enqueueJob(tx, s, {
            kind: "payments_webhook",
            dedupeKey: `check:${attemptId}:${p.operationId}`,
            payload: { attemptId, source: "check" },
          });
          await event(tx, s, attemptId, "check_requested", s.employeeId);
        }
        return { attempt: await viewOf(tx, a) };
      }
      if (a.order_id)
        await tx`select id from orders where id=${a.order_id} for update`;
      if (p.outcome === "not_charged") {
        if (a.state !== "unknown")
          throw new DomainError("payments_not_approved", 409);
        if (
          a.paid_amount !== null ||
          a.provider_status?.startsWith("processed")
        )
          throw new DomainError("payments_provider_says_paid", 409);
        if (providerMayStillCharge(a))
          throw new DomainError("payments_provider_may_charge", 409);
      } else if (a.state !== "review")
        throw new DomainError("payments_not_approved", 409);
      const resolution =
        p.outcome === "not_charged" ? "not_charged" : "refunded_at_provider";
      const [row] = await tx<AttemptRow[]>`update payment_attempts
        set state='dismissed',resolution=${resolution},resolution_note=${p.note!},
          resolved_by=${s.employeeId},resolved_at=now(),version=version+1
        where id=${attemptId} returning *`;
      await event(tx, s, attemptId, "resolved", s.employeeId, {
        outcome: resolution,
      });
      await audit(tx, s, "payment.terminal_resolved", a.order_id ?? attemptId, {
        attemptId,
        outcome: resolution,
        note: p.note,
      });
      return { attempt: await viewOf(tx, row) };
    },
  );
}

/** After commit: a started, cancelled or checked attempt reaches the worker without the sweep. */
export function afterAttemptWrite(): void {
  wakeWorker();
}
export { isLiveForOrder };
