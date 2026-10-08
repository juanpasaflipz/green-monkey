import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dateTime } from "../src/datetime";
import { fiscalDateTime } from "../src/features/fiscal/format";
import { dateTimeLabel } from "../src/features/cfdi/format";

// restaurant-day G3 dates rule: screens print dd/MM/yyyy (Spanish) or a month
// name, never toLocaleString's "7/10/2026, 4:53:12".
describe("dateTime", () => {
  const at = "2026-10-07T10:53:12Z";
  it("prints dd/MM/yyyy HH:mm in Spanish, in the restaurant's timezone", () => {
    expect(dateTime(at, "America/Mexico_City", "es")).toBe("07/10/2026 04:53");
    expect(dateTime(at, "America/Tijuana", "es")).toBe("07/10/2026 03:53");
  });
  it("prints a month name in English", () => {
    expect(dateTime(at, "America/Mexico_City", "en")).toBe("Oct 7, 2026 04:53");
  });
  it("is the fiscal comprobante format", () => {
    expect(fiscalDateTime(at, "America/Mexico_City", "es")).toBe(
      dateTime(at, "America/Mexico_City", "es"),
    );
  });
  // ACC-PR-5b: cfdi's "Abierto hasta" (Facturas globales) and document times
  // printed es-MX's "7 oct 2026, 4:53 p.m.", which G3 refuses at B7-global.
  it("cfdi's dateTimeLabel prints a 24-hour time", () => {
    const pm = "2026-10-07T22:53:00Z";
    expect(dateTimeLabel(pm, "America/Mexico_City", "es")).toBe(
      "7 oct 2026, 16:53",
    );
    expect(dateTimeLabel(pm, "America/Mexico_City", "en")).toBe(
      "Oct 7, 2026, 16:53",
    );
    expect(dateTimeLabel(at, "America/Tijuana", "es")).toBe(
      "7 oct 2026, 03:53",
    );
  });
});

// ACC-PR-5: no screen formats a date with toLocaleString (it prints
// "7/10/2026, 4:53:12"), and no time is left to the locale's hour cycle:
// es-MX prints "4:53 p.m.", which the restaurant-day G3 scanner refuses.
describe("date and time formatting on screens", () => {
  const files = ["src", "shared"].flatMap((dir) =>
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => join(dir, f)),
  );
  /** Every call of `name` with its argument text, as file:line → arguments. */
  const calls = (name: RegExp) =>
    files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(name)].map((m) => {
        const open = m.index! + m[0].length;
        let depth = 1;
        let end = open;
        while (depth && end < text.length) {
          const c = text[end++];
          if (c === "(") depth++;
          else if (c === ")") depth--;
        }
        const line = text.slice(0, m.index).split("\n").length;
        return { at: `${file}:${line}`, args: text.slice(open, end - 1) };
      });
    });
  const cycle = /hourCycle\s*:|hour12\s*:\s*false/;
  it("never calls toLocaleString (dates use dateTime from src/datetime.ts)", () => {
    expect(calls(/\.toLocaleString\(/g).map((c) => c.at)).toEqual([]);
  });
  it("sets the hour cycle wherever an hour is printed", () => {
    const times = calls(/\.toLocaleTimeString\(/g).filter(
      (c) => !cycle.test(c.args),
    );
    const formats = calls(
      /\.toLocaleDateString\(|Intl\.DateTimeFormat\(/g,
    ).filter(
      (c) => /\bhour\s*:|timeStyle\s*:/.test(c.args) && !cycle.test(c.args),
    );
    expect([...times, ...formats].map((c) => c.at)).toEqual([]);
  });
  it("never leaves a date to the locale's default (es-MX prints 7/10/2026)", () => {
    expect(
      calls(/\.toLocaleDateString\(/g)
        .filter((c) => !c.args.includes("{"))
        .map((c) => c.at),
    ).toEqual([]);
  });
});
