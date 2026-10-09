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
  type PricePlatform,
  type Order,
  type Session,
} from "../shared/domain.js";
import {
  evaluateRecordedAt,
  evidenceKey,
  formatVersionOf,
  offlinePaymentIssue,
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
} from "./offline-leases.js";
import { requireRecentAuth } from "./access.js";
import { assertCheckWritable, refreshCheckState } from "./checks.js";
import { fiscalContext, issueDueTicket } from "./fiscal.js";
import { allocatePayment } from "../shared/settlement.js";
import { placeRoundsInOfflineReview } from "./offline-kitchen.js";
import { evidenceExtras, insertTender } from "./payments/tenders.js";

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
  | {
      authentic: true;
      ctx: EvidenceContext;
      problems: EligibilityProblem[];
      /** Why E3-E5 gave offline_conflict, for the manager review (OFFLINE-RECOVERY-03). */
      causes: string[];
    }
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
    // payments (037): judged per method, platform included; nothing defaults to cash.
    if (offlinePaymentIssue(payment))
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
    drawer: cash
      ? { openedAt: cash.opened_at, closedAt: cash.closed_at }
      : null,
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
  // E3-E5 all give offline_conflict (contract D6); `causes` names which one,
  // most specific first (deactivating an employee also revokes the session).
  const causes: string[] = [];
  const [identity] =
    await tx`select e.active as employee_active,d.active as device_active
      from employees e cross join devices d where e.id=${session.employee_id} and d.id=${session.device_id}`;
  if (!identity?.employee_active) causes.push("offline_why_employee_inactive");
  if (!identity?.device_active) causes.push("offline_why_device_inactive");
  if (session.revoked) {
    problems.push("offline_conflict"); // E3 (contract D6)
    if (!causes.length) causes.push("offline_why_session_revoked");
  }
  if (!identity?.employee_active || !identity?.device_active)
    problems.push("offline_conflict"); // E4
  if (!lease.selling_authorized) {
    problems.push("offline_conflict"); // E5
    causes.push("offline_why_selling_not_authorized");
  }
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
    causes,
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
  /** payments (037, LD-72): the order's platform price list (null = POS prices). */
  priceList: PricePlatform | null = null,
) {
  const productIds = [...new Set(lines.map((line) => line.productId))].sort();
  // Hold the catalog revisions until commit so a concurrent edit cannot change
  // the recipe between verification and stock consumption.
  const versions =
    await tx`select id,data from catalog where id=any(${tx.array(productIds)}::uuid[]) order by id for share`;
  // Staff path: open-price lines are valid evidence (contract D11). Synced
  // orders and rounds snapshot tax with the server's fiscal context (027).
  const priced = quote(
    lines,
    await catalog(tx),
    true,
    await fiscalContext(tx),
    priceList,
  );
  const problem = linesProblem(
    lines,
    snapshots,
    expectedTotal,
    sum(priced.map((line) => line.total)),
    versions,
  );
  if (problem) throw new DomainError(problem, 409);
  return priced;
}

/**
 * Why claimed lines would not apply as recorded (I3): the server prices them
 * differently, or a product changed revision since the receipt. Pure, so the
 * manager review can tell without taking the sync's locks.
 */
export function linesProblem(
  lines: LineInput[],
  snapshots: unknown[] | undefined,
  expectedTotal: number,
  serverTotal: number,
  versions: readonly Record<string, any>[],
): "price_conflict" | "offline_catalog_changed" | null {
  if (serverTotal !== expectedTotal) return "price_conflict";
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
      return "offline_catalog_changed";
  }
  return null;
}

export const snapshotLines = (p: OfflineRecord) =>
  "receiptSnapshot" in p ? p.receiptSnapshot?.lines : undefined;

export type OrderRecord = OfflineRecord & {
  order: z.infer<typeof orderInput>;
  expectedTotal: number;
};

/**
 * Line ids are the order_lines primary key. Lines an online send already
 * recorded (its response was lost, so the draft kept them) can never be
 * inserted again; that is a domain conflict for a manager, not a server error
 * retried forever.
 */
