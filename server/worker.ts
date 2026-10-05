// Worker process (Railway service "worker"). Started with
//   node --import ./build/server/instrument.js build/server/worker.js
// so configuration (dotenv + validation) loads before anything else.
// Its Railway preDeploy runs `migrate.js --grants --retention`, keeping the
// migration owner credential out of the internet-facing web service; the
// same credential runs retention here every 15 minutes inside the off-hours
// window 04:00-07:00 America/Mexico_City (OPS-R6, OPS-R10).
import "./config.js";
import http from "node:http";
import { hostname } from "node:os";
import { config } from "./config.js";
import { drainOnSignal } from "./boot.js";
import { log } from "./logging.js";
import { buildInfo } from "./build-info.js";
import { billingWorker } from "./billing-runtime.js";
import { configureAlerts, sendAlert } from "./ops/alerts.js";
import { createWatchdog } from "./ops/watchdog.js";
import {
  createRetentionSchedule,
  RETENTION_WINDOW,
  type RetentionSchedule,
} from "./ops/retention.js";

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
let retention: RetentionSchedule | null = null;
const lastRetention = () => {
  const at = retention?.lastRunAt();
  return at ? new Date(at).toISOString() : null;
};

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
      lastRetentionAt: lastRetention(),
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

// Retention needs the schema owner (both tables force RLS); without the
// credential (local `npm run worker`) only the deploy-time pass runs.
const migrationUrl = process.env.MIGRATION_DATABASE_URL?.trim();
retention = migrationUrl
  ? createRetentionSchedule({ url: migrationUrl, alert: sendAlert })
  : null;
retention?.start();

state.ready = true;
log.info("worker_ready", {
  billing: Boolean(billing),
  alerts: Boolean(config.alertWebhook),
  retention: Boolean(retention),
  retentionWindow: retention
    ? `${RETENTION_WINDOW.startHour}-${RETENTION_WINDOW.endHour} ${RETENTION_WINDOW.timeZone}`
    : null,
  version: info.version,
  commit: info.commit,
});

drainOnSignal(
  server,
  state,
  async () => {
    for (const timer of timers) clearInterval(timer);
    await retention?.stop();
    await billing?.close();
  },
  { drainSeconds: config.drainSeconds },
);
