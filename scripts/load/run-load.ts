// Load test runner (GAP-4). Simulates per restaurant: a cashier terminal
// placing orders (Poisson arrivals, extra rounds, cash/card and split
// payments), KDS screens polling /kitchen and advancing rounds, a tables
// view polling /orders, and a second register that signs rotating cashiers
// in by PIN and opens and closes drawers throughout the load phase, so
// /cash/open's automatic Free slots (ARCHITECTURE E7) meet PIN sign-ins and
// the rest of the load. Reports p50/p95/p99 per route template, errors, KDS
// appearance latency and throughput; exits 1 when a threshold fails or any
// request answers 409 concurrent_update (LD-15 account Q8, LD-32 OPS-3).
//   LOAD_BASE_URL + LOAD_ORIGIN_ALLOWLIST (exact origin), LOAD_PROFILE,
//   KDS_POLL_MS (optional), LOAD_FIXTURE (default work/load/fixture.json),
//   LOAD_EVIDENCE_DIR (default docs/evidence/load), LOAD_SERVER_LOG
//   (optional: the server's JSON log, whose db_retry lines are counted).
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { peakRate, profiles, thresholds } from "./profile.js";

interface Credentials {
  employeeId: string;
  login: string;
  secret: string;
}
interface TenantFixture {
  tenantId: string;
  name: string;
  owner: Credentials;
  cashier: Credentials;
  kitchen: Credentials[];
  /** The second register's rotating cashiers (load:seed). */
  drawerCashiers: Credentials[];
  /** Single-use: the register's, one per KDS screen, then the second register's (load:seed). */
  pairingCodes: string[];
  products: { id: string; price: number; groups: { options: string[] }[] }[];
  tables: string[];
}

const base = process.env.LOAD_BASE_URL ?? "";
const origin = new URL(base).origin;
if (!base || process.env.LOAD_ORIGIN_ALLOWLIST !== origin)
  throw Error(
    "LOAD_ORIGIN_ALLOWLIST must equal the exact LOAD_BASE_URL origin",
  );
const profile = profiles[process.env.LOAD_PROFILE ?? "smoke"];
if (!profile) throw Error("LOAD_PROFILE must be smoke, target or stress");
const kdsPollMs = Number(process.env.KDS_POLL_MS ?? profile.kdsPollMs);
const fixture = JSON.parse(
  readFileSync(process.env.LOAD_FIXTURE ?? "work/load/fixture.json", "utf8"),
) as { tenants: TenantFixture[] };
const tenants = fixture.tenants.slice(0, profile.tenants);
if (tenants.length < profile.tenants)
  throw Error(
    `fixture has ${tenants.length} tenants; run load:seed for ${profile.name}`,
  );
if (
  tenants.some(
    (t) =>
      (t.pairingCodes?.length ?? 0) < 2 + profile.kdsScreensPerTenant ||
      (t.drawerCashiers?.length ?? 0) < 3,
  )
)
  throw Error(
    "fixture lacks pairing codes or drawer cashiers; re-run load:seed",
  );

// ---- measurement ----
const samples = new Map<string, number[]>();
const errors = new Map<string, number>();
const kdsAppearance: number[] = [];
let requests = 0,
  failures = 0,
  unexpected5xx = 0,
  concurrentUpdates = 0,
  drawersCycled = 0,
  ordersCompleted = 0;
const record = (key: string, ms: number) => {
  const list = samples.get(key) ?? [];
  list.push(ms);
  samples.set(key, list);
};
const pct = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ],
  );
};

let pairing: Promise<unknown> = Promise.resolve();

/** One simulated browser: its own keep-alive pool (≤ 6 sockets) and cookies. */
class Device {
  private agent = base.startsWith("https")
    ? new https.Agent({ keepAlive: true, maxSockets: 6 })
    : new http.Agent({ keepAlive: true, maxSockets: 6 });
  private cookies = new Map<string, string>();
  csrf = "";

