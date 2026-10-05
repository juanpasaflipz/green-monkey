/**
 * Offline table service against an in-memory store (wave contract §8.1):
 * preconditions of every builder (I8, I9, I14), local orders paid while online
 * (I13), atomic checkouts, and the display projections that decide what staff
 * still collect (OFF-R2, OFF-R3, OFF-R5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order, Session } from "../shared/domain";
import { fakeDb } from "./offline-fake-db";

vi.mock("../src/offline", async () => ({
  db: (await import("./offline-fake-db")).fakeDb,
}));
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  api: vi.fn(),
}));

import { api } from "../src/api";
import { syncPending } from "../src/offline-queue";
import { resetConnectivityForTests } from "../src/connectivity";
import { scope } from "../src/offline-keys";
import {
  OfflineSaveError,
  assertNoUnsyncedPayment,
  cachedServerOpenOrders,
  findOpenOrder,
  isLocalOrder,
  localOpenOrders,
  refreshOpenOrders,
  rememberOpenOrder,
  saveOfflineCheckout,
  saveOfflineOrder,
  saveOfflinePartial,
  saveOfflinePayment,
  saveOfflineRound,
  serverLink,
  type LocalOrderView,
  type SaveContext,
} from "../src/offline-records";

const mockedApi = vi.mocked(api);
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function session(over: Partial<Session> = {}): Session {
  return {
    id: uuid(1),
    tenantId: uuid(2),
    employeeId: uuid(3),
    deviceId: uuid(4),
    name: "Caja",
    role: "cashier",
    expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    offlineUntil: new Date(Date.now() + 3_600_000).toISOString(),
    offlineLeaseVersion: 1,
    offlineLeaseConfigVersion: 3,
    csrf: "csrf",
    restaurant: {
      name: "Fixture",
      currency: "MXN",
      timezone: "America/Mexico_City",
      cutoff: 240,
      configVersion: 3,
    },
    ...over,
  };
}
const drawer = { id: uuid(9), closed_at: null };
const ctxOf = (s: Session, cashSession: SaveContext["cashSession"] = drawer) =>
  ({ session: s, catalog: [], cashSession }) satisfies SaveContext;
let lineCount = 0;
const line = (quantity = 1) => ({
  id: crypto.randomUUID(),
  productId: uuid(200 + ++lineCount),
  quantity,
  options: [],
  note: "",
});
const priced = (l: ReturnType<typeof line>, unitPrice: number) => ({
  ...l,
  name: { es: "Taco", en: "Taco" },
  optionNames: [],
  unitPrice,
  total: unitPrice * l.quantity,
  cost: null,
  station: "kitchen",
  recipe: [],
  productVersion: 1,
});
const draft = (lines: ReturnType<typeof line>[]) => ({
  operationId: crypto.randomUUID(),
  lines,
  mode: "dine_in" as const,
  tableId: null,
  name: "Mesa 3",
  note: "",
  channel: "pos" as const,
});
const cash = (amount: number, received = amount) => ({
  method: "cash" as const,
  amount,
  tip: 0,
  received,
  reference: "",
  externalConfirmed: false,
});
const values = (amount: number) => ({
  amount,
  tip: 0,
  received: amount,
  method: "cash" as const,
  reference: "",
  confirmed: false,
});

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: Error) => e,
  );
  expect(error).toBeInstanceOf(OfflineSaveError);
  return error!.message;
}

/** "Enviar" offline: a local open order of one line at `price`. */
async function localOrder(s: Session, price = 250) {
  const l = line();
  return saveOfflineOrder(ctxOf(s), {
    draft: draft([l]),
    priced: [priced(l, price)],
    total: price,
    operationId: crypto.randomUUID(),
    autoPrint: false,
  });
}

/** A round input of one line at `price`. */
function roundInput(price: number) {
  const l = line();
  return {
    lines: [l],
    priced: [priced(l, price)],
    total: price,
    operationId: crypto.randomUUID(),
    autoPrint: false,
  };
}

