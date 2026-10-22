import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Page, Browser } from "playwright-core";
import { isolatedTarget, requireWorker } from "./isolated-target.js";
import { connect, tenant } from "../server/db.js";
import {
  deliveryAction,
  deliveryView,
  deliveryLogin,
} from "../server/delivery/service.js";
import {
  deliveryHandler,
  deliveryDead,
  setDeliveryDriver,
} from "../server/delivery-worker/runtime.js";
import { BrowserbaseDriver } from "../server/delivery-worker/browserbase.js";
import { queueDelivery } from "../server/delivery/queue.js";
import { claimJobs, completeJob } from "../server/jobs/queue.js";
import type { ClaimedJob, JobContext } from "../server/jobs.js";
import type { Session } from "../shared/domain.js";
import { log } from "../server/logging.js";
import { uberFixture, uberHeaders } from "./fixtures/delivery/uber.js";
import { DeliveryError } from "../server/delivery/parse.js";
const target = isolatedTarget(process.env),
  admin = postgres(target.migration, { max: 1 }),
  sql = connect(target.runtime),
  worker = postgres(requireWorker(target), { max: 2 });
const A = randomUUID(),
  B = randomUUID(),
  org = randomUUID(),
  employee = randomUUID();
const owner: Session = {
  id: randomUUID(),
  tenantId: A,
  employeeId: employee,
  name: "Synthetic Owner",
  role: "owner",
  deviceId: randomUUID(),
  expiresAt: "",
  offlineUntil: "",
  csrf: "",
  restaurant: {
    name: "Synthetic Cafe",
    currency: "MXN",
    timezone: "America/Mexico_City",
    cutoff: 240,
  },
  access: {
    authenticatedAt: new Date().toISOString(),
    absoluteExpiresAt: null,
    deviceName: "Fixture",
    deviceKind: "terminal",
    idleLockSeconds: null,
    ownerAccount: false,
  },
};
class FakeDriver extends BrowserbaseDriver {
  calls: string[] = [];
  bytes: Uint8Array | null = null;
  failRelease = false;
  constructor() {
    super("synthetic", "synthetic");
  }
  override async createContext() {
    this.calls.push("create");
    return "synthetic-context";
  }
  override async createSession() {
    this.calls.push("session");
    return {
      id: "synthetic-session",
      connectUrl: "wss://connect.browserbase.com/synthetic",
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    };
  }
  override async session() {
    return this.createSession();
  }
  override async live() {
    return "https://www.browserbase.com/sessions/synthetic";
  }
  override async release() {
    this.calls.push("release");
    if (this.failRelease)
      throw new DeliveryError("delivery_browser_unavailable");
  }
  override async deleteContext() {
    this.calls.push("delete");
  }
  override async download() {
    return this.bytes;
  }
  override async page() {
    return {
      browser: {} as Browser,
      page: { goto: async () => {} } as unknown as Page,
      detach: async () => {},
    };
  }
}
const driver = new FakeDriver();
setDeliveryDriver(driver);
async function claim() {
  const [job] = await tenant(worker, A, (tx) =>
    claimJobs(tx, ["delivery_browser"], 1, 180, 100),
  );
  assert.ok(job);
  return job;
}
function context(job: ClaimedJob): JobContext {
  return {
    job,
    tenant: (fn) => tenant(worker, A, fn),
    signal: new AbortController().signal,
    extendLease: async () => {},
    log,
  };
}
async function run(job: ClaimedJob) {
  const result = await deliveryHandler(context(job));
  assert.equal(result, undefined);
  assert.ok(await completeJob(worker, job));
}
async function forceSync() {
  await admin`update delivery_browser_contexts set report_day=coalesce(report_day,((now() at time zone 'America/Mexico_City')::date-1)) where tenant_id=${A}`;
  const [existing] =
    await admin`select 1 from jobs where tenant_id=${A} and state in ('queued','available') and payload->>'action'='sync' limit 1`;
  if (!existing)
    await tenant(worker, A, (tx) =>
      queueDelivery(
        tx,
        A,
        "uber_eats",
        1,
        "sync",
        new Date(Date.now() + checks + 100),
      ),
    );
  await admin`update jobs set next_at=now() where tenant_id=${A} and state in ('queued','available') and payload->>'action'='sync'`;
}
let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  console.log("PASS " + name);
  checks++;
}
try {
  await admin`insert into organizations(id,name) values(${org},'Synthetic delivery')`;
  await admin`insert into restaurants(id,organization_id,name,free_location) values(${A},${org},'Synthetic Cafe',false),(${B},${org},'Synthetic Other',false)`;
  await admin`insert into employees(tenant_id,id,name,login,secret_hash,role) values(${A},${employee},'Synthetic Owner',${randomUUID()},'synthetic','owner')`;
  await admin`insert into restaurant_entitlements(tenant_id,status,access_until,source) values(${A},'active',now()+interval '1 day','fixture')`;
  await admin`update delivery_platform set available=array['uber_eats'],updated_at=now()`;
  await test("only owner with fresh auth and explicit consent can connect", async () => {
    for (const s of [
      { ...owner, role: "manager" },
      {
        ...owner,
        access: {
          ...owner.access!,
          authenticatedAt: new Date(0).toISOString(),
        },
      },
    ])
      await assert.rejects(() =>
        tenant(sql, A, (tx) =>
          deliveryAction(tx, s, "uber_eats", {
            action: "connect",
            consent: "delivery-reports-v1",
          }),
        ),
      );
    await assert.rejects(() =>
      tenant(sql, A, (tx) =>
        deliveryAction(tx, owner, "uber_eats", { action: "connect" }),
      ),
    );
    await tenant(sql, A, (tx) =>
      deliveryAction(tx, owner, "uber_eats", {
        action: "connect",
        consent: "delivery-reports-v1",
      }),
    );
    await assert.rejects(() =>
      tenant(sql, A, (tx) =>
        deliveryAction(tx, owner, "uber_eats", {
          action: "connect",
          consent: "delivery-reports-v1",
        }),
      ),
    );
  });
  await test("connect job provisions private browser and queues independent expiry", async () => {
    await run(await claim());
    const v = await tenant(sql, A, (tx) => deliveryView(tx, owner));
    assert.equal(v.connections[0].state, "awaiting_login");
    assert.ok(!JSON.stringify(v).includes("browserbase"));
    assert.equal(
      (await tenant(sql, A, (tx) => deliveryLogin(tx, owner, "uber_eats"))).url,
      await driver.live(),
    );
    await assert.rejects(() =>
      tenant(sql, A, (tx) =>
        deliveryLogin(tx, { ...owner, employeeId: randomUUID() }, "uber_eats"),
      ),
    );
  });
  await test("RLS and worker-only contexts prevent cross-tenant/session access", async () => {
    assert.equal(
      (await tenant(sql, B, (tx) => tx`select * from delivery_connections`))
        .length,
      0,
    );
    await assert.rejects(() =>
      tenant(sql, A, (tx) => tx`select * from delivery_browser_contexts`),
    );
    await assert.rejects(() =>
      tenant(
        sql,
        B,
        (tx) =>
          tx`insert into delivery_connections(tenant_id,provider) values(${A},'rappi')`,
      ),
    );
  });
  await test("store confirmation validates allowed stores and generations", async () => {
    await admin`update delivery_connections set state='verifying' where tenant_id=${A}`;
    await admin`update delivery_browser_contexts set verified_stores='[{"id":"Synthetic Cafe","name":"Synthetic Cafe"}]' where tenant_id=${A}`;
    await tenant(worker, A, (tx) =>
      queueDelivery(tx, A, "uber_eats", 1, "verify", new Date()),
    );
    const sessions = driver.calls.filter((c) => c === "session").length;
    await run(await claim());
    assert.equal(driver.calls.filter((c) => c === "session").length, sessions);
    assert.equal(
      (await tenant(sql, A, (tx) => deliveryView(tx, owner))).connections[0]
        .state,
      "choose_store",
    );
    await assert.rejects(() =>
      tenant(sql, A, (tx) =>
        deliveryAction(tx, owner, "uber_eats", {
          action: "select",
          generation: 1,
          storeId: "Wrong",
        }),
      ),
    );
    await tenant(sql, A, (tx) =>
      deliveryAction(tx, owner, "uber_eats", {
        action: "select",
        generation: 1,
        storeId: "Synthetic Cafe",
      }),
    );
  });
  await test("sync imports exactly once, pins date, and schedules next local close", async () => {
    const [clock] =
      await admin`select ((now() at time zone 'America/Mexico_City')::date-1)::text as day`;
    driver.bytes = uberFixture(clock.day);
    await admin`update jobs set next_at=now() where tenant_id=${A} and payload->>'action'='sync'`;
    const job = await claim();
    await run(job);
    const v = await tenant(sql, A, (tx) => deliveryView(tx, owner));
    assert.equal(v.connections[0].state, "connected");
    assert.equal(v.days[0].adjusted, 11900);
    assert.equal(v.days[0].day, clock.day);
    await assert.rejects(
      () => deliveryHandler(context(job)),
      /delivery_lease_lost/,
    );
    const [count] =
      await admin`select count(*)::int as n from delivery_daily_reports where tenant_id=${A}`;
    assert.equal(count.n, 1);
    const [next] =
      await admin`select next_at>now() as future from jobs where tenant_id=${A} and state in ('queued','available') and payload->>'action'='sync'`;
    assert.equal(next.future, true);
  });
  await test("an empty day stays unverified without blocking subsequent imports", async () => {
    const [clock] =
      await admin`select ((now() at time zone 'America/Mexico_City')::date-2)::text as empty_day,
      ((now() at time zone 'America/Mexico_City')::date-1)::text as day`;
    await admin`update delivery_browser_contexts set report_day=${clock.empty_day}::date where tenant_id=${A}`;
    driver.bytes = Buffer.from(uberHeaders.join(","));
    await forceSync();
    await run(await claim());
    let view = await tenant(sql, A, (tx) => deliveryView(tx, owner));
    assert.equal(view.connections[0].state, "connected");
    assert.equal(view.issues?.[0].day, clock.empty_day);
    assert.equal(
      view.days.some((d) => d.day === clock.empty_day),
      false,
    );
    const creates = driver.calls.filter((c) => c === "create").length;
    driver.bytes = uberFixture(clock.day);
    await forceSync();
    await run(await claim());
    view = await tenant(sql, A, (tx) => deliveryView(tx, owner));
    assert.equal(view.connections[0].state, "connected");
    assert.equal(driver.calls.filter((c) => c === "create").length, creates);
    assert.equal(view.days[0].day, clock.day);
  });
  await test("a scoped empty export becomes verified zero only after store identity was established", async () => {
    const [clock] =
      await admin`select ((now() at time zone 'America/Mexico_City')::date-2)::text as day`;
    driver.bytes = Buffer.from(uberHeaders.join(","));
    await admin`update delivery_browser_contexts set report_day=${clock.day}::date,download_session_id='synthetic-empty',
      download_started_at=now(),download_scope_verified=true where tenant_id=${A}`;
    await forceSync();
    await run(await claim());
    const view = await tenant(sql, A, (tx) => deliveryView(tx, owner));
    assert.equal(view.days.find((d) => d.day === clock.day)?.adjusted, 0);
    assert.equal(
      view.issues?.some((d) => d.day === clock.day),
      false,
    );
    assert.equal(
      (await tenant(sql, B, (tx) => tx`select * from delivery_day_attempts`))
        .length,
      0,
    );
  });
  await test("delayed downloads poll the saved session without opening or clicking another browser", async () => {
    driver.bytes = null;
    await admin`update delivery_browser_contexts set download_session_id='synthetic-download',download_started_at=now() where tenant_id=${A}`;
    await forceSync();
    const job = await claim(),
      calls = driver.calls.length;
    const result = await deliveryHandler(context(job));
    assert.equal(result?.status, "retry");
    assert.equal(driver.calls.length, calls);
    assert.ok(await completeJob(worker, job));
    await tenant(worker, A, (tx) =>
      queueDelivery(tx, A, "uber_eats", 1, "sync", new Date()),
    );
    const [clock] =
      await admin`select ((now() at time zone 'America/Mexico_City')::date-1)::text as day`;
    driver.bytes = uberFixture(clock.day);
    await run(await claim());
    const [marker] =
      await admin`select download_session_id from delivery_browser_contexts where tenant_id=${A}`;
    assert.equal(marker.download_session_id, null);
  });
  await test("same-name different-store exports cannot overwrite verified sales", async () => {
    const [clock] =
      await admin`select ((now() at time zone 'America/Mexico_City')::date-1)::text as day`;
    driver.bytes = Buffer.from(
      uberFixture(clock.day)
        .toString()
        .replaceAll("store-one", "different-store"),
    );
    await forceSync();
    await run(await claim());
    const view = await tenant(sql, A, (tx) => deliveryView(tx, owner));
    assert.equal(view.connections[0].state, "attention");
    assert.equal(
      view.connections[0].errorCode,
      "delivery_store_identity_changed",
    );
    assert.equal(view.days[0].adjusted, 11900);
    await admin`update delivery_connections set state='connected',error_code=null where tenant_id=${A}`;
  });
  await test("stale sign-in expiry does not start another daily chain", async () => {
    await admin`update jobs set next_at=now() where tenant_id=${A} and payload->>'action'='expire'`;
    const calls = driver.calls.length;
    await run(await claim());
    assert.equal(driver.calls.length, calls);
    assert.equal(
      (await tenant(sql, A, (tx) => deliveryView(tx, owner))).connections[0]
        .state,
      "connected",
    );
  });
  await test("exhausted daily retries preserve the next automatic import", async () => {
    const [clock] =
      await admin`select ((now() at time zone 'America/Mexico_City')::date-3)::text as day`;
    await admin`update delivery_browser_contexts set report_day=${clock.day}::date where tenant_id=${A}`;
    await forceSync();
    const job = await claim();
    await admin`update jobs set dedupe_key=dedupe_key||':fixture-consumed' where tenant_id=${A} and state='completed'`;
    await tenant(worker, A, (tx) =>
      deliveryDead({ tx, job, code: "delivery_download_timeout" }),
    );
    assert.ok(await completeJob(worker, job));
    const view = await tenant(sql, A, (tx) => deliveryView(tx, owner));
    assert.equal(view.connections[0].state, "connected");
    assert.equal(
      view.issues?.find((d) => d.day === clock.day)?.errorCode,
      "delivery_retry_exhausted",
    );
    const [next] =
      await admin`select count(*)::int as n from jobs where tenant_id=${A} and state in ('queued','available') and payload->>'action'='sync'`;
    assert.ok(next.n > 0);
  });
  await test("valid sales commit even when browser cleanup is temporarily unavailable", async () => {
    const [clock] =
      await admin`select ((now() at time zone 'America/Mexico_City')::date-4)::text as day`;
    driver.bytes = uberFixture(clock.day);
    driver.failRelease = true;
    await admin`update delivery_browser_contexts set report_day=${clock.day}::date,session_id='synthetic-cleanup',download_session_id='synthetic-cleanup',download_started_at=now() where tenant_id=${A}`;
    await forceSync();
    await run(await claim());
    assert.equal(
      (await tenant(sql, A, (tx) => deliveryView(tx, owner))).days.find(
        (d) => d.day === clock.day,
      )?.adjusted,
      11900,
    );
    const [saved] =
      await admin`select session_id from delivery_browser_contexts where tenant_id=${A}`;
    assert.equal(saved.session_id, "synthetic-cleanup");
    driver.failRelease = false;
  });
  await test("a newly confirmed same-name store has a separate UUID history", async () => {
    const [clock] =
      await admin`select ((now() at time zone 'America/Mexico_City')::date-1)::text as day`;
    driver.bytes = Buffer.from(
      uberFixture(clock.day).toString().replaceAll("store-one", "new-store"),
    );
    await admin`update delivery_connections set store_uuid=null where tenant_id=${A}`;
    await admin`update delivery_browser_contexts set identity_verified=false where tenant_id=${A}`;
    await forceSync();
    await run(await claim());
    const rows =
      await admin`select store_id from delivery_daily_reports where tenant_id=${A} and day=${clock.day}::date order by store_id`;
    assert.deepEqual(
      rows.map((r) => r.store_id),
      ["new-store", "store-one"],
    );
    assert.equal(
      (await tenant(sql, A, (tx) => deliveryView(tx, owner))).days.length,
      1,
    );
    assert.equal(
      (await tenant(worker, B, (tx) => tx`select * from delivery_day_attempts`))
        .length,
      0,
    );
  });
  await test("disconnect invalidates queued generations and deletes retained session", async () => {
    await tenant(sql, A, (tx) =>
      deliveryAction(tx, owner, "uber_eats", { action: "disconnect" }),
    );
    await run(await claim());
    assert.ok(driver.calls.includes("delete"));
    assert.equal(
      (await tenant(sql, A, (tx) => deliveryView(tx, owner))).connections[0]
        .state,
      "disconnected",
    );
    await tenant(worker, A, (tx) =>
      queueDelivery(tx, A, "uber_eats", 1, "sync", new Date()),
    );
    const calls = driver.calls.length;
    await run(await claim());
    assert.equal(driver.calls.length, calls);
  });
  console.log(`${checks} delivery DB checks passed`);
} finally {
  setDeliveryDriver(null);
  await admin.end();
  await sql.end();
  await worker.end();
}
