import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Order, PricedLine, Session } from "../shared/domain";
import { ReceiptDocument, setReceiptSlots } from "../src/features/Receipt";
import { tenderMethodLabel } from "../src/labels";

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
