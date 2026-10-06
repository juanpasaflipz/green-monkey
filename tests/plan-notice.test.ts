import { describe, expect, it } from "vitest";
import { NOTICE_THRESHOLDS, planNotice } from "../shared/plan-notice";

const now = Date.parse("2026-10-05T18:00:00Z");
const hours = (n: number) => new Date(now + n * 3600_000).toISOString();
const selling = { allowed: true, basis: "pro", continuationUntil: null };
const blocked = { allowed: false, basis: "none", continuationUntil: null };
const trial = (until: string) => ({
  plan: "pro" as const,
  status: "trialing",
  accessUntil: until,
  source: "stripe",
});

describe("plan notices (GAP-1)", () => {
  it("trial thresholds 7d info / 3d warning / 24h critical", () => {
    expect(planNotice(trial(hours(6 * 24)), selling, now)).toMatchObject({
      kind: "trial_ending",
      severity: "info",
      at: hours(6 * 24),
    });
    expect(planNotice(trial(hours(48)), selling, now)?.severity).toBe(
      "warning",
    );
    expect(planNotice(trial(hours(23)), selling, now)?.severity).toBe(
      "critical",
    );
    expect(planNotice(trial(hours(24)), selling, now)?.severity).toBe(
      "critical",
    );
  });

  it("no notice beyond 7 days", () => {
    expect(planNotice(trial(hours(7 * 24 + 1)), selling, now)).toBeNull();
    expect(
      planNotice(
        {
          plan: "pro",
          status: "active",
          accessUntil: hours(2),
          source: "stripe",
        },
        selling,
        now,
      ),
    ).toBeNull();
  });

  it("past_due → payment_failed critical", () => {
    expect(
      planNotice(
        {
          plan: "free",
          status: "past_due",
          accessUntil: null,
          source: "stripe",
        },
        blocked,
        now,
      ),
    ).toMatchObject({ kind: "payment_failed", severity: "critical" });
  });

  it("support grant ending", () => {
    expect(
      planNotice(
        {
          plan: "pro",
          status: "active",
          accessUntil: hours(60),
          source: "support",
        },
        selling,
        now,
      ),
    ).toMatchObject({ kind: "grant_ending", severity: "warning" });
  });

  it("pro_ended within 7 days of accessUntil, including canceled with ended_at", () => {
    for (const status of ["trialing", "active", "canceled"])
      expect(
        planNotice(
          { plan: "free", status, accessUntil: hours(-30), source: "stripe" },
          blocked,
          now,
        ),
        status,
      ).toMatchObject({
        kind: "pro_ended",
        severity: "warning",
        at: hours(-30),
      });
    expect(
      planNotice(
        {
          plan: "free",
          status: "canceled",
          accessUntil: new Date(
            now - NOTICE_THRESHOLDS.endedWindowMs - 1,
          ).toISOString(),
          source: "stripe",
        },
        blocked,
        now,
      )?.kind,
    ).toBe("blocked");
  });

  it("continuation outranks everything", () => {
    const continuation = {
      allowed: true,
      basis: "drawer_continuation",
      continuationUntil: hours(5),
    };
    expect(
      planNotice(
        {
          plan: "free",
          status: "past_due",
          accessUntil: null,
          source: "stripe",
        },
        continuation,
        now,
      ),
    ).toEqual({
      kind: "drawer_continuation",
      severity: "critical",
      at: hours(5),
      continuationUntil: hours(5),
    });
  });

  it("blocked when selling not allowed and nothing else applies", () => {
    expect(
      planNotice(
        { plan: "free", status: "free", accessUntil: null, source: null },
        blocked,
        now,
      ),
    ).toMatchObject({ kind: "blocked", severity: "warning" });
    expect(
      planNotice(
        { plan: "free", status: "free", accessUntil: null, source: null },
        { allowed: true, basis: "free_selection", continuationUntil: null },
        now,
      ),
    ).toBeNull();
  });
});
