import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { transformServiceWorker } from "../../vite/sw-shell-plugin";

const tenantId = "10000000-0000-4000-8000-000000000001";
const PROVISIONAL = /[A-Z][A-Z0-9]{0,2}-\d{2,4}/;

// Production serves HTTPS. Against a local plain-HTTP compiled server, Chromium
// treats loopback as secure but WebKit does not: it upgrades every subresource
// (CSP upgrade-insecure-requests) and refuses Secure cookies. The WebKit
// project therefore drops only that directive and the Secure attribute of the
// login cookies; every other header is served unchanged.
test.beforeEach(async ({ context, browserName, baseURL }) => {
  if (browserName !== "webkit" || !baseURL?.startsWith("http:")) return;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const login = new URL(request.url()).pathname === "/api/login";
    if (request.resourceType() !== "document" && !login)
      return route.fallback();
    const response = await route.fetch();
    const headers = response.headers();
    if (headers["content-security-policy"])
      headers["content-security-policy"] = headers["content-security-policy"]
        .split(";")
        .filter((part) => part.trim() !== "upgrade-insecure-requests")
        .join(";");
    const cookies = response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === "set-cookie")
      .map((header) => {
        const [pair, ...attributes] = header.value.split(";");
        const split = pair!.indexOf("=");
        const maxAge = attributes
          .map((a) => a.trim().match(/^max-age=(\d+)$/i)?.[1])
          .find(Boolean);
        return {
          name: pair!.slice(0, split).trim(),
          value: pair!.slice(split + 1).trim(),
          url: new URL(request.url()).origin,
          httpOnly: true,
          sameSite: "Strict" as const,
          expires: maxAge ? Math.floor(Date.now() / 1000) + Number(maxAge) : -1,
        };
      });
    if (cookies.length) await context.addCookies(cookies);
    delete headers["set-cookie"];
    await route.fulfill({ response, headers });
  });
});

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
}

/** Opens the device drawer if needed and returns to selling. */
async function openDrawer(page: Page) {
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  const open = page.getByRole("button", { name: "Abrir caja", exact: true });
  await expect(
    open.or(page.getByText("Caja abierta", { exact: true })),
  ).toBeVisible();
  if (await open.isVisible()) {
    await open.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Guardar", exact: true })
      .click();
    await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  }
  // Selling caches the open drawer for offline payments when it activates.
  const cached = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/cash",
  );
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await cached;
}

const pill = (page: Page, name: RegExp) =>
  page.locator(".top-actions").getByRole("button", { name });

/** Saves the current draft as an offline cash sale; returns its provisional number. */
async function saveOfflineSale(page: Page) {
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Guardar cobro en este dispositivo",
      exact: true,
    })
    .click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Número provisional");
  await expect(receipt).toContainText("Pendiente de sincronizar");
  const text = (await receipt.textContent()) ?? "";
  const number = text.match(PROVISIONAL)?.[0];
  expect(number, text).toBeTruthy();
  return number!;
}

async function nextSale(page: Page) {
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();
  await expect(page.locator(".receipt")).toHaveCount(0);
}

async function session(page: Page) {
  return page.evaluate(async () => (await fetch("/api/session")).json());
}

const putRow = (page: Page, row: unknown) =>
  page.evaluate(
    (value) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("green-monkey-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("pending", "readwrite");
          tx.objectStore("pending").put(value);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    row,
  );
const getRow = (page: Page, id: string) =>
  page.evaluate(
    (key) =>
      new Promise<any>((resolve, reject) => {
        const request = indexedDB.open("green-monkey-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("pending", "readonly"),
            row = tx.objectStore("pending").get(key);
          row.onsuccess = () => resolve(row.result);
          tx.oncomplete = () => db.close();
        };
      }),
    id,
  );
const allRows = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<any[]>((resolve, reject) => {
        const request = indexedDB.open("green-monkey-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("pending", "readonly"),
            rows = tx.objectStore("pending").getAll();
          rows.onsuccess = () => resolve(rows.result);
          tx.oncomplete = () => db.close();
        };
      }),
  );

