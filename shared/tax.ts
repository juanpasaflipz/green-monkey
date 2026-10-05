// shared/tax.ts — leaf module: no imports from other shared files.
import { z } from "zod";

export const TAX_CATEGORIES = ["iva16", "iva8", "iva0", "exempt"] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];
export const TAX_REGIONS = ["general", "border_north", "border_south"] as const;
export type TaxRegion = (typeof TAX_REGIONS)[number];

export type TaxRule = {
  category: TaxCategory;
  rateBps: number | null; // 1600 | 800 | 0 | null (exempt)
  satTax: "002"; // c_Impuesto: IVA
  satFactor: "Tasa" | "Exento"; // c_TipoFactor
  satRate: string | null; // c_TasaOCuota, 6 decimals
  objetoImp: "02"; // c_ObjetoImp: sí objeto de impuesto
};
export const TAX_RULES: Readonly<Record<TaxCategory, TaxRule>> = {
  iva16: {
    category: "iva16",
    rateBps: 1600,
    satTax: "002",
    satFactor: "Tasa",
    satRate: "0.160000",
    objetoImp: "02",
  },
  iva8: {
    category: "iva8",
    rateBps: 800,
    satTax: "002",
    satFactor: "Tasa",
    satRate: "0.080000",
    objetoImp: "02",
  },
  iva0: {
    category: "iva0",
    rateBps: 0,
    satTax: "002",
    satFactor: "Tasa",
    satRate: "0.000000",
    objetoImp: "02",
  },
  exempt: {
    category: "exempt",
    rateBps: null,
    satTax: "002",
    satFactor: "Exento",
    satRate: null,
    objetoImp: "02",
  },
};

export const SAT_DEFAULT_PRODUCT_KEY = "90101501"; // c_ClaveProdServ "Restaurantes"
export const SAT_DEFAULT_UNIT_KEY = "E48"; // c_ClaveUnidad "Unidad de servicio"
export const SAT_GLOBAL_PRODUCT_KEY = "01010101"; // global CFDI concept
export const SAT_GLOBAL_UNIT_KEY = "ACT";
/** DOF 31-12-2025 extended the border-region IVA incentive to this date (see docs/FISCAL.md). */
export const BORDER_STIMULUS_VALID_UNTIL = "2026-12-31";

export const productFiscalInput = z
  .object({
    taxCategory: z.enum(["default", ...TAX_CATEGORIES]).default("default"),
    satProductKey: z
      .string()
      .regex(/^\d{8}$/)
      .nullable()
      .default(null),
    satUnitKey: z
      .string()
      .regex(/^[A-Z0-9]{1,3}$/)
      .nullable()
      .default(null),
  })
  .strict();
export type ProductFiscal = z.infer<typeof productFiscalInput>;
export function defaultProductFiscal(): ProductFiscal {
  return { taxCategory: "default", satProductKey: null, satUnitKey: null };
}

export type FiscalContext = { region: TaxRegion; defaultCategory: TaxCategory };
export const DEFAULT_FISCAL_CONTEXT: FiscalContext = {
  region: "general",
  defaultCategory: "iva16",
};

export function allowedCategories(region: TaxRegion): TaxCategory[] {
  return region === "general"
    ? ["iva16", "iva0", "exempt"]
    : ["iva16", "iva8", "iva0", "exempt"];
}

/**
 * Splits a tax-inclusive integer amount (centavos) into base + tax, exactly.
 * tax = round-half-up(gross × r / (10000 + r)); base = gross − tax.
 * Identical to shared/domain.ts tax(gross, r, true) for r ∈ {1600, 800} (no ties exist).
 */
export function extractTax(
  gross: number,
  rateBps: number | null,
): { base: number; tax: number } {
  if (!Number.isSafeInteger(gross) || gross < 0)
    throw new RangeError("invalid_amount");
  if (rateBps === null || rateBps === 0) return { base: gross, tax: 0 };
  const g = BigInt(gross),
    r = BigInt(rateBps),
    d = 10000n + r;
  const tax = Number((2n * g * r + d) / (2n * d));
  return { base: gross - tax, tax };
}

/** SAT CFDI 4.0 traslado limits for a 2-decimal base and Importe, in centavos. */
export function satTaxWithinTolerance(
  base: number,
  tax: number,
  rateBps: number | null,
): boolean {
  if (rateBps === null || rateBps === 0) return tax === 0;
  if (base < 0 || tax < 0) return false;
  const b = BigInt(base),
    r = BigInt(rateBps),
    t = BigInt(tax);
  const lowerNum = (2n * b - 1n) * r; // (B − 0.5) × r × 20000
  const lower = lowerNum < 0n ? 0n : lowerNum / 20000n; // truncate
  const upper = ((2n * b + 1n) * r + 19999n) / 20000n; // round up
  return t >= lower && t <= upper;
}

export type TaxBasis = "product" | "default" | "fallback";
export type LineTaxSnapshot = {
  v: 1;
  category: TaxCategory;
  rateBps: number | null;
  basis: TaxBasis;
  satProductKey: string;
  satUnitKey: string;
  /** Informational split of the full line total at quote time. Tickets recompute from remaining units. */
  base: number;
  tax: number;
};

export function resolveTaxCategory(
  fiscal: unknown,
  ctx: FiscalContext,
): { category: TaxCategory; basis: TaxBasis } {
  const parsed = productFiscalInput.safeParse(fiscal ?? {});
  const wanted = parsed.success ? parsed.data.taxCategory : "default";
  if (wanted === "default")
    return { category: ctx.defaultCategory, basis: "default" };
  if (!allowedCategories(ctx.region).includes(wanted))
    return { category: ctx.defaultCategory, basis: "fallback" };
  return { category: wanted, basis: "product" };
}

export function lineTaxSnapshot(
  fiscal: unknown,
  lineTotal: number,
  ctx: FiscalContext,
): LineTaxSnapshot {
  const parsed = productFiscalInput.safeParse(fiscal ?? {});
  const pf = parsed.success ? parsed.data : defaultProductFiscal();
  const { category, basis } = resolveTaxCategory(pf, ctx);
  const rule = TAX_RULES[category];
  const { base, tax } = extractTax(lineTotal, rule.rateBps);
  return {
    v: 1,
    category,
    rateBps: rule.rateBps,
    basis,
    satProductKey: pf.satProductKey ?? SAT_DEFAULT_PRODUCT_KEY,
    satUnitKey: pf.satUnitKey ?? SAT_DEFAULT_UNIT_KEY,
    base,
    tax,
  };
}
