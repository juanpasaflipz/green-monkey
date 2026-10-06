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

describe("support grants (account 031)", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  it("support source active grant is Pro until accessUntil", () => {
    const grant = {
      status: "active" as const,
      accessUntil: new Date(now + 30 * 86400_000).toISOString(),
      source: "support" as const,
    };
    expect(accessPlan(grant, now)).toBe("pro");
    expect(accessPlan(grant, now + 30 * 86400_000)).toBe("free");
    expect(
      accessPlan({ ...grant, status: "free", accessUntil: null }, now),
    ).toBe("free");
  });
});
