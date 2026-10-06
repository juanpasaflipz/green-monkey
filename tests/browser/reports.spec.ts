// Reports (029) browser tests. FIT-9 (spec §7.3 tests 10–12): per-station KDS auto-print, the
// kitchen cancellation chits on a KDS and on a selling device (and a failed chit after a void),
// and the new-ticket tone. Phase A also checks the offline notice of Hoy and Finanzas (A13.8)
// and the live report routes over HTTP; the Finanzas views (spec §7.3 tests 1–9, 13, 14) are
// mounted and tested at the phase B merge (docs/REPORTS.md "Merge wiring").
import { test, expect, type Browser, type Page } from "@playwright/test";

const tenantId =
  process.env.DEMO_TENANT_ID ?? "10000000-0000-4000-8000-000000000001";
const letters = (n: number) =>
  Array.from(String(n), (d) => "abcdefghij"[Number(d)]).join("");
const tag = () => "rpt" + letters(Date.now() % 1e8);
const uuid = () => crypto.randomUUID();

async function ownerLogin(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
/** Signs another demo employee in on this browser (the device cookie stays). */
async function switchEmployee(page: Page, login: string, secret: string) {
  const status = await page.evaluate(
    async ({ tenantId, login, secret }) => {
      const s = await (await fetch("/api/session")).json();
      await fetch("/api/logout", {
        method: "POST",
        headers: { "x-csrf-token": s.csrf },
      });
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
}
const pill = (page: Page, name: RegExp) =>
  page.locator(".top-actions").getByRole("button", { name });
/** Calls the API from the page with the session's CSRF token. */
async function call<T = any>(
  page: Page,
  path: string,
  body?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ path, body }) => {
      const s = await (await fetch("/api/session")).json();
      const r = await fetch("/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? String(r.status));
      return data;
    },
    { path, body },
  );
}
/** Pairs this browser as an owner device, then signs the kitchen employee in. */
async function kitchenScreen(page: Page) {
  await ownerLogin(page);
  await switchEmployee(page, "kitchen", "654321");
  await page.goto("/app");
  await expect(page.getByRole("group", { name: "Estación" })).toBeVisible();
}
async function ownerPage(browser: Browser, baseURL: string) {
  const page = await browser.newPage({ baseURL });
  await ownerLogin(page);
  return page;
}
/** Replaces window.print so the test reads what #print-root held at each print. */
async function stubPrint(page: Page) {
  await page.evaluate(() => {
    (window as any).__printed = [];
    window.print = () => {
      const root = document.getElementById("print-root");
      (window as any).__printed.push({
        text: root?.innerText ?? "",
        sections: root?.querySelectorAll(".print-section").length ?? 0,
      });
    };
  });
}
const printed = (page: Page) =>
  page.evaluate(
    () => (window as any).__printed as { text: string; sections: number }[],
  );
async function catalogProduct(page: Page, name: string) {
  const catalog = await call<any[]>(page, "/catalog");
  const p = catalog.find((x) => x.name.es === name);
  if (!p) throw new Error("no product " + name);
  return p;
}
/** An order with a kitchen line and a bar line, created as another terminal would. */
async function twoStationOrder(page: Page, name: string) {
  const taco = await catalogProduct(page, "Taco de hongos");
  const agua = await catalogProduct(page, "Agua de jamaica");
  return call(page, "/orders", {
    operationId: uuid(),
    lines: [
      { id: uuid(), productId: taco.id, quantity: 1, options: [], note: "" },
      { id: uuid(), productId: agua.id, quantity: 2, options: [], note: "" },
    ],
    mode: "takeaway",
    tableId: null,
    name,
    note: "",
    channel: "pos",
  });
}
/** Turns on "Imprimir comanda al enviar a cocina" on this device (Vender → Impresión). */
async function printOnSend(page: Page) {
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: "Impresión", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Imprimir comanda al enviar a cocina")
    .check();
  await page.keyboard.press("Escape");
}
/** Opens Órdenes and voids one unit of «Agua de jamaica» of the named order in the dialog. */
async function voidAguaFromOrders(page: Page, name: string, reason: string) {
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  const card = page.locator(".order-summary").filter({ hasText: name });
  await card.getByRole("button", { name: "Anular", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Agua de jamaica/).fill("1");
  await dialog.getByLabel("Motivo de la anulación").fill(reason);
  // The owner on a shared terminal approves with their own PIN ("Confirma con tu PIN").
  const approval = dialog.getByRole("group", {
    name: "Autorización de gerente",
  });
  if (await approval.isVisible()) {
    await approval
      .getByLabel("Gerente que autoriza")
      .selectOption({ label: "Alex Demo" });
    await approval.getByLabel(/PIN/).fill("demo-green-monkey");
  }
  await dialog.getByRole("button", { name: /Anular 1 productos/ }).click();
  return dialog;
}
/** Voids one unit of the order's bar line through the API (an owner with recent PIN). */
async function voidBarUnit(page: Page, order: any, reason: string) {
  const bar = order.lines.find((l: any) => l.station === "bar");
  return call(page, `/orders/${order.id}/voids`, {
    operationId: uuid(),
    expectedVersion: order.version,
    lines: [{ lineId: bar.id, quantity: 1 }],
    reason,
    stockDisposition: "no_return",
  });
}
/** Pays what is left and closes the check, so the fixture leaves no open check behind. */
async function settle(page: Page, orderId: string) {
  const current = await call(page, "/cash");
  if (!current || current.closed_at)
    await call(page, "/cash/open", { operationId: uuid(), opening: 50000 });
  const o = await call(page, "/orders/" + orderId);
  if (o.total > o.paid)
    await call(page, `/orders/${o.id}/payments`, {
      operationId: uuid(),
      amount: o.total - o.paid,
      tip: 0,
      received: o.total - o.paid,
      method: "cash",
    });
}

test("FIT-9: a Barra KDS with auto-print prints only new bar tickets, and a void prints a cancellation chit there", async ({
  page,
  browser,
  baseURL,
}) => {
  await kitchenScreen(page);
  await page.getByRole("radio", { name: "Barra" }).check();
  await page.getByRole("button", { name: "Impresión", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Imprimir tickets nuevos automáticamente en esta pantalla")
    .check();
  await page.keyboard.press("Escape");
  await stubPrint(page);
  const owner = await ownerPage(browser, baseURL!);
  const name = "Barra " + tag();
  let orderId = "";
  try {
    const order = await twoStationOrder(owner, name);
    orderId = order.id;
    await expect
      .poll(async () => (await printed(page)).map((j) => j.text).join("\n"), {
        timeout: 20000,
      })
      .toContain(name);
    const ticket = (await printed(page)).find((j) => j.text.includes(name))!;
    expect(ticket.text).toContain("Agua de jamaica");
    expect(ticket.text).not.toContain("Taco de hongos");
    // A void of the bar line: the bar screen prints a cancellation chit.
    await voidBarUnit(owner, order, "Cliente cambió de opinión");
    await expect
      .poll(async () => (await printed(page)).map((j) => j.text).join("\n"), {
        timeout: 20000,
      })
      .toContain("CANCELACIÓN · NO PREPARAR");
    const chit = (await printed(page)).find((j) =>
      j.text.includes("CANCELACIÓN"),
    )!;
    expect(chit.text).toContain(`#${order.number}`);
    expect(chit.text).toContain("− 1 × Agua de jamaica");
    expect(chit.text).toContain("Barra");
    expect(chit.text).toContain("Motivo: Cliente cambió de opinión");
    expect(chit.text).not.toContain("Taco de hongos");
  } finally {
    if (orderId) await settle(owner, orderId);
    await owner.close();
  }
});

test("FIT-9: with «Imprimir comanda al enviar», Vender prints one section per station and a void prints a cancellation chit on the selling device", async ({
  page,
}) => {
  await ownerLogin(page);
  const current = await call(page, "/cash");
  if (!current || current.closed_at)
    await call(page, "/cash/open", { operationId: uuid(), opening: 50000 });
  const name = "Envío " + tag();
  await printOnSend(page);
  await stubPrint(page);
  const tile = (product: string) =>
    page
      .locator("button.product")
      .filter({ has: page.getByText(product, { exact: true }) });
  await tile("Taco de hongos").click();
  await tile("Agua de jamaica").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect
    .poll(async () => (await printed(page)).map((j) => j.text).join("\n"))
    .toContain(name);
  const job = (await printed(page)).find((j) => j.text.includes(name))!;
  expect(job.sections).toBe(2);
  expect(job.text).toContain("Taco de hongos");
  expect(job.text).toContain("Agua de jamaica");
  const list = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  const orderId = list.items[0].id as string;
  try {
    // The void from Órdenes (a manager on a shared terminal confirms with a PIN).
    await stubPrint(page);
    const dialog = await voidAguaFromOrders(page, name, "Error de captura");
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await printed(page)).map((j) => j.text).join("\n"))
      .toContain("CANCELACIÓN · NO PREPARAR");
    const chit = (await printed(page)).find((j) =>
      j.text.includes("CANCELACIÓN"),
    )!;
    expect(chit.text).toContain("− 1 × Agua de jamaica");
    expect(chit.text).toContain("Barra");
    expect(chit.text).toContain("Motivo: Error de captura");
    expect(chit.sections).toBe(1);
  } finally {
    await settle(page, orderId);
  }
});

test("FIT-9: the KDS plays the new-ticket tone when sound is on", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.addInitScript(() => {
    (window as any).__tones = 0;
    const Base = window.AudioContext;
    (window as any).AudioContext = class extends Base {
      createOscillator() {
        const osc = super.createOscillator();
        const start = osc.start.bind(osc);
        osc.start = (when?: number) => {
          (window as any).__tones++;
          start(when);
        };
        return osc;
      }
    };
  });
  await kitchenScreen(page);
  await page.getByRole("radio", { name: "Todas" }).check();
  await page.getByRole("button", { name: "Activar sonido" }).click();
  await expect(
    page.getByRole("button", { name: "Sonido activado" }),
  ).toBeVisible();
  // Let the first load fill the seen set, so only the next order is new.
  await page.waitForTimeout(4000);
  const before = await page.evaluate(() => (window as any).__tones as number);
  const owner = await ownerPage(browser, baseURL!);
  const name = "Tono " + tag();
  let orderId = "";
  try {
    const order = await twoStationOrder(owner, name);
    orderId = order.id;
    await expect(
      page.locator(".kitchen-ticket").filter({ hasText: name }).first(),
    ).toBeVisible({ timeout: 15000 });
    await expect
      .poll(() => page.evaluate(() => (window as any).__tones as number))
      .toBeGreaterThanOrEqual(before + 2);
  } finally {
    if (orderId) await settle(owner, orderId);
    await owner.close();
  }
});

test("FIT-9: when the cancellation chit fails to print, the void dialog says the void was recorded and offers only Reintentar impresión or Cerrar", async ({
  page,
}) => {
  await ownerLogin(page);
  const name = "Falla " + tag();
  const order = await twoStationOrder(page, name);
  const agua = order.lines.find((l: any) => l.station === "bar");
  try {
    await printOnSend(page);
    // The printer fails once (window.print throws), then works.
    await page.evaluate(() => {
      window.print = () => {
        throw new Error("Impresora desconectada");
      };
    });
    const dialog = await voidAguaFromOrders(page, name, "Cliente se fue");
    await expect(
      dialog.getByText("La anulación quedó registrada.", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveText(
      "No se pudo imprimir la cancelación.",
    );
    // No second void from this dialog: the form and its submit button are gone.
    await expect(
      dialog.getByRole("button", { name: /Anular \d+ productos/ }),
    ).toHaveCount(0);
    await expect(dialog.getByLabel("Motivo de la anulación")).toHaveCount(0);
    const after = await call(page, "/orders/" + order.id);
    expect(after.total).toBe(order.total - agua.unitPrice);
    await stubPrint(page);
    await dialog
      .getByRole("button", { name: "Reintentar impresión", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    const chit = (await printed(page)).find((j) =>
      j.text.includes("CANCELACIÓN"),
    )!;
    expect(chit.text).toContain("− 1 × Agua de jamaica");
    expect(chit.text).toContain("Motivo: Cliente se fue");
  } finally {
    await settle(page, order.id);
  }
});

test("A13.8: Hoy and Finanzas say «Los reportes requieren conexión.» offline without requesting a report, and load again when the connection returns", async ({
  page,
  context,
}) => {
  await ownerLogin(page);
  const reportRequests: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (/^\/api\/reports?(\/|$)/.test(path)) reportRequests.push(path);
  });
  const notice = page.getByText("Los reportes requieren conexión.", {
    exact: true,
  });
  await context.setOffline(true);
  await expect(pill(page, /^Sin conexión/)).toBeVisible();
  // The open Hoy view switches to the notice by itself.
  await expect(notice).toBeVisible();
  await page.getByRole("button", { name: "Finanzas", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Finanzas", exact: true }),
  ).toBeVisible();
  await expect(notice).toBeVisible();
  await page.getByRole("button", { name: "Hoy", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await expect(notice).toBeVisible();
  expect(reportRequests).toEqual([]);
  await context.setOffline(false);
  await expect(pill(page, /^Conectado/)).toBeVisible({ timeout: 30_000 });
  await expect(notice).toBeHidden();
  expect(reportRequests).toContain("/api/report");
});

test("the live report routes answer over HTTP without caching, and refuse a cashier", async ({
  page,
}) => {
  await ownerLogin(page);
  /** A GET from the page (its session cookies and fetch metadata): status, cache header, body. */
  const get = (path: string) =>
    page.evaluate(async (path) => {
      const r = await fetch(path);
      return {
        status: r.status,
        cache: r.headers.get("cache-control"),
        body: await r.json(),
      };
    }, path);
  const range = "from=2026-01-05&to=2026-01-05";
  for (const path of [
    "/api/reports/audit?" + range,
    "/api/reports/tenders?" + range,
    "/api/reports/filters",
  ]) {
    const r = await get(path);
    expect(r.status, path).toBe(200);
    expect(r.cache, path).toBe("no-store");
  }
  const bad = await get("/api/reports/audit?from=2026-01-05");
  expect([bad.status, bad.body.error]).toEqual([400, "invalid_input"]);
  await switchEmployee(page, "cashier", "123456");
  const refused = await get("/api/reports/audit?" + range);
  expect([refused.status, refused.body.error]).toEqual([403, "forbidden"]);
});
