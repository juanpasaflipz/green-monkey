/**
 * liveRead (src/offline.ts): Dexie 4.3's liveQuery listens for writes only after
 * its first result, so a write committed during that first read never re-runs it
 * (a sale that syncs as Sincronización opens stayed "Sincronizando" there).
 * liveRead adds one catch-up read; a later live result always wins over it.
 *
 * There is no IndexedDB in these unit tests, so liveQuery is replaced by a stand-in
 * that keeps Dexie 4.3's order (node_modules/dexie/dist/dexie.js, liveQuery): the
 * querier runs once on a timer, and only after that result is delivered can a write
 * re-run it (requery() here). The browser suite covers the real Dexie
 * (tests/browser/offline.spec.ts, "a sale that syncs as Sincronización opens…").
 */
import { describe, expect, it, vi } from "vitest";

type Observer = {
  next?: (value: unknown) => void;
  error?: (error: unknown) => void;
};
const live = vi.hoisted(() => ({ requery: () => {} }));

vi.mock("dexie", async (importOriginal) => ({
  ...(await importOriginal<typeof import("dexie")>()),
  liveQuery: (querier: () => Promise<unknown>) => ({
    subscribe(observer: Observer) {
      let closed = false;
      const run = () =>
        void querier().then(
          (value) => {
            if (!closed) observer.next?.(value);
          },
          (error) => {
            if (!closed) observer.error?.(error);
          },
        );
      setTimeout(() => {
        run();
        live.requery = run;
      }, 0);
      return {
        get closed() {
          return closed;
        },
        unsubscribe() {
          closed = true;
        },
      };
    },
  }),
}));

import { liveRead } from "../src/offline";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("liveRead", () => {
  it("delivers the catch-up read when a write commits during the first read", async () => {
    let stored = "syncing";
    const firstRead = deferred<void>();
    let calls = 0;
    const seen: string[] = [];
    const stop = liveRead(
      async () => {
        calls += 1;
        const value = stored;
        if (calls === 1) await firstRead.promise;
        return value;
      },
      (value) => seen.push(value),
    );
    await vi.waitFor(() => expect(calls).toBe(1));
    // The sync commits while the first read runs: liveQuery is not listening yet.
    stored = "synced";
    firstRead.resolve();
    await vi.waitFor(() => expect(seen).toEqual(["syncing", "synced"]));
    expect(calls).toBe(2);
    stop();
  });

  it("never lets the catch-up read overwrite a later live result", async () => {
    const catchUp = deferred<string>();
    let calls = 0;
    const seen: string[] = [];
    const stop = liveRead(
      () => {
        calls += 1;
        if (calls === 1) return Promise.resolve("first");
        if (calls === 2) return catchUp.promise;
        return Promise.resolve("live");
      },
      (value) => seen.push(value),
    );
    await vi.waitFor(() => expect(calls).toBe(2));
    live.requery();
    await vi.waitFor(() => expect(seen).toEqual(["first", "live"]));
    catchUp.resolve("stale");
    await settle();
    expect(seen).toEqual(["first", "live"]);
    stop();
  });

  it("delivers nothing once unsubscribed", async () => {
    const catchUp = deferred<string>();
    let calls = 0;
    const seen: string[] = [];
    const stop = liveRead(
      () => {
        calls += 1;
        return calls === 1 ? Promise.resolve("first") : catchUp.promise;
      },
      (value) => seen.push(value),
    );
    await vi.waitFor(() => expect(calls).toBe(2));
    stop();
    catchUp.resolve("late");
    await settle();
    expect(seen).toEqual(["first"]);
  });

  it("passes live errors on and ignores a failed catch-up read", async () => {
    let calls = 0;
    const seen: string[] = [],
      errors: string[] = [];
    const stop = liveRead(
      () => {
        calls += 1;
        if (calls === 1) return Promise.resolve("first");
        return Promise.reject(Error(calls === 2 ? "catch-up" : "live"));
      },
      (value) => seen.push(value),
      (error) => errors.push(error.message),
    );
    await vi.waitFor(() => expect(calls).toBe(2));
    await settle();
    expect(errors).toEqual([]);
    live.requery();
    await vi.waitFor(() => expect(errors).toEqual(["live"]));
    expect(seen).toEqual(["first"]);
    stop();
  });
});
