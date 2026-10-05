import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import {
  databaseIdentity,
  databaseTls,
  poolOptions,
  withoutParams,
} from "../server/db-support.js";
import { tenant } from "../server/db.js";

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
});