export async function assertLinesNotRecorded(tx: Tx, lines: LineInput[]) {
  const ids = lines.map((l) => l.id);
  const [found] =
    await tx`select 1 from order_lines where id=any(${tx.array(ids)}::uuid[]) limit 1`;
  if (found) throw new DomainError("offline_lines_already_sent", 409);
}

/**
 * I3 on reuse: the online create priced the draft with the server catalog and
 * the device priced it with its own. A different total is a price conflict
 * for a manager, never silently a partial payment. A sale pays the whole
 * order, so it also never reuses an order that changed or already took money.
 */
async function assertReusable(
  tx: Tx,
  p: OrderRecord,
  orderId: string,
  created: { total?: unknown } | null,
) {
  if (Number(created?.total) !== p.expectedTotal)
    throw new DomainError("price_conflict", 409);
  if (recordKind(p) !== "sale") return;
  const [order] = await tx`select o.total,
      (select coalesce(sum(t.amount),0)::int from tenders t
        where t.tenant_id=o.tenant_id and t.order_id=o.id) as paid
    from orders o where o.id=${orderId}`;
  if (!order) throw new DomainError("offline_order_closed", 409);
  if (order.paid > 0) throw new DomainError("offline_payment_exceeds_due", 409);
  if (order.total !== p.expectedTotal)
    throw new DomainError("price_conflict", 409);
}

/**
 * OFF-R27: the order an online create already made under a sale or order
 * record's draft id (the create committed and its response was lost), and the
 * code its sync gives: null when the record reuses that order. Null when the
 * draft id was never used online. Read-only.
 */
export async function onlineCreateOf(
  tx: Tx,
  p: OfflineRecord,
): Promise<{ orderId: string | null; problem: string | null } | null> {
  if (!("order" in p)) return null;
  const record = p as OrderRecord;
  const [prior] =
    await tx`select kind,hash,result from operations where id=${record.order.operationId}`;
  if (!prior) return null;
  const orderId =
    prior.kind === "create_order" && typeof prior.result?.id === "string"
      ? (prior.result.id as string)
      : null;
  const online = hash(
    JSON.stringify(orderInput.parse({ ...record.order, channel: "pos" })),
  );
  // A different draft under the same order id is a conflict, never a merge.
  if (!orderId || prior.hash !== online)
    return { orderId, problem: "offline_order_already_exists" };
  try {
    await assertReusable(tx, record, orderId, prior.result);
    return { orderId, problem: null };
  } catch (e) {
    if (e instanceof DomainError) return { orderId, problem: e.code };
    throw e;
  }
}

/**
 * The order a sale opens. An online create that committed but whose response
 * was lost is reused (the kitchen already saw it) instead of duplicated, only
 * when the device priced it exactly as the server did.
 */
export async function resolveOrCreateOrder(
  tx: Tx,
  s: Session,
  p: OrderRecord,
  ctx: EvidenceContext,
): Promise<{ orderId: string; reused: boolean }> {
  const created = await onlineCreateOf(tx, p);
  if (created) {
    if (created.problem || !created.orderId)
      throw new DomainError(
        created.problem ?? "offline_order_already_exists",
        409,
      );
    return { orderId: created.orderId, reused: true };
  }
  await verifyLines(
    tx,
    p.order.lines,
    snapshotLines(p),
    p.expectedTotal,
    p.order.pricePlatform ?? null,
  );
  await assertLinesNotRecorded(tx, p.order.lines);
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
  // payments (037): a terminal deleted since is dropped, never the money (OFF-8).
  const extras = await evidenceExtras(tx, payment);
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
        ...(extras.terminal ? { terminalId: extras.terminal.id } : {}),
        ...(payment.platform ? { platform: payment.platform } : {}),
        ...(payment.platformLabel
          ? { platformLabel: payment.platformLabel }
          : {}),
      },
      null,
      drawerId,
      { evidence: true, droppedTerminalId: extras.droppedTerminalId },
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

/**
 * A manager-reconciled offline tender (source offline_recovery) through the one tender writer,
 * with the record's terminal or platform (payments 037; archived terminal accepted, unknown
 * dropped). Returns the tender id.
 */
