import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { check, passed } from "./ops-roles.js";
import {
  applyGrants,
  applyMigrations,
  assertMigrationRole,
  pendingMigrations,
  readMigrations,
} from "../server/ops/schema.js";
import { main } from "../scripts/migrate.js";
import { requireReadySchema } from "../server/readiness.js";
import { runRetention } from "../server/ops/retention.js";
import { setLogSink } from "../server/logging.js";
import { lintMigrations } from "../scripts/ops/migrations-lint.js";

const lines: string[] = [];
setLogSink((line) => lines.push(line));
const { runtime, migration } = isolatedTarget(process.env);
const admin = postgres(migration, { max: 1, onnotice: () => {} });
const suffix = randomBytes(4).toString("hex");
const synthetic = `green_monkey_runner_${suffix}_test`;
const real = `green_monkey_runner_${suffix}b_test`;
const legacy = `green_monkey_runner_${suffix}c_test`;
const migrator = `gm_test_migrator_${suffix}`;
const migratorPassword = randomBytes(24).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "gm-migrations-"));
const urlFor = (
  database: string,
  user?: { name: string; password: string },
) => {
  const u = new URL(migration);
  u.pathname = "/" + database;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.href;
};
const write = (name: string, body: string) =>
  writeFileSync(join(dir, name), body);
const pools: postgres.Sql[] = [];
const pool = (url: string, max = 2) => {
  const sql = postgres(url, { max, onnotice: () => {} });
  pools.push(sql);
  return sql;
};

