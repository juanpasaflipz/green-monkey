import { describe, expect, it } from "vitest";
import {
  acceptsOfflineRound,
  classifySyncError,
  deriveConnectivity,
  fallbackPrefix,
  formatProvisional,
  initialConnectivity,
  LANE_POLL_BUSY_MS,
  LANE_POLL_IDLE_MS,
  lanePollDelay,
  medianOffset,
  CONFIRM_PROBE_MS,
  nextProbeDelay,
  offlineWindow,
  offsetFromSample,
  reduceConnectivity,
  retryDelay,
  type ConnectivityEvent,
  type ConnectivityState,
} from "../src/offline-policy";
import { provisionalNumber } from "../shared/offline-recovery";

const run = (events: ConnectivityEvent[], s = initialConnectivity()) =>
  events.reduce(reduceConnectivity, s);
const fail = (at = 1): ConnectivityEvent => ({
  type: "probe_fail",
  at,
  code: "network_unavailable",
});
const ok = (at = 1, latencyMs = 50): ConnectivityEvent => ({
  type: "probe_ok",
  at,
  latencyMs,
});

describe("connectivity state machine", () => {
  it("two consecutive failures go offline; one failure stays online", () => {
    expect(run([fail()]).mode).toBe("online");
    expect(run([fail(), fail()]).mode).toBe("offline");
    expect(run([fail(), ok(), fail()]).mode).toBe("online");
    expect(deriveConnectivity(run([fail(), fail()])).serverReachable).toBe(
      false,
    );
  });

  it("browser offline goes offline immediately", () => {
    const s = run([{ type: "browser_offline" }]);
    expect(s.mode).toBe("offline");
    expect(deriveConnectivity(s).canUseServer).toBe(false);
    // The browser saying online again proves nothing about the server.
    const back = reduceConnectivity(s, { type: "browser_online" });
    expect(back.mode).toBe("offline");
    expect(run([ok(), ok()], back).mode).toBe("online");
  });

  it("two successes recover; one does not", () => {
    const offline = run([fail(), fail()]);
    expect(run([ok(5)], offline).mode).toBe("offline");
    const recovered = run([ok(5), ok(6)], offline);
    expect(recovered.mode).toBe("online");
    expect(recovered.lastContactAt).toBe(6);
  });

  it("manual flag blocks canUseServer but keeps serverReachable", () => {
    const s = run([{ type: "manual", value: true }]);
    expect(deriveConnectivity(s)).toEqual({
      serverReachable: true,
      canUseServer: false,
      slow: false,
    });
    expect(
      deriveConnectivity(run([{ type: "manual", value: false }], s))
        .canUseServer,
    ).toBe(true);
  });

  it("slow when 2 of last 3 latencies exceed 4000 ms", () => {
    const request = (latencyMs: number): ConnectivityEvent => ({
      type: "request_ok",
      at: 1,
      latencyMs,
    });
    expect(deriveConnectivity(run([request(4500), request(100)])).slow).toBe(
      false,
    );
    expect(
      deriveConnectivity(run([request(4500), request(100), request(5000)]))
        .slow,
    ).toBe(true);
    const timedOut = run([
      request(4500),
      { type: "request_fail", at: 2, code: "request_timeout" },
    ]);
    expect(timedOut.mode).toBe("online");
    expect(deriveConnectivity(timedOut).slow).toBe(true);
    // Older samples roll off.
    expect(
      deriveConnectivity(
        run([request(9000), request(9000), request(1), request(1), request(1)]),
      ).slow,
    ).toBe(false);
  });

  it("probe delay schedule online/hidden/offline backoff caps at 15 s", () => {
    const online = initialConnectivity();
    const offline = run([fail(), fail()]);
    expect(nextProbeDelay(online, false, 0)).toBe(30_000);
    expect(nextProbeDelay(online, true, 0)).toBe(120_000);
    expect(
      [1, 2, 3, 4, 5, 9].map((n) => nextProbeDelay(offline, false, n)),
    ).toEqual([2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    const manualOnline = run([{ type: "manual", value: true }]);
    expect(nextProbeDelay(manualOnline, false, 0)).toBe(30_000);
  });

  it("a failed heartbeat while still online is confirmed in 3 s, not after another 30 s cycle", () => {
    // Regression OUTAGE-006: an idle tablet needed two full 30 s cycles (up
    // to about 68 s) to go offline when the ISP dropped, so a charge started
    // meanwhile hung for 15 s and was then refused offline.
    const once = run([ok(), fail(2)]);
    expect(once.mode).toBe("online");
    expect(nextProbeDelay(once, false, 0)).toBe(CONFIRM_PROBE_MS);
    expect(nextProbeDelay(once, true, 0)).toBe(CONFIRM_PROBE_MS);
    expect(CONFIRM_PROBE_MS).toBeLessThanOrEqual(4_000);
    // The confirmation fails too: offline, then the offline backoff.
    const twice = reduceConnectivity(once, fail(3));
    expect(twice.mode).toBe("offline");
    expect(nextProbeDelay(twice, false, 1)).toBe(2_000);
    // A failed request counts the same way (the device also probes 1 s later).
    const request = reduceConnectivity(run([ok()]), {
      type: "request_fail",
      at: 2,
      code: "request_timeout",
    });
    expect(nextProbeDelay(request, false, 0)).toBe(CONFIRM_PROBE_MS);
    // A success clears it: back to the normal cycle.
    expect(nextProbeDelay(reduceConnectivity(once, ok(4)), false, 0)).toBe(
      30_000,
    );
  });
});

describe("sync error classification and retry", () => {
  it("classifySyncError: transient kinds and codes, auth, archived, synced, conflict", () => {
    for (const kind of ["network", "timeout", "server"] as const)
      expect(classifySyncError("anything", kind)).toBe("transient");
    for (const code of [
      "network_unavailable",
      "request_timeout",
      "server_unavailable",
      "invalid_response",
      "rate_limited",
      "internal_error",
      "schema_not_ready",
      "database_unavailable",
      "offline_recorded_in_future",
      "offline_dependency_pending",
    ])
      expect(classifySyncError(code, "domain")).toBe("transient");
    for (const code of ["unauthorized", "session_changed", "missing_tenant"])
      expect(classifySyncError(code, "domain")).toBe("auth");
    expect(classifySyncError("x", "auth")).toBe("auth");
    expect(classifySyncError("offline_archived", "domain")).toBe("archived");
    expect(classifySyncError("offline_already_synced", "domain")).toBe(
      "synced",
    );
    for (const code of [
      "price_conflict",
      "offline_evidence_invalid",
      "offline_outside_lease",
      "offline_payment_exceeds_due",
      "operation_conflict",
      "settings_changed",
    ])
      expect(classifySyncError(code, "domain")).toBe("conflict");
  });

  it("50 consecutive transient failures never yield conflict and delay caps at 60 s ±20 %", () => {
    // Regression OFF-6: transient failures used to exhaust after ~5 minutes.
    let status = "pending",
      attempts = 0;
    for (let i = 0; i < 50; i++) {
      const outcome = classifySyncError("server_unavailable", "server");
      if (outcome === "conflict") status = "conflict";
      const delay = retryDelay(attempts, () => 1);
      expect(delay).toBeLessThanOrEqual(72_000);
      attempts++;
    }
    expect(status).toBe("pending");
    expect(retryDelay(50, () => 0)).toBe(48_000);
    expect(retryDelay(50, () => 1)).toBe(72_000);
  });

  it("retryDelay jitter bounds", () => {
    expect(retryDelay(0, () => 0.5)).toBe(2_000);
    expect(retryDelay(1, () => 0.5)).toBe(4_000);
    expect(retryDelay(5, () => 0.5)).toBe(60_000);
    for (let i = 0; i < 200; i++) {
      const d = retryDelay(3);
      expect(d).toBeGreaterThanOrEqual(12_800);
      expect(d).toBeLessThanOrEqual(19_200);
    }
  });
});

describe("clock and numbering", () => {
  it("offsetFromSample uses RTT midpoint; median of 5", () => {
    expect(offsetFromSample(1_000, 1_200, 61_100)).toEqual({
      offsetMs: 60_000,
      rttMs: 200,
    });
    expect(medianOffset([5, 1, 900, 3, 4])).toBe(4);
    expect(medianOffset([1, 3])).toBe(2);
    expect(medianOffset([])).toBe(0);
  });

  it("formatProvisional pads and fallbackPrefix matches regex", () => {
    expect(formatProvisional("B", 7)).toBe("B-07");
    expect(formatProvisional("A1", 123)).toBe("A1-123");
    expect(() => formatProvisional("B", 0)).toThrow();
    expect(() => formatProvisional("B", 10_000)).toThrow();
    const prefix = fallbackPrefix("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(prefix).toMatch(/^Z[A-Z2-7]{2}$/);
    expect(fallbackPrefix("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(prefix);
    expect(
      provisionalNumber.safeParse(formatProvisional(prefix, 1)).success,
    ).toBe(true);
  });

  it("offlineWindow expiry with server offset", () => {
    const until = "2026-10-04T20:00:00.000Z";
    const at = Date.parse("2026-10-04T19:00:00.000Z");
    expect(offlineWindow(until, at)).toEqual({
      expired: false,
      minutesLeft: 60,
    });
    // A device 2 hours behind still expires on server time.
    expect(offlineWindow(until, at + 2 * 3600_000).expired).toBe(true);
    expect(offlineWindow(until, Date.parse(until)).expired).toBe(true);
  });
});

describe("initial state", () => {
  it("starts offline when the browser reports offline and remembers manual mode", () => {
    const s: ConnectivityState = initialConnectivity(true, true);
    expect(s.mode).toBe("offline");
    expect(s.manual).toBe(true);
  });
});

describe("Revision 2 rules", () => {
  it("lanePollDelay is 10 s with items and 30 s when the lane is empty", () => {
    // Regression GAP-4: every KDS polled the empty lane every 10 s.
    expect(LANE_POLL_BUSY_MS).toBe(10_000);
    expect(LANE_POLL_IDLE_MS).toBe(30_000);
    expect(lanePollDelay(0)).toBe(30_000);
    expect(lanePollDelay(1)).toBe(10_000);
    expect(lanePollDelay(12)).toBe(10_000);
  });

  it("acceptsOfflineRound refuses a zero or negative balance and accepts a positive one", () => {
    expect(acceptsOfflineRound({ total: 250, paid: 250 })).toBe(false);
    expect(acceptsOfflineRound({ total: 250, paid: 300 })).toBe(false);
    expect(acceptsOfflineRound({ total: 0, paid: 0 })).toBe(false);
    expect(acceptsOfflineRound({ total: 250, paid: 249 })).toBe(true);
    expect(acceptsOfflineRound({ total: 250, paid: 0 })).toBe(true);
  });
});
