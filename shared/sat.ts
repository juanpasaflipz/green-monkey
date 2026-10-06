// shared/sat.ts — leaf. Values verified against the SAT c_RegimenFiscal catalog (sources in
// docs/FISCAL.md); re-checked on 2026-10-05 against the CFDI 4.0 catalog data generated from
// the SAT catCFDI file (19 codes, same descriptions and física/moral applicability).
import { z } from "zod";

export const RFC_PATTERN =
  /^[A-ZÑ&]{3,4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{2}[0-9A]$/;
export const GENERIC_RFCS = ["XAXX010101000", "XEXX010101000"] as const;
export const rfcSchema = z.string().trim().toUpperCase().regex(RFC_PATTERN); // zod 4 overwrite methods
export const postalCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{5}$/);

export type Persona = "fisica" | "moral" | "ambas";
export const REGIMEN_FISCAL: Readonly<
  Record<string, { es: string; en: string; persona: Persona; issuer: boolean }>
> = {
  "601": {
    es: "General de Ley Personas Morales",
    en: "General regime for legal entities",
    persona: "moral",
    issuer: true,
  },
  "603": {
    es: "Personas Morales con Fines no Lucrativos",
    en: "Non-profit legal entities",
    persona: "moral",
    issuer: true,
  },
  "605": {
    es: "Sueldos y Salarios e Ingresos Asimilados a Salarios",
    en: "Wages and salaries",
    persona: "fisica",
    issuer: false,
  },
  "606": {
    es: "Arrendamiento",
    en: "Leasing",
    persona: "fisica",
    issuer: false,
  },
  "607": {
    es: "Régimen de Enajenación o Adquisición de Bienes",
    en: "Sale or acquisition of goods",
    persona: "fisica",
    issuer: false,
  },
  "608": {
    es: "Demás ingresos",
    en: "Other income",
    persona: "fisica",
    issuer: false,
  },
  "610": {
    es: "Residentes en el Extranjero sin Establecimiento Permanente en México",
    en: "Foreign residents without a permanent establishment in Mexico",
    persona: "ambas",
    issuer: false,
  },
  "611": {
    es: "Ingresos por Dividendos (socios y accionistas)",
    en: "Dividend income",
    persona: "fisica",
    issuer: false,
  },
  "612": {
    es: "Personas Físicas con Actividades Empresariales y Profesionales",
    en: "Individuals with business and professional activities",
    persona: "fisica",
    issuer: true,
  },
  "614": {
    es: "Ingresos por intereses",
    en: "Interest income",
    persona: "fisica",
    issuer: false,
  },
  "615": {
    es: "Régimen de los ingresos por obtención de premios",
    en: "Prize income",
    persona: "fisica",
    issuer: false,
  },
  "616": {
    es: "Sin obligaciones fiscales",
    en: "No tax obligations",
    persona: "fisica",
    issuer: false,
  },
  "620": {
    es: "Sociedades Cooperativas de Producción que optan por diferir sus ingresos",
    en: "Production cooperatives deferring income",
    persona: "moral",
    issuer: true,
  },
  "621": {
    es: "Incorporación Fiscal",
    en: "Fiscal incorporation regime",
    persona: "fisica",
    issuer: true,
  },
  "622": {
    es: "Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras",
    en: "Agricultural, livestock, forestry and fishing activities",
    persona: "moral",
    issuer: true,
  },
  "623": {
    es: "Opcional para Grupos de Sociedades",
    en: "Optional regime for groups of companies",
    persona: "moral",
    issuer: true,
  },
  "624": {
    es: "Coordinados",
    en: "Coordinated entities",
    persona: "moral",
    issuer: true,
  },
  "625": {
    es: "Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas",
    en: "Business activities through technology platforms",
    persona: "fisica",
    issuer: true,
  },
  "626": {
    es: "Régimen Simplificado de Confianza",
    en: "Simplified trust regime (RESICO)",
    persona: "ambas",
    issuer: true,
  },
};
export const ISSUER_REGIMES = Object.keys(REGIMEN_FISCAL).filter(
  (c) => REGIMEN_FISCAL[c].issuer,
);
export const regimenFiscalSchema = z
  .string()
  .regex(/^\d{3}$/)
  .refine((c) => c in REGIMEN_FISCAL);

export function rfcKind(rfc: string): "moral" | "fisica" | null {
  return rfc.length === 12 ? "moral" : rfc.length === 13 ? "fisica" : null;
}
export function regimeAllowedFor(
  code: string,
  kind: "moral" | "fisica",
): boolean {
  const r = REGIMEN_FISCAL[code];
  return !!r && (r.persona === "ambas" || r.persona === kind);
}
const CHECK_ALPHABET = "0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ";
/** Módulo 11 homoclave check digit. Verified on EKU9003173C9, SAT970701NN3, XIQB891116QE4. */
export function rfcCheckDigitValid(rfc: string): boolean {
  const s = rfc.length === 12 ? " " + rfc : rfc;
  if (s.length !== 13) return false;
  let total = 0;
  for (let i = 0; i < 12; i++) {
    const v = CHECK_ALPHABET.indexOf(s[i]);
    if (v < 0) return false;
    total += v * (13 - i);
  }
  const r = total % 11;
  const expected = r === 0 ? "0" : 11 - r === 10 ? "A" : String(11 - r);
  return s[12] === expected;
}
export function validateRfc(raw: string): {
  rfc: string;
  ok: boolean;
  generic: boolean;
  kind: "moral" | "fisica" | null;
  checkDigit: boolean;
} {
  const rfc = raw.trim().toUpperCase();
  const generic = (GENERIC_RFCS as readonly string[]).includes(rfc);
  const ok = RFC_PATTERN.test(rfc) && !generic;
  return {
    rfc,
    ok,
    generic,
    kind: ok ? rfcKind(rfc) : null,
    checkDigit: ok && rfcCheckDigitValid(rfc),
  };
}

// shared/sat.ts — appended by Wave 2.0 (j); moved from cfdi §4.2.
export type SatUse = "G01" | "G02" | "G03" | "S01";
export const USE_LABELS: Record<SatUse, { es: string; en: string }> = {
  G03: { es: "Gastos en general", en: "General expenses" },
  G01: { es: "Adquisición de mercancías", en: "Purchase of goods" },
  S01: { es: "Sin efectos fiscales", en: "No tax effects" },
  G02: {
    es: "Devoluciones, descuentos o bonificaciones",
    en: "Returns, discounts or bonuses",
  },
};
/** c_UsoCFDI receptor regimes (Facturapi OpenAPI v2 "Uso del CFDI" table, SAT catalog). */
// prettier-ignore
const BUSINESS = ["601", "603", "606", "612", "620", "621", "622", "623", "624", "625", "626"];
// prettier-ignore
const S01_REGIMES = [
  "601", "603", "605", "606", "607", "608", "610", "611", "612", "614", "615", "616", "620",
  "621", "622", "623", "624", "625", "626",
];
export const USE_REGIMES: Record<SatUse, readonly string[]> = {
  G01: BUSINESS,
  G02: BUSINESS,
  G03: BUSINESS,
  S01: S01_REGIMES,
};
/** False for any use outside USE_REGIMES (callers with a wider catalog apply their own fallback). */
export function usoCfdiAllowed(regimen: string, uso: string): boolean {
  return (
    Object.hasOwn(USE_REGIMES, uso) &&
    USE_REGIMES[uso as SatUse].includes(regimen)
  );
}
