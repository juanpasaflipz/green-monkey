import type postgres from "postgres";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DomainError } from "../shared/domain.js";
import { log } from "./log.js";

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

/** sha256 hex of the grants manifest bytes (the image copies scripts/grants.sql). */
export function grantsManifestHash(path = resolve("scripts/grants.sql")) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The grants manifest hash the runtime role must have recorded. */
export const requiredGrantsHash = grantsManifestHash();

/**
 * Fails closed with 503 schema_not_ready unless the bundled schema is applied
 * and, for the web process, the bundled grants manifest is recorded for the
 * current role, so a deploy that adds a table cannot go healthy before CD has
 * granted it (DB-6). PostgreSQL resolves relations at parse time, so the
 * registry's existence is checked first: databases older than 022 have no
 * registry and skip the grants check; once 022 is bundled the newest-migration
 * rule guarantees the registry exists.
 */
export async function requireReadySchema(
  sql: postgres.Sql,
  o: { grants?: boolean } = {},
) {
  try {
    const [state] = await sql`
      select exists(select 1 from schema_migrations where name=${requiredSchemaMigration}) as schema,
             to_regclass('public.schema_grants') is not null as has_registry`;
    if (!state?.schema) throw new DomainError("schema_not_ready", 503);
    if (!o.grants || !state.has_registry) return;
    const [grants] = await sql`
      select exists(select 1 from schema_grants where manifest_hash=${requiredGrantsHash} and role_name=current_user) as grants`;
    if (!grants?.grants) {
      log.warn("grants_not_applied", {
        expectedHashPrefix: requiredGrantsHash.slice(0, 12),
      });
      throw new DomainError("schema_not_ready", 503);
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("schema_not_ready", 503);
  }
}
