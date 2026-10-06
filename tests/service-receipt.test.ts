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

describe("discount and refund rows (discounts 028, T-06)", () => {
  // Taco ×3 at 4500 (one comped unit) and a 10 % check discount on the rest.
  const taco = line({ id: "l3", quantity: 3, total: 13500, unitPrice: 4500 });
  const at = "2026-10-05T18:05:00.000Z";
  const discounted: Order = {
    ...order,
    note: "",
    rounds: [],
    lines: [taco],
    total: 8100,
    paid: 8100,
    refunded: 4050,
    discount: 5400,
    tenders: [
      {
        id: "t1",
        method: "cash",
        amount: 8100,
        tip: 0,
        received: 8100,
        refunded: 4050,
        external_reference: null,
      },
    ],
    discounts: [
      {
        id: "d1",
        scope: "line",
        lineId: "l3",
        kind: "comp",
        percentBps: null,
        base: 4500,
        amount: 4500,
        units: 1,
        activeAmount: 4500,
        releasedAmount: 0,
        allocations: [{ lineId: "l3", unit: 0, amount: 4500, voided: false }],
        reasonCode: "courtesy",
        note: "",
        actorName: "Ana",
        approverName: "Luis",
        createdAt: at,
        reversal: null,
      },
      {
        id: "d2",
        scope: "order",
        lineId: null,
        kind: "percent",
        percentBps: 1000,
        base: 9000,
        amount: 900,
        units: 2,
        activeAmount: 900,
        releasedAmount: 0,
        allocations: [
          { lineId: "l3", unit: 1, amount: 450, voided: false },
          { lineId: "l3", unit: 2, amount: 450, voided: false },
        ],
        reasonCode: "senior_inapam",
        note: "",
        actorName: "Ana",
        approverName: "Luis",
        createdAt: at,
        reversal: null,
      },
    ],
    refundBatches: [
      {
        id: "b1",
        mode: "items",
        amount: 4050,
        cashAmount: 4050,
        externalAmount: 0,
        reasonCode: "quality",
        note: "frío",
        restock: false,
        actorName: "Ana",
        approverName: "Luis",
        createdAt: at,
        businessDate: "2026-10-05",
        legacy: false,
        rows: [
          {
            refundId: "r1",
            tenderId: "t1",
            method: "cash",
            amount: 4050,
            reference: null,
          },
        ],
        lines: [
          {
            id: "rl1",
            lineId: "l3",
            units: [2],
            amount: 4050,
            restocked: false,
            preparationState: "completed",
            kitchenPending: false,
          },
        ],
      },
    ],
  };

  it("prints line and check discounts before the Total, so the receipt adds up", () => {
    const text = plain(render({ order: discounted }));
    expect(text).toContain("Cortesía (1 de 3) −$45.00");
    expect(text).toContain("Subtotal antes de descuentos $135.00");
    expect(text).toContain("Descuentos −$45.00");
    // MONEY-5: the base the rate applied to (only what was due then).
    expect(text).toContain(
      "Descuento en la cuenta · Adulto mayor (INAPAM) 10 % de $90.00 −$9.00",
    );
    expect(text.indexOf("Subtotal antes de descuentos")).toBeLessThan(
      text.indexOf("Total"),
    );
    expect(text.indexOf("Descuento en la cuenta")).toBeLessThan(
      text.indexOf("Total $81.00"),
    );
    // 135.00 − 45.00 − 9.00 = 81.00
    expect(text).toContain("Total $81.00");
  });

  it("renders nothing for an order without discounts or item refunds", () => {
    const text = plain(render());
    expect(text).not.toContain("Subtotal antes de descuentos");
    expect(text).not.toContain("Descuento");
    expect(text).not.toContain("Cortesía");
  });

  it("follows the refund row with what the item refund returned, unsigned (a breakdown, UI-7)", () => {
    const text = plain(render({ order: discounted }));
    const refund = text.indexOf("Reembolso −$40.50");
    expect(refund).toBeGreaterThan(-1);
    expect(text.indexOf("1 × Taco de asada $40.50")).toBeGreaterThan(refund);
    expect(text).not.toContain("1 × Taco de asada −$40.50");
  });

  it("a card item refund prints its amount once with a minus sign; the item and the terminal reference are its breakdown (UI-7, MONEY-6)", () => {
    const card: Order = {
      ...discounted,
      tenders: [
        {
          id: "t1",
          method: "external",
          amount: 8100,
          tip: 0,
          received: 0,
          refunded: 4050,
          external_reference: "T-1001",
        },
      ],
      refundBatches: [
        {
          ...discounted.refundBatches![0],
          cashAmount: 0,
          externalAmount: 4050,
          rows: [
            {
              refundId: "r1",
              tenderId: "t1",
              method: "external",
              amount: 4050,
              reference: "778812",
            },
          ],
        },
      ],
    };
    const text = plain(render({ order: card }));
    expect(text.split("−$40.50").length - 1).toBe(1);
    expect(text).toContain("Reembolso −$40.50");
    expect(text).toContain("1 × Taco de asada $40.50");
    expect(text).toContain("Terminal · Ref. reembolso 778812 $40.50");
  });

  it("a cached (offline) copy shows its total discount in one row", () => {
    const cached = {
      ...order,
      state: "local",
      total: 8100,
      paid: 8100,
      discount: 900,
      tenders: [],
    } as Order;
    const text = plain(render({ order: cached, kind: "local" }));
    expect(text).toContain("Subtotal antes de descuentos $90.00");
    expect(text).toContain("Descuentos −$9.00");
  });

  it("the refund slip prints in Spanish, with the reason label, the people and no fiscal lines without fiscal data", async () => {
    const { RefundSlip } = await import("../src/features/discounts/RefundSlip");
    const text = plain(
      renderToStaticMarkup(
        createElement(RefundSlip, {
          order: discounted,
          batch: discounted.refundBatches![0],
          session,
          locale: "es",
        }),
      ),
    );
    expect(text).toContain("COMPROBANTE DE REEMBOLSO");
    expect(text).toContain("Orden #42");
    expect(text).toContain("1 × Taco de asada $40.50");
    expect(text).toContain("Efectivo $40.50");
    expect(text).toContain("Total reembolsado $40.50");
    expect(text).toContain(
      "Motivo: Producto con defecto o queja · &quot;frío&quot;",
    );
    expect(text).toContain("Registró Ana · autorizó Luis");
    expect(text).toContain("Este comprobante no es una factura (CFDI).");
    expect(text).not.toContain("IVA reembolsado");
    expect(text).not.toContain("Ticket original");
    // With fiscal's order.fiscal (027): the original folio and the IVA line.
    const fiscal = plain(
      renderToStaticMarkup(
        createElement(RefundSlip, {
          order: {
            ...discounted,
            fiscal: {
              ticket: { folio: "A-000123" },
              provisional: null,
              refunds: [
                {
                  refundId: "r1",
                  createdAt: at,
                  businessDate: "2026-10-05",
                  groups: [
                    {
                      category: "iva16",
                      rateBps: 1600,
                      gross: 4050,
                      base: 3491,
                      tax: 559,
                    },
                  ],
                },
              ],
            },
          } as Order,
          batch: discounted.refundBatches![0],
          session,
          locale: "es",
        }),
      ),
    );
    expect(fiscal).toContain("Ticket original: A-000123");
    expect(fiscal).toContain("Importe sin IVA $34.91 · IVA reembolsado $5.59");
  });

  // Rebase I-08: two lines of one product can differ only by options, so every
  // place that names a refunded or discounted line carries its option names.
  describe("option names (I-08)", () => {
    const queso = line({
      id: "lq",
      optionNames: [
        { es: "Salsa verde", en: "Green salsa" },
        { es: "Queso", en: "Cheese" },
      ],
    });
    const sinCebolla = line({
      id: "ls",
      optionNames: [{ es: "Sin cebolla", en: "No onion" }],
    });
    const at = "2026-10-05T18:05:00.000Z";
    const twin: Order = {
      ...order,
      note: "",
      rounds: [],
      lines: [queso, sinCebolla],
      total: 9000,
      paid: 9000,
      refunded: 9000,
      discount: 0,
      tenders: [
        {
          id: "t1",
          method: "cash",
          amount: 9000,
          tip: 0,
          received: 9000,
          refunded: 9000,
          external_reference: null,
        },
      ],
      discounts: [
        {
          id: "d1",
          scope: "line",
          lineId: "ls",
          kind: "comp",
          percentBps: null,
          base: 4500,
          amount: 4500,
          units: 1,
          activeAmount: 4500,
          releasedAmount: 0,
          allocations: [{ lineId: "ls", unit: 0, amount: 4500, voided: false }],
          reasonCode: "courtesy",
          note: "",
          actorName: "Ana",
          approverName: null,
          createdAt: at,
          reversal: null,
        },
      ],
      refundBatches: [
        {
          id: "b1",
          mode: "items",
          amount: 9000,
          cashAmount: 9000,
          externalAmount: 0,
          reasonCode: "wrong_item",
          note: "",
          restock: false,
          actorName: "Ana",
          approverName: "Ana",
          createdAt: at,
          businessDate: "2026-10-05",
          legacy: false,
          rows: [
            {
              refundId: "r1",
              tenderId: "t1",
              method: "cash",
              amount: 9000,
              reference: null,
            },
          ],
          lines: ["lq", "ls"].map((lineId) => ({
            id: "rl-" + lineId,
            lineId,
            units: [0],
            amount: 4500,
            restocked: false,
            preparationState: "completed",
            kitchenPending: false,
          })),
        },
      ],
    } as Order;
    const QUESO = "1 × Taco de asada (Salsa verde, Queso)";
    const SIN = "1 × Taco de asada (Sin cebolla)";

    it("lineLabel appends the option names; a line without options keeps its name", async () => {
      const { lineLabel } = await import("../src/features/discounts/format");
      expect(lineLabel(queso, "es")).toBe("Taco de asada (Salsa verde, Queso)");
      expect(lineLabel(queso, "en")).toBe("Steak taco (Green salsa, Cheese)");
      expect(lineLabel(line({}), "es")).toBe("Taco de asada");
      expect(lineLabel(undefined, "es")).toBe("");
    });

    it("the receipt's refund rows tell the two tacos apart", () => {
      const text = plain(render({ order: twin }));
      // The breakdown under "Reembolso −$90.00" is unsigned (UI-7).
      expect(text).toContain(`${QUESO} $45.00`);
      expect(text).toContain(`${SIN} $45.00`);
    });

    it("the refund slip tells the two tacos apart", async () => {
      const { RefundSlip } =
        await import("../src/features/discounts/RefundSlip");
      const text = plain(
        renderToStaticMarkup(
          createElement(RefundSlip, {
            order: twin,
            batch: twin.refundBatches![0],
            session,
            locale: "es",
          }),
        ),
      );
      expect(text).toContain(`${QUESO} $45.00`);
      expect(text).toContain(`${SIN} $45.00`);
    });

    it("Detalle de orden's Descuentos and Reembolsos and Vender's summary name the line with its options", async () => {
      const { OrderAdjustments, CheckDiscountSummary } =
        await import("../src/features/discounts/OrderAdjustments");
      const props = {
        order: twin,
        session,
        locale: "es" as const,
        money: (n: number) => "$" + (n / 100).toFixed(2),
        online: true,
        changed: () => {},
      };
      const detail = plain(
        renderToStaticMarkup(createElement(OrderAdjustments, props)),
      );
      expect(detail).toContain("Cortesía · Taco de asada (Sin cebolla)");
      expect(detail).toContain(`${QUESO} · $45.00`);
      expect(detail).toContain(`${SIN} · $45.00`);
      const summary = plain(
        renderToStaticMarkup(createElement(CheckDiscountSummary, props)),
      );
      expect(summary).toContain("Cortesía · Taco de asada (Sin cebolla)");
    });
  });
});
