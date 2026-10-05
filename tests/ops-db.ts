import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { check, disposableLogins, passed } from "./ops-roles.js";
import { checkRole, connect, tenant, waitForDatabase } from "../server/db.js";
import { computeStatus } from "../server/ops/status.js";
import { reconcilePolicies } from "../server/ops/schema.js";
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
let backupDrop: (() => Promise<void>) | null = null;

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
      backupDrop = drop;
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
    },
  );

  console.log(
    `Ops DB checks passed: ${passed()} checks against ${new URL(runtime).pathname.slice(1)}.`,
  );
} finally {
  await backupDrop?.();
  await traced.end();
  await app.end();
  await admin.end();
}
