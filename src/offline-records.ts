/**
 * Offline record builders (format v3) and local projections (OFF-5).
 *
 * Money invariants enforced before anything is written:
 * - every save is one Dexie transaction: the record, the sequence counters and
 *   the draft deletion commit together or not at all;
 * - a record's operationId is created once per user action and is the server's
 *   idempotency key, so a record can only ever apply once (I1);
 * - records cite the lease they were made under, never live settings (OFF-8);
 * - nothing is saved after the offline window ends, by the server clock (I14).
 * The server re-prices every line at sync and rejects any mismatch (I3).
 */
import {
  businessDate,
  currencyExponent,
  type LineInput,
  type Order,
  type OrderInput,
  type PricedLine,
  type Product,
  type Session,
} from "../shared/domain";
import {
  offlineRecordV3,
  type OfflinePayment,
  type OfflineRecord,
  type OfflineRecordV3,
  type OrderTarget,
} from "../shared/offline-recovery";
import { api } from "./api";
import { clockOffset, correctedIso, deviceIso, serverNow } from "./clock";
import { getConnectivitySnapshot } from "./connectivity";
import { db, type Pending } from "./offline";
import { scope } from "./offline-keys";
import {
  fallbackPrefix,
  formatProvisional,
  offlineWindow,
} from "./offline-policy";
import {
  ticketsFromLines,
  type KitchenTicketModel,
} from "./compat/offline-print";

export type OfflinePaymentInput = OfflinePayment;
export type SaveContext = {
  session: Session;
  catalog: Product[];
  cashSession: { id: string; closed_at: string | null } | null;
};
export type LocalReceipt = Order & {
  state: "local";
  offline: {
    provisionalNumber: string | null;
    soldAt: string;
    method: "cash" | "external";
    reference: string;
    localOperationId?: string | null;
    cachedAt?: string | null;
    serverOrderId?: string | null;
  };
};
/** A kitchen ticket kept on this device for calling out and reprinting. */
export type LocalTicket = {
  key: string;
  operationId: string;
  createdAt: number;
  ticket: KitchenTicketModel;
};

/** A client-side refusal; the message is an error code for translateError. */
export class OfflineSaveError extends Error {}
const fail = (code: string): never => {
  throw new OfflineSaveError(code);
};

const prefixKey = (s: Session) => `${s.tenantId}:${s.deviceId}:offline-prefix`;
const dayKey = (s: Session, day: string) =>
  `${s.tenantId}:${s.deviceId}:offline-seq:${day}`;
const sequenceKey = (s: Session) => `${scope(s)}:offline-sequence`;
export const ticketKey = (s: Session, operationId: string, station: string) =>
  `${scope(s)}:ticket:${operationId}:${station}`;
export const tablesKey = (s: Session) => `${scope(s)}:tables`;

type CachedPrefix = { prefix: string; source: "server" | "fallback" };

/** Server-assigned device prefix, fetched once while online; "Z.." otherwise. */
export async function ensureDevicePrefix(session: Session): Promise<string> {
  const cached = (await db.cache.get(prefixKey(session)))?.value as
    CachedPrefix | undefined;
  if (cached?.source === "server") return cached.prefix;
  if (getConnectivitySnapshot().canUseServer && session.role !== "kitchen")
    try {
      const { prefix } = await api<{ prefix: string }>("/offline/device", {});
      await db.cache.put({
        id: prefixKey(session),
        value: { prefix, source: "server" } satisfies CachedPrefix,
      });
      return prefix;
    } catch {
      /* The reserved fallback family still yields valid numbers. */
    }
  return fallbackPrefix(session.deviceId);
}

async function devicePrefix(session: Session): Promise<string> {
  const cached = (await db.cache.get(prefixKey(session)))?.value as
    CachedPrefix | undefined;
  return cached?.source === "server"
    ? cached.prefix
    : fallbackPrefix(session.deviceId);
}

