import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { isolatedTarget } from "./isolated-target.js";
import { check, disposableLogins, passed } from "./ops-roles.js";
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
import {
  clearWorkerJobHandlers,
  discoverTenants,
  registerWorkerJobHandler,
  workerHandlers,
} from "../server/jobs/worker-registry.js";
// The web registry (kitchen_dispatch): server/index.ts imports it as a side
// effect; the runner no longer does (Wave 2.0, P-1).
import "../server/jobs/handlers/index.js";
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
// Kinds the temporary discovery policy covers (LIKE 'opstest\_%'), like cfdi's
// jobs_worker_discover covers 'cfdi\_%' (cfdi 030).
const workerKind = "opstest_" + randomUUID().slice(0, 8);
const discoverPolicy = "opstest_discover_" + randomUUID().slice(0, 8);
const cleanup: { drop?: () => Promise<void> } = {};
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

  await check(
    "runAt defers the first claim: not claimable before it, claimable after; a repeated key keeps the first runAt",
    async () => {
      const at = new Date(Date.now() + 1500);
      await tenant(app, tenantId, (tx) =>
        enqueueJob(tx, owner, {
          kind,
          dedupeKey: "later",
          payload: {},
          runAt: at,
        }),
      );
      await tenant(app, tenantId, (tx) =>
        enqueueJob(tx, owner, {
          kind,
          dedupeKey: "later",
          payload: {},
          runAt: new Date(Date.now() - 60_000),
        }),
      );
      const [row] = await admin`
        select next_at, state from jobs where kind=${kind} and dedupe_key='later'`;
      assert.equal(row.state, "available");
      assert.equal(
        (row.next_at as Date).getTime(),
        at.getTime(),
        "next_at is runAt, and the repeated key did not move it",
      );
      assert.deepEqual(await claim(app, owner), [], "not before runAt");
      await new Promise((r) =>
        setTimeout(r, Math.max(0, at.getTime() - Date.now()) + 150),
      );
      const [job] = await claim(app, owner);
      assert.equal(job?.dedupeKey, "later", "claimable once runAt passed");
      assert.equal(await completeJob(app, job), true);
      await enqueue(owner, "now");
      const [now] = await claim(app, owner);
      assert.equal(now?.dedupeKey, "now", "no runAt means now");
      await admin`delete from jobs where kind=${kind}`;
    },
  );

  await check(
    "per-kind maxAttempts: a kind registered with 3 goes dead on the third failure; a default kind on the eighth",
    async () => {
      const three = kind + "_m3";
      const eight = kind + "_m8";
      const fail = async () => {
        throw Object.assign(new Error("provider down"), {
          code: "provider_down",
        });
      };
      registerJobHandler(three, fail, { maxAttempts: 3 });
      registerJobHandler(eight, fail);
      assert.equal(handlers().get(eight)!.maxAttempts, MAX_ATTEMPTS);
      const dead: string[] = [];
      const only = new Map([
        [three, handlers().get(three)!],
        [eight, handlers().get(eight)!],
      ]);
      const runner = createJobRunner(app, {
        handlers: () => only,
        onDead: (job, code) => dead.push(`${job.kind}:${job.attempts}:${code}`),
      });
      await tenant(app, tenantId, async (tx) => {
        await enqueueJob(tx, owner, {
          kind: three,
          dedupeKey: "m",
          payload: {},
        });
        await enqueueJob(tx, owner, {
          kind: eight,
          dedupeKey: "m",
          payload: {},
        });
      });
      // The default kind starts two claims before its limit.
      await admin`update jobs set attempts=${MAX_ATTEMPTS - 2} where kind=${eight}`;
      const state = async (k: string) =>
        (await admin`select state, attempts from jobs where kind=${k}`)[0] as {
          state: string;
          attempts: number;
        };
      const settle = async () => {
        for (let i = 0; i < 100 && runner.running() > 0; i++)
          await new Promise((r) => setTimeout(r, 20));
        await admin`update jobs set next_at=now() where kind in (${three}, ${eight}) and state='available'`;
      };
      const seen: string[] = [];
      for (let round = 1; round <= 3; round++) {
        await runner.drainTenant(tenantId);
        await settle();
        const a = await state(three);
        const b = await state(eight);
        seen.push(`${a.state}:${a.attempts} ${b.state}:${b.attempts}`);
      }
      await runner.stop(5000);
      assert.deepEqual(seen, [
        `available:1 available:${MAX_ATTEMPTS - 1}`,
        `available:2 dead:${MAX_ATTEMPTS}`,
        `dead:3 dead:${MAX_ATTEMPTS}`,
      ]);
      assert.deepEqual(dead.sort(), [
        `${three}:3:provider_down`,
        `${eight}:${MAX_ATTEMPTS}:provider_down`,
      ]);
      await admin`delete from jobs where kind in (${three}, ${eight})`;
    },
  );

  // Wave 2.0 (c): the worker's jobs login. Capability roles come from
  // globals.sql (idempotent; roles are cluster-global); the login is a
  // disposable member of gm_jobs_worker, like gm_<env>_worker.
  await admin.unsafe(readFileSync("scripts/ops/sql/globals.sql", "utf8"));
  const { logins, drop } = await disposableLogins(admin, runtime, {
    worker: ["gm_jobs_worker"],
  });
  cleanup.drop = drop;
  const worker = logins.worker.sql;
  const insertJob = (
    tenantId: string,
    o: {
      kind?: string;
      key: string;
      state?: string;
      next?: string;
      lease?: string | null;
    },
  ) =>
    admin.unsafe(
      `insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,next_at,lease_until)
       values($1,$2,$3,$4,'{}',$5,${o.next ?? "now()"},${o.lease ?? "null"})`,
      [
        tenantId,
        randomUUID(),
        o.kind ?? workerKind,
        o.key,
        o.state ?? "available",
      ],
    );
  const createPolicy = () =>
    admin.unsafe(
      `create policy "${discoverPolicy}" on jobs for select to gm_jobs_worker using (kind like 'opstest\\_%')`,
    );
  const dropPolicy = () =>
    admin.unsafe(`drop policy if exists "${discoverPolicy}" on jobs`);
  const forbidden = async (promise: Promise<unknown>) =>
    assert.rejects(promise, (e: any) => {
      assert.match(`${e?.code} ${e?.message}`, /42501|permission denied/);
      return true;
    });

  await check(
    "the worker login claims, extends, completes and enqueues a follow-up job inside tenant() with only the 2.0 grants",
    async () => {
      await tenant(app, tenantId, (tx) =>
        enqueueJob(tx, owner, {
          kind: workerKind,
          dedupeKey: "w1",
          payload: {},
        }),
      );
      const [job] = await tenant(worker, tenantId, (tx) =>
        claimJobs(tx, [workerKind], 5, 60),
      );
      assert.equal(job?.dedupeKey, "w1");
      assert.equal(job.tenantId, tenantId);
      const renewed = await extendLease(worker, job, 90);
      assert.ok(renewed && renewed !== job.lease, "the lease is extended");
      await tenant(worker, tenantId, (tx) =>
        enqueueJob(
          tx,
          { tenantId },
          {
            kind: workerKind,
            dedupeKey: "w1-follow-up",
            payload: { after: job.id },
            runAt: new Date(Date.now() + 60_000),
          },
        ),
      );
      // A repeated follow-up (a replayed handler) is ignored, not an error.
      await tenant(worker, tenantId, (tx) =>
        enqueueJob(
          tx,
          { tenantId },
          {
            kind: workerKind,
            dedupeKey: "w1-follow-up",
            payload: {},
          },
        ),
      );
      assert.equal(
        await completeJob(worker, { ...job, lease: renewed! }),
        true,
      );
      const states = await admin`
        select dedupe_key, state from jobs where kind=${workerKind} order by dedupe_key`;
      assert.deepEqual(
        states.map((r) => `${r.dedupe_key}:${r.state}`),
        ["w1:done", "w1-follow-up:available"],
      );
      // The failure path too: a claimed job goes back for retry.
      await admin`update jobs set next_at=now() where kind=${workerKind} and dedupe_key='w1-follow-up'`;
      const [next] = await tenant(worker, tenantId, (tx) =>
        claimJobs(tx, [workerKind], 5, 60),
      );
      assert.equal(
        await failJob(worker, next, { code: "provider_down", maxAttempts: 3 }),
        "retry",
      );
      await admin`delete from jobs where kind=${workerKind}`;
    },
  );

  await check(
    "the worker login cannot DELETE jobs, UPDATE payload or kind, or see another tenant's rows inside tenant()",
    async () => {
      await insertJob(tenantId, { key: "mine" });
      await insertJob(otherTenantId, { key: "theirs" });
      await forbidden(
        tenant(
          worker,
          tenantId,
          (tx) => tx`delete from jobs where kind=${workerKind}`,
        ),
      );
      await forbidden(
        tenant(
          worker,
          tenantId,
          (tx) =>
            tx`update jobs set payload='{"x":1}' where kind=${workerKind}`,
        ),
      );
      await forbidden(
        tenant(
          worker,
          tenantId,
          (tx) =>
            tx`update jobs set kind='other_kind' where kind=${workerKind}`,
        ),
      );
      const [inside] = await tenant(
        worker,
        tenantId,
        (tx) =>
          tx`select count(*)::int as all, count(*) filter (where tenant_id=${otherTenantId})::int as other from jobs where kind=${workerKind}`,
      );
      assert.deepEqual({ ...inside }, { all: 1, other: 0 });
      const [outside] =
        await worker`select count(*)::int as n from jobs where kind=${workerKind}`;
      assert.equal(outside.n, 0, "no policy: nothing visible outside tenant()");
      assert.deepEqual(
        await discoverTenants(worker, [workerKind]),
        [],
        "discovery returns [] without an area policy",
      );
      await admin`delete from jobs where kind=${workerKind}`;
    },
  );

  await check(
    "discoverTenants, with a temporary opstest_% SELECT policy TO gm_jobs_worker: due queued/available or expired running jobs, oldest due first; never future, live running, blocked, done, dead or other-kind jobs; [] without the policy",
    async () => {
      const otherKind = workerKind + "_other";
      await createPolicy();
      try {
        // Only jobs discovery must ignore.
        await insertJob(tenantId, {
          key: "future",
          next: "now() + interval '1 hour'",
        });
        await insertJob(tenantId, {
          key: "live",
          state: "running",
          next: "now() - interval '1 hour'",
          lease: "now() + interval '5 minutes'",
        });
        for (const state of ["blocked", "done", "dead"])
          await insertJob(tenantId, {
            key: state,
            state,
            next: "now() - interval '1 hour'",
          });
        // Due, but of a kind not asked for (and of a kind the policy hides).
        await insertJob(otherTenantId, {
          kind: otherKind,
          key: "other",
          next: "now() - interval '1 hour'",
        });
        await insertJob(otherTenantId, {
          kind,
          key: "hidden",
          next: "now() - interval '1 hour'",
        });
        assert.deepEqual(await discoverTenants(worker, [workerKind, kind]), []);
        assert.deepEqual(await discoverTenants(worker, []), []);

        await insertJob(tenantId, {
          key: "queued",
          state: "queued",
          next: "now() - interval '10 minutes'",
        });
        await insertJob(otherTenantId, {
          key: "available",
          next: "now() - interval '5 minutes'",
        });
        assert.deepEqual(await discoverTenants(worker, [workerKind]), [
          tenantId,
          otherTenantId,
        ]);
        // An expired lease is due since lease_until: older than both.
        await insertJob(otherTenantId, {
          key: "expired",
          state: "running",
          next: "now()",
          lease: "now() - interval '20 minutes'",
        });
        assert.deepEqual(await discoverTenants(worker, [workerKind]), [
          otherTenantId,
          tenantId,
        ]);
        assert.deepEqual(await discoverTenants(worker, [workerKind], 1), [
          otherTenantId,
        ]);
        assert.deepEqual(
          (await discoverTenants(worker, [otherKind])).length,
          1,
          "kinds select the jobs",
        );
        await dropPolicy();
        assert.deepEqual(await discoverTenants(worker, [workerKind]), []);
      } finally {
        await dropPolicy();
        await admin`delete from jobs where kind like ${workerKind + "%"} or (kind=${kind} and dedupe_key='hidden')`;
      }
    },
  );

  await check(
    "with that policy present, a claim in tenant A never leases tenant B's job, and a fenced write with the wrong tenant matches no row (§4.3 regression)",
    async () => {
      await createPolicy();
      try {
        await insertJob(tenantId, {
          key: "a1",
          next: "now() - interval '1 minute'",
        });
        await insertJob(otherTenantId, {
          key: "b1",
          next: "now() - interval '2 minutes'",
        });
        const [seenB] = await tenant(
          worker,
          tenantId,
          (tx) =>
            tx`select count(*)::int as n from jobs where kind=${workerKind} and tenant_id=${otherTenantId}`,
        );
        assert.equal(seenB.n, 1, "the policy widens plain SELECT visibility");
        const claimed = await tenant(worker, tenantId, (tx) =>
          claimJobs(tx, [workerKind], 10, 60),
        );
        assert.deepEqual(
          claimed.map((j) => `${j.tenantId}:${j.dedupeKey}`),
          [`${tenantId}:a1`],
        );
        const [job] = claimed;
        const wrong = { ...job, tenantId: otherTenantId };
        assert.equal(await completeJob(worker, wrong), false);
        assert.equal(await failJob(worker, wrong, { code: "x" }), "lost");
        assert.equal(await extendLease(worker, wrong, 60), null);
        const states = await admin`
          select tenant_id, dedupe_key, state from jobs where kind=${workerKind} order by dedupe_key`;
        assert.deepEqual(
          states.map((r) => `${r.dedupe_key}:${r.state}`),
          ["a1:running", "b1:available"],
          "nothing changed in either tenant",
        );
        assert.equal(await completeJob(worker, job), true);
      } finally {
        await dropPolicy();
        await admin`delete from jobs where kind=${workerKind}`;
      }
    },
  );

  await check(
    "the runtime login sees no other tenant's jobs even with the policy present",
    async () => {
      await createPolicy();
      try {
        await insertJob(otherTenantId, { key: "b2" });
        const [inside] = await tenant(
          app,
          tenantId,
          (tx) =>
            tx`select count(*)::int as n from jobs where kind=${workerKind}`,
        );
        assert.equal(inside.n, 0);
        const [outside] =
          await app`select count(*)::int as n from jobs where kind=${workerKind}`;
        assert.equal(outside.n, 0);
      } finally {
        await dropPolicy();
        await admin`delete from jobs where kind=${workerKind}`;
      }
    },
  );

  await check(
    "worker runner end to end: createJobRunner(worker pool, {handlers: worker registry, discover}) runs an opstest kind for two tenants and marks both done within 10 s",
    async () => {
      const e2e = workerKind + "_e2e";
      const ran: string[] = [];
      registerWorkerJobHandler(e2e, async (ctx) => {
        // ctx.tenant runs in the job's tenant scope. The jobs login holds
        // grants on jobs only in Wave 2.0 (areas add theirs in their block).
        const [r] = await ctx.tenant(
          (tx) =>
            tx`select current_setting('app.tenant_id') as scope, current_user as login`,
        );
        ran.push(
          `${ctx.job.tenantId}:${r.scope === ctx.job.tenantId}:${r.login === logins.worker.role}`,
        );
      });
      await createPolicy();
      const runner = createJobRunner(worker, {
        handlers: workerHandlers,
        concurrency: 4,
        sweepMs: 200,
        discover: () => discoverTenants(worker, [...workerHandlers().keys()]),
      });
      try {
        for (const s of [owner, other])
          await tenant(app, s.tenantId, (tx) =>
            enqueueJob(tx, s, { kind: e2e, dedupeKey: "e2e", payload: {} }),
          );
        const started = Date.now();
        runner.start();
        for (;;) {
          const [row] = await admin`
            select count(*) filter (where state='done')::int as done from jobs where kind=${e2e}`;
          if (row.done === 2) break;
          assert.ok(Date.now() - started < 10_000, "both done within 10 s");
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.deepEqual(
          ran.sort(),
          [`${tenantId}:true:true`, `${otherTenantId}:true:true`].sort(),
        );
      } finally {
        await runner.stop(5000);
        clearWorkerJobHandlers();
        await dropPolicy();
        await admin`delete from jobs where kind=${e2e}`;
      }
    },
  );

  console.log(
    `Jobs DB checks passed: ${passed()} checks (runtime-role claims, lease fencing, retry/dead, requeue, tenant scope, kitchen drain, bounded stop, resume after restart, runAt, per-kind maxAttempts, worker login, discovery, worker runner).`,
  );
} finally {
  await admin`delete from jobs where kind like ${kind + "%"} or kind like ${workerKind + "%"}`.catch(
    () => undefined,
  );
  await admin
    .unsafe(`drop policy if exists "${discoverPolicy}" on jobs`)
    .catch(() => undefined);
  await cleanup.drop?.();
  await second.end();
  await app.end();
  await admin.end();
}
