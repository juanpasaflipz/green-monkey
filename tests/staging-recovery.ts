import "dotenv/config";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { connect, checkRole } from "../server/db.js";
import { signInGoogleOwner } from "../server/owner-accounts.js";
import { signupLegal } from "./staging-legal.js";

// Explicit synthetic identities test deployed HTTP authorization, not Google.
// Fixtures are retained for audit; no provider payments or outbound jobs run.
const origin = process.env.STAGING_URL;
const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (
  origin !== "https://green-monkey-staging.up.railway.app" ||
  origin !== process.env.STAGING_ORIGIN_ALLOWLIST ||
  url.pathname !== "/green_monkey_staging" ||
  `${url.hostname}:${url.port || "5432"}${url.pathname}` !==
    process.env.QUALIFICATION_DATABASE_ALLOWLIST
)
  throw Error("Explicit staging qualification target required");
const sql = connect(process.env.DATABASE_URL!);
const run = randomUUID();
const checks: string[] = [];
const tenantIds: string[] = [];
try {
  await checkRole(sql);
  function client(accountCookie: string) {
    const cookies = new Map([["gm_account", accountCookie]]);
    return async (
      path: string,
      body?: unknown,
      csrf?: string,
      expected = 200,
    ) => {
      const response = await fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        headers: {
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          Origin: origin!,
          "Content-Type": "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, expected, path);
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(";", 1)[0],
          split = pair.indexOf("=");
        cookies.set(pair.slice(0, split), pair.slice(split + 1));
        if (expected === 200 && path.endsWith("/enter")) {
          assert.match(value, /HttpOnly/i);
          assert.match(value, /Secure/i);
        }
      }
      return response.json();
    };
  }
  const version = await (await fetch(origin + "/api/version")).json();
  assert.equal(version.commit, process.env.QUALIFICATION_COMMIT);
  const cookie = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: `recovery-${run}`,
    email: "synthetic-recovery@example.com",
    name: "Recovery qualification",
  });
  const a = client(cookie),
    b = client(cookie);
  const account = await a("/api/auth/account");
  const created = await a(
    "/api/auth/account/signup",
    {
      restaurantName: `Recovery ${run.slice(0, 8)}`,
      currency: "MXN",
      timezone: "America/Mexico_City",
      cutoff: 240,
      openingDays: [1, 2, 3, 4, 5, 6, 7],
      ...(await signupLegal(a)),
    },
    account.csrf,
  );
  tenantIds.push(created.tenantId);
  for (const api of [a, b])
    await api(
      "/api/auth/account/enter",
      { tenantId: created.tenantId },
      account.csrf,
    );
  const s = await a("/api/session"),
    replacement = await b("/api/session");
  assert.notEqual(s.deviceId, replacement.deviceId);
  const denied = await b(
    "/api/cash/open",
    { operationId: randomUUID(), opening: 0 },
    replacement.csrf,
    403,
  );
  assert.equal(denied.error, "free_selection_required");
  const productId = randomUUID();
  const product = {
    operationId: randomUUID(),
    id: productId,
    name: { es: "Efectivo ficticio", en: "Synthetic cash" },
    category: { es: "Prueba", en: "Test" },
    price: 100,
    available: true,
    station: "kitchen",
    expectedVersion: 0,
    cost: null,
    recipe: [],
  };
  await a("/api/catalog/save", product, s.csrf);
  await a("/api/cash/open", { operationId: randomUUID(), opening: 0 }, s.csrf);
  const drawer = await a("/api/cash");
  const sale = {
    formatVersion: 2,
    operationId: randomUUID(),
    order: {
      operationId: randomUUID(),
      lines: [
        { id: randomUUID(), productId, quantity: 1, options: [], note: "" },
      ],
      mode: "takeaway",
      tableId: null,
      name: "Staging recovery fixture",
      note: "",
      channel: "pos",
    },
    expectedTotal: 100,
    received: 100,
    tip: 0,
    recordedAt: new Date().toISOString(),
    sessionId: s.id,
    cashSessionId: drawer.id,
    tenantId: s.tenantId,
    employeeId: s.employeeId,
    deviceId: s.deviceId,
    leaseVersion: s.offlineLeaseVersion,
    currency: "MXN",
    currencyExponent: 2,
    configurationVersion: s.restaurant.configVersion,
    receiptSnapshot: { lines: [], restaurant: s.restaurant },
  };
  await a(
    "/api/catalog/save",
    {
      ...product,
      operationId: randomUUID(),
      expectedVersion: 1,
      available: false,
    },
    s.csrf,
  );
  assert.equal((await a("/api/sync", sale, s.csrf, 400)).error, "unavailable");
  await a(
    "/api/cash/close",
    {
      operationId: randomUUID(),
      counted: 0,
      reason: "Synthetic staging close before recovery",
    },
    s.csrf,
  );
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: origin });
    await context.addCookies([
      {
        name: "gm_account",
        value: cookie,
        url: origin!,
        secure: true,
        httpOnly: true,
      },
    ]);
    const entered = await context.request.post("/api/auth/account/enter", {
      headers: { "x-csrf-token": account.csrf },
      data: { tenantId: s.tenantId },
    });
    assert.equal(entered.status(), 200);
    const page = await context.newPage();
    await page.goto("/app");
    await page.getByRole("button", { name: /Conectado/ }).click();
    const backup = {
      format: "green-monkey-recovery-v2",
      tenantId: s.tenantId,
      exportedAt: new Date().toISOString(),
      paymentAttempts: [],
      sales: [
        {
          id: sale.operationId,
          scope: `${s.tenantId}:${s.deviceId}:${s.employeeId}`,
          body: sale,
          receipt: sale.receiptSnapshot,
        },
      ],
    };
    const upload = page.getByLabel("Restaurar copia de pendientes");
    for (let i = 0; i < 2; i++) {
      await upload.setInputFiles({
        name: "recovery.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(backup)),
      });
      await expect(
        page.getByRole("button", { name: "Revisar efectivo", exact: true }),
      ).toHaveCount(1);
    }
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Descargar pendientes", exact: true })
      .click();
    const stream = await (await downloaded).createReadStream();
    const chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    const exported = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(exported.sales.length, 1);
    assert.equal(exported.sales[0].body.operationId, sale.operationId);
    assert.equal(exported.sales[0].body.expectedTotal, 100);
    await page.screenshot({
      path: "docs/evidence/staging/recovery-backup.png",
    });
    checks.push(
      "deployed replacement-browser backup restore is repeatable",
      "deployed backup download preserves original cash evidence",
    );
  } finally {
    await browser.close();
  }
  const review = await b("/api/sync/review", sale, replacement.csrf);
  assert.equal(review.drawerClosed, true);
  const reconciled = await b(
    "/api/sync/reconcile",
    {
      sale,
      reason: "Synthetic receipt evidence verified for staging",
      confirmed: true,
    },
    replacement.csrf,
  );
  assert.equal(reconciled.paid, 100);
  const replay = await a("/api/sync", sale, s.csrf);
  assert.equal(replay.id, reconciled.id);
  const history = await b(`/api/cash/history/${drawer.id}`);
  assert.equal(history.closedExpected, 0);
  assert.equal(history.originalDiscrepancy, 0);
  assert.equal(history.lateRecovery, 100);
  assert.equal(history.tenders.length, 1);
  assert.equal(history.tenders[0].source, "offline_recovery");
  const recoveries = await b("/api/sync/recoveries");
  const recovery = recoveries.find(
    (r: { order_id: string }) => r.order_id === reconciled.id,
  );
  assert.equal(recovery.tasks.length, 2);
  for (const task of recovery.tasks)
    await b(
      "/api/sync/recoveries/resolve",
      {
        operationId: randomUUID(),
        taskId: task.id,
        outcome: "not_completed",
        reason: "Synthetic fixture has no physical fulfillment",
      },
      replacement.csrf,
    );
  assert.equal(
    (await b(`/api/orders/${reconciled.id}`)).state,
    "recovery_reviewed",
  );
  await b(
    "/api/plan/selection",
    { deviceId: replacement.deviceId, employeeIds: [] },
    replacement.csrf,
  );
  await a(
    "/api/cash/open",
    { operationId: randomUUID(), opening: 0 },
    s.csrf,
    403,
  );
  await b(
    "/api/cash/open",
    { operationId: randomUUID(), opening: 100 },
    replacement.csrf,
  );
  const refund = {
    operationId: randomUUID(),
    tenderId: history.tenders[0].id,
    amount: 100,
    reason: "Reverse synthetic recovery qualification cash",
    disposition: "no_stock_return",
  };
  await b("/api/refunds", refund, replacement.csrf);
  await b("/api/refunds", refund, replacement.csrf);
  const replacementCash = await b("/api/cash");
  assert.equal(replacementCash.refunds.length, 1);
  assert.equal(replacementCash.expected, 0);
  await b(
    "/api/cash/close",
    {
      operationId: randomUUID(),
      counted: 0,
      reason: "Synthetic recovery qualification complete",
    },
    replacement.csrf,
  );
  checks.push(
    "unselected Free device cannot sell",
    "catalog change blocks ordinary sync",
    "unselected manager can review and reconcile original closed drawer",
    "sync replay creates no duplicate tender",
    "original close and discrepancy preserved",
    "late recovery visible across devices",
    "both fulfillment follow-ups resolve",
    "Free selection moves selling permission",
    "recovered cash refundable from replacement drawer",
    "refund replay is idempotent",
  );
  await mkdir("docs/evidence/staging", { recursive: true });
  await writeFile(
    "docs/evidence/staging/recovery-qualification.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        origin,
        commit: version.commit,
        run,
        tenantIds,
        orderId: reconciled.id,
        identity: "synthetic fixture; not Google OAuth proof",
        fixturesRetained: true,
        providerCharges: false,
        scope: "deployed HTTP and replacement-browser backup restore/download",
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS ${checks.length} deployed recovery and Free-selection checks`,
  );
} finally {
  await sql.end();
}