  async call<T = any>(
    method: "GET" | "POST",
    path: string,
    label: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const started = performance.now();
    const target = new URL("/api" + path, base);
    const client = target.protocol === "https:" ? https : http;
    const result = await new Promise<{
      status: number;
      text: string;
      retryAfter: boolean;
    }>((resolve, reject) => {
      const req = client.request(
        target,
        {
          method,
          agent: this.agent,
          headers: {
            "Content-Type": "application/json",
            ...(payload
              ? { "Content-Length": Buffer.byteLength(payload) }
              : {}),
            "x-csrf-token": this.csrf,
            cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          },
          timeout: 30_000,
        },
        (res) => {
          for (const cookie of res.headers["set-cookie"] ?? []) {
            const pair = cookie.split(";", 1)[0];
            const i = pair.indexOf("=");
            this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
          }
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              text,
              retryAfter: Boolean(res.headers["retry-after"]),
            }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error("request_timeout")));
      req.on("error", reject);
      req.end(payload);
    }).catch((error: Error) => ({
      status: 0,
      text: JSON.stringify({ error: error.message }),
      retryAfter: false,
    }));
    const ms = performance.now() - started;
    requests++;
    record(`${method} ${label}`, ms);
    let data: any;
    try {
      data = JSON.parse(result.text);
    } catch {
      data = null;
    }
    if (result.status >= 400 || result.status === 0) {
      failures++;
      const key = `${method} ${label} ${result.status} ${data?.error ?? ""}`;
      errors.set(key, (errors.get(key) ?? 0) + 1);
      if (result.status >= 500 && !(result.status === 503 && result.retryAfter))
        unexpected5xx++;
      if (result.status === 409 && data?.error === "concurrent_update")
        concurrentUpdates++;
    }
    return { status: result.status, data };
  }

  /** Pairs this browser as a terminal with a single-use code (POST /api/access/pair). */
  async pair(code: string) {
    // The pair route allows 10 requests per IP per minute and counts each one
    // while in flight, so browsers pair one at a time across all restaurants.
    const turn = pairing.then(() =>
      this.call("POST", "/access/pair", "/access/pair", { code }),
    );
    pairing = turn.catch(() => undefined);
    const r = await turn;
    if (r.status !== 200)
      throw Error(`pairing failed: ${r.status} ${r.data?.error ?? ""}`);
  }

  /** Signs a staff member in on this paired browser (POST /api/access/pin). */
  async signIn(c: Credentials) {
    const r = await this.call("POST", "/access/pin", "/access/pin", {
      employeeId: c.employeeId,
      secret: c.secret,
    });
    if (r.status !== 200)
      throw Error(
        `sign-in failed for ${c.login}: ${r.status} ${r.data?.error ?? ""}`,
      );
    const session = await this.call("GET", "/session", "/session");
    this.csrf = session.data.csrf;
  }

  close() {
    this.agent.destroy();
  }
}

const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
function lines(t: TenantFixture) {
  return Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => {
    const product = pick(t.products);
    return {
      id: randomUUID(),
      productId: product.id,
      quantity: 1 + Math.floor(Math.random() * 2),
      options: product.groups.map((g) => pick(g.options)),
      note: "",
    };
  });
}

/** Round id → time its POST answered, per tenant, for KDS appearance latency. */
const pendingRounds = new Map<string, number>();
const stopAt = Date.now() + profile.durationSec * 1000;
const running = () => Date.now() < stopAt;

async function cashier(t: TenantFixture, device: Device) {
  // Non-homogeneous Poisson arrivals by thinning: every tick an order starts
  // with probability rate·ramp·dt, so the ramp takes effect immediately.
  const rate = peakRate(profile);
  const tickMs = 100;
  const started = Date.now();
  const inFlight: Promise<void>[] = [];
  while (running()) {
    const ramp = Math.min(
      1,
      (Date.now() - started) / Math.max(profile.rampSec * 1000, 1),
    );
    if (Math.random() < rate * ramp * (tickMs / 1000))
      inFlight.push(order(t, device));
    await delay(tickMs);
  }
  await Promise.allSettled(inFlight);
}

async function order(t: TenantFixture, device: Device) {
  const dineIn = Math.random() < 0.5;
  const draft = {
    lines: lines(t),
    mode: dineIn ? "dine_in" : "takeaway",
    tableId: dineIn ? pick(t.tables) : null,
    name: "",
    note: "",
    channel: "pos",
  };
  const created = await device.call("POST", "/orders", "/orders", {
    operationId: randomUUID(),
    ...draft,
  });
  if (created.status !== 200) return;
  let o = created.data;
  for (const r of o.rounds ?? []) pendingRounds.set(r.id, performance.now());
  if (Math.random() < profile.roundsPerOrder - 1) {
    const round = await device.call(
      "POST",
      `/orders/${o.id}/rounds`,
      "/orders/:id/rounds",
      {
        operationId: randomUUID(),
        expectedVersion: o.version,
        ...draft,
        lines: lines(t),
      },
    );
    if (round.status === 200) {
      const known = new Set((o.rounds ?? []).map((r: { id: string }) => r.id));
      o = round.data;
      for (const r of o.rounds ?? [])
        if (!known.has(r.id)) pendingRounds.set(r.id, performance.now());
    }
  }
  const read = await device.call("GET", `/orders/${o.id}`, "/orders/:id");
  if (read.status === 200) o = read.data;
  const card = Math.random() < profile.cardShare;
  const parts =
    Math.random() < profile.splitShare && o.total > 1
      ? [Math.floor(o.total / 2), o.total - Math.floor(o.total / 2)]
      : [o.total];
  for (const amount of parts) {
    const paid = await device.call(
      "POST",
      `/orders/${o.id}/payments`,
      "/orders/:id/payments",
      {
        operationId: randomUUID(),
        amount,
        tip: 0,
        received: amount,
        method: card ? "external" : "cash",
        externalConfirmed: card,
        reference: card ? `LOAD-${o.number}` : "",
      },
    );
    if (paid.status !== 200) return;
  }
  ordersCompleted++;
}

