import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../shared/domain";

type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let events: string[] = [];

const session = {
  id: "50000000-0000-4000-8000-000000000001",
  tenantId: "10000000-0000-4000-8000-000000000001",
  employeeId: "20000000-0000-4000-8000-000000000001",
  deviceId: "30000000-0000-4000-8000-000000000001",
  name: "Alex",
  role: "owner",
  csrf: "csrf",
  expiresAt: "",
  offlineUntil: "",
  restaurant: { name: "R", currency: "MXN", timezone: "UTC", cutoff: 0 },
} as Session;

async function load() {
  vi.resetModules();
  return import("../src/api");
}

beforeEach(() => {
  replies = [];
  events = [];
  fetchMock = vi.fn(async () => {
    const r = replies.shift() ?? { status: 200, body: { ok: true } };
    return {
      ok: r.status < 400,
      status: r.status,
      json: async () => r.body,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  const target = new EventTarget();
  target.addEventListener("gm-unauthorized", (e) =>
    events.push((e as CustomEvent<string>).detail),
  );
  vi.stubGlobal("window", target);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api() session policy", () => {
  it("a session 401 dispatches gm-unauthorized once and blocks further calls (FOH-7)", async () => {
    const { api, setSession, ApiError } = await load();
    setSession(session);
    replies.push({ status: 401, body: { error: "session_expired" } });
    await expect(api("/orders")).rejects.toMatchObject({
      message: "session_expired",
      status: 401,
    });
    expect(events).toEqual(["session_expired"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Blocked: KDS-style polling no longer reaches the server.
    const blocked = api("/kitchen");
    await expect(blocked).rejects.toBeInstanceOf(ApiError);
    await expect(blocked).rejects.toMatchObject({ message: "session_expired" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["session_expired"]);
    // Access endpoints still work so the lock screen can sign in again.
    await api("/access/terminal");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A new session unblocks.
    setSession(session);
    await api("/catalog");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not block when no session is active, but still reports device codes", async () => {
    const { api } = await load();
    replies.push({ status: 401, body: { error: "device_not_paired" } });
    await expect(api("/session")).rejects.toMatchObject({
      message: "device_not_paired",
    });
    await api("/session");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["device_not_paired"]);
  });

  it("401s from /access/ endpoints never trigger the global handler", async () => {
    const { api, setSession } = await load();
    setSession(session);
    replies.push({ status: 401, body: { error: "invalid_pin" } });
    replies.push({ status: 401, body: { error: "session_expired" } });
    await expect(
      api("/access/pin", { employeeId: "x", secret: "000000" }),
    ).rejects.toMatchObject({ message: "invalid_pin" });
    await expect(
      api("/access/step-up", { secret: "000000" }),
    ).rejects.toMatchObject({ message: "session_expired" });
    expect(events).toEqual([]);
    await api("/orders");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("step_up_required opens the handler and retries the identical body once", async () => {
    const { api, setSession, registerStepUpHandler } = await load();
    setSession(session);
    const handler = vi.fn(async () => {});
    registerStepUpHandler(handler);
    replies.push({ status: 403, body: { error: "step_up_required" } });
    replies.push({ status: 200, body: { id: "refund" } });
    const body = { operationId: "op-1", tenderId: "t", amount: 100 };
    await expect(api("/refunds", body)).resolves.toEqual({ id: "refund" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls as unknown as [
      string,
      RequestInit,
    ][];
    expect(second[0]).toBe(first[0]);
    expect(second[1].body).toBe(first[1].body);
    expect(JSON.parse(String(second[1].body))).toEqual(body);
    // The retry never asks a second time.
    replies.push({ status: 403, body: { error: "step_up_required" } });
    replies.push({ status: 403, body: { error: "step_up_required" } });
    await expect(api("/refunds", body)).rejects.toMatchObject({
      message: "step_up_required",
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("concurrent step_up_required requests share one PIN prompt and both retry (ACC-12)", async () => {
    const { api, setSession, registerStepUpHandler } = await load();
    setSession(session);
    let confirm!: () => void;
    const handler = vi.fn(
      () => new Promise<void>((resolve) => (confirm = resolve)),
    );
    registerStepUpHandler(handler);
    replies.push({ status: 403, body: { error: "step_up_required" } });
    replies.push({ status: 403, body: { error: "step_up_required" } });
    replies.push({ status: 200, body: { id: "a" } });
    replies.push({ status: 200, body: { id: "b" } });
    const a = api("/refunds", { operationId: "op-a" });
    const b = api("/cash/paid-out", { operationId: "op-b" });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    // Let the second request reach its own step_up_required as well.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(1);
    confirm();
    const results = await Promise.all([a, b]);
    expect(results.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // A later step-up opens a fresh prompt.
    replies.push({ status: 403, body: { error: "step_up_required" } });
    const c = api("/refunds", { operationId: "op-c" });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    confirm();
    await expect(c).resolves.toEqual({ ok: true });
  });

  it("held requests wait for the release and then carry the new session headers (ACC-5)", async () => {
    const { api, setSession, holdRequests } = await load();
    setSession(session);
    const release = holdRequests();
    const poll = api("/kitchen");
    // Access calls (the PIN sign-in itself) are never held.
    await api("/access/pin", { employeeId: "e", secret: "123456" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const next = { ...session, id: "50000000-0000-4000-8000-000000000002" };
    setSession(next);
    release();
    await poll;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-session-id"]).toBe(
      next.id,
    );
    // A forgotten hold releases itself.
    vi.useFakeTimers();
    try {
      holdRequests(1000);
      const late = api("/orders");
      await vi.advanceTimersByTimeAsync(1001);
      await late;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requestsBlocked reports a session 401 until a new session is set (ACC-6)", async () => {
    const { api, setSession, requestsBlocked } = await load();
    setSession(session);
    expect(requestsBlocked()).toBe(false);
    replies.push({ status: 401, body: { error: "session_ended" } });
    await expect(api("/sync", {})).rejects.toMatchObject({
      message: "session_ended",
    });
    expect(requestsBlocked()).toBe(true);
    setSession(session);
    expect(requestsBlocked()).toBe(false);
  });

  it("cancelled step-up surfaces step_up_cancelled", async () => {
    const { api, setSession, registerStepUpHandler, ApiError } = await load();
    setSession(session);
    registerStepUpHandler(async () => {
      throw new ApiError("step_up_cancelled", 403);
    });
    replies.push({ status: 403, body: { error: "step_up_required" } });
    await expect(
      api("/cash/paid-out", { operationId: "op", amount: 1, reason: "abc" }),
    ).rejects.toMatchObject({ message: "step_up_cancelled", status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
