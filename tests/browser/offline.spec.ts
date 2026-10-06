import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
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
/** A catalog product button (never the cart's quantity buttons). */
const product = (page: Page, name: string) =>
  page.locator("button.product").filter({ hasText: name });
/**
 * Advances a page clock in 5 s steps, letting each step's requests finish
 * (one big jump would fire their timeouts and flap the connection).
 */
async function advance(page: Page, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
    await page.clock.runFor(5_000);
    await page.waitForTimeout(150);
  }
}

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
const deleteRow = (page: Page, id: string) =>
  page.evaluate(
    (key) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("green-monkey-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("pending", "readwrite");
          tx.objectStore("pending").delete(key);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
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
/**
 * Holds the record and cache stores in one readwrite transaction from a
 * second connection, kept alive by back-to-back reads, so an offline save
 * waits on IndexedDB (as on a slow device) until the returned release runs.
 */
async function holdRecordStores(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((held, reject) => {
        const request = indexedDB.open("green-monkey-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction(["pending", "cache"], "readwrite"),
            store = tx.objectStore("cache"),
            w = window as unknown as { __holdRecords?: boolean };
          w.__holdRecords = true;
          const spin = () => {
            if (w.__holdRecords) store.get("hold").onsuccess = spin;
          };
          spin();
          tx.oncomplete = () => db.close();
          held();
        };
      }),
  );
  return () =>
    page.evaluate(() => {
      (window as unknown as { __holdRecords?: boolean }).__holdRecords = false;
    });
}

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
  // Service's collect (024) first settles a stored attempt and runs offline's
  // charge guard, so the request (and its 15 s timer) starts a moment after
  // the dialog turns busy: fast-forward only once it is out.
  const sent = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/orders" &&
      request.method() === "POST",
  );
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Cargando…" }),
  ).toBeVisible();
  await sent;
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