async function kds(device: Device, screen: number, screens: number) {
  const stage = new Map<string, number>();
  const next = ["seen", "ready", "completed"];
  while (running()) {
    const polled = await device.call("GET", "/kitchen", "/kitchen");
    const now = performance.now();
    if (polled.status === 200)
      for (const round of polled.data as { id: string; state: string }[]) {
        const posted = pendingRounds.get(round.id);
        if (posted !== undefined) {
          kdsAppearance.push(now - posted);
          pendingRounds.delete(round.id);
        }
        // Each screen advances its share of rounds, one step per poll.
        if (parseInt(round.id.slice(-2), 16) % screens !== screen) continue;
        // A round already ready (another screen's, or one a previous run on
        // the same fixture left behind) continues from its real state.
        const step = Math.max(
          stage.get(round.id) ?? 0,
          round.state === "ready" ? 2 : 0,
        );
        if (step < next.length) {
          const r = await device.call(
            "POST",
            `/kitchen/${round.id}`,
            "/kitchen/:id",
            {
              operationId: randomUUID(),
              state: next[step],
            },
          );
          if (r.status === 200) stage.set(round.id, step + 1);
        }
      }
    await delay(kdsPollMs);
  }
}

/**
 * The second register (LD-32 OPS-3): rotating cashiers sign in by PIN, open a
 * drawer (autoAssignFreeSlots moves the device slot and, in automatic mode,
 * evicts the employee slot of the oldest drawer), then close it, for the whole
 * load phase.
 */
async function drawerCycle(t: TenantFixture, device: Device) {
  let turn = 0;
  let open = false;
  while (running()) {
    if (!open) {
      const who = t.drawerCashiers[turn++ % t.drawerCashiers.length];
      await device.signIn(who);
      const opened = await device.call("POST", "/cash/open", "/cash/open", {
        operationId: randomUUID(),
        opening: 0,
      });
      open = opened.status === 200;
    }
    await delay(1500 + Math.random() * 1500);
    if (open) {
      const closed = await device.call("POST", "/cash/close", "/cash/close", {
        operationId: randomUUID(),
        counted: 0,
        reason: "",
      });
      if (closed.status === 200) {
        open = false;
        drawersCycled++;
      }
    }
    await delay(500 + Math.random() * 1000);
  }
}

async function tablesView(device: Device) {
  while (running()) {
    await device.call("GET", "/orders", "/orders");
    await delay(profile.tablesPollMs);
  }
}

async function tenant(t: TenantFixture) {
  const register = new Device();
  const register2 = new Device();
  const screens = Array.from(
    { length: profile.kdsScreensPerTenant },
    () => new Device(),
  );
  try {
    // Pair each browser with its code, then sign in the staff member by PIN.
    await register.pair(t.pairingCodes[0]);
    await register.signIn(t.cashier);
    for (const [i, screen] of screens.entries()) {
      await screen.pair(t.pairingCodes[1 + i]);
      await screen.signIn(t.kitchen[i % t.kitchen.length]);
    }
    await register2.pair(t.pairingCodes[1 + screens.length]);
    await register.call("POST", "/cash/open", "/cash/open", {
      operationId: randomUUID(),
      opening: 0,
    });
    await Promise.all([
      cashier(t, register),
      tablesView(register),
      drawerCycle(t, register2),
      ...screens.map((s, i) => kds(s, i, screens.length)),
    ]);
  } finally {
    register.close();
    register2.close();
    for (const s of screens) s.close();
  }
}

const startedAt = new Date();
await Promise.all(tenants.map(tenant));
const elapsedSec = (Date.now() - startedAt.getTime()) / 1000;

// ---- report ----
const routes = [...samples]
  .map(([route, values]) => ({
    route,
    count: values.length,
    p50: pct(values, 50),
    p95: pct(values, 95),
    p99: pct(values, 99),
  }))
  .sort((a, b) => a.route.localeCompare(b.route));
