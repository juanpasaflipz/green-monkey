// Worker process (Railway service "worker"). Started with
//   node --import ./build/server/instrument.js build/server/worker.js
// so configuration (dotenv + validation) loads before anything else.
// It runs the billing provider loop (sandbox billing only), the watchdog and the jobs
// runner for worker-only kinds on its own login (WORKER_DATABASE_URL, a member of
// gm_jobs_worker; a deployed worker refuses to start without it, PLATFORM-OPS-4, and only a
// development run goes without). It never holds the schema-owner credential or a signing
// key: migrations, grants and retention run in GitHub Actions (.github/actions/deploy,
// .github/workflows/retention.yml), and server/config-rules.ts refuses those variables.
import "./config.js";
import http from "node:http";
import { hostname } from "node:os";
import type postgres from "postgres";
import { config } from "./config.js";
import { drainOnSignal } from "./boot.js";
import { log } from "./logging.js";
import { buildInfo } from "./build-info.js";
import { billingWorker } from "./billing-runtime.js";
import { configureAlerts, sendAlert } from "./ops/alerts.js";
import { createWatchdog } from "./ops/watchdog.js";
import { checkWorkerRole, connectWorker, waitForDatabase } from "./db.js";
import { createJobRunner, type JobRunner } from "./jobs/runner.js";
import { discoverTenants, workerHandlers } from "./jobs/worker-registry.js";
// >>> worker areas: imports (one line per area module; e.g. cfdi's register and boot modules)
import "./cfdi/worker/register.js";
import { cfdiWorkerBoot } from "./cfdi/worker/boot.js";
import "./payments/worker/register.js";
import { paymentsWorkerBoot } from "./payments/worker/boot.js";
// <<< worker areas: imports

const LOOP_STALE_MS = 120_000;
const info = buildInfo();
const instanceId =
  process.env.RAILWAY_REPLICA_ID ??
  process.env.RAILWAY_DEPLOYMENT_ID ??
  hostname();
const state = { ready: false, draining: false };
const loops = new Map<string, number>();
const timers: NodeJS.Timeout[] = [];
const tickNow = (name: string) => loops.set(name, Date.now());
let jobs: JobRunner | null = null;
let workerSql: postgres.Sql | null = null;

configureAlerts(config.alertWebhook, config.appEnv);

/** 200 when booted and every enabled loop ticked within 120 s, else 503. */
function health() {
  const now = Date.now();
  const stale = [...loops].filter(([, at]) => now - at > LOOP_STALE_MS);
  const ok = state.ready && !state.draining && stale.length === 0;
  const last = Math.max(0, ...loops.values());
  return {
    status: ok ? 200 : 503,
    body: {
      ok,
      version: info.version,
      commit: info.commit,
      lastTickAt: last ? new Date(last).toISOString() : null,
      stale: stale.map(([name]) => name),
      jobs: Boolean(jobs),
    },
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    const { status, body } = health();
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
    return;
  }
  // Payments (spec §4.7): the web wakes the worker after a start, cancel, sync or webhook
  // enqueue so a charge reaches the terminal without waiting for the 5 s sweep. No auth and no
  // body: it carries no data and only advances discovery (runner.poke() coalesces bursts to one
  // discovery per 250 ms); the port is reachable on the private network only.
  if (req.method === "POST" && req.url === "/wake") {
    req.resume();
    jobs?.poke();
    res.writeHead(202, { "Cache-Control": "no-store" });
    res.end();
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
// No host: listens on :: (dual stack) where IPv6 exists, which Railway's
// private network (worker.railway.internal) requires, else on 0.0.0.0.
server.listen(config.port, () =>
  log.info("worker_listening", { port: config.port, instanceId }),
);

const billing = config.billingEnabled
  ? await billingWorker(process.env).catch((error) => {
      log.error("worker_billing_failed", {}, error);
      process.exit(1);
    })
  : null;
if (billing) {
  tickNow("billing");
  timers.push(
    setInterval(() => {
      const at = billing.lastTickAt();
      if (at) loops.set("billing", at);
    }, 5000),
  );
}

const watchdog = createWatchdog({
  appUrl: config.appUrl,
  billingSql: billing?.sql ?? null,
  alert: sendAlert,
});
const runWatchdog = async () => {
  await watchdog.check();
  tickNow("watchdog");
};
void runWatchdog();
timers.push(setInterval(() => void runWatchdog(), 60_000));
for (const timer of timers) timer.unref();

if (config.workerDatabaseUrl) {
  const sql = connectWorker(config.workerDatabaseUrl);
  workerSql = sql;
  // A misconfigured login (not a gm_jobs_worker member, or more privileged)
  // is fatal: Railway keeps the previous deployment.
  await waitForDatabase(sql, { check: checkWorkerRole });
  jobs = createJobRunner(sql, {
    handlers: workerHandlers,
    concurrency: 4,
    sweepMs: 5000,
    log: log.child({ loop: "worker-jobs" }),
    discover: async () => {
      const kinds = [...workerHandlers().keys()];
      // With no worker kind registered discovery sends no query, so prove the
      // jobs login still reaches the database before ticking (LD-14 OQ-6):
      // losing it turns /healthz 503 and /api/ops/status worker "stale".
      if (!kinds.length) await sql`select 1`;
      const ids = await discoverTenants(sql, kinds);
      tickNow("jobs");
      return ids;
    },
    onDead: (job, code) =>
      void sendAlert({
        key: `jobs_dead_${job.kind}`,
        severity: "warning",
        title: "dead job",
        body: `jobs_dead kind=${job.kind} code=${code}`,
      }),
  });
} else
  // Development only: config refuses a deployed worker without its jobs login.
  log.warn("worker_jobs_disabled", { reason: "no_worker_database_url" });
// >>> worker areas: boot hooks (one awaited call per area, after the jobs login is
// verified and the runner created, before it starts; receives workerSql, null when
// WORKER_DATABASE_URL is unset, and process.env; a throw is fatal, so hooks
// handle provider outages themselves)
await cfdiWorkerBoot(workerSql, process.env);
await paymentsWorkerBoot(workerSql, process.env);
// <<< worker areas: boot hooks
if (jobs) {
  tickNow("jobs");
  jobs.start();
}

state.ready = true;
log.info("worker_ready", {
  billing: Boolean(billing),
  jobs: Boolean(jobs),
  workerKinds: [...workerHandlers().keys()],
  alerts: Boolean(config.alertWebhook),
  version: info.version,
  commit: info.commit,
  instanceId,
});

drainOnSignal(
  server,
  state,
  async () => {
    for (const timer of timers) clearInterval(timer);
    // Leave room for the billing close and the pool end before drainOnSignal's
    // forced exit at drainSeconds - 2 (P-19).
    await jobs?.stop(Math.max(1000, (config.drainSeconds - 10) * 1000));
    await billing?.close();
    await workerSql?.end({ timeout: 5 });
  },
  { drainSeconds: config.drainSeconds },
);
