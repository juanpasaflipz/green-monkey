/**
 * Cluster roles that grant more than the runtime tenant scope (scripts/ops/sql/globals.sql)
 * and the schema owner. One list for every login check: checkRole and checkWorkerRole
 * (server/db.ts) and the migrator's assertRuntimeRole (server/ops/schema.ts). Pure: no
 * imports, so the web, the worker and the scripts share it.
 *
 * A member of gm_backup_reader matches ops_backup_read (USING (true) on every RLS table,
 * scripts/db/post-migrate.sql), a cross-tenant read; a member of gm_migrator could disable
 * row-level security (P-3).
 */
export const CAPABILITY_ROLES = [
  "gm_billing_worker",
  "gm_jobs_worker",
  "gm_support",
  "gm_backup_reader",
  "gm_migrator",
] as const;
export type CapabilityRole = (typeof CAPABILITY_ROLES)[number];
/**
 * Memberships a runtime or worker login must not hold (the worker's own capability
 * excepted). pg_database_owner's implicit member owns schema public and can drop any
 * table in it (PLATFORM-ROLES-2).
 */
export const PRIVILEGED_MEMBERSHIPS: readonly string[] = [
  ...CAPABILITY_ROLES,
  "neon_superuser",
  "pg_database_owner",
];
