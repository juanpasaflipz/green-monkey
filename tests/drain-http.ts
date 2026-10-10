// Process-level checks for the compiled build, started exactly as Railway does
// (node --import ./build/server/instrument.js ...):
//  - web: SIGTERM finishes an in-flight request, answers /api/health 503
//    server_draining meanwhile, ignores idle keep-alive sockets and exits 0
//    well inside RAILWAY_DEPLOYMENT_DRAINING_SECONDS (OPS-6);
//  - worker: with the jobs login (WORKER_DATABASE_URL, a gm_jobs_worker
//    member) /healthz reports ready with jobs:true, POST /wake (payments)
//    claims due jobs before the sweep, and SIGTERM exits 0 within
//    RAILWAY_DEPLOYMENT_DRAINING_SECONDS.
// Requires `npm run build` and the isolated local development fixture.
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const target = new URL(process.env.DATABASE_URL ?? "");
if (
  target.hostname !== "127.0.0.1" ||
  !/^\/green_monkey(_[a-z][a-z0-9]*)?_dev$/.test(target.pathname)
)
  throw Error(
    "Drain qualification requires the isolated local development fixture",
  );
// The worker's jobs login on the same database: WORKER_DATABASE_URL (local
// .env from setup:local), else the runtime URL with the local gm_worker
// credentials that provision-local.sql and CI create (Wave 2.0, §5.6).
const workerTarget = (() => {
  if (process.env.WORKER_DATABASE_URL) return process.env.WORKER_DATABASE_URL;
  const u = new URL(target.href);
  u.username = "gm_worker";
  u.password = "local-only-worker";
  return u.href;
})();
{
  const w = new URL(workerTarget);
  if (w.host !== target.host || w.pathname !== target.pathname)
    throw Error("WORKER_DATABASE_URL must point at the same local database");
}
const port = Number(process.env.RESTART_TEST_PORT ?? 3003);
const origin = `http://127.0.0.1:${port}`;
const DRAIN_SECONDS = 20;
let child: ChildProcess | undefined;
const output: string[] = [];

function start(entry: string, env: NodeJS.ProcessEnv) {
  const proc = spawn(
    process.execPath,
    ["--import", "./build/server/instrument.js", entry],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        BILLING_SANDBOX_ENABLED: "false",
        RAILWAY_DEPLOYMENT_DRAINING_SECONDS: String(DRAIN_SECONDS),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout!.on("data", (chunk) => output.push(String(chunk)));
  proc.stderr!.on("data", (chunk) => output.push(String(chunk)));
  child = proc;
  return proc;
}

async function waitFor(url: string) {
  for (let i = 0; i < 100; i++) {
    if (child?.exitCode !== null)
      throw Error("process exited before readiness");
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* starting */
    }
    await delay(100);
  }
  throw Error(`readiness timeout for ${url}`);
}

/** Reads raw HTTP/1.1 responses from a socket until `count` have completed. */
function responses(socket: net.Socket, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const done: string[] = [];
    const parse = () => {
      for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.slice(0, end);
        const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
        if (buffer.length < end + 4 + length) return;
        done.push(buffer.slice(0, end + 4 + length));
        buffer = buffer.slice(end + 4 + length);
        if (done.length === count) return resolve(done);
      }
    };
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      parse();
    });
    socket.on("error", reject);
    socket.on("close", () =>
      done.length === count
        ? resolve(done)
        : reject(Error(`closed after ${done.length} responses`)),
    );
  });
}