test("Manual offline mode never locks the device at sign-in: the next employee's session is used", async ({
  page,
}) => {
  // Regression OFF-R16: with manual mode on, a successful login stayed on the
  // login screen (and could restore another employee's cached session).
  await login(page);
  await pill(page, /^Conectado/).click();
  await page.getByRole("switch", { name: "Trabajar sin conexión" }).check();
  await expect(pill(page, /^Sin conexión \(manual\)/)).toBeVisible();
  await page.getByRole("button", { name: "Salir", exact: true }).click();
  const notice = page.locator(".login-form .warning-panel");
  await expect(notice).toContainText(
    "Este dispositivo está en modo sin conexión",
  );
  await expect(
    notice.getByRole("button", { name: "Volver a conectarme", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Usuario").fill("cashier");
  await page.getByLabel("Contraseña o PIN").fill("123456");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.locator(".store-text")).toContainText("Dani Demo");
  await expect(pill(page, /^Sin conexión \(manual\)/)).toBeVisible();
  expect((await session(page)).role).toBe("cashier");
  // From the login screen the device can also leave manual mode.
  await page.getByRole("button", { name: "Salir", exact: true }).click();
  await notice
    .getByRole("button", { name: "Volver a conectarme", exact: true })
    .click();
  await expect(notice).toHaveCount(0);
});

test("With offline table service off (the default), existing checks wait for the connection and only new orders paid in full are saved", async ({
  page,
  context,
}) => {
  // LD-7: table service ships off. GAP-4: nothing fetches open orders.
  let openOrders = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/offline/open-orders")
      openOrders++;
  });
  await login(page);
  await openDrawer(page);
  const order = await sendTableOnline(page, "Mesa 04");
  await goOffline(context, page);
  const existing = page.locator(".existing");
  await expect(existing).toContainText(`#${order.number}`);
  await expect(existing).toContainText("Disponible al volver la conexión");
  await expect(
    page.getByRole("button", { name: "Cobrar", exact: true }),
  ).toBeDisabled();
  await product(page, "Taco de hongos").click();
  await expect(
    page.getByRole("button", { name: "Enviar (sin conexión)", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Órdenes abiertas", exact: true }),
  ).toHaveCount(0);
  // A new order: no kitchen send without paying, no partial payment.
  await page.getByRole("button", { name: "Nueva orden", exact: true }).click();
  await product(page, "Taco de hongos").click();
  await expect(page.locator(".cart-bottom")).toContainText(
    "Sin conexión solo se cobran órdenes nuevas completas",
  );
  await expect(
    page.getByRole("button", { name: "Enviar (sin conexión)", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Cobrar" });
  await dialog.getByLabel("Importe").fill("20.00");
  const save = dialog.getByRole("button", {
    name: "Guardar cobro en este dispositivo",
    exact: true,
  });
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Sin conexión solo se guardan órdenes nuevas cobradas completas",
  );
  expect(
    (await allRows(page)).filter((row) => row.status !== "synced"),
  ).toHaveLength(0);
  await dialog.getByLabel("Importe").fill("45.00");
  await save.click();
  await expect(page.locator(".receipt")).toContainText("Número provisional");
  await nextSale(page);
  await context.setOffline(false);
  await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
  expect(openOrders).toBe(0);
});

test("Open orders are never fetched while offline table service is off", async ({
  page,
}) => {
  // Regression GAP-4 / LD-7: every selling device fetched the snapshot every
  // 120 s whether or not anything could use it.
  const counts = { openOrders: 0, settings: 0 };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/offline/open-orders") counts.openOrders++;
    if (path === "/api/offline/settings" && request.method() === "GET")
      counts.settings++;
  });
  await page.clock.install();
  await login(page);
  await expect.poll(() => counts.settings).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  const settingsReads = counts.settings;
  await advance(page, 300_000);
  expect(counts.openOrders).toBe(0);
  // The setting itself is read when selling opens, never polled.
  expect(counts.settings).toBe(settingsReads);
});

test("Owners turn offline table service on and off on the Sync screen, labelled Beta", async ({
  page,
  browser,
}) => {
  await login(page);
  await pill(page, /^Conectado/).click();
  const setting = page.locator("fieldset.offline-table-service");
  await expect(setting).toContainText("Servicio de mesa sin conexión");
  await expect(setting).toContainText("Beta");
  await expect(setting).toContainText("viene apagado");
  const toggle = setting.getByRole("switch", {
    name: "Activar servicio de mesa sin conexión",
  });
  await expect(toggle).not.toBeChecked();
  try {
    const saved = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/offline/settings" &&
        r.request().method() === "POST",
    );
    await toggle.check();
    expect((await (await saved).json()).tableService).toBe(true);
    await page.reload();
    await pill(page, /^Conectado/).click();
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    expect(
      await page.evaluate(
        async () =>
          (await (await fetch("/api/offline/settings")).json()).tableService,
      ),
    ).toBe(false);
  } finally {
    await setTableService(browser, false);
  }
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

test("A manager records or discards a parked payment attempt, and its order is no longer blocked", async ({
  page,
}) => {
  // Regression OFFLINE-RECOVERY-05: a parked attempt the server reports as
  // missing and not resendable had no resolution; its order stayed blocked.
  await login(page);
  await openDrawer(page);
  const fixture = await page.evaluate(async () => {
    const s = await (await fetch("/api/session")).json();
    const drawer = await (await fetch("/api/cash")).json();
    const products = await (await fetch("/api/catalog")).json();
    const p = products.find((p: any) => p.name.es === "Taco de hongos");
    const scope = `${s.tenantId}:${s.deviceId}:${s.employeeId}`;
    const made: { orderId: string; number: number; operationId: string }[] = [];
    for (const name of ["Cobro por registrar", "Cobro por descartar"]) {
      const order = await (
        await fetch("/api/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": s.csrf,
          },
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
            name: `${name} ${crypto.randomUUID()}`,
            note: "",
            channel: "pos",
          }),
        })
      ).json();
      const operationId = crypto.randomUUID();
      // From an earlier session in this drawer: the device may not resend it.
      const attempt = {
        formatVersion: 1,
        tenantId: s.tenantId,
        employeeId: s.employeeId,
        deviceId: s.deviceId,
        sessionId: crypto.randomUUID(),
        cashSessionId: drawer.id,
        orderId: order.id,
        createdAt: new Date().toISOString(),
        payload: {
          operationId,
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
            id: `${scope}:payment:${operationId}`,
            value: attempt,
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
      made.push({ orderId: order.id, number: order.number, operationId });
    }
    return made;
  });
  const [toRecord, toDiscard] = fixture as [
    (typeof fixture)[0],
    (typeof fixture)[0],
  ];
  await page.reload();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await pill(page, /^Conectado/).click();
  const card = (operationId: string) =>
    page
      .locator("article.panel")
      .filter({ hasText: `Pago por confirmar · ${operationId.slice(0, 8)}` });
  // Recorded: the verified money goes into its order, once.
  const recorded = card(toRecord.operationId);
  await recorded
    .getByRole("button", { name: "Consultar estado", exact: true })
    .click();
  await expect(recorded).toContainText("No se encontró un resultado seguro");
  await recorded
    .getByRole("button", { name: "Registrar cobro verificado", exact: true })
    .click();
  await recorded
    .getByLabel("Motivo")
    .fill("El cliente pagó en efectivo; la caja cuadra con el ticket");
  await recorded.getByRole("checkbox").check();
  await recorded
    .getByRole("button", { name: "Registrar cobro", exact: true })
    .click();
  await expect(recorded).toHaveCount(0);
  const paid = await serverOrder(page, toRecord.orderId);
  expect(paid.paid).toBe(paid.total);
  expect(paid.tenders).toHaveLength(1);
  // Discarded: the guest was not charged; the server refuses the original.
  const discarded = card(toDiscard.operationId);
  await discarded
    .getByRole("button", { name: "Consultar estado", exact: true })
    .click();
  await discarded
    .getByRole("button", {
      name: "Descartar intento (no se cobró)",
      exact: true,
    })
    .click();
  await discarded
    .getByLabel("Motivo")
    .fill("El cliente se fue sin pagar; la caja no tiene el dinero");
  await discarded.getByRole("checkbox").check();
  await discarded
    .getByRole("button", { name: "Descartar intento", exact: true })
    .click();
  await expect(discarded).toHaveCount(0);
  expect((await serverOrder(page, toDiscard.orderId)).paid).toBe(0);
  // That order is no longer blocked on this device: it is charged online.
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("checkbox", {
        name: `Seleccionar orden #${toDiscard.number}`,
        exact: true,
      }),
    })
    .getByRole("button", { name: /Abrir orden/ })
    .click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Cobrado");
  const charged = await serverOrder(page, toDiscard.orderId);
  expect(charged.paid).toBe(charged.total);
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

test("An offline external-terminal sale shows and prints service's local receipt with the method, the reference and the order note (LD-10 B4, LD-1)", async ({
  page,
  context,
}) => {
  // LD-10 B4: one receipt component (service's ReceiptDocument kind "local")
  // for the shown and the printed offline receipt.
  await page.addInitScript(() => {
    (window as any).__printed = [];
    window.print = () => {
      (window as any).__printed.push(
        document.getElementById("print-root")?.innerText ?? "",
      );
    };
  });
  const printed = () =>
    page.evaluate(() => (window as any).__printed as string[]);
  await login(page);
  await openDrawer(page);
  await goOffline(context, page);
  await product(page, "Taco de hongos").click();
  await page.getByLabel("Nota de la orden (cocina)").fill("ALERGIA: nuez");
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Cobrar" });
  await dialog
    .getByRole("button", { name: "Terminal externa", exact: true })
    .click();
  await dialog.getByLabel("Referencia").fill("AUT-B4-77");
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Guardar cobro con terminal", exact: true })
    .click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Pendiente de sincronizar");
  await expect(receipt).toContainText("Terminal bancaria externa");
  await expect(receipt).toContainText("Ref. AUT-B4-77");
  await expect(receipt).toContainText("ALERGIA: nuez");
  await expect(receipt).toContainText("Cobrado · pendiente de sincronizar");
  await expect(receipt).not.toContainText("Cambio");
  await expect(receipt).not.toContainText("Saldo pendiente");
  await page
    .getByRole("dialog", { name: "Recibo local" })
    .getByRole("button", { name: "Imprimir recibo", exact: true })
    .click();
  await expect.poll(async () => (await printed()).length).toBe(1);
  const doc = (await printed())[0]!;
  expect(doc).toContain("Terminal bancaria externa");
  expect(doc).toContain("Ref. AUT-B4-77");
  expect(doc).toContain("ALERGIA: nuez");
  expect(doc).toContain("Taco de hongos");
  expect(doc).toMatch(PROVISIONAL);
  await nextSale(page);
  await context.setOffline(false);
});

test("KDS shows offline sales in the review lane with provisional and server numbers", async ({
  page,
  context,
}) => {
  // Regression OFF-4: synced offline orders reached the KDS as fresh tickets.
  // OFF-R23: the lane shows the selected station only, so clearing the
  // kitchen never marks the bar's rounds as served.
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
  // Service's KDS (024) polls its versioned feed for the station on screen.
  const kitchenPolled = () =>
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/service/kitchen",
    );
  const polled = kitchenPolled();
  await page.goto("/app");
  const lane = page.locator(".offline-review-lane");
  await expect(lane).toContainText("Ventas sin conexión por revisar");
  const cards = lane.locator(".offline-review-card").filter({ hasText: label });
  // Service's KDS opens on "Todas" (gm-kds-station): the lane shows every
  // station's round (LD-10 B1) and no count of another station.
  await expect(
    page.getByRole("radio", { name: "Todas", exact: true }),
  ).toBeChecked();
  await expect(cards).toHaveCount(2);
  await expect(lane).not.toContainText(/por revisar en/);
  // Kitchen station: only the kitchen round, and a count of what waits at
  // the bar.
  await page.getByRole("radio", { name: "Cocina", exact: true }).check();
  await expect(cards).toHaveCount(1);
  // OUTAGE-005 (I7): a round waiting in review is never a live ticket.
  const server = label.split("→ ")[1]!;
  const live = page
    .locator(".kitchen-grid .kitchen-ticket")
    .filter({ hasText: new RegExp(`${server}(?!\\d)`) });
  await polled;
  await kitchenPolled();
  await expect(live).toHaveCount(0);
  await expect(cards).toContainText("Cocina");
  await expect(lane).toContainText(/\d+ por revisar en Barra\./);
  await expect(cards.first()).toContainText("Vendida");
  await expect(cards.first()).toContainText(
    "Comanda en la lista del dispositivo",
  );
  await page.screenshot({ path: "docs/evidence/offline-kds-lane-1440.png" });
  // Clearing the kitchen lane marks only kitchen rounds.
  await lane
    .getByRole("button", { name: "Marcar todas como ya preparadas" })
    .click();
  const confirm = page.getByRole("dialog", {
    name: "Marcar todas como ya preparadas",
  });
  await expect(confirm).toContainText("No aparecerán en cocina");
  await confirm.getByRole("button", { name: "Ya se preparó" }).click();
  await expect(cards).toHaveCount(0);
  await page.getByRole("radio", { name: "Barra", exact: true }).check();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("Barra");
  await expect(live).toHaveCount(0);
  await cards
    .getByRole("button", { name: "Preparar ahora", exact: true })
    .click();
  await expect(cards).toHaveCount(0);
  // "Preparar ahora" sends it to the live KDS of its station.
  await expect(live).toHaveCount(1);
});