/** A server open order as GET /offline/open-orders returns it. */
function serverCopy(
  id: string,
  over: Partial<{
    version: number;
    total: number;
    paid: number;
    state: string;
    tenderIds: string[];
    offlineOperationIds: string[];
    rounds: number[];
  }> = {},
) {
  const rounds = over.rounds ?? [1];
  return {
    id,
    number: 42,
    version: over.version ?? rounds.length,
    mode: "dine_in",
    tableId: null,
    tableName: "Mesa 03",
    name: "Mesa 3",
    note: "",
    total: over.total ?? 250,
    paid: over.paid ?? 0,
    state: over.state ?? "active",
    createdAt: new Date().toISOString(),
    serviceVersion: 1,
    lines: rounds.map((round) => ({
      id: crypto.randomUUID(),
      productId: uuid(300 + round),
      round,
      quantity: 1,
      name: { es: "Taco", en: "Taco" },
      optionNames: [],
      unitPrice: 100,
      total: 100,
      station: "kitchen",
      voidedQuantity: 0,
    })),
    tenderIds: over.tenderIds ?? [],
    offlineOperationIds: over.offlineOperationIds ?? [],
  };
}

/** Caches a server snapshot through the real refresh path. */
async function cacheSnapshot(
  s: Session,
  orders: ReturnType<typeof serverCopy>[],
  refreshedAt = new Date().toISOString(),
) {
  mockedApi.mockResolvedValueOnce({ refreshedAt, orders });
  await refreshOpenOrders(s);
}

/** A server Order as GET /orders/:id returns it. */
function serverOrder(
  id: string,
  over: { paid?: number; tenders?: string[]; rounds?: number[] } = {},
): Order {
  const copy = serverCopy(id, {
    paid: over.paid,
    tenderIds: over.tenders,
    rounds: over.rounds,
  });
  return {
    ...copy,
    refunded: 0,
    rounds: [],
    tenders: (over.tenders ?? []).map((tenderId) => ({ id: tenderId })),
    lines: copy.lines.map((l) => ({
      ...l,
      options: [],
      note: "",
      cost: null,
      recipe: [],
      productVersion: 1,
      voidedUnits: [],
    })),
    offline: null,
  };
}

const markSynced = (id: string, result: Record<string, unknown>, at: number) =>
  fakeDb.pending.update(id, { status: "synced", result, syncedAt: at });

beforeEach(() => {
  fakeDb.reset();
  mockedApi.mockReset();
  resetConnectivityForTests();
});
afterEach(() => {
  vi.useRealTimers();
  resetConnectivityForTests();
});

