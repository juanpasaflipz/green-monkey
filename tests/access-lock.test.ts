import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../shared/domain";

// settleRejectedSession works on the IndexedDB cache; an in-memory stand-in.
const cache = new Map<string, { id: string; value: unknown }>();
vi.mock("../src/offline", () => ({
  db: {
    cache: {
      get: async (id: string) => cache.get(id),
      delete: async (id: string) => void cache.delete(id),
    },
  },
  scope: () => "scope",
  syncPending: async () => {},
}));

const session = (id: string, idleLockSeconds: number | null = 180) =>
  ({
    id,
    access: {
      absoluteExpiresAt: null,
      authenticatedAt: null,
      deviceName: "Caja",
      deviceKind: "terminal",
      idleLockSeconds,
      ownerAccount: false,
    },
  }) as unknown as Session;
const A = "50000000-0000-4000-8000-00000000000a";
const B = "50000000-0000-4000-8000-00000000000b";

let store: Map<string, string>;
async function load() {
  vi.resetModules();
  return import("../src/access/lock");
}
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lock markers (SEC-6, ACC-1/ACC-2)", () => {
  it("a remembered lock comes back only for the same session until forgotten", async () => {
    const { rememberLock, forgetLock, restoredLock } = await load();
    expect(restoredLock(session(A))).toBeNull();
    rememberLock(A, "manual");
    expect(restoredLock(session(A))).toBe("manual");
    expect(restoredLock(session(A, null))).toBe("manual");
    // A new sign-in (another session id) is not affected.
    expect(restoredLock(session(B))).toBeNull();
    rememberLock(A, "session_ended");
    expect(restoredLock(session(A))).toBe("session_ended");
    forgetLock();
    expect(restoredLock(session(A))).toBeNull();
  });

  it("a restore after a pause longer than the auto-lock starts locked as idle", async () => {
    const { noteActivity, restoredLock } = await load();
    const t0 = 1_000_000;
    noteActivity(A, true, t0);
    expect(restoredLock(session(A), t0 + 179_000)).toBeNull();
    expect(restoredLock(session(A), t0 + 181_000)).toBe("idle");
    // Never-lock devices and other sessions never lock by inactivity.
    expect(restoredLock(session(A, null), t0 + 3_600_000)).toBeNull();
    expect(restoredLock(session(B), t0 + 3_600_000)).toBeNull();
  });

  it("activity writes are throttled per session but forced writes always land", async () => {
    const { noteActivity, ACTIVITY_KEY } = await load();
    noteActivity(A, false, 10_000);
    noteActivity(A, false, 12_000);
    expect(JSON.parse(store.get(ACTIVITY_KEY)!).at).toBe(10_000);
    noteActivity(A, false, 15_001);
    expect(JSON.parse(store.get(ACTIVITY_KEY)!).at).toBe(15_001);
    noteActivity(B, false, 15_002);
    // The marker also names the writing tab, so tabs can tell their input apart (ACC-21).
    expect(JSON.parse(store.get(ACTIVITY_KEY)!)).toEqual({
      sessionId: B,
      at: 15_002,
      tab: expect.any(String),
    });
    noteActivity(B, true, 15_003);
    expect(JSON.parse(store.get(ACTIVITY_KEY)!).at).toBe(15_003);
  });

  it("corrupt or unavailable storage never locks and never throws", async () => {
    const { rememberLock, restoredLock, LOCK_KEY } = await load();
    store.set(LOCK_KEY, "{not json");
    expect(restoredLock(session(A))).toBeNull();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => rememberLock(A, "idle")).not.toThrow();
    expect(restoredLock(session(A))).toBeNull();
  });
});

describe("lock dialog guard (ACC-14)", () => {
  it("inertOutside makes every other top-level element inert and undoes only its own change", async () => {
    const { inertOutside } = await load();
    class Element {
      inert = false;
    }
    vi.stubGlobal("HTMLElement", Element);
    const keep = new Element(),
      app = new Element(),
      modal = new Element(),
      already = Object.assign(new Element(), { inert: true });
    vi.stubGlobal("document", {
      body: { children: [app, keep, modal, already] },
    });
    const release = inertOutside(keep as never);
    expect([app.inert, keep.inert, modal.inert, already.inert]).toEqual([
      true,
      false,
      true,
      true,
    ]);
    release();
    expect([app.inert, keep.inert, modal.inert, already.inert]).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });
});

