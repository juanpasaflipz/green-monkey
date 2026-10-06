// Reports (029) unit tests 14–18 and 20–23 (spec §7.1): kitchen cancellation chits, the corte
// documents, the summary CSV, the offline corte button and the print language.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Label, Order, PricedLine } from "../shared/domain";
import type { KitchenRound } from "../shared/service";
import type { FiscalSummary } from "../shared/fiscal";
import {
  composeSalesSummary,
  type CorteDocument,
  type DayCorteDocument as DayCorte,
  type SalesSummary,
} from "../shared/reports";
import { CSV_BOM } from "../shared/csv";
import {
  cancellationsFromKitchenRounds,
  cancellationsFromRefund,
  cancellationsFromVoid,
} from "../src/features/printing/cancellations";
import { KitchenCancellationDocument } from "../src/features/printing/KitchenCancellationDocument";
import {
  DayCorteDocument,
  DrawerCorteDocument,
} from "../src/features/reports/documents";
import { CortePrintButton } from "../src/features/reports/CortePrintButton";
import {
  summaryColumns,
  summaryCsvRows,
  toCsv,
} from "../src/features/reports/csv";
import { summarySections } from "../src/features/reports/summary-rows";
import { strings } from "../src/i18n";

const L = (es: string, en = es): Label => ({ es, en });
/** Visible text of server-rendered markup (tags removed, entities decoded, spaces collapsed). */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  text(renderToStaticMarkup(el));

// ---------------------------------------------------------------------------------------------
// Kitchen cancellation chits (FIT-9)
// ---------------------------------------------------------------------------------------------

function round(p: Partial<KitchenRound>): KitchenRound {
  return {
    id: "r1",
    orderId: "o1",
    orderNumber: 142,
    roundNumber: 2,
    station: "kitchen",
    state: "active",
    seenAt: null,
    readyAt: null,
    createdAt: "2026-10-05T20:00:00.000Z",
    orderCreatedAt: "2026-10-05T19:50:00.000Z",
    businessDate: "2026-10-05",
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
        quantity: 3,
        voidedQuantity: 1,
        name: L("Taco de asada", "Steak taco"),
        optionNames: [L("Con todo", "Everything")],
        note: "",
      },
      {
        id: "l2",
        quantity: 1,
        voidedQuantity: 1,
        name: L("Quesadilla"),
        optionNames: [],
        note: "",
      },
    ],
    pendingVoids: [],
    ...p,
  };
}
const pending = (
  id: string,
  lineId: string,
  quantity: number,
  name: Label,
  reason: string,
  kind?: "void" | "refund",
) => ({
  id,
  lineId,
  quantity,
  name,
  reason,
  createdAt: "2026-10-05T20:10:00.000Z",
  ...(kind ? { kind } : {}),
});