const reads = [...samples]
  .filter(([k]) => k.startsWith("GET ") && k !== "GET /session")
  .flatMap(([, v]) => v);
const setup = new Set(["POST /access/pair", "POST /access/pin"]);
// tenant()'s retried deadlocks and serialization failures in the server log
// (RUNBOOK "Signals"): reported; E7 sanctions at most one retry per command.
let dbRetries: number | null = null;
if (process.env.LOAD_SERVER_LOG)
  try {
    dbRetries = readFileSync(process.env.LOAD_SERVER_LOG, "utf8")
      .split("\n")
      .filter((line) => line.includes('"message":"db_retry"')).length;
  } catch {
    dbRetries = null;
  }
const writes = [...samples]
  .filter(([k]) => k.startsWith("POST ") && !setup.has(k))
  .flatMap(([, v]) => v);
const summary = {
  profile: profile.name,
  target: origin,
  startedAt: startedAt.toISOString(),
  durationSec: Math.round(elapsedSec),
  tenants: tenants.length,
  kdsPollMs,
  requests,
  throughputRps: Math.round((requests / elapsedSec) * 10) / 10,
  ordersCompleted,
  errorRate: requests ? failures / requests : 0,
  unexpected5xx,
  concurrentUpdates,
  drawersCycled,
  dbRetries,
  readP95Ms: pct(reads, 95),
  mutationP95Ms: pct(writes, 95),
  kdsAppearanceP95Ms: pct(kdsAppearance, 95),
  kdsAppearanceSamples: kdsAppearance.length,
  routes,
  errors: Object.fromEntries(errors),
  thresholds,
};
const failed = [
  summary.readP95Ms > thresholds.readP95Ms && "reads p95",
  summary.mutationP95Ms > thresholds.mutationP95Ms && "mutations p95",
  summary.kdsAppearanceP95Ms > thresholds.kdsAppearanceP95Ms &&
    "KDS appearance p95",
  summary.errorRate >= thresholds.maxErrorRate && "error rate",
  summary.unexpected5xx > 0 && "5xx without Retry-After",
  summary.ordersCompleted === 0 && "no completed orders",
  // LD-15 account Q8 / LD-32 OPS-3: E7 holds only with zero concurrent_update.
  summary.concurrentUpdates > 0 && "409 concurrent_update",
  summary.drawersCycled === 0 && "no drawer opened and closed during the load",
].filter(Boolean) as string[];
const dir = process.env.LOAD_EVIDENCE_DIR ?? "docs/evidence/load";
mkdirSync(dir, { recursive: true });
const stem = `${dir}/${startedAt.toISOString().slice(0, 10)}-${new URL(base).hostname}-${profile.name}`;
writeFileSync(
  `${stem}.json`,
  JSON.stringify({ ...summary, failed }, null, 2) + "\n",
);
writeFileSync(
  `${stem}.md`,
  [
    `# Load run: ${profile.name} against ${origin}`,
    "",
    `Started ${summary.startedAt}, ${summary.durationSec} s, ${summary.tenants} restaurants, KDS poll ${kdsPollMs} ms.`,
    `${summary.requests} requests (${summary.throughputRps} req/s), ${summary.ordersCompleted} orders paid, error rate ${(summary.errorRate * 100).toFixed(3)}%.`,
    `${summary.drawersCycled} drawers opened and closed during the load, ${summary.concurrentUpdates} concurrent_update answers${summary.dbRetries === null ? "" : `, ${summary.dbRetries} db_retry log lines`}.`,
    "",
    "| Measure | p95 | Threshold |",
    "|---|---|---|",
    `| Reads | ${summary.readP95Ms} ms | ${thresholds.readP95Ms} ms |`,
    `| Mutations | ${summary.mutationP95Ms} ms | ${thresholds.mutationP95Ms} ms |`,
    `| KDS appearance (${summary.kdsAppearanceSamples} rounds) | ${summary.kdsAppearanceP95Ms} ms | ${thresholds.kdsAppearanceP95Ms} ms |`,
    "",
    "| Route | Count | p50 | p95 | p99 |",
    "|---|---|---|---|---|",
    ...routes.map(
      (r) => `| ${r.route} | ${r.count} | ${r.p50} | ${r.p95} | ${r.p99} |`,
    ),
    "",
    failed.length ? `Failed: ${failed.join(", ")}.` : "All thresholds met.",
    "",
  ].join("\n"),
);
console.log(
  JSON.stringify({
    message: "load_complete",
    ...summary,
    routes: undefined,
    failed,
  }),
);
if (failed.length) process.exitCode = 1;
