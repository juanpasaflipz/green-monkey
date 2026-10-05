import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import type postgres from "postgres";
import {
  bootBackoffMs,
  bootDatabase,
  drainOnSignal,
  isTransientDbError,
} from "../server/boot.js";
import { requiredSchemaMigration } from "../server/readiness.js";
import { setLogSink } from "../server/log.js";

beforeAll(() => setLogSink(() => {}));
afterAll(() => setLogSink(null));

/** A fake sql tag that answers readiness queries with the given rows. */
function readySql(state: { schema: boolean; registry: boolean; grants?: boolean }) {
  return vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("from schema_grants"))
      return [{ grants: state.grants ?? true }];
    return [{ schema: state.schema, has_registry: state.registry }];
  }) as unknown as postgres.Sql;
}

describe("boot", () => {
  it("classifies connectivity failures as transient and configuration as fatal", () => {
    for (const code of ["ECONNREFUSED", "CONNECT_TIMEOUT", "57P03", "53300", "08006"])
      expect(isTransientDbError({ code }), code).toBe(true);
    expect(isTransientDbError(new AggregateError([{ code: "ECONNREFUSED" }]))).toBe(true);
    expect(isTransientDbError({ code: "28P01" })).toBe(false);
    expect(isTransientDbError(new Error("Runtime role must not bypass RLS"))).toBe(false);
    expect(
      isTransientDbError(new Error("Couldn't connect to compute node")),
    ).toBe(true);
  });

  it("connection errors and schema_not_ready retry with backoff", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const check = vi.fn(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    });
    let ready = false;
    // First readiness query reports the schema missing, then ready.
    let schemaCalls = 0;
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("from schema_grants")) return [{ grants: true }];
      schemaCalls++;
      return [{ schema: schemaCalls > 1, has_registry: true }];
    }) as unknown as postgres.Sql;
    const exit = vi.fn();
    await bootDatabase(sql, {
      kind: "web",
      check,
      onReady: () => (ready = true),
      sleep: async (ms) => void sleeps.push(ms),
      rand: () => 0.5,
      exit,
    });
    expect(ready).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(sleeps).toEqual([1000, 2000]);
    expect(bootBackoffMs(10, () => 0.5)).toBe(30_000);
  });

  it("role assertion errors exit fatally", async () => {
    const exit = vi.fn();
    await bootDatabase(readySql({ schema: true, registry: true }), {
      kind: "web",
      check: async () => {
        throw new Error("Runtime role must not bypass RLS");
      },
      onReady: () => {
        throw new Error("must not become ready");
      },
      sleep: async () => {},
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("the worker skips the grants check", async () => {
    let ready = false;
    const sql = readySql({ schema: true, registry: true, grants: false });
    await bootDatabase(sql, {
      kind: "worker",
      check: async () => {},
      onReady: () => (ready = true),
      exit: () => {
        throw new Error("unexpected exit");
      },
    });
    expect(ready).toBe(true);
    expect(requiredSchemaMigration).toMatch(/^\d{3}_/);
  });

  it("drain exits after in-flight requests and forces exit at drainSeconds-2", async () => {
    const signals = new EventEmitter();
    const state = { draining: false };
    const exits: number[] = [];
    let finishRequest!: () => void;
    const server = http.createServer((_req, res) => {
      finishRequest = () => res.end("ok");
    });
    const arrived = new Promise<void>((resolve) => {
      server.on("request", () => resolve());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const response = fetch(`http://127.0.0.1:${port}/`);
    await arrived;
    const close = vi.fn(async () => {});
    drainOnSignal(server, state, close, {
      drainSeconds: 20,
      emitter: signals,
      exit: (code) => void exits.push(code),
    });
    signals.emit("SIGTERM", "SIGTERM");
    expect(state.draining).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(close).not.toHaveBeenCalled();
    expect(exits).toEqual([]);
    finishRequest();
    expect((await response).status).toBe(200);
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(close).toHaveBeenCalledOnce();

    // A stuck close() is cut off at drainSeconds - 2.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stuck = new EventEmitter();
      const forced: number[] = [];
      drainOnSignal(null, { draining: false }, () => new Promise(() => {}), {
        drainSeconds: 20,
        emitter: stuck,
        exit: (code) => void forced.push(code),
      });
      stuck.emit("SIGTERM", "SIGTERM");
      vi.advanceTimersByTime(17_999);
      expect(forced).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(forced).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