try {
  // ---- web ----
  const web = start("build/server/index.js", {
    PORT: String(port),
    APP_URL: origin,
  });
  await waitFor(origin + "/api/health");
  // An idle keep-alive connection must not hold the drain open.
  const agent = new http.Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) =>
    http
      .get(origin + "/api/version", { agent }, (res) => {
        res.resume();
        res.on("end", resolve);
      })
      .on("error", reject),
  );
  // An in-flight request: headers sent, body still arriving.
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  const replies = responses(socket, 2);
  const body = '{"lines":[]}';
  socket.write(
    `POST /api/public/drain-check/orders HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n` +
      body.slice(0, 4),
  );
  await delay(200);
  const exited = once(web, "exit");
  const signalledAt = Date.now();
  web.kill("SIGTERM");
  await delay(500);
  assert.equal(
    web.exitCode,
    null,
    "the server waits for the in-flight request",
  );
  // Finish the body and pipeline a health check behind it.
  socket.write(
    body.slice(4) + "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
  );
  const [first, health] = await replies;
  assert.match(
    first,
    /^HTTP\/1\.1 \d{3}/,
    "the in-flight request got a complete response",
  );
  assert.match(health, /^HTTP\/1\.1 503/, "health turns 503 while draining");
  assert.match(health, /"error":"server_draining"/);
  socket.destroy();
  const [code] = await exited;
  const elapsed = Date.now() - signalledAt;
  assert.equal(code, 0, "clean exit after the drain");
  assert.ok(
    elapsed < (DRAIN_SECONDS - 2) * 1000,
    `exit within drainSeconds-2 (took ${elapsed} ms)`,
  );
  agent.destroy();
  const logs = output.join("");
  assert.match(logs, /"message":"shutdown_complete"/);
  assert.doesNotMatch(
    logs,
    /drain-check/,
    "logs carry route templates, not paths",
  );
  console.log(`PASS web drains in-flight work and exits 0 in ${elapsed} ms`);

  // ---- worker ----
  output.length = 0;
  const worker = start("build/server/worker.js", {
    PROCESS_KIND: "worker",
    PORT: String(port),
    APP_URL: origin,
    DATABASE_URL: "",
    WORKER_DATABASE_URL: workerTarget,
  });
  await waitFor(origin + "/healthz");
  const status = await (await fetch(origin + "/healthz")).json();
  assert.equal(status.ok, true);
  assert.equal(typeof status.commit, "string");
  assert.equal(status.jobs, true, "the jobs runner is on");
  assert.deepEqual(status.stale, []);
  assert.match(
    output.join(""),
    /"message":"worker_ready"[^\n]*"jobs":true/,
    "worker_ready logs jobs:true",
  );

  // ---- worker POST /wake (payments spec §4.7): the web's poke after a payments enqueue.
  const wake = await fetch(origin + "/wake", { method: "POST" });
  assert.equal(wake.status, 202);
  assert.equal(wake.headers.get("cache-control"), "no-store");
  assert.equal(await wake.text(), "", "a wake carries no data back");
  const notWake = await fetch(origin + "/wake");
  assert.equal(notWake.status, 404, "only POST wakes");
  await notWake.text();
  const burst = await Promise.all(
    Array.from({ length: 25 }, () =>
      fetch(origin + "/wake", { method: "POST" }),
    ),
  );
  assert.deepEqual([...new Set(burst.map((r) => r.status))], [202]);
  await Promise.all(burst.map((r) => r.text()));
  assert.equal(
    (await fetch(origin + "/healthz")).status,
    200,
    "a burst of wakes (coalesced by the runner) leaves the worker healthy",
  );
  // A wake claims a due payments job long before the 5 s discovery sweep: three times in a row,
  // each within 1.5 s, which the sweep alone cannot do. payments_wipe for a provider the demo
  // restaurant never connected is a no-op that finishes at once.
  const app = postgres(target.href, { max: 1, onnotice: () => {} });
  const demo = process.env.DEMO_TENANT_ID ?? "";
  assert.match(
    demo,
    /^[0-9a-f-]{36}$/,
    "the seeded demo restaurant (DEMO_TENANT_ID)",
  );
  try {
    for (let i = 1; i <= 3; i++) {
      const jobId = randomUUID();
      await app.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${demo}, true)`;
        await tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,next_at)
          values(${demo},${jobId},'payments_wipe',${"drain-wake:" + jobId},
            ${tx.json({ provider: "clip" })},'available',now())`;
      });
      const t0 = Date.now();
      await (await fetch(origin + "/wake", { method: "POST" })).text();
      let state = "available";
      while (state !== "done" && Date.now() - t0 < 1500) {
        await delay(25);
        state = await app.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${demo}, true)`;
          const [row] = await tx`select state from jobs where id=${jobId}`;
          return row.state as string;
        });
      }
      assert.equal(
        state,
        "done",
        `wake ${i}: the due payments job ran within 1.5 s`,
      );
    }
  } finally {
    await app.end();
  }
  console.log(
    "PASS worker POST /wake answers 202 no-store, survives a burst, and a due payments job runs within 1.5 s of each wake (three in a row; the sweep is 5 s)",
  );
  const workerExit = once(worker, "exit");
  const workerSignalledAt = Date.now();
  worker.kill("SIGTERM");
  const [workerCode] = await workerExit;
  const workerElapsed = Date.now() - workerSignalledAt;
  assert.equal(workerCode, 0);
  assert.ok(
    workerElapsed < DRAIN_SECONDS * 1000,
    `worker exit within drainSeconds (took ${workerElapsed} ms)`,
  );
  console.log(
    `PASS worker reports /healthz with jobs:true and exits 0 on SIGTERM in ${workerElapsed} ms`,
  );

  // ---- worker without the jobs login (§2.4) ----
  output.length = 0;
  const noJobs = start("build/server/worker.js", {
    PROCESS_KIND: "worker",
    PORT: String(port),
    APP_URL: origin,
    DATABASE_URL: "",
    WORKER_DATABASE_URL: "",
  });
  await waitFor(origin + "/healthz");
  const idle = await (await fetch(origin + "/healthz")).json();
  assert.equal(idle.ok, true);
  assert.equal(idle.jobs, false, "no jobs runner without WORKER_DATABASE_URL");
  const disabled = output
    .join("")
    .split("\n")
    .filter((l) => l.includes('"message":"worker_jobs_disabled"'));
  assert.equal(disabled.length, 1, "worker_jobs_disabled is logged once");
  assert.match(disabled[0], /"reason":"no_worker_database_url"/);
  const noJobsExit = once(noJobs, "exit");
  noJobs.kill("SIGTERM");
  assert.equal((await noJobsExit)[0], 0);
  console.log("PASS worker without WORKER_DATABASE_URL reports jobs:false");

  // ---- a jobs login that is not a gm_jobs_worker member is fatal (§2.4) ----
  output.length = 0;
  const misconfigured = start("build/server/worker.js", {
    PROCESS_KIND: "worker",
    PORT: String(port),
    APP_URL: origin,
    DATABASE_URL: "",
    // The runtime login: no gm_jobs_worker membership.
    WORKER_DATABASE_URL: target.href,
  });
  const [badCode] = await once(misconfigured, "exit");
  assert.equal(badCode, 1, "checkWorkerRole failure exits 1");
  assert.match(output.join(""), /"message":"database_fatal"/);
  console.log("PASS a misconfigured jobs login stops the worker with exit 1");
  console.log("Drain qualification passed: 5 process checks.");
} catch (error) {
  console.error(output.join("").slice(-4000));
  throw error;
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
}
