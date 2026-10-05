/**
 * Offline table service against an in-memory store (wave contract §8.1):
 * preconditions of every builder (I8, I9, I14), local orders paid while online
 * (I13), atomic checkouts, and the display projections that decide what staff
 * still collect (OFF-R2, OFF-R3, OFF-R5).
 *
 * LD-7 ships table service off by default. These invariants must hold with it
 * on, so every test turns it on for the fixture restaurant, except the "off"
 * describe, which checks the default.
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

import { api, ApiError } from "../src/api";
import { syncPending } from "../src/offline-queue";
import { resetConnectivityForTests } from "../src/connectivity";
import { scope } from "../src/offline-keys";
import {
  OfflineSaveError,
  assertNoUnsyncedPayment,
  cachedServerOpenOrders,
  findOpenOrder,
  isLocalOrder,
  linkFromRows,
  localOpenOrders,
  orderTicketIds,
  reconciledResult,
  refreshOpenOrders,
  rememberOpenOrder,
  saveOfflineCheckout,
  saveOfflineOrder,
  saveOfflinePartial,
  saveOfflinePayment,
  saveOfflineRound,
  serverLink,
  tablesKey,
  type LocalOrderView,
  type SaveContext,
} from "../src/offline-records";
import {
  offlineTableServiceOn,
  refreshOfflineSettings,
  setOfflineTableServiceForTests,
} from "../src/offline-settings";

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
  over: {
    paid?: number;
    tenders?: string[];
    rounds?: number[];
    total?: number;
    state?: string;
  } = {},
): Order {
  const copy = serverCopy(id, {
    paid: over.paid,
    tenderIds: over.tenders,
    rounds: over.rounds,
    total: over.total,
    state: over.state,
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
  setOfflineTableServiceForTests(session().tenantId, true);
});
afterEach(() => {
  vi.useRealTimers();
  resetConnectivityForTests();
  setOfflineTableServiceForTests(session().tenantId, null);
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

describe("LD-7: offline table service is off by default", () => {
  it("with it off (or never read) only a new order paid in full is saved; nothing else writes a row", async () => {
    const s = session();
    // Prepared while it was on: a local order and a cached server order.
    const open = await localOrder(s);
    const cached = uuid(110);
    await cacheSnapshot(s, [serverCopy(cached)]);
    const before = fakeDb.pending.rows.size;
    for (const value of [false, null]) {
      setOfflineTableServiceForTests(s.tenantId, value);
      expect(offlineTableServiceOn(s)).toBe(false);
      const l = line();
      const refusals = [
        // Enviar (a local open order)
        saveOfflineOrder(ctxOf(s), {
          draft: draft([l]),
          priced: [priced(l, 100)],
          total: 100,
          operationId: crypto.randomUUID(),
          autoPrint: false,
        }),
        // A round on a local or a cached server order
        saveOfflineRound(ctxOf(s), {
          target: { localOrderOperationId: open.id },
          ...roundInput(100),
        }),
        saveOfflineRound(ctxOf(s), {
          target: { orderId: cached },
          ...roundInput(100),
        }),
        // Paying an existing check, in full or in part
        saveOfflinePayment(ctxOf(s), {
          target: { orderId: cached },
          payment: cash(250),
          operationId: crypto.randomUUID(),
        }),
        saveOfflineCheckout(ctxOf(s), values(100), {
          draft: draft([]),
          priced: [],
          total: 0,
          current: open,
          operationId: crypto.randomUUID(),
          orderOperationId: crypto.randomUUID(),
          autoPrint: false,
        }),
        // A new order paid in part
        saveOfflineCheckout(ctxOf(s), values(40), {
          draft: draft([l]),
          priced: [priced(l, 100)],
          total: 100,
          current: null,
          operationId: crypto.randomUUID(),
          orderOperationId: crypto.randomUUID(),
          autoPrint: false,
        }),
      ];
      for (const save of refusals)
        expect(await refusal(save), `setting ${value}`).toBe(
          "offline_table_service_off",
        );
      expect(fakeDb.pending.rows.size).toBe(before);
    }
    // The core offline sale (new order, full payment) never needs it.
    const l = line();
    const sale = await saveOfflineCheckout(ctxOf(s), values(100), {
      draft: draft([l]),
      priced: [priced(l, 100)],
      total: 100,
      current: null,
      operationId: crypto.randomUUID(),
      orderOperationId: crypto.randomUUID(),
      autoPrint: false,
    });
    expect(sale.receipt).toMatchObject({ state: "local", paid: 100 });
    expect(fakeDb.pending.rows.size).toBe(before + 1);
  });

  it("the device keeps the restaurant's last answer for an outage, and stops caching open orders when off", async () => {
    const s = session();
    setOfflineTableServiceForTests(s.tenantId, null);
    mockedApi.mockResolvedValueOnce({ tableService: true });
    await refreshOfflineSettings(s);
    // A reload during the outage: memory is empty, the stored answer applies.
    setOfflineTableServiceForTests(s.tenantId, null);
    await expect(localOrder(s)).resolves.toMatchObject({
      state: "local_open",
    });
    mockedApi.mockResolvedValueOnce({ tableService: false });
    await refreshOfflineSettings(s);
    setOfflineTableServiceForTests(s.tenantId, null);
    expect(await refusal(localOrder(s))).toBe("offline_table_service_off");
    // Nothing reads the open-orders cache while it is off, so nothing writes it.
    await rememberOpenOrder(s, serverOrder(uuid(111)));
    expect(await fakeDb.cache.get(`${scope(s)}:open-orders`)).toBeUndefined();
  });

  it("a record saved while it was on still syncs after it is turned off", async () => {
    const s = session();
    const open = await localOrder(s);
    setOfflineTableServiceForTests(s.tenantId, false);
    mockedApi.mockResolvedValueOnce({ kind: "order", orderId: uuid(112) });
    await syncPending(s, { reason: "poll" });
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(await fakeDb.pending.get(open.id)).toMatchObject({
      status: "synced",
    });
  });
});

describe("rounds on a paid check (§2.3, offline_check_paid)", () => {
  it("a round on a cached server order with zero projected balance is refused with offline_check_paid and writes nothing", async () => {
    const s = session();
    const paidCheck = uuid(120);
    // Dine-in "Pagada · por liberar": still open, nothing left to pay.
    await cacheSnapshot(s, [
      serverCopy(paidCheck, { total: 250, paid: 250, tenderIds: [uuid(121)] }),
    ]);
    expect(
      await refusal(
        saveOfflineRound(ctxOf(s), {
          target: { orderId: paidCheck },
          ...roundInput(80),
        }),
      ),
    ).toBe("offline_check_paid");
    expect(fakeDb.pending.rows.size).toBe(0);
  });

  it("a round on a local order paid in full on this device is refused with offline_check_paid", async () => {
    const s = session();
    const open = await localOrder(s, 250);
    await saveOfflinePayment(ctxOf(s), {
      target: { localOrderOperationId: open.id },
      payment: cash(250),
      operationId: crypto.randomUUID(),
    });
    const rows = fakeDb.pending.rows.size;
    expect(
      await refusal(
        saveOfflineRound(ctxOf(s), {
          target: { localOrderOperationId: open.id },
          ...roundInput(80),
        }),
      ),
    ).toBe("offline_check_paid");
    expect(fakeDb.pending.rows.size).toBe(rows);
    // A local order paid in full is no longer offered as an open order.
    expect(await localOpenOrders(s)).toEqual([]);
  });

  it("a payment with an inline round on a zero-balance order is refused with offline_check_paid; the checkout writes neither row", async () => {
    const s = session();
    const paidCheck = uuid(122);
    await cacheSnapshot(s, [
      serverCopy(paidCheck, { total: 250, paid: 250, tenderIds: [uuid(123)] }),
    ]);
    const [view] = (await cachedServerOpenOrders(s)).orders;
    const l = line();
    expect(
      await refusal(
        saveOfflineCheckout(ctxOf(s), values(80), {
          draft: draft([l]),
          priced: [priced(l, 80)],
          total: 80,
          current: view!,
          operationId: crypto.randomUUID(),
          orderOperationId: crypto.randomUUID(),
          autoPrint: false,
        }),
      ),
    ).toBe("offline_check_paid");
    expect(fakeDb.pending.rows.size).toBe(0);
  });

  it("a round on a cached order with a positive balance is still saved", async () => {
    const s = session();
    const table = uuid(124);
    await cacheSnapshot(s, [serverCopy(table, { total: 250, paid: 100 })]);
    const view = await saveOfflineRound(ctxOf(s), {
      target: { orderId: table },
      ...roundInput(80),
    });
    expect(view).toMatchObject({ id: table, total: 330, paid: 100 });
    expect(fakeDb.pending.rows.size).toBe(1);
  });
});

describe("synced local orders (OFF-R12)", () => {
  it("a synced local order paid online and then dropped from the snapshot never comes back as an unpaid local order", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T20:00:00.000Z"));
    const s = session({
      offlineUntil: new Date("2026-10-05T23:00:00.000Z").toISOString(),
    });
    // Enviar offline: B-01, $250.
    const open = await localOrder(s, 250);
    // It syncs as #142: the queue keeps the server copy from the result.
    const serverId = uuid(130);
    mockedApi.mockResolvedValueOnce({
      kind: "order",
      orderId: serverId,
      orderNumber: 142,
      roundNumber: 1,
      tenderId: null,
      order: serverOrder(serverId),
    });
    await syncPending(s, { reason: "poll" });
    expect(await localOpenOrders(s)).toEqual([]);
    const served = await findOpenOrder(s, { localOrderOperationId: open.id });
    expect(served).toMatchObject({ id: serverId, total: 250, paid: 0 });
    expect(served!.offline.provisionalNumber).toBe(open.offline.provisionalNumber);
    // Paid online in full; Selling caches the paid copy.
    vi.setSystemTime(new Date("2026-10-05T20:05:00.000Z"));
    await rememberOpenOrder(
      s,
      serverOrder(serverId, {
        paid: 250,
        tenders: [uuid(131)],
        state: "completed",
      }),
    );
    // The next refresh no longer lists it (paid and closed).
    vi.setSystemTime(new Date("2026-10-05T20:07:00.000Z"));
    await cacheSnapshot(s, []);
    expect(await localOpenOrders(s)).toEqual([]);
    expect((await cachedServerOpenOrders(s)).orders).toEqual([]);
    expect(
      await findOpenOrder(s, { localOrderOperationId: open.id }),
    ).toBeNull();
    const rows = fakeDb.pending.rows.size;
    // During the next outage nothing can be added to it or charged on it.
    expect(
      await refusal(
        saveOfflineRound(ctxOf(s), {
          target: { localOrderOperationId: open.id },
          ...roundInput(80),
        }),
      ),
    ).toBe("offline_order_not_cached");
    expect(
      await refusal(
        saveOfflinePayment(ctxOf(s), {
          target: { localOrderOperationId: open.id },
          payment: cash(330),
          operationId: crypto.randomUUID(),
          round: roundInput(80),
        }),
      ),
    ).toBe("offline_order_not_cached");
    expect(fakeDb.pending.rows.size).toBe(rows);
  });

  it("an order record that synced without a result is the server's: never a local projection", async () => {
    const s = session();
    const open = await localOrder(s, 250);
    await fakeDb.pending.update(open.id, {
      status: "synced",
      result: null,
      syncedAt: Date.now(),
    });
    expect(await localOpenOrders(s)).toEqual([]);
    expect(
      await refusal(
        saveOfflinePayment(ctxOf(s), {
          target: { localOrderOperationId: open.id },
          payment: cash(100),
          operationId: crypto.randomUUID(),
        }),
      ),
    ).toBe("offline_order_not_cached");
  });
});

describe("manager-reconciled payments (OFF-R18)", () => {
  it("count once against a copy that already has the reconciled tender", async () => {
    const s = session();
    const table = uuid(140);
    await cacheSnapshot(s, [serverCopy(table, { total: 500 })]);
    const paymentId = crypto.randomUUID();
    await saveOfflinePayment(ctxOf(s), {
      target: { orderId: table },
      payment: cash(200),
      operationId: paymentId,
    });
    // The manager reconciles it into the order; the route answers the order.
    const tenderId = uuid(141);
    const reconciled: Order = {
      ...serverOrder(table, { total: 500, paid: 200 }),
      tenders: [
        { id: tenderId, source: "offline_recovery", source_id: paymentId },
      ],
    };
    const result = reconciledResult(paymentId, reconciled);
    expect(result).toMatchObject({ orderId: table, tenderId });
    // Selling shows the order online and caches it with that tender.
    await rememberOpenOrder(s, reconciled);
    for (const stored of [result, reconciled]) {
      // Both the new result shape and a row stored by an older revision (the
      // bare order) are recognised in the copy.
      await fakeDb.pending.update(paymentId, {
        status: "synced",
        result: stored,
        syncedAt: Date.now(),
      });
      expect((await cachedServerOpenOrders(s)).orders[0]).toMatchObject({
        total: 500,
        paid: 200,
      });
      const rows = [...fakeDb.pending.rows.values()];
      expect(linkFromRows(reconciled, rows)).toEqual({
        orderId: table,
        stale: false,
      });
    }
  });
});

describe("table names (OFF-R25)", () => {
  it("local orders show their table from the cached tables list", async () => {
    const s = session();
    const tableId = uuid(150);
    await fakeDb.cache.put({
      id: tablesKey(s),
      value: [{ id: tableId, name: "Mesa 07" }],
    });
    const l = line();
    await saveOfflineOrder(ctxOf(s), {
      draft: { ...draft([l]), tableId },
      priced: [priced(l, 100)],
      total: 100,
      operationId: crypto.randomUUID(),
      autoPrint: false,
    });
    const [view] = await localOpenOrders(s);
    expect(view).toMatchObject({ tableId, tableName: "Mesa 07" });
  });
});

describe("kitchen tickets of an order on screen (OFF-R19)", () => {
  it("lists a local order's own record and its rounds, and only the rounds saved here for a cached order", async () => {
    const s = session();
    const open = await localOrder(s);
    const round = roundInput(80);
    await saveOfflineRound(ctxOf(s), {
      target: { localOrderOperationId: open.id },
      ...round,
    });
    const other = await localOrder(s);
    expect(await orderTicketIds(s, open)).toEqual([open.id, round.operationId]);
    expect(await orderTicketIds(s, other)).toEqual([other.id]);
    const table = uuid(151);
    await cacheSnapshot(s, [serverCopy(table)]);
    const cachedRound = roundInput(50);
    const view = await saveOfflineRound(ctxOf(s), {
      target: { orderId: table },
      ...cachedRound,
    });
    expect(await orderTicketIds(s, view)).toEqual([cachedRound.operationId]);
    // A payment's checkout prints only the round it added (never round 1).
    const paid = await saveOfflineCheckout(ctxOf(s), values(330), {
      draft: draft([round.lines[0]!]),
      priced: round.priced,
      total: 80,
      current: open,
      operationId: crypto.randomUUID(),
      orderOperationId: crypto.randomUUID(),
      autoPrint: false,
    });
    expect(paid.operationIds).toHaveLength(1);
    expect(paid.operationIds[0]).not.toBe(open.id);
    expect((await fakeDb.pending.get(paid.operationIds[0]!))!.body).toMatchObject(
      { kind: "round" },
    );
  });
});

describe("sync loop: one order's records stay in order (I10, OFF-R17)", () => {
  it("a 5xx on the round leaves the payment pending and never sends it; the next pass sends both in order", async () => {
    const s = session();
    const table = uuid(160);
    const roundRow = row(
      s,
      {},
      { kind: "round", sequence: 1, target: { orderId: table } },
    );
    const paymentRow = row(
      s,
      {},
      { kind: "payment", sequence: 2, target: { orderId: table } },
    );
    const otherSale = row(s, {}, { kind: "sale", sequence: 3 });
    for (const r of [roundRow, paymentRow, otherSale])
      await fakeDb.pending.put(r);
    mockedApi
      .mockRejectedValueOnce(new ApiError("internal_error", 500, "server"))
      .mockResolvedValueOnce({ kind: "sale", orderId: uuid(161) });
    await syncPending(s, { reason: "poll" });
    // The payment includes the round's amount: sent first it would be refused
    // as a conflict that only the order of arrival caused.
    expect(mockedApi.mock.calls.map((call) => call[1])).toEqual([
      roundRow.body,
      otherSale.body,
    ]);
    expect(await fakeDb.pending.get(roundRow.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "internal_error",
    });
    const waiting = await fakeDb.pending.get(paymentRow.id);
    expect(waiting).toMatchObject({ status: "pending", attempts: 0 });
    expect(waiting!.error).toBeUndefined();
    expect(await fakeDb.pending.get(otherSale.id)).toMatchObject({
      status: "synced",
    });
    // Until the round is due again, its order stays held.
    mockedApi.mockClear();
    await syncPending(s, { reason: "poll" });
    expect(mockedApi).not.toHaveBeenCalled();
    // Next pass: the round, then the payment.
    mockedApi
      .mockResolvedValueOnce({ kind: "round", orderId: table, roundNumber: 2 })
      .mockResolvedValueOnce({
        kind: "payment",
        orderId: table,
        tenderId: uuid(162),
      });
    await syncPending(s, { reason: "reconnect" });
    expect(mockedApi.mock.calls.map((call) => call[1])).toEqual([
      roundRow.body,
      paymentRow.body,
    ]);
    for (const id of [roundRow.id, paymentRow.id])
      expect(await fakeDb.pending.get(id)).toMatchObject({ status: "synced" });
  });

  it("records of a local order hold together, also once the order record synced", async () => {
    const s = session();
    const parent = row(
      s,
      {
        status: "synced",
        result: { orderId: uuid(170) },
        syncedAt: Date.now(),
      },
      { kind: "order", sequence: 1 },
    );
    const roundRow = row(
      s,
      {},
      {
        kind: "round",
        sequence: 2,
        target: { localOrderOperationId: parent.id },
      },
    );
    // Saved after the order synced, against the server order directly.
    const paymentRow = row(
      s,
      {},
      { kind: "payment", sequence: 3, target: { orderId: uuid(170) } },
    );
    for (const r of [parent, roundRow, paymentRow]) await fakeDb.pending.put(r);
    mockedApi.mockRejectedValueOnce(
      new ApiError("server_unavailable", 503, "server"),
    );
    await syncPending(s, { reason: "poll" });
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(await fakeDb.pending.get(paymentRow.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });
});
