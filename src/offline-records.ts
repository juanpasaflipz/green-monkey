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
import {
  clockMovedBackSinceLastContact,
  getConnectivitySnapshot,
} from "./connectivity";
import { db, type Pending } from "./offline";
import {
  devicePrefix as deviceRowsPrefix,
  isAttemptKey,
  scope,
} from "./offline-keys";
import {
  acceptsOfflineRound,
  fallbackPrefix,
  formatProvisional,
  offlineWindow,
} from "./offline-policy";
import {
  hydrateOfflineSettings,
  offlineTableServiceOn,
} from "./offline-settings";
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
  // OFF-R24: the device clock went back while the app was closed; the window
  // cannot be trusted until a probe measures the server time again.
  if (clockMovedBackSinceLastContact()) return "offline_clock_moved_back";
  if (needsDrawer && (!cashSession || cashSession.closed_at))
    return "offline_drawer_missing";
  return null;
}

export function check(ctx: SaveContext, needsDrawer: boolean) {
  const reason = offlineBlockReason(ctx.session, ctx.cashSession, needsDrawer);
  if (reason) fail(reason);
}

/**
 * LD-7: open checks, rounds and partial payments offline are a per-restaurant
 * beta, off by default. With it off only new orders paid in full are saved.
 * The device's last known answer is loaded first, so an outage that started
 * before this page read it still honours it; an unknown value is off.
 */
export async function checkTableService(session: Session) {
  await hydrateOfflineSettings(session).catch(() => {});
  if (!offlineTableServiceOn(session)) fail("offline_table_service_off");
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

/** A server open order as this device keeps it for an outage. */
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
  /** Tenders this copy already contains. */
  tenderIds: string[];
  /** Offline records the server had applied to the order in this copy. */
  offlineOperationIds: string[];
  /** Device time this copy was stored; compared only with other device times. */
  receivedAt: number;
};
type OpenOrdersCache = {
  format: typeof OPEN_ORDERS_FORMAT;
  refreshedAt: string | null;
  orders: CachedOrder[];
};
/** Copies stored before applied-record lists existed are not trusted. */
const OPEN_ORDERS_FORMAT = 2;

export const openOrdersKey = (s: Session) => `${scope(s)}:open-orders`;

async function cachedSnapshot(session: Session): Promise<OpenOrdersCache> {
  const value = (await db.cache.get(openOrdersKey(session)))?.value as
    OpenOrdersCache | undefined;
  // An older cache cannot say which of this device's records it contains, so
  // it is never projected; the next refresh replaces it.
  return value?.format === OPEN_ORDERS_FORMAT
    ? value
    : { format: OPEN_ORDERS_FORMAT, refreshedAt: null, orders: [] };
}

const CLOSED_STATES = ["cancelled", "recovery_pending", "recovery_reviewed"];
/** The server's open-orders rule (openOrdersSnapshot in offline-tables.ts). */
const stillOpen = (order: Pick<CachedOrder, "state" | "total" | "paid">) =>
  !CLOSED_STATES.includes(order.state) &&
  (order.state !== "completed" || order.total > order.paid);

/** Server facts that only ever grow: rounds, tenders and voided units. */
const progress = (order: CachedOrder) => [
  order.version,
  order.tenderIds.length,
  order.lines.reduce((n, line) => n + (Number(line.voidedQuantity) || 0), 0),
];

/** True when copy `a` of an order was taken strictly after copy `b`. */
function newer(a: CachedOrder, b: CachedOrder) {
  const pa = progress(a),
    pb = progress(b);
  return pa.every((v, i) => v >= pb[i]!) && pa.some((v, i) => v > pb[i]!);
}

/**
 * The later of two copies of one order. An older copy never replaces a newer
 * one, whichever arrives last; the applied-record lists are merged because
 * the server only ever adds to them.
 */
function later(previous: CachedOrder | undefined, incoming: CachedOrder) {
  const keep = previous && newer(previous, incoming) ? previous : incoming;
  return {
    ...keep,
    offlineOperationIds: [
      ...new Set([
        ...(previous?.offlineOperationIds ?? []),
        ...incoming.offlineOperationIds,
      ]),
    ],
  };
}

async function storeOrders(
  session: Session,
  refreshedAt: string | null,
  orders: CachedOrder[],
) {
  orders.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  await db.cache.put({
    id: openOrdersKey(session),
    value: {
      format: OPEN_ORDERS_FORMAT,
      refreshedAt,
      orders,
    } satisfies OpenOrdersCache,
  });
}

