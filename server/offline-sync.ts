import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import {
  DomainError,
  businessDate,
  currencyExponent,
  id,
  orderInput,
  quote,
  sum,
  type LineInput,
  type Order,
  type Session,
} from "../shared/domain.js";
import {
  evaluateRecordedAt,
  evidenceKey,
  formatVersionOf,
  offlineRecord,
  offlineSale,
  recordAmounts,
  recordKind,
  type OfflinePayment,
  type OfflineRecord,
  type OfflineRecordKind,
  type OfflineRecordV3,
} from "../shared/offline-recovery.js";
import { hash, permit, managers, operators } from "./auth.js";
import {
  audit,
  catalog,
  createOrder,
  getOrder,
  once,
  recordPayment,
} from "./orders.js";
import {
  leaseForEvidence,
  type LeaseWindow,
  type OfflineLeaseRow,
} from "./compat/offline-access.js";
import { refreshCheckState } from "./compat/offline-service.js";
import { placeRoundsInOfflineReview } from "./offline-kitchen.js";

/** Legacy v1/v2 cash-sale input (unchanged). */
export const offlineInput = offlineSale;

export type OfflineSyncResult = {
  kind: OfflineRecordKind;
  operationId: string;
  orderId: string;
  orderNumber: number;
  provisionalNumber: string | null;
  roundNumber: number | null;
  tenderId: string | null;
  soldAt: string;
  businessDate: string;
  reusedOnlineOrder: boolean;
  kitchenReview: boolean;
  order: Order;
};

/** Eligibility codes in evaluation order (offline spec §4.4 E1-E9, contract D6). */
export type EligibilityProblem =
  | "offline_archived"
  | "offline_conflict"
  | "offline_recorded_in_future"
  | "offline_outside_lease"
  | "offline_drawer_conflict"
  | "settings_changed";

export type EvidenceContext = {
  session: Record<string, any>;
  lease: OfflineLeaseRow & { windows: LeaseWindow[] };
  cash: Record<string, any> | null;
  soldAt: Date;
  businessDate: string;
};

export const CLOSED_STATES = [
  "cancelled",
  "recovery_pending",
  "recovery_reviewed",
];
export const isV3 = (p: OfflineRecord): p is OfflineRecordV3 => "kind" in p;

/** Payment carried by a record; v1/v2 are cash sales. */
export function paymentOf(p: OfflineRecord): OfflinePayment | null {
  if (!isV3(p))
    return {
      method: "cash",
      amount: p.expectedTotal,
      tip: p.tip,
      received: p.received,
      reference: "",
      externalConfirmed: false,
    };
  return "payment" in p ? p.payment : null;
}

const drawerOf = (p: OfflineRecord): string | null =>
  "cashSessionId" in p ? (p.cashSessionId ?? null) : null;

/**
 * Authenticity (is the evidence what it claims: session, lease, drawer,
 * currency, amounts) is separate from eligibility (may it auto-sync now). This
 * never throws for evidence problems, so a manager can always review, and can
 * reconcile any authentic evidence (OFF-8).
 */
export async function evaluateEvidence(
  tx: Tx,
  s: Session,
  p: OfflineRecord,
  perspective: "sync" | "review" = "sync",
): Promise<
  | { authentic: true; ctx: EvidenceContext; problems: EligibilityProblem[] }
  | { authentic: false; reason: string; session: Record<string, any> | null }