describe("table-service preconditions", () => {
  it("I14: no order, round, payment or partial save after offlineUntil (server clock)", async () => {
    const s = session();
    const open = await localOrder(s);
    const cached = uuid(70);
    await cacheSnapshot(s, [serverCopy(cached)]);
    const before = fakeDb.pending.rows.size;
    // 60 s left by the device clock, but the server is 2 min ahead.
    const expired = {
      ...s,
      offlineUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    resetConnectivityForTests({}, 120_000);
    const l = line();
    const saves = [
      saveOfflineOrder(ctxOf(expired), {
        draft: draft([l]),
        priced: [priced(l, 100)],
        total: 100,
        operationId: crypto.randomUUID(),
        autoPrint: false,
      }),
      saveOfflineRound(ctxOf(expired), {
        target: { localOrderOperationId: open.id },
        ...roundInput(100),
      }),
      saveOfflineRound(ctxOf(expired), {
        target: { orderId: cached },
        ...roundInput(100),
      }),
      saveOfflinePayment(ctxOf(expired), {
        target: { orderId: cached },
        payment: cash(100),
        operationId: crypto.randomUUID(),
      }),
      saveOfflinePartial(ctxOf(expired), {
        draft: draft([l]),
        priced: [priced(l, 100)],
        total: 100,
        payment: cash(40),
        orderOperationId: crypto.randomUUID(),
        paymentOperationId: crypto.randomUUID(),
        autoPrint: false,
      }),
      saveOfflineCheckout(ctxOf(expired), values(100), {
        draft: draft([l]),
        priced: [priced(l, 100)],
        total: 100,
        current: null,
        operationId: crypto.randomUUID(),
        orderOperationId: crypto.randomUUID(),
        autoPrint: false,
      }),
    ];
    for (const save of saves)
      expect(await refusal(save)).toBe("offline_window_expired");
    expect(fakeDb.pending.rows.size).toBe(before);
  });

  it("offline_drawer_missing for payments; Enviar and rounds need no drawer", async () => {
    const s = session();
    const noDrawer = ctxOf(s, null);
    const l = line();
    const open = await saveOfflineOrder(noDrawer, {
      draft: draft([l]),
      priced: [priced(l, 100)],
      total: 100,
      operationId: crypto.randomUUID(),
      autoPrint: false,
    });
    await saveOfflineRound(noDrawer, {
      target: { localOrderOperationId: open.id },
      ...roundInput(50),
    });
    expect(
      await refusal(
        saveOfflinePayment(noDrawer, {
          target: { localOrderOperationId: open.id },
          payment: cash(50),
          operationId: crypto.randomUUID(),
        }),
      ),
    ).toBe("offline_drawer_missing");
    expect(
      await refusal(
        saveOfflinePartial(noDrawer, {
          draft: draft([l]),
          priced: [priced(l, 100)],
          total: 100,
          payment: cash(40),
          orderOperationId: crypto.randomUUID(),
          paymentOperationId: crypto.randomUUID(),
          autoPrint: false,
        }),
      ),
    ).toBe("offline_drawer_missing");
    expect(fakeDb.pending.rows.size).toBe(2);
  });

  it("I9: an unresolved online attempt for the same order blocks an offline payment, on this device only for that order", async () => {
    const s = session();
    const [blocked, parked, other, free] = [71, 72, 73, 74].map(uuid);
    await cacheSnapshot(
      s,
      [blocked, parked, other, free].map((id) => serverCopy(id!)),
    );
    // Active attempt of this employee, a parked one, and one left by another
    // employee on this device before a shift change.
    await fakeDb.cache.put({
      id: `${scope(s)}:payment`,
      value: { orderId: blocked },
    });
    await fakeDb.cache.put({
      id: `${scope(s)}:payment:${uuid(80)}`,
      value: { orderId: parked },
    });
    await fakeDb.cache.put({
      id: `${s.tenantId}:${s.deviceId}:${uuid(99)}:payment`,
      value: { orderId: other },
    });
    for (const orderId of [blocked, parked, other])
      expect(
        await refusal(
          saveOfflinePayment(ctxOf(s), {
            target: { orderId: orderId! },
            payment: cash(100),
            operationId: crypto.randomUUID(),
          }),
        ),
      ).toBe("offline_payment_pending_for_order");
    expect(fakeDb.pending.rows.size).toBe(0);
    await expect(
      saveOfflinePayment(ctxOf(s), {
        target: { orderId: free! },
        payment: cash(100),
        operationId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ state: "local", paid: 100 });
  });

  it("I8: item split is never available offline", async () => {
    const s = session();
    const open = await localOrder(s);
    const rows = fakeDb.pending.rows.size;
    expect(
      await refusal(
        saveOfflineCheckout(
          ctxOf(s),
          values(100),
          {
            draft: draft([]),
            priced: [],
            total: 0,
            current: open,
            operationId: crypto.randomUUID(),
            orderOperationId: crypto.randomUUID(),
            autoPrint: false,
          },
          ["unit-1"],
        ),
      ),
    ).toBe("offline_split_unavailable");
    expect(fakeDb.pending.rows.size).toBe(rows);
  });

  it("an amount above the balance this device sees is refused", async () => {
    const s = session();
    const open = await localOrder(s, 250);
    expect(
      await refusal(
        saveOfflinePayment(ctxOf(s), {
          target: { localOrderOperationId: open.id },
          payment: cash(251),
          operationId: crypto.randomUUID(),
        }),
      ),
    ).toBe("offline_amount_exceeds_due");
    const l = line();
    expect(
      await refusal(
        saveOfflineCheckout(ctxOf(s), values(101), {
          draft: draft([l]),
          priced: [priced(l, 100)],
          total: 100,
          current: null,
          operationId: crypto.randomUUID(),
          orderOperationId: crypto.randomUUID(),
          autoPrint: false,
        }),
      ),
    ).toBe("offline_amount_exceeds_due");
    expect(
      await refusal(
        saveOfflinePayment(ctxOf(s), {
          target: { orderId: uuid(77) },
          payment: cash(10),
          operationId: crypto.randomUUID(),
        }),
      ),
    ).toBe("offline_order_not_cached");
  });

  it("a refused payment leaves no half checkout: its round is rolled back", async () => {
    const s = session();
    const open = await localOrder(s);
    const paymentId = crypto.randomUUID();
    await saveOfflinePayment(ctxOf(s), {
      target: { localOrderOperationId: open.id },
      payment: cash(50),
      operationId: paymentId,
    });
    const rows = fakeDb.pending.rows.size;
    // Same payment id again (a repeated click), now with a round to add.
    expect(
      await refusal(
        saveOfflinePayment(ctxOf(s), {
          target: { localOrderOperationId: open.id },
          payment: cash(50),
          operationId: paymentId,
          round: roundInput(80),
        }),
      ),
    ).toBe("operation_conflict");
    expect(fakeDb.pending.rows.size).toBe(rows);
    expect(
      (await findOpenOrder(s, { localOrderOperationId: open.id }))!,
    ).toMatchObject({ total: 250, paid: 50 });
  });
});

describe("I13: local orders", () => {
  it("a local order paid while online goes through records and then follows its server order", async () => {
    const s = session();
    const open = await localOrder(s, 250);
    expect(isLocalOrder(open)).toBe(true);
    // The device is online (connectivity default), yet nothing is sent.
    const paymentId = crypto.randomUUID();
    const paid = await saveOfflineCheckout(ctxOf(s), values(100), {
      draft: draft([]),
      priced: [],
      total: 0,
      current: open,
      operationId: paymentId,
      orderOperationId: crypto.randomUUID(),
      autoPrint: false,
    });
    expect(mockedApi).not.toHaveBeenCalled();
    const payment = (await fakeDb.pending.get(paymentId))!;
    expect(payment.body).toMatchObject({
      kind: "payment",
      target: { localOrderOperationId: open.id },
    });
    expect(paid.view).toMatchObject({
      total: 250,
      paid: 100,
      state: "local_open",
    });
    // Before the server knows it, Selling keeps the projection.
    expect(await serverLink(s, paid.view!)).toEqual({
      orderId: null,
      stale: false,
    });
    // The order record syncs: Selling must switch to the server order.
    const serverId = uuid(60);
    await markSynced(
      open.id,
      { orderId: serverId, orderNumber: 42 },
      Date.now(),
    );
    expect(await serverLink(s, paid.view!)).toEqual({
      orderId: serverId,
      stale: true,
    });
    // The payment syncs too, and the server copy shows its tender.
    await markSynced(
      payment.id,
      { orderId: serverId, tenderId: uuid(61) },
      Date.now(),
    );
    await cacheSnapshot(s, [
      serverCopy(serverId, {
        paid: 100,
        tenderIds: [uuid(61)],
        offlineOperationIds: [open.id, payment.id],
      }),
    ]);
    expect(await localOpenOrders(s)).toEqual([]);
    const view = await findOpenOrder(s, { localOrderOperationId: open.id });
    expect(view).toMatchObject({ id: serverId, total: 250, paid: 100 });
    expect(
      await serverLink(
        s,
        serverOrder(serverId, { paid: 100, tenders: [uuid(61)] }),
      ),
    ).toEqual({ orderId: serverId, stale: false });
  });
});

describe("projections (OFF-R3)", () => {
  it("count each synced payment once whatever the device clock says (±3 min)", async () => {
    const s = session();
    const order = uuid(62);
    const refreshedAt = Date.now();
    for (const skew of [-180_000, 180_000]) {
      fakeDb.reset();
      // A payment the snapshot already contains, one that synced after it,
      // and one still queued.
      const ids = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      for (const [i, id] of ids.entries())
        await fakeDb.pending.put({
          id,
          scope: scope(s),
          kind: "payment",
          sequence: i + 1,
          status: "pending",
          attempts: 0,
          nextAt: 0,
          body: {
            formatVersion: 3,
            kind: "payment",
            operationId: id,
            recordedAt: new Date(refreshedAt - 600_000).toISOString(),
            target: { orderId: order },
            payment: cash(30),
          },
        });
      await markSynced(
        ids[0]!,
        { orderId: order, tenderId: uuid(63) },
        refreshedAt + skew,
      );
      await markSynced(
        ids[1]!,
        { orderId: order, tenderId: uuid(64) },
        refreshedAt - skew,
      );
      await cacheSnapshot(
        s,
        [
          serverCopy(order, {
            total: 250,
            paid: 30,
            tenderIds: [uuid(63)],
            offlineOperationIds: [ids[0]!],
          }),
        ],
        new Date(refreshedAt).toISOString(),
      );
      const [view] = (await cachedServerOpenOrders(s)).orders;
      expect(view, `skew ${skew}`).toMatchObject({ total: 250, paid: 90 });
    }
  });

  it("rounds and payments for a local order count against its synced server copy until it shows them", async () => {
    const s = session();
    const open = await localOrder(s, 250);
    await saveOfflineRound(ctxOf(s), {
      target: { localOrderOperationId: open.id },
      ...roundInput(80),
    });
    await saveOfflinePayment(ctxOf(s), {
      target: { localOrderOperationId: open.id },
      payment: cash(100),
      operationId: crypto.randomUUID(),
    });
    const serverId = uuid(65);
    await markSynced(
      open.id,
      { orderId: serverId, orderNumber: 7 },
      Date.now(),
    );
    await cacheSnapshot(s, [
      serverCopy(serverId, { total: 250, offlineOperationIds: [open.id] }),
    ]);
    expect(await localOpenOrders(s)).toEqual([]);
    const [view] = (await cachedServerOpenOrders(s)).orders;
    expect(view).toMatchObject({ id: serverId, total: 330, paid: 100 });
    expect(view!.lines.map((l) => l.round)).toEqual([1, 2]);
    // Another employee's queued payment on this device is money already paid.
    const otherId = crypto.randomUUID();
    await fakeDb.pending.put({
      id: otherId,
      scope: `${s.tenantId}:${s.deviceId}:${uuid(99)}`,
      kind: "payment",
      sequence: 1,
      status: "pending",
      attempts: 0,
      nextAt: 0,
      body: {
        formatVersion: 3,
        kind: "payment",
        operationId: otherId,
        recordedAt: new Date().toISOString(),
        target: { orderId: serverId },
        payment: cash(30),
      },
    });
    expect((await cachedServerOpenOrders(s)).orders[0]).toMatchObject({
      paid: 130,
    });
  });
});

describe("open-orders cache (OFF-R2)", () => {
  it("an older copy never replaces a newer one, and a copy stored during a refresh survives it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T20:00:00.000Z"));
    const s = session({
      offlineUntil: new Date("2026-10-05T23:00:00.000Z").toISOString(),
    });
    const table = uuid(66);
    const unpaid = serverCopy(table, { total: 250 });
    await cacheSnapshot(s, [unpaid]);
    // Selling takes a payment online: it remembers the newer order.
    await rememberOpenOrder(
      s,
      serverOrder(table, { paid: 100, tenders: [uuid(67)] }),
    );
    // A refresh that started before that payment arrives late: still 100 paid.
    await cacheSnapshot(s, [unpaid]);
    expect((await cachedServerOpenOrders(s)).orders[0]).toMatchObject({
      paid: 100,
    });
    // An order Selling stores while a refresh is in flight is kept even though
    // that snapshot predates it; an order the snapshot omits is closed.
    const sent = uuid(68);
    mockedApi.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-05T20:00:05.000Z"));
      await rememberOpenOrder(s, serverOrder(sent));
      return { refreshedAt: new Date().toISOString(), orders: [] };
    });
    await refreshOpenOrders(s);
    expect((await cachedServerOpenOrders(s)).orders.map((o) => o.id)).toEqual([
      sent,
    ]);
    vi.setSystemTime(new Date("2026-10-05T20:01:00.000Z"));
    await cacheSnapshot(s, []);
    expect((await cachedServerOpenOrders(s)).orders).toEqual([]);
  });

  it("the order on screen when the outage starts is payable offline at its full balance", async () => {
    const s = session();
    const table = uuid(69);
    // Sent online seconds ago; no refresh has listed it yet.
    await rememberOpenOrder(s, serverOrder(table));
    const view = (await findOpenOrder(s, { orderId: table })) as LocalOrderView;
    expect(view).toMatchObject({ total: 250, paid: 0 });
    const paid = await saveOfflineCheckout(ctxOf(s), values(250), {
      draft: draft([]),
      priced: [],
      total: 0,
      current: view,
      operationId: crypto.randomUUID(),
      orderOperationId: crypto.randomUUID(),
      autoPrint: false,
    });
    expect(paid.receipt).toMatchObject({ total: 250, paid: 250 });
    expect(paid.view).toBeNull();
  });

  it("a cache stored by an older revision is never projected", async () => {
    const s = session();
    await fakeDb.cache.put({
      id: `${scope(s)}:open-orders`,
      value: {
        refreshedAt: new Date().toISOString(),
        orders: [serverCopy(uuid(70))],
      },
    });
    expect((await cachedServerOpenOrders(s)).orders).toEqual([]);
  });
});

