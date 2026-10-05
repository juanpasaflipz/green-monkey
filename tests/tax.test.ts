import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { tax as domainTax } from "../shared/domain";
import {
  allowedCategories,
  BORDER_STIMULUS_VALID_UNTIL,
  DEFAULT_FISCAL_CONTEXT,
  defaultProductFiscal,
  extractTax,
  lineTaxSnapshot,
  productFiscalInput,
  resolveTaxCategory,
  SAT_DEFAULT_PRODUCT_KEY,
  SAT_DEFAULT_UNIT_KEY,
  SAT_GLOBAL_PRODUCT_KEY,
  SAT_GLOBAL_UNIT_KEY,
  satTaxWithinTolerance,
  TAX_CATEGORIES,
  TAX_REGIONS,
  TAX_RULES,
  type FiscalContext,
  type TaxCategory,
} from "../shared/tax";
import {
  GENERIC_RFCS,
  ISSUER_REGIMES,
  postalCodeSchema,
  REGIMEN_FISCAL,
  regimeAllowedFor,
  regimenFiscalSchema,
  rfcCheckDigitValid,
  rfcKind,
  rfcSchema,
  RFC_PATTERN,
  validateRfc,
} from "../shared/sat";
import { rng } from "./fixtures/fiscal";

const TAXED_RATES = [1600, 800] as const;
const border: FiscalContext = {
  region: "border_north",
  defaultCategory: "iva8",
};

describe("tax rules", () => {
  it.each([
    ["iva16", 1600, "Tasa", "0.160000"],
    ["iva8", 800, "Tasa", "0.080000"],
    ["iva0", 0, "Tasa", "0.000000"],
    ["exempt", null, "Exento", null],
  ] as const)(
    "%s maps to IVA (002), rate %s bps, factor %s, TasaOCuota %s, ObjetoImp 02",
    (category, rateBps, satFactor, satRate) => {
      expect(TAX_RULES[category]).toEqual({
        category,
        rateBps,
        satTax: "002",
        satFactor,
        satRate,
        objetoImp: "02",
      });
    },
  );

  it("lists categories in canonical ticket order and the three regions", () => {
    expect(TAX_CATEGORIES).toEqual(["iva16", "iva8", "iva0", "exempt"]);
    expect(TAX_REGIONS).toEqual(["general", "border_north", "border_south"]);
    expect(Object.keys(TAX_RULES)).toEqual([...TAX_CATEGORIES]);
  });

  it("keeps the SAT default keys, global concept keys and the DOF border incentive date", () => {
    expect(SAT_DEFAULT_PRODUCT_KEY).toBe("90101501");
    expect(SAT_DEFAULT_UNIT_KEY).toBe("E48");
    expect(SAT_GLOBAL_PRODUCT_KEY).toBe("01010101");
    expect(SAT_GLOBAL_UNIT_KEY).toBe("ACT");
    expect(BORDER_STIMULUS_VALID_UNTIL).toBe("2026-12-31");
    expect(DEFAULT_FISCAL_CONTEXT).toEqual({
      region: "general",
      defaultCategory: "iva16",
    });
  });

  it("allows IVA 8% only in the border regions", () => {
    expect(allowedCategories("general")).toEqual(["iva16", "iva0", "exempt"]);
    for (const region of ["border_north", "border_south"] as const)
      expect(allowedCategories(region)).toEqual([...TAX_CATEGORIES]);
  });
});

