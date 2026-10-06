// User-run provisioning of database roles for one environment (DB-1, OPS-7,
// OPS-8). Connects as the database owner (Neon: neondb_owner, direct
// endpoint) through PROVISION_DATABASE_URL and, in one transaction:
//   - creates the capability roles and gm_migrator (scripts/ops/sql/globals.sql)
//     and makes gm_migrator a LOGIN without superuser, BYPASSRLS or CREATEROLE;
//   - creates gm_<env>_app (runtime), gm_<env>_billing (member of
//     gm_billing_worker), gm_<env>_worker (member of gm_jobs_worker; the
//     worker's jobs login) and gm_<env>_backup (member of gm_backup_reader);
//   - sets per-role defaults with ALTER ROLE ... SET, which Neon's pooler
//     honours (statement/lock/idle timeouts);
//   - grants CONNECT to the logins, revokes it from PUBLIC, applies
//     scripts/ops/sql/database-grants.sql and moves every public object to
//     gm_migrator (scripts/ops/sql/transfer-ownership.sql);
//   - asserts that no login is privileged and only gm_migrator owns tables.
// The owner is never a superuser on Neon (LOGIN CREATEROLE CREATEDB
// BYPASSRLS), so ALTER ROLE names only attributes it may change, and the
// owner takes INHERIT and SET on gm_migrator explicitly (OPS-R9;
// tests/provision-db.ts "Neon parity").
// Passwords for new logins are generated here and written, before any role
// changes, to .env.provisioned-<env> (mode 0600); a re-run reuses them and
// appends any key the file lacks (a login added by a later release), never
// rewriting one. An existing login keeps its password (rotation is
// scripts/ops/rotate-db-login.ts) and its URL is written without one.
// MIGRATION_DATABASE_URL from the env file goes to the GitHub environment
// secret (gh secret set MIGRATION_DATABASE_URL --env <env> on stdin), never to
// Railway: the deploy job and the retention workflow migrate (DB-1).
//   PROVISION_DATABASE_URL=... tsx scripts/ops/provision-roles.ts --env staging [--dry-run]
// --dry-run runs everything and rolls back. Prints names and actions only.
import "dotenv/config";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "dotenv";
import type { Tx } from "../../server/db.js";
import { databaseTls, withoutParams } from "../../server/db-support.js";

export const roleDefaults: Record<string, Record<string, string>> = {
  migrator: { lock_timeout: "5s", statement_timeout: "10min" },
  app: {
    statement_timeout: "10s",
    lock_timeout: "8s",
    idle_in_transaction_session_timeout: "15s",
  },
  billing: {
    statement_timeout: "30s",
    lock_timeout: "8s",
    idle_in_transaction_session_timeout: "60s",
  },
  worker: {
    statement_timeout: "30s",
    lock_timeout: "8s",
    idle_in_transaction_session_timeout: "60s",
  },
  backup: { statement_timeout: "0", idle_in_transaction_session_timeout: "0" },
};

export interface ProvisionResult {
  env: string;
  database: string;
  roles: Record<string, string>;
  actions: string[];
  file: string | null;
  urls: Record<string, string>;
}

const ident = (v: string) => '"' + v.replaceAll('"', '""') + '"';
const literal = (v: string) => "'" + v.replaceAll("'", "''") + "'";

/**
 * Makes the current (owner) login inherit `role`'s privileges, and with
 * `set` also able to SET ROLE to it, granting the membership when missing.
 * On PostgreSQL 16+ a CREATEROLE login gets ADMIN, but neither INHERIT nor
 * SET, on the roles it creates; on 15 and older a plain GRANT inherits.
 * A superuser already passes both checks.
 */
export async function ensurePrivilegesOf(
  tx: Tx,
  role: string,
  o: { set?: boolean } = {},
) {
  const [{ version }] =
    await tx`select current_setting('server_version_num')::int as version`;
  const modern = version >= 160000;
  const [{ ok }] =
    modern && o.set
      ? await tx`select pg_has_role(current_user, ${role}, 'USAGE') and pg_has_role(current_user, ${role}, 'SET') as ok`
      : await tx`select pg_has_role(current_user, ${role}, 'USAGE') as ok`;
  if (ok) return false;
  await tx.unsafe(
    `grant ${ident(role)} to current_user` +
      (modern ? ` with inherit true${o.set ? ", set true" : ""}` : ""),
  );
  return true;
}

/** Neon pooled host: the endpoint id gains a -pooler suffix. */
export function pooledHost(hostname: string) {
  if (hostname.includes("-pooler")) return hostname;
  const [first, ...rest] = hostname.split(".");
  return /^ep-/.test(first) ? [first + "-pooler", ...rest].join(".") : hostname;
}

