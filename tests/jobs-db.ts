import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { check, passed } from "./ops-roles.js";
import { connect, tenant } from "../server/db.js";
import {
  enqueueJob,
  handlers,
  MAX_ATTEMPTS,
  registerJobHandler,
} from "../server/jobs.js";
import {
  claimJobs,
  completeJob,
  extendLease,
  failJob,
  requeueJob,
} from "../server/jobs/queue.js";
import { createJobRunner } from "../server/jobs/runner.js";
import { setLogSink } from "../server/logging.js";
import { catalog, createOrder } from "../server/orders.js";
import type { Session } from "../shared/domain.js";

setLogSink(() => {});
const { runtime, migration } = isolatedTarget(process.env);
const admin = postgres(migration, { max: 1, onnotice: () => {} });
// Two runtime pools play two web instances (deploy overlap).
const app = connect(runtime);
const second = connect(runtime);
const tenantId = "10000000-0000-4000-8000-000000000001";
const otherTenantId = "10000000-0000-4000-8000-000000000002";
const kind = "ops_test_" + randomUUID().slice(0, 8);
const base = {
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  deviceId: "30000000-0000-4000-8000-000000000001",
  restaurant: {
    name: "Test",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
  },
};
const owner: Session = {
  ...base,
  id: randomUUID(),
  tenantId,
  employeeId: "20000000-0000-4000-8000-000000000001",
  name: "Owner",
  role: "owner",
};
const other: Session = { ...owner, tenantId: otherTenantId };
const cashier: Session = { ...owner, role: "cashier" };
const enqueue = (s: Session, dedupeKey: string, state?: "blocked") =>
  tenant(app, s.tenantId, (tx) =>
    enqueueJob(tx, s, { kind, dedupeKey, payload: { dedupeKey }, state }),
  );
const claim = (sql: postgres.Sql, s: Session, n = 1, lease = 60) =>
  tenant(sql, s.tenantId, (tx) => claimJobs(tx, [kind], n, lease));
const rows = () =>
  admin`select id, tenant_id, state, attempts, error_code from jobs where kind=${kind} order by created_at, id`;