> {
  const [session] = await tx`select * from sessions where id=${p.sessionId}`;
  if (!session) return { authentic: false, reason: "session", session: null };
  if (
    "tenantId" in p &&
    (p.tenantId !== s.tenantId ||
      p.employeeId !== session.employee_id ||
      p.deviceId !== session.device_id)
  )
    return { authentic: false, reason: "identity", session };
  const lease = await leaseForEvidence(tx, p.sessionId);
  if (
    !lease ||
    lease.employee_id !== session.employee_id ||
    lease.device_id !== session.device_id ||
    (isV3(p) && lease.contract_version !== p.lease.contractVersion) ||
    ("leaseVersion" in p && p.leaseVersion !== lease.contract_version)
  )
    return { authentic: false, reason: "lease", session };
  if (
    "currency" in p &&
    (p.currency !== lease.restaurant_snapshot.currency ||
      p.currencyExponent !== currencyExponent(p.currency))
  )
    return { authentic: false, reason: "currency", session };
  const payment = paymentOf(p);
  const drawerId = drawerOf(p);
  let cash: Record<string, any> | null = null;
  if (payment) {
    [cash] = await tx`select * from cash_sessions where id=${drawerId}`;
    if (!cash || cash.device_id !== session.device_id)
      return { authentic: false, reason: "drawer", session };
    if (
      payment.method === "cash"
        ? payment.received < payment.amount + payment.tip
        : payment.received !== payment.amount + payment.tip ||
          !payment.externalConfirmed ||
          !payment.reference.trim()
    )
      return { authentic: false, reason: "amounts", session };
  }
  const [clock] = await tx`select clock_timestamp() as now`;
  const time = evaluateRecordedAt({
    recordedAt: p.recordedAt,
    serverNow: clock.now,
    windows: lease.windows.map((w) => ({
      issuedAt: w.issued_at,
      validUntil: w.valid_until,
    })),
    drawer: cash ? { openedAt: cash.opened_at, closedAt: cash.closed_at } : null,
  });
  const snapshot = lease.restaurant_snapshot;
  const day = businessDate(
    time.soldAt.toISOString(),
    snapshot.timezone,
    snapshot.cutoff,
  );
  const problems: EligibilityProblem[] = [];
  const [archived] =
    await tx`select 1 from offline_archives where operation_id=${p.operationId}`;
  if (archived) problems.push("offline_archived"); // E1
  // E2: only the same employee on the same device syncs automatically. An
  // ended session (logout, switch) is still valid evidence for them. A
  // manager's review is about the original device, so it skips this check.
  if (
    perspective === "sync" &&
    (session.employee_id !== s.employeeId || session.device_id !== s.deviceId)
  )
    problems.push("offline_conflict");
  if (session.revoked) problems.push("offline_conflict"); // E3 (contract D6)
  const [identity] =
    await tx`select e.active as employee_active,d.active as device_active
      from employees e cross join devices d where e.id=${session.employee_id} and d.id=${session.device_id}`;
  if (!identity?.employee_active || !identity?.device_active)
    problems.push("offline_conflict"); // E4
  if (!lease.selling_authorized) problems.push("offline_conflict"); // E5
  if (time.verdict === "future") problems.push("offline_recorded_in_future"); // E6
  if (time.verdict === "too_early" || time.verdict === "too_late")
    problems.push("offline_outside_lease"); // E7
  if (payment) {
    // E8 (invariant I4): money auto-applies only to the device's open drawer.
    const device = perspective === "sync" ? s.deviceId : session.device_id;
    const [open] =
      await tx`select id from cash_sessions where device_id=${device} and closed_at is null`;
    if (open?.id !== drawerId) problems.push("offline_drawer_conflict");
  }
  if (recordKind(p) !== "payment") {
    // E9: the record was priced under the lease's configuration.
    const [restaurant] =
      await tx`select config_version from restaurants where id=${s.tenantId} for share`;
    const cited = isV3(p)
      ? p.lease.configurationVersion
      : "configurationVersion" in p
        ? p.configurationVersion
        : undefined;
    // A v3 record made with a session cached before this field existed cites
    // null; the live check below still applies to it.
    const citedMismatch =
      cited !== undefined &&
      !(isV3(p) && cited === null) &&
      cited !== lease.configuration_version;
    if (
      citedMismatch ||
      restaurant?.config_version !== lease.configuration_version
    )
      problems.push("settings_changed");
  }
  return {
    authentic: true,
    problems: [...new Set(problems)],
    ctx: { session, lease, cash, soldAt: time.soldAt, businessDate: day },
  };
}

/**
 * Re-prices claimed lines with today's catalog (the server is authoritative,
 * invariant I3) and checks each product revision against the receipt snapshot.
 */
export async function verifyLines(
  tx: Tx,
  lines: LineInput[],
  snapshots: unknown[] | undefined,
  expectedTotal: number,
) {
  const productIds = [...new Set(lines.map((line) => line.productId))].sort();
  // Hold the catalog revisions until commit so a concurrent edit cannot change
  // the recipe between verification and stock consumption.
  const versions =
    await tx`select id,data from catalog where id=any(${tx.array(productIds)}::uuid[]) order by id for share`;
  // Staff path: open-price lines are valid evidence (contract D11).
  const priced = quote(lines, await catalog(tx), true);
  if (sum(priced.map((line) => line.total)) !== expectedTotal)
    throw new DomainError("price_conflict", 409);
  for (const line of lines) {
    const current = versions.find((product) => product.id === line.productId);
    const snapshot = snapshots?.find(
      (
        value,
      ): value is { id: string; productId: string; productVersion: number } =>
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        value.id === line.id &&
        "productId" in value &&
        value.productId === line.productId &&
        "productVersion" in value &&
        Number.isInteger(value.productVersion),
    );
    // Legacy evidence has no catalog revision. A never-edited product is safe;
    // an edited product requires review rather than invented historical stock.
    if (
      current &&
      (snapshot
        ? snapshot.productVersion !== current.data.version
        : current.data.version !== 1)
    )
      throw new DomainError("offline_catalog_changed", 409);
  }
  return priced;
}

export const snapshotLines = (p: OfflineRecord) =>
  "receiptSnapshot" in p ? p.receiptSnapshot?.lines : undefined;

export type OrderRecord = OfflineRecord & {
  order: z.infer<typeof orderInput>;
  expectedTotal: number;
};

