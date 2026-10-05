// Provisioning and credential rotation against a throwaway local database
// (DB-1, OPS-7, OPS-9): provision-roles.ts hands an owner-migrated database to
// gm_migrator, creates least-privilege logins with pooler-safe role defaults,
// is idempotent, and rotate-db-login.ts swaps a runtime login with zero
// downtime. Uses the isolated test admin connection; touches only roles it
// creates (gm_migrator keeps its existing password).
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { parse } from "dotenv";
import { isolatedTarget } from "./isolated-target.js";
import { check, passed } from "./ops-roles.js";
import { provisionRoles } from "../scripts/ops/provision-roles.js";
import {
  finalizeRotation,
  rotateLogin,
} from "../scripts/ops/rotate-db-login.js";
import { main as migrate } from "../scripts/migrate.js";
import { checkRole, tenant } from "../server/db.js";
import { setLogSink } from "../server/logging.js";

setLogSink(() => {});
const { migration } = isolatedTarget(process.env);
const admin = postgres(migration, { max: 1, onnotice: () => {} });
const env = "t" + randomBytes(3).toString("hex");
const database = `green_monkey_provision_${env}_test`;
const dir = mkdtempSync(join(tmpdir(), "gm-provision-"));
const file = join(dir, `.env.provisioned-${env}`);
const ownerUrl = (() => {
  const u = new URL(migration);
  u.pathname = "/" + database;
  return u.href;
})();
const pools: postgres.Sql[] = [];
const poolUsers = new Map<postgres.Sql, string>();
const as = (url: string) => {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  pools.push(sql);
  poolUsers.set(sql, decodeURIComponent(new URL(url).username));
  return sql;
};
/** Ends every pool of one login, as a redeploy would. */
const disconnect = async (user: string) => {
  for (const sql of [...pools])
    if (poolUsers.get(sql) === user) {
      await sql.end({ timeout: 5 });
      pools.splice(pools.indexOf(sql), 1);
    }
};
const created: string[] = [];
// The same public local-only value tests/migrate-db.ts and CI give
// gm_migrator; never a real credential.
const MIGRATOR_PASSWORD = "local-only-migrator";
const migratorUrl = (db: string) => {
  const u = new URL(migration);
  u.pathname = "/" + db;
  u.username = "gm_migrator";
  u.password = MIGRATOR_PASSWORD;
  return u.href;
};
/** Grants on `db` (database CONNECT, schema public) that `grantor` gave `role`. */
const grantsBy = async (db: string, role: string, grantor: string) => {
  const u = new URL(migration);
  u.pathname = "/" + db;
  const sql = postgres(u.href, { max: 1, onnotice: () => {} });
  const [row] = await sql`
    select
      (select array_agg(a.privilege_type order by 1) from pg_database d, aclexplode(d.datacl) a
       where d.datname = ${db} and a.grantee = to_regrole(${role}) and a.grantor = to_regrole(${grantor})) as database,
      (select array_agg(a.privilege_type order by 1) from pg_namespace n, aclexplode(n.nspacl) a
       where n.nspname = 'public' and a.grantee = to_regrole(${role}) and a.grantor = to_regrole(${grantor})) as schema`.finally(
    () => sql.end({ timeout: 5 }),
  );
  return { database: row.database ?? [], schema: row.schema ?? [] };
};
/**
 * What every deploy's preDeploy runs (.railway/railway.ts): migrate --grants
 * --retention as gm_migrator, which re-grants CONNECT and schema USAGE to the
 * runtime login with gm_migrator as the grantor (OPS-R14).
 */