async function insertRecoveredTender(
  tx: Tx,
  s: Session,
  t: {
    tenderId?: string;
    orderId: string;
    drawerId: string;
    payment: OfflinePayment;
    operationId: string;
  },
): Promise<string> {
  const extras = await evidenceExtras(tx, t.payment);
  return insertTender(tx, s, {
    tenderId: t.tenderId,
    orderId: t.orderId,
    drawerId: t.drawerId,
    method: t.payment.method,
    amount: t.payment.amount,
    tip: t.payment.tip,
    received: t.payment.received,
    reference: t.payment.reference || null,
    source: { kind: "offline_recovery", id: t.operationId },
    clock: true,
    terminal: extras.terminal,
    platform: extras.platform,
  });
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
  let result: unknown;
  try {
    result = await once(tx, s, p.operationId, "offline_sync", p, async () => {
      const evidence = await evaluateEvidence(tx, s, p);
      if (!evidence.authentic)
        throw new DomainError("offline_evidence_invalid", 409);
      if (evidence.problems.length)
        throw new DomainError(evidence.problems[0]!, 409);
      return applyRecord(tx, s, p, evidence.ctx);
    });
  } catch (e) {
    throw integrityConflict(e, p.operationId);
  }
  return normalizeSyncResult(result, p.operationId, s.restaurant);
}

/**
 * OFFLINE-MONEY-6: a record that collides with rows the server already has
 * (a unique or foreign-key violation, for example an order for a table
 * deleted after the outage) can never apply on a later attempt. As a 500 the device would
 * retry it forever and block drawer close; as a domain conflict a manager
 * reviews it. Since menu (025), createOrder refuses a table archived or
 * deleted after the outage itself (invalid_table) before the foreign key
 * would; that is the same collision. Every other error passes through
 * unchanged.
 */
function integrityConflict(e: unknown, operationId: string): unknown {
  const code = (e as { code?: unknown } | null)?.code;
  const goneTable = e instanceof DomainError && code === "invalid_table";
  if (
    !goneTable &&
    (e instanceof DomainError || (code !== "23505" && code !== "23503"))
  )
    return e;
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "offline.sync_integrity_conflict",
      operationId,
      code,
      constraint: (e as { constraint_name?: unknown }).constraint_name,
    }),
  );
  return new DomainError("offline_record_conflict", 409);
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
  return withLegacyCodes(async () => (await syncOfflineRecord(tx, s, p)).order);
}

/**
 * What review can say about the order a record's money would go to: the
 * order a round or payment targets (offline-tables series), or the order an
 * online create already made for a sale or order (OFF-R27). `reconcile` is
 * the manager path: into that order, as a financial-only recovery, or none
 * (the manager must wait for the original order or archive). `problems`
 * explain a refusal or the financial-only path.
 */
export type ReviewTarget = {
  /** `businessDate`: the order's business day, to date its number (LD-29/LD-48). */
  target: {
    orderId: string;
    number: number;
    businessDate: string | null;
    due: number;
  } | null;
  reconcile: "order" | "financial" | "none";
  problems: string[];
  /**
   * The order an online create already made for this record's draft (its
   * response lost): `reused` when sync takes that order as this record's own
   * (OFF-R30), so the record syncs by itself and is never archived for it.
   */
  onlineCreate?: { reused: boolean };
};
export const reviewTargets: {
  resolve?: (tx: Tx, p: OfflineRecord) => Promise<ReviewTarget | null>;
} = {};

/**
 * An existing order as a place for a record's money on the manager path:
 * `unresolvable` when it is gone, cancelled or in recovery (it can never hold
 * money), `closed` when its check takes no more payments (contract §3.4), or
 * `open`. `lock` takes the order row lock first (class 5, §4.4.1).
 */
export type MoneyTarget =
  | { state: "unresolvable"; code: string }
  | { state: "closed" | "open"; order: Order };