/** GET /offline/open-orders into the device cache (called while online). */
export async function refreshOpenOrders(session: Session): Promise<void> {
  const requestedAt = Date.now();
  const snapshot = await api<{
    refreshedAt: string;
    orders: Omit<CachedOrder, "receivedAt">[];
  }>("/offline/open-orders");
  const receivedAt = Date.now();
  await db.transaction("rw", db.cache, async () => {
    const cache = await cachedSnapshot(session);
    const previous = new Map(cache.orders.map((order) => [order.id, order]));
    const listed = new Set<string>();
    const orders: CachedOrder[] = [];
    for (const order of snapshot.orders) {
      listed.add(order.id);
      orders.push(
        later(previous.get(order.id), {
          ...order,
          tenderIds: order.tenderIds ?? [],
          offlineOperationIds: order.offlineOperationIds ?? [],
          receivedAt,
        }),
      );
    }
    // Missing from the snapshot means closed on the server, unless Selling
    // stored this copy after the request left (the snapshot may predate it).
    for (const order of cache.orders)
      if (!listed.has(order.id) && order.receivedAt > requestedAt)
        orders.push(order);
    await storeOrders(session, snapshot.refreshedAt, orders);
  });
}

/** True for an order as the server returned it, not a device projection. */
export function isServerOrder(order: Order | null | undefined): order is Order {
  return (
    !!order &&
    order.state !== "local" &&
    order.state !== "local_open" &&
    !(order.offline && "cachedAt" in order.offline)
  );
}

function cachedFrom(order: Order, receivedAt: number): CachedOrder {
  return {
    id: order.id,
    number: order.number,
    version: order.version,
    mode: order.mode,
    tableId: order.tableId,
    tableName: order.tableName ?? null,
    name: order.name,
    note: order.note,
    total: order.total,
    paid: order.paid,
    state: order.state,
    createdAt: order.createdAt,
    serviceVersion: order.serviceVersion,
    lines: order.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      round: line.round ?? 1,
      quantity: line.quantity,
      name: line.name,
      optionNames: line.optionNames ?? [],
      unitPrice: line.unitPrice,
      total: line.total,
      station: line.station,
      voidedQuantity: line.voidedUnits?.length ?? 0,
    })),
    tenderIds: (order.tenders ?? []).map((tender: { id: string }) => tender.id),
    // A manager-reconciled offline payment is a tender whose source is the
    // record itself (OFF-R18): the copy already contains that record.
    offlineOperationIds: (order.tenders ?? [])
      .filter(
        (tender: { source?: string; source_id?: string | null }) =>
          tender.source === "offline_recovery" && !!tender.source_id,
      )
      .map((tender: { source_id: string }) => tender.source_id),
    receivedAt,
  };
}

/**
 * Remembers a server order Selling just received (send, round, payment,
 * resume), so the order on screen when an outage starts can still be served
 * offline with its current balance (OFF-R2). Kept even when it closed, so an
 * older snapshot arriving later cannot reopen it. Only while the restaurant
 * has offline table service on (LD-7): otherwise nothing uses the copy.
 */
export async function rememberOpenOrder(
  session: Session,
  order: Order,
): Promise<void> {
  if (!isServerOrder(order)) return;
  await hydrateOfflineSettings(session).catch(() => {});
  if (!offlineTableServiceOn(session)) return;
  const incoming = cachedFrom(order, Date.now());
  await db.transaction("rw", db.cache, async () => {
    const cache = await cachedSnapshot(session);
    const orders = cache.orders.filter((cached) => cached.id !== order.id);
    orders.push(
      later(
        cache.orders.find((cached) => cached.id === order.id),
        incoming,
      ),
    );
    await storeOrders(session, cache.refreshedAt, orders);
  });
}

/**
 * After an order, round or payment record syncs, the server order in its
 * result is the freshest copy there is: it is kept so the order stays
 * servable offline at its real balance, and so a synced local order is only
 * ever shown through its server copy (OFF-R12). Sales open no table check.
 */
export async function rememberSyncedOrder(
  session: Session,
  row: Pending,
  result: unknown,
): Promise<void> {
  if (!isV3(row.body) || row.body.kind === "sale") return;
  const order = (result as { order?: Order } | null)?.order;
  if (!order || typeof order !== "object" || typeof order.id !== "string")
    return;
  await rememberOpenOrder(session, order);
}

