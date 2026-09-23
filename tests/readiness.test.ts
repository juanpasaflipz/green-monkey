import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import {
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

  it("fails closed when the required migration is absent", async () => {
    await expect(requireReadySchema(database([]))).rejects.toMatchObject({
      code: "schema_not_ready",
      status: 503,
    });
  });
});