/**
 * The order a sale opens. An online create that committed but whose response
 * was lost is reused (the kitchen already saw it) instead of duplicated.
 */
export async function resolveOrCreateOrder(
  tx: Tx,
  s: Session,
  p: OrderRecord,
  ctx: EvidenceContext,
): Promise<{ orderId: string; reused: boolean }> {
  const [prior] =
    await tx`select kind,hash,result from operations where id=${p.order.operationId}`;
  if (prior) {
    const online = hash(
      JSON.stringify(orderInput.parse({ ...p.order, channel: "pos" })),
    );
    if (prior.kind === "create_order" && prior.hash === online)
      return { orderId: prior.result.id, reused: true };
    throw new DomainError("offline_order_already_exists", 409);
  }
  await verifyLines(tx, p.order.lines, snapshotLines(p), p.expectedTotal);
  // Business date from the validated sale time, never the sync time (I12).
  const order = await createOrder(
    tx,
    s,
    { ...p.order, channel: "offline" },
    { businessDate: ctx.businessDate },
  );
  return { orderId: order.id, reused: false };
}

/** Records a tender through the normal payment command; returns its id. */
export async function newTender(
  tx: Tx,
  s: Session,
  orderId: string,
  payment: OfflinePayment,
  drawerId: string,
): Promise<string> {
  const before = new Set(
    (await tx`select id from tenders where order_id=${orderId}`).map(
      (row) => row.id as string,
    ),
  );
  let receipt: Order;
  try {
    receipt = await recordPayment(
      tx,
      s,
      orderId,
      {
        operationId: randomUUID(),
        method: payment.method,
        amount: payment.amount,
        tip: payment.tip,
        received: payment.received,
        externalConfirmed: payment.externalConfirmed,
        reference: payment.reference,
      },
      null,
      drawerId,
    );
  } catch (e) {
    // Never charge past the balance (I2): the record goes to manager review.
    if (e instanceof DomainError && e.code === "overpayment")
      throw new DomainError("offline_payment_exceeds_due", 409);
    if (
      e instanceof DomainError &&
      (e.code === "check_closed" || e.code === "stale_order")
    )
      throw new DomainError("offline_order_closed", 409);
    throw e;
  }
  const tender = receipt.tenders.find((t: { id: string }) => !before.has(t.id));
  if (!tender) throw Error("offline tender not recorded");
  await refreshCheckState(tx, s, orderId);
  return tender.id;
}

/** Appends the immutable ledger row for an applied record. */
export async function ledger(
  tx: Tx,
  s: Session,
  p: OfflineRecord,
  ctx: EvidenceContext,
  row: {
    kind: OfflineRecordKind;
    orderId: string;
    roundNumber: number | null;
    tenderId: string | null;
    reused?: boolean;
    path?: "automatic" | "manager";
    reason?: string | null;
  },
) {
  const v3 = isV3(p) ? p : null;
  const { amount, tip } = recordAmounts(p);
  const delivery =
    row.kind === "payment"
      ? "not_applicable"
      : (v3?.kitchenDelivery ?? "device_list");
  await tx`insert into offline_sync_records(
      tenant_id,operation_id,kind,format_version,path,device_id,employee_id,session_id,
      order_id,round_number,tender_id,provisional_number,reused_online_order,recorded_at,
      recorded_at_device,clock_offset_ms,sold_at,business_date,kitchen_delivery,amount,tip,
      reason,actor_id
    ) values(
      ${s.tenantId},${p.operationId},${row.kind},${formatVersionOf(p)},${row.path ?? "automatic"},
      ${ctx.session.device_id},${ctx.session.employee_id},${p.sessionId},${row.orderId},
      ${row.roundNumber},${row.tenderId},${v3?.provisionalNumber ?? null},${row.reused ?? false},
      ${p.recordedAt},${v3?.recordedAtDevice ?? null},${v3?.clockOffsetMs ?? null},
      ${ctx.soldAt},${ctx.businessDate},${delivery},${amount},${tip},${row.reason ?? null},
      ${s.employeeId}
    )`;
}

/** What an applier returns; the caller adds the order and the timing facts. */
export type Applied = {
  kind: OfflineRecordKind;
  orderId: string;
  roundNumber: number | null;
  tenderId: string | null;
  reusedOnlineOrder: boolean;
  kitchenReview: boolean;
};
export type Applier = (
  tx: Tx,
  s: Session,
  p: OfflineRecord,
  ctx: EvidenceContext,
) => Promise<Applied>;

