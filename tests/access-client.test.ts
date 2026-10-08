import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../shared/domain";
import { classifySyncError } from "../src/offline-policy";

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
    // A real JSON response: offline's request() (026) reads text() and checks
    // the content type, so a captive-portal page is never taken for data.
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
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
    // OFF-7 (integration): a queued sale refused while blocked waits as auth in
    // offline's sync loop; it is never classified as a conflict.
    const sync = await api("/offline/sync", { operationId: "op-s" }).catch(
      (e: InstanceType<typeof ApiError>) => e,
    );
    expect(sync).toMatchObject({ message: "session_expired", kind: "auth" });
    expect(
      classifySyncError(
        (sync as InstanceType<typeof ApiError>).message,
        (sync as InstanceType<typeof ApiError>).kind,
      ),
    ).toBe("auth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    const [, init] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
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

  it("isSessionRejection is true only for session 401s, including a blocked call that was never sent (ACC-FLOOR-1)", async () => {
    const { api, setSession, isSessionRejection, ApiError } = await load();
    setSession(session);
    replies.push({ status: 401, body: { error: "session_ended" } });
    const rejected = await api("/orders/x/payments", {}).catch((e) => e);
    expect(isSessionRejection(rejected)).toBe(true);
    const unsent = await api("/orders/x/payments", {}).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isSessionRejection(unsent)).toBe(true);
    expect(isSessionRejection(new ApiError("invalid_pin", 401))).toBe(false);
    expect(isSessionRejection(new ApiError("session_expired", 409))).toBe(
      false,
    );
    expect(isSessionRejection(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("while a soft unlock is in effect and the server answers again, calls are refused unsent; access calls and offline sync still go (ACC-R-2)", async () => {
    const { api, setSession, isSessionRejection, registerSoftUnlockCheck } =
      await load();
    setSession(session);
    let reachable = false,
      checks = 0;
    registerSoftUnlockCheck(async () => {
      checks++;
      return reachable;
    });
    // Still unreachable: the call is sent (and, offline, fails as usual).
    await api("/orders");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(checks).toBe(1);
    // The server answers again: App re-locks and the call never leaves.
    reachable = true;
    const refused = await api("/cash/close", { operationId: "x" }).catch(
      (e) => e,
    );
    expect(refused).toMatchObject({ message: "session_locked", status: 401 });
    expect(isSessionRejection(refused)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    // The lock screen's own calls and queued offline evidence are not held.
    await api("/access/terminal");
    await api("/sync", {});
    // Offline sync posts to /offline/sync since offline (026) merged.
    await api("/offline/sync", {});
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(checks).toBe(2);
    // Unregistered once the lock is back: calls go out again.
    registerSoftUnlockCheck(null);
    await api("/orders");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("while a soft unlock is in effect and the server answers again, authenticated /access/ reads are refused unsent; only the lock screen's own calls go (ACC-R6-3)", async () => {
    const { api, setSession, registerSoftUnlockCheck } = await load();
    setSession(session);
    let checks = 0;
    registerSoftUnlockCheck(async () => {
      checks++;
      return true;
    });
    for (const path of [
      "/access/staff",
      "/access/devices",
      "/access/pairing-codes",
      "/access/approvers",
    ])
      await expect(api(path)).rejects.toMatchObject({
        message: "session_locked",
        status: 401,
      });
    await expect(
      api("/access/staff/x/active", { operationId: "x", active: false }),
    ).rejects.toMatchObject({ message: "session_locked" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(checks).toBe(5);
    // The lock screen's roster, PIN sign-in and step-up still reach the server.
    await api("/access/terminal");
    await api("/access/pin", { employeeId: "x", secret: "123456" });
    await api("/access/step-up", { secret: "123456" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(checks).toBe(5);
    registerSoftUnlockCheck(null);
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
  it("a switch while the PIN prompt is open never sends the retry as the new employee (ACC-20)", async () => {
    const { api, setSession, registerStepUpHandler } = await load();
    setSession(session);
    let confirm!: () => void;
    const handler = vi.fn(
      (_sessionId: string) =>
        new Promise<void>((resolve) => (confirm = resolve)),
    );
    registerStepUpHandler(handler);
    replies.push({ status: 403, body: { error: "step_up_required" } });
    const refund = api("/refunds", { operationId: "op-a", amount: 100 });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    // The prompt is for the session that sent the command.
    expect(handler).toHaveBeenCalledWith(session.id);
    // Manager B switches in from the lock, then the prompt resolves.
    setSession({
      ...session,
      id: "50000000-0000-4000-8000-0000000000b2",
      csrf: "csrf-b",
    });
    confirm();
    await expect(refund).rejects.toMatchObject({
      message: "session_changed",
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a step_up_required answered after a switch asks nobody and is not retried (ACC-20)", async () => {
    const { api, setSession, registerStepUpHandler } = await load();
    setSession(session);
    const handler = vi.fn(async (_sessionId: string) => {});
    registerStepUpHandler(handler);
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    fetchMock.mockImplementationOnce(async () => {
      await answered;
      return new Response(JSON.stringify({ error: "step_up_required" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    });
    const paidOut = api("/cash/paid-out", { operationId: "op-p", amount: 1 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    setSession({ ...session, id: "50000000-0000-4000-8000-0000000000b3" });
    answer();
    await expect(paidOut).rejects.toMatchObject({ message: "session_changed" });
    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a sign-out while the PIN prompt is open never sends the retry (ACC-20)", async () => {
    const { api, setSession, clearSessionScope, registerStepUpHandler } =
      await load();
    setSession(session);
    let confirm!: () => void;
    registerStepUpHandler(
      () => new Promise<void>((resolve) => (confirm = resolve)),
    );
    replies.push({ status: 403, body: { error: "step_up_required" } });
    const request = api("/access/devices/revoke", { operationId: "op-d" });
    await vi.waitFor(() => expect(confirm).toBeTypeOf("function"));
    clearSessionScope();
    confirm();
    await expect(request).rejects.toMatchObject({ message: "session_changed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prompts are never shared across sessions (ACC-20)", async () => {
    const { api, setSession, registerStepUpHandler } = await load();
    const b = { ...session, id: "50000000-0000-4000-8000-0000000000b4" };
    setSession(session);
    const confirms: Record<string, () => void> = {};
    const handler = vi.fn(
      (sessionId: string) =>
        new Promise<void>((resolve) => (confirms[sessionId] = resolve)),
    );
    registerStepUpHandler(handler);
    replies.push({ status: 403, body: { error: "step_up_required" } });
    const first = api("/refunds", { operationId: "op-1" });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    setSession(b);
    replies.push({ status: 403, body: { error: "step_up_required" } });
    replies.push({ status: 200, body: { id: "b-refund" } });
    const second = api("/refunds", { operationId: "op-2" });
    // B gets a prompt of its own instead of joining A's.
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler.mock.calls.map(([id]) => id)).toEqual([session.id, b.id]);
    confirms[b.id]!();
    await expect(second).resolves.toEqual({ id: "b-refund" });
    confirms[session.id]!();
    await expect(first).rejects.toMatchObject({ message: "session_changed" });
    // A's command was sent once and never retried.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
