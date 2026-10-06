// cfdi (030) unit tests, CFDI core: request builders (spec §7.1 tests 9-14, plus the arithmetic
// proof 15 and the egreso bound 15d they rely on), the XML amount parser (16) and the Facturapi
// error classifier (20). Pure: no database, no network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DomainError } from "../shared/domain";
import {
  extractTax,
  refundTaxSplit,
  TAX_CATEGORIES,
  TAX_RULES,
  type RefundTaxView,
  type TaxCategory,
} from "../shared/fiscal";
import {
  buildEgresoRequest,
  buildGlobalRequests,
  buildInvoiceRequest,
  canonicalTax,
  conceptCentavos,
  GLOBAL_MAX_CONCEPTS,
  netGroups,
  pesos,
  taxFor,
  type EgresoBuildInput,
  type GlobalTicket,
  type InvoiceBuildInput,
} from "../server/cfdi/build";
import {
  needsCardForm,
  paymentFormFor,
  usoCfdiAllowed,
  type Receptor,
} from "../shared/cfdi";
import { classifyFacturapiError } from "../server/cfdi/errors";
import { FacturapiError } from "../server/cfdi/facturapi";
import { invoiceInput } from "../server/cfdi/facturapi-schema";
import {
  CfdiXmlError,
  decimalToCentavos,
  parseCfdiTotals,
} from "../server/cfdi/xml";
import {
  cfdiPayload,
  fakeId,
  ISSUER_POSTAL_CODE,
  recordRefunds,
  RECEPTOR_FISICA,
  RECEPTOR_MORAL,
  taxedLine,
} from "./fixtures/cfdi";
import { rng } from "./fixtures/fiscal";

const DOC = "0b6a1a8e-3f1e-4c55-9d1e-2f6d1c0a9b11";
const SUBSTITUTED = "39c85a3f-275b-4341-b259-e8971d9f8a94";
const border = {
  region: "border_north" as const,
  defaultCategory: "iva8" as const,
};
const CODE = /^[a-z][a-z0-9_]{1,63}$/;

function domainError(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error("expected a DomainError");
}

function invoiceInputFor(
  over: Partial<InvoiceBuildInput> = {},
): InvoiceBuildInput {
  return {
    docId: DOC,
    payload: cfdiPayload({
      lines: [
        taxedLine(11600, "iva16"),
        taxedLine(5000, "iva0"),
        taxedLine(2000, "exempt"),
      ],
      payments: [
        { method: "external", amount: 12000 },
        { method: "cash", amount: 6600 },
      ],
    }),
    receptor: RECEPTOR_MORAL,
    settings: {
      conceptMode: "grouped",
      conceptDescription: "Consumo de alimentos y bebidas",
    },
    issuerPostalCode: ISSUER_POSTAL_CODE,
    cardForm: "04",
    timezone: "America/Mexico_City",
    ...over,
  };
}

const IVA16 = { type: "IVA", rate: 0.16, factor: "Tasa", withholding: false };
const IVA8 = { type: "IVA", rate: 0.08, factor: "Tasa", withholding: false };
const IVA0 = { type: "IVA", rate: 0, factor: "Tasa", withholding: false };
const EXENTO = { type: "IVA", rate: 0, factor: "Exento", withholding: false };

// ---------------------------------------------------------------------------------------------
// Catalog rules the builders use (local until shared/cfdi.ts and shared/sat.ts land)
// ---------------------------------------------------------------------------------------------

