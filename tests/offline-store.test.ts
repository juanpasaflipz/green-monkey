/**
 * Offline sale builder and sync loop against an in-memory store (contract
 * §8.1 invariants I1, I10, I14 and the OFF-6 retry policy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../shared/domain";
import { fakeDb } from "./offline-fake-db";

vi.mock("../src/offline", async () => ({
  db: (await import("./offline-fake-db")).fakeDb,
}));
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  api: vi.fn(),
}));

import { api, ApiError } from "../src/api";
import { resetConnectivityForTests } from "../src/connectivity";
import { strings, translateError } from "../src/i18n";
import { scope } from "../src/offline-keys";
import {
  OfflineSaveError,
  offlineBlockReason,
  saveOfflineSale,
} from "../src/offline-records";
import { syncPending, unsyncedCount } from "../src/offline-queue";

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
const line = (n: number, quantity = 1) => ({
  id: uuid(100 + n),
  productId: uuid(200 + n),
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
  mode: "takeaway" as const,
  tableId: null,
  name: "Mesa",
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

/** A cash sale of one line at 100; `operationId` defaults to a new id. */
function sale(s: Session, operationId = crypto.randomUUID(), total = 100) {
  const l = line(1);
  return saveOfflineSale(
    { session: s, catalog: [], cashSession: drawer },
    {
      draft: draft([l]),
      priced: [priced(l, total)],
      total,
      payment: cash(total, total + 50),
      operationId,
      autoPrint: false,
    },
  );
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: Error) => e,
  );
  expect(error).toBeInstanceOf(OfflineSaveError);
  return error!.message;
}

beforeEach(() => {
  fakeDb.reset();
  mockedApi.mockReset();
  resetConnectivityForTests();
});
afterEach(() => {
  vi.useRealTimers();
  resetConnectivityForTests();
});

