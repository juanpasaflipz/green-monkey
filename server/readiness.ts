import type postgres from "postgres";
import { DomainError } from "../shared/domain.js";

export const requiredSchemaMigration = "020_offline_recovery_retention.sql";

export async function requireReadySchema(sql: postgres.Sql) {
  const rows =
    await sql`select name from schema_migrations where name=${requiredSchemaMigration}`;
  if (!rows.length) throw new DomainError("schema_not_ready", 503);
}
