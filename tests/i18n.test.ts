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

  it("the silent-print hint points to the pilot manual's print steps, not to an unconfirmed Chrome flag", () => {
    expect(strings.es.servicePrintSilentHint).toBe(
      "Para imprimir sin diálogo, sigue los pasos de impresión del manual del piloto.",
    );
    expect(strings.en.servicePrintSilentHint).toBe(
      "To print without a dialog, follow the printing steps in the pilot manual.",
    );
    for (const locale of ["es", "en"] as const)
      expect(strings[locale].servicePrintSilentHint).not.toMatch(
        /kiosk|kiosco|chrome/i,
      );
  });

  it("PILOT_SOP's printing section quotes the hint the app shows", () => {
    expect(pilotSop).toContain(`«${strings.es.servicePrintSilentHint}»`);
    expect(pilotSop).toContain(`«${strings.en.servicePrintSilentHint}»`);
  });
});