test("The KDS review lane polls every 10 s with items and every 30 s while empty", async ({
  page,
  context,
}) => {
  // Regression GAP-4: the lane polled every 10 s even when empty.
  await login(page);
  await openDrawer(page);
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await goOffline(context, page);
  const number = await saveOfflineSale(page);
  await nextSale(page);
  await context.setOffline(false);
  await expect
    .poll(
      async () =>
        (await allRows(page)).find((r) => r.body.provisionalNumber === number)
          ?.status,
      { timeout: 60_000 },
    )
    .toBe("synced");
  await page.evaluate(
    async ({ tenantId }) => {
      const s = await (await fetch("/api/session")).json();
      await fetch("/api/logout", {
        method: "POST",
        headers: { "x-csrf-token": s.csrf },
      });
      await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, login: "kitchen", secret: "654321" }),
      });
    },
    { tenantId },
  );
  let polls = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/offline/kitchen"
    )
      polls++;
  });
  await page.clock.install();
  await page.goto("/app");
  const lane = page.locator(".offline-review-lane");
  await expect(lane).toContainText("Ventas sin conexión por revisar");
  // With items: every 10 s.
  polls = 0;
  await advance(page, 60_000);
  expect(polls).toBeGreaterThanOrEqual(5);
  // Empty the lane at both stations (earlier tests may have left items).
  for (const station of ["Cocina", "Barra"]) {
    // Service's KDS station radios (024).
    await page.getByRole("radio", { name: station, exact: true }).check();
    const all = lane.getByRole("button", {
      name: "Marcar todas como ya preparadas",
    });
    if (await all.isVisible()) {
      await all.click();
      await page
        .getByRole("dialog", { name: "Marcar todas como ya preparadas" })
        .getByRole("button", { name: "Ya se preparó" })
        .click();
      await expect(all).toHaveCount(0);
    }
  }
  await expect(lane).toHaveCount(0);
  // Let the chain pick up the empty lane, then every 30 s.
  await advance(page, 10_000);
  polls = 0;
  await advance(page, 60_000);
  expect(polls).toBeGreaterThanOrEqual(1);
  expect(polls).toBeLessThanOrEqual(3);
});

test("Offline saving stops when the session's offline window ends during the outage (I14)", async ({
  page,
  context,
}) => {
  // OFFLINE-MONEY-10: no browser test checked that saving offline is refused
  // once session.offlineUntil (4 h after sign-in) passes by the device's
  // corrected clock.
  await page.clock.install();
  await login(page);
  await openDrawer(page);
  await goOffline(context, page);
  await product(page, "Taco de hongos").click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Cobrar" });
  const save = dialog.getByRole("button", {
    name: "Guardar cobro en este dispositivo",
    exact: true,
  });
  await expect(save).toBeEnabled();
  await page.keyboard.press("Escape");
  // Still offline four hours later: the window has closed.
  await page.clock.fastForward("04:01:00");
  await expect(
    page.getByText(/El periodo sin conexión terminó a las/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText(
    "El periodo sin conexión de esta sesión terminó",
  );
  expect(await allRows(page)).toHaveLength(0);
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

/**
 * Signs this browser in as another fixture employee through the API. The
 * previous session ends without a logout: until the access merge, logout
 * revokes the session (E3), while a switch must end it (contract D6).
 */
async function switchEmployee(page: Page, login: string, secret: string) {
  const status = await page.evaluate(
    async ({ tenantId, login, secret }) => {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, login, secret }),
      });
      return r.status;
    },
    { tenantId, login, secret },
  );
  expect(status).toBe(200);
  await page.goto("/app");
}