/**
 * The result to store on a row a manager reconciled (OFF-R18). The reconcile
 * route answers with the order; balances need the tender the reconcile made,
 * which carries the record's operationId as its source.
 */
export function reconciledResult(operationId: string, order: Order) {
  const tender = (order.tenders ?? []).find(
    (t: { source?: string; source_id?: string | null }) =>
      t.source === "offline_recovery" && t.source_id === operationId,
  ) as { id: string } | undefined;
  return {
    orderId: order.id,
    orderNumber: order.number,
    tenderId: tender?.id ?? null,
    roundNumber: null,
    order,
  };
}

async function scopedV3Rows(session: Session) {
  return (await db.pending.where("scope").equals(scope(session)).toArray())
    .filter((row) => row.status !== "archived" && isV3(row.body))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

/**
 * Every employee's records on this device. Money another employee collected
 * here (before a shift change) is still money the guest already paid.
 */
async function deviceV3Rows(session: Session) {
  return liveV3(await deviceRows(session)()).sort(
    (a, b) =>
      Date.parse(a.body.recordedAt) - Date.parse(b.body.recordedAt) ||
      (a.sequence ?? 0) - (b.sequence ?? 0),
  );
}

const targetsLocal = (body: OfflineRecordV3, operationId: string) =>
  "target" in body &&
  "localOrderOperationId" in body.target &&
  body.target.localOrderOperationId === operationId;

type SyncResult = {
  orderId?: string;
  orderNumber?: number;
  tenderId?: string | null;
  roundNumber?: number | null;
};
const resultOf = (row: Pending | undefined) =>
  (row?.result ?? null) as SyncResult | null;

/** The server order a round or payment targets, when this device knows it. */
function serverTargetOf(
  body: OfflineRecordV3,
  rows: Map<string, Pending>,
): string | null {
  if (!("target" in body)) return null;
  if ("orderId" in body.target) return body.target.orderId;
  const parent = rows.get(body.target.localOrderOperationId);
  return parent?.status === "synced"
    ? (resultOf(parent)?.orderId ?? null)
    : null;
}

/**
 * True when a server copy already contains this record: the copy lists it as
 * applied, or it synced and its tender or round is in the copy. Never decided
 * by comparing the device clock with the server clock (OFF-R3).
 */
function reflected(order: CachedOrder, row: Pending): boolean {
  if (order.offlineOperationIds.includes(row.id)) return true;
  const result = row.status === "synced" ? resultOf(row) : null;
  if (!result || (result.orderId && result.orderId !== order.id)) return false;
  const body = row.body as OfflineRecordV3;
  if (body.kind === "payment")
    return !!result.tenderId && order.tenderIds.includes(result.tenderId);
  if (body.kind === "round")
    return order.lines.some((line) => line.round === result.roundNumber);
  return false;
}

/** Table names cached while online, for offline views and tickets. */
export async function cachedTableName(
  session: Session,
): Promise<(id: string | null) => string | null> {
  const tables =
    ((await db.cache.get(tablesKey(session)))?.value as
      { id: string; name: string }[] | undefined) ?? [];
  return (id) => (id && tables.find((table) => table.id === id)?.name) || null;
}

/**
 * Orders created on this device (Enviar or partial payment) that the server
 * does not have yet, with their local rounds and payments.
 *
 * Once an order record has synced, the server owns the order (OFF-R12): it is
 * only ever served through a cached server copy, never rebuilt from local
 * records. A copy that was paid or closed online drops out of the open-orders
 * cache, so the order can no longer take an offline round or payment.
 */
async function localOrders(session: Session): Promise<LocalOrderView[]> {
  const rows = await scopedV3Rows(session);
  const tableName = await cachedTableName(session);
  const views: LocalOrderView[] = [];
  for (const row of rows) {
    const body = row.body as OfflineRecordV3;
    if (body.kind !== "order" || row.status === "synced") continue;
    const result = resultOf(row);
    const serverId = result?.orderId ?? null;
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
      tableName: tableName(body.order.tableId),
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
 * payments the cached copy does not contain yet (including those that target
 * a local order now synced into it). Exact whatever the device clock says: a
 * record counts unless the copy itself shows it (OFF-R3).
 */
export async function cachedServerOpenOrders(
  session: Session,
): Promise<{ refreshedAt: string | null; orders: LocalOrderView[] }> {
  const snapshot = await cachedSnapshot(session);
  const rows = await deviceV3Rows(session);
  const byId = new Map(rows.map((row) => [row.id, row]));
  // A server order that began as a local order here keeps its provisional
  // number next to the server one ("B-07 → #142", §2.4).
  const provisional = new Map<string, string>();
  for (const row of rows) {
    const body = row.body as OfflineRecordV3;
    const orderId = row.status === "synced" ? resultOf(row)?.orderId : null;
    if (body.kind === "order" && orderId && body.provisionalNumber)
      provisional.set(orderId, body.provisionalNumber);
  }
  const orders = snapshot.orders.filter(stillOpen).map((order) => {
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
      if (body.kind !== "round" && body.kind !== "payment") continue;
      if (serverTargetOf(body, byId) !== order.id || reflected(order, row))
        continue;
      if (body.kind === "round") {
        round++;
        lines.push(...pricedFrom(row).map((line) => ({ ...line, round })));
        total += body.expectedTotal;
      } else paid += body.payment.amount;
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
        provisionalNumber: provisional.get(order.id) ?? null,
        soldAt: order.createdAt,
        localOperationId: null,
        cachedAt: snapshot.refreshedAt,
        serverOrderId: order.id,
      },
    } satisfies LocalOrderView;
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
  let orderId: string | null;
  if ("localOrderOperationId" in target) {
    const local = (await localOrders(session)).find(
      (order) =>
        order.offline.localOperationId === target.localOrderOperationId,
    );
    if (local) return local;
    // Its order record synced: the server owns the order (OFF-R12). It is
    // served only through a cached server copy (the record keeps its local
    // target, I5); without one it is not servable offline.
    const parent = await db.pending.get(target.localOrderOperationId);
    orderId =
      parent?.status === "synced" ? (resultOf(parent)?.orderId ?? null) : null;
    if (!orderId) return null;
  } else orderId = target.orderId;
  return (
    (await cachedServerOpenOrders(session)).orders.find(
      (order) => order.id === orderId,
    ) ?? null
  );
}

async function targetNumber(target: OrderTarget): Promise<string | null> {
  if (!("localOrderOperationId" in target)) return null;
  const parent = await db.pending.get(target.localOrderOperationId);
  return parent && isV3(parent.body) ? parent.body.provisionalNumber : null;
}

/** Online payment attempts (active or parked) on this device for one server order. */
async function hasAttemptFor(session: Session, orderId: string) {
  const rows = await db.cache
    .where("id")
    .startsWith(deviceRowsPrefix(session))
    .filter((row) => isAttemptKey(row.id))
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
  await checkTableService(ctx.session);
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
    })) ?? fail("offline_record_invalid")
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
  await checkTableService(ctx.session);
  checkLines(input.lines);
  const target = await findOpenOrder(ctx.session, input.target);
  if (!target) return fail("offline_order_not_cached");
  // §2.3: a check with no balance left is paid (or closed, or ticketed after
  // fiscal); its round would fail at sync. The items go on a new order.
  if (!acceptsOfflineRound(target)) fail("offline_check_paid");
  const number = await targetNumber(input.target);
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
    (await findOpenOrder(ctx.session, input.target)) ??
    fail("offline_order_not_cached")
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
 * checkout. Never more than the balance this device can see, and never while
 * an online attempt for the same order is unresolved (I9).
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
  await checkTableService(ctx.session);
  if (input.round) checkLines(input.round.lines);
  const found = await findOpenOrder(ctx.session, input.target);
  if (!found) return fail("offline_order_not_cached");
  const current = found;
  // The round written in the same checkout follows the round rule (§2.3).
  if (input.round && !acceptsOfflineRound(current)) fail("offline_check_paid");
  const serverId =
    "orderId" in input.target
      ? input.target.orderId
      : current.offline.serverOrderId;
  if (serverId && (await hasAttemptFor(ctx.session, serverId)))
    fail("offline_payment_pending_for_order");
  const due = current.total - current.paid + (input.round?.total ?? 0);
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
  const after = (await findOpenOrder(ctx.session, input.target)) ?? current;
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
  await checkTableService(ctx.session);
  checkLines(input.draft.lines);
  if (input.payment.amount >= input.total) fail("offline_amount_invalid");
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
  if (!view) return fail("offline_record_invalid");
  return {
    ...view,
    state: "local",
    offline: {
      ...view.offline,
      method: input.payment.method,
      reference: input.payment.reference,
    },
  };
}

