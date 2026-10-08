/**
 * Restaurant-day global setup (specs/acceptance.md §3.1-§3.3, §3.5.2, G1.9):
 *
 *   guards → business-day cutoff guard → CI-parity database reset with the seed
 *   replaced by support provisioning → per-run SIGNING_KEYS/JWT_SECRET (memory
 *   only) → D22 refusal check → web + worker from the compiled build → health,
 *   worker jobs and /api/ops/status → state.json.
 *
 * Nothing here seeds demo data: the restaurants are created later through the
 * UI. The provisioning credentials go only to the child that needs them.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  DATABASE,
  OUT,
  STATE_FILE,
  SUPPORT_ENV_FILE,
  SUPPORT_OPERATOR,
  assertIsolatedRun,
  cfdiBranch,
  cfdiFakePort,
  EDGE_HEADERS,
  type RunState,
} from "./env.js";
import { LEGAL_CI_ENV } from "../../server/legal-ci.js";
import { legalConfig } from "../../server/legal.js";
import { businessDate, minutesUntilLocal, dstChangeWithin } from "./oracle.js";
import { waivedIds } from "./ui.js";

export const PIDS_FILE = resolve(OUT, ".pids.json");
const LOGS = {
  server: resolve(OUT, "server.log"),
  worker: resolve(OUT, "worker.log"),
  facturapi: resolve(OUT, "facturapi-fake.log"),
};

/** Forbidden for each process kind (server/config-rules.ts forbiddenCredentials) plus the demo switch. */
const WEB_FORBIDDEN = [
  "MIGRATION_DATABASE_URL",
  "BACKUP_DATABASE_URL",
  "PROVISION_DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "WORKER_DATABASE_URL",
  "SUPPORT_DATABASE_URL",
  "FACTURAPI_API_KEY",
  "FACTURAPI_TEST_KEY",
  "CREDENTIAL_ENCRYPTION_KEY",
  "CFDI_LIVE_ENABLED",
  "DEMO_TENANT_ID",
  "SUPPORT_PROVISION_TARGET",
  "BILLING_DATABASE_URL",
  "BILLING_SANDBOX_ENABLED",
  "FACTURAPI_BASE_URL",
];
const WORKER_FORBIDDEN = [
  "DATABASE_URL",
  "BACKUP_DATABASE_URL",
  "PROVISION_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "SUPPORT_DATABASE_URL",
  "SIGNING_KEYS",
  "JWT_SECRET",
  "DEMO_TENANT_ID",
  "SUPPORT_PROVISION_TARGET",
  "FACTURAPI_API_KEY",
  "CREDENTIAL_ENCRYPTION_KEY",
  "CFDI_LIVE_ENABLED",
  "FACTURAPI_BASE_URL",
];
const LEGAL = [
  "LEGAL_ENTITY_NAME",
  "LEGAL_ENTITY_ADDRESS",
  "LEGAL_PRIVACY_CONTACT_EMAIL",
  "LEGAL_JURISDICTION",
  "SUPPORT_EMAIL",
  "SUPPORT_PHONE",
  "SUPPORT_HOURS",
];
const LEGAL_OPTIONAL = ["LEGAL_ENTITY_RFC"];

/** The minimum a child needs from this process: never a credential. */
function baseEnv(): Record<string, string> {
  const keep: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "TZ",
    "NODE_OPTIONS_NONE",
  ])
    if (process.env[name]) keep[name] = process.env[name]!;
  return keep;
}

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  input?: string,
) {
  const r = spawnSync(command, args, {
    env,
    input,
    encoding: "utf8",
    cwd: process.cwd(),
    timeout: 180_000,
  });
  if (r.status !== 0)
    throw Error(
      `restaurant-day setup: ${command} ${args.filter((a) => !a.includes("://")).join(" ")} failed (${r.status})\n${r.stderr}`,
    );
  return r.stdout;
}

function psql(url: string, args: string[]) {
  const target = new URL(url);
  return run(
    process.env.PSQL ?? "psql",
    [
      "-h",
      target.hostname,
      "-p",
      target.port || "5432",
      "-U",
      decodeURIComponent(target.username),
      "-d",
      target.pathname.slice(1),
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      ...args,
    ],
    { ...baseEnv(), PGPASSWORD: decodeURIComponent(target.password) },
  );
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function portFree(port: number) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return false;
  } catch (error) {
    return /ECONNREFUSED/.test(
      String((error as { cause?: unknown }).cause ?? error),
    );
  }
}

async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  alive?: ChildProcess,
) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (alive && alive.exitCode !== null)
      throw Error(
        `restaurant-day setup: ${what}: the process exited (${alive.exitCode})`,
      );
    try {
      if (await check()) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw Error(`restaurant-day setup: timed out waiting for ${what}`);
}

