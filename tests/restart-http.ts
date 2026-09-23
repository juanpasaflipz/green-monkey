import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const target = new URL(process.env.DATABASE_URL ?? "");
if (target.hostname !== "127.0.0.1" || target.pathname !== "/green_monkey_dev")
  throw Error(
    "Restart qualification requires the isolated local development fixture",
  );
const port = 3003,
  origin = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined,
  csrf = "";
const cookies = new Map<string, string>();
async function start() {
  server = spawn(process.execPath, ["build/server/index.js"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      APP_URL: origin,
      BILLING_SANDBOX_ENABLED: "false",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null)
      throw Error("Restart test server exited before readiness");
    try {
      if ((await fetch(origin + "/api/health")).ok) return;
    } catch {
      /* starting */
    }
    await delay(100);
  }
  throw Error("Restart test readiness timeout");
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server,
    exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 11000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}
async function api(path: string, body?: unknown) {
  const response = await fetch(origin + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0],
      separator = pair.indexOf("=");
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  assert(response.ok, `HTTP ${response.status} for ${path}`);
  return response.json();
}
try {
  await start();
  await api("/login", {
    tenantId: "10000000-0000-4000-8000-000000000001",
    login: "owner",
    secret: "demo-green-monkey",
  });
  const session = await api("/session");
  csrf = session.csrf;
  const cash = await api("/cash/open", {
    operationId: randomUUID(),
    opening: 0,
  });
  const catalog = await api("/catalog");
  const product = catalog.find(
    (p: any) => p.available && p.groups.length === 0,
  );
  const sale = {
    formatVersion: 2,
    operationId: randomUUID(),
    order: {
      operationId: randomUUID(),
      lines: [
        {
          id: randomUUID(),
          productId: product.id,
          quantity: 1,
          options: [],
          note: "",
        },
      ],
      mode: "takeaway",
      tableId: null,
      name: "Process restart fixture",
      note: "",
      channel: "pos",
    },
    expectedTotal: product.price,
    received: product.price,
    tip: 0,
    recordedAt: new Date().toISOString(),
    sessionId: session.id,
    cashSessionId: cash.id,
    tenantId: session.tenantId,
    employeeId: session.employeeId,
    deviceId: session.deviceId,
    leaseVersion: session.offlineLeaseVersion,
    currency: session.restaurant.currency,
    currencyExponent: 2,
    configurationVersion: session.restaurant.configVersion,
    receiptSnapshot: { restaurant: session.restaurant, lines: [] as any[] },
  };
  sale.receiptSnapshot.lines = [
    {
      id: sale.order.lines[0].id,
      productId: product.id,
      productVersion: product.version,
    },
  ];
  const committed = await api("/sync", sale);
  await stop();
  await start();
  const replay = await api("/sync", sale);
  assert.equal(replay.id, committed.id);
  const order = await api(`/orders/${committed.id}`);
  assert.equal(order.tenders.length, 1);
  assert.equal(order.paid, product.price);
  await api("/cash/close", {
    operationId: randomUUID(),
    counted: product.price,
    reason: "Restart fixture complete",
  });
  console.log(
    "Restart HTTP passed: original cookies and offline operation survive an actual API process restart with exactly one tender.",
  );
} finally {
  await stop();
}