/** Payment values with the same names as service's PaymentValues (§4.8). */
export type OfflinePaymentValues = {
  amount: number;
  tip: number;
  received: number;
  method: "cash" | "external";
  reference: string;
  confirmed: boolean;
};

/** The order to keep selling against after a partial offline payment. */
function openView(receipt: LocalReceipt, state: string): LocalOrderView | null {
  if (receipt.paid >= receipt.total) return null;
  return {
    ...receipt,
    state,
    offline: {
      provisionalNumber: receipt.offline.provisionalNumber,
      soldAt: receipt.offline.soldAt,
      localOperationId: receipt.offline.localOperationId ?? null,
      cachedAt: receipt.offline.cachedAt ?? null,
      serverOrderId: receipt.offline.serverOrderId ?? null,
    },
  };
}

/**
 * Saves an offline checkout (§2.3): a new order paid in full (sale) or in part
 * (order + payment), or a payment of the current local or cached order with
 * the draft's items as a round in the same transaction. Item split is never
 * available offline (I8). Returns the records to print and the order to keep
 * selling against when a balance remains.
 */
export async function saveOfflineCheckout(
  ctx: SaveContext,
  values: OfflinePaymentValues,
  cart: {
    draft: OrderInput;
    priced: PricedLine[];
    total: number;
    current: Order | null;
    operationId: string;
    orderOperationId: string;
    autoPrint: boolean;
  },
  items?: string[],
): Promise<{
  receipt: LocalReceipt;
  operationIds: string[];
  view: LocalOrderView | null;
}> {
  if (items) fail("offline_split_unavailable");
  const payment = {
    method: values.method,
    amount: values.amount,
    tip: values.tip,
    received:
      values.method === "external"
        ? values.amount + values.tip
        : values.received,
    reference: values.method === "external" ? values.reference.trim() : "",
    externalConfirmed: values.method === "external" && values.confirmed,
  };
  if (cart.current) {
    const roundId = crypto.randomUUID();
    const receipt = await saveOfflinePayment(ctx, {
      target: targetOf(cart.current as LocalOrderView),
      payment,
      operationId: cart.operationId,
      round: cart.draft.lines.length
        ? {
            lines: cart.draft.lines,
            priced: cart.priced,
            total: cart.total,
            operationId: roundId,
            autoPrint: cart.autoPrint,
          }
        : undefined,
    });
    return {
      receipt,
      operationIds: cart.draft.lines.length ? [roundId] : [],
      view: openView(receipt, cart.current.state),
    };
  }
  if (values.amount > cart.total) fail("offline_amount_exceeds_due");
  if (values.amount < cart.total) {
    const receipt = await saveOfflinePartial(ctx, {
      draft: cart.draft,
      priced: cart.priced,
      total: cart.total,
      payment,
      orderOperationId: cart.orderOperationId,
      paymentOperationId: cart.operationId,
      autoPrint: cart.autoPrint,
    });
    return {
      receipt,
      operationIds: [cart.orderOperationId],
      view: openView(receipt, "local_open"),
    };
  }
  const receipt = await saveOfflineSale(ctx, {
    draft: cart.draft,
    priced: cart.priced,
    total: cart.total,
    operationId: cart.operationId,
    autoPrint: cart.autoPrint,
    payment,
  });
  return { receipt, operationIds: [receipt.id], view: null };
}