describe("online payment guard (OFF-R5)", () => {
  it("blocks charging a server order while an offline payment for it is unresolved on this device", async () => {
    const s = session();
    const table = uuid(75);
    await cacheSnapshot(s, [serverCopy(table)]);
    await saveOfflinePayment(ctxOf(s), {
      target: { orderId: table },
      payment: cash(100),
      operationId: crypto.randomUUID(),
    });
    const online = serverOrder(table);
    expect(await refusal(assertNoUnsyncedPayment(s, online))).toBe(
      "offline_payment_pending_for_order",
    );
    const [payment] = [...fakeDb.pending.rows.values()];
    await fakeDb.pending.update(payment!.id, {
      status: "conflict",
      error: "offline_payment_exceeds_due",
    });
    expect(await refusal(assertNoUnsyncedPayment(s, online))).toBe(
      "offline_payment_pending_for_order",
    );
    await markSynced(
      payment!.id,
      { orderId: table, tenderId: uuid(76) },
      Date.now(),
    );
    await expect(assertNoUnsyncedPayment(s, online)).resolves.toBeUndefined();
    // The copy on screen lacks that tender: Selling reads the order again.
    expect(await serverLink(s, online)).toEqual({
      orderId: table,
      stale: true,
    });
    expect(
      await serverLink(
        s,
        serverOrder(table, { paid: 100, tenders: [uuid(76)] }),
      ),
    ).toEqual({ orderId: table, stale: false });
    await expect(
      assertNoUnsyncedPayment(s, serverOrder(uuid(79))),
    ).resolves.toBeUndefined();
  });
});

