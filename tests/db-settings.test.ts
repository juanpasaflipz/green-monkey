import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import {
  databaseIdentity,
  databaseTls,
  poolOptions,
  withoutParams,
} from "../server/db-support.js";
import { connect, connectWorker, dbRetryCount, tenant } from "../server/db.js";
import { setLogSink } from "../server/logging.js";

describe("database connection policy", () => {
  it("connect() strips URL params and uses verify-full for non-loopback hosts, false for loopback (OPS-14 regression)", () => {
    const neon = new URL(
      "postgresql://gm_app:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey?sslmode=require&channel_binding=require",
    );
    expect(databaseTls(neon)).toBe("verify-full");
    expect(withoutParams(neon).href).toBe(
      "postgresql://gm_app:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey",
    );
    for (const local of [
      "postgresql://u:p@127.0.0.1:55439/db",
      "postgresql://u:p@localhost/db",
      "postgresql://u:p@[::1]/db",
    ])
      expect(databaseTls(new URL(local)), local).toBe(false);
    const options = poolOptions(neon, { applicationName: "gm-web" });
    expect(options).toMatchObject({
      ssl: "verify-full",
      connect_timeout: 5,
      connection: { application_name: "gm-web" },
    });
    // No startup statement_timeout: Neon's pooler drops it (OPS-7).
    expect(options.connection).not.toHaveProperty("statement_timeout");
    expect(databaseIdentity(neon)).toBe(
      "ep-x-pooler.us-east-1.aws.neon.tech:5432/green_monkey",
    );
  });

  it("connectWorker drops URL parameters, verifies TLS off-host, and does not apply the PG_APP_USER check", async () => {
    const saved = process.env.PG_APP_USER;
    process.env.PG_APP_USER = "gm_staging_app";
    const url =
      "postgresql://gm_staging_worker:pw@ep-x-pooler.us-east-1.aws.neon.tech/green_monkey?sslmode=require&channel_binding=require&options=-c%20role%3Dgm_migrator";
    try {
      // The runtime pool refuses a login other than PG_APP_USER ...
      expect(() => connect(url)).toThrow(/PG_APP_USER must match/);
      // ... the jobs worker pool is a different login by design.
      const worker = connectWorker(url);
      try {
        const o = worker.options as unknown as {
          host: string[];
          user: string;
          database: string;
          ssl: unknown;
          connection: Record<string, unknown>;
        };
        expect(o.host).toEqual(["ep-x-pooler.us-east-1.aws.neon.tech"]);
        expect(o.user).toBe("gm_staging_worker");
        expect(o.database).toBe("green_monkey");
        expect(o.ssl).toBe("verify-full");
        // No startup parameter survives from the URL (OPS-14).
        expect(o.connection).toEqual({ application_name: "gm-worker-jobs" });
      } finally {
        await worker.end();
      }
      const local = connectWorker(
        "postgresql://gm_worker:local-only-worker@127.0.0.1:55439/green_monkey_dev?sslmode=require",
      );
      expect(local.options.ssl).toBe(false);
      await local.end();
    } finally {
      if (saved === undefined) delete process.env.PG_APP_USER;
      else process.env.PG_APP_USER = saved;
    }
  });

  it("pool size comes from DB_POOL_MAX with a default of 20", () => {
    const url = new URL("postgresql://u:p@127.0.0.1/db");
    const saved = process.env.DB_POOL_MAX;
    try {
      delete process.env.DB_POOL_MAX;
      expect(poolOptions(url, { applicationName: "x" }).max).toBe(20);
      process.env.DB_POOL_MAX = "8";
      expect(poolOptions(url, { applicationName: "x" }).max).toBe(8);
      process.env.DB_POOL_MAX = "nonsense";
      expect(poolOptions(url, { applicationName: "x" }).max).toBe(20);
      expect(poolOptions(url, { applicationName: "x", max: 4 }).max).toBe(4);
    } finally {
      if (saved === undefined) delete process.env.DB_POOL_MAX;
      else process.env.DB_POOL_MAX = saved;
    }
  });

  it("tenant() sets the tenant and statement_timeout in one statement (contract 3.11)", async () => {
    const queries: { text: string; values: unknown[] }[] = [];
    const tx = vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push({ text: strings.join("$"), values });
        return [];
      },
    );
    const sql = {
      begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as postgres.Sql;
    await tenant(sql, "10000000-0000-4000-8000-000000000001", async () => "x");
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain("set_config('app.tenant_id'");
    expect(queries[0].text).toContain("set_config('statement_timeout'");
    expect(queries[0].values).toEqual([
      "10000000-0000-4000-8000-000000000001",
      "10000",
    ]);
    await expect(tenant(sql, "", async () => "x")).rejects.toMatchObject({
      code: "missing_tenant",
    });
  });

  it("tenant() logs db_retry and counts every deadlock or serialization failure it catches; other errors are neither (PLATFORM-LOCKS-3)", async () => {
    const lines: Record<string, unknown>[] = [];
    setLogSink((line) => lines.push(JSON.parse(line)));
    try {
      const failing = (codes: string[]) => {
        let n = 0;
        return {
          begin: async () => {
            const code = codes[n++];
            if (code) throw Object.assign(new Error(code), { code });
            return "ok";
          },
        } as unknown as postgres.Sql;
      };
      const t = "10000000-0000-4000-8000-000000000001";
      const before = dbRetryCount();
      expect(await tenant(failing(["40P01"]), t, async () => "x")).toBe("ok");
      expect(dbRetryCount() - before).toBe(1);
      await expect(
        tenant(failing(["40001", "40P01"]), t, async () => "x"),
      ).rejects.toMatchObject({ code: "concurrent_update", status: 409 });
      expect(dbRetryCount() - before).toBe(3);
      await expect(
        tenant(failing(["57014"]), t, async () => "x"),
      ).rejects.toMatchObject({ code: "57014" });
      expect(dbRetryCount() - before, "a timeout is not a retry").toBe(3);
      expect(
        lines
          .filter((l) => l.message === "db_retry")
          .map((l) => [l.level, l.code, l.attempt, l.retried]),
      ).toEqual([
        ["warn", "40P01", 1, true],
        ["warn", "40001", 1, true],
        ["warn", "40P01", 2, false],
      ]);
    } finally {
      setLogSink(null);
    }
  });
});