/** A legacy v1 cash sale row in this session's queue (server-unverifiable fixture). */
function queuedSale(
  s: { tenantId: string; deviceId: string; employeeId: string; id: string },
  extra: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
) {
  const id = crypto.randomUUID();
  return {
    id,
    scope: `${s.tenantId}:${s.deviceId}:${s.employeeId}`,
    status: "pending",
    attempts: 0,
    nextAt: 0,
    body: {
      operationId: id,
      order: {
        operationId: crypto.randomUUID(),
        lines: [
          {
            id: crypto.randomUUID(),
            productId: crypto.randomUUID(),
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "takeaway",
        tableId: null,
        name: "Queue fixture",
        note: "",
        channel: "pos",
      },
      expectedTotal: 100,
      received: 100,
      tip: 0,
      recordedAt: new Date().toISOString(),
      sessionId: s.id,
      cashSessionId: crypto.randomUUID(),
      ...body,
    },
    ...extra,
  };
}

async function goOffline(context: BrowserContext, page: Page) {
  await context.setOffline(true);
  await expect(pill(page, /^Sin conexión/)).toBeVisible();
}

test("API down while browser online switches to offline selling @cross", async ({
  page,
  context,
}) => {
  // Regression OFF-1/FOH-6: the router stays up, the server does not answer.
  await login(page);
  await openDrawer(page);
  await expect(pill(page, /^Conectado/)).toBeVisible();
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await context.route("**/api/**", (route) =>
    route.abort("internetdisconnected"),
  );
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Sin conexión con el servidor",
  );
  const offlinePill = pill(page, /^Sin conexión/);
  await expect(offlinePill).toBeVisible();
  await expect(offlinePill.locator("svg")).toBeVisible();
  await expect(
    page.locator(".connection-banner").filter({
      hasText:
        "Sin conexión con el servidor. Las ventas se guardan en este dispositivo",
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Guardar cobro en este dispositivo",
      exact: true,
    })
    .click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Número provisional");
  const number = ((await receipt.textContent()) ?? "").match(PROVISIONAL)![0];
  await page.screenshot({ path: "docs/evidence/offline-api-down-1440.png" });
  await nextSale(page);
  await context.unroute("**/api/**");
  // Probes recover the connection and the queue syncs on its own.
  await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 40_000 });
  await pill(page, /^Conectado/).click();
  await expect(page.locator(".workspace")).toContainText(
    new RegExp(`${number} → #\\d+`),
    // One request timeout (20 s) plus a retry, if the first attempt stalls.
    { timeout: 45_000 },
  );
});

test("HTML 502 from the proxy is treated as offline, not a generic error @cross", async ({
  page,
  context,
}) => {
  // Regression OFF-1: an HTML gateway page used to surface a generic error.
  await login(page);
  await openDrawer(page);
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await context.route("**/api/**", (route) =>
    route.fulfill({
      status: 502,
      contentType: "text/html",
      body: "<html><body>502 Bad Gateway</body></html>",
    }),
  );
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  const alert = page.getByRole("dialog").getByRole("alert");
  await expect(alert).toContainText("El servidor no está disponible");
  await expect(alert).not.toContainText("No se pudo completar");
  await expect(pill(page, /^Sin conexión/)).toBeVisible();
  await page
    .getByRole("button", {
      name: "Guardar cobro en este dispositivo",
      exact: true,
    })
    .click();
  await expect(page.locator(".receipt")).toContainText("Número provisional");
  await context.unroute("**/api/**");
});

test("Hung server times out and the payment dialog becomes closable within 16 s", async ({
  page,
  context,
}) => {
  // Regression FOH-6: fetch had no timeout and the busy dialog could not close.
  await login(page);
  await openDrawer(page);
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await page.clock.install();
  await context.route("**/api/orders", () => {
    /* never answers */
  });
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Cargando…" }),
  ).toBeVisible();
  await page.clock.fastForward(15_500);
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "El servidor tardó demasiado en responder",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await context.unrouteAll({ behavior: "ignoreErrors" });
});

test("Reload during API outage restores the cached session, not login", async ({
  page,
  context,
  browserName,
}) => {
  // Regression OFF-1: the cached session was used only when navigator.onLine was false.
  test.skip(
    browserName !== "chromium",
    "Service worker routing is Chromium-only",
  );
  test.skip(!process.env.TEST_PRODUCTION, "Needs the compiled service worker");
  await login(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(pill(page, /^Conectado/)).toBeVisible();
  await context.route("**/api/**", (route) =>
    route.abort("internetdisconnected"),
  );
  await page.reload();
  await expect(pill(page, /^Sin conexión/)).toBeVisible();
  await expect(page.getByLabel("Contraseña o PIN")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Taco de hongos/ }),
  ).toBeVisible();
  await context.unroute("**/api/**");
});

