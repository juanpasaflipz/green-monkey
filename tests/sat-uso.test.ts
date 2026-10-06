import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  REGIMEN_FISCAL,
  USE_LABELS,
  USE_REGIMES,
  usoCfdiAllowed,
  type SatUse,
} from "../shared/sat.js";
import * as cfdiShared from "../shared/cfdi.js";

const BUSINESS = [
  "601",
  "603",
  "606",
  "612",
  "620",
  "621",
  "622",
  "623",
  "624",
  "625",
  "626",
];
const regimes = Object.keys(REGIMEN_FISCAL);

describe("SAT c_UsoCFDI catalog (Wave 2.0 (j), contract C-15)", () => {
  it("G01, G02 and G03 are allowed only for business regimes", () => {
    for (const use of ["G01", "G02", "G03"] as const) {
      expect([...USE_REGIMES[use]].sort()).toEqual(BUSINESS);
      for (const regime of regimes)
        expect(usoCfdiAllowed(regime, use), `${regime} ${use}`).toBe(
          BUSINESS.includes(regime),
        );
    }
  });

  it("S01 is allowed for every listed receptor regime", () => {
    expect(regimes).toHaveLength(19);
    expect([...USE_REGIMES.S01].sort()).toEqual([...regimes].sort());
    for (const regime of regimes)
      expect(usoCfdiAllowed(regime, "S01"), regime).toBe(true);
  });

  it("régimen 616 allows only S01", () => {
    expect(
      (Object.keys(USE_LABELS) as SatUse[]).filter((use) =>
        usoCfdiAllowed("616", use),
      ),
    ).toEqual(["S01"]);
  });

  it("an unknown uso or regime is refused, and inherited keys such as 'toString' are not uses", () => {
    for (const use of [
      "CP01",
      "D01",
      "g03",
      "",
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
    ])
      expect(usoCfdiAllowed("601", use), use).toBe(false);
    for (const regime of ["600", "999", "", "601 ", "length"])
      for (const use of Object.keys(USE_LABELS))
        expect(usoCfdiAllowed(regime, use), `${regime} ${use}`).toBe(false);
  });

  it("labels are bilingual for exactly the four uses", () => {
    expect(Object.keys(USE_LABELS).sort()).toEqual([
      "G01",
      "G02",
      "G03",
      "S01",
    ]);
    expect(Object.keys(USE_REGIMES).sort()).toEqual([
      "G01",
      "G02",
      "G03",
      "S01",
    ]);
    for (const label of Object.values(USE_LABELS)) {
      expect(label.es.length).toBeGreaterThan(3);
      expect(label.en.length).toBeGreaterThan(3);
    }
    expect(USE_LABELS.G03).toEqual({
      es: "Gastos en general",
      en: "General expenses",
    });
  });

  it("cfdi re-exports the one shared catalog (LD-14 OQ-4; cfdi full moved the core's temporary catalog into shared/cfdi.ts, wave2-cross-track C28)", () => {
    expect(cfdiShared.USE_LABELS).toBe(USE_LABELS);
    expect(cfdiShared.USE_REGIMES).toBe(USE_REGIMES);
    expect(cfdiShared.usoCfdiAllowed).toBe(usoCfdiAllowed);
    expect(existsSync("server/cfdi/catalog.ts")).toBe(false);
    const source = readFileSync("shared/cfdi.ts", "utf8");
    expect(source).not.toMatch(/const (BUSINESS|S01_REGIMES)\b/);
    expect(source).not.toMatch(/export function usoCfdiAllowed/);
  });

  it("shared/sat.ts imports only zod", () => {
    const source = readFileSync("shared/sat.ts", "utf8");
    const imports = [
      ...source.matchAll(
        /^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm,
      ),
      ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
    ].map((m) => m[1]);
    expect(imports).toEqual(["zod"]);
  });
});
