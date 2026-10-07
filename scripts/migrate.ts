// Migration runner (DB-6). Compiled to build/scripts/migrate.js and run as the
// non-superuser gm_migrator on the direct endpoint by the GitHub Actions deploy
// job (`--grants --retention`, before any service deploys) and by the daily
// retention workflow (`--retention-only`). No Railway service holds this
// credential (both runtime processes refuse it).
//
//   node build/scripts/migrate.js [--grants] [--retention] [--grants-only] [--retention-only] [--check] [--dry-run]
//     default       apply pending migrations, then reconcile backup policies
//     --grants      also apply the runtime grants manifest (the deploy job
//                   always passes this: migrate, then grants). When
//                   migrations are pending the grants commit in the newest
//                   migration's transaction, before its registry row.
//     --retention   then run the retention pass (oauth attempts, done/dead
//                   jobs; blanks the diner name and note of public ordering
//                   holds older than 30 days); a failure alerts
//                   retention_failed, never fails
//     --grants-only only apply grants and reconcile policies
//     --retention-only
//                   only run retention (up to 10 passes inside
//                   RETENTION_WINDOW while a backlog remains): no migrations,
//                   grants or reconcile; exits 1 when a table fails (it has
//                   alerted), 75 when a table was skipped on a lock timeout.
//                   `npm run ops:retention` and .github/workflows/retention.yml
//                   run this mode.
//     --check       exit 3 if migrations are pending; performs no writes
//     --dry-run     print pending migration names; performs no writes
import "dotenv/config";
import postgres from "postgres";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { databaseTls, withoutParams } from "../server/db-support.js";
import { log } from "../server/logging.js";
import type { AppEnv } from "../server/config-rules.js";
import { retentionPass, retentionPasses } from "../server/ops/retention.js";
import {
  alertTargetFromEnv,
  configureAlerts,
  sendAlert,
} from "../server/ops/alerts.js";
import {
  applyGrants,
  applyGrantsTx,
  applyMigrations,
  assertMigrationRole,
  MigrationError,
  pendingMigrations,
  readMigrations,
  reconcilePolicies,
  ROLE_NAME,
} from "../server/ops/schema.js";

const FLAGS = [
  "--grants",
  "--retention",
  "--grants-only",
  "--retention-only",
  "--check",
  "--dry-run",
] as const;
type Flag = (typeof FLAGS)[number];

/** --retention-only exit code when a table was skipped on a lock timeout (EX_TEMPFAIL); the workflow retries it. */
export const RETENTION_SKIPPED_EXIT = 75;

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
  const modes = [
    "--grants-only",
    "--retention-only",
    "--check",
    "--dry-run",
  ].filter((f) => flags.has(f as Flag));
  if (modes.length > 1) throw new UsageError("conflicting_flags");
  // --retention-only applies no grants and already runs retention.
  if (
    flags.has("--retention-only") &&
    (flags.has("--grants") || flags.has("--retention"))
  )
    throw new UsageError("conflicting_flags");
  return flags;
}

/**
 * Returns the exit code: 0 ok, 1 failure, 2 usage, 3 not ready (--check),
 * 75 retention skipped (--retention-only).
 */
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
  const needsRole = flags.has("--grants") || flags.has("--grants-only");
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
      log.info(
        flags.has("--dry-run") ? "migrations_pending" : "migrate_check",
        {
          pending,
        },
      );
      return flags.has("--check") && pending.length ? 3 : 0;
    }
    await assertMigrationRole(sql, appEnv);
    if (flags.has("--retention-only")) {
      // The daily retention workflow and an operator purge (npm run
      // ops:retention): never migrates, grants or reconciles the target.
      // Unlike the deploy's --retention, a failed table fails the run
      // (retentionPass has already alerted), and a lock-timeout skip exits 75
      // so the workflow retries it (P-9).
      configureAlerts(alertTargetFromEnv(env), appEnv);
      const result = await retentionPasses(sql, sendAlert);
      log.info("retention_only_complete", {
        ok: Boolean(result && !result.failed.length),
        deleted: result?.deleted ?? {},
        redacted: result?.redacted ?? {},
        backlog: result?.backlog ?? [],
        skipped: result?.skipped ?? [],
      });
      if (!result || result.failed.length) return 1; // retentionPass has already alerted retention_failed
      return result.skipped.length ? RETENTION_SKIPPED_EXIT : 0;
    }
    const database = decodeURIComponent(target.pathname.slice(1));
    let granted: string | null = null;
    if (!flags.has("--grants-only")) {
      // With --grants, the newest migration and the grants commit together:
      // readiness (newest migration recorded) never passes before the new
      // tables are granted to the runtime role (OPS-R11).
      const applied = await applyMigrations(sql, files, {
        beforeLastRecord: flags.has("--grants")
          ? async (tx) => {
              granted = (await applyGrantsTx(tx, { role, database })).hash;
            }
          : undefined,
      });
      log.info("migrations_complete", {
        applied: applied.length,
        granted: granted !== null,
      });
      if (granted)
        log.info("grants_applied", {
          role,
          hash: granted,
          withMigration: applied.at(-1),
        });
    }
    if (!granted && (flags.has("--grants") || flags.has("--grants-only"))) {
      const { hash } = await applyGrants(sql, { role, database });
      log.info("grants_applied", { role, hash });
    }
    await reconcilePolicies(sql);
    if (flags.has("--retention")) {
      // Retention never fails a deploy; a failure alerts (retention_failed)
      // and the daily retention workflow (.github/workflows/retention.yml)
      // retries it. Each batch is bounded by the retention lock
      // and statement timeouts, so a deploy during service stalls order and
      // payment inserts for at most about 1.7 s per batch (OPS-R10).
      configureAlerts(alertTargetFromEnv(env), appEnv);
      await retentionPass(sql, sendAlert);
    }
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
