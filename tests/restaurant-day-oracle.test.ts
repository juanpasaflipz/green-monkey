import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectedDay, oracleDay } from "./restaurant-day/self-check.js";
import { EXPECTED_P } from "./restaurant-day/expected-p.js";
import { estimatedFee, oracleP } from "./restaurant-day/oracle-p.js";
import {
  allocate,
  businessDate,
  dstChangeWithin,
  extractTax,
  minutesUntilLocal,
  mxn,
  refundTax,
} from "./restaurant-day/oracle.js";

// specs/acceptance.md §5.1: the restaurant-day oracle reproduces the literal
// tables before any browser work. Running it with the unit tests catches a
// broken oracle or table on every PR, not only in the nightly gate.
describe("restaurant-day oracle (specs/acceptance.md §5)", () => {
  it("reproduces the published tables (double entry)", () => {
    expect(oracleDay()).toEqual(expectedDay());
  });

  it("branch P (payments §12.4, LD-80): the oracle reproduces its hand-typed table", () => {
    expect(oracleP()).toEqual(EXPECTED_P);
    // P-R2: half-up to the centavo.
    expect(estimatedFee(11000, 175)).toBe(193);
    expect(estimatedFee(13500, 360)).toBe(486);
  });

  it("imports nothing from the application", () => {
    for (const file of readdirSync("tests/restaurant-day").filter((f) =>
      /^(oracle|expected|scenario|self-check)(-p)?\.ts$/.test(f),
    )) {
      const source = readFileSync(`tests/restaurant-day/${file}`, "utf8");
      expect(source, file).not.toMatch(
        /from "\.\.\/\.\.\/(shared|server|src)\//,
      );
    }
  });

  it("R6 and R8 worked examples", () => {
    expect(extractTax(11900, 1600)).toBe(1641);
    expect(extractTax(12950, 1600) - extractTax(8450, 1600)).toBe(620);
    expect(refundTax(13500, 0, 4500, 1600)).toEqual({ tax: 621, base: 3879 });
    expect(refundTax(12950, 0, 4500, 1600)).toEqual({ tax: 620, base: 3880 });
    // Extracting the day's total instead of summing per ticket differs (§6.14, §7.10).
    expect(extractTax(223730, 1600)).toBe(30859);
    expect(extractTax(427000, 800)).toBe(31630);
  });

  it("allocates leftover centavos to the first weights", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1820, [2800, 2800, 2800, 2800, 3500, 3500])).toEqual([
      280, 280, 280, 280, 350, 350,
    ]);
  });

  it("formats money as the spec prints it", () => {
    expect(mxn(308430)).toBe("$3,084.30");
    expect(mxn(-2000)).toBe("−$20.00");
    expect(mxn(5)).toBe("$0.05");
  });

  it("dates the business day by the local cutoff (§3.5.2)", () => {
    // 03:30 in Mexico City on 7 Oct belongs to 6 Oct with a 04:00 cutoff.
    const at = new Date("2026-10-07T09:30:00Z");
    expect(businessDate(at, "America/Mexico_City", "04:00")).toBe("2026-10-06");
    expect(businessDate(at, "America/Mexico_City", "03:00")).toBe("2026-10-07");
    expect(minutesUntilLocal("America/Mexico_City", at, 240)).toBe(30);
    // Tijuana leaves DST on 1 Nov 2026 at 02:00 local (09:00 UTC).
    expect(
      dstChangeWithin("America/Tijuana", new Date("2026-11-01T08:30:00Z"), 75),
    ).toBe(true);
    expect(dstChangeWithin("America/Tijuana", at, 75)).toBe(false);
    expect(
      dstChangeWithin(
        "America/Mexico_City",
        new Date("2026-11-01T08:30:00Z"),
        75,
      ),
    ).toBe(false);
  });
});