const deployGrants = async (db: string, role: string) => {
  await admin.unsafe(
    `alter role gm_migrator login password '${MIGRATOR_PASSWORD}'`,
  );
  assert.equal(
    await migrate(["--grants", "--retention"], {
      MIGRATION_DATABASE_URL: migratorUrl(db),
      PG_APP_USER: role,
      APP_ENV: "staging",
    }),
    0,
    "the deploy applies the manifest as gm_migrator",
  );
  assert.deepEqual(
    await grantsBy(db, role, "gm_migrator"),
    { database: ["CONNECT"], schema: ["USAGE"] },
    "the runtime login now holds grants whose grantor is gm_migrator",
  );
};
const neonEnv = "n" + randomBytes(3).toString("hex");
const neonDatabase = `green_monkey_provision_${neonEnv}_test`;
const neonOwner = `gm_test_neon_owner_${neonEnv}`;
const neonOwnerPassword = randomBytes(24).toString("hex");
const neonGrantor = `gm_test_grantor_${neonEnv}`;
try {
  await admin.unsafe(`create database "${database}"`);
  assert.equal(
    await migrate([], {
      MIGRATION_DATABASE_URL: ownerUrl,
      APP_ENV: "development",
    }),
    0,
  );
  const [migrator] =
    await admin`select rolcanlogin from pg_roles where rolname='gm_migrator'`;

  await check(
    "provisioning creates least-privilege logins and hands the schema to gm_migrator",
    async () => {
      const dry = await provisionRoles({
        ownerUrl,
        env,
        dryRun: true,
        file: null,
      });
      assert.ok(dry.actions.includes("dry run: rolled back"));
      const [none] =
        await admin`select count(*)::int as n from pg_roles where rolname like ${"gm_" + env + "_%"}`;
      assert.equal(none.n, 0, "dry run leaves no roles behind");

      const result = await provisionRoles({ ownerUrl, env, file });
      created.push(result.roles.app, result.roles.billing, result.roles.backup);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const saved = parse(readFileSync(file, "utf8"));
      assert.deepEqual(Object.keys(saved).sort(), [
        "BACKUP_DATABASE_URL",
        "BILLING_DATABASE_URL",
        "DATABASE_URL",
        "MIGRATION_DATABASE_URL",
        "PG_APP_USER",
      ]);
      assert.equal(saved.PG_APP_USER, `gm_${env}_app`);
      if (migrator?.rolcanlogin)
        assert.ok(
          result.actions.includes("gm_migrator: kept its existing password"),
        );
      const db = as(ownerUrl);
      const [owners] =
        await db`select array_agg(distinct tableowner) as owners from pg_tables where schemaname='public'`;
      assert.deepEqual(owners.owners, ["gm_migrator"]);
      const roles = await db`
      select r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole,
        array(select b.rolname from pg_auth_members m join pg_roles b on b.oid=m.roleid
              where m.member=r.oid order by 1) as member_of
      from pg_roles r where r.rolname like ${"gm_" + env + "_%"} order by 1`;
      assert.deepEqual(
        roles.map((r) => [r.rolname, r.member_of]),
        [
          [`gm_${env}_app`, []],
          [`gm_${env}_backup`, ["gm_backup_reader"]],
          [`gm_${env}_billing`, ["gm_billing_worker"]],
        ],
      );
      assert.ok(
        roles.every((r) => !r.rolsuper && !r.rolbypassrls && !r.rolcreaterole),
      );
      const [connect] =
        await db`select has_database_privilege('public', ${database}, 'CONNECT') as public_connect`;
      assert.equal(connect.public_connect, false, "PUBLIC loses CONNECT");
    },
  );

  await check(
    "role defaults apply through the login (pooler-safe timeouts, OPS-7)",
    async () => {
      const saved = parse(readFileSync(file, "utf8"));
      assert.equal(
        await migrate(["--grants-only"], {
          MIGRATION_DATABASE_URL: ownerUrl,
          PG_APP_USER: saved.PG_APP_USER,
          APP_ENV: "development",
        }),
        0,
      );
      const app = as(saved.DATABASE_URL);
      await checkRole(app);
      const [settings] = await app`
      select current_setting('statement_timeout') as statement,
             current_setting('lock_timeout') as lock,
             current_setting('idle_in_transaction_session_timeout') as idle`;
      assert.deepEqual(
        { ...settings },
        { statement: "10s", lock: "8s", idle: "15s" },
      );
      const backup = as(saved.BACKUP_DATABASE_URL);
      const [b] =
        await backup`select current_setting('statement_timeout') as statement`;
      assert.equal(b.statement, "0");
    },
  );

  await check(
    "a second run is idempotent and reuses the saved passwords",
    async () => {
      const again = await provisionRoles({ ownerUrl, env, file });
      assert.ok(
        !again.actions.some((a) => a.startsWith("created gm_")),
        "no role re-created",
      );
      const saved = parse(readFileSync(file, "utf8"));
      const app = as(saved.DATABASE_URL);
      const [ok] = await app`select 1 as ok`;
      assert.equal(ok.ok, 1);
    },
  );

  await check(
    "dual-role rotation keeps memberships and settings, then drops the old login only when idle",
    async () => {
      const saved = parse(readFileSync(file, "utf8"));
      const rotated = await rotateLogin({
        ownerUrl,
        env,
        kind: "billing",
        newName: `gm_${env}_billing_next`,
        file: join(dir, "rotated-billing"),
      });
      created.push(rotated.newName);
      const next = as(rotated.url);
      const [n] = await next`
      select pg_has_role(current_user, 'gm_billing_worker', 'member') as billing,
             current_setting('statement_timeout') as statement`;
      assert.deepEqual({ ...n }, { billing: true, statement: "30s" });
      const [reach] = await admin`
      select array_agg(d.datname) as dbs from pg_database d,
        aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
      join pg_roles r on r.oid = a.grantee
      where r.rolname = ${rotated.newName} and a.privilege_type = 'CONNECT'`;
      assert.deepEqual(
        reach.dbs,
        [database],
        "explicit CONNECT copied only for the old login's databases",
      );
      const old = as(saved.BILLING_DATABASE_URL);
      await old`select 1`;
      await assert.rejects(
        finalizeRotation({ ownerUrl, old: `gm_${env}_billing` }),
        /still has 1 sessions/,
      );
      await old.end();
      pools.splice(pools.indexOf(old), 1);
      await finalizeRotation({ ownerUrl, old: `gm_${env}_billing` });
      const [gone] =
        await admin`select count(*)::int as n from pg_roles where rolname=${`gm_${env}_billing`}`;
      assert.equal(gone.n, 0);
      await assert.rejects(
        rotateLogin({
          ownerUrl,
          env,
          kind: "runtime",
          old: "gm_migrator",
          file: null,
        }),
        /migrator/,
      );
    },
  );

  await check(
    "runtime rotation grants the new login in the same transaction, so tenant reads and writes work before any deploy (OPS-R3)",
    async () => {
      const saved = parse(readFileSync(file, "utf8"));
      const owner = as(ownerUrl);
      const org = randomUUID(),
        tenantId = randomUUID();
      await owner.begin(async (tx) => {
        await tx`insert into organizations(id,name) values(${org},'Rotation fixture')`;
        await tx`insert into restaurants(id,organization_id,name) values(${tenantId},${org},'Rotation fixture')`;
      });
      // A deploy has run since provisioning, as it always has before a
      // rotation in staging and production.
      await deployGrants(database, saved.PG_APP_USER);
      const rotated = await rotateLogin({
        ownerUrl,
        env,
        kind: "runtime",
        newName: `gm_${env}_app_next`,
        file: join(dir, "rotated-runtime"),
      });
      created.push(rotated.newName);
      assert.ok(
        rotated.actions.includes(`${rotated.newName}: runtime grants applied`),
      );
      assert.ok(
        rotated.actions.includes(
          `${rotated.newName}: holds every table privilege of ${saved.PG_APP_USER}`,
        ),
      );
      // The new login serves a tenant request before any deploy re-applies
      // the manifest: read, insert and column-level update all work.
      const next = as(rotated.url);
      await checkRole(next);
      const tableId = randomUUID();
      await tenant(next, tenantId, async (tx) => {
        await tx`insert into dining_tables(tenant_id,id,name) values(${tenantId},${tableId},'Mesa R')`;
        const [row] = await tx`select count(*)::int as n from dining_tables`;
        assert.equal(row.n, 1, "the new login sees its tenant's rows");
        await tx`select count(*) from orders`;
        await tx`update restaurants set name = 'Rotation fixture 2' where id = ${tenantId}`;
      });
      const [n] = await next`
        select current_setting('statement_timeout') as statement,
               has_table_privilege(current_user, 'orders', 'DELETE') as can_delete`;
      assert.deepEqual(
        { ...n },
        { statement: "10s", can_delete: false },
        "role defaults copied; still no DELETE",
      );
      // Redeploy (old pools end), finalize, and the new login keeps working.
      // The superuser owner revokes gm_migrator's database and schema grants
      // too, which DROP OWNED leaves behind (OPS-R14).
      await disconnect(saved.PG_APP_USER);
      const finalized = await finalizeRotation({
        ownerUrl,
        old: saved.PG_APP_USER,
      });
      assert.ok(
        finalized.actions.includes(
          `revoked CONNECT on database ${database} granted by gm_migrator`,
        ),
      );
      assert.ok(
        finalized.actions.includes(
          "revoked USAGE on schema public granted by gm_migrator",
        ),
      );
      const [gone] =
        await admin`select count(*)::int as n from pg_roles where rolname=${saved.PG_APP_USER}`;
      assert.equal(gone.n, 0);
      await tenant(next, tenantId, (tx) => tx`select 1 from dining_tables`);
    },
  );

  await check(
    "a rotation that would drop a privilege of the old login is rolled back",
    async () => {
      // A manual grant the manifest does not carry (drift) must block the
      // rotation instead of producing a login that fails at runtime.
      const owner = as(ownerUrl);
      const old = `gm_${env}_app_next`;
      await owner.unsafe(`grant delete on dining_tables to "${old}"`);
      await assert.rejects(
        rotateLogin({
          ownerUrl,
          env,
          kind: "runtime",
          old,
          newName: `gm_${env}_app_drift`,
          file: null,
        }),
        /would lack 1 privileges of .*DELETE on dining_tables/,
      );
      const [none] =
        await admin`select count(*)::int as n from pg_roles where rolname=${`gm_${env}_app_drift`}`;
      assert.equal(none.n, 0, "nothing was created");
      await owner.unsafe(`revoke delete on dining_tables from "${old}"`);
    },
  );

  await check(
    "Neon parity: a non-superuser CREATEROLE owner provisions, rotates and finalizes logins (OPS-R9)",
    async () => {
      // neondb_owner is LOGIN CREATEROLE CREATEDB BYPASSRLS but never a
      // superuser, and it owns the database it migrated. On a fresh Neon
      // cluster it creates the capability roles itself (globals.sql), so
      // PostgreSQL 16+ gives it ADMIN on them without INHERIT or SET
      // (createrole_self_grant ''). They already exist in this shared local
      // cluster, so the check grants exactly that membership.
      await admin.unsafe(
        `create role "${neonOwner}" login createrole createdb bypassrls nosuperuser password '${neonOwnerPassword}'`,
      );
      await admin.unsafe(
        `grant gm_migrator, gm_billing_worker, gm_backup_reader to "${neonOwner}" with admin true, inherit false, set false`,
      );
      await admin.unsafe(
        `create database "${neonDatabase}" owner "${neonOwner}"`,
      );
      const neonOwnerUrl = (() => {
        const u = new URL(migration);
        u.pathname = "/" + neonDatabase;
        u.username = neonOwner;
        u.password = neonOwnerPassword;
        return u.href;
      })();
      const owner = as(neonOwnerUrl);
      const [self] = await owner`
        select r.rolsuper, pg_has_role(current_user, 'gm_migrator', 'SET') as can_set
        from pg_roles r where r.rolname = current_user`;
      assert.deepEqual(
        { ...self },
        { rolsuper: false, can_set: false },
        "the owner starts like neondb_owner: not a superuser, cannot SET ROLE gm_migrator",
      );
      assert.equal(
        await migrate([], {
          MIGRATION_DATABASE_URL: neonOwnerUrl,
          APP_ENV: "development",
        }),
        0,
        "the owner migrates its database",
      );

      const neonFile = join(dir, `.env.provisioned-${neonEnv}`);
      const result = await provisionRoles({
        ownerUrl: neonOwnerUrl,
        env: neonEnv,
        file: neonFile,
      });
      created.push(result.roles.app, result.roles.billing, result.roles.backup);
      assert.ok(
        result.actions.includes(
          "asserted: no privileged login; only gm_migrator owns tables",
        ),
      );
      const [owners] = await owner`
        select array_agg(distinct tableowner) as owners from pg_tables where schemaname='public'`;
      assert.deepEqual(owners.owners, ["gm_migrator"]);
      const [membership] = await owner`
        select pg_has_role(current_user, 'gm_migrator', 'SET') as can_set,
               pg_has_role(current_user, 'gm_migrator', 'USAGE') as inherits`;
      assert.deepEqual({ ...membership }, { can_set: true, inherits: true });
      const again = await provisionRoles({
        ownerUrl: neonOwnerUrl,
        env: neonEnv,
        file: neonFile,
      });
      assert.ok(
        !again.actions.some((a) => a.startsWith("created gm_")),
        "a re-run as the non-superuser owner is idempotent",
      );

      // The owner applies the runtime grants once (cutover), then a deploy
      // re-applies them as gm_migrator; then a runtime and a billing rotation
      // and both finalizations run through the same owner.
      const saved = parse(readFileSync(neonFile, "utf8"));
      assert.equal(
        await migrate(["--grants-only"], {
          MIGRATION_DATABASE_URL: neonOwnerUrl,
          PG_APP_USER: saved.PG_APP_USER,
          APP_ENV: "development",
        }),
        0,
      );
      await deployGrants(neonDatabase, saved.PG_APP_USER);
      const org = randomUUID(),
        tenantId = randomUUID();
      await as(neonOwnerUrl).begin(async (tx) => {
        await tx`insert into organizations(id,name) values(${org},'Neon parity fixture')`;
        await tx`insert into restaurants(id,organization_id,name) values(${tenantId},${org},'Neon parity fixture')`;
      });
      const runtimeNext = await rotateLogin({
        ownerUrl: neonOwnerUrl,
        env: neonEnv,
        kind: "runtime",
        newName: `gm_${neonEnv}_app_next`,
        file: null,
      });
      created.push(runtimeNext.newName);
      const next = as(runtimeNext.url);
      await checkRole(next);
      await tenant(next, tenantId, async (tx) => {
        await tx`insert into dining_tables(tenant_id,id,name) values(${tenantId},${randomUUID()},'Mesa N')`;
        const [row] = await tx`select count(*)::int as n from dining_tables`;
        assert.equal(row.n, 1);
      });
      const billingNext = await rotateLogin({
        ownerUrl: neonOwnerUrl,
        env: neonEnv,
        kind: "billing",
        newName: `gm_${neonEnv}_billing_next`,
        file: null,
      });
      created.push(billingNext.newName);
      assert.ok(
        billingNext.actions.includes(
          `${billingNext.newName} is a member of gm_billing_worker`,
        ),
      );
      await disconnect(saved.PG_APP_USER);

      // A grant from a role the owner cannot act as is named, and the
      // finalization rolls back with the old login intact.
      await admin.unsafe(`create role "${neonGrantor}" nologin`);
      await admin.unsafe(
        `grant connect on database "${neonDatabase}" to "${neonGrantor}" with grant option`,
      );
      await admin.begin(async (tx) => {
        await tx.unsafe(`set local role "${neonGrantor}"`);
        await tx.unsafe(
          `grant connect on database "${neonDatabase}" to "${saved.PG_APP_USER}"`,
        );
      });
      await assert.rejects(
        finalizeRotation({ ownerUrl: neonOwnerUrl, old: saved.PG_APP_USER }),
        new RegExp(
          `CONNECT on database ${neonDatabase} granted by ${neonGrantor}, a role this login cannot SET ROLE to`,
        ),
      );
      const [kept] =
        await admin`select count(*)::int as n from pg_roles where rolname=${saved.PG_APP_USER}`;
      assert.equal(kept.n, 1, "the failed finalization dropped nothing");
      assert.deepEqual(
        await grantsBy(neonDatabase, saved.PG_APP_USER, "gm_migrator"),
        { database: ["CONNECT"], schema: ["USAGE"] },
        "and revoked nothing",
      );
      await admin.begin(async (tx) => {
        await tx.unsafe(`set local role "${neonGrantor}"`);
        await tx.unsafe(
          `revoke connect on database "${neonDatabase}" from "${saved.PG_APP_USER}"`,
        );
      });

      const finalized = [];
      for (const old of [saved.PG_APP_USER, `gm_${neonEnv}_billing`])
        finalized.push(await finalizeRotation({ ownerUrl: neonOwnerUrl, old }));
      assert.ok(
        finalized[0].actions.includes(
          `revoked CONNECT on database ${neonDatabase} granted by gm_migrator`,
        ),
        "the deploy's CONNECT grant is revoked as gm_migrator (OPS-R14)",
      );
      const [gone] = await admin`
        select count(*)::int as n from pg_roles
        where rolname = any(${[saved.PG_APP_USER, `gm_${neonEnv}_billing`]})`;
      assert.equal(gone.n, 0, "the owner drops the logins it rotated out");
      await tenant(next, tenantId, (tx) => tx`select 1 from dining_tables`);

      // The next rotation finalizes the login that replaced it, after a
      // deploy granted it as gm_migrator as well.
      await deployGrants(neonDatabase, runtimeNext.newName);
      const runtimeThird = await rotateLogin({
        ownerUrl: neonOwnerUrl,
        env: neonEnv,
        kind: "runtime",
        old: runtimeNext.newName,
        newName: `gm_${neonEnv}_app_third`,
        file: null,
      });
      created.push(runtimeThird.newName);
      await disconnect(runtimeNext.newName);
      await finalizeRotation({
        ownerUrl: neonOwnerUrl,
        old: runtimeNext.newName,
      });
      const third = as(runtimeThird.url);
      await tenant(third, tenantId, (tx) => tx`select 1 from dining_tables`);
    },
  );

  console.log(`Provisioning DB checks passed: ${passed()} checks.`);
} finally {
  for (const sql of pools) await sql.end({ timeout: 5 }).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
  for (const db of [database, neonDatabase])
    await admin
      .unsafe(`drop database if exists "${db}" with (force)`)
      .catch((e) => console.error(e.message));
  for (const role of [...created, neonGrantor, neonOwner])
    await admin
      .unsafe(`drop role if exists "${role}"`)
      .catch((e) => console.error(e.message));
  await admin.end();
}