/** Every row of this device, as one direct Dexie query (a liveQuery querier). */
export const deviceRows = (session: Session) => () =>
  db.pending.where("scope").startsWith(deviceRowsPrefix(session)).toArray();

const liveV3 = (rows: Pending[]) =>
  rows.filter((row) => row.status !== "archived" && isV3(row.body));

/** The server order behind an order on screen, when this device knows it. */
function serverIdOf(order: Order, rows: Map<string, Pending>): string | null {
  if (isServerOrder(order)) return order.id;
  const view = order as LocalOrderView;
  if (view.offline?.localOperationId) {
    const parent = rows.get(view.offline.localOperationId);
    return parent?.status === "synced"
      ? (resultOf(parent)?.orderId ?? null)
      : null;
  }
  return view.offline?.serverOrderId ?? null;
}

/** Guard codes after which syncing this device's records now may clear the way. */
export const SYNC_TO_CHARGE_CODES = [
  "offline_payment_pending_for_order",
  "offline_round_pending_for_order",
  "offline_round_review_for_order",
];

/**
 * Online charge guard: the server balance is only the whole bill once it
 * contains every record this device (any employee) saved offline for the
 * order. Blocks, until those records sync or a manager resolves them:
 * - an unresolved payment (pending, syncing or in review): the server balance
 *   lacks it, so charging it could charge the guest twice (OFF-R5);
 * - an unresolved round: the server balance lacks its items, so the guest
 *   would never be charged for them and the round, refused later on a paid
 *   check, could only be archived (OFF-R26). A round in review needs a
 *   manager first. Another employee's round syncs only in that employee's
 *   session (E2), so it is named as such: syncing now cannot clear it;
 * - a server order on screen without one of this device's synced rounds: it
 *   is being read again, and its amount was taken from the old total.
 */
