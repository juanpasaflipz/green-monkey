import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order, PricedLine, Session } from "../shared/domain";
import { ReceiptDocument, setReceiptSlots } from "../src/features/Receipt";
import { tenderMethodLabel } from "../src/labels";
import { fakeDb } from "./offline-fake-db";

// Local receipts built by offline's record builders (OFF-INT-3) run against
// the in-memory store; the receipt itself never calls the server.
vi.mock("../src/offline", async () => ({
  db: (await import("./offline-fake-db")).fakeDb,
}));
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  api: vi.fn(),
}));

import { api } from "../src/api";
import { resetConnectivityForTests } from "../src/connectivity";
import {
  findOpenOrder,
  refreshOpenOrders,
  saveOfflineCheckout,
  saveOfflineOrder,
  saveOfflineRound,
} from "../src/offline-records";
import { setOfflineTableServiceForTests } from "../src/offline-settings";

const session: Session = {
  id: "s",
  tenantId: "t",
  employeeId: "e",
  name: "Cajero",
  role: "cashier",
  deviceId: "d",
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant: {
    name: "Taquería Ficticia",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
  },
};
const line = (extra: Partial<PricedLine>): PricedLine => ({
  id: "l1",
  productId: "p1",
  quantity: 1,
  options: [],
  note: "",
  name: { es: "Taco de asada", en: "Steak taco" },
  optionNames: [],
  unitPrice: 4500,
  total: 4500,
  cost: null,
  station: "kitchen",
  recipe: [],
  productVersion: 1,
  round: 1,
  ...extra,
});
const order: Order = {
  id: "11111111-1111-4111-8111-111111111111",
  number: 42,
  version: 2,
  mode: "dine_in",
  tableId: null,
  name: "Notas",
  note: "ALERGIA: cacahuate",
  lines: [
    line({
      optionNames: [{ es: "Salsa verde", en: "Green salsa" }],
      note: "Sin cebolla",
    }),
    line({
      id: "l2",
      name: { es: "Flan de vainilla", en: "Vanilla flan" },
      round: 2,
      station: "bar",
    }),
  ],
  total: 9000,
  paid: 0,
  refunded: 0,
  state: "active",
  createdAt: "2026-10-05T18:00:00.000Z",
  rounds: [
    { number: 1, station: "kitchen", note: "" },
    { number: 2, station: "kitchen", note: "Postres al final" },
    { number: 2, station: "bar", note: "Postres al final" },
  ],
  tenders: [],
};
const render = (p: Partial<Parameters<typeof ReceiptDocument>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ReceiptDocument, {
      order,
      session,
      locale: "es",
      kind: "receipt",
      ...p,
    }),
  );

/** The receipt's text as printed, one space between elements. */
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ :/g, ":");

afterEach(() => setReceiptSlots({}));