async function allocateNumber(session: Session, prefix: string) {
  const day = businessDate(
    correctedIso(),
    session.restaurant.timezone,
    session.restaurant.cutoff,
  );
  const key = dayKey(session, day);
  const next = Number((await db.cache.get(key))?.value ?? 0) + 1;
  await db.cache.put({ id: key, value: next });
  return formatProvisional(prefix, next);
}

/** Next per-device, per-business-day provisional number ("B-07"). */
export async function nextProvisionalNumber(session: Session): Promise<string> {
  const prefix = await devicePrefix(session);
  return db.transaction("rw", db.cache, () => allocateNumber(session, prefix));
}

async function allocateSequence(session: Session) {
  const next =
    Number((await db.cache.get(sequenceKey(session)))?.value ?? 0) + 1;
  await db.cache.put({ id: sequenceKey(session), value: next });
  return next;
}

function restaurantSnapshot(session: Session) {
  const { name, currency, timezone, cutoff, configVersion } =
    session.restaurant;
  return {
    name,
    currency,
    timezone,
    cutoff,
    ...(configVersion === undefined ? {} : { configVersion }),
  };
}

/** The client code that blocks offline saves now, or null. */
export function offlineBlockReason(
  session: Session,
  cashSession: SaveContext["cashSession"],
  needsDrawer: boolean,
): string | null {
  if (session.sellingAllowed === false) return "free_selection_required";
  if (offlineWindow(session.offlineUntil, serverNow()).expired)
    return "offline_window_expired";
  if (needsDrawer && (!cashSession || cashSession.closed_at))
    return "offline_drawer_missing";
  return null;
}

export function check(ctx: SaveContext, needsDrawer: boolean) {
  const reason = offlineBlockReason(ctx.session, ctx.cashSession, needsDrawer);
  if (reason) fail(reason);
}

export function checkLines(lines: LineInput[]) {
  if (!lines.length) fail("offline_record_invalid");
}

export function checkPayment(payment: OfflinePaymentInput, due: number) {
  if (!(payment.amount > 0)) fail("offline_amount_invalid");
  if (payment.amount > due) fail("offline_amount_exceeds_due");
  if (
    payment.method === "cash" &&
    payment.received < payment.amount + payment.tip
  )
    fail("insufficient_cash");
  if (
    payment.method === "external" &&
    (!payment.externalConfirmed ||
      !payment.reference.trim() ||
      payment.received !== payment.amount + payment.tip)
  )
    fail("external_confirmation");
}

export function recordBase(
  session: Session,
  operationId: string,
  sequence: number,
  provisionalNumber: string | null,
  kitchenDelivery: OfflineRecordV3["kitchenDelivery"],
) {
  const offset = clockOffset();
  return {
    formatVersion: 3 as const,
    operationId,
    tenantId: session.tenantId,
    employeeId: session.employeeId,
    deviceId: session.deviceId,
    sessionId: session.id,
    // OFF-8: cite the lease, never session.restaurant.configVersion (live).
    lease: {
      contractVersion: session.offlineLeaseVersion ?? 1,
      configurationVersion: session.offlineLeaseConfigVersion ?? null,
    },
    currency: session.restaurant.currency,
    currencyExponent: currencyExponent(session.restaurant.currency),
    recordedAt: correctedIso(),
    recordedAtDevice: deviceIso(),
    clockOffsetMs:
      offset === null
        ? null
        : Math.max(-2_592_000_000, Math.min(2_592_000_000, Math.round(offset))),
    sequence,
    provisionalNumber,
    kitchenDelivery,
  };
}

/** Never store a record the server's schema would refuse. */
export function validated<T extends OfflineRecordV3>(record: unknown): T {
  const parsed = offlineRecordV3.safeParse(record);
  if (!parsed.success) fail("offline_record_invalid");
  return parsed.data as T;
}

