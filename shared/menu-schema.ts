// Strict input schemas for the menu, floor and stock-item routes. The client
// runs the same schemas (safeParse) before posting, so field errors match.
import { z } from "zod";
import { id, money } from "./domain.js";
import { MENU_LIMITS } from "./menu.js";
import { productFiscalInput } from "./tax.js";

const name80 = z.string().trim().min(1).max(80);
/** Spanish name required; a blank English name stores the Spanish one (D9). */
export const bilingual = z
  .object({ es: name80, en: z.string().trim().max(80).default("") })
  .strict()
  .transform((v) => ({ es: v.es, en: v.en || v.es }));
/** Plain decimal text in the stock item's unit; compared > 0 where required. */
export const quantityText = z.string().regex(/^\d{1,9}(\.\d{1,6})?$/);
export const recipeLineInput = z
  .object({ stockId: id, quantity: quantityText })
  .strict();
export const recipeInput = z
  .array(recipeLineInput)
  .max(MENU_LIMITS.recipeLines)
  .refine(
    (r) => new Set(r.map((x) => x.stockId)).size === r.length,
    "duplicate",
  );
const version0 = z.number().int().nonnegative();

export const categoryInput = z
  .object({ operationId: id, id, expectedVersion: version0, name: bilingual })
  .strict();
/** scopeId: the category (products) or area (tables) being reordered. */
export const reorderInput = z
  .object({
    operationId: id,
    scopeId: id.nullable().default(null),
    ids: z.array(id).min(1).max(MENU_LIMITS.products),
  })
  .strict();
export const archiveInput = z
  .object({
    operationId: id,
    id,
    expectedVersion: z.number().int().positive(),
    archived: z.boolean(),
  })
  .strict();
export const availabilityInput = z
  .object({ operationId: id, id, available: z.boolean() })
  .strict();
export const optionAvailabilityInput = z
  .object({
    operationId: id,
    groupId: id,
    optionId: id,
    available: z.boolean(),
  })
  .strict();

export const optionInput = z
  .object({
    id,
    name: bilingual,
    price: money,
    cost: money.nullable().default(null),
    recipe: recipeInput.default([]),
  })
  .strict();
export const groupInput = z
  .object({
    operationId: id,
    id,
    expectedVersion: version0,
    name: bilingual,
    min: z.number().int().min(0).max(MENU_LIMITS.choicesPerLine),
    max: z.number().int().min(1).max(MENU_LIMITS.choicesPerLine),
    repeat: z.boolean().default(false),
    options: z.array(optionInput).min(1).max(MENU_LIMITS.optionsPerGroup),
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.min > g.max)
      ctx.addIssue({ code: "custom", path: ["min"], message: "min_above_max" });
    if (!g.repeat && g.max > g.options.length)
      ctx.addIssue({
        code: "custom",
        path: ["max"],
        message: "max_above_options",
      });
    const ids = new Set<string>(),
      names = new Set<string>();
    g.options.forEach((o, index) => {
      if (ids.has(o.id))
        ctx.addIssue({
          code: "custom",
          path: ["options", index, "id"],
          message: "duplicate",
        });
      ids.add(o.id);
      const key = o.name.es.toLocaleLowerCase("es-MX");
      if (names.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["options", index, "name"],
          message: "duplicate",
        });
      names.add(key);
    });
  });

// fiscal (027): optional; absent keeps the stored value.
export const productInput = z
  .object({
    operationId: id,
    id,
    expectedVersion: version0,
    name: bilingual,
    categoryId: id,
    kind: z.enum(["item", "combo"]).default("item"),
    price: money,
    openAmount: z.boolean().default(false),
    openMax: money
      .refine((n) => n > 0)
      .nullable()
      .default(null),
    station: z.enum(["kitchen", "bar"]),
    /** Used on create only; availability of a saved product is live state. */
    available: z.boolean().default(true),
    groupIds: z.array(id).max(MENU_LIMITS.groupsPerProduct).default([]),
    recipe: recipeInput.default([]),
    cost: money.nullable().default(null),
    fiscal: productFiscalInput.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.openAmount && p.openMax === null)
      ctx.addIssue({ code: "custom", path: ["openMax"], message: "required" });
    if (p.openAmount && p.price !== 0)
      ctx.addIssue({ code: "custom", path: ["price"], message: "open_price" });
    if (!p.openAmount && p.openMax !== null)
      ctx.addIssue({
        code: "custom",
        path: ["openMax"],
        message: "unexpected",
      });
    if (new Set(p.groupIds).size !== p.groupIds.length)
      ctx.addIssue({
        code: "custom",
        path: ["groupIds"],
        message: "duplicate",
      });
  });
export type ProductInput = z.infer<typeof productInput>;
export type GroupInput = z.infer<typeof groupInput>;

/** The pre-025 POST /catalog/save body, kept for clients of the previous revision. */
const legacyLabel = z
  .object({ es: z.string().min(1).max(120), en: z.string().min(1).max(120) })
  .strict();
export const legacyProductInput = z
  .object({
    operationId: id,
    id,
    name: legacyLabel,
    category: legacyLabel,
    price: money,
    available: z.boolean(),
    station: z.enum(["kitchen", "bar"]),
    expectedVersion: z.number().int().nonnegative(),
    cost: money.nullable(),
    recipe: z
      .array(
        z.object({
          stockId: id,
          quantity: z.string().regex(/^\d+(\.\d{1,6})?$/),
        }),
      )
      .max(MENU_LIMITS.recipeLines),
  })
  .strict();

export const areaInput = z
  .object({
    operationId: id,
    id,
    expectedVersion: version0,
    name: z.string().trim().min(1).max(60),
  })
  .strict();
export const tableInput = z
  .object({
    operationId: id,
    id,
    expectedVersion: version0,
    name: z.string().trim().min(1).max(40),
    areaId: id.nullable(),
    seats: z.number().int().min(1).max(99).nullable().default(null),
  })
  .strict();
export const tablesBulkInput = z
  .object({
    operationId: id,
    areaId: id.nullable(),
    prefix: z.string().trim().max(30).default("Mesa"),
    from: z.number().int().min(1).max(999),
    to: z.number().int().min(1).max(999),
    seats: z.number().int().min(1).max(99).nullable().default(null),
  })
  .strict()
  .refine((b) => b.to >= b.from && b.to - b.from < MENU_LIMITS.tablesPerBatch, {
    path: ["to"],
    message: "range",
  });

export const stockUnits = ["g", "kg", "ml", "l", "piece"] as const;
/** expectedVersion is the item's settings_version (0 to create). */
export const stockItemInput = z
  .object({
    operationId: id,
    id,
    expectedVersion: version0,
    name: z.string().trim().min(1).max(80),
    unit: z.enum(stockUnits),
    kind: z.enum(["raw", "prepared"]),
    threshold: quantityText,
    parLevel: quantityText.nullable(),
    openingQuantity: quantityText.nullable().default(null),
  })
  .strict();
export const stockPolicyInput = z
  .object({ operationId: id, policy: z.enum(["allow", "block"]) })
  .strict();
/** `before` is the `next` cursor of the previous page: an ISO instant,
 * optionally followed by "_<movement id>" to break timestamp ties. */
export const movementsQuery = z
  .object({
    before: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})(_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i,
      )
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
