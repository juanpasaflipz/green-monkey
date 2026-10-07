import { test, expect, type Page } from "@playwright/test";

// Operations surface of the compiled server: request ids, body errors, the
// public status document and the client-address probe (no login), and the
// support reference staff read out from an error notice (signed in).

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
}

test("malformed JSON gets 400 invalid_json with a matching X-Request-Id", async ({
  request,
}) => {
  const response = await request.post("/api/public/ops-check/orders", {
    headers: { "Content-Type": "application/json" },
    data: "{bad",
  });
  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error).toBe("invalid_json");
  expect(body.requestId).toBeTruthy();
  expect(response.headers()["x-request-id"]).toBe(body.requestId);
});

test("an oversized body gets 413 payload_too_large from the server's own error handler", async ({
  request,
}) => {
  // server/index.ts parses JSON with a 256 kB limit; this exercises its
  // error handler in the compiled build, not a re-implementation.
  const response = await request.post("/api/public/ops-check/orders", {
    headers: { "Content-Type": "application/json" },
    data: JSON.stringify({ note: "x".repeat(300 * 1024) }),
  });
  expect(response.status()).toBe(413);
  const body = await response.json();
  expect(body.error).toBe("payload_too_large");
  expect(response.headers()["x-request-id"]).toBe(body.requestId);
});

test("a Railway request id is reused end to end", async ({ request }) => {
  const response = await request.get("/api/session", {
    headers: { "X-Railway-Request-Id": "ops-browser-check-0001" },
  });
  expect(response.status()).toBe(401);
  expect(response.headers()["x-request-id"]).toBe("ops-browser-check-0001");
  expect((await response.json()).requestId).toBe("ops-browser-check-0001");
});

test("ops status reports readiness and no secrets", async ({ request }) => {
  const response = await request.get("/api/ops/status");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const status = await response.json();
  expect(Object.keys(status).sort()).toEqual([
    "commit",
    "db",
    "degraded",
    "ok",
    "schema",
    "version",
    "worker",
  ]);
  expect(status).toMatchObject({ ok: true, db: "ok", schema: "ready" });
  // PLATFORM-OPS-2/OPS-4: the worker's build commit and jobs flag pass through.
  expect(Object.keys(status.worker).sort()).toEqual([
    "commit",
    "jobs",
    "lastBeatAt",
    "status",
  ]);
  expect(["ok", "stale", "unknown"]).toContain(status.worker.status);
  if (status.worker.status === "ok") {
    expect(status.worker.commit).toMatch(/^(?:[0-9a-f]{7,40}|local)$/);
    expect(typeof status.worker.jobs).toBe("boolean");
  } else expect(status.worker.jobs).toBeNull();
  expect(JSON.stringify(status)).not.toMatch(
    /postgres|password|secret|tenant|token/i,
  );
});

test("the client-address probe returns only the requester's address", async ({
  request,
}) => {
  const probe = await (await request.get("/api/ops/diagnostics/ip")).json();
  expect(Object.keys(probe).sort()).toEqual([
    "forwardedHop",
    "ip",
    "peerTrusted",
  ]);
  expect(typeof probe.ip).toBe("string");
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
});

test("a server error notice shows the Referencia de soporte staff read out (LD-17, RUNBOOK Signals)", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  const requestId = "3f2a9c1b-7d4e-4c2a-9b1e-0123456789ab";
  // The server fails before creating anything; its answer carries the id.
  await page.route("**/api/orders", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 500,
          headers: { "X-Request-Id": requestId },
          json: { error: "internal_error", requestId },
        })
      : route.continue(),
  );
  try {
    await page
      .locator("button.product")
      .filter({ has: page.getByText("Taco de hongos", { exact: true }) })
      .click();
    await page.getByLabel("Nombre para llamar").fill("Soporte " + Date.now());
    await page
      .getByRole("button", { name: "Enviar a cocina", exact: true })
      .click();
    const notice = page.locator(".cart-bottom [role=alert]");
    await expect(notice).toContainText("Referencia de soporte: 3F2A9C1B");
  } finally {
    await page.unroute("**/api/orders");
  }
});

test("public ordering's inbox and settings notices show the Referencia de soporte of a server error (POL-R2-6)", async ({
  page,
}) => {
  await login(page);
  const requestId = "3f2a9c1b-7d4e-4c2a-9b1e-0123456789ab";
  const failure = {
    status: 500,
    headers: { "X-Request-Id": requestId },
    json: { error: "internal_error", requestId },
  };
  // The inbox shows as it does with an active code and nothing pending; the
  // pause and the settings save fail on the server before changing anything.
  await page.route("**/api/ordering/inbox/summary", (route) =>
    route.fulfill({
      json: { available: true, active: true, pending: 0, oldestAt: null },
    }),
  );
  await page.route("**/api/ordering/inbox", (route) =>
    route.fulfill({
      json: {
        available: true,
        active: true,
        acceptingNow: true,
        reason: null,
        paused: false,
        holds: [],
        recentlyExpired: 0,
        churning: [],
        serverTime: new Date().toISOString(),
      },
    }),
  );
  await page.route("**/api/ordering/pause", (route) =>
    route.request().method() === "POST"
      ? route.fulfill(failure)
      : route.continue(),
  );
  await page.route("**/api/ordering/settings", (route) =>
    route.request().method() === "POST"
      ? route.fulfill(failure)
      : route.continue(),
  );
  try {
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    const inbox = page.locator(".public-inbox");
    await inbox.getByRole("button", { name: "Pausar", exact: true }).click();
    await expect(inbox.locator(".public-notice")).toContainText(
      "Referencia de soporte: 3F2A9C1B",
    );
    await page
      .getByRole("button", { name: "Configuración", exact: true })
      .click();
    const panel = page.locator(".public-settings");
    await panel
      .getByRole("button", { name: "Guardar pedidos en línea", exact: true })
      .click();
    await expect(panel).toContainText("Referencia de soporte: 3F2A9C1B");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