describe("session 401 and the offline cache (ACC-15)", () => {
  it("a revoked session or device leaves the cache; other session codes lock it", async () => {
    const { cacheRuleFor } = await load();
    for (const code of [
      "session_revoked",
      "device_revoked",
      "device_not_paired",
    ])
      expect(cacheRuleFor(code)).toBe("forget");
    for (const code of ["unauthorized", "session_expired", "session_ended"])
      expect(cacheRuleFor(code)).toBe("lock");
    for (const code of ["session_changed", "step_up_required", "forbidden"])
      expect(cacheRuleFor(code)).toBeNull();
  });

  it("settleRejectedSession deletes a revoked cached session and its lock (cold start)", async () => {
    const { rememberLock, restoredLock } = await load();
    const { settleRejectedSession } = await import("../src/access/session");
    cache.set("session", { id: "session", value: session(A) });
    rememberLock(A, "manual");
    await settleRejectedSession("session_revoked");
    expect(cache.has("session")).toBe(false);
    expect(restoredLock(session(A))).toBeNull();
    cache.set("session", { id: "session", value: session(A) });
    await settleRejectedSession("device_revoked");
    expect(cache.has("session")).toBe(false);
  });

  it("settleRejectedSession locks an ended cached session with its code, replacing a soft lock", async () => {
    const { rememberLock, restoredLock } = await load();
    const { settleRejectedSession } = await import("../src/access/session");
    cache.set("session", { id: "session", value: session(A) });
    rememberLock(A, "manual");
    await settleRejectedSession("session_ended");
    expect(cache.has("session")).toBe(true);
    expect(restoredLock(session(A))).toBe("session_ended");
    // Codes that say nothing about the session change nothing.
    await settleRejectedSession("session_changed");
    expect(restoredLock(session(A))).toBe("session_ended");
    cache.clear();
    await settleRejectedSession("session_expired");
    expect(restoredLock(session(B))).toBeNull();
  });
});

describe("remembered logout (ACC-FLOOR-5)", () => {
  it("a late logout names the session it was meant for; a pending one is finished with it", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return bodies.length === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : { ok: true, status: 200, json: async () => ({ ok: true }) };
      }),
    );
    vi.resetModules();
    const { serverSignOut, finishPendingLogout, LOGOUT_PENDING_KEY } =
      await import("../src/access/session");
    expect(await serverSignOut(A)).toBe("local");
    expect(store.get(LOGOUT_PENDING_KEY)).toBe(A);
    expect(await finishPendingLogout()).toBe(true);
    expect(bodies).toEqual([{ sessionId: A }, { sessionId: A }]);
    expect(store.has(LOGOUT_PENDING_KEY)).toBe(false);
    // Without a known session the request names none.
    store.set(LOGOUT_PENDING_KEY, "unknown");
    await finishPendingLogout();
    expect(bodies.at(-1)).toEqual({});
  });
});

describe("lock across tabs (ACC-16)", () => {
  it("another tab's lock applies only to the same session, and every write is new", async () => {
    const { rememberLock, lockedFor, LOCK_KEY } = await load();
    expect(lockedFor(null, A)).toBeNull();
    expect(lockedFor("{not json", A)).toBeNull();
    rememberLock(A, "manual", 1);
    const first = store.get(LOCK_KEY)!;
    expect(lockedFor(first, A)).toBe("manual");
    expect(lockedFor(first, B)).toBeNull();
    // The same reason again is still a different value, so a storage event fires.
    rememberLock(A, "manual", 2);
    expect(store.get(LOCK_KEY)).not.toBe(first);
    expect(lockedFor(store.get(LOCK_KEY)!, A)).toBe("manual");
  });
});