function isQuota(e: unknown) {
  const error = e as { name?: string; inner?: { name?: string } };
  return (
    error?.name === "QuotaExceededError" ||
    error?.inner?.name === "QuotaExceededError"
  );
}

/** One save transaction over pending, cache and drafts. */
export async function write<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await db.transaction("rw", db.pending, db.cache, db.drafts, fn);
  } catch (e) {
    if (isQuota(e)) fail("offline_storage_full");
    throw e;
  }
}

export function pendingRow(
  session: Session,
  body: OfflineRecordV3,
  receipt?: Pending["receipt"],
): Pending {
  return {
    id: body.operationId,
    scope: scope(session),
    kind: body.kind,
    sequence: body.sequence,
    body,
    ...(receipt ? { receipt } : {}),
    status: "pending",
    attempts: 0,
    nextAt: 0,
  };
}

export const deliveryFor = (autoPrint: boolean) =>
  autoPrint ? ("print_requested" as const) : ("device_list" as const);

/** A record id is written exactly once; a repeated click never replaces it. */
export async function insertOnce(row: Pending) {
  if (await db.pending.get(row.id)) fail("operation_conflict");
  await db.pending.add(row);
}

export async function deleteDraft(session: Session) {
  await db.drafts.delete(scope(session) + ":active");
}

export {
  allocateNumber,
  allocateSequence,
  devicePrefix,
  restaurantSnapshot,
  fail,
};

/** New order paid in full offline, by cash or an external terminal. */
export async function saveOfflineSale(
  ctx: SaveContext,
  input: {
    draft: OrderInput;
    priced: PricedLine[];
    total: number;
    payment: OfflinePaymentInput;
    operationId: string;
    autoPrint: boolean;
  },
): Promise<LocalReceipt> {
  check(ctx, true);
  checkLines(input.draft.lines);
  if (!(input.total > 0) || input.payment.amount !== input.total)
    fail("offline_amount_invalid");
  checkPayment(input.payment, input.total);
  const prefix = await devicePrefix(ctx.session);
  const snapshot = {
    lines: input.priced,
    restaurant: restaurantSnapshot(ctx.session),
  };
  const record = await write(async () => {
    const number = await allocateNumber(ctx.session, prefix);
    const sequence = await allocateSequence(ctx.session);
    const body = validated({
      ...recordBase(
        ctx.session,
        input.operationId,
        sequence,
        number,
        deliveryFor(input.autoPrint),
      ),
      kind: "sale",
      cashSessionId: ctx.cashSession!.id,
      order: input.draft,
      expectedTotal: input.total,
      payment: input.payment,
      receiptSnapshot: snapshot,
    });
    await insertOnce(pendingRow(ctx.session, body, snapshot));
    await deleteDraft(ctx.session);
    return body;
  });
  return {
    id: record.operationId,
    number: 0,
    version: 1,
    lines: input.priced.map((line) => ({ ...line, round: 1 })),
    total: input.total,
    paid: input.payment.amount,
    refunded: 0,
    state: "local",
    mode: input.draft.mode,
    tableId: input.draft.tableId,
    name: input.draft.name,
    note: input.draft.note,
    createdAt: record.recordedAt,
    rounds: [],
    tenders: [],
    restaurantSnapshot: restaurantSnapshot(ctx.session),
    offline: {
      provisionalNumber: record.provisionalNumber,
      soldAt: record.recordedAt,
      method: input.payment.method,
      reference: input.payment.reference,
    },
  };
}

const isV3 = (body: OfflineRecord): body is OfflineRecordV3 => "kind" in body;
export const pricedFrom = (row: Pending): PricedLine[] =>
  ((row.receipt?.lines ?? []) as PricedLine[]).filter(
    (line) => line && typeof line === "object" && "productId" in line,
  );

