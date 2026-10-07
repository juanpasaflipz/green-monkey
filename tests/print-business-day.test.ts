// LD-44 (POL-8 / POL-R3-2): printed kitchen paper names an order from another business day
// with its date, as the screens do (LD-29): the comanda (KDS auto-print and "Imprimir
// comanda", Selling's send and note reprint, Órdenes' detail reprint, the QR inbox accept)
// and the cancellation chit (KDS, void, item refund). Same helper as the screens
// (orderNumberLabel), so "#10 · 5 oct" (es) / "#10 · Oct 5" (en), and today's #10 stays "#10".
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Label, Order, PricedLine } from "../shared/domain";
import type { KitchenRound } from "../shared/service";
import {
  KitchenTicketDocument,
  ticketFromKitchenRound,
  ticketsForOpenRounds,
  ticketsFromOrderRound,
  type KitchenTicketModel,
} from "../src/features/KitchenTicket";
import {
  cancellationsFromKitchenRounds,
  cancellationsFromRefund,
  cancellationsFromVoid,
  type KitchenCancellationModel,
} from "../src/features/printing/cancellations";
import { KitchenCancellationDocument } from "../src/features/printing/KitchenCancellationDocument";

const L = (es: string, en = es): Label => ({ es, en });
const zone = "America/Mexico_City";
const yesterday = "2026-10-05";
const today = "2026-10-06";
/** Visible text of server-rendered markup (tags removed, spaces collapsed). */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const comanda = (ticket: KitchenTicketModel, locale: "es" | "en" = "es") =>
  text(
    renderToStaticMarkup(
      createElement(KitchenTicketDocument, { ticket, locale, timezone: zone }),
    ),
  );
const chit = (ticket: KitchenCancellationModel, locale: "es" | "en" = "es") =>
  text(
    renderToStaticMarkup(
      createElement(KitchenCancellationDocument, {
        ticket,
        locale,
        timezone: zone,
      }),
    ),
  );

function kitchenRound(businessDate: string): KitchenRound {
  return {
    id: "r1",
    orderId: "o1",
    orderNumber: 10,
    roundNumber: 2,
    station: "kitchen",
    state: "active",
    seenAt: null,
    readyAt: null,
    createdAt: "2026-10-06T15:00:00.000Z",
    orderCreatedAt: "2026-10-06T02:00:00.000Z",
    businessDate,
    mode: "dine_in",
    channel: "pos",
    callName: "Mesa 4",
    tableName: "M4",
    waiterName: "Sara",
    serviceUpdated: false,
    orderNote: "",
    roundNote: "",
    lines: [
      {
        id: "l1",
        quantity: 2,
        voidedQuantity: 0,
        name: L("Taco de hongos", "Mushroom taco"),
        optionNames: [],
        note: "",
      },
    ],
    pendingVoids: [
      {
        id: "v1",
        lineId: "l1",
        quantity: 1,
        name: L("Taco de hongos", "Mushroom taco"),
        reason: "Error de captura",
        createdAt: "2026-10-06T15:05:00.000Z",
      },
    ],
  };
}
const line = (p: Partial<PricedLine>): PricedLine => ({
  id: "l1",
  productId: "p1",
  quantity: 2,
  options: [],
  note: "",
  name: L("Taco de hongos", "Mushroom taco"),
  optionNames: [],
  unitPrice: 4500,
  total: 9000,
  cost: null,
  station: "kitchen",
  recipe: [],
  productVersion: 1,
  round: 2,
  voidedUnits: [],
  ...p,
});
const order = (businessDate: string | undefined, p: Partial<Order> = {}) =>
  ({
    id: "o1",
    number: 10,
    version: 3,
    mode: "dine_in",
    tableId: "t1",
    tableName: "M4",
    name: "Mesa 4",
    note: "",
    lines: [line({})],
    total: 9000,
    paid: 0,
    refunded: 0,
    state: "active",
    createdAt: "2026-10-06T02:00:00.000Z",
    rounds: [
      {
        number: 2,
        station: "kitchen",
        state: "active",
        note: "",
        created_at: "2026-10-06T15:00:00.000Z",
      },
    ],
    tenders: [],
    ...(businessDate ? { businessDate } : {}),
    ...p,
  }) as Order;

