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
