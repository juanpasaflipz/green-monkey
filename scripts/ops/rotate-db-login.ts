// User-run, zero-downtime database login rotation (OPS-9). Connects as the
// database owner through PROVISION_DATABASE_URL.
//
//   rotate:   tsx scripts/ops/rotate-db-login.ts --env staging --kind runtime|billing|worker|backup [--old <name>] [--new-name <name>]
//             Creates a new login with the old one's memberships and role
//             settings and a fresh password, writes its URL to
//             .env.rotated-<env>-<kind>-<new> (0600). A runtime login also
//             receives the runtime grants manifest (scripts/grants.sql) in
//             the same transaction, and the rotation aborts unless it holds
//             every table and column privilege of the old login, so it can
//             serve traffic before any deploy (OPS-R3). Point the services at
//             it (scripts/ops/railway-vars.sh), redeploy in any order, then:
//   finalize: tsx scripts/ops/rotate-db-login.ts --env staging --finalize --old <name>
//             Refuses while the old login has sessions, then drops it,
//             revoking as their grantor the database and schema grants that
//             DROP OWNED leaves (each deploy grants as gm_migrator, OPS-R14).
//   migrator: tsx scripts/ops/rotate-db-login.ts --env staging --kind migrator
//             Sets a new gm_migrator password and writes the new URL; update
//             the GitHub environment secret:
//             gh secret set MIGRATION_DATABASE_URL --env <env> < <file>
//             (stdin; never on the command line). No Railway service holds it.
// Prints role names and actions only, never passwords.
import "dotenv/config";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Tx } from "../../server/db.js";
import { databaseTls, withoutParams } from "../../server/db-support.js";
import { applyGrantsTx } from "../../server/ops/schema.js";
import { ensurePrivilegesOf, pooledHost } from "./provision-roles.js";

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const ident = (v: string) => '"' + v.replaceAll('"', '""') + '"';
const literal = (v: string) => "'" + v.replaceAll("'", "''") + "'";
export type LoginKind =
  "runtime" | "billing" | "backup" | "worker" | "migrator";
const suffix: Record<Exclude<LoginKind, "migrator">, string> = {
  runtime: "app",
  billing: "billing",
  backup: "backup",
  worker: "worker",
};

function connect(ownerUrl: string) {
  const u = new URL(ownerUrl);
  if (u.hostname.includes("-pooler"))
    throw Error("rotation needs the direct endpoint");
  return postgres(withoutParams(u).href, {
    max: 1,
    ssl: databaseTls(u),
    onnotice: () => {},
  });
}

function loginUrl(
  ownerUrl: string,
  role: string,
  password: string,
  pooled: boolean,
) {
  const u = new URL(withoutParams(ownerUrl).href);
  u.username = role;
  u.password = password;
  if (pooled) u.hostname = pooledHost(u.hostname);
  if (databaseTls(u)) u.searchParams.set("sslmode", "verify-full");
  return u.href;
}

