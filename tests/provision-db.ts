// Provisioning and credential rotation against a throwaway local database
// (DB-1, OPS-7, OPS-9): provision-roles.ts hands an owner-migrated database to
// gm_migrator, creates least-privilege logins with pooler-safe role defaults,
// is idempotent, and rotate-db-login.ts swaps a runtime login with zero
// downtime. Uses the isolated test admin connection; touches only roles it
// creates (gm_migrator keeps its existing password).
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
import { checkRole } from "../server/db.js";
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
const as = (url: string) => {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  pools.push(sql);
  return sql;
};
const created: string[] = [];
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

  console.log(`Provisioning DB checks passed: ${passed()} checks.`);
} finally {
  for (const sql of pools) await sql.end({ timeout: 5 }).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
  await admin
    .unsafe(`drop database if exists "${database}" with (force)`)
    .catch((e) => console.error(e.message));
  for (const role of created)
    await admin
      .unsafe(`drop role if exists "${role}"`)
      .catch((e) => console.error(e.message));
  await admin.end();
}