/** What a kitchen ticket says about a record (label, round, table, call name). */
export type TicketHeading = {
  label: string;
  round: number;
  mode: string;
  tableName: string | null;
  callName: string;
  orderNote: string;
};
type HeadingResolver = (
  row: Pending,
  rows: Pending[],
  tableName: (id: string | null) => string | null,
) => TicketHeading | null;
/** Per-kind ticket headings; the offline-tables series registers more kinds. */
export const ticketHeadings: Partial<Record<string, HeadingResolver>> = {
  sale: (row, _rows, tableName) => {
    const body = row.body as OfflineRecordV3 & { kind: "sale" };
    return {
      label: body.provisionalNumber ?? "—",
      round: 1,
      mode: body.order.mode,
      tableName: tableName(body.order.tableId),
      callName: body.order.name,
      orderNote: body.order.note,
    };
  },
};

/**
 * Kitchen tickets for records saved on this device since `sinceMs`: one per
 * station, made of that record's lines only. Newest first.
 */
export async function localKitchenTickets(
  session: Session,
  sinceMs: number,
  copy: { banner: string; footer: string; round: (n: number) => string },
  tables: { id: string; name: string }[] = [],
): Promise<LocalTicket[]> {
  const rows = (
    await db.pending.where("scope").equals(scope(session)).toArray()
  )
    .filter((row) => row.status !== "archived" && isV3(row.body))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const tableName = (id: string | null) =>
    tables.find((table) => table.id === id)?.name ?? null;
  const tickets: LocalTicket[] = [];
  for (const row of rows) {
    const body = row.body as OfflineRecordV3;
    const heading = ticketHeadings[body.kind]?.(row, rows, tableName);
    const createdAt = Date.parse(body.recordedAt);
    if (!heading || createdAt < sinceMs) continue;
    for (const ticket of ticketsFromLines({
      ...heading,
      label:
        heading.round > 1
          ? `${heading.label} · ${copy.round(heading.round)}`
          : heading.label,
      banner: copy.banner,
      footer: copy.footer,
      time: body.recordedAt,
      lines: pricedFrom(row),
    }))
      tickets.push({
        key: ticketKey(session, body.operationId, ticket.station),
        operationId: body.operationId,
        createdAt,
        ticket,
      });
  }
  return tickets.sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------------------
// Offline table service (wave contract §8.1): open orders, rounds and partial
// payments. Projections are display-only (I13); the server revalidates every
// record at sync.

export type LocalOrderView = Order & {
  offline: {
    provisionalNumber: string | null;
    soldAt: string;
    localOperationId: string | null;
    cachedAt: string | null;
    serverOrderId: string | null;
  };
};

type CachedOrder = {
  id: string;
  number: number;
  version: number;
  mode: string;
  tableId: string | null;
  tableName: string | null;
  name: string;
  note?: string;
  total: number;
  paid: number;
  state: string;
  createdAt: string;
  serviceVersion?: number;
  lines: {
    id: string;
    productId: string;
    round: number;
    quantity: number;
    name: { es: string; en: string };
    optionNames: { es: string; en: string }[];
    unitPrice: number;
    total: number;
    station: string;
    voidedQuantity: number;
  }[];
};

export const openOrdersKey = (s: Session) => `${scope(s)}:open-orders`;

async function cachedSnapshot(
  session: Session,
): Promise<{ refreshedAt: string | null; orders: CachedOrder[] }> {
  const value = (await db.cache.get(openOrdersKey(session)))?.value as
    { refreshedAt: string; orders: CachedOrder[] } | undefined;
  return value ?? { refreshedAt: null, orders: [] };
}

/** GET /offline/open-orders into the device cache (called while online). */
export async function refreshOpenOrders(session: Session): Promise<void> {
  const snapshot = await api<{ refreshedAt: string; orders: CachedOrder[] }>(
    "/offline/open-orders",
  );
  await db.cache.put({ id: openOrdersKey(session), value: snapshot });
}

async function scopedV3Rows(session: Session) {
  return (await db.pending.where("scope").equals(scope(session)).toArray())
    .filter((row) => row.status !== "archived" && isV3(row.body))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

const targetsLocal = (body: OfflineRecordV3, operationId: string) =>
  "target" in body &&
  "localOrderOperationId" in body.target &&
  body.target.localOrderOperationId === operationId;
const targetsServer = (body: OfflineRecordV3, orderId: string) =>
  "target" in body &&
  "orderId" in body.target &&
  body.target.orderId === orderId;

type SyncResult = { orderId?: string; orderNumber?: number };

/** Orders created on this device (Enviar or partial payment), with their local rounds and payments. */
async function localOrders(session: Session): Promise<LocalOrderView[]> {
  const rows = await scopedV3Rows(session);
  const cachedIds = new Set(
    (await cachedSnapshot(session)).orders.map((order) => order.id),
  );
  const views: LocalOrderView[] = [];
  for (const row of rows) {
    const body = row.body as OfflineRecordV3;
    if (body.kind !== "order") continue;
    const result = row.result as SyncResult | undefined;
    const serverId = result?.orderId ?? null;
    // Once a refreshed server snapshot carries the order, it lives there.
    if (serverId && cachedIds.has(serverId)) continue;
    const lines = pricedFrom(row).map((line) => ({ ...line, round: 1 }));
    let total = body.expectedTotal,
      paid = 0,
      round = 1;
    for (const child of rows) {
      const c = child.body as OfflineRecordV3;
      if (!targetsLocal(c, body.operationId)) continue;
      if (c.kind === "round") {
        round++;
        lines.push(...pricedFrom(child).map((line) => ({ ...line, round })));
        total += c.expectedTotal;
      } else if (c.kind === "payment") paid += c.payment.amount;
    }
    views.push({
      id: body.operationId,
      number: result?.orderNumber ?? 0,
      version: round,
      mode: body.order.mode,
      tableId: body.order.tableId,
      name: body.order.name,
      note: body.order.note,
      lines,
      total,
      paid,
      refunded: 0,
      state: "local_open",
      createdAt: body.recordedAt,
      rounds: [],
      tenders: [],
      restaurantSnapshot: row.receipt?.restaurant ?? null,
      offline: {
        provisionalNumber: body.provisionalNumber,
        soldAt: body.recordedAt,
        localOperationId: body.operationId,
        cachedAt: null,
        serverOrderId: serverId,
      },
    });
  }
  return views;
}

/** Local open orders that still have a balance. */
export async function localOpenOrders(
  session: Session,
): Promise<LocalOrderView[]> {
  return (await localOrders(session)).filter(
    (order) => order.total > order.paid,
  );
}

/**
 * Server open orders cached before the outage, plus this device's rounds and
 * payments for them. A row synced after the snapshot still counts, so a payment
 * that already reached the server never makes the order look unpaid again.
 */
export async function cachedServerOpenOrders(
  session: Session,
): Promise<{ refreshedAt: string | null; orders: LocalOrderView[] }> {
  const snapshot = await cachedSnapshot(session);
  const refreshedAt = snapshot.refreshedAt
    ? Date.parse(snapshot.refreshedAt)
    : 0;
  const rows = (await scopedV3Rows(session)).filter(
    (row) => row.status !== "synced" || (row.syncedAt ?? 0) > refreshedAt,
  );
  const orders = snapshot.orders.map((order): LocalOrderView => {
    const lines: PricedLine[] = order.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      quantity: line.quantity,
      options: [],
      note: "",
      name: line.name,
      optionNames: line.optionNames ?? [],
      unitPrice: line.unitPrice,
      total: line.total,
      cost: null,
      station: line.station,
      recipe: [],
      productVersion: 0,
      round: line.round,
      voidedUnits: Array.from(
        { length: Number(line.voidedQuantity) || 0 },
        (_, i) => i,
      ),
    }));
    let total = order.total,
      paid = order.paid,
      round = Math.max(0, ...order.lines.map((line) => line.round));
    for (const row of rows) {
      const body = row.body as OfflineRecordV3;
      if (!targetsServer(body, order.id)) continue;
      if (body.kind === "round") {
        round++;
        lines.push(...pricedFrom(row).map((line) => ({ ...line, round })));
        total += body.expectedTotal;
      } else if (body.kind === "payment") paid += body.payment.amount;
    }
    return {
      id: order.id,
      number: order.number,
      version: order.version,
      mode: order.mode,
      tableId: order.tableId,
      tableName: order.tableName,
      name: order.name,
      note: order.note ?? "",
      lines,
      total,
      paid,
      refunded: 0,
      state: order.state,
      createdAt: order.createdAt,
      serviceVersion: order.serviceVersion,
      rounds: [],
      tenders: [],
      offline: {
        provisionalNumber: null,
        soldAt: order.createdAt,
        localOperationId: null,
        cachedAt: snapshot.refreshedAt,
        serverOrderId: order.id,
      },
    };
  });
  return { refreshedAt: snapshot.refreshedAt, orders };
}