test("Manager review says another employee's sale syncs when they sign in, and keeps reconcile behind a second step", async ({
  page,
  context,
}) => {
  // Regression OFFLINE-RECOVERY-04: a valid sale of a signed-out employee
  // showed no problem and the full reconcile, which keeps only its money.
  await login(page);
  await openDrawer(page);
  const cached = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/cash",
  );
  await switchEmployee(page, "cashier", "123456");
  await cached;
  await goOffline(context, page);
  await product(page, "Taco de hongos").click();
  const number = await saveOfflineSale(page);
  await nextSale(page);
  // The connection returns before the cashier's sale syncs; the owner signs in.
  await holdSync(context);
  await context.setOffline(false);
  await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
  await switchEmployee(page, "owner", "demo-green-monkey");
  await releaseSync(context);
  await pill(page, /^Conectado/).click();
  const row = page
    .locator("article.panel")
    .filter({ hasText: `Venta · ${number}` });
  await expect(row).toContainText("Lo registró otra persona");
  await expect(
    page.getByText(/Reintentar envía los registros de/),
  ).toBeVisible();
  await row
    .getByRole("button", { name: "Revisar efectivo", exact: true })
    .click();
  const review = page
    .locator("form.panel")
    .filter({ hasText: "Conciliar efectivo ya recibido" });
  await expect(review).toContainText(
    /Este registro se envía solo cuando Dani Demo inicie sesión en .+\./,
  );
  await expect(review).toContainText("Sesión original");
  const submit = review.getByRole("button", {
    name: "Registrar efectivo verificado",
  });
  await expect(submit).toHaveCount(0);
  await review
    .getByRole("button", { name: "Conciliar de todos modos", exact: true })
    .click();
  await expect(submit).toBeVisible();
  await review.getByRole("button", { name: "Cancelar", exact: true }).click();
  // As the review said: the cashier signs in here and the sale syncs in full.
  await switchEmployee(page, "cashier", "123456");
  await expect
    .poll(
      async () =>
        (await allRows(page)).find((r) => r.body?.provisionalNumber === number)
          ?.status,
      { timeout: 30_000 },
    )
    .toBe("synced");
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
    // A parked attempt waits for a manager and survives the update: it never
    // blocks it (spec §2.9, OFFLINE-RECOVERY-05).
    await page.evaluate(
      (key) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("green-monkey-v1");
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction("cache", "readwrite");
            tx.objectStore("cache").put({ id: key, value: { parked: true } });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      `${s.tenantId}:${s.deviceId}:${s.employeeId}:payment:${crypto.randomUUID()}`,
    );
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

/** Holds every offline record on the device (a transient answer: never a conflict). */
async function holdSync(context: BrowserContext) {
  await context.route("**/api/offline/sync", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "offline_recorded_in_future" }),
    }),
  );
}
const releaseSync = (context: BrowserContext) =>
  context.unroute("**/api/offline/sync");

/** Counts online payment requests (POST /api/orders/:id/payments). */
function onlinePayments(page: Page) {
  const seen: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /^\/api\/orders\/[^/]+\/payments$/.test(new URL(request.url()).pathname)
    )
      seen.push(request.url());
  });
  return seen;
}

/** Sends a two-taco table order online and returns the server order. */
async function sendTableOnline(page: Page, table: string) {
  await page.getByRole("button", { name: "En mesa", exact: true }).click();
  await page.getByLabel("Seleccionar mesa").selectOption({ label: table });
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await page
    .getByRole("button", { name: "Cantidad + Taco de hongos", exact: true })
    .click();
  const created = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/orders" &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  const order = await (await created).json();
  await expect(page.locator(".existing")).toContainText(`#${order.number}`);
  return order as {
    id: string;
    number: number;
    total: number;
    tableId: string;
  };
}

const serverOrder = (page: Page, id: string) =>
  page.evaluate(
    async (orderId) => (await fetch(`/api/orders/${orderId}`)).json(),
    id,
  );

/**
 * LD-7: offline table service (open checks, rounds and partial payments
 * offline) is a per-restaurant beta, off by default. The fixture restaurant
 * keeps it off; these tests turn it on through the API and off again after.
 */
async function setTableService(browser: Browser, on: boolean) {
  const page = await browser.newPage({
    baseURL: process.env.TEST_BASE_URL ?? "http://127.0.0.1:5173",
  });
  try {
    await page.goto("/app");
    const status = await page.evaluate(
      async ({ tenantId, on }) => {
        await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId,
            login: "owner",
            secret: "demo-green-monkey",
          }),
        });
        const s = await (await fetch("/api/session")).json();
        const r = await fetch("/api/offline/settings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": s.csrf,
          },
          body: JSON.stringify({
            operationId: crypto.randomUUID(),
            tableService: on,
          }),
        });
        await fetch("/api/logout", {
          method: "POST",
          headers: { "x-csrf-token": s.csrf },
        });
        return r.status;
      },
      { tenantId, on },
    );
    expect(status).toBe(200);
  } finally {
    await page.close();
  }
}

