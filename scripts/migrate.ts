// Migration runner (DB-6). Compiled to build/scripts/migrate.js and run by the
// CD deploy job as the non-superuser gm_migrator role.
//
//   node build/scripts/migrate.js [--grants] [--grants-only] [--check] [--dry-run]
//     default       apply pending migrations, then reconcile policies
//     --grants      also apply the runtime grants manifest (CD always passes this)
//     --grants-only only apply grants and reconcile policies
//     --check       exit 3 if migrations are pending or the grants hash is not
//                   recorded for the runtime role; performs no writes
//     --dry-run     print pending migration names; performs no writes
import "dotenv/config";
import postgres from "postgres";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { databaseTls, withoutParams } from "../server/db-tls.js";
import { log } from "../server/log.js";
import type { AppEnv } from "../server/config-rules.js";
import {
  applyGrants,
  applyMigrations,
  assertMigrationRole,
  grantsRecorded,
  manifestHash,
  MigrationError,
  pendingMigrations,
  readMigrations,
  reconcilePolicies,
  ROLE_NAME,
} from "../server/ops/schema.js";

const FLAGS = ["--grants", "--grants-only", "--check", "--dry-run"] as const;
type Flag = (typeof FLAGS)[number];

export class UsageError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** The runtime role grants apply to: PG_APP_USER, else DATABASE_URL's user. */
export function runtimeRole(env: NodeJS.ProcessEnv): string {
  const role =
    env.PG_APP_USER?.trim() ||
    (env.DATABASE_URL
      ? decodeURIComponent(new URL(env.DATABASE_URL).username)
      : "");
  if (!ROLE_NAME.test(role)) throw new UsageError("runtime_role_required");
  return role;
}

/** Validates MIGRATION_DATABASE_URL: present and a direct (non-pooled) endpoint. */
export function migrationTarget(env: NodeJS.ProcessEnv): URL {
  const raw = env.MIGRATION_DATABASE_URL;
  if (!raw) throw new UsageError("migration_database_url_required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError("migration_database_url_invalid");
  }
  // DDL, advisory locks and SET need a session; Neon's pooled host runs
  // PgBouncer in transaction mode.
  if (url.hostname.includes("-pooler"))
    throw new UsageError("migration_requires_direct_endpoint");
  return url;
}

export function parseFlags(args: string[]): Set<Flag> {
  const flags = new Set<Flag>();
  for (const arg of args) {
    if (!(FLAGS as readonly string[]).includes(arg))
      throw new UsageError("unknown_flag");
    flags.add(arg as Flag);
  }
  const modes = ["--grants-only", "--check", "--dry-run"].filter((f) =>
    flags.has(f as Flag),
  );
  if (modes.length > 1) throw new UsageError("conflicting_flags");
  return flags;
}

/** Returns the exit code: 0 ok, 1 failure, 2 usage, 3 not ready (--check). */
export async function main(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let flags: Set<Flag>, target: URL;
  try {
    flags = parseFlags(args);
    target = migrationTarget(env);
  } catch (error) {
    log.error("migrate_usage", {
      code: error instanceof UsageError ? error.code : "invalid_arguments",
    });
    return 2;
  }
  const needsRole =
    flags.has("--grants") || flags.has("--grants-only") || flags.has("--check");
  let role = "";
  if (needsRole)
    try {
      role = runtimeRole(env);
    } catch {
      log.error("migrate_usage", { code: "runtime_role_required" });
      return 2;
    }
  const appEnv = (env.APP_ENV?.trim() || "development") as AppEnv;
  const sql = postgres(withoutParams(target).href, {
    max: 1,
    ssl: databaseTls(target),
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "gm-migrate" },
    onnotice: (notice) =>
      log.info("postgres_notice", { notice: String(notice.message ?? "") }),
  });
  try {
    const files = readMigrations();
    if (flags.has("--dry-run") || flags.has("--check")) {
      const pending = (await pendingMigrations(sql, files)).map((f) => f.name);
      if (flags.has("--dry-run")) {
        log.info("migrations_pending", { pending });
        return 0;
      }
      const hash = manifestHash();
      const recorded = await grantsRecorded(sql, role, hash);
      log.info("migrate_check", {
        pending,
        role,
        grantsHashPrefix: hash.slice(0, 12),
        grantsRecorded: recorded,
      });
      return pending.length || !recorded ? 3 : 0;
    }
    await assertMigrationRole(sql, appEnv);
    const database = decodeURIComponent(target.pathname.slice(1));
    if (!flags.has("--grants-only")) {
      const applied = await applyMigrations(sql, files);
      log.info("migrations_complete", { applied: applied.length });
    }
    if (flags.has("--grants") || flags.has("--grants-only"))
      await applyGrants(sql, { role, database });
    await reconcilePolicies(sql);
    return 0;
  } catch (error) {
    if (error instanceof MigrationError)
      log.error("migrate_failed", { code: error.code, ...error.detail });
    else log.error("migrate_failed", {}, error);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function invokedDirectly() {
  try {
    return (
      Boolean(process.argv[1]) &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}
if (invokedDirectly()) process.exitCode = await main(process.argv.slice(2));