export async function provisionRoles(o: {
  ownerUrl: string;
  env: string;
  database?: string;
  dryRun?: boolean;
  file?: string | null;
}): Promise<ProvisionResult> {
  if (!/^[a-z][a-z0-9]{1,20}$/.test(o.env))
    throw Error("env must be lowercase letters/digits");
  const owner = new URL(o.ownerUrl);
  if (owner.hostname.includes("-pooler"))
    throw Error("provisioning needs the direct endpoint");
  if (o.database) owner.pathname = "/" + o.database;
  const database = decodeURIComponent(owner.pathname.slice(1));
  const roles = {
    migrator: "gm_migrator",
    app: `gm_${o.env}_app`,
    billing: `gm_${o.env}_billing`,
    worker: `gm_${o.env}_worker`,
    backup: `gm_${o.env}_backup`,
  };
  const file = o.file === undefined ? `.env.provisioned-${o.env}` : o.file;
  // Reuse saved credentials so a re-run never strands a password.
  const saved: Record<string, string> =
    file && existsSync(file) ? parse(readFileSync(file, "utf8")) : {};
  const savedPassword = (name: string, key: string) => {
    if (!saved[key]) return null;
    const url = new URL(saved[key]);
    if (decodeURIComponent(url.username) !== name)
      throw Error(`saved ${key} is for another role`);
    return decodeURIComponent(url.password);
  };
  // Existing logins keep their password unless it was saved by an earlier run.
  const probe = postgres(withoutParams(owner).href, {
    max: 1,
    ssl: databaseTls(owner),
    onnotice: () => {},
  });
  const existing = new Set(
    (
      await probe`select rolname from pg_roles where rolcanlogin and rolname = any(${Object.values(roles)})`.finally(
        () => probe.end({ timeout: 5 }),
      )
    ).map((r) => r.rolname as string),
  );
  const keys = {
    migrator: "MIGRATION_DATABASE_URL",
    app: "DATABASE_URL",
    billing: "BILLING_DATABASE_URL",
    worker: "WORKER_DATABASE_URL",
    backup: "BACKUP_DATABASE_URL",
  } as const;
  const passwords = Object.fromEntries(
    (Object.keys(roles) as (keyof typeof roles)[]).map((key) => [
      key,
      savedPassword(roles[key], keys[key]) ??
        (existing.has(roles[key]) ? null : randomBytes(32).toString("hex")),
    ]),
  ) as Record<keyof typeof roles, string | null>;
  const url = (role: string, password: string | null, pooled: boolean) => {
    const u = new URL(withoutParams(owner).href);
    u.username = role;
    u.password = password ?? "";
    if (pooled) u.hostname = pooledHost(u.hostname);
    if (databaseTls(u)) u.searchParams.set("sslmode", "verify-full");
    return u.href;
  };
  const urls = {
    MIGRATION_DATABASE_URL: url(roles.migrator, passwords.migrator, false),
    DATABASE_URL: url(roles.app, passwords.app, true),
    BILLING_DATABASE_URL: url(roles.billing, passwords.billing, true),
    WORKER_DATABASE_URL: url(roles.worker, passwords.worker, true),
    BACKUP_DATABASE_URL: url(roles.backup, passwords.backup, false),
    PG_APP_USER: roles.app,
  };
  const actions: string[] = [];
  if (file && !existsSync(file) && !o.dryRun)
    writeFileSync(
      file,
      `# Generated by scripts/ops/provision-roles.ts for ${o.env}; keep private.\n` +
        Object.entries(urls)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n") +
        "\n",
      { mode: 0o600, flag: "wx" },
    );
  else if (file && !o.dryRun) {
    // P-8: an environment provisioned by an earlier release gains the keys of
    // logins added since (WORKER_DATABASE_URL). Saved keys are never rewritten.
    const missing = Object.entries(urls).filter(([k]) => !(k in saved));
    if (missing.length) {
      const text = readFileSync(file, "utf8");
      appendFileSync(
        file,
        (text.endsWith("\n") || !text ? "" : "\n") +
          missing.map(([k, v]) => `${k}=${v}`).join("\n") +
          "\n",
      );
      actions.push(`env file: appended ${missing.map(([k]) => k).join(",")}`);
    }
    for (const [k] of missing) {
      const key = (Object.keys(keys) as (keyof typeof keys)[]).find(
        (name) => keys[name] === k,
      );
      if (key && !passwords[key])
        actions.push(
          `${roles[key]}: existing login without a saved password; rotate it (rotate-db-login.ts --kind ${key === "app" ? "runtime" : key})`,
        );
    }
  }

  const sql = postgres(withoutParams(owner).href, {
    max: 1,
    ssl: databaseTls(owner),
    onnotice: () => {},
  });
  const DRY = Symbol("dry-run");
  try {
    await sql
      .begin(async (raw) => {
        const tx = raw as Tx;
        await tx`select set_config('lock_timeout','5s',true)`;
        await tx.unsafe(readFileSync("scripts/ops/sql/globals.sql", "utf8"));
        actions.push("capability roles and gm_migrator ensured");
        const attributes = async (role: string) =>
          (
            await tx`
              select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
              from pg_roles where rolname=${role}`
          )[0];
        const login = async (key: keyof typeof roles, member?: string) => {
          const role = roles[key];
          let current = await attributes(role);
          if (!current) {
            await tx.unsafe(
              `create role ${ident(role)} nosuperuser nocreatedb nocreaterole nobypassrls`,
            );
            actions.push(`created ${role}`);
            current = await attributes(role);
          }
          // The owner on Neon (neondb_owner) has CREATEROLE but is not a
          // superuser, and PostgreSQL lets only a superuser name SUPERUSER or
          // NOSUPERUSER in ALTER ROLE (OPS-R9). Name only the attributes that
          // must change; the assertion below refuses any privileged login
          // that remains.
          const password = passwords[key];
          const clauses = [
            current.rolcanlogin ? "" : "login",
            current.rolsuper ? "nosuperuser" : "",
            current.rolcreatedb ? "nocreatedb" : "",
            current.rolcreaterole ? "nocreaterole" : "",
            current.rolbypassrls ? "nobypassrls" : "",
            password ? `password ${literal(password)}` : "",
          ].filter(Boolean);
          if (clauses.length)
            await tx.unsafe(`alter role ${ident(role)} ${clauses.join(" ")}`);
          if (!password) actions.push(`${role}: kept its existing password`);
          if (member) {
            await tx.unsafe(`grant ${ident(member)} to ${ident(role)}`);
            actions.push(`${role} is a member of ${member}`);
          }
          for (const [setting, value] of Object.entries(roleDefaults[key]))
            await tx.unsafe(
              `alter role ${ident(role)} in database ${ident(database)} set ${setting} = ${literal(value)}`,
            );
          await tx.unsafe(
            `grant connect on database ${ident(database)} to ${ident(role)}`,
          );
          actions.push(
            `${role}: login, defaults ${Object.keys(roleDefaults[key]).join("/")}, connect`,
          );
        };
        await login("migrator");
        await login("app");
        await login("billing", "gm_billing_worker");
        await login("worker", "gm_jobs_worker");
        await login("backup", "gm_backup_reader");
        await tx.unsafe(
          `revoke connect on database ${ident(database)} from public`,
        );
        await tx.unsafe(
          readFileSync("scripts/ops/sql/database-grants.sql", "utf8"),
        );
        actions.push(
          "database grants applied; PUBLIC loses CONNECT and CREATE",
        );
        // Moving ownership to gm_migrator needs SET ROLE on it (PG16+), and
        // rotate-db-login.ts grants on its tables through inherited
        // privileges. A non-superuser owner that created gm_migrator holds
        // only ADMIN on it (PG16 createrole_self_grant ''), which already
        // counts as 'member' (OPS-R9), so check SET and USAGE explicitly.
        await ensurePrivilegesOf(tx, "gm_migrator", { set: true });
        actions.push("owner can SET ROLE gm_migrator and inherits it");
        await tx.unsafe(
          readFileSync("scripts/ops/sql/transfer-ownership.sql", "utf8"),
        );
        actions.push("public objects owned by gm_migrator");
        const unsafe = await tx`
          select rolname from pg_roles
          where rolname = any(${Object.values(roles)})
            and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb
              or coalesce(pg_has_role(rolname, to_regrole('neon_superuser'), 'member'), false))`;
        if (unsafe.length)
          throw Error(
            `privileged login: ${unsafe.map((r) => r.rolname).join(",")}`,
          );
        const owners = await tx`
          select distinct tableowner from pg_tables where schemaname='public' and tableowner <> 'gm_migrator'`;
        if (owners.length) throw Error("ownership_transfer_incomplete");
        actions.push(
          "asserted: no privileged login; only gm_migrator owns tables",
        );
        if (o.dryRun) throw DRY;
      })
      .catch((error) => {
        if (error !== DRY) throw error;
        actions.push("dry run: rolled back");
      });
  } finally {
    await sql.end({ timeout: 5 });
  }
  return {
    env: o.env,
    database,
    roles,
    actions,
    file: o.dryRun ? null : file,
    urls,
  };
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

if (invokedDirectly()) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const ownerUrl = process.env.PROVISION_DATABASE_URL;
    if (!ownerUrl) throw Error("PROVISION_DATABASE_URL required");
    const result = await provisionRoles({
      ownerUrl,
      env: value("--env") ?? "",
      database: value("--database"),
      dryRun: args.includes("--dry-run"),
    });
    console.log(
      JSON.stringify({
        message: "roles_provisioned",
        ...result,
        urls: Object.keys(result.urls),
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        message: "provision_failed",
        error: String((error as Error).message).replace(
          /postgres(ql)?:\/\/[^@\s]+@/g,
          "postgresql://[redacted]@",
        ),
      }),
    );
    process.exitCode = 1;
  }
}