/** The sync target for an order shown in Selling. */
export function targetOf(order: {
  id: string;
  offline?: { localOperationId?: string | null } | null;
}): OrderTarget {
  return order.offline?.localOperationId
    ? { localOrderOperationId: order.offline.localOperationId }
    : { orderId: order.id };
}

/** True for an order created on this device that the server has not answered for yet. */
export const isLocalOrder = (order: Order | null): boolean =>
  order?.state === "local_open";

/** The current projection of one target order, if this device knows it. */
export async function findOpenOrder(
  session: Session,
  target: OrderTarget,
): Promise<LocalOrderView | null> {
  if ("localOrderOperationId" in target)
    return (
      (await localOrders(session)).find(
        (order) =>
          order.offline.localOperationId === target.localOrderOperationId,
      ) ?? null
    );
  return (
    (await cachedServerOpenOrders(session)).orders.find(
      (order) => order.id === target.orderId,
    ) ?? null
  );
}

async function targetNumber(target: OrderTarget): Promise<string | null> {
  if (!("localOrderOperationId" in target)) return null;
  const parent = await db.pending.get(target.localOrderOperationId);
  return parent && isV3(parent.body) ? parent.body.provisionalNumber : null;
}

/** Online payment attempts (active or parked) recorded for one server order. */
async function hasAttemptFor(session: Session, orderId: string) {
  const prefix = scope(session) + ":payment";
  const rows = await db.cache
    .filter((row) => row.id === prefix || row.id.startsWith(prefix + ":"))
    .toArray();
  return rows.some(
    (row) => (row.value as { orderId?: string } | null)?.orderId === orderId,
  );
}