/** A queued row as the builders store it (only the fields the loop reads). */
function row(
  s: Session,
  over: Record<string, any> = {},
  body: Record<string, any> = {},
) {
  const id = crypto.randomUUID();
  return {
    id,
    scope: scope(s),
    kind: body.kind ?? "sale",
    status: "pending",
    attempts: 0,
    nextAt: 0,
    body: {
      formatVersion: 3,
      kind: "sale",
      operationId: id,
      recordedAt: new Date().toISOString(),
      sequence: 1,
      ...body,
    },
    ...over,
  };
}

describe("sync loop and table records", () => {
  it("I5: a dependent row waits for its queued parent without counting attempts", async () => {
    const s = session();
    const parent = row(
      s,
      { status: "conflict", error: "settings_changed" },
      { kind: "order", sequence: 1 },
    );
    const child = row(
      s,
      {},
      {
        kind: "payment",
        sequence: 2,
        target: { localOrderOperationId: parent.id },
      },
    );
    await fakeDb.pending.put(parent);
    await fakeDb.pending.put(child);
    await syncPending(s, { reason: "poll" });
    expect(mockedApi).not.toHaveBeenCalled();
    expect(await fakeDb.pending.get(child.id)).toMatchObject({
      status: "pending",
      waitReason: "dependency",
      attempts: 0,
    });
    await fakeDb.pending.update(parent.id, {
      status: "synced",
      result: { orderId: uuid(50) },
      syncedAt: Date.now(),
    });
    mockedApi.mockResolvedValueOnce({ orderId: uuid(50), tenderId: uuid(51) });
    await syncPending(s, { reason: "poll" });
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(mockedApi.mock.calls[0]![1]).toEqual(child.body);
    const synced = await fakeDb.pending.get(child.id);
    expect(synced).toMatchObject({ status: "synced", attempts: 0 });
    expect(synced!.waitReason).toBeUndefined();
  });
});