/** §3.5.2: 04:00 unless the next 04:00 is under 75 minutes away, then 16:00. */
function cutoffFor(timezone: string, now: Date): string {
  if (dstChangeWithin(timezone, now, 75))
    throw Error(
      `restaurant-day setup: a DST transition in ${timezone} falls within the next 75 minutes; run later`,
    );
  return minutesUntilLocal(timezone, now, 240) >= 75 ? "04:00" : "16:00";
}

export default async function globalSetup() {
  if (process.env.RD_ACCEPTANCE !== "1")
    throw Error("restaurant-day setup: RD_ACCEPTANCE=1 is required");
  const u = assertIsolatedRun();
  waivedIds(); // §13.5: refuses a never-waivable finding ID before any work
  if (process.env.DEMO_TENANT_ID?.trim())
    throw Error("restaurant-day setup: DEMO_TENANT_ID must be unset (§3.3)");
  // dotenv (`import "dotenv/config"`) would load ./.env into web and worker.
  if (existsSync(resolve(".env")))
    throw Error("restaurant-day setup: remove ./.env first (§3.2, dotenv)");
  const missing = LEGAL.filter((n) => !process.env[n]?.trim());
  if (missing.length)
    throw Error(
      `restaurant-day setup: missing ${missing.join(", ")} (export RD_LEGAL_*/RD_SUPPORT_*; scripts/restaurant-day.sh)`,
    );
  // Production refuses the identifying values of the fictional CI set (ACC-18,
  // server/legal.ts CI_IDENTIFYING); fail here with the reason.
  const identifying = [
    "LEGAL_ENTITY_NAME",
    "LEGAL_ENTITY_ADDRESS",
    "LEGAL_PRIVACY_CONTACT_EMAIL",
    "SUPPORT_EMAIL",
    "SUPPORT_PHONE",
  ] as const;
  const ci = identifying
    .map((n) => [n, LEGAL_CI_ENV[n]] as const)
    .filter(
      ([n, v]) => process.env[n]?.trim().toLowerCase() === v.toLowerCase(),
    );
  if (ci.length)
    throw Error(
      `restaurant-day setup: ${ci.map(([n]) => n).join(", ")} still hold the CI literals; export the RD_* values`,
    );
  // Production publishes only well-formed values (account §2.2, legalConfig):
  // any other value is left out of the documents or of "Ayuda y soporte" and
  // logged (legal_optional_values_invalid, a G4 failure much later); fail here
  // with the names. SUPPORT_PHONE is E.164 without spaces (+525512345678).
  const refused = legalConfig({
    ...Object.fromEntries(
      [...LEGAL, ...LEGAL_OPTIONAL].map((n) => [n, process.env[n] ?? ""]),
    ),
    NODE_ENV: "production",
    APP_ENV: "production",
  });
  const unusable = [...refused.missing, ...refused.invalid];
  if (unusable.length)
    throw Error(
      `restaurant-day setup: production refuses ${unusable.map((n) => `RD_${n}`).join(", ")} (format and placeholder rules of server/legal.ts; a phone is E.164 without spaces, like +525512345678)`,
    );
  if (process.env.LEGAL_UNPUBLISHED_SIGNUP === "allow")
    throw Error(
      "restaurant-day setup: LEGAL_UNPUBLISHED_SIGNUP must not be allow (§3.3)",
    );
  const fakePort = cfdiFakePort();
  for (const port of [u.port, u.workerPort, ...(fakePort ? [fakePort] : [])])
    if (!(await portFree(port)))
      throw Error(`restaurant-day setup: port ${port} is busy`);

  const branch = cfdiBranch();
  const now = new Date();
  const cutoffA = cutoffFor("America/Mexico_City", now);
  const cutoffB = cutoffFor("America/Tijuana", now);

  // Output folder: everything but Playwright's own artifacts dir.
  mkdirSync(OUT, { recursive: true });
  for (const entry of readdirSync(OUT))
    if (entry !== "artifacts")
      rmSync(resolve(OUT, entry), { recursive: true, force: true });
  for (const dir of ["screens", "axe", "prints"])
    mkdirSync(resolve(OUT, dir), { recursive: true });

  // §3.1 step 0: a crashed run's operator file (support:provision never overwrites it).
  rmSync(SUPPORT_ENV_FILE, { force: true });
  // Step 1: cluster roles, idempotent.
  psql(u.provisionerAdmin, ["-f", "scripts/provision-local.sql"]);
  psql(u.provisionerAdmin, ["-f", "scripts/ops/sql/globals.sql"]);
  psql(u.provisionerAdmin, ["-c", "GRANT gm_jobs_worker TO gm_worker"]);
  psql(u.provisionerAdmin, [
    "-c",
    "ALTER ROLE gm_migrator LOGIN PASSWORD 'local-only-migrator'",
  ]);
  // Step 2: a fresh database.
  psql(u.provisionerAdmin, [
    "-c",
    `drop database if exists ${DATABASE} with (force)`,
  ]);
  psql(u.provisionerAdmin, [
    "-c",
    `drop role if exists gm_support_${SUPPORT_OPERATOR}`,
  ]);
  psql(u.provisionerAdmin, [
    "-c",
    `create database ${DATABASE} owner gm_provisioner`,
  ]);
  psql(u.provisioner, ["-f", "scripts/ops/sql/database-grants.sql"]);
  // Step 3: migrate as the non-superuser owner, exactly as CI.
  run(
    process.execPath,
    ["--import", "tsx", "scripts/migrate.ts", "--grants", "--retention"],
    {
      ...baseEnv(),
      APP_ENV: "staging",
      PG_APP_USER: "gm_app",
      MIGRATION_DATABASE_URL: u.migrator,
    },
  );
  // Step 4: no seed. Support provisioning instead (the only child with these two values).
  run(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/provision-support-operator.ts",
      "--name",
      SUPPORT_OPERATOR,
    ],
    {
      ...baseEnv(),
      PROVISION_DATABASE_URL: u.provisioner,
      SUPPORT_PROVISION_TARGET: u.target,
    },
  );

  // §3.3 / Q20: per-run keys, held in memory only.
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  // isPlaceholderSigningKey refuses an all-printable secret (odds about 2e-14).
  const newKey = () => randomBytes(32);
  let secret = newKey();
  while (/^[\x20-\x7e]+$/.test(secret.toString("latin1"))) secret = newKey();
  const signingKey = `k${day}-${randomBytes(2).toString("hex")}:${secret.toString("base64url")}`;
  const jwtSecret = randomBytes(48).toString("base64url");

  const deployedEnv = branch === "K" ? "staging" : "production";
  const legal: Record<string, string> = {};
  for (const name of [...LEGAL, ...LEGAL_OPTIONAL])
    if (process.env[name]?.trim()) legal[name] = process.env[name]!;
  const webEnv: Record<string, string> = {
    ...baseEnv(),
    ...Object.fromEntries(WEB_FORBIDDEN.map((n) => [n, ""])),
    ...legal,
    LEGAL_UNPUBLISHED_SIGNUP: "off",
    NODE_ENV: "production",
    APP_ENV: deployedEnv,
    RAILWAY_ENVIRONMENT_NAME: deployedEnv,
    PORT: String(u.port),
    APP_URL: u.app.origin,
    DATABASE_URL: u.runtime,
    SIGNING_KEYS: signingKey,
    JWT_SECRET: jwtSecret,
    WORKER_URL: u.workerUrl,
    ACCESS_STEP_UP_SECONDS: "60",
    ACCESS_IDLE_LOCK_DEFAULT_SECONDS: "0",
    // G1.8 needs the Google button, which renders only when the OAuth client
    // is configured. Inert per-run values: the suite never starts the flow
    // (F1 is the documented identity substitute), so Google is never contacted.
    GOOGLE_CLIENT_ID: `rd-${randomBytes(6).toString("hex")}.apps.googleusercontent.com`,
    GOOGLE_CLIENT_SECRET: randomBytes(24).toString("base64url"),
    GOOGLE_REDIRECT_URI: `${u.app.origin}/api/auth/google/callback`,
  };
  const workerEnv: Record<string, string> = {
    ...baseEnv(),
    ...Object.fromEntries(WORKER_FORBIDDEN.map((n) => [n, ""])),
    NODE_ENV: "production",
    APP_ENV: deployedEnv,
    RAILWAY_ENVIRONMENT_NAME: deployedEnv,
    WORKER_PORT: String(u.workerPort),
    APP_URL: u.app.origin,
    WORKER_DATABASE_URL: u.worker,
    FACTURAPI_TEST_KEY:
      branch === "K" && !fakePort ? process.env.FACTURAPI_TEST_KEY!.trim() : "",
    // Local triage only (cfdiFakePort): an unknown sk_test_ key gets the fake's
    // ready shared-sandbox organization.
    ...(fakePort
      ? {
          APP_ENV: "test",
          RAILWAY_ENVIRONMENT_NAME: "",
          FACTURAPI_TEST_KEY: `sk_test_rdfake${randomBytes(6).toString("hex")}`,
          FACTURAPI_BASE_URL: `http://127.0.0.1:${fakePort}/v2`,
        }
      : {}),
  };
  const web = [
    "--import",
    "./build/server/instrument.js",
    "build/server/index.js",
  ];
  const worker = [
    "--import",
    "./build/server/instrument.js",
    "build/server/worker.js",
  ];
  if (!existsSync("build/server/index.js"))
    throw Error("restaurant-day setup: run npm run build first");

  // G1.9 / D22: production-valued web with DEMO_TENANT_ID refuses to start.
  {
    const d22 = spawn(process.execPath, web, {
      env: {
        ...webEnv,
        DEMO_TENANT_ID: "10000000-0000-4000-8000-000000000001",
        APP_ENV: "production",
        RAILWAY_ENVIRONMENT_NAME: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      answered = false;
    d22.stdout!.on("data", (b) => (stdout += b));
    d22.stderr!.on("data", (b) => (stderr += b));
    const exited = new Promise<number | null>((r) =>
      d22.on("exit", (code) => r(code)),
    );
    const end = Date.now() + 10_000;
    let code: number | null | undefined;
    while (Date.now() < end && code === undefined) {
      code = await Promise.race([exited, sleep(250).then(() => undefined)]);
      if (code === undefined)
        answered ||= await fetch(`http://127.0.0.1:${u.port}/api/health`, {
          signal: AbortSignal.timeout(500),
        })
          .then(() => true)
          .catch(() => false);
    }
    if (code === undefined) d22.kill("SIGKILL");
    writeFileSync(
      resolve(OUT, "d22.log"),
      `exit=${code}\nanswered_health=${answered}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
    );
    if (
      code === undefined ||
      code === 0 ||
      answered ||
      !stderr.includes("DEMO_TENANT_ID must not be set in production") ||
      /config_invalid/.test(stdout)
    )
      throw Error(
        `restaurant-day setup: D22 refusal check failed (see ${resolve(OUT, "d22.log")})`,
      );
  }

  const pids: Record<string, number> = {};
  const start = (
    name: "server" | "worker" | "facturapi",
    args: string[],
    env: Record<string, string>,
  ) => {
    const fd = openSync(LOGS[name], "a");
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", fd, fd],
      detached: false,
    });
    closeSync(fd);
    child.unref();
    pids[name] = child.pid!;
    writeFileSync(PIDS_FILE, JSON.stringify(pids));
    return child;
  };
  if (fakePort) {
    const fake = start(
      "facturapi",
      ["--import", "tsx", "tests/fakes/facturapi-fake.ts"],
      { ...baseEnv(), FACTURAPI_FAKE_PORT: String(fakePort) },
    );
    await waitFor(
      "the Facturapi fake",
      async () =>
        (await fetch(`http://127.0.0.1:${fakePort}/v2/organizations`)).status >
        0,
      30_000,
      fake,
    ).catch((error) => {
      fake.kill();
      throw error;
    });
  }
  const webProcess = start("server", web, webEnv);
  const workerProcess = start("worker", worker, workerEnv);
  try {
    await waitFor(
      "GET /api/health",
      async () => (await fetch(`${u.base.origin}/api/health`)).status === 200,
      60_000,
      webProcess,
    );
    await waitFor(
      "worker /healthz jobs:true",
      async () =>
        (await (await fetch(`${u.workerUrl}/healthz`)).json()).jobs === true,
      60_000,
      workerProcess,
    );
    await waitFor(
      "/api/ops/status ok",
      async () => {
        const s = await (
          await fetch(`${u.base.origin}/api/ops/status`, {
            headers: EDGE_HEADERS,
          })
        ).json();
        return (
          s.ok === true && s.worker?.status === "ok" && s.degraded === false
        );
      },
      60_000,
      webProcess,
    );
  } catch (error) {
    for (const pid of Object.values(pids))
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    throw error;
  }

  const runId = `${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
  const state: RunState = {
    runId,
    branch,
    startedAt: now.toISOString(),
    baseUrl: u.base.origin,
    appUrl: u.app.origin,
    cutoffA,
    cutoffB,
    businessDateA: businessDate(now, "America/Mexico_City", cutoffA),
    businessDateB: businessDate(now, "America/Tijuana", cutoffB),
    orders: {},
    numbers: {},
    realSoldAt: {},
    employees: {},
    devices: {},
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  // The test workers sign the F1 owner cookie (owner.spec pattern) with the
  // web's keys: they inherit this process's environment, never a file.
  process.env.SIGNING_KEYS = signingKey;
  process.env.JWT_SECRET = jwtSecret;
  process.env.RD_RUNTIME_DATABASE_URL = u.runtime;
  process.env.RD_PROVISIONER_URL = u.provisioner;
  process.env.RD_WORKER_URL = u.workerUrl;
}

/** Reads the PIDs this setup started (teardown). */
export function startedPids(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(PIDS_FILE, "utf8"));
  } catch {
    return {};
  }
}