/** New order paid in full (v1/v2 cash, v3 cash or external terminal). */
const applySale: Applier = async (tx, s, p, ctx) => {
  const record = p as OrderRecord & { cashSessionId: string };
  const { orderId, reused } = await resolveOrCreateOrder(tx, s, record, ctx);
  const tenderId = await newTender(
    tx,
    s,
    orderId,
    paymentOf(p)!,
    record.cashSessionId,
  );
  await ledger(tx, s, p, ctx, {
    kind: "sale",
    orderId,
    roundNumber: 1,
    tenderId,
    reused,
  });
  // OFF-4: synced rounds wait for a kitchen decision (I7). An order committed
  // online before the outage was already seen by the kitchen.
  const kitchenReview = reused
    ? false
    : (await placeRoundsInOfflineReview(tx, s, {
        orderId,
        roundNumber: 1,
        operationId: p.operationId,
      })) > 0;
  return {
    kind: "sale",
    orderId,
    roundNumber: 1,
    tenderId,
    reusedOnlineOrder: reused,
    kitchenReview,
  };
};

/** Per-kind appliers; the offline-tables series registers more kinds. */
export const appliers: Partial<Record<OfflineRecordKind, Applier>> = {
  sale: applySale,
};

async function applyRecord(
  tx: Tx,
  s: Session,
  p: OfflineRecord,
  ctx: EvidenceContext,
): Promise<OfflineSyncResult> {
  const kind = recordKind(p);
  const apply = appliers[kind];
  if (!apply) throw new DomainError("invalid_input", 400);
  const applied = await apply(tx, s, p, ctx);
  await audit(tx, s, "offline.synced", applied.orderId, {
    kind,
    operationId: p.operationId,
    provisionalNumber: isV3(p) ? p.provisionalNumber : null,
    soldAt: ctx.soldAt.toISOString(),
    clockOffsetMs: isV3(p) ? p.clockOffsetMs : null,
  });
  const order = await getOrder(tx, applied.orderId);
  return {
    ...applied,
    operationId: p.operationId,
    orderNumber: order.number,
    provisionalNumber: isV3(p) ? p.provisionalNumber : null,
    soldAt: ctx.soldAt.toISOString(),
    businessDate: ctx.businessDate,
    order,
  };
}

/** Results stored before v3 are plain Orders (legacy /sync and reconcile). */
export function normalizeSyncResult(
  r: any,
  operationId: string,
  restaurant: Session["restaurant"],
): OfflineSyncResult {
  if (r && typeof r === "object" && "order" in r && "kind" in r) return r;
  const order = r as Order;
  const soldAt = order.recovery?.original.recordedAt ?? order.createdAt;
  const snapshot = order.restaurantSnapshot ?? restaurant;
  return {
    kind: "sale",
    operationId,
    orderId: order.id,
    orderNumber: order.number,
    provisionalNumber: null,
    roundNumber: order.recovery ? null : 1,
    tenderId: order.tenders?.at(-1)?.id ?? null,
    soldAt,
    businessDate: businessDate(soldAt, snapshot.timezone, snapshot.cutoff),
    reusedOnlineOrder: false,
    kitchenReview: false,
    order,
  };
}

/**
 * Applies one offline record exactly once (invariant I1): sync, legacy sync and
 * manager reconcile all use once(record.operationId, "offline_sync").
 */
export async function syncOfflineRecord(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<OfflineSyncResult> {
  permit(s, operators);
  const p = offlineRecord.parse(raw);
  const result = await once(
    tx,
    s,
    p.operationId,
    "offline_sync",
    p,
    async () => {
      const evidence = await evaluateEvidence(tx, s, p);
      if (!evidence.authentic)
        throw new DomainError("offline_evidence_invalid", 409);
      if (evidence.problems.length)
        throw new DomainError(evidence.problems[0]!, 409);
      return applyRecord(tx, s, p, evidence.ctx);
    },
  );
  return normalizeSyncResult(result, p.operationId, s.restaurant);
}

/** Codes older clients understand (POST /api/sync). */
export function legacyCode(code: string): string {
  if (
    [
      "offline_evidence_invalid",
      "offline_outside_lease",
      "offline_recorded_in_future",
    ].includes(code)
  )
    return "offline_context_invalid";
  if (code === "offline_catalog_changed" || code === "offline_archived")
    return "offline_conflict";
  return code;
}

async function withLegacyCodes<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DomainError && legacyCode(e.code) !== e.code)
      throw new DomainError(legacyCode(e.code), e.status);
    throw e;
  }
}