test("Manual Trabajar sin conexión saves locally with API up; turning it off syncs @cross", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await pill(page, /^Conectado/).click();
  await page.getByRole("switch", { name: "Trabajar sin conexión" }).check();
  await expect(pill(page, /^Sin conexión \(manual\)/)).toBeVisible();
  await expect(page.locator(".connection-banner")).toContainText(
    "Trabajando sin conexión por decisión del equipo",
  );
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  const number = await saveOfflineSale(page);
  await nextSale(page);
  await pill(page, /^Sin conexión \(manual\)/).click();
  await page.getByRole("switch", { name: "Trabajar sin conexión" }).uncheck();
  await expect(pill(page, /^Conectado/)).toBeVisible();
  await expect(page.locator(".workspace")).toContainText(
    new RegExp(`${number} → #\\d+`),
    // One request timeout (20 s) plus a retry, if the first attempt stalls.
    { timeout: 45_000 },
  );
});

test("Unresolved payment does not block new orders or offline sales", async ({
  page,
  context,
}) => {
  // Regression OFF-2.
  await login(page);
  await openDrawer(page);
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await page.route("**/api/orders/*/payments", (route) =>
    route.abort("failed"),
  );
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText(/Hay un pago anterior por confirmar/),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await goOffline(context, page);
  const newOrder = page.getByRole("button", {
    name: "Nueva orden",
    exact: true,
  });
  await expect(newOrder).toBeEnabled();
  await newOrder.click();
  await page.getByRole("button", { name: /Agua de jamaica/ }).click();
  await saveOfflineSale(page);
  await nextSale(page);
  await pill(page, /^Sin conexión/).click();
  await expect(
    page.getByRole("heading", { name: /Pago por confirmar/ }),
  ).toBeVisible();
  await page.unroute("**/api/orders/*/payments");
  await context.setOffline(false);
  await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page
    .getByRole("button", { name: "Recuperar pago", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Cobrado");
});

test("Review-required attempt is parked and other orders can be paid online", async ({
  page,
}) => {
  // Regression OFF-2: an attempt from an old session used to block every sale.
  await login(page);
  await openDrawer(page);
  await page.evaluate(async () => {
    const s = await (await fetch("/api/session")).json();
    const products = await (await fetch("/api/catalog")).json();
    const p = products.find((p: any) => p.name.es === "Taco de hongos");
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        lines: [
          {
            id: crypto.randomUUID(),
            productId: p.id,
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "takeaway",
        tableId: null,
        name: "Parked attempt fixture",
        note: "",
        channel: "pos",
      }),
    });
    const order = await response.json();
    const attempt = {
      formatVersion: 1,
      tenantId: s.tenantId,
      employeeId: s.employeeId,
      deviceId: s.deviceId,
      sessionId: crypto.randomUUID(),
      cashSessionId: crypto.randomUUID(),
      orderId: order.id,
      createdAt: new Date().toISOString(),
      payload: {
        operationId: crypto.randomUUID(),
        amount: order.total,
        tip: 0,
        received: order.total,
        method: "cash",
        externalConfirmed: false,
        reference: "",
      },
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("green-monkey-v1");
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("cache", "readwrite");
        tx.objectStore("cache").put({
          id: `${s.tenantId}:${s.deviceId}:${s.employeeId}:payment`,
          value: attempt,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Puedes seguir con otras órdenes",
  );
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Cobrado");
  await nextSale(page);
  await pill(page, /^Conectado/).click();
  await expect(
    page.getByRole("heading", { name: /Pago por confirmar.*En revisión/ }),
  ).toBeVisible();
});

test("Transient sync failures keep retrying and never become conflicts", async ({
  page,
}) => {
  // Regression OFF-6: 5xx answers used to exhaust retries after ~5 minutes.
  await login(page);
  const s = await session(page);
  await page.clock.install();
  let calls = 0;
  const row = queuedSale(s);
  await page.route("**/api/offline/sync", async (route) => {
    calls++;
    if (calls <= 10)
      await route.fulfill({
        status: 503,
        json: { error: "database_unavailable" },
      });
    else
      await route.fulfill({
        json: { kind: "sale", operationId: row.id, orderNumber: 77 },
      });
  });
  await putRow(page, row);
  await page.reload();
  for (let i = 0; i < 40 && calls <= 10; i++) {
    await page.clock.fastForward(65_000);
    const current = await getRow(page, row.id);
    expect(current.status, JSON.stringify(current)).not.toBe("conflict");
  }
  await expect.poll(() => calls).toBeGreaterThan(10);
  await expect
    .poll(async () => (await getRow(page, row.id))?.status)
    .toBe("synced");
  expect((await getRow(page, row.id)).body.operationId).toBe(row.id);
});

test("No sync attempts are counted while offline @cross", async ({
  page,
  context,
}) => {
  // Regression OFF-6: attempts were consumed while the server was unreachable.
  await login(page);
  const s = await session(page);
  let calls = 0;
  const row = queuedSale(s);
  await page.route("**/api/offline/sync", async (route) => {
    calls++;
    await route.fulfill({ json: { kind: "sale", operationId: row.id } });
  });
  await goOffline(context, page);
  await putRow(page, row);
  await page.waitForTimeout(3_000);
  expect(calls).toBe(0);
  expect((await getRow(page, row.id)).attempts).toBe(0);
  await context.setOffline(false);
  await expect
    .poll(async () => (await getRow(page, row.id))?.status, { timeout: 30_000 })
    .toBe("synced");
  expect((await getRow(page, row.id)).attempts).toBe(0);
  expect(calls).toBe(1);
});

test("Offline kitchen ticket prints and appears in the device list", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    (window as any).__prints = 0;
    window.print = () => {
      (window as any).__prints++;
    };
    localStorage.setItem("gm-offline-print", "kitchen");
  });
  await login(page);
  await openDrawer(page);
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await page.getByRole("button", { name: /Agua de jamaica/ }).click();
  await goOffline(context, page);
  const number = await saveOfflineSale(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).__prints))
    .toBe(1);
  await nextSale(page);
  await page.getByRole("button", { name: "Comandas (1)", exact: true }).click();
  const list = page.getByRole("dialog", { name: "Comandas sin conexión" });
  await expect(list).toContainText(
    "Lista local de este dispositivo. Cocina no la ve",
  );
  const tickets = list.locator(".offline-ticket");
  await expect(tickets).toHaveCount(2);
  await expect(tickets.first()).toContainText(number);
  const ready = tickets
    .first()
    .getByRole("button", { name: "Lista", exact: true });
  await ready.click();
  await expect(ready).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "docs/evidence/offline-tickets-1440.png" });
  await tickets
    .first()
    .getByRole("button", { name: "Reimprimir", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__prints))
    .toBe(2);
  await context.setOffline(false);
});

