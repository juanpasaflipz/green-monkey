import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { check, disposableLogins, passed } from "./ops-roles.js";
import {
  checkRole,
  checkWorkerRole,
  connect,
  tenant,
  waitForDatabase,
  type Tx,
} from "../server/db.js";
import { computeStatus } from "../server/ops/status.js";
import { assertRuntimeRole, reconcilePolicies } from "../server/ops/schema.js";
import { setLogSink } from "../server/logging.js";

setLogSink(() => {});
const { runtime, migration } = isolatedTarget(process.env);
const admin = postgres(migration, { max: 2, onnotice: () => {} });
const statements: string[] = [];
// The runtime pool exactly as the web process builds it.
const app = connect(runtime);
// A second runtime pool that records every statement it sends.
const traced = postgres(runtime, {
  max: 1,
  debug: (_connection, query) => statements.push(query),
});
const tenantId = "10000000-0000-4000-8000-000000000001";
const contractIndexes = [
  "audit_tenant_id_created_at",
  "billing_events_subscription_id",
  "billing_operations_available_at",
  "cash_movements_tenant_id_session_id",
  "cash_sessions_tenant_id_closed_at",
  "jobs_state_next_at",
  "jobs_tenant_id_created_at",
  "refunds_tenant_id_created_at",
  "refunds_tenant_id_session_id",
  "tenders_tenant_id_created_at",
  "tenders_tenant_id_session_id",
];
const rejects = async (promise: Promise<unknown>, pattern: RegExp) =>
  assert.rejects(promise, (e: any) => {
    assert.match(`${e?.code ?? ""} ${e?.message ?? ""}`, pattern);
    return true;
  });
const cleanup: { drop?: () => Promise<void>; roles?: () => Promise<void> } = {};