describe("catalog (local copy of spec §4.2)", () => {
  it("usoCfdiAllowed: G01/G02/G03 only for business regimes; S01 for every receptor regime; 616 allows only S01; unknown uses are false", () => {
    for (const use of ["G01", "G02", "G03"]) {
      expect(usoCfdiAllowed("601", use)).toBe(true);
      expect(usoCfdiAllowed("626", use)).toBe(true);
      expect(usoCfdiAllowed("605", use)).toBe(false);
      expect(usoCfdiAllowed("616", use)).toBe(false);
    }
    for (const regime of ["601", "605", "616", "626"])
      expect(usoCfdiAllowed(regime, "S01")).toBe(true);
    expect(usoCfdiAllowed("601", "CP01")).toBe(false);
    expect(usoCfdiAllowed("601", "toString")).toBe(false);
  });

  it("paymentFormFor: the largest amount wins, ties take the earliest tender, external maps to the card form; needsCardForm only when a card decides", () => {
    expect(paymentFormFor([{ method: "cash", amount: 100 }], "04")).toBe("01");
    expect(paymentFormFor([{ method: "external", amount: 100 }], "28")).toBe(
      "28",
    );
    expect(
      paymentFormFor(
        [
          { method: "cash", amount: 60 },
          { method: "external", amount: 50 },
          { method: "external", amount: 20 },
        ],
        "04",
      ),
    ).toBe("04");
    expect(
      paymentFormFor(
        [
          { method: "external", amount: 50 },
          { method: "cash", amount: 50 },
        ],
        "28",
      ),
    ).toBe("28");
    expect(
      paymentFormFor(
        [
          { method: "cash", amount: 50 },
          { method: "external", amount: 50 },
        ],
        "28",
      ),
    ).toBe("01");
    expect(paymentFormFor([], "04")).toBe("01");
    expect(needsCardForm([{ method: "cash", amount: 10 }])).toBe(false);
    expect(
      needsCardForm([
        { method: "cash", amount: 10 },
        { method: "external", amount: 11 },
      ]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Arithmetic the tax-inclusive strategy relies on (spec §4.3)
// ---------------------------------------------------------------------------------------------

describe("amount strategy", () => {
  it("15. MON-1 regression: for every gross 1..200,000 centavos at 16% and 8%, round2(G/(1+r)) + round2(G·r/(1+r)) = G and round2(G·r/(1+r)) = extractTax(G).tax (no rounding ties exist)", () => {
    for (const r of [1600, 800]) {
      const d = 10000 + r;
      for (let g = 1; g <= 200_000; g++) {
        // Exact half-way would need 2·G·r ≡ d (mod 2d), and likewise for the base.
        expect((2 * g * r) % (2 * d) === d).toBe(false);
        expect((2 * g * 10000) % (2 * d) === d).toBe(false);
        const tax = Math.floor((2 * g * r + d) / (2 * d));
        const base = Math.floor((2 * g * 10000 + d) / (2 * d));
        if (base + tax !== g || tax !== extractTax(g, r).tax)
          throw new Error(`G=${g} r=${r}`);
      }
    }
  });

  it("pesos, taxFor and conceptCentavos are exact", () => {
    expect(pesos(10776)).toBe(107.76);
    expect(pesos(1)).toBe(0.01);
    expect(pesos(123456789)).toBe(1234567.89);
    expect(taxFor("iva16")).toEqual(IVA16);
    expect(taxFor("iva8")).toEqual(IVA8);
    expect(taxFor("iva0")).toEqual(IVA0);
    expect(taxFor("exempt")).toEqual(EXENTO);
    expect(conceptCentavos({ quantity: 1, product: { price: 107.76 } })).toBe(
      10776,
    );
    expect(conceptCentavos({ quantity: 3, product: { price: 3.33 } })).toBe(
      999,
    );
    expect(
      conceptCentavos({ quantity: 3, product: { price: 33.333333 } }),
    ).toBe(10000);
    expect(conceptCentavos({ quantity: 7, product: { price: 0.142857 } })).toBe(
      100,
    );
  });

  it("netGroups uses fiscal's figures (ticket group − adjustments), drops categories netted to zero and refuses inconsistent data", () => {
    const groups = [
      { category: "iva16" as const, gross: 11600, tax: 1600 },
      { category: "iva0" as const, gross: 5000, tax: 0 },
    ];
    expect(
      netGroups(groups, [
        {
          refundId: "r1",
          groups: [{ category: "iva16", gross: 5801, tax: 800 }],
        },
        { refundId: "r2", groups: [{ category: "iva0", gross: 5000, tax: 0 }] },
      ]),
    ).toEqual([{ category: "iva16", gross: 5799, tax: 800 }]);
    expect(netGroups(groups, [])).toEqual(groups);
    expect(
      domainError(() =>
        netGroups(groups, [
          { refundId: "r", groups: [] },
          { refundId: "r", groups: [] },
        ]),
      ).code,
    ).toBe("cfdi_refund_netted_twice");
    expect(
      domainError(() =>
        netGroups([{ category: "iva16", gross: 100, tax: 101 }], []),
      ).code,
    ).toBe("fiscal_total_mismatch");
    expect(
      domainError(() =>
        netGroups([{ category: "exempt", gross: 100, tax: 1 }], []),
      ).code,
    ).toBe("fiscal_total_mismatch");
    expect(
      domainError(() =>
        netGroups(groups, [
          {
            refundId: "r",
            groups: [{ category: "iva16", gross: 100, tax: 1700 }],
          },
        ]),
      ).code,
    ).toBe("fiscal_total_mismatch");
  });

  it("netGroups refuses an over-refund, a refund of a category the ticket lacks and IVA left on a zero net instead of dropping them (CFDI-ADV-1)", () => {
    const mismatchOf = (
      groups: Parameters<typeof netGroups>[0],
      netted: Parameters<typeof netGroups>[1],
    ) => domainError(() => netGroups(groups, netted)).code;
    const ticket = [
      { category: "iva16" as const, gross: 1000, tax: 138 },
      { category: "iva0" as const, gross: 500, tax: 0 },
    ];
    // (a) iva16 refunded beyond the sale: never an invoice for the iva0 part only.
    expect(
      mismatchOf(ticket, [
        {
          refundId: "r1",
          groups: [{ category: "iva16", gross: 1200, tax: 166 }],
        },
      ]),
    ).toBe("fiscal_total_mismatch");
    // (b) a refund in a category the ticket never sold: never the full ticket with r1 "netted".
    expect(
      mismatchOf(
        [{ category: "iva16", gross: 1000, tax: 138 }],
        [
          {
            refundId: "r1",
            groups: [{ category: "iva0", gross: 100, tax: 0 }],
          },
        ],
      ),
    ).toBe("fiscal_total_mismatch");
    // (c) the gross nets to zero but one centavo of IVA is left.
    expect(
      mismatchOf(
        [{ category: "iva16", gross: 1000, tax: 138 }],
        [
          {
            refundId: "r1",
            groups: [{ category: "iva16", gross: 1000, tax: 137 }],
          },
        ],
      ),
    ).toBe("fiscal_total_mismatch");
    // The reverse: more IVA refunded than charged on a zero net.
    expect(
      mismatchOf(
        [{ category: "iva16", gross: 1000, tax: 138 }],
        [
          {
            refundId: "r1",
            groups: [{ category: "iva16", gross: 1000, tax: 139 }],
          },
        ],
      ),
    ).toBe("fiscal_total_mismatch");
    // Net IVA above the net gross, and IVA on a 0 % or exempt adjustment.
    expect(
      mismatchOf(ticket, [
        { refundId: "r1", groups: [{ category: "iva16", gross: 990, tax: 0 }] },
      ]),
    ).toBe("fiscal_total_mismatch");
    expect(
      mismatchOf(ticket, [
        { refundId: "r1", groups: [{ category: "iva0", gross: 100, tax: 1 }] },
      ]),
    ).toBe("fiscal_total_mismatch");
    // An exact full refund of a category is still dropped (0 / 0), the rest is invoiced.
    expect(
      netGroups(ticket, [
        {
          refundId: "r1",
          groups: [{ category: "iva16", gross: 1000, tax: 138 }],
        },
      ]),
    ).toEqual([{ category: "iva0", gross: 500, tax: 0 }]);
    // A fully discounted category on the ticket (0 / 0) is not an error and not a concept.
    expect(
      netGroups(
        [
          { category: "iva16", gross: 0, tax: 0 },
          { category: "iva0", gross: 500, tax: 0 },
        ],
        [],
      ),
    ).toEqual([{ category: "iva0", gross: 500, tax: 0 }]);

    // The builders refuse the same data, so no request is ever built from it.
    const payload = invoiceInputFor().payload; // iva16 116.00, iva0 50.00, exempt 20.00
    const refund = (
      groups: { category: TaxCategory; gross: number; tax: number }[],
    ): RefundTaxView => ({
      refundId: fakeId(),
      createdAt: "2026-10-05T20:00:00.000Z",
      businessDate: "2026-10-05",
      groups: groups.map((g) => ({
        ...g,
        rateBps: TAX_RULES[g.category].rateBps,
        base: g.gross - g.tax,
      })),
    });
    for (const refunds of [
      [refund([{ category: "iva16", gross: 12000, tax: 1655 }])],
      [refund([{ category: "iva8", gross: 1080, tax: 80 }])],
      [refund([{ category: "iva16", gross: 11600, tax: 1599 }])],
    ])
      expect(
        domainError(() =>
          buildInvoiceRequest(
            invoiceInputFor({ payload: { ...payload, refunds } }),
          ),
        ).code,
      ).toBe("fiscal_total_mismatch");
    // A ticket whose groups do not add up to its own totals is refused too.
    for (const ticket of [
      { ...payload.ticket, gross: payload.ticket.gross + 1 },
      { ...payload.ticket, tax: payload.ticket.tax - 1 },
    ])
      expect(
        domainError(() =>
          buildInvoiceRequest(
            invoiceInputFor({ payload: { ...payload, ticket } }),
          ),
        ).code,
      ).toBe("fiscal_total_mismatch");
    // Globals and credit notes apply the same per-figure rules.
    expect(
      domainError(() =>
        buildGlobalRequests({
          docIds: () => fakeId(),
          tickets: [
            {
              id: fakeId(),
              folio: "A-000001",
              groups: [{ category: "iva0", gross: 500, tax: 1 }],
              payments: [{ method: "cash", amount: 500 }],
            },
          ],
          period: { periodicity: "day", months: "10", year: 2026 },
          issuerPostalCode: ISSUER_POSTAL_CODE,
          cardForm: "04",
        }),
      ).code,
    ).toBe("fiscal_total_mismatch");
    expect(
      domainError(() =>
        buildGlobalRequests({
          docIds: () => fakeId(),
          tickets: [
            {
              id: fakeId(),
              folio: "A-000001",
              groups: [
                { category: "iva16", gross: 1160, tax: 160 },
                { category: "iva16", gross: 1160, tax: 160 },
              ],
              payments: [{ method: "cash", amount: 2320 }],
            },
          ],
          period: { periodicity: "day", months: "10", year: 2026 },
          issuerPostalCode: ISSUER_POSTAL_CODE,
          cardForm: "04",
        }),
      ).code,
    ).toBe("fiscal_total_mismatch");
    expect(
      domainError(() =>
        buildEgresoRequest({
          docId: DOC,
          folio: "A-000123",
          parent: {
            kind: "global",
            uuid: SUBSTITUTED,
            receptor: null,
            paymentForm: "01",
          },
          refund: {
            method: "cash",
            groups: [{ category: "exempt", gross: 100, tax: 1 }],
          },
          issuerPostalCode: ISSUER_POSTAL_CODE,
          cardForm: "04",
        }),
      ).code,
    ).toBe("fiscal_total_mismatch");
  });

  it("netGroups property (seeded, 2,000 cases): Σ net gross = ticket gross − netted refund gross and Σ net IVA = ticket IVA − refund IVA, or it refuses; fiscal's own refund splits are never refused", () => {
    const random = rng(2027);
    const sumOf = (rows: readonly { gross: number; tax: number }[]) =>
      rows.reduce(
        (s, r) => ({ gross: s.gross + r.gross, tax: s.tax + r.tax }),
        {
          gross: 0,
          tax: 0,
        },
      );
    type Refund = Parameters<typeof netGroups>[1][number];
    const holds = (
      groups: Parameters<typeof netGroups>[0],
      netted: readonly Refund[],
      net: ReturnType<typeof netGroups>,
    ) => {
      const ticket = sumOf(groups);
      const refunded = sumOf(netted.flatMap((r) => r.groups));
      expect(sumOf(net)).toEqual({
        gross: ticket.gross - refunded.gross,
        tax: ticket.tax - refunded.tax,
      });
      for (const g of net) {
        expect(groups.some((t) => t.category === g.category)).toBe(true);
        expect(g.gross).toBeGreaterThan(0);
        expect(g.tax).toBeGreaterThanOrEqual(0);
        expect(g.tax).toBeLessThanOrEqual(g.gross);
        if (!TAX_RULES[g.category].rateBps) expect(g.tax).toBe(0);
      }
    };
    let refused = 0;
    for (let n = 0; n < 2000; n++) {
      const categories = TAX_CATEGORIES.filter(() => random.next() < 0.6);
      if (!categories.length) categories.push(random.pick(TAX_CATEGORIES));
      const groups = categories.map((category) => {
        const rateBps = TAX_RULES[category].rateBps;
        const gross = random.int(1, 500_000);
        return {
          category,
          rateBps,
          gross,
          tax: extractTax(gross, rateBps).tax,
        };
      });
      // Refunds as fiscal records them (refundTaxSplit never refunds more than was sold).
      const valid: Refund[] = [];
      let remaining = sumOf(groups).gross;
      for (let k = random.int(0, 3); k > 0 && remaining > 0; k--) {
        const amount = random.int(1, remaining);
        valid.push({
          refundId: `r${valid.length}`,
          groups: refundTaxSplit({
            refundGross: amount,
            saleGroups: groups,
            previous: valid.flatMap((v) => v.groups),
          }),
        });
        remaining -= amount;
      }
      const net = netGroups(groups, valid);
      holds(groups, valid, net);
      // The cumulative split keeps every net group within 1 centavo of the canonical IVA.
      for (const g of net)
        expect(
          Math.abs(
            g.tax - extractTax(g.gross, TAX_RULES[g.category].rateBps).tax,
          ),
        ).toBeLessThanOrEqual(1);

      // The same data, corrupted: it must be refused, or still add up.
      const left = new Map(
        groups.map((g) => [g.category, { gross: g.gross, tax: g.tax }]),
      );
      for (const a of valid.flatMap((v) => v.groups)) {
        const l = left.get(a.category)!;
        left.set(a.category, { gross: l.gross - a.gross, tax: l.tax - a.tax });
      }
      const target = random.pick(categories);
      const rate = TAX_RULES[target].rateBps;
      const foreign = TAX_CATEGORIES.filter((c) => !categories.includes(c));
      let extra: Refund["groups"][number];
      let mustRefuse = true;
      switch (random.int(0, 3)) {
        case 0: {
          // Over-refund of a sold category.
          const gross = left.get(target)!.gross + random.int(1, 1000);
          extra = { category: target, gross, tax: extractTax(gross, rate).tax };
          break;
        }
        case 1: {
          // A category the ticket never sold (or an over-refund when it sold all four).
          const category = foreign.length ? random.pick(foreign) : target;
          const gross = foreign.length
            ? random.int(1, 1000)
            : left.get(target)!.gross + 1;
          extra = {
            category,
            gross,
            tax: extractTax(gross, TAX_RULES[category].rateBps).tax,
          };
          break;
        }
        case 2: {
          // The exact gross left, with IVA one centavo off.
          const l = left.get(target)!;
          extra = {
            category: target,
            gross: l.gross,
            tax: Math.max(0, l.tax + random.pick([-1, 1])),
          };
          mustRefuse = extra.tax !== l.tax;
          break;
        }
        default: {
          // Any partial amount with an arbitrary IVA: may or may not be consistent.
          const gross = random.int(0, Math.max(0, left.get(target)!.gross));
          extra = { category: target, gross, tax: random.int(0, gross) };
          mustRefuse = false;
        }
      }
      const corrupt = [...valid, { refundId: "x", groups: [extra] }];
      let result: ReturnType<typeof netGroups> | null = null;
      try {
        result = netGroups(groups, corrupt);
      } catch (e) {
        expect(e).toBeInstanceOf(DomainError);
        expect((e as DomainError).code).toBe("fiscal_total_mismatch");
        refused++;
      }
      if (result) {
        expect(mustRefuse, JSON.stringify({ groups, corrupt })).toBe(false);
        holds(groups, corrupt, result);
      }
    }
    expect(refused).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------------------------
// Invoice (type I) builder
// ---------------------------------------------------------------------------------------------

describe("buildInvoiceRequest", () => {
  it("9. FIT-6: grouped sends one concept per tax category with 90101501/E48, tax_included price = net gross, IVA 16/8/0/exento taxes, sku = folio, PUE, use, address.zip = issuer CP, external_id = idempotency_key = document id", () => {
    const input = invoiceInputFor();
    const built = buildInvoiceRequest(input);
    const { body } = built;
    expect(invoiceInput.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      type: "I",
      payment_form: "04", // external 120.00 > cash 66.00, restaurant default credit
      payment_method: "PUE",
      use: "G03",
      currency: "MXN",
      series: "F",
      address: { zip: ISSUER_POSTAL_CODE },
      external_id: DOC,
      idempotency_key: DOC,
      customer: {
        legal_name: RECEPTOR_MORAL.legalName,
        tax_id: RECEPTOR_MORAL.rfc,
        tax_system: "601",
        email: RECEPTOR_MORAL.email,
        address: { zip: RECEPTOR_MORAL.postalCode },
      },
    });
    expect(body.related_documents).toBeUndefined();
    expect(body.global).toBeUndefined();
    expect(body.items).toEqual([
      {
        quantity: 1,
        product: {
          description: "Consumo de alimentos y bebidas",
          product_key: "90101501",
          unit_key: "E48",
          unit_name: "Unidad de servicio",
          price: 116,
          tax_included: true,
          taxability: "02",
          taxes: [IVA16],
          sku: "A-000123",
        },
      },
      {
        quantity: 1,
        product: expect.objectContaining({
          description: "Consumo de alimentos y bebidas (tasa 0%)",
          price: 50,
          taxes: [IVA0],
          sku: "A-000123",
        }),
      },
      {
        quantity: 1,
        product: expect.objectContaining({
          description: "Consumo de alimentos y bebidas (exento)",
          price: 20,
          taxes: [EXENTO],
        }),
      },
    ]);
    expect(built).toMatchObject({
      expectedTotal: 18600,
      expectedTax: 1600,
      conceptCount: 3,
      nettedRefundIds: [],
      conceptMode: "grouped",
      itemizedFallback: null,
    });
    expect(built.expectedTotal).toBe(input.payload.ticket.gross);
    expect(built.expectedTax).toBe(input.payload.ticket.tax);
    expect(canonicalTax(body)).toBe(built.expectedTax);

    // Border region: IVA 8% and 16% concepts; the debit card form when asked.
    const b = buildInvoiceRequest(
      invoiceInputFor({
        cardForm: "28",
        payload: cfdiPayload({
          lines: [
            taxedLine(10800, "iva8", { ctx: border }),
            taxedLine(2320, "iva16", { ctx: border }),
          ],
          ctx: border,
          payments: [{ method: "external", amount: 13120 }],
        }),
      }),
    );
    expect(b.body.items.map((i) => i.product.taxes[0])).toEqual([IVA16, IVA8]);
    expect(b.body.items.map((i) => i.product.price)).toEqual([23.2, 108]);
    expect(b.body.payment_form).toBe("28");
    expect(b).toMatchObject({ expectedTotal: 13120, expectedTax: 320 + 800 });
    expect(canonicalTax(b.body)).toBe(b.expectedTax);
  });

  it("9b. the PDF section dates the ticket in the restaurant timezone; substitutions relate 04; no email means no email field", () => {
    const late = buildInvoiceRequest(
      invoiceInputFor({
        receptor: RECEPTOR_FISICA,
        replacesUuid: SUBSTITUTED,
        payload: cfdiPayload({
          lines: [taxedLine(11600, "iva16")],
          issuedAt: "2026-10-06T03:00:00.000Z", // 21:00 on 5 Oct in Mexico City
        }),
      }),
    ).body;
    expect(late.pdf_custom_section).toBe("<p>Ticket A-000123 · 05/10/2026</p>");
    expect(late.related_documents).toEqual([
      { relationship: "04", documents: [SUBSTITUTED] },
    ]);
    expect(late.customer).toEqual({
      legal_name: RECEPTOR_FISICA.legalName,
      tax_id: RECEPTOR_FISICA.rfc,
      tax_system: "612",
      address: { zip: RECEPTOR_FISICA.postalCode },
    });
    expect(late.use).toBe("G01");
    // An unknown timezone falls back to the fiscal business date.
    expect(
      buildInvoiceRequest(invoiceInputFor({ timezone: "Mars/Base" })).body
        .pdf_custom_section,
    ).toBe("<p>Ticket A-000123 · 05/10/2026</p>");
  });

  it("9c. never a nominative invoice for a generic RFC or a use the régimen does not allow", () => {
    const generic: Receptor = { ...RECEPTOR_MORAL, rfc: "XAXX010101000" };
    expect(
      domainError(() =>
        buildInvoiceRequest(invoiceInputFor({ receptor: generic })),
      ).code,
    ).toBe("cfdi_generic_rfc");
    const foreign: Receptor = { ...RECEPTOR_MORAL, rfc: "XEXX010101000" };
    expect(
      domainError(() =>
        buildInvoiceRequest(invoiceInputFor({ receptor: foreign })),
      ).code,
    ).toBe("cfdi_generic_rfc");
    const noObligations: Receptor = {
      ...RECEPTOR_FISICA,
      regime: "616",
      use: "G03",
    };
    expect(
      domainError(() =>
        buildInvoiceRequest(invoiceInputFor({ receptor: noObligations })),
      ).code,
    ).toBe("cfdi_use_not_allowed");
    const badZip: Receptor = { ...RECEPTOR_MORAL, postalCode: "123" };
    expect(
      domainError(() =>
        buildInvoiceRequest(invoiceInputFor({ receptor: badZip })),
      ).code,
    ).toBe("cfdi_request_invalid");
  });

  it("10. itemized uses per-line SAT keys (quantity kept when the unit price is exact at 6 decimals) and falls back to grouped when per-line extraction does not sum to the group tax", () => {
    const ok = cfdiPayload({
      lines: [
        taxedLine(3480, "iva16", {
          quantity: 3,
          name: { es: "Taco al pastor", en: "Al pastor taco" },
          optionNames: [
            { es: "Sin cebolla", en: "No onion" },
            { es: "Extra salsa", en: "Extra salsa" },
          ],
        }),
        line5800(),
        taxedLine(11600, "iva16", {
          quantity: 3,
          name: { es: "Pastel", en: "Cake" },
        }),
        taxedLine(2000, "iva0", { name: { es: "Agua", en: "Water" } }),
        taxedLine(0, "iva16", { name: { es: "Cortesía", en: "Comp" } }),
      ],
    });
    expect(ok.itemizedValid).toBe(true);
    const built = buildInvoiceRequest(
      invoiceInputFor({
        payload: ok,
        settings: { conceptMode: "itemized", conceptDescription: "Consumo" },
      }),
    );
    expect(built.conceptMode).toBe("itemized");
    expect(built.itemizedFallback).toBeNull();
    expect(
      built.body.items.map((i) => [
        i.quantity,
        i.product.description,
        i.product.price,
        i.product.product_key,
        i.product.unit_key,
        i.product.unit_name,
      ]),
    ).toEqual([
      [
        3,
        "Taco al pastor + Sin cebolla, Extra salsa",
        11.6,
        "90101501",
        "E48",
        "Unidad de servicio",
      ],
      [2, "Refresco", 29, "50202306", "H87", "Pieza"],
      [1, "3 × Pastel", 116, "90101501", "E48", "Unidad de servicio"], // 116.00 / 3 is not exact
      [1, "Agua", 20, "90101501", "E48", "Unidad de servicio"],
    ]);
    expect(built.body.items.every((i) => i.product.sku === "A-000123")).toBe(
      true,
    );
    expect(built.body.items.map((i) => i.product.taxes[0])).toEqual([
      IVA16,
      IVA16,
      IVA16,
      IVA0,
    ]);
    expect(built.expectedTotal).toBe(ok.ticket.gross);
    expect(canonicalTax(built.body)).toBe(built.expectedTax);
    expect(built.body.items.reduce((s, i) => s + conceptCentavos(i), 0)).toBe(
      built.expectedTotal,
    );

    // 99.00 + 50.00 + 100.00 at 16%: the per-line IVA (13.66 + 6.90 + 13.79) ≠ the group's 34.34.
    const mismatch = cfdiPayload({
      lines: [
        taxedLine(9900, "iva16"),
        taxedLine(5000, "iva16"),
        taxedLine(10000, "iva16"),
      ],
    });
    const fallback = buildInvoiceRequest(
      invoiceInputFor({
        payload: mismatch,
        settings: { conceptMode: "itemized", conceptDescription: "Consumo" },
      }),
    );
    expect(fallback).toMatchObject({
      conceptMode: "grouped",
      itemizedFallback: "tax_mismatch",
      conceptCount: 1,
    });
    expect(fallback.body.items[0].product).toMatchObject({
      description: "Consumo",
      price: 249,
      product_key: "90101501",
    });
    expect(canonicalTax(fallback.body)).toBe(fallback.expectedTax);

    // Fiscal flagged a line outside SAT's per-concept tolerance (tiny allocations): grouped.
    const flagged = { ...ok, itemizedValid: false };
    expect(
      buildInvoiceRequest(
        invoiceInputFor({
          payload: flagged,
          settings: { conceptMode: "itemized", conceptDescription: "Consumo" },
        }),
      ),
    ).toMatchObject({
      conceptMode: "grouped",
      itemizedFallback: "lines_invalid",
    });

    // Refunds are netted per category, which only grouped concepts can carry.
    const refunded = { ...ok, refunds: recordRefunds(ok, [1000]) };
    expect(
      buildInvoiceRequest(
        invoiceInputFor({
          payload: refunded,
          settings: { conceptMode: "itemized", conceptDescription: "Consumo" },
        }),
      ),
    ).toMatchObject({ conceptMode: "grouped", itemizedFallback: "refunds" });
  });

  it("11. nets refunds recorded before the build per category and lists their ids; a fully refunded ticket yields nothing to invoice", () => {
    const base = invoiceInputFor().payload; // iva16 116.00, iva0 50.00, exempt 20.00
    const refunds = recordRefunds(base, [5801, 1000]);
    const built = buildInvoiceRequest(
      invoiceInputFor({ payload: { ...base, refunds } }),
    );
    expect(built.nettedRefundIds).toEqual(refunds.map((r) => r.refundId));
    const adj = (c: TaxCategory) =>
      refunds.flatMap((r) => r.groups).filter((g) => g.category === c);
    const expected = base.ticket.groups.map((g) => ({
      category: g.category,
      gross: g.gross - adj(g.category).reduce((s, a) => s + a.gross, 0),
      tax: g.tax - adj(g.category).reduce((s, a) => s + a.tax, 0),
    }));
    expect(built.expectedTotal).toBe(18600 - 6801);
    expect(built.expectedTotal).toBe(expected.reduce((s, g) => s + g.gross, 0));
    expect(built.expectedTax).toBe(expected.reduce((s, g) => s + g.tax, 0));
    expect(built.body.items.map((i) => conceptCentavos(i))).toEqual(
      expected.map((g) => g.gross),
    );
    // Each netted concept is still within one centavo of the canonical extraction.
    expect(
      Math.abs(canonicalTax(built.body) - built.expectedTax),
    ).toBeLessThanOrEqual(expected.length);

    // An item refund of the whole 0% group drops that concept.
    const scoped: RefundTaxView = {
      refundId: fakeId(),
      createdAt: "2026-10-05T20:00:00.000Z",
      businessDate: "2026-10-05",
      groups: refundTaxSplit({
        refundGross: 5000,
        saleGroups: base.ticket.groups,
        previous: [],
        scope: [{ category: "iva0", gross: 5000 }],
      }),
    };
    const dropped = buildInvoiceRequest(
      invoiceInputFor({ payload: { ...base, refunds: [scoped] } }),
    );
    expect(dropped.body.items.map((i) => i.product.taxes[0])).toEqual([
      IVA16,
      EXENTO,
    ]);

    // Only the refunds handed in are netted (the caller freezes the list).
    expect(
      buildInvoiceRequest(
        invoiceInputFor({ payload: { ...base, refunds }, nettedRefunds: [] }),
      ),
    ).toMatchObject({
      expectedTotal: 18600,
      nettedRefundIds: [],
    });

    for (const amounts of [[18600], [10000, 8600]]) {
      const full = { ...base, refunds: recordRefunds(base, amounts) };
      expect(
        domainError(() =>
          buildInvoiceRequest(invoiceInputFor({ payload: full })),
        ).code,
      ).toBe("cfdi_nothing_to_invoice");
    }
  });
});

function line5800() {
  return taxedLine(5800, "iva16", {
    quantity: 2,
    name: { es: "Refresco", en: "Soda" },
    fiscal: {
      taxCategory: "iva16",
      satProductKey: "50202306",
      satUnitKey: "H87",
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Global invoice builder
// ---------------------------------------------------------------------------------------------

const ids = () => {
  let n = 9000;
  return () => fakeId(++n);
};

function ticket(
  folio: string,
  groups: [TaxCategory, number][],
  payments: GlobalTicket["payments"],
): GlobalTicket {
  return {
    id: fakeId(),
    folio,
    groups: groups.map(([category, gross]) => ({
      category,
      gross,
      tax: extractTax(gross, TAX_RULES[category].rateBps).tax,
    })),
    payments,
  };
}

describe("buildGlobalRequests", () => {
  it("12. MON-1/FIT-6: PUBLICO EN GENERAL/XAXX010101000/616/S01, 01010101/ACT/Venta/quantity 1 per ticket per category with sku (NoIdentificacion) = folio, InformacionGlobal periodicity/months/year, and the payment form of the largest ticket", () => {
    const t102 = ticket(
      "A-000102",
      [["iva16", 11600]],
      [{ method: "external", amount: 11600 }],
    );
    const t101 = ticket(
      "A-000101",
      [
        ["iva0", 3000],
        ["iva16", 5800],
      ],
      [{ method: "cash", amount: 8800 }],
    );
    const tB = ticket(
      "B-000001",
      [["exempt", 2000]],
      [{ method: "cash", amount: 2000 }],
    );
    const refunded = ticket("A-000103", [], [{ method: "cash", amount: 500 }]);
    const parts = buildGlobalRequests({
      docIds: ids(),
      tickets: [tB, t102, refunded, t101],
      period: { periodicity: "day", months: "10", year: 2026 },
      issuerPostalCode: ISSUER_POSTAL_CODE,
      cardForm: "28",
    });
    expect(parts).toHaveLength(1);
    const [part] = parts;
    expect(invoiceInput.safeParse(part.body).success).toBe(true);
    expect(part.docId).toBe(fakeId(9001));
    expect(part.body).toMatchObject({
      type: "I",
      customer: {
        legal_name: "PUBLICO EN GENERAL",
        tax_id: "XAXX010101000",
        tax_system: "616",
        address: { zip: ISSUER_POSTAL_CODE },
      },
      use: "S01",
      series: "FG",
      payment_method: "PUE",
      currency: "MXN",
      address: { zip: ISSUER_POSTAL_CODE },
      global: { periodicity: "day", months: "10", year: 2026 },
      payment_form: "28", // A-000102 (116.00, card) is the largest ticket
      external_id: part.docId,
      idempotency_key: part.docId,
    });
    expect(part.body.customer.email).toBeUndefined();
    expect(
      part.body.items.map((i) => [
        i.product.sku,
        i.product.price,
        i.product.taxes[0],
      ]),
    ).toEqual([
      ["A-000101", 58, IVA16],
      ["A-000101", 30, IVA0],
      ["A-000102", 116, IVA16],
      ["B-000001", 20, EXENTO],
    ]);
    for (const item of part.body.items)
      expect(item).toMatchObject({
        quantity: 1,
        product: {
          description: "Venta",
          product_key: "01010101",
          unit_key: "ACT",
          unit_name: "Actividad",
          tax_included: true,
          taxability: "02",
        },
      });
    expect(part.ticketIds).toEqual([t101.id, t102.id, tB.id]);
    expect(part).toMatchObject({
      expectedTotal: 22400,
      expectedTax: 800 + 1600,
    });
    expect(canonicalTax(part.body)).toBe(part.expectedTax);

    // Ties take the lowest folio; an empty period builds nothing; ticket ids are unique.
    const tie = buildGlobalRequests({
      docIds: ids(),
      tickets: [
        ticket(
          "A-000002",
          [["iva16", 1160]],
          [{ method: "external", amount: 1160 }],
        ),
        ticket(
          "A-000001",
          [["iva16", 1160]],
          [{ method: "cash", amount: 1160 }],
        ),
      ],
      period: { periodicity: "month", months: "02", year: 2026 },
      issuerPostalCode: ISSUER_POSTAL_CODE,
      cardForm: "04",
    });
    expect(tie[0].body.payment_form).toBe("01");
    expect(tie[0].body.global).toEqual({
      periodicity: "month",
      months: "02",
      year: 2026,
    });
    expect(
      buildGlobalRequests({
        docIds: ids(),
        tickets: [refunded],
        period: { periodicity: "day", months: "10", year: 2026 },
        issuerPostalCode: ISSUER_POSTAL_CODE,
        cardForm: "04",
      }),
    ).toEqual([]);
    expect(
      domainError(() =>
        buildGlobalRequests({
          docIds: ids(),
          tickets: [t101, t101],
          period: { periodicity: "day", months: "10", year: 2026 },
          issuerPostalCode: ISSUER_POSTAL_CODE,
          cardForm: "04",
        }),
      ).code,
    ).toBe("cfdi_duplicate_ticket");
  });

  it("13. chunks at 4,000 concepts without splitting a ticket and keeps folio order", () => {
    // 2,500 tickets × 2 categories = 5,000 concepts → 2,000 tickets in part 1, 500 in part 2.
    const tickets = Array.from({ length: 2500 }, (_, i) =>
      ticket(
        `A-${String(2500 - i).padStart(6, "0")}`,
        [
          ["iva16", 1160 + i],
          ["iva0", 100],
        ],
        [{ method: "cash", amount: 1260 + i }],
      ),
    );
    const parts = buildGlobalRequests({
      docIds: ids(),
      tickets,
      period: { periodicity: "week", months: "10", year: 2026 },
      issuerPostalCode: ISSUER_POSTAL_CODE,
      cardForm: "04",
    });
    expect(GLOBAL_MAX_CONCEPTS).toBe(4000);
    expect(parts.map((p) => p.body.items.length)).toEqual([4000, 1000]);
    expect(parts.map((p) => p.ticketIds.length)).toEqual([2000, 500]);
    expect(new Set(parts.map((p) => p.docId)).size).toBe(2);
    const skus = parts.flatMap((p) => p.body.items.map((i) => i.product.sku));
    expect(skus[0]).toBe("A-000001");
    expect(skus.at(-1)).toBe("A-002500");
    expect([...skus].sort()).toEqual(skus);
    expect(parts[0].body.items.at(-1)!.product.sku).not.toBe(
      parts[1].body.items[0].product.sku,
    );
    for (const p of parts)
      expect(invoiceInput.safeParse(p.body).success).toBe(true);
    expect(parts.reduce((s, p) => s + p.expectedTotal, 0)).toBe(
      tickets.reduce(
        (s, t) => s + t.groups.reduce((a, g) => a + g.gross, 0),
        0,
      ),
    );

    // Small limit: a ticket whose concepts do not fit starts the next part, never splits.
    const small = buildGlobalRequests({
      docIds: ids(),
      tickets: [
        ticket(
          "A-000001",
          [
            ["iva16", 116],
            ["iva0", 100],
          ],
          [],
        ),
        ticket(
          "A-000002",
          [
            ["iva16", 116],
            ["iva0", 100],
          ],
          [],
        ),
        ticket(
          "A-000003",
          [
            ["iva16", 116],
            ["iva0", 100],
            ["exempt", 50],
          ],
          [],
        ),
        ticket("A-000004", [["iva16", 116]], []),
      ],
      period: { periodicity: "day", months: "10", year: 2026 },
      issuerPostalCode: ISSUER_POSTAL_CODE,
      cardForm: "04",
      maxConcepts: 5,
    });
    expect(small.map((p) => p.body.items.map((i) => i.product.sku))).toEqual([
      ["A-000001", "A-000001", "A-000002", "A-000002"],
      ["A-000003", "A-000003", "A-000003", "A-000004"],
    ]);
    // The stamping job rebuilds one part from its own claims with no limit.
    expect(
      buildGlobalRequests({
        docIds: ids(),
        tickets: tickets.slice(0, 10),
        period: { periodicity: "day", months: "10", year: 2026 },
        issuerPostalCode: ISSUER_POSTAL_CODE,
        cardForm: "04",
        maxConcepts: Infinity,
      }),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Credit note (egreso) builder
// ---------------------------------------------------------------------------------------------

function egreso(over: Partial<EgresoBuildInput> = {}): EgresoBuildInput {
  return {
    docId: DOC,
    folio: "A-000123",
    parent: {
      kind: "invoice",
      uuid: SUBSTITUTED,
      receptor: RECEPTOR_MORAL,
      paymentForm: "28",
    },
    refund: {
      method: "external",
      groups: [
        { category: "iva0", gross: 1000, tax: 0 },
        { category: "iva16", gross: 5801, tax: 800 },
      ],
    },
    issuerPostalCode: ISSUER_POSTAL_CODE,
    cardForm: "04",
    ...over,
  };
}

describe("buildEgresoRequest", () => {
  it("14. type E, related 01 to the parent UUID, 84111506/ACT, G02 for business receptors, S01 for público en general and 616, payment form of the refund tender", () => {
    const built = buildEgresoRequest(egreso());
    expect(invoiceInput.safeParse(built.body).success).toBe(true);
    expect(built.body).toMatchObject({
      type: "E",
      series: "NC",
      payment_method: "PUE",
      use: "G02",
      currency: "MXN",
      payment_form: "28", // external refund on a debit-card parent
      related_documents: [{ relationship: "01", documents: [SUBSTITUTED] }],
      address: { zip: ISSUER_POSTAL_CODE },
      external_id: DOC,
      idempotency_key: DOC,
      customer: {
        tax_id: RECEPTOR_MORAL.rfc,
        tax_system: "601",
        email: RECEPTOR_MORAL.email,
      },
    });
    expect(built.body.global).toBeUndefined();
    expect(built.body.items).toEqual([
      {
        quantity: 1,
        product: {
          description: "Devolución del ticket A-000123",
          product_key: "84111506",
          unit_key: "ACT",
          unit_name: "Actividad",
          price: 58.01,
          tax_included: true,
          taxability: "02",
          taxes: [IVA16],
        },
      },
      {
        quantity: 1,
        product: expect.objectContaining({
          description: "Devolución del ticket A-000123 (tasa 0%)",
          price: 10,
          taxes: [IVA0],
        }),
      },
    ]);
    expect(built).toMatchObject({
      expectedTotal: 6801,
      fiscalTax: 800,
      conceptCount: 2,
    });
    expect(built.expectedTax).toBe(extractTax(5801, 1600).tax);
    expect(canonicalTax(built.body)).toBe(built.expectedTax);

    // Global parent: PUBLICO EN GENERAL with S01; cash refund → 01.
    const global = buildEgresoRequest(
      egreso({
        parent: {
          kind: "global",
          uuid: SUBSTITUTED,
          receptor: null,
          paymentForm: "01",
        },
        refund: {
          method: "cash",
          groups: [{ category: "iva16", gross: 1160, tax: 160 }],
        },
      }),
    ).body;
    expect(global).toMatchObject({
      use: "S01",
      payment_form: "01",
      customer: {
        legal_name: "PUBLICO EN GENERAL",
        tax_id: "XAXX010101000",
        tax_system: "616",
        address: { zip: ISSUER_POSTAL_CODE },
      },
    });
    // A receptor in régimen 616 (or any régimen where G02 is not allowed) gets S01.
    const noObligations: Receptor = {
      ...RECEPTOR_FISICA,
      regime: "616",
      use: "S01",
    };
    expect(
      buildEgresoRequest(
        egreso({
          parent: {
            kind: "invoice",
            uuid: SUBSTITUTED,
            receptor: noObligations,
            paymentForm: "01",
          },
        }),
      ).body.use,
    ).toBe("S01");
    expect(
      buildEgresoRequest(
        egreso({
          parent: {
            kind: "invoice",
            uuid: SUBSTITUTED,
            receptor: RECEPTOR_FISICA,
            paymentForm: "04",
          },
        }),
      ).body.use,
    ).toBe("G02");
    // External refund whose parent was paid in cash: the restaurant's card form.
    expect(
      buildEgresoRequest(
        egreso({
          parent: {
            kind: "invoice",
            uuid: SUBSTITUTED,
            receptor: RECEPTOR_MORAL,
            paymentForm: "01",
          },
        }),
      ).body.payment_form,
    ).toBe("04");
    expect(
      domainError(() =>
        buildEgresoRequest(egreso({ refund: { method: "cash", groups: [] } })),
      ).code,
    ).toBe("cfdi_nothing_to_invoice");
    expect(
      domainError(() =>
        buildEgresoRequest(
          egreso({
            parent: {
              kind: "invoice",
              uuid: SUBSTITUTED,
              receptor: null,
              paymentForm: null,
            },
          }),
        ),
      ).code,
    ).toBe("cfdi_parent_receptor_missing");
  });

  it("15d. an egreso stamps extract(adj.gross) per category; its expectedTax is canonical and may differ from fiscal adj.tax by at most 1 centavo per category", () => {
    const random = rng(30);
    let differed = 0;
    for (let n = 0; n < 2000; n++) {
      const gross = random.int(100, 500_000);
      const payload = cfdiPayload({
        lines: [
          taxedLine(gross, random.pick(["iva16", "iva0"] as const)),
          taxedLine(random.int(100, 50_000), "iva16"),
        ],
      });
      const total = payload.ticket.gross;
      let left = total;
      const amounts: number[] = [];
      for (let k = 0; k < random.int(1, 4) && left > 1; k++) {
        const a = random.int(1, left - 1);
        amounts.push(a);
        left -= a;
      }
      for (const refund of recordRefunds(payload, amounts)) {
        const built = buildEgresoRequest(
          egreso({ refund: { method: "cash", groups: refund.groups } }),
        );
        expect(canonicalTax(built.body)).toBe(built.expectedTax);
        const categories = new Set(refund.groups.map((g) => g.category)).size;
        expect(
          Math.abs(built.expectedTax - built.fiscalTax),
        ).toBeLessThanOrEqual(categories);
        if (built.expectedTax !== built.fiscalTax) differed++;
      }
    }
    // The bound is real (some refunds do differ by a centavo), and never more.
    expect(differed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// XML amount parser
// ---------------------------------------------------------------------------------------------

const CFDI_NS = 'xmlns:cfdi="http://www.sat.gob.mx/cfd/4"';
function doc(
  attrs: string,
  inner = "",
  root = "cfdi:Comprobante",
  ns = CFDI_NS,
) {
  return `<?xml version="1.0" encoding="UTF-8"?><${root} ${ns} ${attrs}>${inner}</${root}>`;
}

describe("parseCfdiTotals", () => {
  it("16. reads SubTotal, Total, TotalImpuestosTrasladados and concept traslados from a CFDI 4.0 XML regardless of attribute order and quote style", () => {
    const xml = readFileSync("tests/fixtures/cfdi/sample-cfdi40.xml");
    const t = parseCfdiTotals(xml);
    expect(t).toMatchObject({
      version: "4.0",
      type: "I",
      series: "FG",
      folio: "12",
      currency: "MXN",
      subtotal: 17000,
      discount: 0,
      total: 18600,
      taxTraslados: 1600,
      uuid: "39C85A3F-275B-4341-B259-E8971D9F8A94",
    });
    expect(t.concepts).toEqual([
      {
        noIdentificacion: "A-000123",
        importe: 10000,
        descuento: 0,
        traslados: [
          {
            impuesto: "002",
            factor: "Tasa",
            rate: "0.160000",
            base: 10000,
            importe: 1600,
          },
        ],
      },
      {
        noIdentificacion: "A-000123",
        importe: 5000,
        descuento: 0,
        traslados: [
          {
            impuesto: "002",
            factor: "Tasa",
            rate: "0.000000",
            base: 5000,
            importe: 0,
          },
        ],
      },
      {
        noIdentificacion: "A-000124",
        importe: 2000,
        descuento: 0,
        traslados: [
          {
            impuesto: "002",
            factor: "Exento",
            rate: null,
            base: 2000,
            importe: null,
          },
        ],
      },
    ]);
    // Comprobante-level traslados only (the concept-level ones are not repeated here).
    expect(t.traslados.map((x) => [x.base, x.importe])).toEqual([
      [10000, 1600],
      [5000, 0],
      [2000, null],
    ]);
    // The same document as a string, with a BOM.
    expect(parseCfdiTotals("﻿" + xml.toString("utf8")).total).toBe(18600);
  });

  it("16b. resolves namespaces by URI (any prefix or a default namespace), rounds 6-decimal amounts half up, and handles totals above MXN 1,000,000", () => {
    const concept = (pfx: string) =>
      `<${pfx}Conceptos><${pfx}Concepto NoIdentificacion="A-1" Importe="2155172.413793"><${pfx}Impuestos><${pfx}Traslados><${pfx}Traslado Base="2155172.413793" Importe="344827.586207" TipoFactor="Tasa" TasaOCuota="0.160000" Impuesto="002"/></${pfx}Traslados></${pfx}Impuestos></${pfx}Concepto></${pfx}Conceptos>` +
      `<${pfx}Impuestos TotalImpuestosTrasladados="344827.59"/>`;
    const prefixed = parseCfdiTotals(
      doc(
        'Total="2500000.00" SubTotal="2155172.41"',
        concept("c:"),
        "c:Comprobante",
        'xmlns:c="http://www.sat.gob.mx/cfd/4"',
      ),
    );
    expect(prefixed).toMatchObject({
      total: 250_000_000,
      subtotal: 215_517_241,
      taxTraslados: 34_482_759,
    });
    expect(prefixed.concepts[0].traslados[0]).toMatchObject({
      base: 215_517_241,
      importe: 34_482_759,
    });
    const defaultNs = parseCfdiTotals(
      doc(
        "Total='2500000.00' SubTotal='2155172.41'",
        concept(""),
        "Comprobante",
        'xmlns="http://www.sat.gob.mx/cfd/4"',
      ),
    );
    expect(defaultNs.total).toBe(250_000_000);
    expect(defaultNs.concepts).toHaveLength(1);
    expect(decimalToCentavos("0.005")).toBe(1);
    expect(decimalToCentavos("0.004999")).toBe(0);
    expect(decimalToCentavos("107.755")).toBe(10776);
    expect(decimalToCentavos("12")).toBe(1200);
    expect(() => decimalToCentavos("-1.00")).toThrow(CfdiXmlError);
    expect(() => decimalToCentavos("1e3")).toThrow(CfdiXmlError);
    // Descuento, entities and comments.
    const withDiscount = parseCfdiTotals(
      doc(
        'SubTotal="100.00" Descuento="10.00" Total="104.40"',
        '<!-- note --><cfdi:Conceptos><cfdi:Concepto NoIdentificacion="A&amp;B" Importe="100.00" Descuento="10.00"/></cfdi:Conceptos>',
      ),
    );
    expect(withDiscount).toMatchObject({
      discount: 1000,
      total: 10440,
      taxTraslados: 0,
    });
    expect(withDiscount.concepts[0]).toMatchObject({
      noIdentificacion: "A&B",
      descuento: 1000,
    });
    // A concept's Impuestos is never read as the comprobante-level one.
    const conceptOnly = parseCfdiTotals(
      doc(
        'SubTotal="100.00" Total="116.00"',
        '<cfdi:Conceptos><cfdi:Concepto Importe="100.00"><cfdi:Impuestos TotalImpuestosTrasladados="99.00"/></cfdi:Concepto></cfdi:Conceptos>',
      ),
    );
    expect(conceptOnly.taxTraslados).toBe(0);
  });

  it("16c. malformed or foreign documents are refused", () => {
    const bad = [
      "",
      "<root/>",
      doc('SubTotal="1.00"'), // no Total
      doc('SubTotal="1.00" Total="1.00"', "<cfdi:Conceptos>"), // unbalanced
      doc(
        'SubTotal="1.00" Total="1.00"',
        "",
        "cfdi:Comprobante",
        'xmlns:cfdi="http://www.sat.gob.mx/cfd/3"',
      ), // CFDI 3.3 namespace
      '<!DOCTYPE x [<!ENTITY a "b">]>' + doc('SubTotal="1.00" Total="1.00"'),
      doc('SubTotal="1.00" Total="1.00" Total="2.00"'), // duplicate attribute
      doc('SubTotal="1.00" Total="abc"'),
      doc('SubTotal="1.00" Total="1.00"', "<x:Foo/>"), // undeclared prefix
      doc('SubTotal="1.00" Total="1.00"') + doc('SubTotal="1.00" Total="1.00"'), // two roots
      doc(
        'SubTotal="1.00" Total="1.00"',
        '<cfdi:Conceptos><cfdi:Concepto Importe="1.00" NoIdentificacion="&bogus;"/></cfdi:Conceptos>',
      ),
    ];
    for (const xml of bad)
      expect(() => parseCfdiTotals(xml), xml.slice(0, 80)).toThrow(
        CfdiXmlError,
      );
    expect(() => parseCfdiTotals(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(
      CfdiXmlError,
    );
    try {
      parseCfdiTotals("<root/>");
    } catch (e) {
      expect((e as CfdiXmlError).code).toBe("cfdi_xml_invalid");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Facturapi error classification
// ---------------------------------------------------------------------------------------------

const http = (
  status: number,
  code: string,
  o: {
    details?: FacturapiError["details"];
    path?: string;
    retryAfterMs?: number;
    message?: string;
  } = {},
) =>
  new FacturapiError(
    "http",
    status,
    code,
    o.message ?? "mensaje",
    o.details ?? [],
    o.path,
    "log_1",
    o.retryAfterMs,
  );

describe("classifyFacturapiError", () => {
  it("20. retryable (network, timeout, any 5xx even with a mapped code, rate_limit_exceeded with Retry-After, invoice_stamping_service_unavailable, idempotency_key_in_use, stamping_in_progress, a conflict or unknown 409, invoice_already_stamped adopted) vs permanent", () => {
    const retryable: [
      FacturapiError,
      Partial<ReturnType<typeof classifyFacturapiError>>,
    ][] = [
      [
        new FacturapiError("network", 0, "cfdi_provider_network", "x"),
        { code: "cfdi_provider_network", unknownOutcome: true },
      ],
      [
        new FacturapiError("network", 0, "cfdi_request_aborted", "x"),
        { code: "cfdi_request_aborted", unknownOutcome: true },
      ],
      [
        new FacturapiError("timeout", 0, "cfdi_provider_timeout", "x"),
        { code: "cfdi_provider_timeout", unknownOutcome: true },
      ],
      [
        http(500, "internal_error"),
        { code: "cfdi_provider_unavailable", unknownOutcome: true },
      ],
      [
        http(502, "http_502"),
        { code: "cfdi_provider_unavailable", unknownOutcome: true },
      ],
      [
        http(503, "invoice_stamping_service_unavailable"),
        { code: "cfdi_provider_unavailable" },
      ],
      [
        http(503, "invoice_cancellation_service_unavailable"),
        { code: "cfdi_provider_unavailable" },
      ],
      [
        http(429, "rate_limit_exceeded", { retryAfterMs: 2000 }),
        {
          afterMs: 2000,
          code: "cfdi_provider_rate_limited",
          unknownOutcome: false,
        },
      ],
      [http(429, "rate_limit_exceeded"), { afterMs: 60_000 }],
      [
        http(429, "rate_limit_exceeded", { retryAfterMs: 86_400_000 }),
        { afterMs: 3_600_000 },
      ],
      [
        http(409, "idempotency_key_in_use"),
        {
          afterMs: 15_000,
          code: "cfdi_provider_in_progress",
          unknownOutcome: true,
        },
      ],
      [
        http(409, "stamping_in_progress"),
        { afterMs: 15_000, unknownOutcome: true },
      ],
      [http(408, "http_408"), { code: "cfdi_provider_timeout" }],
      // CFDI-CORE-1: a 409 that is not a known final state may be a retry colliding with the
      // first request (attempt 1 timed out, adoption did not see the invoice yet): retry the same
      // key in 15 s and never fail the document.
      [
        http(409, "conflict"),
        {
          afterMs: 15_000,
          code: "cfdi_provider_in_progress",
          unknownOutcome: true,
          providerCode: "conflict",
        },
      ],
      [
        http(409, "something_new"),
        {
          afterMs: 15_000,
          code: "cfdi_provider_in_progress",
          unknownOutcome: true,
        },
      ],
      [
        http(409, "http_409"),
        { code: "cfdi_provider_in_progress", unknownOutcome: true },
      ],
      // A permanent code on 409 that is not a resource state (e.g. stamping) is not trusted either.
      [
        http(409, "invoice_stamping_failed"),
        { code: "cfdi_provider_in_progress", unknownOutcome: true },
      ],
      // Any 5xx leaves the outcome unknown, even with a documented (mapped) code.
      [
        http(503, "not_found"),
        { code: "cfdi_provider_unavailable", unknownOutcome: true },
      ],
      [
        http(500, "invoice_stamping_failed"),
        {
          code: "cfdi_provider_unavailable",
          unknownOutcome: true,
          providerCode: "invoice_stamping_failed",
        },
      ],
      [
        http(502, "invoice_stamping_validation_error", {
          details: [
            {
              code: "tax_id_not_found",
              message: "x",
              source: "facturapi",
              path: "customer.tax_id",
            },
          ],
        }),
        { code: "cfdi_provider_unavailable", unknownOutcome: true },
      ],
      [
        http(500, "certificate_expired"),
        { code: "cfdi_provider_unavailable", unknownOutcome: true },
      ],
      [
        http(503, "invoice_stamping_service_unavailable", {
          retryAfterMs: 5000,
        }),
        {
          afterMs: 5000,
          code: "cfdi_provider_unavailable",
          unknownOutcome: true,
        },
      ],
      [
        http(503, "rate_limit_exceeded"),
        { code: "cfdi_provider_rate_limited", unknownOutcome: true },
      ],
      // The generic CommonErrorCode `conflict` is never final, whatever status carries it.
      [
        http(400, "conflict"),
        {
          afterMs: 15_000,
          code: "cfdi_provider_in_progress",
          unknownOutcome: true,
        },
      ],
      // CFDI-ADV-4: InvoiceErrorCode invoice_already_stamped asserts a stamped CFDI exists. It is
      // adopted by external_id on the next attempt, never a failure that releases the claims.
      ...[400, 409, 422].map(
        (status) =>
          [
            http(status, "invoice_already_stamped"),
            {
              afterMs: 15_000,
              code: "cfdi_provider_already_stamped",
              unknownOutcome: true,
              providerCode: "invoice_already_stamped",
            },
          ] as [
            FacturapiError,
            Partial<ReturnType<typeof classifyFacturapiError>>,
          ],
      ),
    ];
    for (const [e, expected] of retryable)
      expect(classifyFacturapiError(e), `${e.status} ${e.code}`).toMatchObject({
        retry: true,
        ...expected,
      });

    const permanent: [
      FacturapiError,
      Partial<ReturnType<typeof classifyFacturapiError>>,
    ][] = [
      [
        http(400, "invoice_stamping_validation_error"),
        { code: "cfdi_stamping_rejected" },
      ],
      [http(400, "invoice_stamping_failed"), { code: "cfdi_stamping_failed" }],
      [
        http(400, "invalid_request", { path: "items.0.product.price" }),
        {
          code: "cfdi_provider_invalid_request",
          path: "items.0.product.price",
        },
      ],
      [http(401, "api_key_invalid"), { code: "cfdi_org_key_invalid" }],
      [http(401, "user_key_invalid"), { code: "cfdi_provider_auth_failed" }],
      [http(401, "http_401"), { code: "cfdi_provider_auth_failed" }],
      [http(403, "subscription_required"), { code: "cfdi_org_not_ready" }],
      [http(400, "organization_incomplete"), { code: "cfdi_org_not_ready" }],
      [
        http(400, "invoice_cancellation_in_progress"),
        { code: "cfdi_cancellation_in_progress" },
      ],
      [
        http(409, "invoice_not_cancelable"),
        { code: "cfdi_cancel_rejected_provider", unknownOutcome: false },
      ],
      // 409s that state a final fact about the resource stay permanent with a known outcome.
      [
        http(409, "invoice_cancellation_in_progress"),
        { code: "cfdi_cancellation_in_progress", unknownOutcome: false },
      ],
      [
        http(409, "invoice_not_cancelable_by_sat"),
        { code: "cfdi_cancel_rejected_provider", unknownOutcome: false },
      ],
      // CFDI-ADV-8: every cancellation failure code is final on 409 as on 400.
      [
        http(409, "invoice_cancellation_failed"),
        { code: "cfdi_cancel_rejected_provider", unknownOutcome: false },
      ],
      [
        http(400, "invoice_cancellation_failed"),
        { code: "cfdi_cancel_rejected_provider", unknownOutcome: false },
      ],
      [
        http(409, "substitution_invoice_status_not_allowed"),
        { code: "cfdi_substitute_invalid", unknownOutcome: false },
      ],
      [
        http(409, "invoice_email_status_not_allowed"),
        { code: "cfdi_email_not_allowed", unknownOutcome: false },
      ],
      [
        http(409, "certificate_previous_rfc_mismatch"),
        { code: "cfdi_csd_rfc_mismatch", unknownOutcome: false },
      ],
      [
        http(409, "legal_name_mismatch"),
        {
          code: "cfdi_receptor_name_mismatch",
          path: "customer.legal_name",
          unknownOutcome: false,
        },
      ],
      [
        http(400, "substitution_invoice_not_found"),
        { code: "cfdi_substitute_invalid" },
      ],
      [
        http(400, "invoice_email_delivery_failed"),
        { code: "cfdi_email_delivery_failed" },
      ],
      [http(404, "invoice_not_found"), { code: "cfdi_provider_not_found" }],
      [http(400, "something_new"), { code: "cfdi_provider_rejected" }],
      [
        new FacturapiError("key", 0, "cfdi_key_kind", "x"),
        { code: "cfdi_key_kind", unknownOutcome: false },
      ],
      [
        new FacturapiError("schema", 0, "cfdi_request_invalid", "x"),
        { code: "cfdi_request_invalid", unknownOutcome: false },
      ],
      // A 2xx the client could not read, or one in the wrong environment: the provider acted.
      [
        new FacturapiError("schema", 200, "cfdi_provider_schema", "x"),
        { code: "cfdi_provider_schema", unknownOutcome: true },
      ],
      [
        new FacturapiError("schema", 0, "cfdi_mode_mismatch", "x"),
        { code: "cfdi_mode_mismatch", unknownOutcome: true },
      ],
      [
        new FacturapiError("schema", 200, "cfdi_duplicate_external_id", "x"),
        { code: "cfdi_duplicate_external_id" },
      ],
    ];
    for (const [e, expected] of permanent)
      expect(classifyFacturapiError(e), `${e.status} ${e.code}`).toMatchObject({
        retry: false,
        ...expected,
      });

    // Anything that is not a FacturapiError is retried as an unknown outcome.
    expect(classifyFacturapiError(new TypeError("boom"))).toMatchObject({
      retry: true,
      code: "cfdi_unexpected_error",
      unknownOutcome: true,
    });
  });

  it("20b. receptor data codes map to the field to correct, as the root code or as an errors[] detail", () => {
    const cases: [string, string, string][] = [
      ["tax_id_not_found", "cfdi_receptor_rfc_not_found", "customer.tax_id"],
      [
        "legal_name_mismatch",
        "cfdi_receptor_name_mismatch",
        "customer.legal_name",
      ],
      [
        "tax_address_zip_mismatch",
        "cfdi_receptor_zip_mismatch",
        "customer.address.zip",
      ],
      [
        "tax_system_not_allowed_for_tax_id",
        "cfdi_receptor_regime_mismatch",
        "customer.tax_system",
      ],
      [
        "tax_system_not_in_catalog",
        "cfdi_receptor_regime_invalid",
        "customer.tax_system",
      ],
    ];
    for (const [provider, code, path] of cases) {
      expect(
        classifyFacturapiError(http(400, provider)),
        provider,
      ).toMatchObject({ retry: false, code, path });
      const nested = http(400, "invoice_stamping_validation_error", {
        details: [
          { code: "CFDI40145", message: "x", source: "sat" },
          { code: provider, message: "y", source: "facturapi", path },
        ],
      });
      expect(
        classifyFacturapiError(nested),
        `nested ${provider}`,
      ).toMatchObject({
        retry: false,
        code,
        path,
        providerCode: "invoice_stamping_validation_error",
      });
    }
    // A provider path wins over the default one.
    expect(
      classifyFacturapiError(
        http(400, "legal_name_mismatch", { path: "customer.legal_name" }),
      ).path,
    ).toBe("customer.legal_name");
  });

  it("20c. certificate errors map to the CSD codes (spec §4.8.2)", () => {
    const cases: [string, string][] = [
      ["private_key_password_incorrect", "cfdi_csd_password"],
      ["private_key_certificate_mismatch", "cfdi_csd_key_mismatch"],
      ["certificate_expired", "cfdi_csd_expired"],
      ["certificate_not_yet_valid", "cfdi_csd_not_yet_valid"],
      ["csd_required", "cfdi_csd_is_fiel"],
      ["certificate_files_invalid", "cfdi_csd_invalid"],
      ["certificate_invalid", "cfdi_csd_invalid"],
      ["certificate_previous_rfc_mismatch", "cfdi_csd_rfc_mismatch"],
    ];
    for (const [provider, code] of cases)
      expect(
        classifyFacturapiError(http(400, provider)),
        provider,
      ).toMatchObject({ retry: false, code, unknownOutcome: false });
  });

  it("20d. every code is a valid job/document code and messages stay bounded", () => {
    const samples = [
      ...["network", "timeout", "key", "schema"].map(
        (k) =>
          new FacturapiError(k as FacturapiError["kind"], 0, "cfdi_x", "m"),
      ),
      ...[400, 401, 403, 404, 409, 422, 429, 500, 503].flatMap((s) =>
        [
          "internal_error",
          "invalid_request",
          "rate_limit_exceeded",
          "tax_id_not_found",
          "certificate_expired",
          "weird.Code-1",
          `http_${s}`,
        ].map((c) => http(s, c, { message: "x".repeat(5000) })),
      ),
    ];
    for (const e of samples) {
      const c = classifyFacturapiError(e);
      expect(c.code, `${e.kind} ${e.status} ${e.code}`).toMatch(CODE);
      expect(c.message?.length ?? 0).toBeLessThanOrEqual(1000);
      if (c.afterMs !== undefined) expect(c.afterMs).toBeGreaterThan(0);
      // Never a known outcome after a server error, whatever the code.
      if (e.kind === "http" && e.status >= 500)
        expect(c, `${e.status} ${e.code}`).toMatchObject({
          retry: true,
          unknownOutcome: true,
        });
    }
    // Every documented root code that is not a final resource state (or receptor/CSD data) is a
    // retry with an unknown outcome on 409, never a permanent failure.
    for (const code of [
      "conflict",
      "not_found",
      "internal_error",
      "invalid_request",
      "invoice_stamping_validation_error",
      "invoice_stamping_failed",
      "organization_incomplete",
      "product_key_not_found",
    ])
      expect(classifyFacturapiError(http(409, code)), code).toMatchObject({
        retry: true,
        unknownOutcome: true,
      });
    // The documented cancellation, substitution and email codes (errors.mdx
    // InvoiceCancellationErrorCode and InvoiceDeliveryErrorCode, except the *_service_unavailable
    // and delivery codes that are not resource states) state a final fact: same permanent class on
    // 409 as on 400, with a known outcome.
    for (const code of [
      "invoice_cancellation_in_progress",
      "invoice_cancellation_receipt_external",
      "invoice_cancellation_receipt_unavailable",
      "invoice_cancellation_failed",
      "invoice_cancellation_not_allowed",
      "invoice_cancellation_not_found",
      "invoice_cancellation_rfc_mismatch",
      "invoice_not_cancelable",
      "invoice_not_cancelable_by_sat",
      "substitution_invoice_canceled",
      "substitution_invoice_not_found",
      "substitution_invoice_required",
      "substitution_invoice_status_not_allowed",
      "invoice_email_recipient_required",
      "invoice_email_status_not_allowed",
    ]) {
      const on400 = classifyFacturapiError(http(400, code));
      expect(on400, code).toMatchObject({
        retry: false,
        unknownOutcome: false,
      });
      expect(on400.code, code).not.toBe("cfdi_provider_rejected");
      expect(classifyFacturapiError(http(409, code)), code).toEqual(on400);
    }
    expect(TAX_CATEGORIES).toHaveLength(4);
  });
});
