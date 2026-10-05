import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import type postgres from "postgres";
import { drainOnSignal } from "../server/boot.js";
import { waitForDatabase } from "../server/db.js";
import {
  isTransientDbError,
  retryBackoffMs,
  statementTimeoutMs,
} from "../server/db-support.js";
import { setLogSink } from "../server/logging.js";

beforeAll(() => setLogSink(() => {}));
afterAll(() => setLogSink(null));

describe("boot", () => {
  it("classifies connectivity failures as transient and configuration as fatal", () => {
    for (const code of [
      "ECONNREFUSED",
      "CONNECT_TIMEOUT",
      "57P03",
      "53300",
      "08006",
    ])
      expect(isTransientDbError({ code }), code).toBe(true);
    expect(
      isTransientDbError(new AggregateError([{ code: "ECONNREFUSED" }])),
    ).toBe(true);
    expect(isTransientDbError({ code: "28P01" })).toBe(false);
    expect(
      isTransientDbError(new Error("Runtime role must not bypass RLS")),
    ).toBe(false);
    expect(
      isTransientDbError(new Error("Couldn't connect to compute node")),
    ).toBe(true);
  });

  it("waitForDatabase retries connection errors with capped backoff (OPS-11 regression)", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await waitForDatabase({} as postgres.Sql, {
      check: async () => {
        if (++calls < 4)
          throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
      sleep: async (ms) => void sleeps.push(ms),
      rand: () => 0.5,
    });
    expect(calls).toBe(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(retryBackoffMs(10, () => 0.5)).toBe(30_000);
    expect(retryBackoffMs(0, () => 0)).toBe(800);
  });

  it("role assertion errors fail immediately", async () => {
    const sleep = vi.fn(async () => {});
    await expect(
      waitForDatabase({} as postgres.Sql, {
        check: async () => {
          throw new Error("Runtime role must not bypass RLS");
        },
        sleep,
      }),
    ).rejects.toThrow("Runtime role must not bypass RLS");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("tenant statement timeout comes from DB_STATEMENT_TIMEOUT_MS within 1-60 s", () => {
    expect(statementTimeoutMs(undefined)).toBe("10000");
    expect(statementTimeoutMs("15000")).toBe("15000");
    expect(statementTimeoutMs("0")).toBe("10000");
    expect(statementTimeoutMs("600000")).toBe("10000");
    expect(statementTimeoutMs("abc")).toBe("10000");
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