export async function moneyTarget(
  tx: Tx,
  orderId: string,
  lock: boolean,
): Promise<MoneyTarget> {
  const [row] = lock
    ? await tx`select * from orders where id=${orderId} for update`
    : await tx`select * from orders where id=${orderId}`;
  if (!row || CLOSED_STATES.includes(row.state))
    return { state: "unresolvable", code: "offline_order_closed" };
  const order = await getOrder(tx, orderId);
  try {
    assertCheckWritable(row as { check_state: string; state: string });
  } catch (e) {
    if (e instanceof DomainError) return { state: "closed", order };
    throw e;
  }
  return { state: "open", order };
}

export const dueOf = (order: Order) => order.total - order.paid;

/** Why money of `amount` cannot go into an order that is not open or too small. */
export const moneyRefusal = (amount: number, order: Order) =>
  amount > dueOf(order)
    ? "offline_payment_exceeds_due"
    : "offline_order_closed";

/**
 * OFF-R31: a POS create of this draft whose order can never hold money
 * (cancelled, for example every line voided, or gone). Its authentic money can
 * only be a financial-only recovery. Not for an order a financial-only
 * recovery made for the same draft (its hash differs): that order already
 * holds money, and a second recovery would count it twice.
 */
export const cancelledOnlineCreate = (
  created: { orderId: string | null; problem: string | null },
  found: MoneyTarget,
) =>
  found.state === "unresolvable" &&
  created.problem !== "offline_order_already_exists";

/**
 * OFF-R27: review of a sale or order whose create already committed online.
 * The existing order is named so the manager knows which order took (or
 * should take) the money. A sale's money goes into it when it is open and the
 * amount fits its balance (I2); otherwise nothing is reconcilable, because a
 * financial-only recovery would leave that order open and unpaid, except when
 * that order was cancelled (OFF-R31).
 */
async function onlineCreateTarget(
  tx: Tx,
  p: OfflineRecord,
): Promise<ReviewTarget | null> {
  const created = await onlineCreateOf(tx, p);
  if (!created) return null;
  const problems = created.problem ? [created.problem] : [];
  const onlineCreate = { reused: !created.problem && !!created.orderId };
  if (!created.orderId)
    return {
      target: null,
      reconcile: "none",
      problems: problems.length ? problems : ["offline_order_already_exists"],
      onlineCreate,
    };
  const found = await moneyTarget(tx, created.orderId, false);
  const order =
    found.state === "unresolvable"
      ? await getOrder(tx, created.orderId).catch((e: unknown) => {
          if (e instanceof DomainError) return null;
          throw e;
        })
      : found.order;
  const target = order
    ? {
        orderId: order.id,
        number: order.number,
        businessDate: order.businessDate ?? null,
        due: dueOf(order),
      }
    : null;
  const payment = paymentOf(p);
  const withProblem = (code: string) =>
    problems.includes(code) ? problems : [...problems, code];
  if (!payment) return { target, reconcile: "none", problems, onlineCreate };
  if (found.state === "unresolvable") {
    const [recovered] =
      await tx`select 1 from offline_recoveries where order_operation_id=${(p as OrderRecord).order.operationId}`;
    return {
      target,
      reconcile:
        cancelledOnlineCreate(created, found) && !recovered
          ? "financial"
          : "none",
      problems: withProblem(found.code),
      onlineCreate,
    };
  }
  if (found.state === "open" && payment.amount <= dueOf(found.order))
    return { target, reconcile: "order", problems, onlineCreate };
  return {
    target,
    reconcile: "none",
    problems: withProblem(moneyRefusal(payment.amount, found.order)),
    onlineCreate,
  };
}

/**
 * payments (037, LD-72; PAYMENTS-MONEY-3): the price list a record's lines sync at: an order or
 * sale record's own, a round's target order's (read as the round applier reads it); null = POS
 * prices, also while a round's parent has not synced yet.
 */