/** Creates `newName` with the memberships and settings of `old`. */
export async function rotateLogin(o: {
  ownerUrl: string;
  env: string;
  kind: Exclude<LoginKind, "migrator">;
  old?: string;
  newName?: string;
  file?: string | null;
}) {
  const old = o.old ?? `gm_${o.env}_${suffix[o.kind]}`;
  const newName =
    o.newName ??
    `${old.replace(/_r\d{8}$/, "")}_r${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
  if (!ROLE.test(old) || !ROLE.test(newName) || old === newName)
    throw Error("invalid role names");
  if (old === "gm_migrator")
    throw Error("use --kind migrator for the migration owner");
  const password = randomBytes(32).toString("hex");
  const url = loginUrl(o.ownerUrl, newName, password, o.kind !== "backup");
  const file =
    o.file === undefined
      ? `.env.rotated-${o.env}-${o.kind}-${newName}`
      : o.file;
  // Save before creating the role so a lost response never strands a password.
  if (file)
    writeFileSync(
      file,
      `# ${o.kind} login ${newName} (replaces ${old})\nURL=${url}\n`,
      { mode: 0o600, flag: "wx" },
    );
  const sql = connect(o.ownerUrl);
  const actions: string[] = [];
  try {
    await sql.begin(async (raw) => {
      const tx = raw as Tx;
      const [source] = await tx`
        select oid, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname=${old}`;
      if (!source) throw Error(`old login ${old} not found`);
      if (
        source.rolsuper ||
        source.rolbypassrls ||
        source.rolcreaterole ||
        source.rolcreatedb
      )
        throw Error(`refusing to copy a privileged login (${old})`);
      const owned =
        await tx`select 1 from pg_tables where tableowner=${old} limit 1`;
      if (owned.length)
        throw Error(`${old} owns tables; it is not a runtime login`);
      await tx.unsafe(
        `create role ${ident(newName)} login password ${literal(password)} nosuperuser nocreatedb nocreaterole nobypassrls`,
      );
      actions.push(`created ${newName}`);
      const memberships = await tx`
        select b.rolname from pg_auth_members m
        join pg_roles b on b.oid = m.roleid where m.member = ${source.oid}`;
      for (const { rolname } of memberships) {
        await tx.unsafe(`grant ${ident(rolname)} to ${ident(newName)}`);
        actions.push(`${newName} is a member of ${rolname}`);
      }
      const settings = await tx`
        select d.datname, s.setconfig from pg_db_role_setting s
        left join pg_database d on d.oid = s.setdatabase where s.setrole = ${source.oid}`;
      for (const { datname, setconfig } of settings)
        for (const entry of setconfig as string[]) {
          const [name, ...rest] = entry.split("=");
          if (!/^[a-z_]+$/.test(name)) continue;
          await tx.unsafe(
            `alter role ${ident(newName)}${datname ? ` in database ${ident(datname)}` : ""} set ${name} = ${literal(rest.join("="))}`,
          );
          actions.push(`${newName}: ${name} copied`);
        }
      // Explicit CONNECT grants only (not the ones every role inherits from
      // PUBLIC), so the new login reaches exactly the old login's databases.
      const databases = await tx`
        select d.datname from pg_database d,
          aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
        where a.grantee = ${source.oid} and a.privilege_type = 'CONNECT'`;
      for (const { datname } of databases) {
        await tx.unsafe(
          `grant connect on database ${ident(datname)} to ${ident(newName)}`,
        );
        actions.push(`${newName}: connect ${datname}`);
      }
      if (o.kind === "runtime") {
        // The runtime login holds direct grants (scripts/grants.sql), not a
        // membership: grant them now so the new login can serve traffic
        // before any deploy re-applies the manifest (OPS-R3).
        const [{ can, database }] = await tx`
          select coalesce(bool_and(pg_has_role(current_user, tableowner, 'usage')), true) as can,
                 current_database() as database
          from pg_tables where schemaname = 'public'`;
        if (!can)
          throw Error(
            "the owner login cannot grant on the public tables; it must be a member of gm_migrator (scripts/ops/provision-roles.ts)",
          );
        await applyGrantsTx(tx, { role: newName, database });
        actions.push(`${newName}: runtime grants applied`);
      }
      const missing = await missingPrivileges(tx, source.oid, newName);
      if (missing.length)
        throw Error(
          `${newName} would lack ${missing.length} privileges of ${old} (for example ${missing
            .slice(0, 3)
            .map((m) => `${m.privilege_type} on ${m.object}`)
            .join(", ")}); rotation rolled back`,
        );
      actions.push(`${newName}: holds every table privilege of ${old}`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
  return { old, newName, url, file, actions };
}

/** Table and column privileges in schema public that `oldOid` has and `newName` lacks. */
async function missingPrivileges(tx: Tx, oldOid: number, newName: string) {
  return tx<{ object: string; privilege_type: string }[]>`
    with acl as (
      select c.relname::text as object, a.grantee, a.privilege_type
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
           aclexplode(c.relacl) a
      where n.nspname = 'public'
      union all
      select c.relname || '.' || att.attname, a.grantee, a.privilege_type
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped,
           aclexplode(att.attacl) a
      where n.nspname = 'public'
    )
    select object, privilege_type from acl where grantee = ${oldOid}
    except
    select object, privilege_type from acl
    where grantee = (select oid from pg_roles where rolname = ${newName})
    order by 1, 2`;
}

const PRIVILEGE = /^(CONNECT|CREATE|TEMPORARY|USAGE)$/;

/**
 * Database (any in the cluster) and schema (this database) privileges `old`
 * still holds, one row per object and grantor, with whether the current
 * login may SET ROLE to the grantor.
 */
async function remainingGrants(tx: Tx, old: string) {
  const [{ version }] =
    await tx`select current_setting('server_version_num')::int as version`;
  // PostgreSQL 16 separates SET from membership; 15 and older allow SET ROLE
  // to any role the login is a member of.
  const mode = version >= 160000 ? "SET" : "MEMBER";
  return tx<
    {
      kind: "database" | "schema";
      name: string;
      grantor: string;
      privileges: string[];
      can_set: boolean;
    }[]
  >`
    with target as (select oid from pg_roles where rolname = ${old}),
    acl as (
      select 'database' as kind, d.datname::text as name, a.grantor, a.privilege_type
      from pg_database d cross join lateral aclexplode(d.datacl) a
      where a.grantee = (select oid from target)
      union all
      select 'schema', n.nspname::text, a.grantor, a.privilege_type
      from pg_namespace n cross join lateral aclexplode(n.nspacl) a
      where a.grantee = (select oid from target)
    )
    select acl.kind, acl.name, g.rolname as grantor,
           array_agg(distinct acl.privilege_type order by acl.privilege_type) as privileges,
           pg_has_role(current_user, g.oid, ${mode}) as can_set
    from acl join pg_roles g on g.oid = acl.grantor
    group by acl.kind, acl.name, g.rolname, g.oid
    order by 1, 2, 3`;
}

/** Drops the old login once nothing is connected with it. */
export async function finalizeRotation(o: { ownerUrl: string; old: string }) {
  if (!ROLE.test(o.old) || o.old === "gm_migrator")
    throw Error("invalid old login");
  const sql = connect(o.ownerUrl);
  const actions: string[] = [];
  try {
    const [active] =
      await sql`select count(*)::int as n from pg_stat_activity where usename=${o.old}`;
    if (active.n)
      throw Error(
        `${o.old} still has ${active.n} sessions; redeploy and retry`,
      );
    await sql.begin(async (raw) => {
      const tx = raw as Tx;
      // DROP OWNED needs the old login's privileges. Neon's owner holds only
      // ADMIN on the logins it created (PostgreSQL 16+), so it inherits the
      // old login first; the membership disappears with the role (OPS-R9).
      await ensurePrivilegesOf(tx, o.old);
      await tx.unsafe(`drop owned by ${ident(o.old)}`);
      actions.push(`dropped objects and privileges owned by ${o.old}`);
      // DROP OWNED revokes a privilege only when this login's best grantor
      // for that object made the grant. Every deploy re-applies
      // scripts/grants.sql as gm_migrator, so CONNECT on the database and
      // USAGE on schema public are also held from gm_migrator (and, for a
      // superuser or a login that inherits gm_migrator, the owner's grant can
      // be the one left). Revoke each remaining grant as its grantor, since
      // REVOKE ... GRANTED BY accepts only the current user (OPS-R14).
      const remaining = await remainingGrants(tx, o.old);
      const blocked = remaining.filter((g) => !g.can_set);
      if (blocked.length)
        throw Error(
          `${o.old} still holds ${blocked
            .map(
              (g) =>
                `${g.privileges.join(", ")} on ${g.kind} ${g.name} granted by ${g.grantor}`,
            )
            .join(
              "; ",
            )}, a role this login cannot SET ROLE to; revoke it as that role and retry (nothing was dropped)`,
        );
      for (const g of remaining) {
        if (!g.privileges.every((p) => PRIVILEGE.test(p)))
          throw Error(`unexpected privilege on ${g.kind} ${g.name}`);
        await tx.unsafe(`set local role ${ident(g.grantor)}`);
        await tx.unsafe(
          `revoke ${g.privileges.join(", ")} on ${g.kind} ${ident(g.name)} from ${ident(o.old)}`,
        );
        await tx.unsafe(`reset role`);
        actions.push(
          `revoked ${g.privileges.join(", ")} on ${g.kind} ${g.name} granted by ${g.grantor}`,
        );
      }
      await tx.unsafe(`drop role ${ident(o.old)}`);
      actions.push(`dropped ${o.old}`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
  return { dropped: o.old, actions };
}

/** New password for gm_migrator (used only by the GitHub Actions deploy job and retention workflow). */
export async function rotateMigrator(o: {
  ownerUrl: string;
  env: string;
  file?: string | null;
}) {
  const password = randomBytes(32).toString("hex");
  const url = loginUrl(o.ownerUrl, "gm_migrator", password, false);
  const file =
    o.file === undefined
      ? `.env.rotated-${o.env}-migrator-${Date.now()}`
      : o.file;
  if (file)
    writeFileSync(file, `MIGRATION_DATABASE_URL=${url}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  const sql = connect(o.ownerUrl);
  try {
    await sql.unsafe(`alter role gm_migrator password ${literal(password)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return { role: "gm_migrator", url, file };
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
    const env = value("--env") ?? "";
    if (!/^[a-z][a-z0-9]{1,20}$/.test(env)) throw Error("--env required");
    let result: Record<string, unknown>;
    if (args.includes("--finalize"))
      result = await finalizeRotation({ ownerUrl, old: value("--old") ?? "" });
    else if (value("--kind") === "migrator") {
      const r = await rotateMigrator({ ownerUrl, env });
      result = {
        role: r.role,
        file: r.file,
        next: "update the GitHub environment secret: gh secret set MIGRATION_DATABASE_URL --env <env> < <file> (stdin; never on the command line)",
      };
    } else {
      const kind = value("--kind") as Exclude<LoginKind, "migrator">;
      if (!["runtime", "billing", "backup", "worker"].includes(kind))
        throw Error("--kind runtime|billing|backup|worker|migrator");
      const r = await rotateLogin({
        ownerUrl,
        env,
        kind,
        old: value("--old"),
        newName: value("--new-name"),
      });
      result = {
        old: r.old,
        newName: r.newName,
        file: r.file,
        actions: r.actions,
        next:
          kind === "runtime"
            ? "the new login already holds the runtime grants; set DATABASE_URL and PG_APP_USER on web and the GitHub environment variable PG_APP_USER; redeploy web (merge no migration mid-rotation); then --finalize"
            : kind === "billing"
              ? "set BILLING_DATABASE_URL on web and worker, redeploy both, then --finalize"
              : kind === "worker"
                ? "set WORKER_DATABASE_URL on the worker service, redeploy it, then --finalize"
                : "update the BACKUP_DATABASE_URL GitHub environment secret, then --finalize",
      };
    }
    console.log(
      JSON.stringify({ message: "rotation_step_complete", ...result }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        message: "rotation_failed",
        error: String((error as Error).message).replace(
          /postgres(ql)?:\/\/[^@\s]+@/g,
          "postgresql://[redacted]@",
        ),
      }),
    );
    process.exitCode = 1;
  }
}
