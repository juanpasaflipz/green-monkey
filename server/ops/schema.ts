/**
 * Migration and grants library (DB-6). Used by scripts/migrate.ts and the
 * provisioning scripts only; the web entry never imports it (import-graph test).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type postgres from "postgres";
import type { AppEnv } from "../config-rules.js";
import type { Tx } from "../db.js";
import { log } from "../logging.js";

export interface MigrationFile {
  name: string;
  number: number;
  body: string;
  hash: string;
  transactional: boolean;
}

/** One key serialises every runner, transactional or not. */
export const MIGRATION_LOCK = 7102481;
export const STATEMENT_BREAK = "-- gm:statement-break";
const NAME = /^\d{3}_[a-z0-9_]+\.sql$/;
const CAPABILITY_ROLES = [
  "gm_billing_worker",
  "gm_jobs_worker",
  "gm_maintenance",
  "gm_backup_reader",
  "gm_migrator",
];

export class MigrationError extends Error {
  constructor(
    public code: string,
    public detail: { file?: string; pgCode?: string; role?: string } = {},
  ) {
    super(code + (detail.file ? `: ${detail.file}` : ""));
    this.name = "MigrationError";
  }
}

export const sha256 = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");

/** True when the leading comment block carries `-- gm:no-transaction`. */
export function isNoTransaction(body: string) {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("--")) return false;
    if (line === "-- gm:no-transaction") return true;
  }
  return false;
}

export function readMigrations(dir = resolve("migrations")): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const seen = new Map<number, string>();
  return names.map((name) => {
    if (!NAME.test(name))
      throw new MigrationError("migration_name_invalid", { file: name });
    const number = Number(name.slice(0, 3));
    if (seen.has(number))
      throw new MigrationError("migration_number_duplicate", { file: name });
    seen.set(number, name);
    const body = readFileSync(resolve(dir, name), "utf8");
    return {
      name,
      number,
      body,
      hash: sha256(body),
      transactional: !isNoTransaction(body),
    };
  });
}

/** Splits a no-transaction file on lines that are exactly `-- gm:statement-break`. */
export function splitStatements(body: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === STATEMENT_BREAK) {
      parts.push(current.join("\n"));
      current = [];
    } else current.push(line);
  }
  parts.push(current.join("\n"));
  return parts.filter((part) =>
    part
      .split("\n")
      .some((line) => line.trim() !== "" && !line.trim().startsWith("--")),
  );
}

async function appliedMigrations(sql: postgres.Sql) {
  const [registry] =
    await sql`select to_regclass('public.schema_migrations') is not null as present`;
  if (!registry.present) return new Map<string, string>();
  const rows = await sql<{ name: string; hash: string }[]>`
    select name, hash from schema_migrations`;
  return new Map(rows.map((r) => [r.name, r.hash]));
}

/** Pending files in order. Throws when an applied file's bytes changed. */
export async function pendingMigrations(
  sql: postgres.Sql,
  files: MigrationFile[],
): Promise<MigrationFile[]> {
  const applied = await appliedMigrations(sql);
  for (const file of files) {
    const prior = applied.get(file.name);
    if (prior !== undefined && prior !== file.hash)
      throw new MigrationError("migration_checksum_changed", {
        file: file.name,
      });
  }
  return files.filter((file) => !applied.has(file.name));
}

const pgCode = (e: unknown) =>
  typeof (e as { code?: unknown })?.code === "string"
    ? ((e as { code: string }).code as string)
    : undefined;

async function ensureRegistry(sql: postgres.Sql, lockTimeout: string) {
  await sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('lock_timeout',${lockTimeout},true)`;
    await tx`create table if not exists schema_migrations(name text primary key, hash text not null, applied_at timestamptz not null default now())`;
  });
}

/** Runs in the newest migration's transaction, before its registry row. */
export type BeforeRecord = (tx: Tx) => Promise<unknown>;

async function applyTransactional(
  sql: postgres.Sql,
  file: MigrationFile,
  lockTimeout: string,
  statementTimeout: string,
  beforeRecord?: BeforeRecord,
) {
  return sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('lock_timeout',${lockTimeout},true), set_config('statement_timeout',${statementTimeout},true)`;
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    const [prior] =
      await tx`select hash from schema_migrations where name=${file.name}`;
    if (prior) {
      if (prior.hash !== file.hash)
        throw new MigrationError("migration_checksum_changed", {
          file: file.name,
        });
      return false;
    }
    await tx.unsafe(file.body);
    if (beforeRecord) await beforeRecord(tx);
    await tx`insert into schema_migrations(name,hash) values(${file.name},${file.hash})`;
    return true;
  }) as Promise<boolean>;
}

