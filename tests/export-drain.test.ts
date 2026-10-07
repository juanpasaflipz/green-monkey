import { describe, expect, it } from "vitest";
import { DRAIN_TIMEOUT_MS, drainTimeoutMs } from "../server/data-export.js";

// The export's drain timeout (FLK-R10): EXPORT_DRAIN_TIMEOUT_MS may shorten
// it on a local or CI server, never on a deployed one.
describe("export drain timeout", () => {
  it("is 50 s unless a local or CI server sets EXPORT_DRAIN_TIMEOUT_MS, bounded to 1..50 s", () => {
    expect(DRAIN_TIMEOUT_MS).toBe(50_000);
    expect(drainTimeoutMs({})).toBe(50_000);
    expect(drainTimeoutMs({ EXPORT_DRAIN_TIMEOUT_MS: "3000" })).toBe(3000);
    expect(
      drainTimeoutMs({
        EXPORT_DRAIN_TIMEOUT_MS: "3000",
        APP_ENV: "development",
      }),
    ).toBe(3000);
    expect(drainTimeoutMs({ EXPORT_DRAIN_TIMEOUT_MS: "10" })).toBe(1000);
    expect(drainTimeoutMs({ EXPORT_DRAIN_TIMEOUT_MS: "900000" })).toBe(50_000);
    expect(drainTimeoutMs({ EXPORT_DRAIN_TIMEOUT_MS: "soon" })).toBe(50_000);
  });

  it("is ignored on staging, production and any Railway environment", () => {
    for (const env of [
      { APP_ENV: "staging" },
      { APP_ENV: "production" },
      { APP_ENV: " Production " },
      { RAILWAY_ENVIRONMENT_NAME: "staging" },
      { RAILWAY_ENVIRONMENT_NAME: "pr-12" },
    ])
      expect(
        drainTimeoutMs({ ...env, EXPORT_DRAIN_TIMEOUT_MS: "3000" }),
        JSON.stringify(env),
      ).toBe(50_000);
  });
});
