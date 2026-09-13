import { describe, it, expect } from "vitest";
import { accessPlan } from "../shared/plans";
describe("Pro access boundaries", () => {
  const now = Date.parse("2026-09-13T12:00:00Z");
  it("defaults to Free without an explicit grant", () =>
    expect(accessPlan(null, now)).toBe("free"));
  it("expires exactly at the end instant", () => {
    const e = {
      status: "trialing" as const,
      accessUntil: new Date(now).toISOString(),
      source: "stripe" as const,
    };
    expect(accessPlan(e, now - 1)).toBe("pro");
    expect(accessPlan(e, now)).toBe("free");
  });
  it("never treats canceled, paused or malformed grants as Pro", () => {
    for (const status of ["canceled", "paused", "free"] as const)
      expect(
        accessPlan(
          {
            status,
            accessUntil: new Date(now + 1000).toISOString(),
            source: "stripe",
          },
          now,
        ),
      ).toBe("free");
    expect(
      accessPlan(
        { status: "active", accessUntil: "invalid", source: "stripe" },
        now,
      ),
    ).toBe("free");
  });
  it("bounds failed-renewal grace as explicitly persisted", () => {
    expect(
      accessPlan(
        {
          status: "past_due",
          accessUntil: new Date(now + 1).toISOString(),
          source: "stripe",
        },
        now,
      ),
    ).toBe("pro");
    expect(
      accessPlan(
        { status: "past_due", accessUntil: null, source: "stripe" },
        now,
      ),
    ).toBe("free");
  });
});
