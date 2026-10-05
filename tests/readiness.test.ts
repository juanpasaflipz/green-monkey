import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { readdirSync } from "node:fs";
import {
  latestBundledMigration,
  requiredSchemaMigration,
  requireReadySchema,
} from "../server/readiness.js";

function database(result: { name: string }[]) {
  return vi.fn(async () => result) as unknown as postgres.Sql;
}

describe("application readiness", () => {
  it("requires the latest schema used by the runtime", async () => {
    const sql = database([{ name: requiredSchemaMigration }]);

    await expect(requireReadySchema(sql)).resolves.toBeUndefined();
    expect(sql).toHaveBeenCalledOnce();
  });

  it("requires the newest bundled migration file", () => {
    const files = readdirSync("migrations")
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(requiredSchemaMigration).toBe(files.at(-1));
    expect(latestBundledMigration()).toBe(files.at(-1));
  });

  it("fails closed when the required migration is absent", async () => {
    await expect(requireReadySchema(database([]))).rejects.toMatchObject({
      code: "schema_not_ready",
      status: 503,
    });
  });
});