test("KDS shows offline sales in the review lane with provisional and server numbers", async ({
  page,
  context,
}) => {
  // Regression OFF-4: synced offline orders reached the KDS as fresh tickets.
  await login(page);
  await openDrawer(page);
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await page.getByRole("button", { name: /Agua de jamaica/ }).click();
  await goOffline(context, page);
  const number = await saveOfflineSale(page);
  await nextSale(page);
  await context.setOffline(false);
  await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
  await pill(page, /^Conectado/).click();
  const mapped = page
    .locator(".workspace")
    .getByText(new RegExp(`${number} → #\\d+`));
  await expect(mapped).toBeVisible({ timeout: 45_000 });
  const label = ((await mapped.textContent()) ?? "").match(
    new RegExp(`${number} → #\\d+`),
  )![0];
  const status = await page.evaluate(
    async ({ tenantId }) => {
      const s = await (await fetch("/api/session")).json();
      await fetch("/api/logout", {
        method: "POST",
        headers: { "x-csrf-token": s.csrf },
      });
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, login: "kitchen", secret: "654321" }),
      });
      return r.status;
    },
    { tenantId },
  );
  expect(status).toBe(200);
  await page.goto("/app");
  const lane = page.locator(".offline-review-lane");
  await expect(lane).toContainText("Ventas sin conexión por revisar");
  const cards = lane.locator(".offline-review-card").filter({ hasText: label });
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Vendida");
  await expect(cards.first()).toContainText(
    "Comanda en la lista del dispositivo",
  );
  await page.screenshot({ path: "docs/evidence/offline-kds-lane-1440.png" });
  await cards
    .filter({ hasText: "Cocina" })
    .getByRole("button", { name: "Ya se preparó", exact: true })
    .click();
  await expect(cards).toHaveCount(1);
  await cards
    .filter({ hasText: "Barra" })
    .getByRole("button", { name: "Preparar ahora", exact: true })
    .click();
  await expect(cards).toHaveCount(0);
});

