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
    expect(JSON.parse(store.get(ACTIVITY_KEY)!)).toEqual({
      sessionId: B,
      at: 15_002,
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
    vi.stubGlobal("document", { body: { children: [app, keep, modal, already] } });
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
    for (const code of ["session_revoked", "device_revoked", "device_not_paired"])
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
