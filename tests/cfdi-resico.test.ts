// cfdi (030), LD-16 L9: RESICO ISR withholding (LISR art. 113-J). A persona física in régimen 626
// invoicing a persona moral shows a 1.25 % ISR retention per concept; the amount check compares the
// pre-retention totals. Shape verified against the Facturapi OpenAPI BaseTax (vendored subset) and
// the Node SDK `Tax` type; the provider behaviour itself is exercised only with the fake.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractTax } from "../shared/fiscal";
import {
  buildEgresoRequest,
  buildGlobalRequests,
  buildInvoiceRequest,
  canonicalAmounts,
  netGroups,
} from "../server/cfdi/build";
import {
  createFacturapiClient,
  type FacturapiKey,
} from "../server/cfdi/facturapi";
import { invoiceInput, productInput } from "../server/cfdi/facturapi-schema";
import { parseCfdiTotals } from "../server/cfdi/xml";
import { createFacturapiFake, FAKE_BASE_URL } from "./fakes/facturapi-fake";
import {
  cfdiPayload,
  fakeId,
  ISSUER_POSTAL_CODE,
  RECEPTOR_FISICA,
  RECEPTOR_MORAL,
  taxedLine,
  USER_KEY,
} from "./fixtures/cfdi";

const RESICO = { regime: "626", rfc: "XIQB891116QE4" };
const GENERAL = { regime: "601", rfc: "EKU9003173C9" };
const settings = {
  conceptMode: "grouped" as const,
  conceptDescription: "Consumo de alimentos y bebidas",
};

function invoice(
  o: {
    issuer?: { regime: string | null; rfc: string | null };
    receptor?: typeof RECEPTOR_MORAL;
    gross?: number;
    itemized?: boolean;
  } = {},
) {
  return buildInvoiceRequest({
    docId: fakeId(),
    payload: cfdiPayload({
      lines: [taxedLine(o.gross ?? 11650, "iva16"), taxedLine(5000, "iva0")],
    }),
    receptor: o.receptor ?? RECEPTOR_MORAL,
    settings: o.itemized ? { ...settings, conceptMode: "itemized" } : settings,
    issuerPostalCode: ISSUER_POSTAL_CODE,
    cardForm: "04",
    timezone: "America/Mexico_City",
    issuer: o.issuer ?? RESICO,
  });
}

describe("RESICO ISR withholding: request shape", () => {
  it("a RESICO persona física invoicing a persona moral adds the ISR retention to every concept, priced at fiscal's base", () => {
    const b = invoice();
    expect(b.body.items).toHaveLength(2);
    for (const item of b.body.items) {
      expect(item.product.tax_included).toBe(false);
      expect(item.product.taxes).toHaveLength(2);
      expect(item.product.taxes[1]).toEqual({
        type: "ISR",
        rate: 0.0125,
        factor: "Tasa",
        withholding: true,
      });
    }
    // Fiscal figures: 16 % on 116.50 → IVA 16.07, base 100.43; 0 % on 50.00 → base 50.00.
    const iva = extractTax(11650, 1600).tax;
    expect(b.body.items[0].product.price).toBe((11650 - iva) / 100);
    expect(b.body.items[1].product.price).toBe(50);
    expect(b.expectedTotal).toBe(16650);
    expect(b.expectedTax).toBe(iva);
    // 1.25 % of each base, rounded half up per concept.
    expect(b.expectedWithholding).toBe(
      Math.round((11650 - iva) * 0.0125) + Math.round(5000 * 0.0125),
    );
    expect(invoiceInput.safeParse(b.body).success).toBe(true);
  });

  it("no retention for a persona física receptor, a non-RESICO issuer, a moral issuer or a missing issuer", () => {
    for (const b of [
      invoice({ receptor: RECEPTOR_FISICA }),
      invoice({ issuer: GENERAL }),
      invoice({ issuer: { regime: "626", rfc: "URE180429TM6" } }),
      invoice({ issuer: { regime: null, rfc: null } }),
    ]) {
      expect(b.expectedWithholding).toBe(0);
      for (const item of b.body.items) {
        expect(item.product.tax_included).toBe(true);
        expect(item.product.taxes).toHaveLength(1);
      }
    }
  });

  it("itemized concepts fall back to grouped when the retention applies", () => {
    const b = invoice({ itemized: true });
    expect(b.conceptMode).toBe("grouped");
    expect(b.itemizedFallback).toBe("withholding");
    expect(invoice({ itemized: true, issuer: GENERAL }).conceptMode).toBe(
      "itemized",
    );
  });

  it("globals never carry a retention (PUBLICO EN GENERAL)", () => {
    const payload = cfdiPayload({ lines: [taxedLine(11600, "iva16")] });
    const [part] = buildGlobalRequests({
      docIds: fakeId,
      tickets: [
        {
          id: payload.ticket.id,
          folio: payload.ticket.folio,
          groups: netGroups(payload.ticket.groups, []),
          payments: payload.payments,
        },
      ],
      period: { periodicity: "day", months: "10", year: 2026 },
      issuerPostalCode: ISSUER_POSTAL_CODE,
      cardForm: "04",
    });
    expect(part.body.items.every((i) => i.product.taxes.length === 1)).toBe(
      true,
    );
  });

  it("a credit note of a parent with the retention reverses it too; a global parent never", () => {
    const refund = {
      method: "cash",
      groups: [{ category: "iva16" as const, gross: 5800, tax: 800 }],
    };
    const withheld = buildEgresoRequest({
      docId: fakeId(),
      folio: "A-000123",
      parent: {
        kind: "invoice",
        uuid: "39c85a3f-275b-4341-b259-e8971d9f8a94",
        receptor: RECEPTOR_MORAL,
        paymentForm: "01",
        withholding: true,
      },
      refund,
      issuerPostalCode: ISSUER_POSTAL_CODE,
      cardForm: "04",
    });
    expect(withheld.body.items[0].product).toMatchObject({
      price: 50,
      tax_included: false,
    });
    expect(withheld.expectedWithholding).toBe(63); // 5000 × 1.25 % = 62.5 → 63
    expect(withheld.expectedTax).toBe(800);
    const global = buildEgresoRequest({
      docId: fakeId(),
      folio: "A-000123",
      parent: {
        kind: "global",
        uuid: "39c85a3f-275b-4341-b259-e8971d9f8a94",
        receptor: null,
        paymentForm: "01",
        withholding: true,
      },
      refund,
      issuerPostalCode: ISSUER_POSTAL_CODE,
      cardForm: "04",
    });
    expect(global.expectedWithholding).toBe(0);
    expect(global.body.items[0].product.tax_included).toBe(true);
  });

  it("the strict schema refuses a retention that is not the documented shape", () => {
    const base = invoice().body.items[0].product;
    expect(productInput.safeParse(base).success).toBe(true);
    // Retention first, with a tax-inclusive price, at another rate, or twice the IVA.
    for (const bad of [
      { ...base, taxes: [base.taxes[1], base.taxes[0]] },
      { ...base, tax_included: true },
      { ...base, taxes: [base.taxes[0], { ...base.taxes[1], rate: 0.1 }] },
      { ...base, taxes: [base.taxes[0], base.taxes[0]] },
      { ...base, taxes: [base.taxes[0]] },
    ])
      expect(productInput.safeParse(bad).success).toBe(false);
  });

  it("every field of the retention exists in the vendored OpenAPI BaseTax", () => {
    const spec = JSON.parse(
      readFileSync("tests/fixtures/facturapi/openapi-v2-subset.json", "utf8"),
    );
    const tax = spec.components.schemas.BaseTax;
    expect(tax.properties.type.enum).toContain("ISR");
    expect(tax.properties.factor.enum).toContain("Tasa");
    expect(tax.properties.withholding.type).toBe("boolean");
    expect(tax.properties.rate.type).toBe("number");
    const product = spec.components.schemas.ProductProperties;
    expect(product.properties.tax_included.type).toBe("boolean");
  });
});