export async function assertNoUnsyncedRecords(
  session: Session,
  order: Order | null,
): Promise<void> {
  if (!order) return;
  const rows = liveV3(await deviceRows(session)());
  const byId = new Map(rows.map((row) => [row.id, row]));
  const orderId = serverIdOf(order, byId);
  if (!orderId) return;
  const forOrder = rows.filter((row) => {
    const body = row.body as OfflineRecordV3;
    return (
      (body.kind === "payment" || body.kind === "round") &&
      serverTargetOf(body, byId) === orderId
    );
  });
  const kindOf = (row: Pending) => (row.body as OfflineRecordV3).kind;
  if (
    forOrder.some((row) => kindOf(row) === "payment" && row.status !== "synced")
  )
    fail("offline_payment_pending_for_order");
  const rounds = forOrder.filter((row) => kindOf(row) === "round");
  if (rounds.some((row) => row.status === "conflict"))
    fail("offline_round_review_for_order");
  const unsynced = rounds.filter((row) => row.status !== "synced");
  if (unsynced.some((row) => row.scope === scope(session)))
    fail("offline_round_pending_for_order");
  if (unsynced.length) fail("offline_round_other_employee_for_order");
  if (
    isServerOrder(order) &&
    rounds.some((row) => {
      const result = resultOf(row);
      return (
        typeof result?.roundNumber === "number" &&
        (!result.orderId || result.orderId === order.id) &&
        !order.lines.some((line) => (line.round ?? 1) === result.roundNumber)
      );
    })
  )
    fail("offline_order_outdated");
}

/**
 * How an order on screen relates to this device's records (I13, OFF-R5): the
 * server order it corresponds to, and whether the copy on screen is stale. A
 * projection is always stale once its server order is known; a server order is
 * stale when one of this device's synced rounds or payments for it is missing
 * from it. Pure, so a liveQuery can run it on the rows it observed.
 */
export function linkFromRows(
  order: Order,
  rowsOfDevice: Pending[],
): { orderId: string | null; stale: boolean } {
  const rows = liveV3(rowsOfDevice);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const orderId = serverIdOf(order, byId);
  if (!orderId) return { orderId: null, stale: false };
  if (!isServerOrder(order)) return { orderId, stale: true };
  const copy = cachedFrom(order, 0);
  const stale = rows.some((row) => {
    const body = row.body as OfflineRecordV3;
    return (
      row.status === "synced" &&
      !!resultOf(row) &&
      (body.kind === "round" || body.kind === "payment") &&
      serverTargetOf(body, byId) === orderId &&
      !reflected(copy, row)
    );
  });
  return { orderId, stale };
}

/**
 * The records of this device whose kitchen tickets belong to an order on
 * screen (§2.5, "Imprimir comanda" on an order view): a local order's own
 * record and its rounds, or the rounds saved here for a cached server order.
 */
export async function orderTicketIds(
  session: Session,
  order: Order,
): Promise<string[]> {
  const rows = liveV3(await deviceRows(session)());
  const byId = new Map(rows.map((row) => [row.id, row]));
  const view = order as LocalOrderView;
  const local = view.offline?.localOperationId ?? null;
  const serverId = isServerOrder(order)
    ? order.id
    : (view.offline?.serverOrderId ?? null);
  return rows
    .filter((row) => {
      const body = row.body as OfflineRecordV3;
      if (body.kind === "order")
        return (
          body.operationId === local ||
          (!!serverId &&
            row.status === "synced" &&
            resultOf(row)?.orderId === serverId)
        );
      if (body.kind !== "round") return false;
      if (local && targetsLocal(body, local)) return true;
      return !!serverId && serverTargetOf(body, byId) === serverId;
    })
    .map((row) => row.id);
}

/** linkFromRows over the rows stored now. */
export async function serverLink(session: Session, order: Order) {
  return linkFromRows(order, await deviceRows(session)());
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
