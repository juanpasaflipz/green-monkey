import "dotenv/config";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";

// Reports (029) browser tests for Hoy, Finanzas and the cortes (spec §7.3 tests 1–9, 13, 14) and the second opinion's UI
// findings (LD-27: REPORTS-UI-1..UI-10, CORTES-1). The demo owner "Alex Demo" runs every view;
// fixture devices and drawers are created in-test and revoked afterwards.
const tenantId = "10000000-0000-4000-8000-000000000001";
const ownerId = "20000000-0000-4000-8000-000000000001";
const OWNER_PASSWORD = "demo-green-monkey";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const uuid = () => crypto.randomUUID();
const tag = () => "fin" + Math.random().toString(36).slice(2, 7);

/** Local fixture database only (same guard as discounts.spec). */
function fixtureAdmin(baseURL: string | undefined) {
  const runtime = new URL(process.env.DATABASE_URL ?? "http://invalid"),
    migration = new URL(process.env.MIGRATION_DATABASE_URL ?? "http://invalid"),
    base = new URL(baseURL ?? "http://invalid");
  if (
    !["localhost", "127.0.0.1"].includes(runtime.hostname) ||
    runtime.hostname !== migration.hostname ||
    runtime.port !== migration.port ||
    runtime.pathname !== migration.pathname ||
    !/^\/green_monkey(_[a-z]+)?_dev$/.test(runtime.pathname) ||
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    throw Error("Report fixtures require the isolated local dev database");
  return postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
}
/** An extra device with an open (or closed) drawer, as another terminal left it. */
async function fixtureDrawer(
  admin: postgres.Sql,
  p: {
    name: string;
    openedHoursAgo: number;
    opening: number;
    closed?: { counted: number; expected: number };
  },
) {
  const deviceId = uuid(),
    drawerId = uuid();
  await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`insert into devices(tenant_id,id,name,token_hash) values(${tenantId},${deviceId},${p.name},${"x" + deviceId})`;
    if (p.closed)
      await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at,counted,expected,reason,closed_at,closed_by,count_mode)
        values(${tenantId},${drawerId},${deviceId},${ownerId},${p.opening},now() - make_interval(hours => ${p.openedHoursAgo}),
          ${p.closed.counted},${p.closed.expected},'Faltó cambio',now() - make_interval(hours => ${p.openedHoursAgo - 1}),${ownerId},'visible')`;
    else
      await tx`insert into cash_sessions(tenant_id,id,device_id,employee_id,opening,opened_at)
        values(${tenantId},${drawerId},${deviceId},${ownerId},${p.opening},now() - make_interval(hours => ${p.openedHoursAgo}))`;
  });
  return { deviceId, drawerId };
}
async function revokeDevice(admin: postgres.Sql, deviceId: string) {
  await admin.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`update devices set active=false, revoked_at=now(), revoked_by=${ownerId}, revoked_reason='revoked' where id=${deviceId}`;
  });
}

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
/** Calls the API as the page's session. */
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
async function openDrawer(page: Page, opening = 50000) {
  const current = await call(page, "/cash");
  if (!current || current.closed_at)
    await call(page, "/cash/open", { operationId: uuid(), opening });
}
/** A takeaway order of `quantity` tacos paid by `method`. */
async function sale(
  page: Page,
  method: "cash" | "external" = "cash",
  quantity = 1,
) {
  const catalog = await call<any[]>(page, "/catalog");
  const taco = catalog.find((x) => x.name.es === "Taco de hongos");
  const o = await call(page, "/orders", {
    operationId: uuid(),
    lines: [
      { id: uuid(), productId: taco.id, quantity, options: [], note: "" },
    ],
    mode: "takeaway",
    tableId: null,
    name: "Finanzas " + tag(),
    note: "",
    channel: "pos",
  });
  await call(page, `/orders/${o.id}/payments`, {
    operationId: uuid(),
    amount: o.total,
    tip: 0,
    received: method === "cash" ? o.total : 0,
    method,
    externalConfirmed: method === "external",
    reference: method === "external" ? "T-8812" : "",
  });
  return o;
}
const rail = (page: Page, name: string) =>
  page.locator("nav.rail").getByRole("button", { name, exact: true });
const chip = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Rango de fechas" })
    .getByRole("button", { name, exact: true });
const tab = (page: Page, name: string) =>
  page.getByRole("tab", { name, exact: true });
async function finance(page: Page, tabName = "Resumen") {
  await rail(page, "Finanzas").click();
  await expect(
    page.getByRole("heading", { name: "Finanzas", exact: true }),
  ).toBeVisible();
  await tab(page, tabName).click();
  await chip(page, "Hoy").click();
}
/** Opens an operational view through Operación and its tabs (owners and managers). */
async function go(page: Page, view: string) {
  await rail(page, "Operación").click();
  await page.getByRole("button", { name: view, exact: true }).click();
}
const timeout = (url: URL) =>
  url.pathname.startsWith("/api/reports/") &&
  url.searchParams.get("employee") !== null;
const reportTimeout = {
  status: 422,
  contentType: "application/json",
  body: JSON.stringify({ error: "reports_timeout" }),
};
/** Replaces window.print: records the printed text and whether the document overflows its width. */
async function stubPrint(page: Page) {
  await page.evaluate(() => {
    (window as any).__printed = [];
    window.print = () => {
      const root = document.getElementById("print-root");
      const doc = root?.querySelector<HTMLElement>(".print-doc");
      (window as any).__printed.push({
        text: root?.innerText ?? "",
        overflow: doc ? doc.scrollWidth - doc.clientWidth : 0,
      });
    };
  });
}
const printed = (page: Page) =>
  page.evaluate(
    () => (window as any).__printed as { text: string; overflow: number }[],
  );
const addDays = (date: string, days: number) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

test("Finanzas (§7.3 tests 1, 3): ranges, the cash and terminal split, all totals reconcile, axe; a range whose load fails shows none of the previous range's figures (REPORTS-UI-1)", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await sale(page, "cash");
  await sale(page, "external");
  await finance(page);
  await expect(chip(page, "Hoy")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".report-tiles")).toBeVisible();
  await expect(page.getByText("Todos los totales cuadran.")).toBeVisible();
  const methods = page.getByRole("table", { name: "Cobros por método" });
  await expect(
    methods.getByRole("row").filter({ hasText: "Efectivo" }),
  ).toBeVisible();
  await expect(
    methods.getByRole("row").filter({ hasText: "Terminal bancaria externa" }),
  ).toBeVisible();
  const axe = await new AxeBuilder({ page })
    .include(".reports-view")
    .withTags(AXE_TAGS)
    .analyze();
  expect(axe.violations).toEqual([]);
  // Last month times out: today's tiles, checks and CSV must not stay under "Mes pasado".
  await page.route("**/api/reports/summary?**", (route) =>
    route.fulfill(reportTimeout),
  );
  await chip(page, "Mes pasado").click();
  await expect(page.getByRole("alert")).toContainText(
    "El reporte tardó demasiado",
  );
  await expect(page.locator(".report-tiles")).toHaveCount(0);
  await expect(page.getByText("Todos los totales cuadran.")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Descargar CSV", exact: true }),
  ).toHaveCount(0);
  await page.unroute("**/api/reports/summary?**");
  await chip(page, "Hoy").click();
  await expect(page.locator(".report-tiles")).toBeVisible();
});

test("Resumen on a phone (§7.3 test 14, REPORTS-UI-6, UI-9): amounts stay on one line in the tiles, the refund split is rows of its own, and the page never scrolls sideways", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // Large figures, as a busy month would show them.
  await page.route("**/api/reports/summary?**", async (route) => {
    const response = await route.fetch();
    const s = await response.json();
    s.sales.salesTotal = 123_456_789;
    s.sales.averageTicket = 123_456_789;
    s.sales.outstanding = 123_454_000;
    s.collections.collected = 123_454_000;
    s.collections.tips = 1_234_500;
    s.refunds = { ...s.refunds, total: 125_000, cash: 125_000, external: 0 };
    await route.fulfill({ response, json: s });
  });
  await finance(page);
  await expect(page.locator(".report-tiles")).toBeVisible();
  await expect(page.locator(".report-tile dd").first()).toContainText(
    "$1,234,567.89",
  );
  const lines = await page.evaluate(() =>
    [...document.querySelectorAll(".report-tile dd")].map((dd) => {
      const range = document.createRange();
      range.selectNodeContents(dd.firstChild!);
      return range.getClientRects().length;
    }),
  );
  expect(
    lines.every((n) => n === 1),
    JSON.stringify(lines),
  ).toBe(true);
  const sales = page
    .locator(".report-card")
    .filter({ hasText: "Ventas brutas" });
  await expect(
    sales.locator(".doc-row").filter({ hasText: "Reembolsos" }),
  ).toContainText("−$1,250.00");
  await expect(
    sales.locator(".doc-row.indent").filter({ hasText: "Efectivo" }),
  ).toContainText("−$1,250.00");
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("Excepciones and Pagos (§7.3 test 4, REPORTS-UI-7, UI-8): a filter whose list fails shows none of the previous rows, and the Caja filter follows the range", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  // One void today, so Excepciones lists something under "Todos".
  const catalog = await call<any[]>(page, "/catalog");
  const taco = catalog.find((x) => x.name.es === "Taco de hongos");
  const o = await call(page, "/orders", {
    operationId: uuid(),
    lines: [
      { id: uuid(), productId: taco.id, quantity: 2, options: [], note: "" },
    ],
    mode: "takeaway",
    tableId: null,
    name: "Excepción " + tag(),
    note: "",
    channel: "pos",
  });
  const after = await call(page, `/orders/${o.id}/voids`, {
    operationId: uuid(),
    expectedVersion: o.version,
    lines: [{ lineId: o.lines[0].id, quantity: 1 }],
    reason: "Error de captura",
    stockDisposition: "no_return",
  });
  try {
    await finance(page, "Excepciones");
    const list = page.getByRole("table", { name: "Excepciones" });
    await expect(list.locator("tbody tr").first()).toBeVisible();
    await page.route(
      (url) => timeout(url),
      (route) => route.fulfill(reportTimeout),
    );
    await page
      .getByRole("combobox", { name: "Empleado" })
      .selectOption({ label: "Dani Demo" });
    await expect(page.getByRole("alert").first()).toContainText(
      "El reporte tardó demasiado",
    );
    await expect(list.locator("tbody tr")).toHaveCount(0);
    await page.unroute((url) => timeout(url));

    await tab(page, "Pagos").click();
    const drawer = page.getByRole("combobox", { name: "Caja" });
    await expect(drawer.locator("option")).not.toHaveCount(1);
    const filtered = page.waitForRequest(
      (r) =>
        r.url().includes("/api/reports/tenders") && r.url().includes("drawer="),
    );
    await drawer.selectOption({ index: 1 });
    await filtered;
    const next = page.waitForRequest((r) =>
      r.url().includes("/api/reports/tenders"),
    );
    await chip(page, "Semana pasada").click();
    expect((await next).url()).not.toContain("drawer=");
    await expect(drawer).toHaveValue("");
  } finally {
    await call(page, `/orders/${o.id}/payments`, {
      operationId: uuid(),
      amount: after.total,
      tip: 0,
      received: after.total,
      method: "cash",
    });
  }
});

test("Hoy (§7.3 test 9, REPORTS-UI-5, UI-10): the header Actualizar reloads Hoy and Finanzas; the unreviewed-difference alert opens Cortes on the last 31 days, where an older difference is listed «Por revisar»", async ({
  page,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  const name = "Caja vieja " + tag();
  const fixture = await fixtureDrawer(admin, {
    name,
    openedHoursAgo: 72,
    opening: 10_000,
    closed: { counted: 10_000, expected: 10_500 },
  });
  try {
    await login(page);
    const today: string = (await call(page, "/reports/today")).businessDate;
    const todayLoads: string[] = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (path === "/api/reports/today" || path === "/api/reports/drawers")
        todayLoads.push(path);
    });
    const header = page
      .locator(".section-title")
      .getByRole("button", { name: "Actualizar" });
    const before = todayLoads.filter((p) => p.endsWith("today")).length;
    await header.click();
    await expect
      .poll(() => todayLoads.filter((p) => p.endsWith("today")).length)
      .toBeGreaterThan(before);
    const alert = page
      .locator(".today-alert")
      .filter({ hasText: "sin revisar en los últimos 31 días" });
    await expect(alert).toBeVisible();
    await alert.getByRole("button", { name: "Cortes", exact: true }).click();
    await expect(tab(page, "Cortes")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Desde")).toHaveValue(addDays(today, -30));
    await expect(page.getByLabel("Hasta")).toHaveValue(today);
    await expect(page.getByRole("row").filter({ hasText: name })).toContainText(
      "Por revisar",
    );
    const drawersBefore = todayLoads.filter((p) =>
      p.endsWith("drawers"),
    ).length;
    await header.click();
    await expect
      .poll(() => todayLoads.filter((p) => p.endsWith("drawers")).length)
      .toBeGreaterThan(drawersBefore);
  } finally {
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`insert into cash_count_reviews(tenant_id,id,drawer_id,reviewer_id,note)
        values(${tenantId},${uuid()},${fixture.drawerId},${ownerId},'Prueba de reportes')`;
    });
    await revokeDevice(admin, fixture.deviceId);
    await admin.end();
  }
});

test("Caja (§7.3 tests 6, 8, 13, REPORTS-UI-2): Corte X from the open drawer (disabled offline with its reason), the close dialog prints the corte Z, the history reprints it as REIMPRESIÓN 2, 58 mm fits, and on a phone Cortes keeps Diferencia readable", async ({
  page,
  context,
}) => {
  await login(page);
  await openDrawer(page);
  await sale(page, "cash");
  await go(page, "Caja");
  const corteX = page.getByRole("button", { name: "Corte X", exact: true });
  await expect(corteX).toBeEnabled();
  await context.setOffline(true);
  await expect(corteX).toBeDisabled();
  await expect(corteX).toHaveAccessibleDescription(
    "Los reportes requieren conexión.",
  );
  await context.setOffline(false);
  await expect(corteX).toBeEnabled({ timeout: 30_000 });
  await stubPrint(page);
  await corteX.click();
  const preview = page.getByRole("dialog", { name: "Vista previa" });
  await preview.getByRole("radio", { name: "58 mm" }).check();
  await preview.getByRole("button", { name: "Imprimir", exact: true }).click();
  await expect.poll(async () => (await printed(page)).length).toBe(1);
  const [x] = await printed(page);
  expect(x.text).toContain("CORTE X");
  expect(x.overflow, "the 58 mm corte X fits its width").toBeLessThanOrEqual(0);
  await preview.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(preview).toBeHidden();
  // Close with the exact count, then print the corte Z from the result step.
  const cash = await call(page, "/cash");
  await page.getByRole("button", { name: "Cerrar caja", exact: true }).click();
  const close = page.getByRole("dialog", { name: "Cerrar caja" });
  await close
    .getByLabel("Efectivo contado")
    .fill((cash.expected / 100).toFixed(2));
  await close.getByRole("button", { name: "Continuar", exact: true }).click();
  await close
    .getByRole("button", { name: "Guardar conteo y cerrar", exact: true })
    .click();
  const result = page.getByRole("dialog", { name: "Corte registrado" });
  await result
    .getByRole("button", { name: "Imprimir corte Z", exact: true })
    .click();
  const zPreview = page.getByRole("dialog", { name: "Vista previa" });
  await zPreview.getByRole("button", { name: "Imprimir", exact: true }).click();
  await expect.poll(async () => (await printed(page)).length).toBe(2);
  const z = (await printed(page))[1];
  expect(z.text).toContain("CORTE Z");
  expect(z.text).not.toContain("REIMPRESIÓN");
  await zPreview.getByRole("button", { name: "Cerrar", exact: true }).click();
  await result.getByRole("button", { name: "Listo", exact: true }).click();
  await page.getByText("Historial de cajas", { exact: true }).click();
  await page
    .locator("details article.panel")
    .first()
    .getByRole("button", { name: "Imprimir corte Z", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Vista previa" })
    .getByRole("button", { name: "Imprimir", exact: true })
    .click();
  await expect.poll(async () => (await printed(page)).length).toBe(3);
  expect((await printed(page))[2].text).toContain("REIMPRESIÓN 2");
  await page
    .getByRole("dialog", { name: "Vista previa" })
    .getByRole("button", { name: "Cerrar", exact: true })
    .click();
  await openDrawer(page);
  // On a phone the actions column scrolls with its row: Diferencia stays readable.
  await page.setViewportSize({ width: 390, height: 844 });
  await rail(page, "Finanzas").click();
  await tab(page, "Cortes").click();
  await chip(page, "Hoy").click();
  await expect(page.locator(".report-table .sticky-end").first()).toBeVisible();
  expect(
    await page
      .locator(".report-table .sticky-end")
      .first()
      .evaluate((el) => getComputedStyle(el).position),
  ).toBe("static");
});

test("Remote close (§7.3 test 9, REPORTS-CORTES-1): Hoy's open-since alert leads to Cortes; the dialog shows the live expected cash, refuses a close after the drawer changed and asks for a recount; the closed drawer leaves Hoy", async ({
  page,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  const name = "Terraza " + tag();
  const fixture = await fixtureDrawer(admin, {
    name,
    openedHoursAgo: 30,
    opening: 30_000,
  });
  try {
    await login(page);
    const alert = page.locator(".today-alert").filter({ hasText: name });
    await expect(alert).toContainText("sigue abierta desde el");
    await alert.getByRole("button", { name: "Cortes", exact: true }).click();
    const row = page.getByRole("row").filter({ hasText: name });
    await row
      .getByRole("button", { name: "Cerrar caja desde aquí", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: `Cerrar caja de ${name}` });
    await expect(dialog).toContainText("Efectivo esperado ahora: $300.00");
    await dialog.getByLabel("Efectivo contado").fill("300");
    await dialog.getByLabel("Motivo del cierre").fill("La caja quedó abierta");
    await dialog
      .getByRole("button", { name: "Cerrar caja desde aquí", exact: true })
      .click();
    await expect(dialog).toContainText("Cuadra");
    // A paid-out lands on that drawer after the dialog read it.
    await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`insert into cash_movements(tenant_id,id,session_id,amount,reason) values(${tenantId},${uuid()},${fixture.drawerId},-1000,'Hielo')`;
    });
    await dialog
      .getByRole("button", { name: "Cerrar caja con $300.00 contados" })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "La caja cambió desde que la abriste",
    );
    await expect(dialog).toContainText("Efectivo esperado ahora: $290.00");
    expect(
      (
        await admin`select closed_at from cash_sessions where id = ${fixture.drawerId}`
      )[0].closed_at,
    ).toBeNull();
    await dialog.getByLabel("Efectivo contado").fill("290");
    await dialog
      .getByRole("button", { name: "Cerrar caja desde aquí", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Cerrar caja con $290.00 contados" })
      .click();
    await expect(dialog).toContainText("CORTE Z");
    await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
    await rail(page, "Hoy").click();
    await expect(page.locator(".report-tiles")).toBeVisible();
    await expect(
      page.locator(".today-alert").filter({ hasText: name }),
    ).toHaveCount(0);
  } finally {
    await revokeDevice(admin, fixture.deviceId);
    await admin.end();
  }
});

test("Productos, Personal, Horas y canales and Bitácora (§7.3 tests 2, 5): rows, the activity filter and CSV files named by dataset and date", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await sale(page, "cash", 2);
  await finance(page, "Productos");
  const today: string = (await call(page, "/reports/today")).businessDate;
  await expect(
    page.getByRole("row").filter({ hasText: "Taco de hongos" }).first(),
  ).toBeVisible();
  const csv = async (dataset: string) => {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Descargar CSV", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`${dataset}_${today}.csv`);
  };
  await csv("ventas_por_producto");
  await tab(page, "Personal").click();
  await expect(
    page.getByRole("row").filter({ hasText: "Alex Demo" }).first(),
  ).toBeVisible();
  await csv("ventas_por_mesero");
  await tab(page, "Horas y canales").click();
  await expect(page.getByRole("table").first()).toBeVisible();
  await tab(page, "Bitácora").click();
  await page.getByLabel("Actividad").selectOption({ label: "Ventas y cobros" });
  const log = page.getByRole("table", { name: "Bitácora" });
  await expect(log.locator("tbody tr").first()).toBeVisible();
  const activities = await log
    .locator("tbody tr td:nth-child(2)")
    .allInnerTexts();
  expect(activities.length).toBeGreaterThan(0);
  expect(activities.some((a) => /Cobro|Pago|Orden/.test(a))).toBe(true);
  await csv("bitacora");
});