describe("offline sale preconditions", () => {
  it("I14: no offline save after offlineUntil by the server-corrected clock", async () => {
    // The device clock says 60 s are left, but the server is 2 min ahead.
    const s = session({
      offlineUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    resetConnectivityForTests({}, 120_000);
    expect(await refusal(sale(s))).toBe("offline_window_expired");
    expect(fakeDb.pending.rows.size).toBe(0);
    // The device clock says the window ended, but the server is 2 min behind.
    const late = session({
      offlineUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    resetConnectivityForTests({}, -120_000);
    await expect(sale(late)).resolves.toMatchObject({ state: "local" });
    expect(fakeDb.pending.rows.size).toBe(1);
  });

  it("offline_drawer_missing without a cached open drawer", async () => {
    const s = session();
    const l = line(1);
    for (const cashSession of [
      null,
      { id: uuid(9), closed_at: new Date().toISOString() },
    ])
      expect(
        await refusal(
          saveOfflineSale(
            { session: s, catalog: [], cashSession },
            {
              draft: draft([l]),
              priced: [priced(l, 100)],
              total: 100,
              payment: cash(100),
              operationId: crypto.randomUUID(),
              autoPrint: false,
            },
          ),
        ),
      ).toBe("offline_drawer_missing");
    expect(offlineBlockReason(s, null, false)).toBeNull();
    expect(
      offlineBlockReason({ ...s, sellingAllowed: false }, drawer, true),
    ).toBe("free_selection_required");
    expect(fakeDb.pending.rows.size).toBe(0);
  });

  it("I1: a record id is written exactly once and a repeat never replaces it", async () => {
    const s = session();
    const id = crypto.randomUUID();
    const first = await sale(s, id);
    const stored = await fakeDb.pending.get(id);
    expect(await refusal(sale(s, id, 300))).toBe("operation_conflict");
    expect(await fakeDb.pending.get(id)).toEqual(stored);
    // The refused save rolled back its provisional number and sequence.
    const next = await sale(s);
    expect(next.offline.provisionalNumber).not.toBe(
      first.offline.provisionalNumber,
    );
    expect((await fakeDb.pending.get(next.id))!.body.provisionalNumber).toMatch(
      /-02$/,
    );
  });

  it("refusals use translated offline codes", async () => {
    expect(await refusal(sale(session(), undefined, 0))).toBe(
      "offline_amount_invalid",
    );
    for (const code of [
      "offline_window_expired",
      "offline_drawer_missing",
      "offline_amount_invalid",
      "offline_record_invalid",
      "offline_order_not_cached",
      "offline_amount_exceeds_due",
      "offline_payment_pending_for_order",
      "offline_split_unavailable",
      "offline_storage_full",
    ])
      for (const locale of ["es", "en"] as const)
        expect(translateError(code, locale), code).not.toBe(
          strings[locale].error,
        );
  });

  it("the record cites the lease and both clocks", async () => {
    resetConnectivityForTests({}, -180_000);
    const receipt = await sale(session());
    const body = (await fakeDb.pending.get(receipt.id))!.body;
    expect(body.lease).toEqual({ contractVersion: 1, configurationVersion: 3 });
    expect(body.clockOffsetMs).toBe(-180_000);
    expect(
      Date.parse(body.recordedAtDevice) - Date.parse(body.recordedAt),
    ).toBeGreaterThanOrEqual(180_000 - 50);
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

describe("sync loop", () => {
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

  it("OFF-6: 50 transient failures never become a conflict; delay caps at 60 s ±20 %", async () => {
    const s = session();
    const queued = row(s);
    await fakeDb.pending.put(queued);
    mockedApi.mockRejectedValue(
      new ApiError("server_unavailable", 503, "server"),
    );
    for (let i = 0; i < 50; i++) {
      const before = Date.now();
      await syncPending(s, { force: true, reason: "manual" });
      const current = (await fakeDb.pending.get(queued.id))!;
      expect(current.status).toBe("pending");
      expect(current.nextAt - before).toBeLessThanOrEqual(72_000 + 50);
    }
    expect((await fakeDb.pending.get(queued.id))!.attempts).toBe(50);
    expect(await unsyncedCount(s)).toBe(1);
  });

  it("OFF-6: attempts are not counted while the server looks unreachable, and a network error stops the pass", async () => {
    const s = session();
    const first = row(s, {}, { sequence: 1 });
    const second = row(s, {}, { sequence: 2 });
    await fakeDb.pending.put(first);
    await fakeDb.pending.put(second);
    resetConnectivityForTests({ mode: "offline", failures: 2 });
    mockedApi.mockRejectedValue(
      new ApiError("network_unavailable", 0, "network"),
    );
    await syncPending(s, { force: true, reason: "manual" });
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(await fakeDb.pending.get(first.id)).toMatchObject({
      status: "pending",
      attempts: 0,
      error: "network_unavailable",
    });
    expect(await fakeDb.pending.get(second.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });

  it("classification is applied to rows: auth waits, archived resolves, domain codes need review", async () => {
    const s = session();
    const auth = row(s, {}, { sequence: 1 });
    const archived = row(s, {}, { sequence: 2 });
    const conflict = row(s, {}, { sequence: 3 });
    for (const r of [auth, archived, conflict]) await fakeDb.pending.put(r);
    mockedApi.mockRejectedValueOnce(new ApiError("unauthorized", 401, "auth"));
    await syncPending(s, { reason: "poll" });
    expect(await fakeDb.pending.get(auth.id)).toMatchObject({
      status: "pending",
      waitReason: "auth",
      attempts: 0,
    });
    expect(mockedApi).toHaveBeenCalledTimes(1);
    await fakeDb.pending.delete(auth.id);
    mockedApi
      .mockRejectedValueOnce(new ApiError("offline_archived", 409))
      .mockRejectedValueOnce(new ApiError("price_conflict", 409));
    await syncPending(s, { reason: "poll" });
    const archivedRow = (await fakeDb.pending.get(archived.id))!;
    expect(archivedRow.status).toBe("archived");
    expect(archivedRow.archivedAt).toBeGreaterThan(0);
    expect(await fakeDb.pending.get(conflict.id)).toMatchObject({
      status: "conflict",
      error: "price_conflict",
    });
    // A conflict is never retried on its own; only a forced pass sends it.
    mockedApi.mockClear();
    await syncPending(s, { reason: "poll" });
    expect(mockedApi).not.toHaveBeenCalled();
    expect(await unsyncedCount(s)).toBe(1);
  });
});