async function reviewPriceList(
  tx: Tx,
  p: Record<string, unknown>,
): Promise<PricePlatform | null> {
  if ("order" in p)
    return (
      (p.order as { pricePlatform?: PricePlatform | null }).pricePlatform ??
      null
    );
  const target = p.target as
    { orderId: string } | { localOrderOperationId: string } | undefined;
  if (!target) return null;
  let orderId: string | null;
  if ("orderId" in target) orderId = target.orderId;
  else {
    const [parent] =
      await tx`select result from operations where id=${target.localOrderOperationId} and kind='offline_sync'`;
    orderId = parent
      ? (parent.result.orderId ?? parent.result.id ?? null)
      : null;
  }
  if (!orderId) return null;
  const [order] =
    await tx`select price_platform from orders where id=${orderId}`;
  return (order?.price_platform as PricePlatform | null) ?? null;
}

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
      // PAYMENTS-MONEY-3: priced at the list the sync would use (verifyLines).
      currentTotal = sum(
        quote(
          lines,
          await catalog(tx),
          true,
          undefined,
          await reviewPriceList(tx, p),
        ).map((line) => line.total),
      );
    } catch {
      /* Unavailable/deleted menu is explicitly unknown. */
    }
  const targeted =
    (await reviewTargets.resolve?.(tx, p)) ?? (await onlineCreateTarget(tx, p));
  const target = targeted?.target ?? null;
  const session = evidence.authentic ? evidence.ctx.session : evidence.session;
  const [employee] = session
    ? await tx`select name from employees where id=${session.employee_id}`
    : [];
  const [device] = session
    ? await tx`select name from devices where id=${session.device_id}`
    : [];
  const drawerId = drawerOf(p);
  const [cash] = drawerId
    ? await tx`select id,closed_at from cash_sessions where id=${drawerId}`
    : [];
  const amount = payment?.amount ?? 0;
  // Money is reconcilable only into an open order it fits, or as a
  // financial-only recovery when no order holds it: never while a payment's
  // original order is still queued, never into a paid or closed check, and
  // never beside an order an online create already made for the sale (I2,
  // I5, OFF-R27).
  const reconcilable =
    evidence.authentic &&
    !prior &&
    !archived &&
    !!payment &&
    !!reconcilers[kind] &&
    (targeted ? targeted.reconcile !== "none" : kind !== "payment");
  const problems: string[] = evidence.authentic ? [...evidence.problems] : [];
  const addProblem = (code: string) => {
    if (!problems.includes(code)) problems.push(code);
  };
  for (const problem of targeted?.problems ?? []) addProblem(problem);
  // Claimed lines the sync would refuse (I3), read without the sync's locks.
  // An order an online create already made is reused as it is instead.
  if (evidence.authentic && lines && !targeted?.onlineCreate && !prior) {
    const [sent] =
      await tx`select 1 from order_lines where id=any(${tx.array(lines.map((l) => l.id))}::uuid[]) limit 1`;
    const versions =
      currentTotal === null
        ? []
        : await tx`select id,data from catalog where id=any(${tx.array([...new Set(lines.map((l) => l.productId))])}::uuid[])`;
    const linesCode =
      currentTotal === null
        ? null
        : linesProblem(
            lines,
            snapshotLines(p),
            (p as { expectedTotal: number }).expectedTotal,
            currentTotal,
            versions,
          );
    // A table deleted or archived (menu 025, D10) after the outage refuses
    // the order, as createOrder does.
    const tableId = "order" in p ? p.order.tableId : null;
    const [table] = tableId
      ? await tx`select 1 from dining_tables where id=${tableId} and archived_at is null`
      : [{}];
    if (new Set(lines.map((l) => l.id)).size !== lines.length || !table)
      addProblem("offline_record_conflict");
    else if (sent) addProblem("offline_lines_already_sent");
    else if (linesCode) addProblem(linesCode);
  }
  // OFFLINE-RECOVERY-04: a record nothing blocks syncs by itself once the
  // employee who saved it signs in on that device (E2). Reconciling it instead
  // would keep only its money, without lines, kitchen or stock.
  const waits = ["offline_dependency_pending", "offline_recorded_in_future"];
  const autoSyncAs =
    evidence.authentic &&
    !prior &&
    !archived &&
    problems.every((code) => waits.includes(code)) &&
    (!targeted?.onlineCreate || targeted.onlineCreate.reused)
      ? {
          employeeName: (employee?.name as string | undefined) ?? null,
          deviceName: (device?.name as string | undefined) ?? null,
          self:
            session!.employee_id === s.employeeId &&
            session!.device_id === s.deviceId,
        }
      : null;
  // OFFLINE-RECOVERY-03: each problem in words a manager can act on, for the
  // kind of record (an order or round carries no money to reconcile).
  const reasons: string[] = [];
  const addReason = (code: string) => {
    if (!reasons.includes(code)) reasons.push(code);
  };
  for (const code of problems) {
    if (code === "offline_conflict" && evidence.authentic)
      (evidence.causes.length ? evidence.causes : [code]).forEach(addReason);
    else if (code === "settings_changed")
      addReason(
        payment ? "offline_why_settings_changed" : "offline_why_settings_items",
      );
    else if (code === "price_conflict" && !payment)
      addReason("offline_why_price_items");
    else if (code === "offline_catalog_changed" && !payment)
      addReason("offline_why_catalog_items");
    else addReason(code);
  }
  return {
    authentic: evidence.authentic,
    problems,
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
    /** Where reconcile puts the money: into `target`, or a recovery order. */
    reconcileAs: reconcilable
      ? targeted?.reconcile === "order"
        ? ("order" as const)
        : ("financial" as const)
      : null,
    /** OFF-R30: sync takes the order an online create made for this draft. */
    reusesOnlineOrder: !!targeted?.onlineCreate?.reused && !!target,
    autoSyncAs,
    reasons,
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
  /**
   * OFF-R31: the draft's POS create committed online and its order can never
   * hold money (cancelled). The money still needs a home; that create stays
   * the draft's operation.
   */
  opts: { cancelledOnlineCreate?: boolean } = {},
): Promise<OfflineSyncResult> {
  const payment = paymentOf(p)!;
  const order = "order" in p ? p.order : null;
  if (order) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + order.operationId},0))`;
    const [existingOrder] =
      await tx`select id from operations where id=${order.operationId}`;
    if (existingOrder && !opts.cancelledOnlineCreate)
      throw new DomainError("offline_order_already_exists", 409);
    // One recovery per draft (offline_recoveries is unique on it).
    const [recovered] = opts.cancelledOnlineCreate
      ? await tx`select 1 from offline_recoveries where order_operation_id=${order.operationId}`
      : [];
    if (recovered) throw new DomainError("offline_order_already_exists", 409);
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
  await tx`insert into orders(tenant_id,id,number,business_date,employee_id,table_id,mode,name,note,channel,total,state,restaurant_snapshot) values(${s.tenantId},${orderId},${number.value},${date},${lease.employee_id},null,${order?.mode ?? "takeaway"},${order?.name ?? ""},${"Conciliación de efectivo sin conexión: " + reason},'offline',${payment.amount},'recovery_pending',${tx.json(lease.restaurant_snapshot)})`;
  // Global lock order (contract §3.14): the drawer after order_numbers and the
  // order, so a concurrent drawer close waits for this tender.
  const [cash] =
    await tx`select * from cash_sessions where id=${drawerOf(p)} for update`;
  await insertRecoveredTender(tx, s, {
    tenderId,
    orderId,
    drawerId: cash.id,
    payment,
    operationId: p.operationId,
  });
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
  // fiscal 027: a recovery order is closed at insert, so refreshCheckState never
  // issues it; one recovery_default group at the restaurant default category.
  await issueDueTicket(tx, s, orderId, "recovery");
  const result = await getOrder(tx, orderId);
  if (order && !opts.cancelledOnlineCreate)
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

/**
 * Manager reconcile of a record's money into an existing open order: the
 * tender goes to the original drawer (open or closed) with the same
 * allocations the payment command would make. No recovery order, so the order
 * stays a normal, serviceable order. The caller holds the order row lock.
 * Used for a payment of its target order, and for a sale whose create already
 * committed online (OFF-R27), which is that order's first round.
 */
export async function reconcileIntoOrder(
  tx: Tx,
  s: Session,
  p: OfflineRecord,
  ctx: EvidenceContext,
  order: Order,
  reason: string,
): Promise<OfflineSyncResult> {
  const kind = recordKind(p);
  const payment = paymentOf(p)!;
  const drawerId = drawerOf(p)!;
  const orderId = order.id;
  if (payment.amount > dueOf(order))
    throw new DomainError("offline_payment_exceeds_due", 409);
  // Global lock order (§4.4.1): the drawer after the order, so a concurrent
  // drawer close waits for this tender and counts it.
  await tx`select id from cash_sessions where id=${drawerId} for update`;
  const allocations = order.itemSplitAvailable
    ? allocatePayment(order.paymentUnits!, payment.amount)
    : [];
  const tenderId = await insertRecoveredTender(tx, s, {
    orderId,
    drawerId,
    payment,
    operationId: p.operationId,
  });
  for (const allocation of allocations)
    await tx`insert into tender_allocations(tenant_id,order_id,tender_id,line_id,unit_index,amount)
      values(${s.tenantId},${orderId},${tenderId},${allocation.lineId},${allocation.unit},${allocation.amount})`;
  const sale = kind === "sale";
  await ledger(tx, s, p, ctx, {
    kind,
    orderId,
    roundNumber: sale ? 1 : null,
    tenderId,
    reused: sale,
    path: "manager",
    reason,
  });
  await audit(tx, s, "offline.payment_reconciled", orderId, {
    reason,
    kind,
    operationId: p.operationId,
    amount: payment.amount,
    tip: payment.tip,
    method: payment.method,
    drawerId,
    provisionalNumber: isV3(p) ? p.provisionalNumber : null,
  });
  await refreshCheckState(tx, s, orderId);
  const result = await getOrder(tx, orderId);
  return {
    kind,
    operationId: p.operationId,
    orderId,
    orderNumber: result.number,
    provisionalNumber: isV3(p) ? p.provisionalNumber : null,
    roundNumber: sale ? 1 : null,
    tenderId,
    soldAt: ctx.soldAt.toISOString(),
    businessDate: ctx.businessDate,
    reusedOnlineOrder: sale,
    kitchenReview: false,
    order: result,
  };
}

/**
 * Manager reconcile of a sale. A sale whose create never reached the server
 * is a financial-only recovery. One whose create committed online (its
 * response lost) already has its order, which the kitchen made: the money
 * goes into that order when it is open and the amount fits (OFF-R27), and is
 * refused otherwise, never recorded beside it.
 */
async function reconcileSale(
  tx: Tx,
  s: Session,
  p: OfflineRecord,
  ctx: EvidenceContext,
  reason: string,
): Promise<OfflineSyncResult> {
  const record = p as OrderRecord;
  // Serialized with an online create of the same draft (once() locks its id).
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + record.order.operationId},0))`;
  const created = await onlineCreateOf(tx, p);
  if (!created) return financialRecovery(tx, s, p, ctx, reason);
  if (!created.orderId)
    throw new DomainError("offline_order_already_exists", 409);
  const found = await moneyTarget(tx, created.orderId, true);
  // OFF-R31: a cancelled POS order holds nothing; the authentic money is a
  // financial-only recovery instead of a sale with nowhere to go.
  if (cancelledOnlineCreate(created, found))
    return financialRecovery(tx, s, p, ctx, reason, {
      cancelledOnlineCreate: true,
    });
  if (found.state === "unresolvable") throw new DomainError(found.code, 409);
  if (found.state === "closed")
    throw new DomainError(moneyRefusal(paymentOf(p)!.amount, found.order), 409);
  return reconcileIntoOrder(tx, s, p, ctx, found.order, reason);
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
  sale: reconcileSale,
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
  requireRecentAuth(s); // D23: money-affecting manager command
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
  requireRecentAuth(s); // D23: money-affecting manager command
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
  const rows =
    await tx`select r.id,r.operation_id,r.order_id,r.reason,r.original_sold_at,
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
  const rows =
    await tx`select a.id,a.operation_id,a.kind,a.amount,a.tip,a.currency,
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