describe("RESICO ISR withholding: stamped through the fake", () => {
  it("the stamped XML shows the retention, Total = SubTotal + IVA − ISR, and the pre-retention totals match the canonical figures", async () => {
    const fake = createFacturapiFake({
      now: new Date("2026-10-05T18:00:00.000Z"),
    });
    const client = createFacturapiClient({
      fetch: fake.fetch,
      baseUrl: FAKE_BASE_URL,
      userAgent: "green-monkey/test",
    });
    const org = await client.createOrganization(USER_KEY, {
      name: "Taquería RESICO · GM-0b6a1a8e",
    });
    await client.updateLegal(USER_KEY, org.id, {
      name: "Taquería RESICO",
      legal_name: "BERENICE XIMO QUEZADA",
      tax_system: "626",
      address: { zip: ISSUER_POSTAL_CODE },
    });
    const key: FacturapiKey = {
      kind: "test",
      secret: await client.getTestApiKey(USER_KEY, org.id),
    };
    const b = invoice();
    const { invoice: stamped } = await client.createInvoice(key, b.body);
    expect(stamped.status).toBe("valid");
    const xml = await client.download(key, stamped.id, "xml");
    const totals = parseCfdiTotals(xml);
    const canonical = canonicalAmounts(b.body);
    expect(totals.taxRetenidos).toBe(b.expectedWithholding);
    expect(totals.taxRetenidos).toBe(canonical.withheld);
    expect(totals.taxTraslados).toBe(canonical.tax);
    expect(totals.total + totals.taxRetenidos).toBe(canonical.total);
    expect(totals.total).toBe(
      totals.subtotal + totals.taxTraslados - totals.taxRetenidos,
    );
    expect(totals.concepts.every((c) => c.retenciones.length === 1)).toBe(true);
    expect(totals.retenciones).toEqual([
      { impuesto: "001", rate: null, base: 0, importe: b.expectedWithholding },
    ]);
    // Fiscal's base on each concept; the stamped IVA of a base-priced concept may differ from
    // fiscal's by at most a centavo (Base × rate rounded vs extractTax): the documented bound.
    expect(Math.abs(totals.taxTraslados - b.expectedTax)).toBeLessThanOrEqual(
      b.body.items.length,
    );
    expect(
      Math.abs(stamped.total! * 100 + b.expectedWithholding - b.expectedTotal),
    ).toBeLessThanOrEqual(b.body.items.length);
  });
});
