// Process-level checks for the compiled build, started exactly as Railway does
// (node --import ./build/server/instrument.js ...):
//  - web: SIGTERM finishes an in-flight request, answers /api/health 503
//    server_draining meanwhile, ignores idle keep-alive sockets and exits 0
//    well inside RAILWAY_DEPLOYMENT_DRAINING_SECONDS (OPS-6);
//  - worker: /healthz reports ready and SIGTERM exits 0.
// Requires `npm run build` and the isolated local development fixture.
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const target = new URL(process.env.DATABASE_URL ?? "");
if (
  target.hostname !== "127.0.0.1" ||
  !/^\/green_monkey(_[a-z]+)?_dev$/.test(target.pathname)
)
  throw Error(
    "Drain qualification requires the isolated local development fixture",
  );
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
  });
  await waitFor(origin + "/healthz");
  const status = await (await fetch(origin + "/healthz")).json();
  assert.equal(status.ok, true);
  assert.equal(typeof status.commit, "string");
  const workerExit = once(worker, "exit");
  worker.kill("SIGTERM");
  const [workerCode] = await workerExit;
  assert.equal(workerCode, 0);
  console.log("PASS worker reports /healthz and exits 0 on SIGTERM");
  console.log("Drain qualification passed: 2 process checks.");
} catch (error) {
  console.error(output.join("").slice(-4000));
  throw error;
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
}
