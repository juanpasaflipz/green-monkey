import { describe, expect, it } from "vitest";
import { dateTime } from "../src/datetime";
import { fiscalDateTime } from "../src/features/fiscal/format";

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
});
