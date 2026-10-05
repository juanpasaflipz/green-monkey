import { afterEach, describe, expect, it, vi } from "vitest";
import { clockOffset, correctedIso, deviceIso, serverNow } from "../src/clock";
import { resetConnectivityForTests } from "../src/connectivity";

afterEach(() => {
  vi.useRealTimers();
  resetConnectivityForTests();
});

describe("corrected clock (OFF-8)", () => {
  it("correctedIso applies persisted offset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T20:03:00.000Z"));
    // The device clock runs 3 minutes fast: the server is 180 s behind it.
    resetConnectivityForTests({}, -180_000);
    expect(clockOffset()).toBe(-180_000);
    expect(serverNow()).toBe(Date.parse("2026-10-04T20:00:00.000Z"));
    expect(correctedIso()).toBe("2026-10-04T20:00:00.000Z");
  });

  it("recordedAtDevice keeps raw device time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T20:03:00.000Z"));
    resetConnectivityForTests({}, -180_000);
    expect(deviceIso()).toBe("2026-10-04T20:03:00.000Z");
    resetConnectivityForTests({}, null);
    expect(clockOffset()).toBeNull();
    expect(correctedIso()).toBe(deviceIso());
  });
});