/** "Enviar" offline: a new local open order (kitchen via print/device list). */
export async function saveOfflineOrder(
  ctx: SaveContext,
  input: {
    draft: OrderInput;
    priced: PricedLine[];
    total: number;
    operationId: string;
    autoPrint: boolean;
  },
): Promise<LocalOrderView> {
  check(ctx, false);
  checkLines(input.draft.lines);
  const prefix = await devicePrefix(ctx.session);
  const snapshot = {
    lines: input.priced,
    restaurant: restaurantSnapshot(ctx.session),
  };
  await write(async () => {
    const number = await allocateNumber(ctx.session, prefix);
    const sequence = await allocateSequence(ctx.session);
    const body = validated({
      ...recordBase(
        ctx.session,
        input.operationId,
        sequence,
        number,
        deliveryFor(input.autoPrint),
      ),
      kind: "order",
      cashSessionId: ctx.cashSession?.id ?? null,
      order: input.draft,
      expectedTotal: input.total,
      receiptSnapshot: snapshot,
    });
    await insertOnce(pendingRow(ctx.session, body, snapshot));
    await deleteDraft(ctx.session);
  });
  return (
    (await findOpenOrder(ctx.session, {
      localOrderOperationId: input.operationId,
    })) ?? fail("invalid_input")
  );
}