try {
  await check(
    "the runtime pool connects through waitForDatabase and checkRole",
    async () => {
      await waitForDatabase(app);
      await checkRole(app);
    },
  );

  await check(
    "022 creates exactly the contract's hot-path indexes (DB-3)",
    async () => {
      const rows = await admin`
        select indexname from pg_indexes
        where schemaname='public' and indexname = any(${contractIndexes})`;
      assert.deepEqual(rows.map((r) => r.indexname).sort(), contractIndexes);
      const [claim] = await admin`
        select pg_get_indexdef(indexrelid) as def from pg_index
        where indexrelid = to_regclass('public.jobs_state_next_at')`;
      assert.match(
        claim.def,
        /WHERE \(state = ANY \(ARRAY\['queued'::text, 'available'::text\]\)\)/,
      );
    },
  );

  await check(
    "drawer, report and jobs queries can use the new indexes (EXPLAIN with enable_seqscan=off)",
    async () => {
      const plan = async (query: string, params: unknown[]) =>
        (
          await tenant(app, tenantId, async (tx) => {
            await tx`set local enable_seqscan = off`;
            return tx.unsafe(`explain ${query}`, params as any[]);
          })
        )
          .map((r: any) => r["QUERY PLAN"])
          .join("\n");
      assert.match(
        await plan(
          `select coalesce(sum(amount),0) from tenders where session_id=$1`,
          [randomUUID()],
        ),
        /tenders_tenant_id_session_id/,
      );
      assert.match(
        await plan(
          `select coalesce(sum(amount),0) from cash_movements where session_id=$1`,
          [randomUUID()],
        ),
        /cash_movements_tenant_id_session_id/,
      );
      assert.match(
        await plan(
          `select * from audit order by created_at desc limit 100`,
          [],
        ),
        /audit_tenant_id_created_at/,
      );
      assert.match(
        await plan(
          `select id from jobs where state in ('queued','available') and next_at <= now() order by next_at limit 5`,
          [],
        ),
        /jobs_state_next_at|jobs_tenant_id_created_at/,
      );
    },
  );

  await check(
    "every public table except schema_migrations has RLS enabled and forced",
    async () => {
      const rows = await admin`
        select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p')
          and not (c.relrowsecurity and c.relforcerowsecurity)
          and c.relname <> 'schema_migrations'`;
      assert.deepEqual(
        rows.map((r) => r.relname),
        [],
      );
    },
  );

  await check("runtime cannot DELETE anywhere", async () => {
    const rows = await admin`
      select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p')
        and has_table_privilege('gm_app', c.oid, 'DELETE')`;
    assert.deepEqual(
      rows.map((r) => r.relname),
      [],
    );
    await rejects(
      tenant(app, tenantId, (tx) => tx`delete from jobs`),
      /permission denied|42501/,
    );
  });

  await check(
    "neither the runtime nor gm_jobs_worker holds DELETE, TRUNCATE, REFERENCES or TRIGGER on any table; every table gm_jobs_worker reaches forces RLS; its policies on jobs are SELECT only (PLATFORM-ROLES-5)",
    async () => {
      // TRUNCATE ignores row-level security entirely; REFERENCES and TRIGGER
      // let a login lock or observe other tenants' rows. A future exception is
      // listed here explicitly, never granted silently.
      const allowed: string[] = [];
      const held = await admin`
        select r.role || ' ' || p.priv || ' ' || c.relname as grant
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        cross join (values ('gm_app'), ('gm_jobs_worker')) r(role)
        cross join (values ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
        where n.nspname='public' and c.relkind in ('r','p')
          and to_regrole(r.role) is not null
          and has_table_privilege(r.role, c.oid, p.priv)
        order by 1`;
      assert.deepEqual(
        held.map((r) => r.grant).filter((g) => !allowed.includes(g)),
        [],
      );
      const reach = await admin`
        select c.relname, c.relrowsecurity and c.relforcerowsecurity as forced
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p')
          and has_any_column_privilege('gm_jobs_worker', c.oid, 'SELECT, INSERT, UPDATE')
        order by 1`;
      assert.ok(
        reach.some((r) => r.relname === "jobs"),
        "the worker reaches jobs",
      );
      assert.deepEqual(
        reach.filter((r) => !r.forced).map((r) => r.relname),
        [],
      );
      const policies = await admin`
        select policyname, cmd from pg_policies
        where schemaname='public' and tablename='jobs' and 'gm_jobs_worker' = any(roles)`;
      assert.deepEqual(
        policies.filter((p) => p.cmd !== "SELECT").map((p) => p.policyname),
        [],
      );
    },
  );

  await check(
    "tenant() sets the tenant and statement_timeout in one statement (OPS-7 regression)",
    async () => {
      const [inside] = await tenant(
        app,
        tenantId,
        (tx) =>
          tx`select current_setting('statement_timeout') as timeout, current_setting('app.tenant_id') as tenant`,
      );
      assert.deepEqual({ ...inside }, { timeout: "10s", tenant: tenantId });
      // SET LOCAL semantics: nothing leaks to the next use of the connection.
      const [after] =
        await app`select current_setting('app.tenant_id', true) as tenant`;
      assert.ok(!after.tenant, "tenant GUC is transaction-local");
      await traced`select 1`; // connection setup (type fetch) happens once
      statements.length = 0;
      await tenant(traced, tenantId, (tx) => tx`select 1`);
      const setConfig = statements.filter((q) => q.includes("set_config"));
      assert.equal(setConfig.length, 1, "one set_config statement");
      assert.match(setConfig[0], /app\.tenant_id.*statement_timeout/s);
      assert.equal(
        statements.length,
        4,
        `BEGIN, set_config, handler, COMMIT (got ${JSON.stringify(statements)})`,
      );
    },
  );

  await check(
    "a statement over the tenant timeout is cancelled with 57014",
    async () => {
      await rejects(
        tenant(app, tenantId, async (tx) => {
          await tx`select set_config('statement_timeout','200',true)`;
          await tx`select pg_sleep(1)`;
        }),
        /57014|statement timeout/,
      );
    },
  );

  await check(
    "every RLS table gets ops_backup_read; the backup reader sees all tenants with row_security=on",
    async () => {
      await admin`
        do $$ begin
          if to_regrole('gm_backup_reader') is null then
            create role gm_backup_reader nologin nosuperuser nocreatedb nocreaterole nobypassrls;
          end if;
        end $$`;
      await reconcilePolicies(admin);
      const missing = await admin`
        select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity
          and not exists(select 1 from pg_policies p where p.schemaname='public'
                         and p.tablename=c.relname and p.policyname='ops_backup_read')`;
      assert.deepEqual(
        missing.map((r) => r.relname),
        [],
      );
      const { logins, drop } = await disposableLogins(admin, runtime, {
        backup: ["gm_backup_reader"],
      });
      cleanup.drop = drop;
      const [expected] = await admin`
        select count(*)::int as n, count(distinct tenant_id)::int as tenants from employees`;
      assert.ok(expected.tenants >= 2, "fixture has two tenants");
      const [seen] = await logins.backup.sql.begin(async (tx) => {
        await tx`set local row_security = on`;
        return tx`select count(*)::int as n, count(distinct tenant_id)::int as tenants from employees`;
      });
      assert.deepEqual({ ...seen }, { ...expected });
      await rejects(
        logins.backup.sql`update employees set name=name`,
        /permission denied|42501/,
      );
      // The runtime role gains nothing from the reconciler.
      const [runtimeView] = await app`select count(*)::int as n from employees`;
      assert.equal(runtimeView.n, 0, "runtime still needs the tenant GUC");
    },
  );

  await check(
    "ops status reports db and schema readiness without tenant data",
    async () => {
      const status = await computeStatus(app);
      assert.equal(status.db, "ok");
      assert.equal(status.schema, "ready");
      assert.equal(status.worker.status, "unknown");
      assert.equal(status.degraded, true, "no worker configured");
      assert.deepEqual(Object.keys(status).sort(), [
        "commit",
        "db",
        "degraded",
        "ok",
        "schema",
        "version",
        "worker",
      ]);
      assert.deepEqual(status.worker, {
        status: "unknown",
        lastBeatAt: null,
        commit: null,
        jobs: null,
      });
    },
  );

  await check(
    "ops status passes the worker's commit and jobs flag through; a deployed worker without jobs is degraded (PLATFORM-OPS-2, OPS-4)",
    async () => {
      const sha = "0123456789abcdef0123456789abcdef01234567";
      const healthz =
        (body: unknown, status = 200): typeof fetch =>
        async () =>
          new Response(JSON.stringify(body), { status });
      const beat = new Date().toISOString();
      const healthy = { ok: true, commit: sha, jobs: true, lastTickAt: beat };
      const live = await computeStatus(app, {
        workerUrl: "http://worker.invalid",
        fetch: healthz(healthy),
        requireJobs: true,
      });
      assert.deepEqual(live.worker, {
        status: "ok",
        lastBeatAt: beat,
        commit: sha,
        jobs: true,
      });
      assert.equal(live.degraded, false);
      const noJobs = await computeStatus(app, {
        workerUrl: "http://worker.invalid",
        fetch: healthz({ ...healthy, jobs: false }),
        requireJobs: true,
      });
      assert.equal(noJobs.worker.status, "ok");
      assert.equal(noJobs.worker.jobs, false);
      assert.equal(noJobs.degraded, true, "deployed: jobs off is degraded");
      assert.equal(
        (
          await computeStatus(app, {
            workerUrl: "http://worker.invalid",
            fetch: healthz({ ...healthy, jobs: false }),
            requireJobs: false,
          })
        ).degraded,
        false,
        "development: a worker without jobs is fine",
      );
      // Anything but a commit-shaped string or a boolean is dropped, never echoed.
      const odd = await computeStatus(app, {
        workerUrl: "http://worker.invalid",
        fetch: healthz({ ...healthy, commit: "<script>", jobs: "yes" }),
        requireJobs: true,
      });
      assert.deepEqual([odd.worker.commit, odd.worker.jobs], [null, null]);
      assert.equal(odd.degraded, true);
      const down = await computeStatus(app, {
        workerUrl: "http://worker.invalid",
        fetch: healthz({ ok: false, commit: sha, jobs: true }, 503),
      });
      assert.equal(down.worker.status, "stale");
      assert.equal(down.degraded, true);
    },
  );

  // Wave 2.0 (e): one membership list (server/roles.ts) for every login check.
  // Roles are cluster-global, so these checks create disposable logins and
  // never drop or alter a capability role.
  const { logins, drop } = await disposableLogins(admin, runtime, {
    plain: [],
    jobs: ["gm_jobs_worker"],
    support: ["gm_support"],
    backup: ["gm_backup_reader"],
    migrator: ["gm_migrator"],
    createdb: [],
    worker: ["gm_jobs_worker"],
    workerBilling: ["gm_jobs_worker", "gm_billing_worker"],
    workerSupport: ["gm_jobs_worker", "gm_support"],
    workerBackup: ["gm_jobs_worker", "gm_backup_reader"],
    workerMigrator: ["gm_jobs_worker", "gm_migrator"],
    workerBypass: ["gm_jobs_worker"],
    workerCreaterole: ["gm_jobs_worker"],
    workerCreatedb: ["gm_jobs_worker"],
    workerOwner: ["gm_jobs_worker"],
  });
  cleanup.roles = drop;
  await admin.unsafe(`alter role "${logins.createdb.role}" createdb`);
  await admin.unsafe(`alter role "${logins.workerBypass.role}" bypassrls`);
  await admin.unsafe(`alter role "${logins.workerCreaterole.role}" createrole`);
  await admin.unsafe(`alter role "${logins.workerCreatedb.role}" createdb`);
  const ownedTable = `opstest_owned_${randomBytes(4).toString("hex")}`;

  await check(
    "checkRole rejects runtime logins that are members of gm_jobs_worker, gm_support, gm_backup_reader or gm_migrator, or have CREATEDB",
    async () => {
      await checkRole(logins.plain.sql);
      for (const name of ["jobs", "support", "backup", "migrator", "createdb"])
        await rejects(
          checkRole(logins[name].sql),
          /Runtime role must not bypass RLS/,
        );
    },
  );

  await check(
    "checkRole and checkWorkerRole also refuse a login that can SET ROLE to a role with BYPASSRLS or SUPERUSER, or to a role that owns a table (PLATFORM-ROLES-2)",
    async () => {
      const tag = randomBytes(4).toString("hex");
      const bypass = `gm_test_bypassing_${tag}`;
      const owner = `gm_test_owning_${tag}`;
      const table = `opstest_owned_by_role_${tag}`;
      await admin.unsafe(`create role "${bypass}" nologin bypassrls`);
      await admin.unsafe(`create role "${owner}" nologin`);
      await admin.unsafe(`create table "${table}" (id int)`);
      await admin.unsafe(`alter table "${table}" owner to "${owner}"`);
      const reach = await disposableLogins(admin, runtime, {
        viaBypass: [bypass],
        viaOwner: [owner],
        workerViaBypass: ["gm_jobs_worker", bypass],
        workerViaOwner: ["gm_jobs_worker", owner],
      });
      try {
        await rejects(
          checkRole(reach.logins.viaBypass.sql),
          /Runtime role must not bypass RLS/,
        );
        await rejects(
          checkRole(reach.logins.viaOwner.sql),
          /Runtime role must not own application tables/,
        );
        await rejects(
          checkWorkerRole(reach.logins.workerViaBypass.sql),
          /Worker role must be a gm_jobs_worker member without other privileges/,
        );
        await rejects(
          checkWorkerRole(reach.logins.workerViaOwner.sql),
          /Worker role must not own application tables/,
        );
        // The plain runtime and worker logins still pass.
        await checkRole(logins.plain.sql);
        await checkWorkerRole(logins.worker.sql);
      } finally {
        await reach.drop();
        await admin.unsafe(`drop table if exists "${table}"`);
        await admin.unsafe(`drop role if exists "${bypass}"`);
        await admin.unsafe(`drop role if exists "${owner}"`);
      }
    },
  );

  await check(
    "checkWorkerRole accepts a gm_jobs_worker member; rejects a non-member, any other capability or gm_migrator membership, BYPASSRLS, CREATEROLE, CREATEDB and a table owner",
    async () => {
      await checkWorkerRole(logins.worker.sql);
      for (const name of [
        "plain",
        "support",
        "workerBilling",
        "workerSupport",
        "workerBackup",
        "workerMigrator",
        "workerBypass",
        "workerCreaterole",
        "workerCreatedb",
      ])
        await rejects(
          checkWorkerRole(logins[name].sql),
          /Worker role must be a gm_jobs_worker member without other privileges/,
        );
      await admin.unsafe(`create table "${ownedTable}" (id int)`);
      try {
        await admin.unsafe(
          `alter table "${ownedTable}" owner to "${logins.workerOwner.role}"`,
        );
        await rejects(
          checkWorkerRole(logins.workerOwner.sql),
          /Worker role must not own application tables/,
        );
      } finally {
        await admin.unsafe(`drop table if exists "${ownedTable}"`);
      }
      // The runtime check refuses the worker login too.
      await rejects(
        checkRole(logins.worker.sql),
        /Runtime role must not bypass RLS/,
      );
    },
  );

  await check(
    "assertRuntimeRole refuses gm_support membership (runtime_role_privileged)",
    async () => {
      for (const name of ["support", "jobs", "backup", "migrator"])
        await rejects(
          admin.begin((raw) => assertRuntimeRole(raw as Tx, logins[name].role)),
          /runtime_role_privileged/,
        );
      await admin.begin((raw) =>
        assertRuntimeRole(raw as Tx, logins.plain.role),
      );
    },
  );

  await check(
    "the 2.0 grants guard raises the actionable message when either role is missing",
    async () => {
      const manifest = readFileSync("scripts/grants.sql", "utf8");
      const guard = manifest.match(
        /DO \$\$ BEGIN\n IF to_regrole\('gm_jobs_worker'\)[\s\S]*?END \$\$;/,
      )?.[0];
      assert.ok(guard, "the -- 2.0 jobs worker guard block");
      assert.ok(
        manifest.indexOf("-- 2.0 jobs worker") < manifest.indexOf(guard),
        "the guard belongs to the 2.0 block",
      );
      await admin.unsafe(guard);
      const absent = "gm_absent_" + randomBytes(4).toString("hex");
      for (const role of ["gm_jobs_worker", "gm_support"])
        await rejects(
          admin.unsafe(
            guard.replace(`to_regrole('${role}')`, `to_regrole('${absent}')`),
          ),
          /role gm_jobs_worker or gm_support is missing: run scripts\/ops\/sql\/globals\.sql as the database owner first \(docs\/PROVISIONING\.md\)/,
        );
    },
  );

  console.log(
    `Ops DB checks passed: ${passed()} checks against ${new URL(runtime).pathname.slice(1)}.`,
  );
} finally {
  await cleanup.drop?.();
  await cleanup.roles?.();
  await traced.end();
  await app.end();
  await admin.end();
}
