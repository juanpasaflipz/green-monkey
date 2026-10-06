// Fiscal (027) client pieces: the receipt's fiscal blocks (through service's slots), the
// register CSV and the product editor's value helpers.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/offline", async () => ({
  db: (await import("./offline-fake-db")).fakeDb,
}));
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  api: vi.fn(),
}));

import type { Order, Session } from "../shared/domain";
import {
  extractTax,
  orderTaxSummary,
  type FiscalContextView,
  type FiscalTicketView,
  type TicketRow,
} from "../shared/fiscal";
import { ReceiptDocument, setReceiptSlots } from "../src/features/Receipt";
import {
  installFiscalReceipt,
  setFiscalFooterExtra,
} from "../src/features/fiscal/FiscalReceipt";
import {
  clearFiscalContext,
  setFiscalContext,
} from "../src/features/fiscal/context";
import {
  fiscalDraft,
  toProductFiscal,
} from "../src/features/fiscal/ProductFiscalFields";
import {
  TICKET_CSV_COLUMNS,
  ticketsCsv,
  ticketsCsvName,
} from "../src/features/fiscal/csv";
import { fiscalDateTime } from "../src/features/fiscal/format";
import { line } from "./fixtures/fiscal";

const restaurant = {
  name: "Taquería El Güero",
  currency: "MXN",
  timezone: "America/Mexico_City",
  cutoff: 240,
};
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
  restaurant,
};
const issuer = {
  rfc: "EKU9003173C9",
  legalName: "ALIMENTOS EL GÜERO",
  regime: "601",
  regimeName: {
    es: "General de Ley Personas Morales",
    en: "General regime for legal entities",
  },
  postalCode: "06700",
  address: {
    street: "Av. Ficticia 123",
    neighborhood: "Roma Norte",
    municipality: "Cuauhtémoc",
    state: "Ciudad de México",
  },
};
const context: FiscalContextView = {
  version: 1,
  complete: true,
  currencySupported: true,
  issuer,
  tradeName: restaurant.name,
  ticketSeries: "A",
  taxRegion: "general",
  defaultTaxCategory: "iva16",
  borderStimulusValidUntil: "2026-12-31",
};

