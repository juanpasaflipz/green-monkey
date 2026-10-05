import { afterEach, describe, expect, it, vi } from "vitest";
import { clockOffset, correctedIso, deviceIso, serverNow } from "../src/clock";
import {
  clockMovedBackSinceLastContact,
  loadClockForTests,
  probeNow,
  resetConnectivityForTests,
  setMonotonicClockForTests,
} from "../src/connectivity";
import { offlineWindow } from "../src/offline-policy";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setMonotonicClockForTests(null);
  resetConnectivityForTests();
});

/** A controllable monotonic clock (performance.now) in ms. */
function monotonic(start = 1_000) {
  const clock = { now: start };
  setMonotonicClockForTests(() => clock.now);
  return clock;
}

/** A successful heartbeat that reports `serverMs` as the server time. */
async function probe(serverMs: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, now: serverMs, build: "local" }), {
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  await probeNow();
}

const at = (iso: string) => Date.parse(iso);

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

describe("a device clock set back (OFF-R24)", () => {
  it("after a probe, setting the device clock back neither reopens the offline window nor backdates a record", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-05T20:00:00.000Z"));
    const mono = monotonic();
    await probe(at("2026-10-05T20:00:00.000Z"));
    const until = "2026-10-05T20:30:00.000Z";
    expect(offlineWindow(until, serverNow()).expired).toBe(false);
    // 31 minutes pass: the window has ended.
    mono.now += 31 * 60_000;
    vi.setSystemTime(at("2026-10-05T20:31:00.000Z"));
    expect(offlineWindow(until, serverNow()).expired).toBe(true);
    // Someone sets the device clock back 21 minutes.
    vi.setSystemTime(at("2026-10-05T20:10:00.000Z"));
    expect(offlineWindow(until, serverNow()).expired).toBe(true);
    expect(serverNow()).toBeGreaterThanOrEqual(at("2026-10-05T20:31:00.000Z"));
    expect(Date.parse(correctedIso())).toBeGreaterThanOrEqual(
      at("2026-10-05T20:31:00.000Z"),
    );
    // And offline saves stop until a probe measures the time again.
    expect(clockMovedBackSinceLastContact()).toBe(true);
    await probe(at("2026-10-05T20:31:00.000Z"));
    expect(clockMovedBackSinceLastContact()).toBe(false);
  });

  it("small device-clock jitter and sleep (monotonic clock paused) are not a rollback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-05T20:00:00.000Z"));
    const mono = monotonic();
    await probe(at("2026-10-05T20:00:00.000Z"));
    vi.setSystemTime(at("2026-10-05T19:59:00.000Z"));
    serverNow();
    expect(clockMovedBackSinceLastContact()).toBe(false);
    // The tablet sleeps an hour: the device clock runs, the monotonic one not.
    vi.setSystemTime(at("2026-10-05T21:00:00.000Z"));
    expect(serverNow()).toBe(at("2026-10-05T21:00:00.000Z"));
    expect(clockMovedBackSinceLastContact()).toBe(false);
    expect(mono.now).toBe(1_000);
  });

  it("a clock set back while the app was closed is detected at load from the stored floor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-05T20:10:00.000Z"));
    monotonic();
    const stored = new Map<string, unknown>([
      ["device:clock", { offsetMs: 0 }],
      ["device:clock-floor", { serverMs: at("2026-10-05T20:31:00.000Z") }],
    ]);
    await loadClockForTests({
      get: async (id) =>
        stored.has(id) ? { value: stored.get(id) } : undefined,
      put: async (row) => stored.set(row.id, row.value),
    });
    expect(clockMovedBackSinceLastContact()).toBe(true);
    // The corrected clock continues from the last time this device showed.
    expect(serverNow()).toBeGreaterThanOrEqual(at("2026-10-05T20:31:00.000Z"));
    expect(
      offlineWindow("2026-10-05T20:30:00.000Z", serverNow()).expired,
    ).toBe(true);
  });
});
