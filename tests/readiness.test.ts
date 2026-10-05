import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
  grantsManifestHash,
  latestBundledMigration,
  requiredGrantsHash,
  requiredSchemaMigration,
  requireReadySchema,
} from "../server/readiness.js";
import { setLogSink } from "../server/log.js";

beforeAll(() => setLogSink(() => {}));
afterAll(() => setLogSink(null));

/**
 * Fake sql tag: the first statement reports the schema row and the registry,
 * the second (only when asked) whether the grants hash is recorded.
 */
function database(state: {
  schema: boolean;
  registry?: boolean;
  grants?: boolean;
  fail?: unknown;
}) {
  return vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (state.fail) throw state.fail;
    const text = strings.join("?");
    if (text.includes("from schema_grants")) {
      expect(values).toContain(requiredGrantsHash);
      return [{ grants: state.grants ?? false }];
    }
    expect(values).toContain(requiredSchemaMigration);
    return [{ schema: state.schema, has_registry: state.registry ?? false }];
  }) as unknown as postgres.Sql & ReturnType<typeof vi.fn>;
}

describe("application readiness", () => {
  it("requires the latest schema used by the runtime", async () => {
    const sql = database({ schema: true });

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
    await expect(
      requireReadySchema(database({ schema: false })),
    ).rejects.toMatchObject({
      code: "schema_not_ready",
      status: 503,
    });
  });

  it("requires the bundled grants hash for the runtime role", async () => {
    expect(requiredGrantsHash).toBe(
      createHash("sha256")
        .update(readFileSync("scripts/grants.sql"))
        .digest("hex"),
    );
    expect(grantsManifestHash()).toBe(requiredGrantsHash);
    const recorded = database({ schema: true, registry: true, grants: true });
    await expect(
      requireReadySchema(recorded, { grants: true }),
    ).resolves.toBeUndefined();
    expect(recorded).toHaveBeenCalledTimes(2);
    await expect(
      requireReadySchema(
        database({ schema: true, registry: true, grants: false }),
        { grants: true },
      ),
    ).rejects.toMatchObject({ code: "schema_not_ready", status: 503 });
  });

  it("worker readiness skips grants", async () => {
    const sql = database({ schema: true, registry: true, grants: false });
    await expect(
      requireReadySchema(sql, { grants: false }),
    ).resolves.toBeUndefined();
    expect(sql).toHaveBeenCalledOnce();
  });

  it("databases without the grants registry skip the grants check", async () => {
    const sql = database({ schema: true, registry: false });
    await expect(
      requireReadySchema(sql, { grants: true }),
    ).resolves.toBeUndefined();
    expect(sql).toHaveBeenCalledOnce();
  });

  it("missing schema_grants table or any query error → schema_not_ready", async () => {
    await expect(
      requireReadySchema(
        database({
          schema: true,
          fail: Object.assign(
            new Error('relation "schema_grants" does not exist'),
            { code: "42P01" },
          ),
        }),
        { grants: true },
      ),
    ).rejects.toMatchObject({ code: "schema_not_ready", status: 503 });
  });
});