/** Legacy POST /api/sync: v1/v2 cash sales; returns the Order. */
export async function synchronizeOffline(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<Order> {
  const p = offlineInput.parse(raw);
  return withLegacyCodes(
    async () => (await syncOfflineRecord(tx, s, p)).order,
  );
}

/** Server order a round/payment targets, for review (offline-tables series). */
export const reviewTargets: {
  resolve?: (
    tx: Tx,
    p: OfflineRecord,
  ) => Promise<{ orderId: string; number: number; due: number } | null>;
} = {};

/** Manager review. Throws only invalid_input or forbidden, never for evidence. */
export async function reviewOfflineRecord(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = offlineRecord.parse(raw);
  if ("tenantId" in p && p.tenantId !== s.tenantId)
    throw new DomainError("forbidden", 403);
  const evidence = await evaluateEvidence(tx, s, p, "review");
  const kind = recordKind(p);
  const [prior] =
    await tx`select kind from operations where id=${p.operationId}`;
  const [archived] =
    await tx`select 1 from offline_archives where operation_id=${p.operationId}`;
  const payment = paymentOf(p);
  const lines =
    "order" in p
      ? p.order.lines
      : ((p as { lines?: LineInput[] }).lines ?? null);
  let currentTotal: number | null = null;
  if (lines)
    try {
      currentTotal = sum(
        quote(lines, await catalog(tx), true).map((line) => line.total),
      );
    } catch {
      /* Unavailable/deleted menu is explicitly unknown. */
    }
  const target = (await reviewTargets.resolve?.(tx, p)) ?? null;
  const session = evidence.authentic ? evidence.ctx.session : evidence.session;
  const [employee] = session
    ? await tx`select name from employees where id=${session.employee_id}`
    : [];
  const drawerId = drawerOf(p);
  const [cash] = drawerId
    ? await tx`select id,closed_at from cash_sessions where id=${drawerId}`
    : [];
  const amount = payment?.amount ?? 0;
  const reconcilable =
    evidence.authentic &&
    !prior &&
    !archived &&
    !!payment &&
    (kind === "sale" || !target || amount <= target.due);
  return {
    authentic: evidence.authentic,
    problems: evidence.authentic ? evidence.problems : [],
    kind,
    formatVersion: formatVersionOf(p),
    collected: amount,
    tip: payment?.tip ?? 0,
    method: payment?.method ?? null,
    reference: payment?.reference || null,
    recordedAt: p.recordedAt,
    recordedAtDevice: isV3(p) ? p.recordedAtDevice : null,
    clockOffsetMs: isV3(p) ? p.clockOffsetMs : null,
    soldAt: evidence.authentic ? evidence.ctx.soldAt.toISOString() : null,
    provisionalNumber: isV3(p) ? p.provisionalNumber : null,
    currentTotal,
    originalEmployee: employee?.name ?? null,
    originalDeviceId: session?.device_id ?? null,
    originalDrawerId: cash?.id ?? drawerId,
    drawerClosed: cash ? !!cash.closed_at : null,
    sessionRevoked: session ? !!session.revoked : null,
    evidenceVersion: evidence.authentic
      ? evidence.ctx.lease.contract_version
      : null,
    prior: prior ? { kind: prior.kind } : null,
    archived: !!archived,
    target,
    reconcilable,
  };
}
export const reviewOffline = reviewOfflineRecord;
export type OfflineReview = Awaited<ReturnType<typeof reviewOfflineRecord>>;

/**
 * Financial-only recovery: records the original money in the original drawer
 * without inventing items, kitchen dispatch or stock (manager path).
 */
export async function financialRecovery(
  tx: Tx,
  s: Session,
  p: OfflineRecord,
  ctx: EvidenceContext,
  reason: string,
): Promise<OfflineSyncResult> {
  const payment = paymentOf(p)!;
  const order = "order" in p ? p.order : null;
  const [cash] =
    await tx`select * from cash_sessions where id=${drawerOf(p)} for update`;
  if (order) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + order.operationId},0))`;
    const [existingOrder] =
      await tx`select id from operations where id=${order.operationId}`;
    if (existingOrder)
      throw new DomainError("offline_order_already_exists", 409);
  }
  const lease = ctx.lease;
  const date = ctx.businessDate;
  const [number] =
    await tx`insert into order_numbers(tenant_id,business_date,value) values(${s.tenantId},${date},1) on conflict(tenant_id,business_date) do update set value=order_numbers.value+1 returning value`;
  const orderId = randomUUID(),
    tenderId = randomUUID(),
    recoveryId = randomUUID();
  // Financial recovery is deliberately not a reconstructed fulfillment order.
  // Keep the claimed source lines in audit; do not invent historical unit prices,
  // repeat kitchen dispatch, or deduct current recipes from stock.
  await tx`insert into orders(tenant_id,id,number,business_date,employee_id,table_id,mode,name,note,channel,total,state,restaurant_snapshot) values(${s.tenantId},${orderId},${number.value},${date},${lease.employee_id},null,${order?.mode ?? "takeaway"},${order?.name ?? ""},${"Offline cash reconciliation: " + reason},'offline',${payment.amount},'recovery_pending',${tx.json(lease.restaurant_snapshot)})`;
  await tx`insert into tenders(tenant_id,id,order_id,session_id,method,amount,tip,received,external_reference,source,source_id,created_at) values(${s.tenantId},${tenderId},${orderId},${cash.id},${payment.method},${payment.amount},${payment.tip},${payment.received},${payment.reference || null},'offline_recovery',${p.operationId},clock_timestamp())`;
  await tx`insert into offline_recoveries(
      tenant_id,id,operation_id,order_operation_id,original_session_id,
      original_employee_id,original_device_id,original_drawer_id,actor_id,
      reason,evidence_version,evidence,order_id,tender_id,original_sold_at,recognized_at
    ) values(
      ${s.tenantId},${recoveryId},${p.operationId},${order?.operationId ?? randomUUID()},
      ${p.sessionId},${lease.employee_id},${lease.device_id},${cash.id},
      ${s.employeeId},${reason},${lease.contract_version},${tx.json(p as any)},
      ${orderId},${tenderId},${ctx.soldAt},clock_timestamp()
    )`;
  for (const kind of ["kitchen", "stock"])
    await tx`insert into offline_recovery_tasks(tenant_id,id,recovery_id,kind) values(${s.tenantId},${randomUUID()},${recoveryId},${kind})`;
  await audit(tx, s, "offline.reconciled", orderId, {
    reason,
    original: p,
    kind: recordKind(p),
    method: payment.method,
    provisionalNumber: isV3(p) ? p.provisionalNumber : null,
    originalEmployeeId: lease.employee_id,
    originalDeviceId: lease.device_id,
    originalDrawerClosed: !!cash.closed_at,
    recoveryId,
    fulfillment: "pending",
    stock: "pending",
  });
  const result = await getOrder(tx, orderId);
  if (order)
    await tx`insert into operations(tenant_id,id,kind,hash,result) values(${s.tenantId},${order.operationId},'create_order',${hash(JSON.stringify({ ...order, channel: "offline" }))},${tx.json(result)})`;
  return {
    kind: recordKind(p),
    operationId: p.operationId,
    orderId,
    orderNumber: result.number,
    provisionalNumber: isV3(p) ? p.provisionalNumber : null,
    roundNumber: null,
    tenderId,
    soldAt: ctx.soldAt.toISOString(),
    businessDate: date,
    reusedOnlineOrder: false,
    kitchenReview: false,
    order: result,
  };
}

export type Reconciler = (
  tx: Tx,
  s: Session,
  p: OfflineRecord,
  ctx: EvidenceContext,
  reason: string,
) => Promise<OfflineSyncResult>;
/** Per-kind manager reconcilers; the offline-tables series registers more kinds. */
export const reconcilers: Partial<Record<OfflineRecordKind, Reconciler>> = {
  sale: financialRecovery,
};

const reconcileInput = z
  .object({
    record: z.unknown(),
    reason: z.string().trim().min(10).max(500),
    confirmed: z.literal(true),
  })
  .strict();

/** Manager reconcile of authentic evidence; same idempotency key as sync. */
export async function reconcileOfflineRecord(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<Order> {
  permit(s, managers);
  const input = reconcileInput.parse(raw);
  const p = offlineRecord.parse(input.record);
  if ("tenantId" in p && p.tenantId !== s.tenantId)
    throw new DomainError("forbidden", 403);
  const result = await once(
    tx,
    s,
    p.operationId,
    "offline_sync",
    p,
    async () => {
      const evidence = await evaluateEvidence(tx, s, p, "review");
      if (!evidence.authentic)
        throw new DomainError("offline_evidence_invalid", 409);
      if (evidence.problems.includes("offline_archived"))
        throw new DomainError("offline_archived", 409);
      const reconcile = reconcilers[recordKind(p)];
      if (!reconcile)
        throw new DomainError("offline_reconcile_unsupported", 409);
      return reconcile(tx, s, p, evidence.ctx, input.reason);
    },
  );
  return normalizeSyncResult(result, p.operationId, s.restaurant).order;
}

/** Legacy POST /api/sync/reconcile body: { sale, reason, confirmed }. */
export async function reconcileOffline(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<Order> {
  permit(s, managers);
  const { sale, reason, confirmed } = z
    .object({
      sale: offlineInput,
      reason: z.string().trim().min(10).max(500),
      confirmed: z.literal(true),
    })
    .strict()
    .parse(raw);
  return withLegacyCodes(() =>
    reconcileOfflineRecord(tx, s, { record: sale, reason, confirmed }),
  );
}

const archiveInput = z
  .object({
    operationId: id,
    record: z.record(z.string(), z.unknown()),
    localError: z.string().max(100).nullable(),
    reason: z.string().trim().min(10).max(500),
    confirmed: z.literal(true),
  })
  .strict();

const uuidOrNull = (value: unknown) =>
  id.safeParse(value).success ? (value as string) : null;
const nonNegative = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;

/** What an archive can state about evidence, even when it does not parse. */
function archiveFacts(record: Record<string, unknown>) {
  const parsed = offlineRecord.safeParse(record);
  if (parsed.success) {
    const p = parsed.data;
    return {
      valid: true,
      kind: recordKind(p) as OfflineRecordKind | null,
      ...recordAmounts(p),
      currency: "currency" in p ? p.currency : null,
      deviceId: "deviceId" in p ? p.deviceId : null,
      employeeId: "employeeId" in p ? p.employeeId : null,
      drawerId: drawerOf(p),
      recordedAt: p.recordedAt,
    };
  }
  const payment = (record.payment ?? {}) as Record<string, unknown>;
  return {
    valid: false,
    kind: ["sale", "order", "round", "payment"].includes(record.kind as string)
      ? (record.kind as OfflineRecordKind)
      : null,
    amount: nonNegative(payment.amount ?? record.expectedTotal),
    tip: nonNegative(payment.tip ?? record.tip),
    currency:
      typeof record.currency === "string" && /^[A-Z]{3}$/.test(record.currency)
        ? record.currency
        : null,
    deviceId: uuidOrNull(record.deviceId),
    employeeId: uuidOrNull(record.employeeId),
    drawerId: uuidOrNull(record.cashSessionId),
    recordedAt:
      typeof record.recordedAt === "string" &&
      !Number.isNaN(Date.parse(record.recordedAt))
        ? new Date(record.recordedAt).toISOString()
        : null,
  };
}

/**
 * Manager archive of a local record that will never be recorded as a sale
 * (OFF-8). Never records money. Serialized with sync on the record's key, so
 * exactly one of archive or sync wins (invariant I1).
 */
export async function archiveOfflineRecord(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<{ id: string; operationId: string; archivedAt: string }> {
  permit(s, managers);
  const p = archiveInput.parse(raw);
  const recordId = id.parse(p.record.operationId);
  if (p.record.tenantId !== undefined && p.record.tenantId !== s.tenantId)
    throw new DomainError("forbidden", 403);
  if (JSON.stringify(p.record).length > 200_000)
    throw new DomainError("invalid_input", 400);
  return once(tx, s, p.operationId, "offline.archive", p, async () => {
    // The key once(recordId) uses: archive and sync of one record serialize.
    await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + recordId},0))`;
    const [synced] = await tx`select 1 from operations where id=${recordId}`;
    if (synced) throw new DomainError("offline_already_synced", 409);
    const evidenceHash = createHash("sha256")
      .update(evidenceKey(p.record))
      .digest("hex");
    const [existing] =
      await tx`select id,evidence_hash,created_at from offline_archives where operation_id=${recordId}`;
    if (existing) {
      if (existing.evidence_hash !== evidenceHash)
        throw new DomainError("operation_conflict", 409);
      return {
        id: existing.id,
        operationId: recordId,
        archivedAt: existing.created_at.toISOString(),
      };
    }
    const facts = archiveFacts(p.record);
    const archiveId = randomUUID();
    const [row] = await tx`insert into offline_archives(
        tenant_id,id,operation_id,command_id,evidence,evidence_hash,evidence_valid,kind,
        amount,tip,currency,claimed_device_id,claimed_employee_id,claimed_drawer_id,
        recorded_at,local_error,reason,actor_id
      ) values(
        ${s.tenantId},${archiveId},${recordId},${p.operationId},${tx.json(p.record as any)},
        ${evidenceHash},${facts.valid},${facts.kind},${facts.amount},${facts.tip},
        ${facts.currency},${facts.deviceId},${facts.employeeId},${facts.drawerId},
        ${facts.recordedAt},${p.localError},${p.reason},${s.employeeId}
      ) returning created_at`;
    await audit(tx, s, "offline.archived", recordId, {
      reason: p.reason,
      kind: facts.kind,
      amount: facts.amount,
      tip: facts.tip,
      localError: p.localError,
    });
    return {
      id: archiveId,
      operationId: recordId,
      archivedAt: row.created_at.toISOString(),
    };
  });
}