describe("receipt document", () => {
  it("prints the order note, round notes, modifiers and line notes (LD-1)", () => {
    for (const kind of ["receipt", "check", "local"] as const) {
      const html = render({ kind });
      expect(html).toContain("ALERGIA: cacahuate");
      expect(html).toContain("Alergia");
      expect(html).toContain("Nota de la ronda 2");
      expect(html.match(/Postres al final/g)).toHaveLength(1);
      expect(html).toContain("Salsa verde");
      expect(html).toContain("Sin cebolla");
      expect(html.indexOf("ALERGIA: cacahuate")).toBeLessThan(
        html.indexOf("Taco de asada"),
      );
    }
    expect(render({ kind: "check" })).toContain(
      "Cuenta · no es comprobante de pago",
    );
  });

  it("hides a round note identical to the order note and shows plain labels", () => {
    const html = render({
      order: {
        ...order,
        note: "Sin prisa",
        rounds: [{ number: 2, station: "kitchen", note: "Sin prisa" }],
      },
      locale: "en",
    });
    expect(html.match(/Sin prisa/g)).toHaveLength(1);
    expect(html).toContain("Order note");
    expect(html).not.toContain("Round 2 note");
  });

  it("never prints an offline sale collected in full as unpaid (SERVICE-MONEY-5)", () => {
    const local = { ...order, state: "local", paid: 0, tenders: [] };
    const html = render({ order: local, kind: "local" });
    expect(html).toContain("Cobrado · pendiente de sincronizar");
    expect(html).toContain("$90.00");
    expect(html).not.toContain("Saldo pendiente");
    expect(html).not.toContain("$0.00");
    expect(render({ order: local, kind: "local", locale: "en" })).toContain(
      "Collected · pending sync",
    );
    // A server receipt keeps its paid and remaining rows.
    const server = render();
    expect(server).toContain("Saldo pendiente");
    expect(server).toContain("$0.00");
  });

  it("prints an offline payment's method, reference, change and balance on a local receipt (LD-10 B4)", () => {
    const offline = {
      provisionalNumber: "A1-0001",
      soldAt: order.createdAt,
      method: "cash" as const,
      reference: "",
      amount: 9000,
      tip: 0,
      received: 10000,
    };
    const cash = render({
      order: { ...order, state: "local", paid: 9000, offline } as Order,
      kind: "local",
    });
    expect(cash).toContain("Efectivo");
    expect(cash).toContain("Recibido");
    expect(cash).toContain("$100.00");
    expect(cash).toContain("Cambio");
    expect(cash).toContain("$10.00");
    expect(cash).toContain("Cobrado · pendiente de sincronizar");
    expect(cash).not.toContain("Saldo pendiente");
    expect(cash).toContain("ALERGIA: cacahuate");
    const external = render({
      order: {
        ...order,
        state: "local",
        paid: 9000,
        offline: {
          ...offline,
          method: "external",
          reference: "AUT-7781",
          received: 9000,
        },
      } as Order,
      kind: "local",
    });
    expect(external).toContain("Terminal bancaria externa");
    expect(external).toContain("Ref. AUT-7781");
    expect(external).not.toContain("Cambio");
    // LD-7 table service: a partial offline payment prints what was collected
    // and the balance, never the total as collected.
    const partial = render({
      order: {
        ...order,
        state: "local",
        paid: 5000,
        offline: { ...offline, amount: 5000, received: 5000 },
      } as Order,
      kind: "local",
    });
    expect(partial).toContain("Cobrado · pendiente de sincronizar");
    expect(partial).toContain("$50.00");
    expect(partial).toContain("Saldo pendiente");
    expect(partial).toContain("$40.00");
  });

  it("prints earlier tenders as paid and only this payment as pending sync (OFF-INT-3)", () => {
    // A payment saved offline on a server order cached with $20.00 already
    // paid online: the order's paid counts both.
    const html = render({
      order: {
        ...order,
        state: "local",
        paid: 7000,
        offline: {
          provisionalNumber: null,
          soldAt: order.createdAt,
          method: "cash",
          reference: "",
          amount: 5000,
          tip: 0,
          received: 5000,
        },
      } as Order,
      kind: "local",
    });
    const printed = plain(html);
    expect(printed).toContain("Cobrado $20.00");
    expect(printed).toContain("Cobrado · pendiente de sincronizar $50.00");
    expect(printed).toContain("Saldo pendiente $20.00");
    expect(printed).not.toContain("$70.00");
  });

  it("shows registered fiscal slots on every receipt; props win", () => {
    setReceiptSlots({
      header: ({ kind, reprint }) =>
        createElement("p", null, `RFC slot ${kind} ${reprint}`),
      footer: () => createElement("p", null, "Folio slot"),
    });
    expect(render({ kind: "check" })).toContain("RFC slot check false");
    expect(render({ reprint: true })).toContain("RFC slot receipt true");
    expect(render()).toContain("Folio slot");
    const own = render({ header: createElement("p", null, "Propio") });
    expect(own).toContain("Propio");
    expect(own).not.toContain("RFC slot");
  });
});

