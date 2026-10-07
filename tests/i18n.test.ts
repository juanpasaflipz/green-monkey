import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { areas, errorText, strings } from "../src/i18n";

const baseKeys = (locale: "es" | "en") => {
  const areaKeys = new Set(
    Object.values(areas).flatMap((a) => Object.keys(a[locale])),
  );
  return Object.keys(strings[locale]).filter((k) => !areaKeys.has(k));
};

describe("bilingual strings", () => {
  it("never lets an area override another area or the base strings", () => {
    for (const locale of ["es", "en"] as const) {
      const seen = new Map<string, string>();
      for (const key of baseKeys(locale)) seen.set(key, "base");
      for (const [name, area] of Object.entries(areas))
        for (const key of Object.keys(area[locale])) {
          expect(seen.get(key), `${locale}.${key} in ${name}`).toBeUndefined();
          seen.set(key, name);
        }
    }
  });

  it("translates every key in both languages with non-empty text", () => {
    expect(Object.keys(strings.en).sort()).toEqual(
      Object.keys(strings.es).sort(),
    );
    for (const locale of ["es", "en"] as const)
      for (const [key, text] of Object.entries(strings[locale]))
        expect(text.trim(), `${locale}.${key}`).not.toBe("");
  });

  it("keeps error codes unique and translated", () => {
    const seen = new Set<string>();
    for (const [name, area] of Object.entries(areas))
      for (const code of Object.keys(area.errors)) {
        expect(seen.has(code), `${code} in ${name}`).toBe(false);
        seen.add(code);
      }
    for (const [code, [es, en]] of Object.entries(errorText)) {
      expect(es.trim(), code).not.toBe("");
      expect(en.trim(), code).not.toBe("");
    }
  });
});

describe("copy that sends staff to the pilot manual (LD-17)", () => {
  const pilotSop = readFileSync(
    new URL("../docs/PILOT_SOP.md", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");

  it("the silent-print hint points to the pilot guide's print steps, not to an unconfirmed Chrome flag, and says what auto-print does (POLISH-UX-9)", () => {
    expect(strings.es.servicePrintSilentHint).toBe(
      "La impresión sin diálogo no está confirmada: con esta opción, cada ticket nuevo abre el diálogo de impresión. Sigue la guía del piloto, sección 1.3.",
    );
    expect(strings.en.servicePrintSilentHint).toBe(
      "Printing without a dialog is not confirmed: with this option, each new ticket opens the print dialog. Follow the pilot guide, section 1.3.",
    );
    // The section it names is PILOT_SOP's silent-printing section, under the
    // guide's own title.
    expect(pilotSop).toContain("# Guía de operación del piloto");
    expect(pilotSop).toContain(
      "### 1.3 Imprimir sin diálogo (modo kiosco) según el navegador",
    );
    for (const locale of ["es", "en"] as const)
      expect(strings[locale].servicePrintSilentHint).not.toMatch(
        /kiosk|kiosco|chrome/i,
      );
  });

  it("the hint never promises a dialog-free route that the manual says does not exist (POL-R2-1)", () => {
    // PILOT_SOP §1.3: no confirmed way to print without a dialog today.
    expect(pilotSop).toContain(
      "Hoy no existe una forma confirmada de imprimir sin diálogo.",
    );
    expect(strings.es.servicePrintSilentHint).toMatch(/no está confirmada/);
    expect(strings.en.servicePrintSilentHint).toMatch(/is not confirmed/);
    expect(strings.es.servicePrintSilentHint).not.toMatch(
      /^Para imprimir sin diálogo/,
    );
    expect(strings.en.servicePrintSilentHint).not.toMatch(
      /^To print without a dialog/,
    );
  });

  it("PILOT_SOP's printing section quotes the hint the app shows", () => {
    expect(pilotSop).toContain(`«${strings.es.servicePrintSilentHint}»`);
    expect(pilotSop).toContain(`«${strings.en.servicePrintSilentHint}»`);
  });
});
