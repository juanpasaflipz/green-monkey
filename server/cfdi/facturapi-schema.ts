/**
 * Facturapi API v2 shapes used by cfdi (030).
 *
 * Source: the official OpenAPI document FacturAPI/facturapi-docs `website/openapi_v2.en.yaml`,
 * commit 1c2e617 (2026-09-19), vendored as a subset in tests/fixtures/facturapi/openapi-v2-subset.json,
 * plus the official Node SDK types (Context7 /facturapi/facturapi-node: Invoice, Organization,
 * FacturapiErrorDetail, SearchResult). The contract test checks every request field below against
 * that subset, so a field the documentation does not have cannot be sent.
 *
 * Requests are STRICT: only the fields cfdi sends, with the documented limits. A body that fails
 * these schemas is never sent. Responses are LOOSE (unknown fields kept): they read only what cfdi
 * stores, and a mismatch means the provider changed (a permanent `schema` error, see facturapi.ts).
 *
 * Pure module: zod only, no I/O. Used by the worker, the tests and the fake (tests/fakes).
 */
import { z } from "zod";

/** SAT folio fiscal (UUID) as SAT/PACs print it; case-insensitive, no version check. */
export const SAT_UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Facturapi object ids (24-hex ObjectIds today); kept conservative for URL paths. */
export const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Receptor RFC as Facturapi validates it (generic RFCs included, for the global invoice). */
export const RECEPTOR_RFC = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

const zip = z.string().regex(/^\d{5}$/);

// ---------------------------------------------------------------------------------------------
// Requests (strict)
// ---------------------------------------------------------------------------------------------

/** BaseTax: an IVA traslado (IEPS is out of scope, fiscal D8). */
export const ivaTaxInput = z
  .object({
    type: z.literal("IVA"),
    rate: z.union([z.literal(0.16), z.literal(0.08), z.literal(0)]),
    factor: z.enum(["Tasa", "Exento"]),
    withholding: z.literal(false),
  })
  .strict();
/**
 * BaseTax: the RESICO ISR retention (LISR 113-J, LD-16 L9), 1.25 % of the concept base, withheld by
 * a persona moral from a persona física in régimen 626. Shape from the OpenAPI BaseTax (type enum
 * IVA/ISR/IEPS, `withholding` boolean) and the Node SDK `Tax` type (Context7 /facturapi/facturapi-node).
 */
export const isrWithholdingInput = z
  .object({
    type: z.literal("ISR"),
    rate: z.literal(0.0125),
    factor: z.literal("Tasa"),
    withholding: z.literal(true),
  })
  .strict();
export const taxInput = z.union([ivaTaxInput, isrWithholdingInput]);

/**
 * LineItemProductInput / LineItemProductEgresoInput (ProductProperties).
 *
 * Taxes: exactly the IVA traslado, or the IVA traslado followed by the RESICO ISR retention. With
 * a retention the price is the concept BASE (`tax_included: false`): the documentation says a
 * tax-inclusive price includes "all applicable taxes" without saying how a withholding enters that
 * price, so a tax-inclusive price could move the base away from fiscal's. Without a retention the
 * price is tax-inclusive (`tax_included: true`), the exact strategy of spec §4.3.
 */
export const productInput = z
  .object({
    description: z.string().min(1).max(1000),
    product_key: z.string().regex(/^\d{8}$/),
    unit_key: z.string().regex(/^[A-Z0-9]{1,3}$/),
    unit_name: z.string().min(1).max(20),
    price: z.number().positive().multipleOf(0.000001),
    tax_included: z.boolean(),
    taxability: z.literal("02"),
    taxes: z.array(taxInput).min(1).max(2),
    // NoIdentificacion. ProductProperties (ingreso) documents `sku`; ProductEgresoProperties does
    // not, so credit notes never send it (enforced on the invoice body below).
    sku: z.string().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const [first, second] = p.taxes;
    if (first.type !== "IVA" || first.withholding)
      ctx.addIssue({
        code: "custom",
        path: ["taxes", 0],
        message: "the first tax is the IVA traslado",
      });
    if (second && second.type !== "ISR")
      ctx.addIssue({
        code: "custom",
        path: ["taxes", 1],
        message: "the second tax can only be the ISR retention",
      });
    if (p.tax_included !== !second)
      ctx.addIssue({
        code: "custom",
        path: ["tax_included"],
        message: "a price with a retention is the base (tax_included false)",
      });
  });

