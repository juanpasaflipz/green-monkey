#!/usr/bin/env node
/* global process, console, fetch, setTimeout, AbortSignal */
// Post-deploy HTTP smoke (no browser). Used by .github/workflows/deploy.yml.
//   node scripts/ops/smoke.mjs --base-url https://app.example.com \
//     --expect-commit <40-char sha> [--timeout 600] [--local] [--poll-ms 5000]
// Checks: the new revision is live (/api/version), health, ops status with a
// healthy worker that runs the same commit with its jobs runner on (a deployed
// run waits for the new worker: `railway up --ci` returns when the build ends,
// and a worker that fails to boot leaves the old one answering, PLATFORM-OPS-2),
// the proxy hop (client IP is public, arrives as a forwarded hop and spoofed
// forwarding headers are ignored), malformed JSON handling with a matching
// request id, and that the API requires a session. --local (loopback runs)
// skips the proxy hop and the worker commit/jobs requirement. Prints one JSON
// report and exits 1 on any failure.

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split(/\s(?=--)/)
    .filter(Boolean)
    .map((part) => {
      const [key, ...rest] = part.replace(/^--/, "").split(" ");
      return [key, rest.join(" ") || true];
    }),
);
const base = String(args["base-url"] ?? process.env.APP_URL ?? "").replace(
  /\/$/,
  "",
);
const expected = args["expect-commit"];
const timeoutMs = Number(args.timeout ?? 600) * 1000;
const pollMs = Number(args["poll-ms"] ?? 5000);
const local = args.local === true;
const report = { base, expectedCommit: expected ?? null, checks: [] };

function fail(message) {
  report.ok = false;
  report.error = message;
  console.log(JSON.stringify(report));
  process.exit(1);
}
if (!/^https?:\/\//.test(base)) fail("base_url_required");
if (expected !== undefined && !/^[0-9a-f]{40}$/.test(String(expected)))
  fail("expect_commit_must_be_full_sha");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (path, init = {}) =>
  fetch(base + path, { ...init, signal: AbortSignal.timeout(15_000) });
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    report.checks.push({
      name,
      ok: true,
      ms: Date.now() - started,
      ...(detail ?? {}),
    });
  } catch (error) {
    report.checks.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: String(error?.message ?? error),
    });
    fail(`${name} failed`);
  }
}
async function until(name, deadline, probe) {
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result.ok) return result;
      last = result.reason;
    } catch (error) {
      last = String(error?.message ?? error);
    }
    await sleep(pollMs);
  }
  throw Error(`${name}: ${last}`);
}

/** RFC 1918, loopback, link-local, CGNAT (Railway edge 100.64/10 and 100/8) and IPv6 private ranges. */
function isPrivate(ip) {
  if (/^(::1|fe80:|fc|fd)/i.test(ip)) return true;
  const v4 = ip.replace(/^::ffff:/, "");
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n)))
    return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 100 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

const deadline = Date.now() + timeoutMs;
await check("version", async () => {
  const result = await until("version", deadline, async () => {
    const response = await get("/api/version");
    const body = await response.json();
    if (!response.ok) return { ok: false, reason: `status ${response.status}` };
    if (expected && body.commit !== expected)
      return {
        ok: false,
        reason: `serving ${String(body.commit).slice(0, 12)}`,
      };
    return { ok: true, body };
  });
  return { commit: result.body.commit, version: result.body.version };
});
await check("health", async () => {
  const response = await get("/api/health");
  if (response.status !== 200) throw Error(`status ${response.status}`);
});
await check("ops_status", async () => {
  const result = await until(
    "ops_status",
    // The worker uploads first but may finish its health check after the web.
    Math.min(deadline, Date.now() + 300_000),
    async () => {
      const response = await get("/api/ops/status");
      const body = await response.json();
      if (body.ok !== true)
        return { ok: false, reason: `db=${body.db} schema=${body.schema}` };
      if (body.worker?.status !== "ok")
        return { ok: false, reason: `worker ${body.worker?.status}` };
      if (!local) {
        // The live worker must be this deploy's, with its jobs runner on: a new
        // worker that failed to boot leaves the old one answering ok.
        if (expected && body.worker.commit !== expected)
          return {
            ok: false,
            reason: `worker serving ${String(body.worker.commit).slice(0, 12)}`,
          };
        if (body.worker.jobs !== true)
          return { ok: false, reason: "worker jobs runner is off" };
        if (body.degraded !== false) return { ok: false, reason: "degraded" };
      }
      return { ok: true, body };
    },
  );
  const keys = Object.keys(result.body).sort().join(",");
  if (keys !== "commit,db,degraded,ok,schema,version,worker")
    throw Error(`unexpected keys ${keys}`);
  return {
    degraded: result.body.degraded,
    workerCommit: result.body.worker.commit ?? null,
    workerJobs: result.body.worker.jobs ?? null,
  };
});
await check("client_ip", async () => {
  const plain = await (await get("/api/ops/diagnostics/ip")).json();
  // Locally there is no edge proxy appending the real client, so loopback is
  // a trusted hop and forwarding headers are expected to apply.
  if (local) return { ip: plain.ip, local: true };
  const spoofed = await (
    await get("/api/ops/diagnostics/ip", {
      headers: { "X-Forwarded-For": "203.0.113.7", "X-Real-IP": "203.0.113.8" },
    })
  ).json();
  if (["203.0.113.7", "203.0.113.8"].includes(spoofed.ip))
    throw Error("a client-supplied forwarding header was trusted");
  if (isPrivate(plain.ip))
    throw Error("client IP is a proxy or private address");
  if (spoofed.ip !== plain.ip)
    throw Error("forwarding headers changed the client IP");
  // Access's PIN, pairing and logout limits key on this address (clientIp),
  // so a deployed edge must hand Express the real client as an
  // X-Forwarded-For hop; otherwise every client of a restaurant could fall
  // into the proxy's bucket (LD-9, OPS-INT-R3).
  if (plain.forwardedHop !== true)
    throw Error("the edge sent no X-Forwarded-For hop for the client");
  return { peerTrusted: plain.peerTrusted, forwardedHop: plain.forwardedHop };
});
await check("malformed_json", async () => {
  const response = await get("/api/public/smoke/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{bad",
  });
  const body = await response.json();
  if (response.status !== 400 || body.error !== "invalid_json")
    throw Error(`status ${response.status} ${body.error}`);
  if (
    !body.requestId ||
    response.headers.get("x-request-id") !== body.requestId
  )
    throw Error("X-Request-Id does not match the body requestId");
});
await check("session_required", async () => {
  const response = await get("/api/session");
  if (response.status !== 401) throw Error(`status ${response.status}`);
});
report.ok = true;
console.log(JSON.stringify(report));