test("Device clock 3 minutes fast still syncs", async ({ page, context }) => {
  // Regression OFF-8: a fast device clock made every sale "in the future".
  await page.clock.install({ time: Date.now() + 180_000 });
  await login(page);
  await openDrawer(page);
  await pill(page, /^Conectado/).click();
  await expect(page.locator(".workspace")).toContainText(
    "La hora de este dispositivo difiere 3 min",
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await goOffline(context, page);
  const number = await saveOfflineSale(page);
  await nextSale(page);
  await context.setOffline(false);
  await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
  await pill(page, /^Conectado/).click();
  await expect(page.locator(".workspace")).toContainText(
    new RegExp(`${number} → #\\d+`),
    // One request timeout (20 s) plus a retry, if the first attempt stalls.
    { timeout: 45_000 },
  );
});

test("Manager archives an unverifiable local record and drawer close unblocks", async ({
  page,
}) => {
  // Regression OFF-8: evidence that could not be verified blocked drawer close.
  await login(page);
  await openDrawer(page);
  const s = await session(page);
  const drawer = await page.evaluate(async () =>
    (await fetch("/api/cash")).json(),
  );
  const row = queuedSale(
    s,
    {},
    {
      sessionId: crypto.randomUUID(),
      cashSessionId: drawer.id,
      expectedTotal: 4500,
      received: 4500,
    },
  );
  await putRow(page, row);
  await pill(page, /^Conectado/).click();
  const panel = page
    .locator("article.panel")
    .filter({ hasText: `Venta · ${row.id.slice(0, 8)}` });
  await expect(panel).toContainText("Requiere revisión", { timeout: 20_000 });
  await expect(panel).toContainText("No se pudo verificar este registro local");
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await page.getByRole("button", { name: "Cerrar caja", exact: true }).click();
  await page.getByLabel("Efectivo contado").fill("0");
  await page.getByLabel("Explicación").fill("Cierre con registro pendiente");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Sincroniza las ventas pendientes",
  );
  await page.keyboard.press("Escape");
  await pill(page, /^Conectado/).click();
  await panel
    .getByRole("button", { name: "Revisar efectivo", exact: true })
    .click();
  const review = page
    .locator("form.panel")
    .filter({ hasText: "Conciliar efectivo ya recibido" });
  await expect(review).toContainText(
    "No se pudo verificar este registro local",
  );
  await expect(
    review.getByRole("button", { name: "Registrar efectivo verificado" }),
  ).toHaveCount(0);
  await review
    .getByRole("button", { name: "Archivar registro local", exact: true })
    .click();
  const archive = page
    .locator("form.panel")
    .filter({ hasText: "Archivar sin registrar venta" });
  const reason = `La venta no se puede verificar; se capturó en papel ${row.id.slice(0, 8)}`;
  await archive.getByLabel("Motivo").fill(reason);
  await archive.getByRole("checkbox").check();
  await archive.getByRole("button", { name: "Archivar", exact: true }).click();
  await expect(panel).toContainText("Archivado");
  await expect(
    page.locator("article.panel").filter({ hasText: reason }),
  ).toContainText("Archivado por Alex Demo");
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await page.getByRole("button", { name: "Cerrar caja", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Este dispositivo archivó $45.00 de ventas locales de esta caja",
  );
  await page.getByLabel("Efectivo contado").fill("500");
  await page.getByLabel("Explicación").fill("Cierre después de archivar");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Connection state is visible without colour at 768 px @cross", async ({
  page,
  context,
}) => {
  // Regression FOH-15: at tablet width only an 8 px dot changed colour.
  await login(page);
  await openDrawer(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await goOffline(context, page);
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await saveOfflineSale(page);
  await nextSale(page);
  const offlinePill = pill(page, /^Sin conexión · 1 por sincronizar/);
  await expect(offlinePill).toBeVisible();
  await expect(offlinePill.locator("svg")).toBeVisible();
  await expect(offlinePill.locator(".connection-count")).toBeVisible();
  await expect(offlinePill.locator(".connection-count")).toContainText("1");
  const banner = page.locator(".connection-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Sin conexión con el servidor");
  await expect(banner).toContainText("Puedes vender sin conexión hasta las");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await banner.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/evidence/offline-banner-768.png" });
  const results = await new AxeBuilder({ page })
    .include(".topbar")
    .include(".connection-banner")
    .analyze();
  expect(
    results.violations.filter((v) =>
      [
        "color-contrast",
        "link-in-text-block",
        "button-name",
        "aria-allowed-role",
      ].includes(v.id),
    ),
  ).toEqual([]);
  await context.setOffline(false);
});

test("Persistent storage is requested after login", async ({ page }) => {
  // Regression OFF-11: persistence was only a manual button.
  await page.addInitScript(() => {
    (window as any).__persist = 0;
    if (navigator.storage) {
      navigator.storage.persisted = async () => false;
      navigator.storage.persist = async () => {
        (window as any).__persist++;
        return true;
      };
    }
  });
  await login(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).__persist))
    .toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__persist)).toBe(0);
});