async function applyNonTransactional(
  sql: postgres.Sql,
  file: MigrationFile,
  lockTimeout: string,
  statementTimeout: string,
  beforeRecord?: BeforeRecord,
) {
  const reserved = await sql.reserve();
  let locked = false;
  try {
    const [lock] =
      await reserved`select pg_try_advisory_lock(${MIGRATION_LOCK}) as ok`;
    if (!lock.ok) {
      // Another runner holds the lock; surface it as a lock timeout so the
      // caller's backoff applies.
      throw Object.assign(new Error("migration_lock_busy"), { code: "55P03" });
    }
    locked = true;
    await reserved`select set_config('lock_timeout',${lockTimeout},false), set_config('statement_timeout',${statementTimeout},false)`;
    const [prior] =
      await reserved`select hash from schema_migrations where name=${file.name}`;
    if (prior) {
      if (prior.hash !== file.hash)
        throw new MigrationError("migration_checksum_changed", {
          file: file.name,
        });
      return false;
    }
    // Each statement must be idempotent (DROP INDEX CONCURRENTLY IF EXISTS
    // before CREATE INDEX CONCURRENTLY) because a failure leaves earlier ones.
    for (const statement of splitStatements(file.body))
      await reserved.unsafe(statement);
    if (beforeRecord)
      await reserved.begin((raw) => beforeRecord(raw as unknown as Tx));
    await reserved`insert into schema_migrations(name,hash) values(${file.name},${file.hash})`;
    return true;
  } finally {
    try {
      await reserved`reset lock_timeout`;
      await reserved`reset statement_timeout`;
      if (locked) await reserved`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    } finally {
      reserved.release();
    }
  }
}

/**
 * Applies each pending file in its own transaction (or, for
 * `-- gm:no-transaction` files, statement by statement on one reserved
 * connection). Lock timeouts retry with 2/4/8/16 s backoff; anything else
 * aborts the run with migration_failed.
 *
 * `beforeLastRecord` runs for the newest pending file just before its
 * registry row is written: in the same transaction for a transactional
 * file, in its own transaction for a no-transaction file. Readiness keys on
 * that row, so the runner passes the grants manifest here and a new
 * revision never passes /api/health before its tables are granted (OPS-R11).
 * A failure rolls the newest migration back with it.
 */
export async function applyMigrations(
  sql: postgres.Sql,
  files: MigrationFile[],
  o: {
    lockTimeout?: string;
    statementTimeout?: string;
    retries?: number;
    sleep?: (ms: number) => Promise<void>;
    beforeLastRecord?: BeforeRecord;
  } = {},
): Promise<string[]> {
  const lockTimeout = o.lockTimeout ?? "5s";
  const statementTimeout = o.statementTimeout ?? "10min";
  const retries = o.retries ?? 4;
  const sleep = o.sleep ?? ((ms: number) => delay(ms));
  await ensureRegistry(sql, lockTimeout);
  const applied: string[] = [];
  const pending = await pendingMigrations(sql, files);
  const highest = Math.max(
    0,
    ...files.filter((f) => !pending.includes(f)).map((f) => f.number),
  );
  for (const file of pending) {
    if (file.number < highest)
      log.warn("migration_out_of_order", { file: file.name, highest });
    const hook = file === pending.at(-1) ? o.beforeLastRecord : undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const ran = file.transactional
          ? await applyTransactional(
              sql,
              file,
              lockTimeout,
              statementTimeout,
              hook,
            )
          : await applyNonTransactional(
              sql,
              file,
              lockTimeout,
              statementTimeout,
              hook,
            );
        if (ran) {
          applied.push(file.name);
          log.info("migration_applied", {
            file: file.name,
            transactional: file.transactional,
          });
        }
        break;
      } catch (error) {
        if (error instanceof MigrationError) throw error;
        const code = pgCode(error);
        if (code === "55P03" && attempt < retries) {
          const waitMs = 2000 * 2 ** attempt;
          log.warn("migration_lock_retry", {
            file: file.name,
            attempt: attempt + 1,
            waitMs,
          });
          await sleep(waitMs);
          continue;
        }
        log.error("migration_failed", { file: file.name, pgCode: code }, error);
        throw new MigrationError("migration_failed", {
          file: file.name,
          pgCode: code,
        });
      }
    }
  }
  return applied;
}

export function quoteIdent(value: string) {
  return '"' + value.replaceAll('"', '""') + '"';
}

export const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/i;

/** Rejects a runtime role that could bypass row-level security or own the schema. */
export async function assertRuntimeRole(tx: Tx, role: string) {
  const [r] = await tx`
    select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
      (select count(*)::int from pg_tables where schemaname='public' and tableowner=${role}) as owned,
      (select coalesce(array_agg(c), '{}') from unnest(${CAPABILITY_ROLES}::text[]) c
        where to_regrole(c) is not null and pg_has_role(${role}::name, to_regrole(c), 'member')) as capabilities
    from pg_roles where rolname=${role}`;
  if (!r) throw new MigrationError("runtime_role_missing", { role });
  if (r.rolsuper || r.rolbypassrls || r.rolcreatedb || r.rolcreaterole)
    throw new MigrationError("runtime_role_privileged", { role });
  if (r.owned) throw new MigrationError("runtime_role_owns_tables", { role });
  if (r.capabilities.length)
    throw new MigrationError("runtime_role_privileged", { role });
}

export interface GrantsTarget {
  role: string;
  database: string;
  manifestPath?: string;
}

/**
 * Applies the reviewed runtime grants manifest to one role inside the
 * caller's transaction (the runner's last migration, a credential rotation).
 * Runs as the connected user, which must own the tables or be a member of
 * their owner (gm_migrator).
 */
export async function applyGrantsTx(
  tx: Tx,
  o: GrantsTarget,
): Promise<{ hash: string }> {
  if (!ROLE_NAME.test(o.role))
    throw new MigrationError("runtime_role_invalid", { role: o.role });
  const path = o.manifestPath ?? resolve("scripts/grants.sql");
  const bytes = readFileSync(path);
  const hash = sha256(bytes);
  // Static reviewed manifest; only quoted identifiers are substituted.
  const manifest = bytes
    .toString("utf8")
    .replaceAll(/\bgm_app\b/g, quoteIdent(o.role))
    .replaceAll(/\bgreen_monkey_dev\b/g, quoteIdent(o.database));
  await assertRuntimeRole(tx, o.role);
  await tx.unsafe(manifest);
  const [schema] = await tx`
    select n.nspowner = (select oid from pg_roles where rolname=current_user)
        or pg_has_role(current_user, n.nspowner, 'member') as can_revoke
    from pg_namespace n where n.nspname='public'`;
  if (schema?.can_revoke) await tx`revoke create on schema public from public`;
  else
    log.info("grants_schema_revoke_skipped", {
      reason: "public schema CREATE is revoked by provisioning",
    });
  return { hash };
}

/**
 * Applies the reviewed runtime grants manifest to one role in its own
 * transaction. The runner also applies it inside the newest migration's
 * transaction (applyMigrations `beforeLastRecord`), so a revision whose
 * migration readiness can see always has its grants (DB-6).
 */
export async function applyGrants(
  sql: postgres.Sql,
  o: GrantsTarget,
): Promise<{ hash: string }> {
  const result = (await sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('lock_timeout','5s',true)`;
    return applyGrantsTx(tx, o);
  })) as { hash: string };
  log.info("grants_applied", {
    role: o.role,
    hashPrefix: result.hash.slice(0, 12),
  });
  return result;
}

/** Runs the reviewed reconciler (backup-reader policies on every RLS table). */
export async function reconcilePolicies(
  sql: postgres.Sql,
  path = resolve("scripts/db/post-migrate.sql"),
) {
  const body = readFileSync(path, "utf8");
  await sql.begin(async (raw) => {
    const tx = raw as Tx;
    await tx`select set_config('lock_timeout','5s',true)`;
    await tx.unsafe(body);
  });
  log.info("policies_reconciled", {});
}

/**
 * In staging and production the migration login must not be a superuser,
 * bypass RLS, create roles, or belong to neon_superuser (DB-1).
 */
export async function assertMigrationRole(sql: postgres.Sql, appEnv: AppEnv) {
  if (appEnv !== "staging" && appEnv !== "production") return;
  const [r] = await sql`
    select rolsuper, rolbypassrls, rolcreaterole,
      coalesce(pg_has_role(current_user, to_regrole('neon_superuser'), 'member'), false) as neon_superuser
    from pg_roles where rolname = current_user`;
  if (!r || r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.neon_superuser)
    throw new MigrationError("migration_role_privileged");
}