describe("extractTax", () => {
  it("base + tax equals gross for every amount 0..2,000,000 at 16% and 8%", () => {
    for (const r of TAXED_RATES) {
      const d = 10000 + r;
      for (let g = 0; g <= 2_000_000; g++) {
        const { base, tax } = extractTax(g, r);
        // Exact reconciliation, both parts non-negative, and tax is the nearest integer to
        // g·r/(10000+r): |tax·d − g·r| ≤ d/2 (Number math is exact below 2^53 here).
        if (
          base + tax !== g ||
          base < 0 ||
          tax < 0 ||
          2 * Math.abs(tax * d - g * r) > d ||
          (2 * g * r) % (2 * d) === d // a tie would make "round half up" matter: none exist
        )
          throw new Error(`gross ${g} at ${r} bps → ${base} + ${tax}`);
      }
    }
  });

  it("extractTax equals domain tax(gross, rate, true) for every amount 0..200,000 at 16% and 8%", () => {
    for (const r of TAXED_RATES)
      for (let g = 0; g <= 200_000; g++)
        if (extractTax(g, r).tax !== domainTax(g, r, true))
          throw new Error(`gross ${g} at ${r} bps`);
  });

  it("every split is within the SAT CFDI 4.0 traslado tolerance (2 decimals)", () => {
    for (const r of TAXED_RATES) {
      for (let g = 0; g <= 2_000_000; g++) {
        const { base, tax } = extractTax(g, r);
        if (!satTaxWithinTolerance(base, tax, r))
          throw new Error(`gross ${g} at ${r} bps → ${base} + ${tax}`);
      }
      const random = rng(r);
      for (let i = 0; i < 100_000; i++) {
        const g = random.int(2_000_000, 100_000_000);
        const { base, tax } = extractTax(g, r);
        expect(satTaxWithinTolerance(base, tax, r), `${g}`).toBe(true);
      }
    }
  });

  it.each([
    [0, 1600, 0, 0],
    [1, 1600, 1, 0],
    [3, 1600, 3, 0],
    [4, 1600, 3, 1],
    [11600, 1600, 10000, 1600],
    [12500, 1600, 10776, 1724], // the spec's 80 mm ticket: Base $107.76, IVA $17.24
    [100_000_000, 1600, 86_206_897, 13_793_103],
    [1, 800, 1, 0],
    [7, 800, 6, 1],
    [100, 800, 93, 7],
    [10800, 800, 10000, 800],
    [100_000_000, 800, 92_592_593, 7_407_407],
  ])("gross %i at %i bps → base %i, tax %i", (gross, r, base, tax) => {
    expect(extractTax(gross, r)).toEqual({ base, tax });
  });

  it("0% and exempt keep base = gross and tax = 0; rejects negative and unsafe amounts", () => {
    for (const g of [0, 1, 999, 12500, 100_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(extractTax(g, 0)).toEqual({ base: g, tax: 0 });
      expect(extractTax(g, null)).toEqual({ base: g, tax: 0 });
    }
    for (const bad of [-1, 1.5, Number.NaN, Infinity, 2 ** 53, -0.01])
      for (const r of [1600, 800, 0, null])
        expect(() => extractTax(bad, r), `${bad} at ${r}`).toThrow(RangeError);
  });

  it("is monotone: base and tax each grow by 0 or 1 per centavo (so discount bases and refund bases are never negative)", () => {
    for (const r of TAXED_RATES) {
      let prev = extractTax(0, r);
      for (let g = 1; g <= 200_000; g++) {
        const next = extractTax(g, r);
        const db = next.base - prev.base,
          dt = next.tax - prev.tax;
        if (db + dt !== 1 || db < 0 || dt < 0)
          throw new Error(`step at ${g} for ${r} bps`);
        prev = next;
      }
    }
  });
});

describe("satTaxWithinTolerance", () => {
  it("rejects tax off by 2 centavos and accepts both neighbours of base × rate", () => {
    for (const r of TAXED_RATES)
      for (let base = 0; base <= 100_000; base++) {
        const lo = Math.floor((base * r) / 10000),
          hi = Math.ceil((base * r) / 10000);
        if (
          !satTaxWithinTolerance(base, lo, r) ||
          !satTaxWithinTolerance(base, hi, r) ||
          satTaxWithinTolerance(base, hi + 2, r) ||
          (lo >= 2 && satTaxWithinTolerance(base, lo - 2, r))
        )
          throw new Error(`base ${base} at ${r} bps`);
      }
  });

  it("matches the Anexo 20 limits computed in decimal: trunc((Base − 0.005) × Tasa) .. ceil((Base + 0.005) × Tasa)", () => {
    const random = rng(20);
    for (const r of TAXED_RATES) {
      const rate = new Decimal(
        TAX_RULES[r === 1600 ? "iva16" : "iva8"].satRate!,
      );
      for (let i = 0; i < 20_000; i++) {
        const base = i < 1000 ? i : random.int(0, 100_000_000);
        const pesos = new Decimal(base).div(100);
        const lower = pesos
          .minus("0.005")
          .mul(rate)
          .toDecimalPlaces(2, Decimal.ROUND_DOWN)
          .mul(100)
          .toNumber();
        const upper = pesos
          .plus("0.005")
          .mul(rate)
          .toDecimalPlaces(2, Decimal.ROUND_UP)
          .mul(100)
          .toNumber();
        for (let t = Math.max(0, lower - 2); t <= upper + 2; t++)
          if (satTaxWithinTolerance(base, t, r) !== (t >= lower && t <= upper))
            throw new Error(`base ${base}, tax ${t} at ${r} bps`);
      }
    }
  });

  it("0% and exempt accept only zero tax; negative amounts are rejected", () => {
    expect(satTaxWithinTolerance(12500, 0, 0)).toBe(true);
    expect(satTaxWithinTolerance(12500, 0, null)).toBe(true);
    expect(satTaxWithinTolerance(12500, 1, 0)).toBe(false);
    expect(satTaxWithinTolerance(12500, 1, null)).toBe(false);
    expect(satTaxWithinTolerance(-1, 0, 1600)).toBe(false);
    expect(satTaxWithinTolerance(100, -1, 1600)).toBe(false);
    // Base 0: the limits are trunc(−0.005 × 0.16) = 0 and ceil(0.005 × 0.16) = 0.01 pesos.
    expect(satTaxWithinTolerance(0, 0, 1600)).toBe(true);
    expect(satTaxWithinTolerance(0, 1, 1600)).toBe(true);
    expect(satTaxWithinTolerance(0, 2, 1600)).toBe(false);
  });
});

describe("product fiscal input and tax category resolution", () => {
  it('productFiscalInput is strict and defaultProductFiscal is taxCategory "default"', () => {
    expect(productFiscalInput.parse({})).toEqual(defaultProductFiscal());
    expect(defaultProductFiscal()).toEqual({
      taxCategory: "default",
      satProductKey: null,
      satUnitKey: null,
    });
    expect(
      productFiscalInput.parse({
        taxCategory: "iva0",
        satProductKey: "50192100",
        satUnitKey: "H87",
      }),
    ).toEqual({
      taxCategory: "iva0",
      satProductKey: "50192100",
      satUnitKey: "H87",
    });
    for (const bad of [
      { taxCategory: "iva16", ieps: true },
      { taxCategory: "iva11" },
      { satProductKey: "9010150" },
      { satProductKey: "901015011" },
      { satProductKey: "9010150A" },
      { satUnitKey: "e48" },
      { satUnitKey: "E48X" },
      { satUnitKey: "" },
    ])
      expect(
        productFiscalInput.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
  });

  it.each([
    [{ taxCategory: "default" }, DEFAULT_FISCAL_CONTEXT, "iva16", "default"],
    [{ taxCategory: "default" }, border, "iva8", "default"],
    [{ taxCategory: "iva16" }, border, "iva16", "product"],
    [{ taxCategory: "iva0" }, DEFAULT_FISCAL_CONTEXT, "iva0", "product"],
    [{ taxCategory: "exempt" }, DEFAULT_FISCAL_CONTEXT, "exempt", "product"],
    [{ taxCategory: "iva8" }, border, "iva8", "product"],
    [
      { taxCategory: "iva8" },
      { region: "border_south", defaultCategory: "iva16" },
      "iva8",
      "product",
    ],
    [{ taxCategory: "iva8" }, DEFAULT_FISCAL_CONTEXT, "iva16", "fallback"],
    [
      { taxCategory: "iva8" },
      { region: "general", defaultCategory: "iva0" },
      "iva0",
      "fallback",
    ],
  ] as const)(
    "resolveTaxCategory: %j in %j → %s (%s)",
    (fiscal, ctx, category, basis) => {
      expect(resolveTaxCategory(fiscal, ctx)).toEqual({ category, basis });
    },
  );

  it('legacy products without fiscal resolve to the restaurant default with basis "default"', () => {
    for (const legacy of [
      undefined,
      null,
      {},
      "iva16",
      16,
      { taxCategory: "iva99" },
      { extra: 1 },
    ]) {
      expect(resolveTaxCategory(legacy, DEFAULT_FISCAL_CONTEXT)).toEqual({
        category: "iva16",
        basis: "default",
      });
      expect(resolveTaxCategory(legacy, border)).toEqual({
        category: "iva8",
        basis: "default",
      });
    }
  });

  it("MON-1: the line snapshot records the product tax category, rate, SAT keys and informational base/IVA", () => {
    expect(
      lineTaxSnapshot(
        { taxCategory: "iva16", satProductKey: "90101503", satUnitKey: "H87" },
        12500,
        DEFAULT_FISCAL_CONTEXT,
      ),
    ).toEqual({
      v: 1,
      category: "iva16",
      rateBps: 1600,
      basis: "product",
      satProductKey: "90101503",
      satUnitKey: "H87",
      base: 10776,
      tax: 1724,
    });
    expect(lineTaxSnapshot({ taxCategory: "exempt" }, 5000, border)).toEqual({
      v: 1,
      category: "exempt",
      rateBps: null,
      basis: "product",
      satProductKey: SAT_DEFAULT_PRODUCT_KEY,
      satUnitKey: SAT_DEFAULT_UNIT_KEY,
      base: 5000,
      tax: 0,
    });
    expect(
      lineTaxSnapshot({ taxCategory: "iva8" }, 10800, DEFAULT_FISCAL_CONTEXT),
    ).toMatchObject({
      category: "iva16",
      rateBps: 1600,
      basis: "fallback",
      base: 9310,
      tax: 1490,
    });
  });

  it("without a fiscal context the client display uses IVA 16%", () => {
    expect(lineTaxSnapshot(undefined, 11600, DEFAULT_FISCAL_CONTEXT)).toEqual({
      v: 1,
      category: "iva16",
      rateBps: 1600,
      basis: "default",
      satProductKey: "90101501",
      satUnitKey: "E48",
      base: 10000,
      tax: 1600,
    });
    // An invalid stored fiscal field never blocks pricing: it behaves like a legacy product.
    expect(lineTaxSnapshot({ satUnitKey: "bad" }, 11600, border)).toMatchObject(
      {
        category: "iva8",
        basis: "default",
        satUnitKey: "E48",
      },
    );
  });

  it("the snapshot's base + IVA reconcile to the line total for every category and region", () => {
    const random = rng(6);
    for (let i = 0; i < 20_000; i++) {
      const region = random.pick(TAX_REGIONS);
      const ctx: FiscalContext = {
        region,
        defaultCategory: random.pick(allowedCategories(region)),
      };
      const wanted = random.pick(["default", ...TAX_CATEGORIES] as const);
      const total = random.int(0, 100_000_000);
      const s = lineTaxSnapshot({ taxCategory: wanted }, total, ctx);
      expect(s.base + s.tax).toBe(total);
      expect(allowedCategories(region)).toContain(s.category);
      expect(s.rateBps).toBe(TAX_RULES[s.category as TaxCategory].rateBps);
      expect(satTaxWithinTolerance(s.base, s.tax, s.rateBps)).toBe(true);
    }
    expect(() => lineTaxSnapshot({}, -1, DEFAULT_FISCAL_CONTEXT)).toThrow(
      RangeError,
    );
  });
});

// Independent oracle for the RFC check digit, written from the SAT description (value table,
// weights 13..2 over the 12 leading characters, a space prepended to 12-character RFCs).
const RFC_VALUES: Record<string, number> = Object.fromEntries([
  ..."0123456789".split("").map((c, i) => [c, i]),
  ..."ABCDEFGHIJKLMN".split("").map((c, i) => [c, 10 + i]),
  ["&", 24],
  ..."OPQRSTUVWXYZ".split("").map((c, i) => [c, 25 + i]),
  [" ", 37],
  ["Ñ", 38],
]);
function oracleCheckDigit(first: string): string {
  const s = first.length === 11 ? " " + first : first;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += RFC_VALUES[s[i]] * (13 - i);
  const digit = 11 - (sum % 11);
  return digit === 11 ? "0" : digit === 10 ? "A" : String(digit);
}

describe("RFC", () => {
  it.each([
    ["EKU9003173C9", "moral"],
    ["SAT970701NN3", "moral"],
    ["IIA040805DZ4", "moral"],
    ["EWE1709045U0", "moral"],
    ["URE180429TM6", "moral"],
    ["XIQB891116QE4", "fisica"],
    ["CACX7605101P8", "fisica"],
  ] as const)("validateRfc accepts %s (%s)", (rfc, kind) => {
    expect(validateRfc(rfc)).toEqual({
      rfc,
      ok: true,
      generic: false,
      kind,
      checkDigit: true,
    });
    expect(validateRfc(` ${rfc.toLowerCase()} `)).toEqual({
      rfc,
      ok: true,
      generic: false,
      kind,
      checkDigit: true,
    });
  });

  it("validateRfc rejects the generic RFCs and malformed ones", () => {
    for (const rfc of GENERIC_RFCS) {
      expect(validateRfc(rfc)).toMatchObject({
        ok: false,
        generic: true,
        kind: null,
        checkDigit: false,
      });
      expect(RFC_PATTERN.test(rfc)).toBe(true); // well-formed, refused only because generic
    }
    for (const bad of [
      "",
      "EKU900317",
      "EKU9003173C",
      "EKU9003173C99X",
      "EKU9013173C9", // month 13
      "EKU9000173C9", // month 00
      "EKU9003323C9", // day 32
      "EKU9003003C9", // day 00
      "EKU9003173CB", // check character must be a digit or A
      "EK19003173C9", // digit in the name part
      "EKU 9003173C9",
      "EKU-900317-3C9",
      "XIQB8911163QE4",
    ])
      expect(validateRfc(bad), bad).toMatchObject({
        ok: false,
        kind: null,
        checkDigit: false,
      });
    expect(validateRfc("ÑAA010101AA1").ok).toBe(true);
    expect(validateRfc("A&A010101AA1").ok).toBe(true);
  });

  it("rfcCheckDigitValid: true for SAT970701NN3, EKU9003173C9 and XIQB891116QE4; false when the last character changes", () => {
    for (const rfc of [
      "SAT970701NN3",
      "EKU9003173C9",
      "XIQB891116QE4",
      "CACX7605101P8",
      "IIA040805DZ4",
    ]) {
      expect(rfcCheckDigitValid(rfc), rfc).toBe(true);
      for (const c of "0123456789A")
        if (c !== rfc.at(-1))
          expect(rfcCheckDigitValid(rfc.slice(0, -1) + c), rfc + c).toBe(false);
    }
    for (const bad of [
      "",
      "EKU9003173C",
      "XIQB891116QE44",
      "eku9003173c9",
      "EKU9003173C?",
    ])
      expect(rfcCheckDigitValid(bad), bad).toBe(false);
  });

  it("rfcCheckDigitValid agrees with an independent implementation on 20,000 random RFCs (including Ñ, & and check digits 0 and A)", () => {
    const random = rng(21);
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZÑ&";
    const homoclave = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const len = random.pick([3, 4]);
      const name = Array.from({ length: len }, () =>
        random.pick(letters.split("")),
      ).join("");
      const date = `${String(random.int(0, 99)).padStart(2, "0")}${String(random.int(1, 12)).padStart(2, "0")}${String(random.int(1, 28)).padStart(2, "0")}`;
      const hc =
        random.pick(homoclave.split("")) + random.pick(homoclave.split(""));
      const first = name + date + hc;
      const digit = oracleCheckDigit(first);
      seen.add(digit);
      const rfc = first + digit;
      expect(RFC_PATTERN.test(rfc), rfc).toBe(true);
      expect(rfcCheckDigitValid(rfc), rfc).toBe(true);
      expect(validateRfc(rfc).kind).toBe(len === 3 ? "moral" : "fisica");
      const wrong = random.pick("0123456789A".replace(digit, "").split(""));
      expect(rfcCheckDigitValid(first + wrong), first + wrong).toBe(false);
    }
    expect([...seen].sort()).toEqual([..."0123456789A"].sort());
  });

  it("rfcSchema trims and uppercases before the SAT pattern; postalCodeSchema needs 5 digits", () => {
    expect(rfcSchema.parse("  eku9003173c9 ")).toBe("EKU9003173C9");
    expect(rfcSchema.parse("xiqb891116qe4")).toBe("XIQB891116QE4");
    for (const bad of ["EKU9013173C9", "EKU900317", ""])
      expect(rfcSchema.safeParse(bad).success, bad).toBe(false);
    expect(postalCodeSchema.parse(" 06700 ")).toBe("06700");
    for (const bad of ["6700", "067000", "06 700", "O6700", ""])
      expect(postalCodeSchema.safeParse(bad).success, bad).toBe(false);
    expect(rfcKind("EKU9003173C9")).toBe("moral");
    expect(rfcKind("XIQB891116QE4")).toBe("fisica");
    expect(rfcKind("")).toBeNull();
  });
});

describe("régimen fiscal catalog", () => {
  // c_RegimenFiscal (CFDI 4.0), re-checked on 2026-10-05: code → applicability.
  const catalog: Record<string, "fisica" | "moral" | "ambas"> = {
    "601": "moral",
    "603": "moral",
    "605": "fisica",
    "606": "fisica",
    "607": "fisica",
    "608": "fisica",
    "610": "ambas",
    "611": "fisica",
    "612": "fisica",
    "614": "fisica",
    "615": "fisica",
    "616": "fisica",
    "620": "moral",
    "621": "fisica",
    "622": "moral",
    "623": "moral",
    "624": "moral",
    "625": "fisica",
    "626": "ambas",
  };

  it("REGIMEN_FISCAL has 19 unique codes; ISSUER_REGIMES excludes 605/606/607/608/610/611/614/615/616", () => {
    const codes = Object.keys(REGIMEN_FISCAL);
    expect(codes).toHaveLength(19);
    expect(new Set(codes).size).toBe(19);
    expect(
      Object.fromEntries(codes.map((c) => [c, REGIMEN_FISCAL[c].persona])),
    ).toEqual(catalog);
    for (const excluded of [
      "605",
      "606",
      "607",
      "608",
      "610",
      "611",
      "614",
      "615",
      "616",
    ])
      expect(ISSUER_REGIMES).not.toContain(excluded);
    expect(ISSUER_REGIMES).toEqual([
      "601",
      "603",
      "612",
      "620",
      "621",
      "622",
      "623",
      "624",
      "625",
      "626",
    ]);
    for (const c of codes) {
      expect(REGIMEN_FISCAL[c].es.trim(), c).not.toBe("");
      expect(REGIMEN_FISCAL[c].en.trim(), c).not.toBe("");
    }
    expect(REGIMEN_FISCAL["626"].es).toBe("Régimen Simplificado de Confianza");
  });

  it("regimenFiscalSchema accepts only catalog codes", () => {
    for (const c of Object.keys(catalog))
      expect(regimenFiscalSchema.parse(c)).toBe(c);
    for (const bad of [
      "600",
      "602",
      "627",
      "628",
      "60",
      "6011",
      "abc",
      "",
      "constructor",
      "__proto__",
    ])
      expect(regimenFiscalSchema.safeParse(bad).success, bad).toBe(false);
  });

  it("regimeAllowedFor matches the regime to the RFC kind", () => {
    for (const [code, persona] of Object.entries(catalog)) {
      expect(regimeAllowedFor(code, "moral"), code).toBe(persona !== "fisica");
      expect(regimeAllowedFor(code, "fisica"), code).toBe(persona !== "moral");
    }
    for (const unknown of ["600", "", "constructor", "__proto__", "toString"]) {
      expect(regimeAllowedFor(unknown, "moral"), unknown).toBe(false);
      expect(regimeAllowedFor(unknown, "fisica"), unknown).toBe(false);
    }
  });
});
