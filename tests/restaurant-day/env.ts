/**
 * Restaurant-day gate (specs/acceptance.md §3): the one place that turns the
 * run's environment into URLs, paths and guards. Used by global setup and
 * teardown, the browser suite and the DB reconciliation suite.
 *
 * The database is always the disposable `green_monkey_acceptance_dev` on a
 * loopback host (§3.1); the role passwords are the documented local/CI ones
 * of scripts/provision-local.sql and qualification.yml.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DATABASE = "green_monkey_acceptance_dev";
export const OUT = resolve("test-results/restaurant-day");
export const STATE_FILE = resolve(OUT, "state.json");
export const SUPPORT_ENV_FILE = resolve(".env.support-acceptance");
export const SUPPORT_OPERATOR = "acceptance";

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/** Ports and URLs; TEST_BASE_URL names the web's own plain-http listener. */
export function runUrls(env: NodeJS.ProcessEnv = process.env) {
  const base = new URL(env.TEST_BASE_URL ?? "http://127.0.0.1:3390");
  const app = new URL(env.APP_URL ?? `https://${base.host}`);
  const port = Number(base.port || "80");
  const workerPort = Number(env.RD_WORKER_PORT ?? port + 1);
  const host = env.RD_PG_HOST ?? "127.0.0.1";
  const pgPort = env.RD_PG_PORT ?? "5432";
  const at = `${host}:${pgPort}/${DATABASE}`;
  return {
    base,
    app,
    port,
    workerPort,
    workerUrl: `http://127.0.0.1:${workerPort}`,
    pg: { host, port: pgPort },
    target: at,
    provisioner: `postgresql://gm_provisioner:${encodeURIComponent(env.PGPASSWORD ?? "local-only-provisioner")}@${at}`,
    provisionerAdmin: `postgresql://gm_provisioner:${encodeURIComponent(env.PGPASSWORD ?? "local-only-provisioner")}@${host}:${pgPort}/postgres`,
    migrator: `postgresql://gm_migrator:local-only-migrator@${at}`,
    runtime: `postgresql://gm_app:local-only-green-monkey@${at}`,
    worker: `postgresql://gm_worker:local-only-worker@${at}`,
  };
}

/**
 * §3.1 guards: loopback database named exactly green_monkey_acceptance_dev,
 * TEST_BASE_URL plain http on loopback, APP_URL https on the same host and
 * port (LD-16 L12, §3.2.1). Throws with the reason.
 */
export function assertIsolatedRun(env: NodeJS.ProcessEnv = process.env) {
  const u = runUrls(env);
  if (!LOOPBACK.has(u.pg.host))
    throw Error(
      "restaurant-day: the database host must be 127.0.0.1 or localhost",
    );
  if (u.base.protocol !== "http:" || !LOOPBACK.has(u.base.hostname))
    throw Error(
      "restaurant-day: TEST_BASE_URL must be http:// on a loopback host",
    );
  if (u.app.protocol !== "https:")
    throw Error("restaurant-day: APP_URL must be https:// (LD-16 L12)");
  if (u.app.hostname !== u.base.hostname || u.app.port !== u.base.port)
    throw Error(
      "restaurant-day: APP_URL and TEST_BASE_URL must name the same host and port",
    );
  return u;
}

/** Branch K (day-cfdi job) when a Facturapi test key is present, else N. */
export function cfdiBranch(env: NodeJS.ProcessEnv = process.env): "N" | "K" {
  return env.FACTURAPI_TEST_KEY?.trim() || cfdiFakePort(env) ? "K" : "N";
}

/**
 * Local triage of branch K against tests/fakes/facturapi-fake.ts
 * (RD_CFDI_FAKE_PORT): the worker then runs as APP_ENV=test, the only place a
 * loopback FACTURAPI_BASE_URL is accepted (cfdi config). It proves the UI
 * flow, never the sandbox: CI refuses it, and a run with it is never the gate.
 */
export function cfdiFakePort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.RD_CFDI_FAKE_PORT?.trim();
  if (!raw) return null;
  if (env.CI) throw Error("restaurant-day: RD_CFDI_FAKE_PORT is a local triage switch; CI never sets it");
  if (env.FACTURAPI_TEST_KEY?.trim())
    throw Error("restaurant-day: RD_CFDI_FAKE_PORT and FACTURAPI_TEST_KEY are exclusive");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("restaurant-day: RD_CFDI_FAKE_PORT must be a port number");
  return port;
}

/** SUPPORT_DATABASE_URL from the operator file support:provision wrote. */
export function supportDatabaseUrl(): string {
  if (!existsSync(SUPPORT_ENV_FILE))
    throw Error("restaurant-day: .env.support-acceptance is missing");
  const line = readFileSync(SUPPORT_ENV_FILE, "utf8")
    .split("\n")
    .find((l) => l.startsWith("SUPPORT_DATABASE_URL="));
  if (!line)
    throw Error("restaurant-day: SUPPORT_DATABASE_URL not provisioned");
  return line.slice("SUPPORT_DATABASE_URL=".length).trim();
}

export type RunState = {
  runId: string;
  branch: "N" | "K";
  startedAt: string;
  baseUrl: string;
  appUrl: string;
  cutoffA: string;
  cutoffB: string;
  businessDateA: string;
  businessDateB: string;
  tenantA?: string;
  tenantB?: string;
  /** order-book id (A01…, B1…) → orders.id */
  orders: Record<string, string>;
  /** order-book id → order number shown on screen */
  numbers: Record<string, number>;
  /** offline sales: order-book id → epoch ms when "Guardar" was tapped */
  realSoldAt: Record<string, number>;
  /** offline provisional prefix the server assigned to Caja 1 */
  offlinePrefix?: string;
  employees: Record<string, string>;
  devices: Record<string, string>;
  [key: string]: unknown;
};

export function readState(): RunState {
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as RunState;
}
