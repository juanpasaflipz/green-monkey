import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  ApiError,
  setRetryGate,
  setTransportObserver,
  type TransportOutcome,
} from "../src/api";

type Reply = () => Response | Promise<Response>;
function mockFetch(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
      Promise.resolve(reply()).then(resolve, reject);
    });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const text =
  (status: number, body: string, type = "text/html") =>
  () =>
    new Response(body, { status, headers: { "content-type": type } });
const hang = () => new Promise<Response>(() => {});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as ApiError;
  }
  throw Error("expected a failure");
}

beforeEach(() => {
  setTransportObserver(null);
  setRetryGate(null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("api transport", () => {
  it("HTML 502 maps to server_unavailable transient server error", async () => {
    // Regression OFF-1: a proxy HTML page used to throw a SyntaxError.
    mockFetch(text(502, "<html>Bad gateway</html>"));
    const e = await failure(api("/orders", { operationId: "x" }));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe("server_unavailable");
    expect(e.kind).toBe("server");
    expect(e.status).toBe(502);
    expect(e.transient).toBe(true);
  });

  it("network TypeError maps to network_unavailable", async () => {
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const e = await failure(api("/orders", {}));
    expect([e.message, e.kind, e.transient]).toEqual([
      "network_unavailable",
      "network",
      true,
    ]);
  });

  it("own timeout maps to request_timeout and aborts fetch", async () => {
    // Regression FOH-6: a hung server used to leave the payment modal stuck.
    vi.useFakeTimers();
    const calls = mockFetch(hang);
    const pending = failure(
      api("/orders/1/payments", {}, { idempotent: true }),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    const e = await pending;
    expect([e.message, e.kind]).toEqual(["request_timeout", "timeout"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });

  it("caller abort rethrows AbortError", async () => {
    mockFetch(hang);
    const controller = new AbortController();
    const pending = api("/catalog", undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("JSON 409 domain error keeps code and kind domain", async () => {
    mockFetch(json(409, { error: "price_conflict", requestId: "req-1" }));
    const e = await failure(api("/offline/sync", {}));
    expect([e.message, e.status, e.kind, e.requestId, e.transient]).toEqual([
      "price_conflict",
      409,
      "domain",
      "req-1",
      false,
    ]);
  });

  it("401 JSON maps to kind auth", async () => {
    mockFetch(json(401, { error: "unauthorized" }));
    const e = await failure(api("/session"));
    expect([e.message, e.kind]).toEqual(["unauthorized", "auth"]);
  });

  it("2xx non-JSON maps to invalid_response transient", async () => {
    mockFetch(text(200, "<html>captive portal</html>"));
    const e = await failure(api("/session"));
    expect([e.message, e.kind, e.transient]).toEqual([
      "invalid_response",
      "server",
      true,
    ]);
  });

  it("429 text maps to rate_limited", async () => {
    mockFetch(text(429, "Too many requests", "text/plain"));
    const e = await failure(api("/login", {}));
    expect([e.message, e.status]).toEqual(["rate_limited", 429]);
  });

  it("GET retries once on 503 but not on timeout", async () => {
    vi.useFakeTimers();
    const retried = mockFetch(
      json(503, { error: "database_unavailable" }),
      json(200, { ok: true }),
    );
    const ok = api("/catalog");
    await vi.advanceTimersByTimeAsync(400);
    expect(await ok).toEqual({ ok: true });
    expect(retried).toHaveLength(2);
    const once = mockFetch(hang);
    const timedOut = failure(api("/catalog"));
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await timedOut).message).toBe("request_timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(once).toHaveLength(1);
  });

  it("POST does not retry unless idempotent; idempotent retries once on network error", async () => {
    vi.useFakeTimers();
    const plain = mockFetch(() => Promise.reject(new TypeError("offline")));
    const first = failure(api("/orders", {}));
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await first).message).toBe("network_unavailable");
    expect(plain).toHaveLength(1);
    const idempotent = mockFetch(
      () => Promise.reject(new TypeError("offline")),
      json(200, { id: "order" }),
    );
    const second = api("/orders", { operationId: "op" }, { idempotent: true });
    await vi.advanceTimersByTimeAsync(800);
    expect(await second).toEqual({ id: "order" });
    expect(idempotent).toHaveLength(2);
    expect(idempotent[1]!.init.body).toBe(idempotent[0]!.init.body);
    // No retry once connectivity says the server is unreachable.
    setRetryGate(() => false);
    const gated = mockFetch(() => Promise.reject(new TypeError("offline")));
    const third = failure(api("/orders", {}, { idempotent: true }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await third).message).toBe("network_unavailable");
    expect(gated).toHaveLength(1);
  });

  it("an idempotent POST retried into a 401 reports the first, unknown outcome (integration)", async () => {
    vi.useFakeTimers();
    const calls = mockFetch(
      () => Promise.reject(new TypeError("offline")),
      json(401, { error: "session_expired" }),
    );
    const paid = failure(
      api("/orders/o/payments", { operationId: "op" }, { idempotent: true }),
    );
    await vi.advanceTimersByTimeAsync(800);
    const e = await paid;
    expect([e.message, e.kind, e.transient]).toEqual([
      "network_unavailable",
      "network",
      true,
    ]);
    expect(calls).toHaveLength(2);
  });

  it("an idempotent POST retried into session_changed or missing_tenant reports the first, unknown outcome (OFF-INT-1)", async () => {
    // Authentication answers both before any handler runs: the retry was not
    // processed, which says nothing about the first attempt. Selling clears a
    // payment attempt on a 409, so a 409 here would lose "Recuperar pago".
    vi.useFakeTimers();
    for (const [status, code] of [
      [409, "session_changed"],
      [403, "missing_tenant"],
    ] as const) {
      const calls = mockFetch(
        () => Promise.reject(new TypeError("offline")),
        json(status, { error: code }),
      );
      const paid = failure(
        api("/orders/o/payments", { operationId: "op" }, { idempotent: true }),
      );
      await vi.advanceTimersByTimeAsync(800);
      const e = await paid;
      expect([e.message, e.status, e.kind, e.transient]).toEqual([
        "network_unavailable",
        0,
        "network",
        true,
      ]);
      expect(calls).toHaveLength(2);
    }
    // A domain refusal on the retry is still the answer: the handler ran.
    const refused = mockFetch(
      () => Promise.reject(new TypeError("offline")),
      json(409, { error: "check_closed" }),
    );
    const closed = failure(
      api("/orders/o/payments", { operationId: "op" }, { idempotent: true }),
    );
    await vi.advanceTimersByTimeAsync(800);
    expect((await closed).message).toBe("check_closed");
    expect(refused).toHaveLength(2);
  });

  it("transport observer receives ok/kind/latency", async () => {
    const outcomes: TransportOutcome[] = [];
    setTransportObserver((o) => outcomes.push(o));
    mockFetch(json(200, { ok: true }));
    await api("/session");
    mockFetch(json(409, { error: "stale_order" }));
    await failure(api("/orders", {}));
    mockFetch(text(504, "gateway"));
    await failure(api("/orders", {}));
    expect(outcomes.map(({ ok, kind, path }) => ({ ok, kind, path }))).toEqual([
      { ok: true, kind: undefined, path: "/session" },
      { ok: false, kind: "domain", path: "/orders" },
      { ok: false, kind: "server", path: "/orders" },
    ]);
    expect(outcomes.every((o) => o.latencyMs >= 0)).toBe(true);
  });

  it("session_changed dispatches gm-session-changed", async () => {
    const target = new EventTarget();
    const seen = vi.fn();
    target.addEventListener("gm-session-changed", seen);
    vi.stubGlobal("window", target);
    mockFetch(json(409, { error: "session_changed" }));
    const e = await failure(api("/orders", {}));
    expect(e.message).toBe("session_changed");
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