describe("server locks never soften (ACC-18)", () => {
  it("a lock the server imposed is never replaced by an idle, manual or renew lock", async () => {
    const { nextLock, allowsContinueOffline } = await load();
    for (const code of [
      "session_revoked",
      "session_ended",
      "session_expired",
      "unauthorized",
    ]) {
      const server = { reason: code };
      for (const soft of ["idle", "manual", "renew"])
        expect(nextLock(server, soft)).toBe(server);
      // The first server reason stays as well.
      expect(nextLock(server, "session_expired")).toBe(server);
      expect(allowsContinueOffline(code)).toBe(false);
    }
    // A server code replaces a client lock.
    expect(nextLock({ reason: "manual" }, "session_revoked")).toEqual({
      reason: "session_revoked",
    });
    expect(nextLock({ reason: "idle" }, "session_ended")).toEqual({
      reason: "session_ended",
    });
    // Client locks: the one already up stays; none up locks with the reason.
    const idle = { reason: "idle" };
    expect(nextLock(idle, "manual")).toBe(idle);
    expect(nextLock(null, "manual")).toEqual({ reason: "manual" });
    expect(nextLock(null, "session_revoked")).toEqual({
      reason: "session_revoked",
    });
    expect(allowsContinueOffline("idle")).toBe(true);
    expect(allowsContinueOffline("manual")).toBe(true);
    // ACC-FLOOR-6: a renewal the cashier started keeps a valid session, so it
    // may continue offline too (changed deliberately from false).
    expect(allowsContinueOffline("renew")).toBe(true);
  });
});

describe("renewal prompt (ACC-FLOOR-6)", () => {
  it("the auto-lock turns a renewal prompt into an idle lock and never softens a server lock", async () => {
    const { idleLock, remembered } = await load();
    expect(idleLock({ reason: "renew" })).toEqual({ reason: "idle" });
    expect(idleLock(null)).toEqual({ reason: "idle" });
    const manual = { reason: "manual" };
    expect(idleLock(manual)).toBe(manual);
    // Any real lock (another tab's manual lock, a soft unlock's re-lock)
    // replaces a renewal prompt, whose "Ahora no" would otherwise pass it.
    const { nextLock } = await load();
    expect(nextLock({ reason: "renew" }, "manual")).toEqual({
      reason: "manual",
    });
    expect(nextLock({ reason: "renew" }, "session_ended")).toEqual({
      reason: "session_ended",
    });
    const renew = { reason: "renew" };
    expect(nextLock(renew, "renew")).toBe(renew);
    expect(nextLock({ reason: "idle" }, "renew")).toEqual({ reason: "idle" });
    const server = { reason: "session_ended" };
    expect(idleLock(server)).toBe(server);
    // A renewal prompt is never remembered across reloads or tabs; every
    // other lock is.
    expect(remembered("renew")).toBe(false);
    for (const reason of ["idle", "manual", "session_revoked"])
      expect(remembered(reason)).toBe(true);
  });
});

describe("idle lock across tabs (ACC-21)", () => {
  it("an idle lock in another tab never locks this tab; other reasons do", async () => {
    const { rememberLock, lockFromOtherTab, LOCK_KEY } = await load();
    rememberLock(A, "idle", 1);
    expect(lockFromOtherTab(store.get(LOCK_KEY)!, A)).toBeNull();
    rememberLock(A, "manual", 2);
    expect(lockFromOtherTab(store.get(LOCK_KEY)!, A)).toBe("manual");
    expect(lockFromOtherTab(store.get(LOCK_KEY)!, B)).toBeNull();
    rememberLock(A, "session_ended", 3);
    expect(lockFromOtherTab(store.get(LOCK_KEY)!, A)).toBe("session_ended");
  });

  it("a due idle lock waits while another tab of the session had input within the window", async () => {
    const { noteActivity, idleElsewhereWait, ACTIVITY_KEY } = await load();
    const t0 = 1_000_000;
    // This tab's own input never defers its own timer.
    noteActivity(A, true, t0);
    expect(idleElsewhereWait(A, 180, t0 + 180_000)).toBe(0);
    // Another tab's input 60 s ago: wait the rest of that tab's window.
    store.set(
      ACTIVITY_KEY,
      JSON.stringify({ sessionId: A, at: t0 + 120_000, tab: "other-tab" }),
    );
    expect(idleElsewhereWait(A, 180, t0 + 180_000)).toBe(120_000);
    // Idle everywhere: lock now.
    expect(idleElsewhereWait(A, 180, t0 + 300_000)).toBe(0);
    // Another session's input, or a corrupt marker, defers nothing.
    expect(idleElsewhereWait(B, 180, t0 + 180_000)).toBe(0);
    store.set(ACTIVITY_KEY, "{not json");
    expect(idleElsewhereWait(A, 180, t0 + 180_000)).toBe(0);
  });
});
