import "dotenv/config";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";

// Discounts, refunds and drawer controls (028), specs/discounts.md §7.3. The
// demo owner "Alex Demo" approves (the demo has no separate manager); the
// cashier is "Dani Demo" and the kitchen "Cocina Demo".
const tenantId = "10000000-0000-4000-8000-000000000001";
const OWNER_PASSWORD = "demo-green-monkey";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

/** Local fixture database only (same guard as access.spec). */
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
    throw Error("Discount fixtures require the isolated local dev database");
  return postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
}
const tag = () => "dsc" + Math.random().toString(36).slice(2, 7);
const uuid = () => crypto.randomUUID();

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
}
/** Signs another employee in on this paired browser (voids.spec pattern). */
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
  await page.goto("/app");
}
/**
 * Opens an operational view: owners and managers reach it through "Operación"
 * and its tabs; cashiers have it in the rail.
 */
async function go(page: Page, view: string, operation = "Operación") {
  await expect(page.locator("nav.rail")).toBeVisible();
  const rail = page
    .locator("nav.rail")
    .getByRole("button", { name: operation, exact: true });
  if (await rail.count()) await rail.click();
  await page.getByRole("button", { name: view, exact: true }).click();
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
async function order(
  page: Page,
  name: string,
  quantity = 1,
  productName = "Taco de hongos",
) {
  const catalog = await call<any[]>(page, "/catalog");
  const p = catalog.find((x) => x.name.es === productName);
  return call(page, "/orders", {
    operationId: uuid(),
    lines: [{ id: uuid(), productId: p.id, quantity, options: [], note: "" }],
    mode: "takeaway",
    tableId: null,
    name,
    note: "",
    channel: "pos",
  });
}
async function pay(
  page: Page,
  orderId: string,
  amount: number,
  o: { method?: "cash" | "external"; items?: string[] } = {},
) {
  const method = o.method ?? "cash";
  return call(page, `/orders/${orderId}/payments`, {
    operationId: uuid(),
    amount,
    tip: 0,
    received: method === "cash" ? amount : 0,
    method,
    externalConfirmed: method === "external",
    reference: method === "external" ? "T-482913" : "",
    ...(o.items ? { items: o.items } : {}),
  });
}
/** Replaces window.print so the test reads what #print-root held at print time. */
async function stubPrint(page: Page) {
  await page.evaluate(() => {
    (window as any).__printed = [];
    window.print = () => {
      (window as any).__printed.push(
        document.getElementById("print-root")?.innerText ?? "",
      );
    };
  });
}
const printed = (page: Page) =>
  page.evaluate(() => (window as any).__printed as string[]);
const row = (page: Page, name: string) =>
  page.locator(".order-summary").filter({ hasText: name }).first();
async function orders(page: Page) {
  await go(page, "Órdenes");
}
/** Back to the default controls (no saved row): blind close, 0 % staff limits. */
async function resetControls(baseURL: string | undefined) {
  const admin = fixtureAdmin(baseURL);
  try {
    await admin`delete from money_controls where tenant_id=${tenantId}`;
  } finally {
    await admin.end();
  }
}

test.beforeEach(async ({ baseURL }) => {
  await resetControls(baseURL);
});

test("FIT-8 / LD-2: a cashier applies a 10% discount approved with exactly one PIN; the order shows the discount and the new total", async ({
  page,
  baseURL,
}) => {
  const admin = fixtureAdmin(baseURL);
  try {
    const name = "Descuento " + tag();
    await login(page);
    await order(page, name, 2);
    await switchEmployee(page, "cashier", "123456");
    // The cashier's PIN is older than the step-up window (1800 s here).
    const s = await call(page, "/session");
    await admin`update sessions set authenticated_at=now()-interval '1 hour' where id=${s.id}`;
    await orders(page);
    await row(page, name)
      .getByRole("button", { name: "Descuento", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: /Descuento · Orden/ });
    await expect(dialog.getByRole("status")).toContainText(
      "Descuento: −$9.00 · Saldo nuevo: $81.00",
    );
    await dialog
      .getByRole("combobox", { name: "Motivo", exact: true })
      .selectOption({ label: "Adulto mayor (INAPAM)" });
    await expect(dialog).toContainText(
      "Este descuento supera tu límite. Un gerente debe autorizarlo.",
    );
    await dialog
      .getByLabel("Gerente que autoriza")
      .selectOption({ label: "Alex Demo" });
    await dialog.getByLabel("PIN del gerente").fill(OWNER_PASSWORD);
    const axe = await new AxeBuilder({ page })
      .include("dialog")
      .withTags(AXE_TAGS)
      .analyze();
    expect(axe.violations).toEqual([]);
    await expect(dialog.getByLabel("PIN del gerente")).toHaveCount(1);
    await dialog
      .getByRole("button", { name: "Aplicar descuento −$9.00", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    // Exactly one PIN: the manager's. The cashier is never asked to step up.
    await expect(
      page.getByRole("dialog", { name: "Confirma con tu PIN" }),
    ).toHaveCount(0);
    const card = row(page, name);
    await expect(card).toContainText("Descuento −$9.00");
    await expect(card).toContainText("$81.00");
    await card.getByRole("button", { name: "Detalle", exact: true }).click();
    const detail = page.getByRole("dialog", { name: /Orden #/ });
    const checkDiscount = detail
      .locator(".doc-discounts .row")
      .filter({ hasText: "Descuento en la cuenta" });
    await expect(checkDiscount).toContainText(
      "Descuento en la cuenta · Adulto mayor (INAPAM) 10 %",
    );
    await expect(checkDiscount).toContainText("−$9.00");
    await expect(detail).toContainText("Dani Demo · autorizó Alex Demo");
  } finally {
    await admin.end();
  }
});

test("manager comps one taco; the item split shows it as Cortesía and it is not selectable", async ({
  page,
}) => {
  const name = "Cortesía " + tag();
  await login(page);
  await openDrawer(page);
  await order(page, name, 3);
  await orders(page);
  await row(page, name)
    .getByRole("button", { name: "Descuento", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Descuento · Orden/ });
  await dialog.getByLabel("Un producto").check();
  await dialog.getByLabel("Cantidad").fill("1");
  await dialog
    .getByRole("button", { name: "Cortesía (100%)", exact: true })
    .click();
  await dialog
    .getByRole("combobox", { name: "Motivo", exact: true })
    .selectOption({ label: "Cortesía de la casa" });
  await dialog
    .getByRole("button", { name: "Aplicar descuento −$45.00", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(row(page, name)).toContainText("$90.00");
  await row(page, name)
    .getByRole("button", { name: /Abrir orden/ })
    .click();
  await expect(page.locator(".existing")).toContainText("Cortesía");
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const payment = page.getByRole("dialog");
  await payment
    .getByRole("button", { name: "Dividir por productos", exact: true })
    .click();
  const comped = payment.locator("label.option").filter({ hasText: "· 1" });
  await expect(comped).toContainText("Cortesía");
  await expect(comped.getByRole("checkbox")).toBeDisabled();
  await expect(
    payment
      .locator("label.option")
      .filter({ hasText: "· 2" })
      .getByRole("checkbox"),
  ).toBeEnabled();
});

test("manager removes a discount before payment and the balance goes back up", async ({
  page,
}) => {
  const name = "Quitar " + tag();
  await login(page);
  const o = await order(page, name, 2);
  await call(page, `/orders/${o.id}/discounts`, {
    operationId: uuid(),
    expectedVersion: o.version,
    scope: "order",
    kind: "percent",
    percentBps: 1000,
    reasonCode: "regular_customer",
  });
  await orders(page);
  await expect(row(page, name)).toContainText("$81.00");
  await row(page, name)
    .getByRole("button", { name: "Detalle", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: /Orden #/ });
  await detail
    .getByRole("button", { name: "Quitar descuento", exact: true })
    .click();
  const remove = page.getByRole("dialog", { name: "Quitar descuento" });
  await expect(remove).toContainText("El saldo de la cuenta aumentará $9.00.");
  await remove.getByLabel("Motivo para quitarlo").fill("Se aplicó por error");
  await remove
    .getByRole("button", { name: "Quitar y sumar $9.00", exact: true })
    .click();
  await expect(remove).toBeHidden();
  await expect(detail).toContainText(
    "Quitado por Alex Demo · Se aplicó por error",
  );
  await page.keyboard.press("Escape");
  await expect(row(page, name)).toContainText("$90.00");
});

test("DSC-R2: Quitar descuento recovers from stale_order: it reloads the check, keeps the reason and succeeds on the next confirm", async ({
  page,
}) => {
  const name = "Desfasada " + tag();
  await login(page);
  const o = await order(page, name, 2);
  const lineId = o.lines[0].id;
  // A 10 % discount on one of the two tacos (unit 0).
  await call(page, `/orders/${o.id}/discounts`, {
    operationId: uuid(),
    expectedVersion: o.version,
    scope: "line",
    lineId,
    quantity: 1,
    kind: "percent",
    percentBps: 1000,
    reasonCode: "regular_customer",
  });
  await orders(page);
  await row(page, name)
    .getByRole("button", { name: "Detalle", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: /Orden #/ });
  await detail
    .getByRole("button", { name: "Quitar descuento", exact: true })
    .click();
  const remove = page.getByRole("dialog", { name: "Quitar descuento" });
  await remove.getByLabel("Motivo para quitarlo").fill("Se aplicó por error");
  // Another device discounts the other taco: the check's version moves on,
  // and the first discount stays removable (no overlap).
  const current = await call(page, "/orders/" + o.id);
  await call(page, `/orders/${o.id}/discounts`, {
    operationId: uuid(),
    expectedVersion: current.version,
    scope: "line",
    lineId,
    quantity: 1,
    kind: "comp",
    reasonCode: "courtesy",
  });
  await remove
    .getByRole("button", { name: "Quitar y sumar $4.50", exact: true })
    .click();
  await expect(remove.getByRole("alert")).toHaveText(
    "La orden cambió en otro dispositivo. Revisa y confirma de nuevo.",
  );
  await expect(remove.getByLabel("Motivo para quitarlo")).toHaveValue(
    "Se aplicó por error",
  );
  // The screen behind it picked up the other device's comp.
  await expect(detail).toContainText("Cortesía");
  await remove
    .getByRole("button", { name: "Quitar y sumar $4.50", exact: true })
    .click();
  await expect(remove).toBeHidden();
  await expect(detail).toContainText(
    "Quitado por Alex Demo · Se aplicó por error",
  );
  const after = await call(page, "/orders/" + o.id);
  expect(after.total).toBe(4500);
  expect(after.discount).toBe(4500);
});

test("MON-4: refund one paid item by card; the terminal reference is required; the kitchen shows it as refunded and acknowledges it", async ({
  page,
}) => {
  const name = "Tarjeta " + tag();
  await login(page);
  await openDrawer(page);
  const o = await order(page, name, 1);
  await pay(page, o.id, 4500, { method: "external" });
  await orders(page);
  await row(page, name)
    .getByRole("button", { name: "Reembolsar", exact: true })
    .click();
  const refund = page.getByRole("dialog", { name: /Reembolso · Orden/ });
  await expect(
    refund.getByRole("button", { name: "Por productos", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await refund.getByLabel(/Taco de hongos · \$45\.00 c\/u/).fill("1");
  await expect(refund).toContainText("Reembolso en terminal externa: $45.00");
  await expect(refund).toContainText(
    "Terminal · pago original Ref. T-482913 · $45.00",
  );
  await expect(refund).toContainText(
    "Cocina recibirá el aviso de no preparar 1 productos.",
  );
  await refund
    .getByLabel("Motivo del reembolso")
    .selectOption({ label: "El cliente canceló" });
  const reference = refund.getByLabel(
    "Referencia del reembolso en la terminal",
  );
  await expect(reference).toHaveAttribute("required", "");
  // The browser refuses the submit while the terminal reference is missing.
  await refund
    .getByRole("button", { name: "Reembolsar $45.00", exact: true })
    .click();
  await expect(refund).toBeVisible();
  expect(
    await reference.evaluate((e: HTMLInputElement) => e.validity.valid),
  ).toBe(false);
  await reference.fill("R-778812");
  await refund
    .getByLabel("Confirmo que la terminal aprobó el reembolso de $45.00")
    .check();
  await refund
    .getByRole("button", { name: "Reembolsar $45.00", exact: true })
    .click();
  await expect(refund).toContainText("Reembolso registrado: $45.00");
  await refund.getByRole("button", { name: "Listo", exact: true }).click();
  const after = await call(page, "/orders/" + o.id);
  expect(after.refundBatches[0].rows[0]).toMatchObject({
    method: "external",
    reference: "R-778812",
    amount: 4500,
  });
  await switchEmployee(page, "kitchen", "654321");
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: name });
  const alert = ticket.locator(".void-alert");
  await expect(alert).toContainText("Reembolsado · no preparar");
  await expect(alert).toContainText("1 × Taco de hongos");
  await ticket
    .getByRole("button", { name: "Enterado de la cancelación" })
    .click();
  await expect(alert).toBeHidden();
});

test("MON-4: a cash item refund with restock prints the refund slip and lowers the drawer's expected cash", async ({
  page,
}) => {
  const name = "Efectivo " + tag();
  await login(page);
  await openDrawer(page);
  const o = await order(page, name, 2);
  await pay(page, o.id, 9000);
  const before = (await call(page, "/cash")).expected;
  await orders(page);
  await row(page, name)
    .getByRole("button", { name: "Reembolsar", exact: true })
    .click();
  const refund = page.getByRole("dialog", { name: /Reembolso · Orden/ });
  await refund.getByLabel(/Taco de hongos · \$45\.00 c\/u/).fill("1");
  await refund.getByLabel("Regresar ingredientes a inventario").check();
  await expect(refund).toContainText(
    "Entrega $45.00 en efectivo de la caja de este dispositivo.",
  );
  await refund
    .getByLabel("Motivo del reembolso")
    .selectOption({ label: "Producto con defecto o queja" });
  await refund.getByLabel("Explicación").fill("frío");
  await refund
    .getByRole("button", { name: "Reembolsar $45.00", exact: true })
    .click();
  await expect(refund).toContainText("Reembolso registrado: $45.00");
  await stubPrint(page);
  await refund
    .getByRole("button", { name: "Imprimir comprobante", exact: true })
    .click();
  await expect
    .poll(async () => (await printed(page)).join("\n"))
    .toContain("COMPROBANTE DE REEMBOLSO");
  const slip = (await printed(page)).join("\n");
  expect(slip).toContain("Total reembolsado");
  expect(slip).toContain("Producto con defecto o queja");
  expect(slip).toContain("Registró Alex Demo · autorizó Alex Demo");
  expect(slip).toContain("Este comprobante no es una factura (CFDI).");
  await refund.getByRole("button", { name: "Listo", exact: true }).click();
  expect((await call(page, "/cash")).expected).toBe(before - 4500);
  const after = await call(page, "/orders/" + o.id);
  expect(after.refundBatches[0].lines[0].restocked).toBe(true);
});

test("DSC-R1: leaving the refund result with Escape or the X button refreshes Órdenes and Detalle de orden", async ({
  page,
}) => {
  const name = "Escape " + tag();
  await login(page);
  await openDrawer(page);
  const o = await order(page, name, 2);
  await pay(page, o.id, 9000);
  await orders(page);
  const card = row(page, name);
  await expect(card).toContainText("Cobrado");
  await card.getByRole("button", { name: "Reembolsar", exact: true }).click();
  const refund = page.getByRole("dialog", { name: /Reembolso · Orden/ });
  await refund.getByLabel(/Taco de hongos · \$45\.00 c\/u/).fill("1");
  await refund
    .getByLabel("Motivo del reembolso")
    .selectOption({ label: "El cliente canceló" });
  await refund
    .getByRole("button", { name: "Reembolsar $45.00", exact: true })
    .click();
  await expect(refund).toContainText("Reembolso registrado: $45.00");
  await page.keyboard.press("Escape");
  await expect(refund).toBeHidden();
  // The card shows the refund without a manual "Actualizar".
  await expect(card).toContainText("Reembolsado");
  // Detalle de orden: the X button refreshes it too.
  await card.getByRole("button", { name: "Detalle", exact: true }).click();
  const detail = page.getByRole("dialog", { name: /Orden #/ });
  await expect(detail.locator("section.order-adjustments")).toHaveCount(1);
  await detail.getByRole("button", { name: "Reembolsar", exact: true }).click();
  const again = page.getByRole("dialog", { name: /Reembolso · Orden/ });
  await again.getByLabel(/Taco de hongos · \$45\.00 c\/u/).fill("1");
  await again
    .getByLabel("Motivo del reembolso")
    .selectOption({ label: "El cliente canceló" });
  await again
    .getByRole("button", { name: "Reembolsar $45.00", exact: true })
    .click();
  await expect(again).toContainText("Reembolso registrado: $45.00");
  await again.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(again).toBeHidden();
  const refunds = detail
    .locator("section.order-adjustments")
    .filter({ hasText: "Reembolsos" });
  await expect(refunds.locator("li")).toHaveCount(2);
  await expect(
    detail.getByRole("button", { name: "Reembolsar", exact: true }),
  ).toHaveCount(0);
});

test("MON-9/FIT-10: blind close — the cashier never sees expected cash; the manager sees the difference in history and reviews it", async ({
  page,
}) => {
  const name = "Ciego " + tag();
  const note = "Faltaron monedas · " + tag();
  await login(page);
  await openDrawer(page, 50000);
  const o = await order(page, name, 1);
  await pay(page, o.id, 4500);
  // The owner lets cashiers close the drawer (blind by default).
  const controls = await call(page, "/discounts/controls");
  await call(page, "/discounts/controls", {
    operationId: uuid(),
    expectedVersion: controls.version,
    limits: controls.limits,
    blindClose: true,
    expectedRoles: ["manager"],
    closeRoles: ["cashier"],
  });
  await switchEmployee(page, "cashier", "123456");
  await go(page, "Caja");
  await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Efectivo esperado", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("note")).toContainText(
    "Corte ciego: el efectivo esperado se muestra a un responsable después del conteo.",
  );
  expect((await call(page, "/cash")).expected).toBeNull();
  await page.getByRole("button", { name: "Cerrar caja", exact: true }).click();
  const close = page.getByRole("dialog", { name: "Cerrar caja" });
  await expect(close).toContainText(
    "El efectivo esperado no se muestra hasta guardar el conteo.",
  );
  await close.getByLabel("Efectivo contado").fill("540");
  const axe = await new AxeBuilder({ page })
    .include("dialog")
    .withTags(AXE_TAGS)
    .analyze();
  expect(axe.violations).toEqual([]);
  await close.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(close).toContainText(
    "¿Cerrar la caja con $540.00 contados? Después no se puede cambiar.",
  );
  await close
    .getByRole("button", { name: "Guardar conteo y cerrar", exact: true })
    .click();
  const result = page.getByRole("dialog", { name: "Corte registrado" });
  await expect(result).toContainText("Un responsable revisará el resultado.");
  await expect(result).not.toContainText("$545.00");
  await result.getByRole("button", { name: "Listo", exact: true }).click();
  await expect(page.getByText("Caja cerrada", { exact: true })).toBeVisible();

  await switchEmployee(page, "owner", OWNER_PASSWORD);
  await go(page, "Caja");
  await page.getByText("Historial de cajas", { exact: true }).click();
  const history = page
    .locator("article.panel")
    .filter({ hasText: "Cerró Dani Demo" })
    .filter({ hasText: "Diferencia por revisar" })
    .first();
  await expect(history).toContainText("Corte ciego");
  await expect(history).toContainText("Esperado al cerrar: $545.00");
  await history
    .getByRole("button", { name: "Revisar diferencia", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Revisar diferencia de caja",
  });
  await expect(review).toContainText("diferencia -$5.00");
  await review.getByLabel("Explicación del responsable").fill(note);
  await review
    .getByRole("button", { name: "Guardar revisión", exact: true })
    .click();
  await expect(review).toBeHidden();
  await page.getByText("Historial de cajas", { exact: true }).click();
  await expect(
    page.locator("article.panel").filter({ hasText: note }),
  ).toContainText(`Revisó Alex Demo · ${note}`);
});

test("FIT-10: a card payment with a tip needs no cash received; the drawer's terminal section shows the sale and the tip", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page, 50000);
  await go(page, "Vender");
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Terminal externa", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Efectivo recibido", { exact: true }),
  ).toHaveCount(0);
  await dialog.getByLabel("Propina", { exact: true }).fill("5");
  await dialog.getByLabel("Referencia de aprobación").fill("9911");
  await dialog.getByLabel("Confirmo que la terminal aprobó este pago").check();
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Ref. 9911");
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();
  await go(page, "Caja");
  const terminal = page
    .locator(".drawer-card")
    .filter({ hasText: "Terminal externa" });
  await expect(terminal).toContainText("Cobros con terminal");
  await expect(terminal).toContainText("$45.00");
  await expect(terminal).toContainText("Propinas con terminal");
  await expect(terminal).toContainText("$5.00");
  await expect(terminal).toContainText("$50.00");
  const cash = page
    .locator(".drawer-card")
    .filter({ hasText: "Efectivo esperado" });
  await expect(cash).toContainText("$500.00");
});

test("controls: the owner sets the cashier limit to 10%; a 5% cashier discount needs no approval", async ({
  page,
}) => {
  const name = "Límite " + tag();
  await login(page);
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  const panel = page.locator("section.money-controls");
  await expect(panel).toContainText("Descuentos y corte de caja");
  await panel.getByLabel("Cajero · Hasta (%)").fill("10");
  await panel
    .getByLabel("Cajero · Y hasta (importe por descuento)")
    .fill("100");
  const axe = await new AxeBuilder({ page })
    .include("section.money-controls")
    .withTags(AXE_TAGS)
    .analyze();
  expect(axe.violations).toEqual([]);
  await panel
    .getByRole("button", { name: "Guardar controles", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("Controles guardados");
  await order(page, name, 2);
  await switchEmployee(page, "cashier", "123456");
  await orders(page);
  await row(page, name)
    .getByRole("button", { name: "Descuento", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Descuento · Orden/ });
  await dialog.getByRole("button", { name: "5 %", exact: true }).click();
  await dialog
    .getByRole("combobox", { name: "Motivo", exact: true })
    .selectOption({ label: "Cliente frecuente" });
  await expect(dialog.getByLabel("PIN del gerente")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Aplicar descuento −$4.50", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(row(page, name)).toContainText("Descuento −$4.50");
});

test("DSC-R7: controls accept 0.00 %, and after another device saves first the form reloads and the next save succeeds", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  const panel = page.locator("section.money-controls");
  const save = panel.getByRole("button", {
    name: "Guardar controles",
    exact: true,
  });
  await panel.getByLabel("Mesero · Hasta (%)").fill("0.00");
  await save.click();
  await expect(panel.getByRole("status")).toContainText("Controles guardados");
  // Another device saves a 7 % cashier limit with the current version.
  const view = await call(page, "/discounts/controls");
  await call(page, "/discounts/controls", {
    operationId: uuid(),
    expectedVersion: view.version,
    limits: {
      cashier: { maxPercentBps: 700, maxAmount: 0 },
      server: { maxPercentBps: 0, maxAmount: 0 },
    },
    blindClose: view.blindClose,
    expectedRoles: view.expectedRoles,
    closeRoles: view.closeRoles,
  });
  await panel.getByLabel("Cajero · Hasta (%)").fill("12");
  await save.click();
  await expect(panel.getByRole("alert")).toHaveText(
    "Otro dispositivo cambió estos controles. Ya ves los valores actuales; revisa y guarda de nuevo.",
  );
  await expect(panel.getByLabel("Cajero · Hasta (%)")).toHaveValue("7");
  await panel.getByLabel("Cajero · Hasta (%)").fill("12");
  await save.click();
  await expect(panel.getByRole("status")).toContainText("Controles guardados");
  expect(
    (await call(page, "/discounts/controls")).limits.cashier.maxPercentBps,
  ).toBe(1200);
});

test("discount and refund actions are disabled offline", async ({
  page,
  context,
}) => {
  const name = "Sin red " + tag();
  await login(page);
  await openDrawer(page);
  const open = await order(page, name, 2);
  await pay(page, open.id, 4500);
  await orders(page);
  const card = row(page, name);
  await expect(
    card.getByRole("button", { name: "Descuento", exact: true }),
  ).toBeEnabled();
  await expect(
    card.getByRole("button", { name: "Reembolsar", exact: true }),
  ).toBeEnabled();
  await context.setOffline(true);
  await expect(
    page.locator(".top-actions").getByRole("button", { name: /^Sin conexión/ }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Descuento", exact: true }),
  ).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "Reembolsar", exact: true }),
  ).toBeDisabled();
  // DSC-R5: the reason is visible (touch tablets show no tooltip) and is the
  // buttons' accessible description.
  await expect(
    card.getByText("Los descuentos requieren conexión."),
  ).toBeVisible();
  await expect(
    card.getByText("Los reembolsos requieren conexión."),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Descuento", exact: true }),
  ).toHaveAccessibleDescription("Los descuentos requieren conexión.");
  await expect(
    card.getByRole("button", { name: "Reembolsar", exact: true }),
  ).toHaveAccessibleDescription("Los reembolsos requieren conexión.");
  // Detalle de orden (opened online; it reads the order from the server)
  // keeps Descuento visible, disabled, with its reason once offline.
  await context.setOffline(false);
  await expect(
    card.getByRole("button", { name: "Descuento", exact: true }),
  ).toBeEnabled();
  await card.getByRole("button", { name: "Detalle", exact: true }).click();
  const detail = page.getByRole("dialog", { name: /Orden #/ });
  // The action row's Descuento (the per-line links share the name and hide
  // offline).
  const discountAction = detail
    .getByRole("button", { name: "Descuento", exact: true })
    .last();
  await expect(discountAction).toBeEnabled();
  await context.setOffline(true);
  await expect(
    detail.getByRole("button", { name: "Descuento", exact: true }),
  ).toHaveCount(1);
  await expect(discountAction).toBeDisabled();
  await expect(discountAction).toHaveAccessibleDescription(
    "Los descuentos requieren conexión.",
  );
  await expect(
    detail.getByRole("button", { name: "Reembolsar", exact: true }),
  ).toHaveAccessibleDescription("Los reembolsos requieren conexión.");
  await page.keyboard.press("Escape");
  await context.setOffline(false);
});

test("Axe: the refund dialog, the drawer close dialog and the controls panel have no violations", async ({
  page,
}) => {
  const name = "Axe " + tag();
  await login(page);
  await openDrawer(page);
  const o = await order(page, name, 1);
  await pay(page, o.id, 4500, { method: "external" });
  await orders(page);
  await row(page, name)
    .getByRole("button", { name: "Reembolsar", exact: true })
    .click();
  const refund = page.getByRole("dialog", { name: /Reembolso · Orden/ });
  await refund.getByLabel(/Taco de hongos/).fill("1");
  for (const target of ["dialog"]) {
    const axe = await new AxeBuilder({ page })
      .include(target)
      .withTags(AXE_TAGS)
      .analyze();
    expect(axe.violations).toEqual([]);
  }
  await page.keyboard.press("Escape");
  await go(page, "Caja");
  await page.getByRole("button", { name: "Cerrar caja", exact: true }).click();
  await page.getByLabel("Efectivo contado").fill("500");
  const close = await new AxeBuilder({ page })
    .include("dialog")
    .withTags(AXE_TAGS)
    .analyze();
  expect(close.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  await expect(page.locator("section.money-controls")).toBeVisible();
  const settings = await new AxeBuilder({ page })
    .include("section.money-controls")
    .withTags(AXE_TAGS)
    .analyze();
  expect(settings.violations).toEqual([]);
});

test("amount refunds need a paid check: with a balance due the dialog hides Por importe and explains why; after full payment it appears", async ({
  page,
}) => {
  const name = "Saldo " + tag();
  await login(page);
  await openDrawer(page);
  const o = await order(page, name, 2);
  await pay(page, o.id, 4500, { items: [`${o.lines[0].id}:0`] });
  await orders(page);
  await row(page, name)
    .getByRole("button", { name: "Reembolsar", exact: true })
    .click();
  const refund = page.getByRole("dialog", { name: /Reembolso · Orden/ });
  await expect(
    refund.getByRole("button", { name: "Por importe", exact: true }),
  ).toHaveCount(0);
  await expect(refund).toContainText(
    "El reembolso por importe se habilita cuando la cuenta está pagada. Por ahora solo puedes reembolsar productos ya cobrados.",
  );
  await refund.getByLabel(/Taco de hongos/).fill("1");
  await refund
    .getByLabel("Motivo del reembolso")
    .selectOption({ label: "Producto equivocado" });
  await refund
    .getByRole("button", { name: "Reembolsar $45.00", exact: true })
    .click();
  await refund.getByRole("button", { name: "Listo", exact: true }).click();
  await pay(page, o.id, 4500);
  await page.getByRole("button", { name: "Actualizar" }).click();
  await row(page, name)
    .getByRole("button", { name: "Reembolsar", exact: true })
    .click();
  const again = page.getByRole("dialog", { name: /Reembolso · Orden/ });
  await expect(
    again.getByRole("button", { name: "Por importe", exact: true }),
  ).toBeVisible();
});

test("a whole-check comp on a takeaway check warns, closes the check and offers no Quitar descuento", async ({
  page,
}) => {
  const name = "Comp " + tag();
  await login(page);
  await openDrawer(page);
  await go(page, "Vender");
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await page.getByLabel("Nombre para llamar").fill(name);
  // Unsent lines are sent first (only sent items are discounted).
  await page.getByRole("button", { name: "Descuento", exact: true }).click();
  const first = page.getByRole("dialog", { name: "Enviar productos primero" });
  await first
    .getByRole("button", { name: "Enviar y continuar", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Descuento · Orden/ });
  await dialog
    .getByRole("button", { name: "Cortesía (100%)", exact: true })
    .click();
  await expect(dialog.getByRole("note")).toContainText(
    "La cuenta se cerrará y la cortesía ya no se podrá quitar.",
  );
  await dialog
    .getByRole("combobox", { name: "Motivo", exact: true })
    .selectOption({ label: "Queja o error del servicio" });
  await dialog
    .getByRole("button", { name: "Aplicar descuento −$45.00", exact: true })
    .click();
  // The check closed: its receipt opens as after a payment.
  await expect(page.locator(".receipt")).toContainText("Cortesía");
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();
  await go(page, "Órdenes");
  const card = row(page, name);
  await expect(card).toContainText("Cerrada");
  await card.getByRole("button", { name: "Detalle", exact: true }).click();
  const detail = page.getByRole("dialog", { name: /Orden #/ });
  await expect(detail).toContainText("Cortesía");
  await expect(
    detail.getByRole("button", { name: "Quitar descuento" }),
  ).toHaveCount(0);
});

test("the refund slip prints in Spanish while the UI is in English; the drawer close result stays in English", async ({
  page,
}) => {
  const name = "Idioma " + tag();
  await login(page);
  await openDrawer(page);
  const o = await order(page, name, 1);
  await pay(page, o.id, 4500);
  await page.getByRole("button", { name: "ES", exact: true }).click();
  await go(page, "Orders", "Operations");
  await row(page, name)
    .getByRole("button", { name: "Refund", exact: true })
    .click();
  const refund = page.getByRole("dialog", { name: /Refund · Order/ });
  await refund.getByRole("button", { name: "By amount", exact: true }).click();
  await refund.getByLabel("Amount", { exact: true }).fill("10");
  await refund
    .getByLabel("Refund reason")
    .selectOption({ label: "Charging error" });
  // en-US prints the peso as MX$ (Intl); the slip stays es-MX.
  await refund
    .getByRole("button", { name: "Refund MX$10.00", exact: true })
    .click();
  await expect(refund).toContainText("Refund recorded: MX$10.00");
  await stubPrint(page);
  await refund
    .getByRole("button", { name: "Print refund slip", exact: true })
    .click();
  await expect
    .poll(async () => (await printed(page)).join("\n"))
    .toContain("COMPROBANTE DE REEMBOLSO");
  const slip = (await printed(page)).join("\n");
  expect(slip).toContain("Total reembolsado");
  expect(slip).toContain("Cobro equivocado");
  expect(slip).not.toContain("REFUND SLIP");
  await refund.getByRole("button", { name: "Done", exact: true }).click();
  await go(page, "Cash drawer", "Operations");
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await page.getByLabel("Counted cash").fill("535");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Save count and close", exact: true })
    .click();
  const result = page.getByRole("dialog", { name: "Count recorded" });
  await expect(result).toContainText("Expected cash");
  await expect(result).toContainText("Difference");
  await result.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "EN", exact: true }).click();
});