test.describe("offline table service (Beta) turned on", () => {
  test.beforeAll(async ({ browser }) => setTableService(browser, true));
  test.afterAll(async ({ browser }) => setTableService(browser, false));

  test("Offline payment on a cached open table order; an external terminal payment requires a reference", async ({
    page,
    context,
  }) => {
    // Regression OFF-5: open table checks could not be settled offline.
    await login(page);
    await openDrawer(page);
    await page.getByRole("button", { name: "En mesa", exact: true }).click();
    await page
      .getByLabel("Seleccionar mesa")
      .selectOption({ label: "Mesa 03" });
    await page.getByRole("button", { name: /Taco de hongos/ }).click();
    const created = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/orders" &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Enviar a cocina", exact: true })
      .click();
    const order = await (await created).json();
    await expect(page.locator(".existing")).toContainText(`#${order.number}`);
    // Reopening selling refreshes the open-orders cache used during outages.
    await page.getByRole("button", { name: "Caja", exact: true }).click();
    const cached = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/offline/open-orders",
    );
    await page.getByRole("button", { name: "Vender", exact: true }).click();
    await cached;
    await page
      .getByRole("button", { name: "Nueva orden", exact: true })
      .click();
    await goOffline(context, page);
    await page
      .getByRole("button", { name: "Órdenes abiertas", exact: true })
      .click();
    const picker = page.getByRole("dialog", { name: "Órdenes abiertas" });
    await expect(picker).toContainText(
      "Órdenes guardadas antes de perder la conexión",
    );
    await picker
      .getByRole("button", { name: new RegExp(`#${order.number} · Mesa 03`) })
      .click();
    await expect(page.locator(".existing")).toContainText(`#${order.number}`);
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cobrar" });
    await expect(dialog).toContainText(
      "Esta orden se guardó antes de perder la conexión",
    );
    await dialog
      .getByRole("button", { name: "Terminal externa", exact: true })
      .click();
    const save = dialog.getByRole("button", {
      name: "Guardar cobro con terminal",
      exact: true,
    });
    // Service's PaymentDialog (024) asks for both inline and keeps the save
    // disabled until the reference and the terminal approval are given.
    await expect(save).toBeDisabled();
    await expect(dialog).toContainText(
      "Escribe la referencia de aprobación de la terminal.",
    );
    await dialog.getByLabel("Referencia").fill("AUTH-55");
    await expect(save).toBeDisabled();
    await expect(dialog).toContainText(
      "Marca la confirmación de que la terminal aprobó el pago.",
    );
    await dialog.getByRole("checkbox").check();
    await save.click();
    await expect(page.locator(".receipt")).toContainText(
      "Pendiente de sincronizar",
    );
    await nextSale(page);
    await context.setOffline(false);
    await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              async (id) => (await fetch(`/api/orders/${id}`)).json(),
              order.id,
            )
          ).paid,
        { timeout: 45_000 },
      )
      .toBe(order.total);
    const synced = await page.evaluate(
      async (id) => (await fetch(`/api/orders/${id}`)).json(),
      order.id,
    );
    expect(synced.tenders).toHaveLength(1);
    expect(synced.tenders[0]).toMatchObject({
      method: "external",
      external_reference: "AUTH-55",
    });
  });

  test("Offline Enviar, add a round and pay later sync as one order with two rounds", async ({
    page,
    context,
  }) => {
    // Regression OFF-5: Enviar was disabled offline and rounds could not be added.
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await login(page);
    await openDrawer(page);
    await goOffline(context, page);
    await page.getByRole("button", { name: /Taco de hongos/ }).click();
    await page
      .getByRole("button", { name: "Enviar (sin conexión)", exact: true })
      .click();
    const heading = page.locator(".cart-heading .eyebrow").first();
    await expect(heading).toHaveText(PROVISIONAL);
    const number = (await heading.textContent())!.trim();
    await page.getByRole("button", { name: /Agua de jamaica/ }).click();
    await page
      .getByRole("button", { name: "Enviar (sin conexión)", exact: true })
      .click();
    await expect(page.locator(".existing")).toContainText("Agua de jamaica");
    await page
      .getByRole("button", { name: "Comandas (2)", exact: true })
      .click();
    const tickets = page
      .getByRole("dialog", { name: "Comandas sin conexión" })
      .locator(".offline-ticket");
    await expect(tickets).toHaveCount(2);
    await expect(tickets.filter({ hasText: "Ronda 2" })).toContainText(number);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Guardar cobro en este dispositivo",
        exact: true,
      })
      .click();
    await expect(page.locator(".receipt")).toContainText(number);
    await nextSale(page);
    await context.setOffline(false);
    await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (await allRows(page)).filter((row) => row.status === "synced").length,
        { timeout: 60_000 },
      )
      .toBe(3);
    const rows = await allRows(page);
    const orderIds = new Set(rows.map((row) => row.result?.orderId));
    expect(orderIds.size).toBe(1);
    const [orderId] = [...orderIds];
    const synced = await page.evaluate(
      async (id) => (await fetch(`/api/orders/${id}`)).json(),
      orderId,
    );
    expect(synced.offline.provisionalNumber).toBe(number);
    expect(new Set(synced.lines.map((line: any) => line.round))).toEqual(
      new Set([1, 2]),
    );
    expect(synced.paid).toBe(synced.total);
    expect(synced.tenders).toHaveLength(1);
    expect(
      synced.rounds.every((round: any) => round.state === "offline_review"),
    ).toBe(true);
    await pill(page, /^Conectado/).click();
    await expect(page.locator(".workspace")).toContainText(
      new RegExp(`${number} → #${synced.number}`),
    );
  });

  test("Items tapped while an offline Enviar is being saved stay in the cart; the sent lines and delivered notes leave it", async ({
    page,
    context,
  }) => {
    // OFF-INT-5 (SVC-R7 offline): the cart used to be emptied after the save,
    // so a product tapped during the IndexedDB write never reached the kitchen.
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await login(page);
    await openDrawer(page);
    await goOffline(context, page);
    const send = page.getByRole("button", {
      name: "Enviar (sin conexión)",
      exact: true,
    });
    const cart = page.locator(".order-line");
    const inFlight = cart.filter({ hasText: "Enviando a cocina…" });
    const existing = page.locator(".existing");
    await product(page, "Taco de hongos").click();
    await page.getByLabel("Nota de la orden (cocina)").fill("Sin prisa");
    const release = await holdRecordStores(page);
    await send.click();
    await expect(inFlight).toHaveCount(1);
    // The guest adds a drink while the device is still saving the order.
    await product(page, "Agua de jamaica").click();
    await expect(cart).toHaveCount(2);
    await release();
    const heading = page.locator(".cart-heading .eyebrow").first();
    await expect(heading).toHaveText(PROVISIONAL);
    await expect(existing).toContainText("Taco de hongos");
    await expect(existing).not.toContainText("Agua de jamaica");
    await expect(cart).toHaveCount(1);
    await expect(cart).toContainText("Agua de jamaica");
    await expect(inFlight).toHaveCount(0);
    // The order note reached the order, so it left the cart's note field.
    await expect(existing).toContainText("Sin prisa");
    const roundNote = page.getByLabel("Nota para esta ronda");
    await expect(roundNote).toHaveValue("");
    // The drink goes as round 2 with its own note, which then leaves too.
    await roundNote.fill("Sin hielo");
    await send.click();
    await expect(existing).toContainText("Agua de jamaica");
    await expect(cart).toHaveCount(0);
    await expect(roundNote).toHaveValue("");
    await page
      .getByRole("button", { name: "Comandas (2)", exact: true })
      .click();
    const tickets = page
      .getByRole("dialog", { name: "Comandas sin conexión" })
      .locator(".offline-ticket");
    await expect(tickets).toHaveCount(2);
    await expect(tickets.filter({ hasText: "Ronda 2" })).toContainText(
      "Agua de jamaica",
    );
    await expect(tickets.filter({ hasText: "Ronda 2" })).not.toContainText(
      "Taco de hongos",
    );
    await expect(tickets.filter({ hasNotText: "Ronda 2" })).not.toContainText(
      "Agua de jamaica",
    );
    await page.keyboard.press("Escape");
    // Settle the check so it leaves no open order behind.
    await saveOfflineSale(page);
    await nextSale(page);
    await context.setOffline(false);
  });

  test("The order on screen when the connection drops is payable offline at its full balance", async ({
    page,
    context,
  }) => {
    // Regression OFF-R2: the open-orders cache refreshed only every 120 s, so the
    // order just sent online was missing from it (or had a stale balance).
    await login(page);
    await openDrawer(page);
    const order = await sendTableOnline(page, "Mesa 05");
    await goOffline(context, page);
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cobrar" });
    await expect(dialog.getByLabel("Importe")).toHaveValue(
      (order.total / 100).toFixed(2),
    );
    await dialog
      .getByRole("button", {
        name: "Guardar cobro en este dispositivo",
        exact: true,
      })
      .click();
    await expect(page.locator(".receipt")).toContainText(
      "Pendiente de sincronizar",
    );
    await nextSale(page);
    await context.setOffline(false);
    await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await serverOrder(page, order.id)).paid, {
        timeout: 45_000,
      })
      .toBe(order.total);
    expect((await serverOrder(page, order.id)).tenders).toHaveLength(1);
  });

  test("A local order paid while online goes through records and then follows its server order", async ({
    page,
    context,
  }) => {
    // Invariant I13: a local, unsynced order changes only through offline
    // records, even online; after its record syncs Selling shows the server order.
    await page.addInitScript(() => {
      window.print = () => {};
    });
    const payments = onlinePayments(page);
    await login(page);
    await openDrawer(page);
    await goOffline(context, page);
    await page.getByRole("button", { name: /Taco de hongos/ }).click();
    await page
      .getByRole("button", { name: "Cantidad + Taco de hongos", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Enviar (sin conexión)", exact: true })
      .click();
    await expect(page.locator(".cart-heading .eyebrow").first()).toHaveText(
      PROVISIONAL,
    );
    await holdSync(context);
    await context.setOffline(false);
    await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cobrar" });
    await dialog.getByLabel("Importe").fill("45.00");
    await dialog.getByLabel("Efectivo recibido", { exact: true }).fill("45.00");
    await dialog
      .getByRole("button", { name: "Confirmar cobro", exact: true })
      .click();
    await expect(page.locator(".receipt")).toContainText(
      "Pendiente de sincronizar",
    );
    expect(payments, "the local order is never charged online").toEqual([]);
    await page.getByRole("button", { name: "Volver", exact: true }).click();
    await expect(page.locator(".existing")).toContainText("Cobrado: $45.00");
    await releaseSync(context);
    await expect
      .poll(
        async () =>
          (await allRows(page)).filter((row) => row.status === "synced").length,
        { timeout: 60_000 },
      )
      .toBe(2);
    const orderRow = (await allRows(page)).find(
      (row) => row.body.kind === "order",
    );
    const { orderId, orderNumber } = orderRow.result;
    await expect(page.locator(".existing")).toContainText(`#${orderNumber}`, {
      timeout: 30_000,
    });
    await expect(page.locator(".existing")).toContainText("Cobrado: $45.00", {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await expect(dialog.getByLabel("Importe")).toHaveValue("45.00");
    await dialog
      .getByRole("button", { name: "Confirmar cobro", exact: true })
      .click();
    await expect(page.locator(".receipt")).toContainText("Cobrado");
    expect(payments).toHaveLength(1);
    const synced = await serverOrder(page, orderId);
    expect(synced.paid).toBe(synced.total);
    expect(synced.tenders).toHaveLength(2);
  });

  test("Online payment waits for this device's offline payment of the same order", async ({
    page,
    context,
  }) => {
    // Regression OFF-R5: after reconnect Selling could show the balance before
    // the offline payment synced and staff could charge it again online.
    const payments = onlinePayments(page);
    await login(page);
    await openDrawer(page);
    const order = await sendTableOnline(page, "Mesa 06");
    await goOffline(context, page);
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cobrar" });
    await dialog.getByLabel("Importe").fill("45.00");
    await dialog.getByLabel("Efectivo recibido", { exact: true }).fill("45.00");
    await dialog
      .getByRole("button", {
        name: "Guardar cobro en este dispositivo",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Volver", exact: true }).click();
    await expect(page.locator(".existing")).toContainText("Cobrado: $45.00");
    await holdSync(context);
    await context.setOffline(false);
    await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
    // The server order replaces the projection: it does not show the payment yet.
    await expect(page.locator(".existing")).toContainText("Cobrado: $0.00", {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Confirmar cobro", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Esta orden tiene un pago por confirmar",
    );
    expect(payments, "never charged online twice").toEqual([]);
    await page.keyboard.press("Escape");
    await releaseSync(context);
    // Once the offline payment syncs, Selling reads the order again.
    await expect(page.locator(".existing")).toContainText("Cobrado: $45.00", {
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await expect(dialog.getByLabel("Importe")).toHaveValue("45.00");
    await dialog
      .getByRole("button", { name: "Confirmar cobro", exact: true })
      .click();
    await expect(page.locator(".receipt")).toContainText("Cobrado");
    expect(payments).toHaveLength(1);
    const synced = await serverOrder(page, order.id);
    expect(synced.paid).toBe(order.total);
    expect(synced.tenders).toHaveLength(2);
  });

  test("Online charge waits for this device's offline round of the same order, so its items are charged", async ({
    page,
    context,
  }) => {
    // Regression OFF-R26: after reconnect Selling showed the server order
    // without an offline round whose sync was still failing; charging that
    // balance left the round's items unpaid, and the round was then refused
    // on the paid check.
    await page.addInitScript(() => {
      window.print = () => {};
    });
    const payments = onlinePayments(page);
    await login(page);
    await openDrawer(page);
    const order = await sendTableOnline(page, "Mesa 08");
    await goOffline(context, page);
    await product(page, "Agua de jamaica").click();
    await page
      .getByRole("button", { name: "Enviar (sin conexión)", exact: true })
      .click();
    const existing = page.locator(".existing");
    await expect(existing).toContainText("Agua de jamaica");
    // The connection returns, but the round's sync keeps failing (transient).
    await holdSync(context);
    await context.setOffline(false);
    await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
    // The server order replaces the projection: it lacks the round.
    await expect(existing).not.toContainText("Agua de jamaica", {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cobrar" });
    const confirm = dialog.getByRole("button", {
      name: "Confirmar cobro",
      exact: true,
    });
    await confirm.click();
    await expect(dialog.getByRole("alert")).toContainText(
      "productos guardados sin conexión que aún no se sincronizan",
    );
    expect(payments, "the server balance lacks the round").toEqual([]);
    // Once the round syncs, Selling reads the order again with the round; the
    // amount still at the old balance in the open dialog follows the new one.
    await releaseSync(context);
    await expect(existing).toContainText("Agua de jamaica", {
      timeout: 60_000,
    });
    const withRound = await serverOrder(page, order.id);
    expect(withRound.total).toBeGreaterThan(order.total);
    await expect(dialog.getByLabel("Importe")).toHaveValue(
      (withRound.total / 100).toFixed(2),
    );
    await confirm.click();
    await expect(page.locator(".receipt")).toContainText("Cobrado");
    expect(payments).toHaveLength(1);
    const paid = await serverOrder(page, order.id);
    expect(paid.paid).toBe(withRound.total);
    expect(paid.tenders).toHaveLength(1);
    expect(
      (await allRows(page)).filter((row) => row.status === "conflict"),
    ).toHaveLength(0);
  });

  test("Cobrar juntas waits for this device's offline records of every order it charges", async ({
    page,
    context,
  }) => {
    // Regression OFF-R29: Órdenes › Cobrar juntas charged the server balance
    // of an order whose offline round had not synced, so the round's items
    // were never charged and the round was then refused on the paid check.
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      window.print = () => {};
    });
    const settlements: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/settlements"
      )
        settlements.push(request.url());
    });
    await login(page);
    await openDrawer(page);
    const order = await sendTableOnline(page, "Mesa 01");
    const other = await page.evaluate(async () => {
      const s = await (await fetch("/api/session")).json();
      const catalog = await (await fetch("/api/catalog")).json();
      const taco = catalog.find((p: any) => p.name.es === "Taco de hongos");
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": s.csrf,
        },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          lines: [
            {
              id: crypto.randomUUID(),
              productId: taco.id,
              quantity: 1,
              options: [],
              note: "",
            },
          ],
          mode: "takeaway",
          tableId: null,
          name: "Settlement " + crypto.randomUUID(),
          note: "",
          channel: "pos",
        }),
      });
      return (await response.json()) as { id: string; number: number };
    });
    // During the outage a round is added to the first order offline.
    await goOffline(context, page);
    await product(page, "Agua de jamaica").click();
    await page
      .getByRole("button", { name: "Enviar (sin conexión)", exact: true })
      .click();
    await expect(page.locator(".existing")).toContainText("Agua de jamaica");
    // The connection returns, but the round's sync keeps failing (transient).
    await holdSync(context);
    await context.setOffline(false);
    await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    const box = (n: number) =>
      page.getByRole("checkbox", {
        name: `Seleccionar orden #${n}`,
        exact: true,
      });
    const card = (n: number) =>
      page.getByRole("article").filter({ has: box(n) });
    // The order cannot be selected, and says why.
    await expect(box(order.number)).toBeDisabled();
    await expect(card(order.number)).toContainText(
      "productos guardados sin conexión que aún no se sincronizan",
    );
    await expect(box(other.number)).toBeEnabled();
    // Once the round syncs, the list is read again with its items.
    await releaseSync(context);
    await expect(box(order.number)).toBeEnabled({ timeout: 60_000 });
    const withRound = await serverOrder(page, order.id);
    expect(withRound.total).toBeGreaterThan(order.total);
    await box(order.number).check();
    await box(other.number).check();
    // A record the list has not seen yet (another employee's offline payment
    // of the second order, written by another tab or a restored backup): the
    // charge itself is refused before any request, naming the order.
    const s = await session(page);
    const foreign = crypto.randomUUID();
    await putRow(page, {
      id: foreign,
      scope: `${s.tenantId}:${s.deviceId}:${crypto.randomUUID()}`,
      status: "pending",
      attempts: 0,
      nextAt: 0,
      body: {
        kind: "payment",
        operationId: foreign,
        target: { orderId: other.id },
        payment: {
          method: "cash",
          amount: 100,
          tip: 0,
          received: 100,
          reference: "",
          externalConfirmed: false,
        },
        recordedAt: new Date().toISOString(),
      },
    });
    await page
      .getByRole("button", { name: "Cobrar juntas (2)", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      `#${other.number} · Esta orden tiene un pago por confirmar`,
    );
    expect(settlements, "nothing is charged").toEqual([]);
    // Without it, both orders are charged in full, the round's items included.
    await deleteRow(page, foreign);
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
    // Service's SettlementDialog (024) shows the result; "Listo" closes it.
    await expect(dialog.getByRole("status")).toContainText(
      "Cobro conjunto registrado",
    );
    await dialog.getByRole("button", { name: "Listo", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(settlements).toHaveLength(1);
    const paid = await serverOrder(page, order.id);
    expect(paid.total).toBe(withRound.total);
    expect(paid.paid).toBe(withRound.total);
    expect((await serverOrder(page, other.id)).paid).toBeGreaterThan(0);
  });

  test("Open orders refresh on mount and every 120 s while offline table service is on", async ({
    page,
  }) => {
    // GAP-4 / LD-7: the snapshot is fetched only with the setting on.
    let openOrders = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/offline/open-orders")
        openOrders++;
    });
    await page.clock.install();
    await login(page);
    await expect.poll(() => openOrders).toBe(1);
    await advance(page, 60_000);
    expect(openOrders).toBe(1);
    await advance(page, 65_000);
    await expect.poll(() => openOrders).toBe(2);
  });

  test("A local order that synced and was paid online never comes back as an unpaid open order", async ({
    page,
    context,
  }) => {
    // Regression OFF-R12: once its server copy left the open-orders cache, the
    // synced local order reappeared as a local open order with its full total.
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await login(page);
    await openDrawer(page);
    await goOffline(context, page);
    await product(page, "Taco de hongos").click();
    await page
      .getByRole("button", { name: "Enviar (sin conexión)", exact: true })
      .click();
    const heading = page.locator(".cart-heading .eyebrow").first();
    await expect(heading).toHaveText(PROVISIONAL);
    const number = (await heading.textContent())!.trim();
    await context.setOffline(false);
    await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (await allRows(page)).find((r) => r.body.kind === "order")?.status,
        { timeout: 60_000 },
      )
      .toBe("synced");
    const { orderId, orderNumber } = (await allRows(page)).find(
      (r) => r.body.kind === "order",
    ).result;
    await expect(heading).toHaveText(`${number} → #${orderNumber}`, {
      timeout: 30_000,
    });
    // The kitchen confirms it and the guest pays online: the check closes.
    await page.evaluate(async (id) => {
      const s = await (await fetch("/api/session")).json();
      const lane = await (await fetch("/api/offline/kitchen")).json();
      for (const item of lane.items.filter((i: any) => i.orderId === id))
        await fetch(`/api/offline/kitchen/${item.roundId}/decision`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": s.csrf,
          },
          body: JSON.stringify({
            operationId: crypto.randomUUID(),
            decision: "already_served",
          }),
        });
    }, orderId);
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Cobrar" })
      .getByRole("button", { name: "Confirmar cobro", exact: true })
      .click();
    await expect(page.locator(".receipt")).toContainText("Cobrado");
    await nextSale(page);
    expect((await serverOrder(page, orderId)).state).toBe("completed");
    // The next refresh no longer lists it.
    await page.getByRole("button", { name: "Caja", exact: true }).click();
    const refreshed = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/offline/open-orders",
    );
    await page.getByRole("button", { name: "Vender", exact: true }).click();
    await refreshed;
    await goOffline(context, page);
    await page
      .getByRole("button", { name: "Órdenes abiertas", exact: true })
      .click();
    const picker = page.getByRole("dialog", { name: "Órdenes abiertas" });
    await expect(picker.getByText("Cargando…")).toHaveCount(0);
    await expect(picker).not.toContainText(number);
    await expect(picker).not.toContainText(
      new RegExp(`#${orderNumber}(?!\\d)`),
    );
    await context.setOffline(false);
  });

  test("Offline round on a paid table check offers Enviar como orden nueva and saves a new local order for the same table", async ({
    page,
    context,
  }) => {
    // §2.3 (Revision 2): a check with no balance takes no offline round.
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await login(page);
    await openDrawer(page);
    const order = await sendTableOnline(page, "Mesa 07");
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Cobrar" })
      .getByRole("button", { name: "Confirmar cobro", exact: true })
      .click();
    await expect(page.locator(".receipt")).toContainText("Cobrado");
    // Service's receipt (024) finishes a paid table check ("Siguiente venta");
    // the check stays open until "Liberar mesa" and a waiter adding one more
    // round opens it again from Órdenes. Selling then refreshes the
    // open-orders cache, which lists paid checks (D19).
    await page.keyboard.press("Escape");
    await expect(page.locator(".receipt")).toHaveCount(0);
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    const cached = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/offline/open-orders",
    );
    await page
      .getByRole("article")
      .filter({
        has: page.getByRole("checkbox", {
          name: `Seleccionar orden #${order.number}`,
          exact: true,
        }),
      })
      .getByRole("button", { name: /Abrir orden/ })
      .click();
    await expect(page.locator(".existing")).toContainText(`#${order.number}`);
    await cached;
    await goOffline(context, page);
    await expect(page.locator(".existing")).toContainText(`#${order.number}`);
    await product(page, "Agua de jamaica").click();
    await page
      .getByRole("button", { name: "Enviar (sin conexión)", exact: true })
      .click();
    await expect(page.locator(".cart-bottom").getByRole("alert")).toContainText(
      "Esta cuenta ya está pagada",
    );
    expect(
      (await allRows(page)).filter((row) => row.body.kind === "round"),
    ).toHaveLength(0);
    await page
      .getByRole("button", { name: "Enviar como orden nueva", exact: true })
      .click();
    const heading = page.locator(".cart-heading .eyebrow").first();
    await expect(heading).toHaveText(PROVISIONAL);
    const orderRow = (await allRows(page)).find(
      (row) => row.body.kind === "order",
    );
    expect(orderRow.body.order.mode).toBe("dine_in");
    expect(orderRow.body.order.tableId).toBe(order.tableId);
    await context.setOffline(false);
    await expect
      .poll(async () => (await getRow(page, orderRow.id))?.status, {
        timeout: 60_000,
      })
      .toBe("synced");
    const synced = await getRow(page, orderRow.id);
    expect(synced.result.orderId).not.toBe(order.id);
    expect(
      (await allRows(page)).filter((row) => row.status === "conflict"),
    ).toHaveLength(0);
  });

  test("Imprimir comanda prints the new round, never round 1 again; Enviar offers printing when set to ask", async ({
    page,
    context,
  }) => {
    // Regression OFF-R19: the receipt printed the order's first ticket.
    await page.addInitScript(() => {
      (window as any).__printed = [];
      window.print = () => {
        (window as any).__printed.push(
          // Service's printDocument (contracts §3.7) renders into #print-root.
          document.getElementById("print-root")?.textContent ?? "",
        );
      };
    });
    const printed = () =>
      page.evaluate(() => (window as any).__printed as string[]);
    await login(page);
    await openDrawer(page);
    await goOffline(context, page);
    await product(page, "Taco de hongos").click();
    await page
      .getByRole("button", { name: "Enviar (sin conexión)", exact: true })
      .click();
    const heading = page.locator(".cart-heading .eyebrow").first();
    await expect(heading).toHaveText(PROVISIONAL);
    const number = (await heading.textContent())!.trim();
    // "Preguntar" (the default): the save offers printing its ticket.
    const sent = page.locator(".cart-bottom .warning-panel");
    await expect(sent).toContainText("Comanda guardada en este dispositivo");
    await sent
      .getByRole("button", { name: "Imprimir comanda", exact: true })
      .click();
    await expect.poll(async () => (await printed()).length).toBe(1);
    expect((await printed())[0]).toContain("Taco de hongos");
    expect((await printed())[0]).toContain(number);
    // Pay it with a new item: the receipt prints that round only.
    await product(page, "Agua de jamaica").click();
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Guardar cobro en este dispositivo",
        exact: true,
      })
      .click();
    const receipt = page.getByRole("dialog", { name: "Recibo local" });
    await expect(receipt.locator(".receipt")).toContainText(number);
    await receipt
      .getByRole("button", { name: "Imprimir comanda", exact: true })
      .click();
    await expect.poll(async () => (await printed()).length).toBe(2);
    const roundTicket = (await printed())[1]!;
    expect(roundTicket).toContain(`${number} · Ronda 2`);
    expect(roundTicket).toContain("Agua de jamaica");
    expect(roundTicket).not.toContain("Taco de hongos");
    await nextSale(page);
    await context.setOffline(false);
  });
});