describe("kitchen cancellation chits (FIT-9)", () => {
  it("14. FIT-9: cancellationsFromKitchenRounds builds one chit per round with new pending voids only, marked refund when every void is a refund", () => {
    const rounds = [
      round({
        id: "r1",
        pendingVoids: [
          pending(
            "v-old",
            "l1",
            1,
            L("Taco de asada", "Steak taco"),
            "Ya visto",
          ),
          pending(
            "v-new",
            "l1",
            1,
            L("Taco de asada", "Steak taco"),
            "Cliente cambió",
          ),
          pending("v-new2", "l2", 1, L("Quesadilla"), "Cliente cambió"),
        ],
      }),
      round({
        id: "r2",
        roundNumber: 3,
        station: "bar",
        pendingVoids: [pending("v-ref", "l1", 2, L("Agua"), "Queja", "refund")],
      }),
      round({
        id: "r3",
        pendingVoids: [pending("v-seen", "l1", 1, L("Taco"), "Ya visto")],
      }),
    ];
    const chits = cancellationsFromKitchenRounds(
      rounds,
      new Set(["v-new", "v-new2", "v-ref"]),
    );
    expect(chits).toHaveLength(2);
    expect(chits[0]).toEqual({
      kind: "void",
      label: "#142",
      callName: "Mesa 4",
      station: "kitchen",
      round: 2,
      time: "2026-10-05T20:10:00.000Z",
      tableName: "M4",
      reason: "Cliente cambió",
      lines: [
        {
          quantity: 1,
          name: L("Taco de asada", "Steak taco"),
          optionNames: [L("Con todo", "Everything")],
        },
        { quantity: 1, name: L("Quesadilla"), optionNames: [] },
      ],
    });
    expect(chits[1]).toMatchObject({
      kind: "refund",
      station: "bar",
      round: 3,
    });
    // A round mixing a void and a refund cancellation is a void chit.
    const mixed = cancellationsFromKitchenRounds(
      [
        round({
          pendingVoids: [
            pending("a", "l1", 1, L("Taco"), "x", "refund"),
            pending("b", "l2", 1, L("Quesadilla"), "y"),
          ],
        }),
      ],
      new Set(["a", "b"]),
    );
    expect(mixed[0]).toMatchObject({ kind: "void", reason: "x; y" });
    expect(cancellationsFromKitchenRounds(rounds, new Set())).toEqual([]);
  });

  const line = (p: Partial<PricedLine>): PricedLine => ({
    id: "l1",
    productId: "p1",
    quantity: 3,
    options: [],
    note: "",
    name: L("Taco de asada", "Steak taco"),
    optionNames: [],
    unitPrice: 4500,
    total: 13500,
    cost: null,
    station: "kitchen",
    recipe: [],
    productVersion: 1,
    round: 1,
    voidedUnits: [],
    ...p,
  });
  const order = (lines: PricedLine[], p: Partial<Order> = {}): Order => ({
    id: "o1",
    number: 142,
    version: 1,
    mode: "dine_in",
    tableId: "t1",
    tableName: "M4",
    name: "Mesa 4",
    note: "",
    lines,
    total: 0,
    paid: 0,
    refunded: 0,
    state: "active",
    createdAt: "2026-10-05T19:50:00.000Z",
    rounds: [],
    tenders: [],
    ...p,
  });

  const lineVoid = (
    p: Partial<NonNullable<Order["voids"]>[number]>,
  ): NonNullable<Order["voids"]>[number] => ({
    id: "v",
    lineId: "l1",
    quantity: 1,
    amount: 4500,
    reason: "Error de captura",
    stockDisposition: "returned",
    preparationState: "not_started",
    actorName: "Ana",
    approverName: "Mara",
    createdAt: "2026-10-05T20:15:00.000Z",
    kitchenPending: true,
    ...p,
  });

  it("15. FIT-9: cancellationsFromVoid groups the command's kitchen-pending voids by round and station", () => {
    // An earlier void of l1 (unit 2) is still pending in the kitchen: it is not reprinted.
    const earlier = lineVoid({
      id: "v0",
      createdAt: "2026-10-05T20:00:00.000Z",
    });
    const before = order(
      [
        line({ id: "l1", round: 1, station: "kitchen", voidedUnits: [2] }),
        line({ id: "l2", round: 1, station: "bar", name: L("Agua") }),
        line({ id: "l3", round: 2, station: "kitchen", name: L("Pozole") }),
      ],
      { voids: [earlier] },
    );
    const after = order(
      [
        line({
          id: "l1",
          round: 1,
          station: "kitchen",
          voidedUnits: [0, 1, 2],
        }),
        line({
          id: "l2",
          round: 1,
          station: "bar",
          name: L("Agua"),
          voidedUnits: [0],
        }),
        line({ id: "l3", round: 2, station: "kitchen", name: L("Pozole") }),
      ],
      {
        voids: [
          earlier,
          lineVoid({ id: "v1", lineId: "l1", quantity: 2, amount: 9000 }),
          lineVoid({
            id: "v2",
            lineId: "l2",
            createdAt: "2026-10-05T20:14:00.000Z",
          }),
        ],
      },
    );
    const chits = cancellationsFromVoid(before, after, " Error de captura ");
    expect(
      chits.map((c) => [c.round, c.station, c.lines.map((l) => l.quantity)]),
    ).toEqual([
      [1, "bar", [1]],
      [1, "kitchen", [2]],
    ]);
    expect(chits[0]).toMatchObject({
      kind: "void",
      label: "#142",
      reason: "Error de captura",
      time: "2026-10-05T20:15:00.000Z",
      tableName: "M4",
    });
    expect(cancellationsFromVoid(after, after, "x")).toEqual([]);
  });

  it("15b. RPT-R12: a void of a completed (served) round prints no chit, as the KDS shows no pending void for it", () => {
    const before = order([
      line({ id: "l1", round: 1, station: "kitchen" }),
      line({ id: "l2", round: 2, station: "bar", name: L("Agua") }),
    ]);
    const served = lineVoid({ id: "v1", lineId: "l1", kitchenPending: false });
    const afterServed = order(
      [
        line({ id: "l1", round: 1, station: "kitchen", voidedUnits: [0] }),
        line({ id: "l2", round: 2, station: "bar", name: L("Agua") }),
      ],
      { voids: [served] },
    );
    expect(cancellationsFromVoid(before, afterServed, "Ya servido")).toEqual(
      [],
    );
    // One command voiding a served unit and an unserved one prints only the unserved one.
    const afterMixed = order(
      [
        line({ id: "l1", round: 1, station: "kitchen", voidedUnits: [0] }),
        line({
          id: "l2",
          round: 2,
          station: "bar",
          name: L("Agua"),
          voidedUnits: [0, 1],
        }),
      ],
      {
        voids: [
          served,
          lineVoid({ id: "v2", lineId: "l2", quantity: 2, amount: 9000 }),
        ],
      },
    );
    expect(
      cancellationsFromVoid(before, afterMixed, "Error").map((c) => [
        c.round,
        c.station,
        c.lines.map((l) => [l.name.es, l.quantity]),
      ]),
    ).toEqual([[2, "bar", [["Agua", 2]]]]);
  });

  it("16. FIT-9: cancellationsFromRefund prints only kitchen-pending refund lines", () => {
    const o = order([
      line({ id: "l1", round: 1, station: "kitchen" }),
      line({ id: "l2", round: 2, station: "bar", name: L("Agua") }),
      line({ id: "l3", round: 2, station: "bar", name: L("Café") }),
    ]);
    const chits = cancellationsFromRefund(
      o,
      {
        lines: [
          { lineId: "l1", units: [0], kitchenPending: false }, // served: no chit
          { lineId: "l2", units: [0, 1], kitchenPending: true },
          { lineId: "l3", units: [0], kitchenPending: true },
        ],
        createdAt: "2026-10-05T20:30:00.000Z",
      },
      "Producto con defecto o queja · frío",
    );
    expect(chits).toEqual([
      {
        kind: "refund",
        label: "#142",
        callName: "Mesa 4",
        station: "bar",
        round: 2,
        time: "2026-10-05T20:30:00.000Z",
        tableName: "M4",
        reason: "Producto con defecto o queja · frío",
        lines: [
          { quantity: 2, name: L("Agua"), optionNames: [] },
          { quantity: 1, name: L("Café"), optionNames: [] },
        ],
      },
    ]);
    // An amount refund has no lines: nothing prints.
    expect(cancellationsFromRefund(o, { lines: [] }, "x")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Corte documents (FIT-10)
// ---------------------------------------------------------------------------------------------

const restaurant = {
  name: "Taquería Ficticia",
  currency: "MXN",
  timezone: "America/Mexico_City",
};
const fullZ: CorteDocument = {
  kind: "z",
  visibility: "full",
  zNumber: 128,
  printNumber: 2,
  restaurant,
  drawer: {
    id: "d1",
    deviceName: "Caja mostrador",
    openedAt: "2026-10-05T15:02:00.000Z",
    openedByName: "Ana",
    closedAt: "2026-10-06T04:30:00.000Z",
    closedByName: "Luis",
    businessDate: "2026-10-05",
    countMode: "blind",
  },
  printedAt: "2026-10-06T04:40:00.000Z",
  printedByName: "Luis",
  cash: {
    opening: 100_000,
    sales: 425_000,
    tips: 31_000,
    refunds: 9_000,
    paidOuts: 50_000,
    payIns: 0,
    expected: 497_000,
    counted: 495_000,
    difference: -2_000,
    reason: "Faltó cambio",
  },
  counted: 495_000,
  terminal: {
    sales: 612_000,
    count: 23,
    tips: 64_000,
    refunds: 0,
    net: 676_000,
    reported: 676_000,
    difference: 0,
  },
  payments: 41,
  controls: {
    discounts: { count: 2, amount: 12_000 },
    refunds: { count: 1, amount: 9_000 },
    paidOuts: { count: 1, amount: 50_000 },
  },
  folios: [{ series: "A", first: "A-000101", last: "A-000141", count: 41 }],
  lateCash: 1_500,
  lateTerminal: 0,
  review: null,
};
const blindZ: CorteDocument = {
  ...fullZ,
  visibility: "blind",
  printNumber: 1,
  cash: null,
  controls: null,
  folios: [],
  lateCash: 0,
  review: null,
};

describe("corte documents (FIT-10)", () => {
  it("17. FIT-10: the blind DrawerCorteDocument renders no expected cash, cash sales, refunds, paid-outs or difference", () => {
    const out = render(
      createElement(DrawerCorteDocument, { doc: blindZ, locale: "es" }),
    );
    expect(out).toContain("COMPROBANTE DE CONTEO (CORTE CIEGO)");
    expect(out).toContain("Efectivo contado $4,950.00");
    expect(out).toContain("Cobros con terminal (23) $6,120.00");
    expect(out).toContain("Cobros registrados 41");
    expect(out).toContain(
      "El efectivo esperado y la diferencia los revisa un responsable.",
    );
    for (const hidden of [
      "Efectivo esperado",
      "Ventas en efectivo",
      "Reembolsos en efectivo",
      "Retiros",
      "Diferencia (",
      "$4,970.00",
      "$4,250.00",
      "Faltó cambio",
      "Folios",
      "Registrado después del cierre",
    ])
      expect(out).not.toContain(hidden);
  });

  it("18. DrawerCorteDocument Z shows the Z number, Sobrante/Faltante text and REIMPRESIÓN from print 2", () => {
    const out = render(
      createElement(DrawerCorteDocument, { doc: fullZ, locale: "es" }),
    );
    expect(out).toContain("CORTE Z · CIERRE DE CAJA");
    expect(out).toContain("REIMPRESIÓN 2");
    expect(out).toContain("Corte Z núm. 128");
    expect(out).toContain("Efectivo esperado $4,970.00");
    expect(out).toContain("Efectivo contado $4,950.00");
    expect(out).toContain("Diferencia (faltante) -$20.00");
    expect(out).toContain("Explicación: Faltó cambio");
    expect(out).toContain("Conteo: ciego");
    expect(out).toContain("Folios A-000101 a A-000141 (41 tickets)");
    expect(out).toContain("Registrado después del cierre: $15.00");
    expect(out).toContain("Entrega");
    expect(out).toContain("Recibe");
    expect(out).toContain("Documento interno; no es comprobante fiscal.");
    const over = render(
      createElement(DrawerCorteDocument, {
        doc: {
          ...fullZ,
          printNumber: 1,
          cash: { ...fullZ.cash!, counted: 497_500, difference: 500 },
        },
        locale: "es",
      }),
    );
    expect(over).toContain("Diferencia (sobrante) $5.00");
    expect(over).not.toContain("REIMPRESIÓN");
    const exact = render(
      createElement(DrawerCorteDocument, {
        doc: {
          ...fullZ,
          cash: { ...fullZ.cash!, counted: 497_000, difference: 0 },
        },
        locale: "es",
      }),
    );
    expect(exact).toContain("Diferencia (cuadra) $0.00");
    // A corte X is a partial reading of an open drawer.
    const x = render(
      createElement(DrawerCorteDocument, {
        doc: {
          ...fullZ,
          kind: "x",
          zNumber: null,
          printNumber: null,
          drawer: {
            ...fullZ.drawer,
            closedAt: null,
            closedByName: null,
            countMode: null,
          },
          cash: {
            ...fullZ.cash!,
            counted: null,
            difference: null,
            reason: null,
          },
          lateCash: 0,
        },
        locale: "es",
      }),
    );
    expect(x).toContain("CORTE X · LECTURA PARCIAL");
    expect(x).toContain("Lectura parcial: la caja sigue abierta.");
    expect(x).not.toContain("Entrega");
  });

  it("RPT-R20: a second corte X is a new reading, not a reprint; a second count slip is", () => {
    const xDoc: CorteDocument = {
      ...fullZ,
      kind: "x",
      zNumber: null,
      printNumber: 2,
      drawer: {
        ...fullZ.drawer,
        closedAt: null,
        closedByName: null,
        countMode: null,
      },
      cash: { ...fullZ.cash!, counted: null, difference: null, reason: null },
      lateCash: 0,
    };
    for (const locale of ["es", "en"] as const) {
      const out = render(
        createElement(DrawerCorteDocument, {
          doc: { ...xDoc, printNumber: 3 },
          locale,
        }),
      );
      expect(out).not.toContain("REIMPRESIÓN");
      expect(out).not.toContain("REPRINT");
    }
    expect(
      render(createElement(DrawerCorteDocument, { doc: xDoc, locale: "es" })),
    ).not.toContain("REIMPRESIÓN");
    const slip = render(
      createElement(DrawerCorteDocument, {
        doc: { ...blindZ, printNumber: 2 },
        locale: "es",
      }),
    );
    expect(slip).toContain("COMPROBANTE DE CONTEO (CORTE CIEGO)");
    expect(slip).toContain("REIMPRESIÓN 2");
  });
});

// ---------------------------------------------------------------------------------------------
// Summary rows, CSV and the corte del día
// ---------------------------------------------------------------------------------------------

function fiscal(p: Partial<FiscalSummary> = {}): FiscalSummary {
  return {
    from: "2026-10-05",
    to: "2026-10-05",
    tickets: {
      count: 96,
      series: [{ series: "A", first: 101, last: 196, count: 96 }],
    },
    sales: [
      {
        category: "iva16",
        rateBps: 1600,
        grossBeforeDiscount: 2_516_000,
        discount: 62_000,
        gross: 2_454_000,
        base: 2_115_517,
        tax: 338_483,
      },
      {
        category: "iva0",
        rateBps: 0,
        grossBeforeDiscount: 10_000,
        discount: 0,
        gross: 10_000,
        base: 10_000,
        tax: 0,
      },
    ],
    refunds: [
      {
        category: "iva16",
        rateBps: 1600,
        grossBeforeDiscount: 9_000,
        discount: 0,
        gross: 9_000,
        base: 7_759,
        tax: 1_241,
      },
    ],
    net: [],
    totals: {
      gross: 2_464_000,
      base: 2_125_517,
      tax: 338_483,
      tips: 196_000,
      refundGross: 9_000,
      refundTax: 1_241,
      netGross: 2_455_000,
      netBase: 2_117_758,
      netTax: 337_242,
    },
    missingTickets: 0,
    ...p,
  };
}
function summary(tax: FiscalSummary | null): SalesSummary {
  return composeSalesSummary({
    range: { from: "2026-10-05", to: "2026-10-05" },
    currency: "MXN",
    generatedAt: "2026-10-06T06:12:00.000Z",
    currentBusinessDate: "2026-10-06",
    requestId: "req-12345678",
    sales: [
      {
        date: "2026-10-05",
        orders: 98,
        cancelled: 1,
        recoveryCount: 0,
        recoveryTotal: 0,
        ticketedRecoveryGross: 0,
        discounts: 62_000,
        total: 2_478_000,
        paid: 2_454_000,
        tips: 196_000,
        openChecks: 2,
        overpaid: 0,
        ticketed: 96,
        ticketedGross: 2_454_000,
        ticketedOrderTotal: 2_454_000,
        unticketedOpen: 24_000,
        unticketedPaid: 0,
        offlineCount: 3,
        offlineTotal: 42_000,
        offlineTips: 2_000,
      },
    ],
    lines: [
      {
        date: "2026-10-05",
        lineNet: 2_478_000,
        voided: 64_000,
        voidedUnits: 7,
        cancelledAmount: 8_000,
        lineDiscounts: 62_000,
        courtesies: 18_000,
        cogs: 810_000,
        cogsAll: 820_000,
        coveredGross: 2_250_000,
        ticketedLineGross: 2_516_000,
        wasteCost: 3_000,
      },
    ],
    collections: [
      {
        date: "2026-10-05",
        method: "cash",
        count: 61,
        amount: 1_421_000,
        tips: 82_000,
        lateCount: 0,
        lateAmount: 0,
      },
      {
        date: "2026-10-05",
        method: "external",
        count: 37,
        amount: 1_033_000,
        tips: 114_000,
        lateCount: 0,
        lateAmount: 0,
      },
    ],
    refunds: [
      {
        date: "2026-10-05",
        method: "cash",
        count: 1,
        amount: 9_000,
        fiscalAmount: 9_000,
      },
    ],
    restocks: [],
    paidOuts: [{ date: "2026-10-05", count: 1, amount: 50_000 }],
    drawers: [],
    tax,
  });
}

describe("Resumen rows, summary CSV and the corte del día", () => {
  it("20. FIT-7: the summary CSV lists every Resumen row in screen order with section, concept and either an amount or a quantity", () => {
    const s = summary(fiscal());
    const sections = summarySections(s, "es");
    const rows = summaryCsvRows(s, "es");
    expect(rows.map((r) => r.concept)).toEqual(
      sections.flatMap((x) => x.lines.map((l) => l.label)),
    );
    expect([...new Set(rows.map((r) => r.section))]).toEqual([
      "Ventas",
      "IVA de ventas con ticket",
      "Cobros por método",
      "Costo y margen (estimado)",
      "Cajas",
    ]);
    for (const r of rows)
      expect(r.amount !== null && r.quantity !== null).toBe(false);
    const csv = toCsv(summaryColumns, rows, {
      locale: "es",
      currency: "MXN",
      timezone: "America/Mexico_City",
    });
    const lines = csv.slice(CSV_BOM.length).split("\r\n");
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(lines[0]).toBe("Sección,Concepto,Importe,Cantidad");
    expect(lines).toContain("Ventas,Ventas brutas (IVA incluido),25400.00,");
    expect(lines).toContain("Ventas,Descuentos y cortesías,-620.00,");
    expect(lines).toContain("Ventas,Órdenes,,98");
    expect(lines).toContain("IVA de ventas con ticket,Venta IVA 16%,24540.00,");
    expect(lines).toContain("IVA de ventas con ticket,IVA reembolsado,-12.41,");
    expect(lines).toContain(
      "IVA de ventas con ticket,Folios A-000101 a A-000196 (96 tickets),,96",
    );
    expect(lines).toContain("Cobros por método,Retiros de efectivo,-500.00,");
    // The English export uses English headers and labels.
    const en = toCsv(summaryColumns, summaryCsvRows(s, "en"), {
      locale: "en",
      currency: "MXN",
      timezone: "America/Mexico_City",
    });
    expect(en.slice(CSV_BOM.length).split("\r\n")[0]).toBe(
      "Section,Item,Amount,Quantity",
    );
  });

  const dayDoc = (
    tax: FiscalSummary | null,
    extra: Partial<DayCorte> = {},
  ): DayCorte => ({
    date: "2026-10-05",
    restaurant,
    printedAt: "2026-10-06T06:12:00.000Z",
    printedByName: "Luis",
    printNumber: null,
    summary: summary(tax),
    drawers: [],
    drawersOpen: 0,
    otherDayDrawerCollections: 0,
    exceptions: [
      { kind: "void", count: 5, amount: 64_000 },
      { kind: "discount", count: 4, amount: 62_000 },
    ],
    extra: {},
    ...extra,
  });

  it("21. acceptance rows: DayCorteDocument prints one Venta/Base/IVA block per category present and none for an absent category, Base reembolsada, Ventas con ticket después de reembolsos, órdenes anuladas with their amount and ventas sin conexión with tips", () => {
    const out = render(
      createElement(DayCorteDocument, { doc: dayDoc(fiscal()), locale: "es" }),
    );
    expect(out).toContain("CORTE DEL DÍA · 05/10/2026");
    expect(out).toContain("Venta IVA 16% $24,540.00");
    expect(out).toContain("Base IVA 16% $21,155.17");
    expect(out).toContain("IVA 16% $3,384.83");
    expect(out).toContain("Venta a tasa 0% $100.00");
    expect(out).not.toContain("IVA 8%");
    expect(out).not.toContain("Venta exenta");
    expect(out).toContain("Base reembolsada (sin IVA) −$77.59");
    expect(out).toContain("IVA reembolsado −$12.41");
    expect(out).toContain("IVA neto del periodo $3,372.42");
    expect(out).toContain(
      "Ventas con ticket después de reembolsos (IVA incluido) $24,550.00",
    );
    // REPORTS-UI-3: the count stays in the label, the amount only in the value column.
    expect(out).toContain("Órdenes anuladas por completo (1) $80.00");
    expect(out).toContain("Ventas sin conexión (3 · propinas $20.00) $420.00");
    // REPORTS-UI-9: the refund split prints as rows of its own.
    expect(out).toContain("Reembolsos −$90.00 Efectivo −$90.00");
    expect(out).toContain("Folios A-000101 a A-000196 (96 tickets)");
    expect(out).toContain("Anulaciones: 5 · $640.00");
    expect(out).toContain("Cuentas con saldo 2 · $240.00");
    expect(out).toContain("Documento interno; no es comprobante fiscal.");
    // Without fiscal data (non-MXN) the IVA block says so.
    const none = render(
      createElement(DayCorteDocument, { doc: dayDoc(null), locale: "es" }),
    );
    expect(none).toContain(strings.es.reportsTaxUnavailable);
    expect(none).not.toContain("Venta IVA 16%");
    // Open drawers and reprints are flagged.
    const flagged = render(
      createElement(DayCorteDocument, {
        doc: dayDoc(fiscal(), { drawersOpen: 1, printNumber: 3 }),
        locale: "es",
      }),
    );
    expect(flagged).toContain(
      "Hay cajas abiertas; el corte del día puede cambiar.",
    );
    expect(flagged).toContain("REIMPRESIÓN 3");
  });

  it('22. A13.8: CortePrintButton with online=false renders a disabled button described by "Los reportes requieren conexión."', () => {
    const html = renderToStaticMarkup(
      createElement(CortePrintButton, {
        session: {
          id: "s",
          tenantId: "t",
          employeeId: "e",
          name: "Luis",
          role: "manager",
          deviceId: "d",
          expiresAt: "",
          offlineUntil: "",
          csrf: "",
          restaurant: { ...restaurant, cutoff: 240 },
        },
        locale: "es",
        drawerId: "d1",
        label: "Corte X",
        online: false,
      }),
    );
    const button = html.match(/<button[^>]*>Corte X<\/button>/)?.[0] ?? "";
    expect(button).toContain("disabled");
    const describedBy = button.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    const reason = html.match(
      new RegExp(`id="${describedBy}"[^>]*>([^<]+)<`),
    )?.[1];
    expect(reason).toBe("Los reportes requieren conexión.");
    const onlineHtml = renderToStaticMarkup(
      createElement(CortePrintButton, {
        session: {
          id: "s",
          tenantId: "t",
          employeeId: "e",
          name: "Luis",
          role: "manager",
          deviceId: "d",
          expiresAt: "",
          offlineUntil: "",
          csrf: "",
          restaurant: { ...restaurant, cutoff: 240 },
        },
        locale: "es",
        drawerId: "d1",
        label: "Corte X",
      }),
    );
    expect(onlineHtml).not.toContain("disabled");
    expect(onlineHtml).not.toContain("Los reportes requieren conexión.");
  });
});

// ---------------------------------------------------------------------------------------------
// Print language (lead resolution, D17)
// ---------------------------------------------------------------------------------------------

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("print language (D17)", () => {
  it("23. lead resolution (print language): corte documents and cancellation chits render in the locale they receive (es and en); no reports module passes a locale to ReceiptDocument, FiscalReceipt or RefundSlip", () => {
    const es = render(
      createElement(DrawerCorteDocument, { doc: fullZ, locale: "es" }),
    );
    const en = render(
      createElement(DrawerCorteDocument, { doc: fullZ, locale: "en" }),
    );
    expect(es).toContain("CORTE Z · CIERRE DE CAJA");
    expect(en).toContain("Z REPORT · DRAWER CLOSE");
    expect(en).toContain("Internal document; not a tax receipt.");
    expect(en).not.toContain("Documento interno");
    const day = (locale: "es" | "en") =>
      render(
        createElement(DayCorteDocument, {
          doc: {
            date: "2026-10-05",
            restaurant,
            printedAt: "2026-10-06T06:12:00.000Z",
            printedByName: "Luis",
            printNumber: null,
            summary: summary(fiscal()),
            drawers: [],
            drawersOpen: 0,
            otherDayDrawerCollections: 0,
            exceptions: [],
            extra: {},
          },
          locale,
        }),
      );
    expect(day("es")).toContain("CORTE DEL DÍA");
    expect(day("en")).toContain("END-OF-DAY REPORT");
    const chit = {
      kind: "void" as const,
      label: "#142",
      callName: "Mesa 4",
      station: "bar",
      round: 2,
      time: "2026-10-05T20:10:00.000Z",
      tableName: "M4",
      reason: "Cliente cambió",
      lines: [
        { quantity: 1, name: L("Agua fresca", "Fresh water"), optionNames: [] },
      ],
    };
    const chitEs = render(
      createElement(KitchenCancellationDocument, {
        ticket: chit,
        locale: "es",
        timezone: "America/Mexico_City",
      }),
    );
    const chitEn = render(
      createElement(KitchenCancellationDocument, {
        ticket: chit,
        locale: "en",
        timezone: "America/Mexico_City",
      }),
    );
    expect(chitEs).toContain("CANCELACIÓN · NO PREPARAR");
    expect(chitEs).toContain("Ronda 2 · Barra");
    expect(chitEs).toContain("− 1 × Agua fresca");
    expect(chitEs).toContain("Motivo: Cliente cambió");
    expect(chitEn).toContain("CANCELLED · DO NOT PREPARE");
    expect(chitEn).toContain("Fresh water");
    expect(
      render(
        createElement(KitchenCancellationDocument, {
          ticket: { ...chit, kind: "refund" },
          locale: "es",
          timezone: "America/Mexico_City",
        }),
      ),
    ).toContain("REEMBOLSADO · NO PREPARAR");
    // Comprobantes always print in Spanish; reports never renders or re-localizes them.
    const sources = [
      ...files("src/features/reports"),
      ...files("src/features/printing"),
    ].filter((f) => /\.tsx?$/.test(f));
    expect(sources.length).toBeGreaterThan(10);
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      for (const component of [
        "ReceiptDocument",
        "FiscalReceipt",
        "RefundSlip",
      ])
        expect(
          source.includes("<" + component),
          `${file} renders ${component}`,
        ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Transport (LD-15 reports Q1)
// ---------------------------------------------------------------------------------------------

describe("report transport (LD-15 reports Q1)", () => {
  it("report reads and prints count as reachability only: the observer's rule matches /report and /reports/* and nothing else, and the contact it records carries no latency sample", async () => {
    const { REACHABILITY_ONLY_PATHS } = await import("../src/connectivity");
    const { reduceConnectivity, initialConnectivity } =
      await import("../src/offline-policy");
    for (const path of [
      "/report",
      "/report?date=2026-10-05",
      "/reports/summary?from=2026-10-01&to=2026-10-05",
      "/reports/drawers/0b6d0b84-5c6a-4b9f-9a33-8f1f0c2a1f00/corte",
      "/reports/today",
    ])
      expect(REACHABILITY_ONLY_PATHS.test(path), path).toBe(true);
    for (const path of [
      "/orders",
      "/restaurant",
      "/reportsx",
      "/cash/report",
      "/api/reports",
    ])
      expect(REACHABILITY_ONLY_PATHS.test(path), path).toBe(false);
    const before = { ...initialConnectivity(), latencies: [100, 200] };
    const after = reduceConnectivity(before, {
      type: "probe_ok",
      at: 1,
      latencyMs: 0,
    });
    expect(after.latencies).toEqual([100, 200]);
    expect(after.failures).toBe(0);
    expect(after.lastContactAt).toBe(1);
  });

  it("reports_timeout is a 422 domain answer: the client never retries it and it never reads as an outage", async () => {
    const { vi } = await import("vitest");
    const { api, ApiError } = await import("../src/api");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ error: "reports_timeout" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    try {
      const e = await api(
        "/reports/summary?from=2026-10-01&to=2026-10-05",
      ).catch((x) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect({
        code: e.message,
        status: e.status,
        kind: e.kind,
        transient: e.transient,
      }).toEqual({
        code: "reports_timeout",
        status: 422,
        kind: "domain",
        transient: false,
      });
      expect(calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Findings of the phase B UI smoke (axe, rendering)
// ---------------------------------------------------------------------------------------------

describe("report tables and rows (UI smoke findings)", () => {
  it("a table's totals row has one row header and data cells, never an empty column header (axe empty-table-header)", async () => {
    const { DataTable } = await import("../src/features/reports/DataTable");
    const html = renderToStaticMarkup(
      createElement(DataTable<{ id: string; n: number }>, {
        caption: "Prueba",
        locale: "es",
        rows: [{ id: "a", n: 1 }],
        rowKey: (r: { id: string }) => r.id,
        columns: [
          { key: "id", header: "Id", render: (r: { id: string }) => r.id },
          { key: "blank", header: "Vacía", render: () => "" },
          {
            key: "n",
            header: "N",
            numeric: true,
            render: (r: { n: number }) => r.n,
          },
        ],
        totals: ["Total", "", "1"],
      }),
    );
    const foot = html.match(/<tfoot>([\s\S]*)<\/tfoot>/)![1];
    expect(foot.match(/<th[^>]*>/g)).toEqual(['<th scope="row">']);
    expect(foot.match(/<td[^>]*>/g)).toHaveLength(2);
  });

  it('a deduction of zero is 0, never −0: the summary CSV writes 0.00 and the rows never print "-$0.00"', () => {
    const empty = composeSalesSummary({
      range: { from: "2026-10-05", to: "2026-10-05" },
      currency: "MXN",
      generatedAt: "2026-10-05T20:00:00.000Z",
      currentBusinessDate: "2026-10-05",
      sales: [],
      lines: [],
      collections: [],
      refunds: [],
      restocks: [],
      paidOuts: [],
      drawers: [],
      tax: null,
    });
    const rows = summaryCsvRows(empty, "es");
    for (const r of rows)
      if (r.amount !== null)
        expect(Object.is(r.amount, -0), r.concept).toBe(false);
    const csv = toCsv(summaryColumns, rows, {
      locale: "es",
      currency: "MXN",
      timezone: "America/Mexico_City",
    });
    expect(csv).not.toContain("-0.00");
    expect(csv).toContain("Ventas,Descuentos y cortesías,0.00,");
  });
});