/** LineItemInput / LineItemEgresoInput with an inline product. */
export const itemInput = z
  .object({ quantity: z.number().positive(), product: productInput })
  .strict();

/** CustomerCreateInput: a receptor sent inline (never a stored Facturapi customer). */
export const customerInput = z
  .object({
    legal_name: z.string().min(1).max(254),
    tax_id: z.string().regex(RECEPTOR_RFC),
    tax_system: z.string().regex(/^\d{3}$/),
    email: z.email().max(254).optional(),
    address: z.object({ zip, country: z.literal("MEX").optional() }).strict(),
  })
  .strict();

/** InvoiceIngresoInput (type "I") or InvoiceEgresoInput (type "E"), fields cfdi sends only. */
export const invoiceInput = z
  .object({
    type: z.enum(["I", "E"]),
    customer: customerInput,
    items: z.array(itemInput).min(1).max(5000),
    payment_form: z.string().regex(/^\d{2}$/),
    payment_method: z.literal("PUE"),
    use: z.enum(["G01", "G02", "G03", "S01"]),
    currency: z.literal("MXN"),
    series: z.string().min(1).max(25),
    address: z.object({ zip }).strict(),
    global: z
      .object({
        periodicity: z.enum(["day", "week", "fortnight", "month"]),
        months: z.string().regex(/^(0[1-9]|1[0-2])$/),
        year: z.number().int().min(2021).max(2100),
      })
      .strict()
      .optional(),
    related_documents: z
      .array(
        z
          .object({
            relationship: z.enum(["01", "04"]),
            documents: z.array(z.string().regex(SAT_UUID)).min(1),
          })
          .strict(),
      )
      .optional(),
    external_id: z.string().uuid(),
    idempotency_key: z.string().uuid(),
    pdf_custom_section: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    body.items.forEach((item, i) => {
      // Ingreso concepts carry the ticket folio as NoIdentificacion; egreso products have no sku.
      if ((body.type === "I") !== (item.product.sku !== undefined))
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "product", "sku"],
          message:
            body.type === "I"
              ? "ingreso concepts need sku"
              : "egreso products have no sku",
        });
    });
    // InvoiceIngresoInput has `global`; InvoiceEgresoInput does not (OpenAPI subset).
    if (body.type === "E" && body.global)
      ctx.addIssue({
        code: "custom",
        path: ["global"],
        message: "global is not an egreso field",
      });
    if (body.global && body.use !== "S01")
      ctx.addIssue({
        code: "custom",
        path: ["use"],
        message: "a global invoice uses S01",
      });
  });
export type FInvoiceInput = z.infer<typeof invoiceInput>;
export type FItemInput = z.infer<typeof itemInput>;
export type FTaxInput = z.infer<typeof taxInput>;
export type FIvaTaxInput = z.infer<typeof ivaTaxInput>;
export type FCustomerInput = z.infer<typeof customerInput>;

/** OrganizationLegalInput (name and legal_name ≤ 100: the documented limit, spec R14). */
export const legalInput = z
  .object({
    name: z.string().min(1).max(100),
    legal_name: z.string().min(1).max(100),
    tax_system: z.string().regex(/^\d{3}$/),
    address: z
      .object({
        zip,
        street: z.string().max(100).optional(),
        neighborhood: z.string().max(80).optional(),
        municipality: z.string().max(80).optional(),
        state: z.string().max(60).optional(),
      })
      .strict(),
  })
  .strict();
export type FLegalInput = z.infer<typeof legalInput>;

/** OrganizationCreateInput. */
export const organizationCreateInput = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

/** POST /invoices/{id}/email body: up to 10 addresses (documented maxLength 10). */
export const emailInput = z
  .object({ email: z.array(z.email().max(254)).min(1).max(10) })
  .strict();

/** DELETE /invoices/{id} query. Motive 01 needs the substitute's UUID (SAT). */
export const cancelQuery = z
  .object({
    motive: z.enum(["01", "02", "03", "04"]),
    substitution: z.string().regex(SAT_UUID).optional(),
  })
  .strict()
  .refine((q) => (q.motive === "01") === (q.substitution !== undefined), {
    message: "substitution is required with motive 01 and only then",
  });