const pageInput = z
  .object({
    cursor: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[0-9a-f-]{36}$/i)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

/** Keyset cursor "<microsecond ISO instant>_<uuid>". */
function cursorOf(raw: unknown) {
  const p = pageInput.parse(raw);
  if (!p.cursor) return { at: null, id: null, limit: p.limit };
  const split = p.cursor.lastIndexOf("_");
  return {
    at: p.cursor.slice(0, split),
    id: id.parse(p.cursor.slice(split + 1)),
    limit: p.limit,
  };
}

/** Legacy list (unchanged shape), capped at 200 rows. */
export async function listOfflineRecoveries(tx: Tx, s: Session) {
  permit(s, managers);
  return tx`select r.id,r.operation_id,r.order_id,r.reason,r.original_sold_at,
    r.recognized_at,r.original_employee_id,r.original_device_id,
    r.original_drawer_id,r.item_allocation_complete,
    coalesce(jsonb_agg(jsonb_build_object('id',t.id,'kind',t.kind,'state',t.state,
      'resolution',t.resolution,'resolvedAt',t.resolved_at) order by t.kind)
      filter(where t.id is not null),'[]') as tasks
    from offline_recoveries r left join offline_recovery_tasks t
      on t.tenant_id=r.tenant_id and t.recovery_id=r.id
    group by r.tenant_id,r.id order by r.recognized_at desc,r.id desc limit 200`;
}

/** Keyset-paginated recoveries, newest first. */
export async function listOfflineRecoveriesPage(
  tx: Tx,
  s: Session,
  q: unknown,
) {
  permit(s, managers);
  const c = cursorOf(q);
  const rows = await tx`select r.id,r.operation_id,r.order_id,r.reason,r.original_sold_at,
      r.recognized_at,r.original_employee_id,r.original_device_id,
      r.original_drawer_id,r.item_allocation_complete,
      coalesce(jsonb_agg(jsonb_build_object('id',t.id,'kind',t.kind,'state',t.state,
        'resolution',t.resolution,'resolvedAt',t.resolved_at) order by t.kind)
        filter(where t.id is not null),'[]') as tasks,
      to_char(r.recognized_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
    from offline_recoveries r left join offline_recovery_tasks t
      on t.tenant_id=r.tenant_id and t.recovery_id=r.id
    where ${c.at === null ? tx`true` : tx`(r.recognized_at,r.id) < (${c.at}::timestamptz,${c.id}::uuid)`}
    group by r.tenant_id,r.id order by r.recognized_at desc,r.id desc limit ${c.limit + 1}`;
  const items = rows.slice(0, c.limit);
  const last = items.at(-1);
  return {
    items: items.map(({ cursor_at: _cursor, ...item }) => item),
    nextCursor:
      rows.length > c.limit && last ? `${last.cursor_at}_${last.id}` : null,
  };
}

/** Keyset-paginated manager archives, newest first. */
export async function listOfflineArchives(tx: Tx, s: Session, q: unknown) {
  permit(s, managers);
  const c = cursorOf(q);
  const rows = await tx`select a.id,a.operation_id,a.kind,a.amount,a.tip,a.currency,
      a.recorded_at,a.claimed_device_id,a.claimed_drawer_id,a.reason,e.name as actor_name,
      a.created_at,a.evidence_valid,
      to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
    from offline_archives a join employees e on e.tenant_id=a.tenant_id and e.id=a.actor_id
    where ${c.at === null ? tx`true` : tx`(a.created_at,a.id) < (${c.at}::timestamptz,${c.id}::uuid)`}
    order by a.created_at desc,a.id desc limit ${c.limit + 1}`;
  const items = rows.slice(0, c.limit);
  const last = items.at(-1);
  return {
    items: items.map((a) => ({
      id: a.id,
      operationId: a.operation_id,
      kind: a.kind,
      amount: a.amount,
      tip: a.tip,
      currency: a.currency,
      recordedAt: a.recorded_at?.toISOString() ?? null,
      claimedDeviceId: a.claimed_device_id,
      claimedDrawerId: a.claimed_drawer_id,
      reason: a.reason,
      actorName: a.actor_name,
      createdAt: a.created_at.toISOString(),
      evidenceValid: a.evidence_valid,
    })),
    nextCursor:
      rows.length > c.limit && last ? `${last.cursor_at}_${last.id}` : null,
  };
}

export async function resolveOfflineRecoveryTask(
  tx: Tx,
  s: Session,
  raw: unknown,
) {
  permit(s, managers);
  const p = z
    .object({
      operationId: z.uuid(),
      taskId: z.uuid(),
      outcome: z.enum(["already_completed", "not_completed"]),
      reason: z.string().trim().min(10).max(500),
    })
    .strict()
    .parse(raw);
  return once(tx, s, p.operationId, "offline_recovery.task", p, async () => {
    await tx`select o.id from orders o join offline_recoveries r on r.tenant_id=o.tenant_id and r.order_id=o.id
      join offline_recovery_tasks t on t.tenant_id=r.tenant_id and t.recovery_id=r.id where t.id=${p.taskId} for update of o`;
    const [task] = await tx`select t.*,r.order_id from offline_recovery_tasks t
      join offline_recoveries r on r.tenant_id=t.tenant_id and r.id=t.recovery_id
      where t.id=${p.taskId} for update of t`;
    if (!task) throw new DomainError("not_found", 404);
    if (task.state === "resolved")
      return {
        id: task.id,
        state: task.state,
        resolution: task.resolution,
      };
    const resolution = `${p.outcome}: ${p.reason}`;
    await tx`update offline_recovery_tasks set state='resolved',resolved_by=${s.employeeId},resolution=${resolution},resolved_at=now() where id=${task.id}`;
    const [remaining] =
      await tx`select count(*)::int as count from offline_recovery_tasks where recovery_id=${task.recovery_id} and state='pending'`;
    if (remaining.count === 0)
      await tx`update orders set state='recovery_reviewed' where id=${task.order_id}`;
    await audit(tx, s, `offline.${task.kind}_reviewed`, task.recovery_id, {
      outcome: p.outcome,
      reason: p.reason,
    });
    return { id: task.id, state: "resolved", resolution };
  });
}
