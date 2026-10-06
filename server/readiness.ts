import type postgres from "postgres";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DomainError } from "../shared/domain.js";

/**
 * The newest migration bundled with this revision. The image copies
 * migrations/ next to the build, so an older revision keeps requiring its own
 * newest file and stays healthy after a later expand-only migration applies.
 */
export function latestBundledMigration(dir = resolve("migrations")) {
  const latest = readdirSync(dir)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort()
    .at(-1);
  if (!latest) throw Error(`No migrations bundled in ${dir}`);
  return latest;
}

export const requiredSchemaMigration = latestBundledMigration();

export async function requireReadySchema(sql: postgres.Sql) {
  const rows =
    await sql`select name from schema_migrations where name=${requiredSchemaMigration}`;
  if (!rows.length) throw new DomainError("schema_not_ready", 503);
}