test("Manifest is linked and installable fields are present @cross", async ({
  page,
}) => {
  // Regression OFF-11: the app could not be installed to the home screen.
  await page.goto("/app");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");
  const manifest = await (await page.request.get(href!)).json();
  expect(manifest).toMatchObject({
    name: "Green Monkey POS",
    short_name: "Green Monkey",
    start_url: "/app",
    display: "standalone",
  });
  const sizes = manifest.icons.map((icon: any) => icon.sizes);
  expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(manifest.icons.some((icon: any) => icon.purpose === "maskable")).toBe(
    true,
  );
  for (const icon of manifest.icons)
    expect((await page.request.get(icon.src)).ok()).toBe(true);
  expect(
    await page.locator('link[rel="apple-touch-icon"]').getAttribute("href"),
  ).toBe("/brand/icon-192.png");
});

test("Unsupported browser gate renders when navigator.locks is missing", async ({
  page,
}) => {
  // Regression OFF-11: browsers without Web Locks failed on the first payment.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "locks", {
      configurable: true,
      get: () => undefined,
    });
  });
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: "Este navegador no es compatible" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Safari 16.4+");
  await expect(page.getByLabel("Contraseña o PIN")).toHaveCount(0);
});

test("Sync screen does not poll IndexedDB or server every 1.5 s", async ({
  page,
}) => {
  // Regression OFF-12.
  await login(page);
  const s = await session(page);
  await page.clock.install();
  let lists = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/offline/recoveries")) lists++;
  });
  await pill(page, /^Conectado/).click();
  await expect.poll(() => lists).toBe(1);
  await page.clock.runFor(10_000);
  expect(lists).toBe(1);
  // Local rows still update immediately through liveQuery: a row written
  // outside Dexie appears as soon as the sync loop updates it through Dexie.
  const row = queuedSale(s);
  await putRow(page, row);
  const panel = page
    .locator("article.panel")
    .filter({ hasText: `Venta · ${row.id.slice(0, 8)}` });
  await expect(panel).toHaveCount(0);
  await page
    .getByRole("button", { name: "Reintentar sincronización", exact: true })
    .click();
  await expect(panel).toContainText("Requiere revisión");
  expect(lists).toBeLessThanOrEqual(2);
});

test("Synced rows older than 7 days are pruned", async ({ page }) => {
  // Regression OFF-12: nothing ever deleted synced rows.
  await login(page);
  const s = await session(page);
  const old = queuedSale(s, {
    status: "synced",
    syncedAt: Date.now() - 8 * 86_400_000,
    result: { id: "old" },
  });
  const recent = queuedSale(s, {
    status: "synced",
    syncedAt: Date.now() - 86_400_000,
    result: { id: "recent" },
  });
  await putRow(page, old);
  await putRow(page, recent);
  await pill(page, /^Conectado/).click();
  await page
    .getByRole("button", { name: "Reintentar sincronización", exact: true })
    .click();
  await expect.poll(async () => await getRow(page, old.id)).toBeUndefined();
  expect((await getRow(page, recent.id))?.status).toBe("synced");
  expect((await allRows(page)).some((r) => r.id === old.id)).toBe(false);
});

/** Waits for a registration.update() to settle the new worker. */
async function updateWorker(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return "no-registration";
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("no-update"), 15_000);
      registration.addEventListener(
        "updatefound",
        () => {
          const worker = registration.installing!;
          worker.addEventListener("statechange", () => {
            if (["installed", "redundant"].includes(worker.state)) {
              clearTimeout(timer);
              resolve(worker.state);
            }
          });
        },
        { once: true },
      );
      registration.update().catch(() => {
        clearTimeout(timer);
        resolve("update-failed");
      });
    });
  });
}