try {
  await admin.unsafe(`create database "${synthetic}"`);
  await admin.unsafe(
    `create role "${migrator}" login password '${migratorPassword}' nosuperuser nocreatedb nocreaterole nobypassrls`,
  );
  await admin.unsafe(`create database "${real}" owner "${migrator}"`);
  const sql = pool(urlFor(synthetic));
  const noSleep = async () => {};

  await check(
    "applies each file in its own transaction and records it",
    async () => {
      write(
        "001_a.sql",
        "SET LOCAL lock_timeout = '5s';\nCREATE TABLE a(id int);\n",
      );
      write(
        "002_b.sql",
        "SET LOCAL lock_timeout = '5s';\nCREATE TABLE b(id int);\n",
      );
      write(
        "003_bad.sql",
        "SET LOCAL lock_timeout = '5s';\nCREATE TABLE c(id int);\nSELECT missing_function();\n",
      );
      await assert.rejects(
        applyMigrations(sql, readMigrations(dir), { sleep: noSleep }),
        (e: any) =>
          e.code === "migration_failed" && e.detail.file === "003_bad.sql",
      );
      const rows = await sql`select name from schema_migrations order by name`;
      assert.deepEqual(
        rows.map((r) => r.name),
        ["001_a.sql", "002_b.sql"],
      );
      const [c] = await sql`select to_regclass('public.c') is null as absent`;
      assert.equal(c.absent, true, "the failing file rolled back alone");
      rmSync(join(dir, "003_bad.sql"));
    },
  );

  await check(
    "lock_timeout retry: a held ACCESS EXCLUSIVE lock causes retries then success after release; persistent lock fails with migration_failed (DB-6 regression)",
    async () => {
      write(
        "003_alter.sql",
        "SET LOCAL lock_timeout = '5s';\nALTER TABLE a ADD COLUMN x int;\n",
      );
      const holder = pool(urlFor(synthetic), 1);
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const held = holder.begin(async (tx) => {
        await tx`lock table a in access exclusive mode`;
        await released;
      });
      await new Promise((r) => setTimeout(r, 100));
      const waits: number[] = [];
      const applied = await applyMigrations(sql, readMigrations(dir), {
        lockTimeout: "200ms",
        sleep: async (ms) => {
          waits.push(ms);
          if (waits.length === 2) {
            release();
            await held;
          }
        },
      });
      assert.deepEqual(applied, ["003_alter.sql"]);
      assert.deepEqual(waits, [2000, 4000]);
      assert.ok(lines.some((l) => l.includes('"migration_lock_retry"')));

      write(
        "004_alter.sql",
        "SET LOCAL lock_timeout = '5s';\nALTER TABLE b ADD COLUMN y int;\n",
      );
      let stop!: () => void;
      const stopped = new Promise<void>((r) => (stop = r));
      const blocking = holder.begin(async (tx) => {
        await tx`lock table b in access exclusive mode`;
        await stopped;
      });
      await new Promise((r) => setTimeout(r, 100));
      const persistent: number[] = [];
      await assert.rejects(
        applyMigrations(sql, readMigrations(dir), {
          lockTimeout: "100ms",
          sleep: async (ms) => void persistent.push(ms),
        }),
        (e: any) =>
          e.code === "migration_failed" &&
          e.detail.file === "004_alter.sql" &&
          e.detail.pgCode === "55P03",
      );
      assert.deepEqual(persistent, [2000, 4000, 8000, 16000]);
      stop();
      await blocking;
      assert.deepEqual(
        await applyMigrations(sql, readMigrations(dir), { sleep: noSleep }),
        ["004_alter.sql"],
      );
    },
  );

  await check("checksum change is refused", async () => {
    write(
      "001_a.sql",
      "SET LOCAL lock_timeout = '5s';\nCREATE TABLE a(id bigint);\n",
    );
    await assert.rejects(
      pendingMigrations(sql, readMigrations(dir)),
      (e: any) =>
        e.code === "migration_checksum_changed" &&
        e.detail.file === "001_a.sql",
    );
    write(
      "001_a.sql",
      "SET LOCAL lock_timeout = '5s';\nCREATE TABLE a(id int);\n",
    );
  });

  await check(
    "no-transaction file runs CREATE INDEX CONCURRENTLY",
    async () => {
      write(
        "005_index.sql",
        [
          "-- gm:no-transaction",
          "DROP INDEX CONCURRENTLY IF EXISTS a_x;",
          "-- gm:statement-break",
          "CREATE INDEX CONCURRENTLY a_x ON a (x);",
          "",
        ].join("\n"),
      );
      const files = readMigrations(dir);
      assert.equal(
        files.find((f) => f.name === "005_index.sql")?.transactional,
        false,
      );
      assert.deepEqual(await applyMigrations(sql, files, { sleep: noSleep }), [
        "005_index.sql",
      ]);
      const [index] =
        await sql`select indisvalid from pg_index where indexrelid=to_regclass('public.a_x')`;
      assert.equal(index.indisvalid, true);
      const [setting] = await sql`select current_setting('lock_timeout') as v`;
      assert.equal(
        setting.v,
        "0",
        "session settings are reset before the connection is reused",
      );
    },
  );

  await check("out-of-order file applies with a warning", async () => {
    write(
      "000_early.sql",
      "SET LOCAL lock_timeout = '5s';\nCREATE TABLE early(id int);\n",
    );
    lines.length = 0;
    assert.deepEqual(
      await applyMigrations(sql, readMigrations(dir), { sleep: noSleep }),
      ["000_early.sql"],
    );
    assert.ok(lines.some((l) => l.includes('"migration_out_of_order"')));
  });

  const migratorUrl = urlFor(real, {
    name: migrator,
    password: migratorPassword,
  });
  const env = (extra: Record<string, string> = {}) => ({
    MIGRATION_DATABASE_URL: migratorUrl,
    PG_APP_USER: "gm_app",
    APP_ENV: "staging",
    ...extra,
  });

  await check(
    "a non-superuser migration owner applies every bundled migration with APP_ENV=staging (DB-1 parity)",
    async () => {
      assert.equal(await main([], env()), 0);
      const checkOwner = pool(urlFor(real));
      const [o] = await checkOwner`
        select array_agg(distinct tableowner) as owners from pg_tables where schemaname='public'`;
      assert.deepEqual(o.owners, [migrator]);
      const [latest] =
        await checkOwner`select max(name) as name from schema_migrations`;
      assert.equal(latest.name, readMigrations().at(-1)!.name);
    },
  );

  await check(
    "--check exits 3 only while migrations are pending; --dry-run never writes",
    async () => {
      assert.equal(await main(["--check"], env()), 0);
      assert.equal(await main(["--dry-run"], env()), 0);
      // A database with no bundled migrations applied is pending.
      assert.equal(
        await main(["--check"], {
          ...env(),
          MIGRATION_DATABASE_URL: urlFor(synthetic),
        }),
        3,
      );
      const [registry] =
        await sql`select count(*)::int as n from schema_migrations`;
      assert.ok(registry.n > 0, "the synthetic registry was left untouched");
    },
  );

  const appUrl = new URL(runtime);
  appUrl.pathname = "/" + real;
  const app = pool(appUrl.href);

  await check(
    "preDeploy (migrate, then grants, then retention) leaves the runtime role ready and refuses privileged roles (DB-6)",
    async () => {
      assert.equal(await main(["--grants", "--retention"], env()), 0);
      await requireReadySchema(app);
      await app.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${"10000000-0000-4000-8000-000000000001"}, true)`;
        await tx`select count(*) from jobs`;
      });
      const [del] = await app`
        select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p')
          and has_table_privilege('gm_app', c.oid, 'DELETE')`;
      assert.equal(del.n, 0, "the runtime role gets no DELETE anywhere");
      assert.equal(
        await main(["--grants-only"], env()),
        0,
        "grants are idempotent",
      );
      const owner = pool(migratorUrl);
      await assert.rejects(
        applyGrants(owner, { role: migrator, database: real }),
        (e: any) => /runtime_role_(privileged|owns_tables)/.test(e.code),
      );
      const adminReal = pool(urlFor(real));
      await assert.rejects(
        applyGrants(adminReal, {
          role: new URL(migration).username,
          database: real,
        }),
        (e: any) => e.code === "runtime_role_privileged",
      );
      await assert.rejects(
        applyGrants(adminReal, {
          role: "gm_app; drop table x",
          database: real,
        }),
        (e: any) => e.code === "runtime_role_invalid",
      );
    },
  );

  await check(
    "retention as the non-superuser owner deletes only consumed/expired OAuth attempts and old done/dead jobs, and restores FORCE RLS (DB-8 regression)",
    async () => {
      const adminReal = pool(urlFor(real));
      const org = randomUUID(),
        tenantId = randomUUID();
      const state = () => randomBytes(32).toString("base64url").slice(0, 43);
      const oauth = {
        consumedOld: state(),
        expiredOld: state(),
        liveRecent: state(),
        consumedRecent: state(),
      };
      const jobs = {
        doneOld: randomUUID(),
        deadOld: randomUUID(),
        doneRecent: randomUUID(),
        blockedOld: randomUUID(),
        availableOld: randomUUID(),
      };
      await adminReal.begin(async (tx) => {
        await tx`insert into organizations(id,name) values(${org},'Retention fixture')`;
        await tx`insert into restaurants(id,organization_id,name) values(${tenantId},${org},'Retention fixture')`;
        const attempt = (hash: string, created: string, consumed: boolean) =>
          tx.unsafe(
            `insert into oauth_login_attempts(state_hash,browser_hash,nonce,verifier,created_at,expires_at,consumed_at)
             values($1,$1,'n','v',${created},${created} + interval '10 minutes',${consumed ? created : "null"})`,
            [hash],
          );
        await attempt(oauth.consumedOld, "now() - interval '3 days'", true);
        await attempt(oauth.expiredOld, "now() - interval '3 days'", false);
        await attempt(oauth.liveRecent, "now()", false);
        await attempt(oauth.consumedRecent, "now() - interval '1 hour'", true);
        const job = (id: string, s: string, created: string) =>
          tx.unsafe(
            `insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,created_at)
             values($1,$2,'kitchen_dispatch',$4,'{}',$3,${created})`,
            [tenantId, id, s, id],
          );
        await job(jobs.doneOld, "done", "now() - interval '40 days'");
        await job(jobs.deadOld, "dead", "now() - interval '40 days'");
        await job(jobs.doneRecent, "done", "now() - interval '2 days'");
        await job(jobs.blockedOld, "blocked", "now() - interval '40 days'");
        await job(jobs.availableOld, "available", "now() - interval '40 days'");
      });
      const owner = pool(migratorUrl);
      const result = await runRetention(owner, { batch: 1 });
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(result.deleted, { oauth_login_attempts: 2, jobs: 2 });
      const [left] = await adminReal`
        select
          (select array_agg(state_hash order by state_hash) from oauth_login_attempts) as oauth,
          (select array_agg(id::text order by id) from jobs where tenant_id=${tenantId}) as jobs,
          (select bool_and(relforcerowsecurity) from pg_class
            where oid in (to_regclass('public.jobs'), to_regclass('public.oauth_login_attempts'))) as forced`;
      assert.deepEqual(
        left.oauth,
        [oauth.liveRecent, oauth.consumedRecent].sort(),
      );
      assert.deepEqual(
        left.jobs,
        [jobs.doneRecent, jobs.blockedOld, jobs.availableOld].sort(),
      );
      assert.equal(left.forced, true, "FORCE ROW LEVEL SECURITY is restored");
      // A held lock makes retention skip the table instead of queueing traffic.
      const holder = pool(urlFor(real), 1);
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const held = holder.begin(async (tx) => {
        await tx`lock table jobs in access share mode`;
        await released;
      });
      await new Promise((r) => setTimeout(r, 100));
      const busy = await runRetention(owner);
      release();
      await held;
      assert.deepEqual(busy.skipped, ["jobs"]);
      await adminReal.begin(async (tx) => {
        await tx`delete from jobs where tenant_id=${tenantId}`;
        await tx`delete from oauth_login_attempts`;
        await tx`delete from restaurants where id=${tenantId}`;
        await tx`delete from organizations where id=${org}`;
      });
    },
  );

  await check(
    "backfills as the non-superuser owner change rows only with NO FORCE / FORCE on every table they write and read; the lint flags the others (OPS-R2)",
    async () => {
      const adminReal = pool(urlFor(real));
      const owner = pool(migratorUrl);
      const fixtureDir = mkdtempSync(join(tmpdir(), "gm-backfill-"));
      const tenants = [randomUUID(), randomUUID()];
      const org = randomUUID();
      const devices = [randomUUID(), randomUUID(), randomUUID()];
      const writeFixture = (name: string, body: string) =>
        writeFileSync(join(fixtureDir, name), body);
      const apply = async (name: string) => {
        const file = readMigrations(fixtureDir).find((f) => f.name === name)!;
        assert.deepEqual(
          await applyMigrations(owner, [file], { sleep: noSleep }),
          [name],
        );
      };
      const noted = async () => {
        const rows = await adminReal`
          select fixture_note from devices where tenant_id = any(${tenants}) order by id`;
        return rows.map((r) => r.fixture_note);
      };
      try {
        await adminReal.begin(async (tx) => {
          await tx`insert into organizations(id,name) values(${org},'Backfill fixture')`;
          for (const [i, id] of tenants.entries())
            await tx`insert into restaurants(id,organization_id,name) values(${id},${org},${"Backfill " + i})`;
          for (const [i, id] of devices.entries())
            await tx`insert into devices(tenant_id,id,name,token_hash)
              values(${tenants[i % 2]},${id},'Caja',${"fixture-" + id})`;
        });
        await adminReal`alter table devices add column fixture_note text`;
        // 023 as written: the owner's UPDATE is filtered by FORCE RLS.
        writeFixture(
          "900_plain.sql",
          "SET LOCAL lock_timeout = '5s';\nUPDATE devices SET fixture_note = 'plain';\n",
        );
        // Only the written table unforced: the joined table still looks empty.
        writeFixture(
          "901_target_only.sql",
          `SET LOCAL lock_timeout = '5s';
ALTER TABLE devices NO FORCE ROW LEVEL SECURITY;
UPDATE devices d SET fixture_note = r.name FROM restaurants r WHERE r.id = d.tenant_id;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
`,
        );
        // The owner pattern on every table it writes and reads (menu 025).
        writeFixture(
          "902_owner_pattern.sql",
          `SET LOCAL lock_timeout = '5s';
ALTER TABLE devices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE restaurants NO FORCE ROW LEVEL SECURITY;
UPDATE devices d SET fixture_note = r.name FROM restaurants r WHERE r.id = d.tenant_id;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
ALTER TABLE restaurants FORCE ROW LEVEL SECURITY;
`,
        );
        const findings = lintMigrations([
          ...readMigrations(),
          ...readMigrations(fixtureDir),
        ]);
        const flagged = (file: string) =>
          [
            ...new Set(
              findings
                .filter(
                  (f) => f.file === file && f.rule === "backfill_owner_pattern",
                )
                .map((f) => f.detail.split(":")[0]),
            ),
          ].sort();
        assert.deepEqual(flagged("900_plain.sql"), ["devices"]);
        assert.deepEqual(flagged("901_target_only.sql"), ["restaurants"]);
        assert.deepEqual(flagged("902_owner_pattern.sql"), []);

        await apply("900_plain.sql");
        assert.deepEqual(
          await noted(),
          [null, null, null],
          "without the owner pattern the backfill silently changes nothing",
        );
        await apply("901_target_only.sql");
        assert.deepEqual(
          await noted(),
          [null, null, null],
          "a forced table read by the backfill looks empty",
        );
        await apply("902_owner_pattern.sql");
        const expected = await adminReal`
          select r.name from devices d join restaurants r on r.id = d.tenant_id
          where d.tenant_id = any(${tenants}) order by d.id`;
        assert.deepEqual(
          await noted(),
          expected.map((r) => r.name),
        );
        assert.equal(new Set(expected.map((r) => r.name)).size, 2);
        const [forced] = await adminReal`
          select bool_and(relforcerowsecurity) as forced from pg_class
          where oid in (to_regclass('public.devices'), to_regclass('public.restaurants'))`;
        assert.equal(forced.forced, true, "FORCE is restored in the same file");
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
        await adminReal`delete from schema_migrations where name in ('900_plain.sql','901_target_only.sql','902_owner_pattern.sql')`;
        await adminReal`alter table devices drop column if exists fixture_note`;
        await adminReal`delete from devices where tenant_id = any(${tenants})`;
        await adminReal`delete from restaurants where id = any(${tenants})`;
        await adminReal`delete from organizations where id = ${org}`;
      }
    },
  );

  await check(
    "cutover: globals, database grants and ownership transfer let gm_migrator take over an owner-migrated database (R4)",
    async () => {
      const read = (f: string) => readFileSync(f, "utf8");
      await admin.unsafe(read("scripts/ops/sql/globals.sql"));
      // The same public local-only value CI uses; never a real credential.
      await admin.unsafe(
        "alter role gm_migrator login password 'local-only-migrator'",
      );
      await admin.unsafe(`create database "${legacy}"`);
      const legacyAdmin = pool(urlFor(legacy));
      // Today's staging: migrated by the database owner.
      assert.equal(
        await main([], {
          MIGRATION_DATABASE_URL: urlFor(legacy),
          APP_ENV: "development",
        }),
        0,
      );
      await legacyAdmin.unsafe(read("scripts/ops/sql/database-grants.sql"));
      await legacyAdmin.begin((tx) =>
        tx.unsafe(read("scripts/ops/sql/transfer-ownership.sql")),
      );
      const [owners] = await legacyAdmin`
        select array_agg(distinct tableowner) as owners from pg_tables where schemaname='public'`;
      assert.deepEqual(owners.owners, ["gm_migrator"]);
      const asMigrator = urlFor(legacy, {
        name: "gm_migrator",
        password: "local-only-migrator",
      });
      assert.equal(
        await main(["--grants", "--retention"], {
          MIGRATION_DATABASE_URL: asMigrator,
          PG_APP_USER: "gm_app",
          APP_ENV: "staging",
        }),
        0,
        "the non-superuser owner migrates, grants and prunes",
      );
      const appLegacy = new URL(runtime);
      appLegacy.pathname = "/" + legacy;
      await requireReadySchema(pool(appLegacy.href));
    },
  );

  await check("pooled host is refused", async () => {
    assert.equal(
      await main([], {
        ...env(),
        MIGRATION_DATABASE_URL:
          "postgresql://gm_migrator:x@ep-cool-name-123456-pooler.us-east-1.aws.neon.tech/neondb",
      }),
      2,
    );
    assert.ok(
      lines.some((l) => l.includes("migration_requires_direct_endpoint")),
    );
    assert.equal(await main(["--bogus"], env()), 2);
  });

  await check(
    "assertMigrationRole refuses a superuser when APP_ENV=staging",
    async () => {
      const superuser = pool(urlFor(synthetic));
      await assert.rejects(
        assertMigrationRole(superuser, "staging"),
        (e: any) => e.code === "migration_role_privileged",
      );
      await assertMigrationRole(superuser, "development");
      await assertMigrationRole(pool(migratorUrl), "production");
      assert.equal(
        await main([], { ...env(), MIGRATION_DATABASE_URL: urlFor(synthetic) }),
        1,
      );
    },
  );

  console.log(`Migration runner DB checks passed: ${passed()} checks.`);
} finally {
  for (const sql of pools) await sql.end({ timeout: 5 }).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
  await admin
    .unsafe(`drop database if exists "${synthetic}" with (force)`)
    .catch(() => undefined);
  await admin
    .unsafe(`drop database if exists "${legacy}" with (force)`)
    .catch(() => undefined);
  await admin
    .unsafe(`drop database if exists "${real}" with (force)`)
    .catch(() => undefined);
  await admin
    .unsafe(`drop role if exists "${migrator}"`)
    .catch((e) => console.error(e.message));
  await admin.end();
}