try {
  await check("enqueueJob dedupes per (tenant, kind, dedupe_key)", async () => {
    await enqueue(owner, "dedupe");
    await enqueue(owner, "dedupe");
    await enqueue(other, "dedupe");
    const all = await rows();
    assert.equal(all.length, 2);
    assert.deepEqual(
      new Set(all.map((r) => r.tenant_id)),
      new Set([tenantId, otherTenantId]),
    );
    assert.ok(all.every((r) => r.state === "available"));
    await admin`delete from jobs where kind=${kind}`;
  });

  await check("two runners never lease the same job", async () => {
    for (let i = 0; i < 24; i++) await enqueue(owner, `c${i}`);
    const seen: string[] = [];
    await Promise.all(
      [app, second, app, second].map(async (sql) => {
        for (;;) {
          const jobs = await claim(sql, owner, 3);
          if (!jobs.length) return;
          seen.push(...jobs.map((j) => j.id));
        }
      }),
    );
    assert.equal(seen.length, 24);
    assert.equal(new Set(seen).size, 24);
    assert.deepEqual(
      await claim(app, other, 10),
      [],
      "RLS keeps tenants apart",
    );
    await admin`delete from jobs where kind=${kind}`;
  });

  await check(
    "a stale lease cannot complete or fail; extendLease renews the fence",
    async () => {
      await enqueue(owner, "stale");
      const [job] = await claim(app, owner);
      const stale = { ...job, lease: "2000-01-01 00:00:00+00" };
      assert.equal(await completeJob(app, stale), false);
      assert.equal(await failJob(app, stale, { code: "late" }), "lost");
      assert.equal(await extendLease(app, stale, 60), null);
      const renewed = await extendLease(app, job, 90);
      assert.ok(renewed && renewed !== job.lease);
      assert.equal(await completeJob(app, job), false, "the old fence is gone");
      assert.equal(await completeJob(app, { ...job, lease: renewed! }), true);
      const [row] = await rows();
      assert.equal(row.state, "done");
      await admin`delete from jobs where kind=${kind}`;
    },
  );

  await check(
    "an expired lease is reclaimed and the old holder is fenced out",
    async () => {
      await enqueue(owner, "expired");
      const [first] = await claim(app, owner);
      assert.deepEqual(await claim(second, owner), []);
      await admin`update jobs set lease_until=now()-interval '1 second' where id=${first.id}`;
      const [again] = await claim(second, owner);
      assert.equal(again.id, first.id);
      assert.equal(again.attempts, 2);
      assert.equal(await completeJob(app, first), false);
      assert.equal(await completeJob(second, again), true);
      await admin`delete from jobs where kind=${kind}`;
    },
  );

  await check(
    `retry schedules next_at with backoff; attempt ${MAX_ATTEMPTS} → dead`,
    async () => {
      await enqueue(owner, "retry");
      const [job] = await claim(app, owner);
      assert.equal(
        await failJob(app, job, { code: "provider_timeout" }),
        "retry",
      );
      const [row] = await admin`
      select state, error_code, extract(epoch from next_at - now())::int as wait, lease_until
      from jobs where id=${job.id}`;
      assert.equal(row.state, "available");
      assert.equal(row.error_code, "provider_timeout");
      assert.equal(row.lease_until, null);
      assert.ok(
        row.wait >= 20 && row.wait <= 40,
        `first retry waits ~30 s, got ${row.wait}`,
      );
      assert.deepEqual(await claim(app, owner), [], "not before next_at");
      await admin`update jobs set next_at=now(), attempts=${MAX_ATTEMPTS - 1} where id=${job.id}`;
      const [last] = await claim(app, owner);
      assert.equal(last.attempts, MAX_ATTEMPTS);
      assert.equal(
        await failJob(app, last, { code: "provider_timeout" }),
        "dead",
      );
      const [dead] = await rows();
      assert.equal(dead.state, "dead");
    },
  );

  await check(
    "requeueJob resets a dead job for managers only; blocked jobs are not requeued",
    async () => {
      const [dead] = await rows();
      await assert.rejects(
        tenant(app, tenantId, (tx) => requeueJob(tx, cashier, dead.id)),
        /forbidden/,
      );
      await assert.rejects(
        tenant(app, otherTenantId, (tx) => requeueJob(tx, other, dead.id)),
        /not_found/,
      );
      await tenant(app, tenantId, (tx) => requeueJob(tx, owner, dead.id));
      const [row] =
        await admin`select state, attempts, error_code from jobs where id=${dead.id}`;
      assert.deepEqual(
        { ...row },
        { state: "available", attempts: 0, error_code: null },
      );
      await enqueue(owner, "blocked", "blocked");
      const [blocked] =
        await admin`select id from jobs where kind=${kind} and state='blocked'`;
      await assert.rejects(
        tenant(app, tenantId, (tx) => requeueJob(tx, owner, blocked.id)),
        /job_not_requeueable/,
      );
      await admin`delete from jobs where kind=${kind}`;
    },
  );

  await check(
    "handler ctx.tenant is tenant-scoped; kinds without a handler and blocked jobs are untouched",
    async () => {
      const probe = kind + "_scope";
      const seen: unknown[] = [];
      registerJobHandler(probe, async (ctx) => {
        const [r] = await ctx.tenant(
          (tx) =>
            tx`select count(distinct tenant_id)::int as tenants, bool_and(tenant_id=${ctx.job.tenantId}) as own from employees`,
        );
        seen.push({ ...r });
      });
      await tenant(app, tenantId, async (tx) => {
        await enqueueJob(tx, owner, {
          kind: probe,
          dedupeKey: "scope",
          payload: {},
        });
        await enqueueJob(tx, owner, {
          kind,
          dedupeKey: "no-handler",
          payload: {},
        });
        await enqueueJob(tx, owner, {
          kind: probe,
          dedupeKey: "blocked",
          payload: {},
          state: "blocked",
        });
      });
      const only = new Map([[probe, handlers().get(probe)!]]);
      const runner = createJobRunner(app, { handlers: () => only });
      assert.equal(await runner.drainTenant(tenantId), 1);
      await runner.stop(5000);
      assert.deepEqual(seen, [{ tenants: 1, own: true }]);
      const states = await admin`
      select kind, dedupe_key, state from jobs where kind in (${probe}, ${kind}) order by dedupe_key`;
      assert.deepEqual(
        states.map((r) => `${r.dedupe_key}:${r.state}`),
        ["blocked:blocked", "no-handler:available", "scope:done"],
      );
      await admin`delete from jobs where kind in (${probe}, ${kind})`;
    },
  );

  await check(
    "kitchen_dispatch jobs drain to done after a tenant write (OPS-15 regression)",
    async () => {
      const products = await tenant(app, tenantId, (tx) => catalog(tx));
      const product = products.find(
        (p) => p.available && p.groups.length === 0,
      )!;
      assert.ok(product, "fixture needs a simple product");
      const order = await tenant(app, tenantId, (tx) =>
        createOrder(tx, owner, {
          operationId: randomUUID(),
          lines: [
            {
              id: randomUUID(),
              productId: product.id,
              quantity: 1,
              options: [],
              note: "",
            },
          ],
          mode: "takeaway",
          tableId: null,
          name: "Jobs drain",
          note: "",
          channel: "pos",
        }),
      );
      const pending = await admin`
      select id, state from jobs where kind='kitchen_dispatch' and payload->>'orderId'=${order.id}`;
      assert.deepEqual(
        pending.map((r) => r.state),
        ["available"],
      );
      const runner = createJobRunner(app, { debounceMs: 10 });
      runner.start();
      runner.noteTenant(tenantId);
      for (let i = 0; i < 100; i++) {
        const [row] =
          await admin`select state from jobs where id=${pending[0].id}`;
        if (row.state === "done") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await runner.stop(5000);
      const [row] =
        await admin`select state, lease_until, error_code from jobs where id=${pending[0].id}`;
      assert.deepEqual(
        { ...row },
        { state: "done", lease_until: null, error_code: null },
      );
      const receipts = await admin`
      select count(*)::int as n from jobs where kind='receipt' and state<>'blocked'`;
      assert.equal(receipts[0].n, 0, "receipt jobs stay blocked");
    },
  );

  await check(
    "a throwing handler retries with its error code; dead jobs reach onDead",
    async () => {
      const failing = kind + "_fail";
      registerJobHandler(failing, async () => {
        throw Object.assign(new Error("provider down"), {
          code: "provider_down",
        });
      });
      await tenant(app, tenantId, (tx) =>
        enqueueJob(tx, owner, { kind: failing, dedupeKey: "f", payload: {} }),
      );
      const dead: string[] = [];
      const only = new Map([[failing, handlers().get(failing)!]]);
      const runner = createJobRunner(app, {
        handlers: () => only,
        onDead: (job, code) => dead.push(`${job.kind}:${code}`),
      });
      await runner.drainTenant(tenantId);
      await new Promise((r) => setTimeout(r, 100));
      const [row] =
        await admin`select state, error_code, attempts from jobs where kind=${failing}`;
      assert.deepEqual(
        { ...row },
        { state: "available", error_code: "provider_down", attempts: 1 },
      );
      await admin`update jobs set next_at=now(), attempts=${MAX_ATTEMPTS - 1} where kind=${failing}`;
      await runner.drainTenant(tenantId);
      await runner.stop(5000);
      assert.deepEqual(dead, [`${failing}:provider_down`]);
      await admin`delete from jobs where kind=${failing}`;
    },
  );

  await check(
    "stop() bounds a drain blocked on a hung handler, then aborts it (OPS-R12 regression)",
    async () => {
      const hang = kind + "_hang";
      const aborted: string[] = [];
      registerJobHandler(
        hang,
        (ctx) =>
          new Promise((resolve) =>
            ctx.signal.addEventListener("abort", () => {
              aborted.push(String((ctx.signal.reason as Error)?.message));
              resolve({ status: "retry", code: "shutdown", afterMs: 0 });
            }),
          ),
        { concurrency: 1 },
      );
      await tenant(app, tenantId, async (tx) => {
        for (const dedupeKey of ["h1", "h2"])
          await enqueueJob(tx, owner, { kind: hang, dedupeKey, payload: {} });
      });
      const only = new Map([[hang, handlers().get(hang)!]]);
      const runner = createJobRunner(app, { handlers: () => only });
      // Saturated (concurrency 1, two jobs): the drain waits on the hung job.
      const drain = runner.drainTenant(tenantId);
      for (let i = 0; i < 100 && runner.running() === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(runner.running(), 1);
      const started = Date.now();
      await runner.stop(300);
      const took = Date.now() - started;
      // Before the fix stop() waited for the drain, i.e. for the lease
      // timer to abort the handler (118 s).
      assert.ok(took < 3000, `stop took ${took} ms`);
      assert.deepEqual(aborted, ["shutdown"]);
      assert.equal(await drain, 1, "the drain ends without claiming more");
      const states = await admin`
      select state, error_code from jobs where kind=${hang}`;
      // The aborted job is released for retry; the other was never claimed.
      assert.deepEqual(states.map((r) => `${r.state}:${r.error_code}`).sort(), [
        "available:null",
        "available:shutdown",
      ]);
      await admin`delete from jobs where kind=${hang}`;
    },
  );

  await check(
    "after a restart, a tenant's first authenticated read resumes its jobs; reads add no drains for known tenants (OPS-R12)",
    async () => {
      const resume = kind + "_resume";
      registerJobHandler(resume, async () => ({ status: "done" }));
      const only = new Map([[resume, handlers().get(resume)!]]);
      const add = (dedupeKey: string) =>
        tenant(app, tenantId, (tx) =>
          enqueueJob(tx, owner, { kind: resume, dedupeKey, payload: {} }),
        );
      const state = async (dedupeKey: string) =>
        (
          await admin`select state from jobs where kind=${resume} and dedupe_key=${dedupeKey}`
        )[0].state as string;
      const until = async (dedupeKey: string, wanted: string) => {
        for (let i = 0; i < 100; i++) {
          if ((await state(dedupeKey)) === wanted) return;
          await new Promise((r) => setTimeout(r, 30));
        }
        assert.fail(`${dedupeKey} never reached ${wanted}`);
      };
      // A fresh runner plays the restarted web process; no sweep runs.
      const runner = createJobRunner(app, {
        handlers: () => only,
        debounceMs: 10,
      });
      await add("before-restart");
      runner.noteTenant(tenantId, "read");
      await until("before-restart", "done");
      await add("later");
      runner.noteTenant(tenantId, "read");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await state("later"), "available");
      runner.noteTenant(tenantId);
      await until("later", "done");
      await runner.stop(5000);
      await admin`delete from jobs where kind=${resume}`;
    },
  );

  console.log(
    `Jobs DB checks passed: ${passed()} checks (runtime-role claims, lease fencing, retry/dead, requeue, tenant scope, kitchen drain, bounded stop, resume after restart).`,
  );
} finally {
  await admin`delete from jobs where kind like ${kind + "%"}`.catch(
    () => undefined,
  );
  await second.end();
  await app.end();
  await admin.end();
}