describe("printed kitchen paper names the business date of an order from another day (LD-44)", () => {
  const es = { today, locale: "es" as const };
  const en = { today, locale: "en" as const };

  it("the comanda: KDS rounds, a sent round and the note reprint", () => {
    expect(ticketFromKitchenRound(kitchenRound(yesterday), es).label).toBe(
      "#10 · 5 oct",
    );
    expect(
      comanda(ticketFromKitchenRound(kitchenRound(yesterday), es)),
    ).toMatch(/^#10 · 5 oct Mesa 4 Ronda 2/);
    expect(
      comanda(ticketFromKitchenRound(kitchenRound(yesterday), en), "en"),
    ).toMatch(/^#10 · Oct 5 Mesa 4 Round 2/);
    // Today's #10 prints its plain number.
    expect(comanda(ticketFromKitchenRound(kitchenRound(today), es))).toMatch(
      /^#10 Mesa 4 Ronda 2/,
    );
    const sent = ticketsFromOrderRound(order(yesterday), 2, es);
    expect(sent.map((t) => t.label)).toEqual(["#10 · 5 oct"]);
    expect(comanda(sent[0])).toMatch(/^#10 · 5 oct Mesa 4/);
    expect(
      ticketsFromOrderRound(order(today), 2, es).map((t) => t.label),
    ).toEqual(["#10"]);
    expect(
      ticketsForOpenRounds(order(yesterday), en).map((t) => t.label),
    ).toEqual(["#10 · Oct 5"]);
    // An order without a business date (an older cached copy) keeps "#10".
    expect(
      ticketsFromOrderRound(order(undefined), 2, es).map((t) => t.label),
    ).toEqual(["#10"]);
  });

  it("the cancellation chit: KDS auto-print, a void and an item refund", () => {
    const fromKds = cancellationsFromKitchenRounds(
      [kitchenRound(yesterday)],
      new Set(["v1"]),
      es,
    );
    expect(fromKds.map((c) => c.label)).toEqual(["#10 · 5 oct"]);
    expect(chit(fromKds[0])).toContain("#10 · 5 oct Mesa 4");
    expect(
      cancellationsFromKitchenRounds(
        [kitchenRound(today)],
        new Set(["v1"]),
        es,
      ).map((c) => c.label),
    ).toEqual(["#10"]);

    const before = order(yesterday, { voids: [] });
    const after = order(yesterday, {
      lines: [line({ voidedUnits: [0] })],
      voids: [
        {
          id: "v1",
          lineId: "l1",
          quantity: 1,
          amount: 4500,
          reason: "Error de captura",
          stockDisposition: "returned",
          preparationState: "not_started",
          actorName: "Ana",
          approverName: null,
          createdAt: "2026-10-06T15:05:00.000Z",
          kitchenPending: true,
        },
      ],
    } as Partial<Order>);
    const voided = cancellationsFromVoid(before, after, "Error de captura", en);
    expect(voided.map((c) => c.label)).toEqual(["#10 · Oct 5"]);
    expect(chit(voided[0], "en")).toContain("#10 · Oct 5 Mesa 4");

    const refunded = cancellationsFromRefund(
      order(yesterday),
      { lines: [{ lineId: "l1", units: [0], kitchenPending: true }] },
      "Producto con defecto o queja",
      es,
    );
    expect(refunded.map((c) => c.label)).toEqual(["#10 · 5 oct"]);
    expect(chit(refunded[0])).toContain("#10 · 5 oct Mesa 4");
    expect(
      cancellationsFromRefund(
        order(today),
        { lines: [{ lineId: "l1", units: [0], kitchenPending: true }] },
        "x",
        es,
      ).map((c) => c.label),
    ).toEqual(["#10"]);
  });

  it("every print call site passes the restaurant's current business day (the screens' helper)", () => {
    // Kitchen: the feed's currentBusinessDate, as its ticket headers.
    const kitchen = readFileSync("src/features/Kitchen.tsx", "utf8");
    expect(
      kitchen.match(/ticketFromKitchenRound\(\w+, \{\s*today: [^,]+,/g),
    ).toEqual([
      expect.stringContaining("today: r.currentBusinessDate,"),
      expect.stringContaining("today: feed?.currentBusinessDate,"),
    ]);
    expect(kitchen).toMatch(
      /cancellationsFromKitchenRounds\(voided, newVoidIds, \{\s*today: r\.currentBusinessDate,/,
    );
    // Selling, Órdenes' detail, the dialogs and the QR inbox: currentBusinessDate.
    for (const [file, calls] of [
      ["src/features/Selling.tsx", 1],
      ["src/features/OrderDetail.tsx", 1],
      ["src/features/VoidDialog.tsx", 1],
      ["src/features/RefundDialog.tsx", 1],
      ["src/features/public/PublicOrderInbox.tsx", 1],
    ] as const) {
      const source = readFileSync(file, "utf8");
      const days = source.match(
        /today: (?:today \|\| )?currentBusinessDate\(session\.restaurant\),\s*locale\b/g,
      );
      expect(days?.length ?? 0, file).toBeGreaterThanOrEqual(calls);
    }
  });
});
