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
  setDeliveryDriver,
} from "../server/delivery-worker/runtime.js";
import { BrowserbaseDriver } from "../server/delivery-worker/browserbase.js";
import { queueDelivery } from "../server/delivery/queue.js";
import { claimJobs, completeJob } from "../server/jobs/queue.js";
import type { ClaimedJob, JobContext } from "../server/jobs.js";
import type { Session } from "../shared/domain.js";
import { log } from "../server/logging.js";
import { uberFixture } from "./fixtures/delivery/uber.js";
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
    await admin`update delivery_connections set state='choose_store',stores='[{"id":"Synthetic Cafe","name":"Synthetic Cafe"}]' where tenant_id=${A}`;
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