async function shellCaches(page: Page) {
  return page.evaluate(async () => {
    const result: Record<string, string[]> = {};
    for (const name of await caches.keys())
      if (name.startsWith("green-monkey-shell-"))
        result[name] = (await (await caches.open(name)).keys())
          .map((request) => new URL(request.url).pathname)
          .sort();
    return result;
  });
}

test("Service worker update keeps the old revision intact; the prompt applies only without unsynced work", async ({
  page,
  context,
  browserName,
}) => {
  // Regression OFF-10: a failed update wrote new HTML into the live cache.
  test.skip(
    browserName !== "chromium",
    "Service worker routing is Chromium-only",
  );
  test.skip(!process.env.TEST_PRODUCTION, "Needs the compiled service worker");
  // The browser fetches a worker's main script outside Playwright routing, so
  // the next revision's script is written to the local compiled build.
  const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(
    process.env.TEST_BASE_URL ?? "",
  );
  test.skip(
    !local || !existsSync("dist/sw.js"),
    "Needs the local compiled build",
  );
  const deployed = readFileSync("dist/sw.js", "utf8");
  try {
    await login(page);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect(pill(page, /^Conectado/)).toBeVisible();
    const before = await shellCaches(page);
    const [current] = Object.entries(before);
    expect(current).toBeTruthy();
    const assets = current![1].filter((path) => path.startsWith("/assets/"));
    const html = await (await page.request.get("/index.html")).text();
    const source = readFileSync("public/sw.js", "utf8");
    const serve = async (buildId: string, extraAssets: string[]) => {
      await context.unrouteAll({ behavior: "ignoreErrors" });
      writeFileSync(
        "dist/sw.js",
        transformServiceWorker(source, {
          buildId,
          assets: [...assets, ...extraAssets],
        }),
      );
      await context.route("**/index.html", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: html.replace(
            /<meta name="gm-build" content="[^"]*">/,
            `<meta name="gm-build" content="${buildId}">`,
          ),
        }),
      );
      await context.route("**/assets/missing-next.js", (route) =>
        route.fulfill({ status: 404, body: "missing" }),
      );
    };
    // A new revision whose install fails leaves the old revision untouched.
    await serve(`browser-failed-${Date.now()}`, ["/assets/missing-next.js"]);
    expect(await updateWorker(page)).toBe("redundant");
    expect(await shellCaches(page)).toEqual(before);
    await context.setOffline(true);
    await page.reload();
    await expect(pill(page, /^Sin conexión/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Taco de hongos/ }),
    ).toBeVisible();
    await context.setOffline(false);
    await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
    // A complete revision waits; the prompt stays disabled while a record is unsynced.
    const next = `browser-next-${Date.now()}`;
    await serve(next, []);
    const s = await session(page);
    const row = queuedSale(s, {
      status: "conflict",
      error: "offline_conflict",
    });
    await putRow(page, row);
    expect(await updateWorker(page)).toBe("installed");
    const bar = page.locator(".update-bar");
    await expect(bar).toContainText("Hay una nueva versión lista.");
    await expect(bar).toContainText(
      "Sincroniza las ventas pendientes antes de actualizar.",
    );
    await expect(
      bar.getByRole("button", { name: "Actualizar ahora" }),
    ).toBeDisabled();
    expect(Object.keys(await shellCaches(page))).toContain(
      `green-monkey-shell-${next}`,
    );
    // Once nothing is unsynced, applying the update reloads into the new revision.
    await putRow(page, { ...row, status: "archived", archivedAt: Date.now() });
    await page.reload();
    await expect(
      bar.getByRole("button", { name: "Actualizar ahora" }),
    ).toBeEnabled();
    const reloaded = page.waitForEvent("load");
    await bar.getByRole("button", { name: "Actualizar ahora" }).click();
    await reloaded;
    await expect(page.locator('meta[name="gm-build"]')).toHaveAttribute(
      "content",
      next,
    );
    await expect(pill(page, /^Conectado/)).toBeVisible();
    expect(Object.keys(await shellCaches(page))).toEqual([
      `green-monkey-shell-${next}`,
    ]);
  } finally {
    writeFileSync("dist/sw.js", deployed);
    await context.unrouteAll({ behavior: "ignoreErrors" });
  }
});