const taco = line({ total: 9000, quantity: 2 });
const coffee = line({
  total: 18000,
  fiscal: { taxCategory: "iva0" },
  name: { es: "Café en grano", en: "Coffee beans" },
});
const summary = orderTaxSummary({
  lines: [taco, coffee],
  total: 27000,
  ctx: { region: "general", defaultCategory: "iva16" },
});
const ticket: FiscalTicketView = {
  id: "ticket",
  orderId: "order",
  folio: "A-000123",
  series: "A",
  number: 123,
  issuedAt: "2026-10-04T20:32:00.000Z",
  businessDate: "2026-10-04",
  source: "sale",
  selfInvoiceCode: "ABCDEFGH1234",
  issuer: { ...issuer, tradeName: restaurant.name, taxRegion: "general" },
  currency: "MXN",
  grossBeforeDiscount: 27000,
  discount: 0,
  unallocatedDiscount: 0,
  gross: 27000,
  base: summary.base,
  tax: summary.tax,
  tip: 2000,
  basis: "line_snapshot",
  groups: summary.groups,
  lines: [],
  payments: [
    {
      method: "cash",
      amount: 27000,
      tip: 2000,
      reference: null,
      at: "2026-10-04T20:32:00.000Z",
    },
  ],
};
const baseOrder: Order = {
  id: "11111111-1111-4111-8111-111111111111",
  number: 42,
  version: 2,
  mode: "takeaway",
  tableId: null,
  name: "",
  note: "",
  lines: [taco, coffee],
  total: 27000,
  paid: 27000,
  refunded: 0,
  state: "active",
  createdAt: "2026-10-04T20:10:00.000Z",
  rounds: [],
  tenders: [],
  restaurantSnapshot: restaurant,
  fiscal: { ticket, provisional: null, refunds: [] },
};
const render = (
  order: Partial<Order> = {},
  p: Partial<Parameters<typeof ReceiptDocument>[0]> = {},
) =>
  renderToStaticMarkup(
    createElement(ReceiptDocument, {
      order: { ...baseOrder, ...order },
      session,
      locale: "es",
      kind: "receipt",
      ...p,
    }),
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
const money = (n: number) => "$" + (n / 100).toFixed(2);

beforeEach(() => {
  installFiscalReceipt();
  setFiscalContext(context);
});
afterEach(() => {
  setReceiptSlots({});
  setFiscalFooterExtra(null);
  clearFiscalContext();
});

describe("the fiscal blocks of the printed ticket", () => {
  it("MON-1/FIT-6: a ticket prints the issuer, folio, date of issue and the IVA breakdown per category", () => {
    const text = render();
    const iva16 = extractTax(9000, 1600);
    for (const expected of [
      "ALIMENTOS EL GÜERO",
      "RFC: EKU9003173C9",
      "Régimen fiscal: 601 General de Ley Personas Morales",
      "Av. Ficticia 123, Roma Norte, Cuauhtémoc, Ciudad de México",
      "Lugar de expedición: C.P. 06700",
      "Folio: A-000123",
      `Fecha de expedición: ${fiscalDateTime(ticket.issuedAt, restaurant.timezone, "es")}`,
      `Base IVA 16% ${money(iva16.base)}`,
      `IVA 16% ${money(iva16.tax)}`,
      `Venta a tasa 0% ${money(18000)}`,
      "Precios con IVA incluido",
      "Propina voluntaria; no forma parte del total de la venta.",
      "Este ticket no es una factura (CFDI).",
      "¿Necesitas factura? Pídela con el folio A-000123.",
    ])
      expect(text).toContain(expected);
    expect(text).not.toContain("Green Monkey");
    expect(fiscalDateTime(ticket.issuedAt, restaurant.timezone, "es")).toBe(
      "04/10/2026 14:32",
    );
  });

  it("the razón social prints only when it differs from the trade name (accents and case ignored)", () => {
    const same = {
      ...ticket,
      issuer: { ...ticket.issuer!, legalName: "taqueria el guero" },
    };
    const text = render({
      fiscal: { ticket: same, provisional: null, refunds: [] },
    });
    expect(text).not.toContain("taqueria el guero");
    expect(text).toContain("RFC: EKU9003173C9");
  });

  it("a reprint keeps the frozen issuer even after the profile changed", () => {
    setFiscalContext({
      ...context,
      issuer: { ...issuer, rfc: "SAT970701NN3", legalName: "OTRA" },
    });
    const text = render({}, { reprint: true });
    expect(text).toContain("RFC: EKU9003173C9");
    expect(text).not.toContain("SAT970701NN3");
  });

  it("refunds print the refunded IVA", () => {
    const text = render({
      refunded: 4500,
      fiscal: {
        ticket,
        provisional: null,
        refunds: [
          {
            refundId: "r",
            createdAt: "",
            businessDate: "2026-10-04",
            groups: [
              {
                category: "iva16",
                rateBps: 1600,
                gross: 4500,
                base: 3879,
                tax: 621,
              },
            ],
          },
        ],
      },
    });
    expect(text).toContain("IVA reembolsado −$6.21");
  });

  it("variants without a ticket: partial payment, paid without folio, offline local receipt, pre-bill", () => {
    const provisional = summary;
    const partial = render({
      paid: 10000,
      fiscal: { ticket: null, provisional, refunds: [] },
    });
    expect(partial).toContain(
      "Comprobante de pago parcial. El ticket con folio se emite al liquidar la cuenta.",
    );
    expect(partial).toContain("RFC: EKU9003173C9");
    expect(partial).not.toContain("Folio:");
    expect(partial).toContain("Precios con IVA incluido");
    expect(partial).not.toContain("Base IVA");
    expect(
      render({ fiscal: { ticket: null, provisional, refunds: [] } }),
    ).toContain(
      "Sin folio fiscal. Un gerente puede emitir los tickets faltantes en Configuración.",
    );
    expect(
      render(
        { state: "local", fiscal: undefined },
        { kind: "local", label: "Número provisional A-01" },
      ),
    ).toContain("Folio fiscal pendiente: se asigna al sincronizar.");
    const check = render(
      { paid: 0, fiscal: { ticket: null, provisional, refunds: [] } },
      { kind: "check" },
    );
    expect(check).toContain("IVA incluido en la cuenta");
    expect(check).toContain(`IVA 16% ${money(extractTax(9000, 1600).tax)}`);
    expect(check).not.toContain("RFC:");
    expect(check).not.toContain("Folio");
  });

  it("an incomplete profile prints 'Ticket sin datos fiscales del emisor.' in place of the issuer", () => {
    setFiscalContext({ ...context, complete: false, issuer: null });
    expect(
      render({ fiscal: { ticket: null, provisional: summary, refunds: [] } }),
    ).toContain("Ticket sin datos fiscales del emisor.");
    expect(
      render({
        fiscal: {
          ticket: { ...ticket, issuer: null },
          provisional: null,
          refunds: [],
        },
      }),
    ).toContain("Ticket sin datos fiscales del emisor. Folio: A-000123");
  });

  it("non-MXN restaurants print no fiscal block", () => {
    const text = render({
      restaurantSnapshot: { ...restaurant, currency: "USD" },
      fiscal: { ticket: null, provisional: summary, refunds: [] },
    });
    expect(text).not.toContain("IVA");
    expect(text).not.toContain("RFC");
  });

  it("cfdi's footer extra replaces the self-invoice line; the screen copy follows the UI language", () => {
    setFiscalFooterExtra(() => createElement("p", null, "Factura en línea"));
    const text = render();
    expect(text).toContain("Factura en línea");
    expect(text).not.toContain("Pídela con el folio");
    setFiscalFooterExtra(null);
    const english = render({}, { locale: "en" });
    expect(english).toContain("Ticket no.: A-000123");
    expect(english).toContain("Prices include VAT");
  });
});

describe("register CSV (LD-16 L13)", () => {
  const row: TicketRow = {
    id: "t1",
    orderId: "o1",
    orderNumber: 42,
    folio: "A-000123",
    issuedAt: "2026-10-04T20:32:00.000Z",
    businessDate: "2026-10-04",
    gross: 27000,
    base: summary.base,
    tax: summary.tax,
    discount: 0,
    tip: 2000,
    groups: summary.groups.map((g) => ({
      category: g.category,
      rateBps: g.rateBps,
      gross: g.gross,
      base: g.base,
      tax: g.tax,
    })),
    refundGross: 4500,
    refundTax: 621,
    payments: [
      { method: "cash", amount: 20000 },
      { method: "external", amount: 7000 },
    ],
    selfInvoiceCode: "ABCDEFGH1234",
    source: "sale",
  };

  it("ticketsCsv: BOM, Spanish headers, dot decimals, one column per category", () => {
    const text = ticketsCsv([row], "America/Mexico_City");
    expect(text.startsWith("﻿")).toBe(true);
    const [header, record] = text.slice(1).split("\r\n");
    expect(header).toBe(
      "folio,serie,numero,fecha_expedicion,dia_negocio,orden,total,base_iva16,iva16,base_iva8,iva8,venta_tasa0,venta_exenta,descuentos,propinas,reembolsos,iva_reembolsado,formas_pago,codigo_facturacion",
    );
    expect(TICKET_CSV_COLUMNS.length).toBe(19);
    const iva16 = extractTax(9000, 1600);
    expect(record).toBe(
      [
        "A-000123",
        "A",
        "123",
        "2026-10-04 14:32",
        "2026-10-04",
        "42",
        "270.00",
        (iva16.base / 100).toFixed(2),
        (iva16.tax / 100).toFixed(2),
        "0.00",
        "0.00",
        "180.00",
        "0.00",
        "0.00",
        "20.00",
        "45.00",
        "6.21",
        "Efectivo 200.00; Terminal bancaria externa 70.00",
        "ABCDEFGH1234",
      ].join(","),
    );
    expect(text.endsWith("\r\n")).toBe(true);
    expect(ticketsCsvName("2026-10-04", "2026-10-04")).toBe(
      "tickets_2026-10-04_2026-10-04.csv",
    );
  });
});

describe("product editor fiscal value", () => {
  it("toProductFiscal: malformed or missing values fall back to defaultProductFiscal()", () => {
    const fallback = {
      taxCategory: "default",
      satProductKey: null,
      satUnitKey: null,
    };
    for (const value of [
      undefined,
      null,
      "iva16",
      { taxCategory: "iva21" },
      { taxCategory: "iva0", extra: true },
      { satProductKey: "123" },
    ])
      expect(toProductFiscal(value)).toEqual(fallback);
    expect(toProductFiscal({ taxCategory: "iva0" })).toEqual({
      ...fallback,
      taxCategory: "iva0",
    });
  });

  it("fiscalDraft keeps a SAT key while it is being typed, so the field never resets", () => {
    expect(fiscalDraft({ taxCategory: "iva0", satProductKey: "123" })).toEqual({
      taxCategory: "iva0",
      satProductKey: "123",
      satUnitKey: null,
    });
    expect(fiscalDraft(undefined)).toEqual(toProductFiscal(undefined));
  });
});