export type FCancelQuery = z.infer<typeof cancelQuery>;

// ---------------------------------------------------------------------------------------------
// Responses (loose: unknown fields pass through)
// ---------------------------------------------------------------------------------------------

const optionalText = z.string().nullish();

/**
 * Invoice (ResourceAutoGeneratedProps + InvoiceProperties); fields cfdi reads. The OpenAPI Invoice
 * requires only id, created_at and livemode (InvoiceProperties has no required list; the 202
 * answer adds status), so total, date, type and uuid are optional here: a documented 202 pending
 * object, or one found while adopting by external_id, always parses. `status` is required because
 * no decision can be made without it. Where a stamp is recorded, stampFacts() (facturapi.ts)
 * requires uuid, total and a date.
 */
export const invoiceResponse = z.looseObject({
  id: z.string().regex(PROVIDER_ID),
  livemode: z.boolean(),
  status: z.enum(["pending", "valid", "canceled", "draft", "failed"]),
  cancellation_status: z
    .enum(["none", "verifying", "pending", "accepted", "rejected", "expired"])
    .nullish()
    .transform((s) => s ?? "none"),
  uuid: z.string().regex(SAT_UUID).nullish(),
  total: z.number().finite().nonnegative().nullish(),
  // The SDK types folio_number as number | string; both are kept as a positive integer or null.
  folio_number: z
    .union([z.number().int().positive(), z.string().regex(/^\d{1,15}$/)])
    .nullish()
    .transform((f) => (f === null || f === undefined ? null : Number(f))),
  series: optionalText,
  stamp: z.looseObject({ date: z.string().nullish() }).nullish(),
  verification_url: optionalText,
  date: z.string().nullish(),
  type: z.enum(["I", "E", "P", "N", "T"]).nullish(),
  external_id: optionalText,
  idempotency_key: optionalText,
});
export type FInvoice = z.infer<typeof invoiceResponse>;

/** Organization; fields cfdi reads (legal.tax_id is in the SDK type, not the OpenAPI schema). */
export const organizationResponse = z.looseObject({
  id: z.string().regex(PROVIDER_ID),
  is_production_ready: z
    .boolean()
    .nullish()
    .transform((b) => b ?? false),
  pending_steps: z
    .array(
      z.looseObject({
        type: z.string(),
        description: z
          .string()
          .nullish()
          .transform((d) => d ?? ""),
      }),
    )
    .nullish()
    .transform((s) => s ?? []),
  legal: z
    .looseObject({
      name: optionalText,
      legal_name: optionalText,
      tax_system: optionalText,
      tax_id: optionalText,
    })
    .nullish(),
  certificate: z
    .looseObject({
      has_certificate: z
        .boolean()
        .nullish()
        .transform((b) => b ?? false),
      expires_at: optionalText,
      serial_number: optionalText,
      updated_at: optionalText,
    })
    .nullish(),
});
export type FOrganization = z.infer<typeof organizationResponse>;

/** SearchResult<T>: `data` is the only required field (cursor searches omit the page fields). */
export function searchResult<T extends z.ZodType>(item: T) {
  return z.looseObject({
    data: z.array(item),
    page: z.number().int().nullish(),
    total_pages: z.number().int().nullish(),
    total_results: z.number().int().nullish(),
  });
}

/** GET /organizations/{id}/apikeys/test and PUT …/apikeys/live: a JSON string. */
export const apiKeyResponse = z.string().min(9).max(512);

/** POST /invoices/{id}/email: `{ ok: true }`. */
export const okResponse = z.looseObject({ ok: z.literal(true) });

/** ErrorDetail. */
export const errorDetail = z.looseObject({
  code: z.string().nullish(),
  message: z.string().nullish(),
  source: z.string().nullish(),
  path: z.string().nullish(),
  location: z.string().nullish(),
});

/** GenericError `{ok:false, message, status, code, location?, path?, errors?[]}`, read leniently. */
export const errorResponse = z.looseObject({
  ok: z.boolean().nullish(),
  message: z.string().nullish(),
  status: z.number().int().nullish(),
  code: z.string().nullish(),
  location: z.string().nullish(),
  path: z.string().nullish(),
  errors: z.array(errorDetail).nullish(),
});