type RoundInput = {
  lines: LineInput[];
  priced: PricedLine[];
  total: number;
  operationId: string;
  autoPrint: boolean;
};

async function roundBody(
  ctx: SaveContext,
  target: OrderTarget,
  input: RoundInput,
  number: string | null,
) {
  const snapshot = {
    lines: input.priced,
    restaurant: restaurantSnapshot(ctx.session),
  };
  const body = validated({
    ...recordBase(
      ctx.session,
      input.operationId,
      await allocateSequence(ctx.session),
      number,
      deliveryFor(input.autoPrint),
    ),
    kind: "round",
    cashSessionId: ctx.cashSession?.id ?? null,
    target,
    lines: input.lines,
    expectedTotal: input.total,
    receiptSnapshot: snapshot,
  });
  return { body, snapshot };
}

/** Adds items to a local open order or to a server order cached before the outage. */
export async function saveOfflineRound(
  ctx: SaveContext,
  input: RoundInput & { target: OrderTarget },
): Promise<LocalOrderView> {
  check(ctx, false);
  checkLines(input.lines);
  if (!(await findOpenOrder(ctx.session, input.target))) fail("invalid_input");
  const number = await targetNumber(input.target);
  const target = await findOpenOrder(ctx.session, input.target);
  await write(async () => {
    const { body, snapshot } = await roundBody(
      ctx,
      input.target,
      input,
      number,
    );
    await insertOnce(
      withContext(pendingRow(ctx.session, body, snapshot), target),
    );
    await deleteDraft(ctx.session);
  });
  return (
    (await findOpenOrder(ctx.session, input.target)) ?? fail("invalid_input")
  );
}

/** Keeps the cached server order's heading on the row for its kitchen ticket. */
function withContext(row: Pending, order: LocalOrderView | null): Pending {
  return order && !order.offline.localOperationId
    ? {
        ...row,
        context: {
          orderNumber: order.number,
          mode: order.mode,
          tableName: order.tableName ?? null,
          name: order.name,
        },
      }
    : row;
}

/**
 * Payment of a local or cached order, with the round being added in the same
 * checkout written atomically, so a refused payment never leaves half a
 * checkout. Never more than the balance this device can see.
 */
export async function saveOfflinePayment(
  ctx: SaveContext,
  input: {
    target: OrderTarget;
    payment: OfflinePaymentInput;
    operationId: string;
    round?: RoundInput;
  },
): Promise<LocalReceipt> {
  check(ctx, true);
  if (
    "orderId" in input.target &&
    (await hasAttemptFor(ctx.session, input.target.orderId))
  )
    fail("offline_payment_pending_for_order");
  if (input.round) checkLines(input.round.lines);
  const current = await findOpenOrder(ctx.session, input.target);
  if (!current) fail("invalid_input");
  const due = current!.total - current!.paid + (input.round?.total ?? 0);
  checkPayment(input.payment, due);
  const number = await targetNumber(input.target);
  await write(async () => {
    if (input.round) {
      const { body, snapshot } = await roundBody(
        ctx,
        input.target,
        input.round,
        number,
      );
      await insertOnce(
        withContext(pendingRow(ctx.session, body, snapshot), current),
      );
    }
    const body = validated({
      ...recordBase(
        ctx.session,
        input.operationId,
        await allocateSequence(ctx.session),
        number,
        "not_applicable",
      ),
      kind: "payment",
      cashSessionId: ctx.cashSession!.id,
      target: input.target,
      expectedDue: due,
      payment: input.payment,
    });
    await insertOnce(pendingRow(ctx.session, body));
    await deleteDraft(ctx.session);
  });
  const after = (await findOpenOrder(ctx.session, input.target)) ?? current!;
  return {
    ...after,
    state: "local",
    offline: {
      ...after.offline,
      soldAt: correctedIso(),
      method: input.payment.method,
      reference: input.payment.reference,
    },
  };
}

