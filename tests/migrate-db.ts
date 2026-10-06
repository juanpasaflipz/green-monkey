import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { check, passed } from "./ops-roles.js";
import {
  applyGrants,
  applyGrantsTx,
  applyMigrations,
  assertMigrationRole,
  pendingMigrations,
  readMigrations,
} from "../server/ops/schema.js";
import type { Tx } from "../server/db.js";
import { main } from "../scripts/migrate.js";
import { requireReadySchema } from "../server/readiness.js";
import {
  createRetentionSchedule,
  RETENTION_LOCK_TIMEOUT_MS,
  RETENTION_STATEMENT_TIMEOUT_MS,
  retentionPass,
  runRetention,
} from "../server/ops/retention.js";
import { tenant } from "../server/db.js";
import type { Alert } from "../server/ops/alerts.js";
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

  await check(
    "grants commit in the newest migration's transaction: a grants failure rolls that migration back, success grants before its registry row (OPS-R11)",
    async () => {
      const manifests = mkdtempSync(join(tmpdir(), "gm-grants-"));
      try {
        write(
          "006_g1.sql",
          "SET LOCAL lock_timeout = '5s';\nCREATE TABLE g1(id int);\n",
        );
        write(
          "007_g2.sql",
          "SET LOCAL lock_timeout = '5s';\nCREATE TABLE g2(id int);\n",
        );
        const bad = join(manifests, "bad.sql"),
          good = join(manifests, "good.sql");
        writeFileSync(
          bad,
          "GRANT SELECT ON g1, g2, missing_table TO gm_app;\n",
        );
        writeFileSync(good, "GRANT SELECT ON g1, g2 TO gm_app;\n");
        const grantsFrom = (manifestPath: string) => (tx: Tx) =>
          applyGrantsTx(tx, {
            role: "gm_app",
            database: synthetic,
            manifestPath,
          });
        await assert.rejects(
          applyMigrations(sql, readMigrations(dir), {
            sleep: noSleep,
            beforeLastRecord: grantsFrom(bad),
          }),
          (e: any) =>
            e.code === "migration_failed" && e.detail.file === "007_g2.sql",
        );
        const recorded = await sql`
          select name from schema_migrations where name in ('006_g1.sql','007_g2.sql') order by name`;
        assert.deepEqual(
          recorded.map((r) => r.name),
          ["006_g1.sql"],
          "the earlier file committed on its own",
        );
        const [g2] =
          await sql`select to_regclass('public.g2') is null as absent`;
        assert.equal(
          g2.absent,
          true,
          "the newest migration rolled back with its failed grants",
        );
        assert.deepEqual(
          await applyMigrations(sql, readMigrations(dir), {
            sleep: noSleep,
            beforeLastRecord: grantsFrom(good),
          }),
          ["007_g2.sql"],
        );
        const [granted] = await sql`
          select has_table_privilege('gm_app', 'g1', 'SELECT') as g1,
                 has_table_privilege('gm_app', 'g2', 'SELECT') as g2`;
        assert.deepEqual({ ...granted }, { g1: true, g2: true });
      } finally {
        rmSync(manifests, { recursive: true, force: true });
      }
    },
  );

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
      lines.length = 0;
      assert.equal(await main(["--grants"], env()), 0);
      // The runtime grants rode in the newest migration's transaction.
      assert.ok(
        lines.some(
          (l) =>
            l.includes('"grants_applied"') &&
            l.includes(`"withMigration":"${readMigrations().at(-1)!.name}"`),
        ),
      );
      // The log carries the manifest's sha256 (nothing stores it yet).
      const manifestHash = createHash("sha256")
        .update(readFileSync("scripts/grants.sql"))
        .digest("hex");
      assert.ok(
        lines.some(
          (l) =>
            l.includes('"grants_applied"') &&
            l.includes(`"hash":"${manifestHash}"`),
        ),
        "grants_applied logs the manifest hash",
      );
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
    "--grants applies the 2.0 jobs-worker block: on `jobs`, gm_jobs_worker holds exactly SELECT, INSERT and UPDATE of the five runner columns",
    async () => {
      // Scoped to `jobs`: area blocks (-- 030 cfdi) grant the worker more tables.
      const adminReal = pool(urlFor(real));
      const [r] = await adminReal`
        select
          (select array_agg(a.privilege_type::text order by a.privilege_type)
             from pg_class c, aclexplode(c.relacl) a
            where c.oid = 'public.jobs'::regclass and a.grantee = 'gm_jobs_worker'::regrole) as table_privileges,
          (select array_agg(att.attname::text || ':' || a.privilege_type order by att.attname, a.privilege_type)
             from pg_attribute att, aclexplode(att.attacl) a
            where att.attrelid = 'public.jobs'::regclass and att.attnum > 0
              and a.grantee = 'gm_jobs_worker'::regrole) as column_privileges,
          has_table_privilege('gm_jobs_worker', 'public.jobs', 'DELETE') as can_delete,
          has_table_privilege('gm_jobs_worker', 'public.jobs', 'TRUNCATE') as can_truncate,
          has_schema_privilege('gm_jobs_worker', 'public', 'USAGE') as schema_usage`;
      assert.deepEqual(r.table_privileges, ["INSERT", "SELECT"]);
      assert.deepEqual(r.column_privileges, [
        "attempts:UPDATE",
        "error_code:UPDATE",
        "lease_until:UPDATE",
        "next_at:UPDATE",
        "state:UPDATE",
      ]);
      assert.equal(r.can_delete, false);
      assert.equal(r.can_truncate, false);
      assert.equal(r.schema_usage, true);
      for (const column of [
        "payload",
        "kind",
        "dedupe_key",
        "tenant_id",
        "id",
        "created_at",
      ]) {
        const [c] = await adminReal`
          select has_column_privilege('gm_jobs_worker', 'public.jobs', ${column}, 'UPDATE') as can_update`;
        assert.equal(c.can_update, false, `no UPDATE of jobs.${column}`);
      }
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
          (select array_agg(state_hash order by state_hash collate "C") from oauth_login_attempts) as oauth,
          (select array_agg(id::text order by id::text collate "C") from jobs where tenant_id=${tenantId}) as jobs,
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
    "the worker's retention schedule runs as the owner, never overlaps, and alerts retention_failed when it cannot run (OPS-R6)",
    async () => {
      const alerts: Alert[] = [];
      const alert = async (a: Alert) => void alerts.push(a);
      const schedule = createRetentionSchedule({ url: migratorUrl, alert });
      try {
        const [first, overlapping] = await Promise.all([
          schedule.runNow(),
          schedule.runNow(),
        ]);
        assert.deepEqual(first?.failed, []);
        assert.equal(
          overlapping,
          null,
          "a second run while one is active is skipped",
        );
        assert.ok(schedule.lastRunAt());
        assert.deepEqual(alerts, []);
      } finally {
        await schedule.stop();
      }
      const wrong = new URL(migratorUrl);
      wrong.password = "not-the-password";
      const broken = createRetentionSchedule({ url: wrong.href, alert });
      try {
        assert.equal((await broken.runNow())?.failed.length, 2);
        assert.deepEqual(
          alerts.map((a) => [a.key, a.severity, a.body]),
          [
            [
              "retention_failed",
              "warning",
              "retention_failed tables=oauth_login_attempts,jobs",
            ],
          ],
        );
      } finally {
        await broken.stop();
      }
    },
  );

  await check(
    "--retention-only (npm run ops:retention) deletes expired rows, applies no pending migration and no grants, and exits 1 when a table fails (OPS-R16)",
    async () => {
      const adminReal = pool(urlFor(real));
      const org = randomUUID(),
        tenantId = randomUUID();
      const doneOld = randomUUID(),
        doneRecent = randomUUID();
      await adminReal.begin(async (tx) => {
        await tx`insert into organizations(id,name) values(${org},'Retention-only fixture')`;
        await tx`insert into restaurants(id,organization_id,name) values(${tenantId},${org},'Retention-only fixture')`;
        for (const [id, created] of [
          [doneOld, "now() - interval '40 days'"],
          [doneRecent, "now()"],
        ])
          await tx.unsafe(
            `insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,created_at)
             values($1,$2,'kitchen_dispatch',$3,'{}','done',${created})`,
            [tenantId, id, id],
          );
      });
      try {
        // No PG_APP_USER: the mode never grants, so it needs no runtime role.
        lines.length = 0;
        assert.equal(
          await main(["--retention-only"], {
            MIGRATION_DATABASE_URL: migratorUrl,
            APP_ENV: "staging",
          }),
          0,
        );
        const [left] =
          await adminReal`select array_agg(id::text) as ids from jobs where tenant_id=${tenantId}`;
        assert.deepEqual(left.ids, [doneRecent], "only the old done job goes");
        for (const event of [
          "migrations_complete",
          "grants_applied",
          "policies_reconciled",
        ])
          assert.ok(
            !lines.some((l) => l.includes(`"${event}"`)),
            `${event} never runs in --retention-only`,
          );
        assert.ok(
          lines.some(
            (l) =>
              l.includes('"retention_only_complete"') &&
              l.includes('"ok":true'),
          ),
        );

        // A target with pending migrations and without the retention tables:
        // nothing is migrated, and the failed tables fail the run.
        const [before] =
          await sql`select count(*)::int as n from schema_migrations`;
        lines.length = 0;
        assert.equal(
          await main(["--retention-only"], {
            MIGRATION_DATABASE_URL: urlFor(synthetic),
            APP_ENV: "development",
          }),
          1,
        );
        assert.ok(lines.some((l) => l.includes('"retention_failed"')));
        const [after] =
          await sql`select count(*)::int as n from schema_migrations`;
        assert.equal(after.n, before.n, "no pending migration was applied");
        assert.equal(
          await main(["--check"], {
            ...env(),
            MIGRATION_DATABASE_URL: urlFor(synthetic),
          }),
          3,
          "the synthetic database is still pending",
        );

        for (const other of [
          "--grants",
          "--retention",
          "--grants-only",
          "--check",
          "--dry-run",
        ])
          assert.equal(
            await main(["--retention-only", other], env()),
            2,
            `--retention-only conflicts with ${other}`,
          );
      } finally {
        await adminReal.begin(async (tx) => {
          await tx`delete from jobs where tenant_id=${tenantId}`;
          await tx`delete from restaurants where id=${tenantId}`;
          await tx`delete from organizations where id=${org}`;
        });
      }
    },
  );

  await check(
    "retention holds jobs' ACCESS EXCLUSIVE lock only within its bounds: order-path inserts stay fast on a large table, a slow pass aborts and alerts, and a blocked ALTER queues inserts at most the lock timeout (OPS-R10)",
    async () => {
      const adminReal = pool(urlFor(real));
      const owner = pool(migratorUrl);
      const org = randomUUID(),
        tenantId = randomUUID();
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // What an order or a payment does: one jobs insert as the runtime role.
      const insertJob = async () => {
        const t = performance.now();
        await tenant(
          app,
          tenantId,
          (tx) =>
            tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload)
               values(${tenantId},${randomUUID()},'kitchen_dispatch',${randomUUID()},'{}')`,
        );
        return performance.now() - t;
      };
      const jobsLock = async (granted: boolean) => {
        const [row] = await adminReal`
          select count(*)::int as n from pg_locks
          where database = (select oid from pg_database where datname = current_database())
            and relation = 'public.jobs'::regclass
            and mode = 'AccessExclusiveLock' and granted = ${granted}`;
        return row.n > 0;
      };
      const waitFor = async (what: string, probe: () => Promise<boolean>) => {
        const deadline = Date.now() + 10_000;
        while (!(await probe())) {
          if (Date.now() > deadline) throw Error(`timed out waiting: ${what}`);
          await sleep(5);
        }
      };
      const bound = RETENTION_LOCK_TIMEOUT_MS + RETENTION_STATEMENT_TIMEOUT_MS;
      try {
        await adminReal.begin(async (tx) => {
          await tx`insert into organizations(id,name) values(${org},'Retention lock fixture')`;
          await tx`insert into restaurants(id,organization_id,name) values(${tenantId},${org},'Retention lock fixture')`;
          // A large table retention must keep (recent done jobs, blocked
          // receipts that never expire) plus 40 expired done jobs.
          await tx`
            insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,created_at)
            select ${tenantId}, gen_random_uuid(), 'kitchen_dispatch', 'keep-' || g, '{}',
                   case when g % 2 = 0 then 'done' else 'blocked' end,
                   case when g % 2 = 0 then now() - interval '1 day' else now() - interval '40 days' end
            from generate_series(1, 200000) g`;
          await tx`
            insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,created_at)
            select ${tenantId}, gen_random_uuid(), 'kitchen_dispatch', 'expired-' || g, '{}',
                   'done', now() - interval '40 days'
            from generate_series(1, 40) g`;
        });
        await adminReal`analyze jobs`;

        // 1. A real pass over the large table while orders keep inserting.
        const latencies: number[] = [];
        let stop = false;
        const traffic = (async () => {
          while (!stop) latencies.push(await insertJob());
        })();
        const result = await runRetention(owner);
        stop = true;
        await traffic;
        assert.deepEqual(result.failed, []);
        assert.ok(result.deleted.jobs >= 40);
        const [kept] = await adminReal`
          select count(*) filter (where dedupe_key like 'keep-%')::int as kept,
                 count(*) filter (where dedupe_key like 'expired-%')::int as expired
          from jobs where tenant_id = ${tenantId}`;
        assert.deepEqual({ ...kept }, { kept: 200000, expired: 0 });
        assert.ok(latencies.length > 0, "orders inserted during the pass");
        assert.ok(
          Math.max(...latencies) < bound + 500,
          `inserts stayed under the bound (max ${Math.round(Math.max(...latencies))} ms)`,
        );

        // 2. A pass whose DELETE outgrows the bound (a 100 ms trigger per
        // row stands in for a scan of a production-sized table: 40 rows are
        // 4 s unbounded) aborts at the statement timeout, rolls back, alerts,
        // and an order that arrives while it holds the lock waits only that
        // long.
        await adminReal.unsafe(
          `create function retention_slow_delete() returns trigger language plpgsql as $f$ begin perform pg_sleep(0.1); return old; end $f$`,
        );
        await adminReal.unsafe(
          `create trigger retention_slow_delete before delete on jobs for each row execute function retention_slow_delete()`,
        );
        await adminReal`
          insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,created_at)
          select ${tenantId}, gen_random_uuid(), 'kitchen_dispatch', 'slow-' || g, '{}',
                 'done', now() - interval '40 days'
          from generate_series(1, 40) g`;
        const alerts: Alert[] = [];
        lines.length = 0;
        const slowPass = retentionPass(owner, async (a) => void alerts.push(a));
        await waitFor("retention holds the jobs lock", () => jobsLock(true));
        const waited = await insertJob();
        const slow = await slowPass;
        assert.deepEqual(slow?.failed, ["jobs"]);
        assert.ok(
          lines.some(
            (l) =>
              l.includes('"retention_table_failed"') &&
              l.includes('"statement_timeout"'),
          ),
        );
        assert.deepEqual(
          alerts.map((a) => a.body),
          ["retention_failed tables=jobs"],
        );
        assert.ok(
          waited >= 200,
          `the insert really waited behind retention's lock (${Math.round(waited)} ms)`,
        );
        assert.ok(
          waited < bound + 500,
          `the insert waited at most the bound (${Math.round(waited)} ms, unbounded 4000 ms)`,
        );
        const [slowLeft] = await adminReal`
          select count(*)::int as n,
                 (select relforcerowsecurity from pg_class where oid = 'public.jobs'::regclass) as forced
          from jobs where tenant_id = ${tenantId} and dedupe_key like 'slow-%'`;
        assert.deepEqual(
          { ...slowLeft },
          { n: 40, forced: true },
          "the aborted batch rolled back, FORCE included",
        );
        await adminReal.unsafe(`drop trigger retention_slow_delete on jobs`);
        await adminReal.unsafe(`drop function retention_slow_delete()`);

        // 3. While a long reader (the nightly pg_dump) holds ACCESS SHARE,
        // the ALTER waits; inserts queue behind it at most the lock timeout.
        const holder = pool(urlFor(real), 1);
        let release!: () => void;
        const released = new Promise<void>((r) => (release = r));
        let holding!: () => void;
        const holds = new Promise<void>((r) => (holding = r));
        const held = holder.begin(async (tx) => {
          await tx`lock table jobs in access share mode`;
          holding();
          await released;
        });
        await holds;
        const blocked = runRetention(owner);
        await waitFor("retention's ALTER is waiting", () => jobsLock(false));
        const queued = await insertJob();
        const skipped = await blocked;
        release();
        await held;
        assert.deepEqual(skipped.skipped, ["jobs"]);
        assert.ok(
          queued < RETENTION_LOCK_TIMEOUT_MS + 400,
          `an insert queued behind the waiting ALTER for at most the lock timeout (${Math.round(queued)} ms)`,
        );
      } finally {
        await adminReal
          .unsafe(`drop trigger if exists retention_slow_delete on jobs`)
          .catch(() => undefined);
        await adminReal
          .unsafe(`drop function if exists retention_slow_delete()`)
          .catch(() => undefined);
        await adminReal.begin(async (tx) => {
          await tx`delete from jobs where tenant_id=${tenantId}`;
          await tx`delete from restaurants where id=${tenantId}`;
          await tx`delete from organizations where id=${org}`;
        });
      }
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