describe("local receipts built from offline records (OFF-INT-3, LD-1)", () => {
  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const s: Session = {
    ...session,
    id: uuid(1),
    tenantId: uuid(2),
    employeeId: uuid(3),
    deviceId: uuid(4),
    expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    offlineUntil: new Date(Date.now() + 3_600_000).toISOString(),
    offlineLeaseVersion: 1,
    offlineLeaseConfigVersion: 3,
    restaurant: { ...session.restaurant, configVersion: 3 },
  };
  const ctx = {
    session: s,
    catalog: [],
    cashSession: { id: uuid(9), closed_at: null },
  };
  let products = 0;
  const cartLine = (unitPrice: number) => {
    const input = {
      id: crypto.randomUUID(),
      productId: uuid(200 + ++products),
      quantity: 1,
      options: [],
      note: "",
    };
    return { input, priced: line({ ...input, unitPrice, total: unitPrice }) };
  };
  const draftOf = (
    lines: ReturnType<typeof cartLine>["input"][],
    note = "",
  ) => ({
    operationId: crypto.randomUUID(),
    lines,
    mode: "dine_in" as const,
    tableId: null,
    name: "Mesa 3",
    note,
    channel: "pos" as const,
  });
  const pay = (amount: number) => ({
    amount,
    tip: 0,
    received: amount,
    method: "cash" as const,
    reference: "",
    confirmed: false,
  });
  const keys = () => ({
    operationId: crypto.randomUUID(),
    orderOperationId: crypto.randomUUID(),
    autoPrint: false,
  });
  const printed = (o: Order) =>
    plain(render({ order: o, session: s, kind: "local" }));

  beforeEach(() => {
    fakeDb.reset();
    vi.mocked(api).mockReset();
    resetConnectivityForTests();
    setOfflineTableServiceForTests(s.tenantId, true);
  });
  afterEach(() => {
    resetConnectivityForTests();
    setOfflineTableServiceForTests(s.tenantId, null);
  });

  it("a local order's receipt prints the notes of rounds added offline", async () => {
    const first = cartLine(4500);
    const open = await saveOfflineOrder(ctx, {
      draft: draftOf([first.input], "ALERGIA: cacahuate"),
      priced: [first.priced],
      total: 4500,
      operationId: crypto.randomUUID(),
      autoPrint: false,
    });
    const second = cartLine(3000);
    await saveOfflineRound(ctx, {
      target: { localOrderOperationId: open.id },
      lines: [second.input],
      priced: [second.priced],
      total: 3000,
      note: "Postres al final",
      operationId: crypto.randomUUID(),
      autoPrint: false,
    });
    // The items added while paying are a round with the cart's note too.
    const third = cartLine(1500);
    const { receipt } = await saveOfflineCheckout(ctx, pay(9000), {
      draft: draftOf([third.input], "Café sin azúcar"),
      priced: [third.priced],
      total: 1500,
      current: await findOpenOrder(s, { localOrderOperationId: open.id }),
      ...keys(),
    });
    const text = printed(receipt);
    expect(text).toContain("ALERGIA: cacahuate");
    expect(text).toContain("Nota de la ronda 2: Postres al final");
    expect(text).toContain("Nota de la ronda 3: Café sin azúcar");
    expect(text).toContain("Cobrado · pendiente de sincronizar $90.00");
    expect(text).not.toContain("Saldo pendiente");
  });

  it("a cached server order's receipt prints its round notes, earlier tenders as paid and this payment as pending sync", async () => {
    const orderId = uuid(70);
    const served = (round: number) => ({
      id: crypto.randomUUID(),
      productId: uuid(300 + round),
      round,
      quantity: 1,
      name: { es: "Taco de asada", en: "Steak taco" },
      optionNames: [],
      unitPrice: 4500,
      total: 4500,
      station: "kitchen",
      voidedQuantity: 0,
    });
    vi.mocked(api).mockResolvedValueOnce({
      refreshedAt: new Date().toISOString(),
      orders: [
        {
          id: orderId,
          number: 42,
          version: 2,
          mode: "dine_in",
          tableId: null,
          tableName: "Mesa 03",
          name: "Mesa 3",
          note: "",
          total: 9000,
          paid: 2000,
          state: "active",
          createdAt: new Date().toISOString(),
          serviceVersion: 1,
          lines: [served(1), served(2)],
          tenderIds: [uuid(80)],
          offlineOperationIds: [],
          roundNotes: [{ number: 2, note: "Postres al final" }],
        },
      ],
    });
    await refreshOpenOrders(s);
    const { receipt } = await saveOfflineCheckout(ctx, pay(5000), {
      draft: draftOf([]),
      priced: [],
      total: 0,
      current: await findOpenOrder(s, { orderId }),
      ...keys(),
    });
    const text = printed(receipt);
    expect(text).toContain("Nota de la ronda 2: Postres al final");
    expect(text).toContain("Cobrado $20.00");
    expect(text).toContain("Cobrado · pendiente de sincronizar $50.00");
    expect(text).toContain("Saldo pendiente $20.00");
  });
});

describe("tender labels", () => {
  it("never labels an unknown method as cash", () => {
    expect(tenderMethodLabel("cash", undefined, "es")).toBe("Efectivo");
    expect(tenderMethodLabel("external", undefined, "es")).toBe(
      "Terminal bancaria externa",
    );
    expect(tenderMethodLabel("integrated", undefined, "es")).toBe(
      "Otro método de pago",
    );
    expect(tenderMethodLabel("integrated", undefined, "en")).toBe(
      "Other payment method",
    );
    expect(tenderMethodLabel("cash", "offline_recovery", "es")).toBe(
      "Efectivo recuperado",
    );
  });
});