/** New order paid in part: the order and its first payment, atomically. */
export async function saveOfflinePartial(
  ctx: SaveContext,
  input: {
    draft: OrderInput;
    priced: PricedLine[];
    total: number;
    payment: OfflinePaymentInput;
    orderOperationId: string;
    paymentOperationId: string;
    autoPrint: boolean;
  },
): Promise<LocalReceipt> {
  check(ctx, true);
  checkLines(input.draft.lines);
  if (input.payment.amount >= input.total) fail("invalid_amount");
  checkPayment(input.payment, input.total);
  const prefix = await devicePrefix(ctx.session);
  const snapshot = {
    lines: input.priced,
    restaurant: restaurantSnapshot(ctx.session),
  };
  await write(async () => {
    const provisional = await allocateNumber(ctx.session, prefix);
    const orderBody = validated({
      ...recordBase(
        ctx.session,
        input.orderOperationId,
        await allocateSequence(ctx.session),
        provisional,
        deliveryFor(input.autoPrint),
      ),
      kind: "order",
      cashSessionId: ctx.cashSession!.id,
      order: input.draft,
      expectedTotal: input.total,
      receiptSnapshot: snapshot,
    });
    await insertOnce(pendingRow(ctx.session, orderBody, snapshot));
    const paymentBody = validated({
      ...recordBase(
        ctx.session,
        input.paymentOperationId,
        await allocateSequence(ctx.session),
        provisional,
        "not_applicable",
      ),
      kind: "payment",
      cashSessionId: ctx.cashSession!.id,
      target: { localOrderOperationId: input.orderOperationId },
      expectedDue: input.total,
      payment: input.payment,
    });
    await insertOnce(pendingRow(ctx.session, paymentBody));
    await deleteDraft(ctx.session);
  });
  const view = await findOpenOrder(ctx.session, {
    localOrderOperationId: input.orderOperationId,
  });
  if (!view) fail("invalid_input");
  return {
    ...view!,
    state: "local",
    offline: {
      ...view!.offline,
      method: input.payment.method,
      reference: input.payment.reference,
    },
  };
}

ticketHeadings.order = (row, _rows, tableName) => {
  const body = row.body as OfflineRecordV3 & { kind: "order" };
  return {
    label: body.provisionalNumber ?? "—",
    round: 1,
    mode: body.order.mode,
    tableName: tableName(body.order.tableId),
    callName: body.order.name,
    orderNote: body.order.note,
  };
};
ticketHeadings.round = (row, rows, tableName) => {
  const body = row.body as OfflineRecordV3 & { kind: "round" };
  const earlier = rows.filter(
    (other) =>
      (other.sequence ?? 0) < (row.sequence ?? 0) &&
      isV3(other.body) &&
      other.body.kind === "round" &&
      JSON.stringify(other.body.target) === JSON.stringify(body.target),
  ).length;
  if ("localOrderOperationId" in body.target) {
    const parent = rows.find(
      (other) =>
        other.id ===
        (body.target as { localOrderOperationId: string })
          .localOrderOperationId,
    )?.body as (OfflineRecordV3 & { kind: "order" }) | undefined;
    return {
      label: body.provisionalNumber ?? parent?.provisionalNumber ?? "—",
      round: earlier + 2,
      mode: parent?.order.mode ?? "dine_in",
      tableName: tableName(parent?.order.tableId ?? null),
      callName: parent?.order.name ?? "",
      orderNote: "",
    };
  }
  return {
    label: `#${row.context?.orderNumber ?? "—"}`,
    round: earlier + 2,
    mode: row.context?.mode ?? "dine_in",
    tableName: row.context?.tableName ?? null,
    callName: row.context?.name ?? "",
    orderNote: "",
  };
};
