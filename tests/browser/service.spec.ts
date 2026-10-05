import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
}

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
const uuid = () => crypto.randomUUID();
async function openDrawer(page: Page) {
  const current = await call(page, "/cash");
  if (!current || current.closed_at)
    await call(page, "/cash/open", { operationId: uuid(), opening: 50000 });
}
async function product(page: Page, name: string) {
  const catalog = await call<any[]>(page, "/catalog");
  return catalog.find((p) => p.name.es === name);
}
/** 86es (or brings back) a seeded product, as another terminal would. */
async function setSeededAvailable(
  page: Page,
  name: string,
  available: boolean,
) {
  const current = await product(page, name);
  await call(page, "/catalog/save", {
    operationId: uuid(),
    id: current.id,
    name: current.name,
    category: current.category,
    price: current.price,
    available,
    station: current.station,
    expectedVersion: current.version,
    cost: current.cost,
    recipe: current.recipe ?? [],
  });
}
/**
 * The Vender tile of one catalog product, matched by its exact name. Other
 * specs add products to the same demo tenant, so a substring or regex match
 * on "Agua de jamaica" could also hit a product such as "Agua de jamaica 2sbzf".
 */
const productTile = (page: Page, name: string) =>
  page
    .locator("button.product")
    .filter({ has: page.getByText(name, { exact: true }) });
async function apiOrder(
  page: Page,
  name: string,
  productName = "Taco de hongos",
  extra: object = {},
) {
  const p = await product(page, productName);
  return call(page, "/orders", {
    operationId: uuid(),
    lines: [
      { id: uuid(), productId: p.id, quantity: 1, options: [], note: "" },
    ],
    mode: "takeaway",
    tableId: null,
    name,
    note: "",
    channel: "pos",
    ...extra,
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
const letters = (n: number) =>
  Array.from(String(n), (d) => "abcdefghij"[Number(d)]).join("");
const tag = () => "svc" + letters(Date.now() % 1e8);
/** Pays what is left on a check and releases it, so its table is free again. */
async function freeCheck(page: Page, orderId: string) {
  await openDrawer(page);
  const o = await call(page, "/orders/" + orderId);
  if (o.total > o.paid)
    await call(page, `/orders/${o.id}/payments`, {
      operationId: uuid(),
      amount: o.total - o.paid,
      tip: 0,
      received: o.total - o.paid,
      method: "cash",
    });
  if ((await call(page, "/orders/" + orderId)).checkState !== "closed")
    await call(page, `/service/orders/${orderId}/close`, {
      operationId: uuid(),
    });
}
/** Releases leftover paid checks and returns the tables with no check. */
async function freeTables(page: Page) {
  for (const t of await call<any[]>(page, "/service/tables"))
    for (const c of t.checks)
      if (c.checkState === "paid")
        await call(page, `/service/orders/${c.id}/close`, {
          operationId: uuid(),
        });
  return (await call<any[]>(page, "/service/tables")).filter(
    (t) => !t.checks.length,
  );
}

test("dine-in table accepts dessert after delivery, stays occupied until paid and released", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  const tables = await call<any[]>(page, "/service/tables");
  // Release leftover paid checks so a fixture table is free.
  for (const t of tables)
    for (const c of t.checks)
      if (c.checkState === "paid")
        await call(page, `/service/orders/${c.id}/close`, {
          operationId: uuid(),
        });
  const free = (await call<any[]>(page, "/service/tables")).find(
    (t) => !t.checks.length,
  );
  expect(free, "a fixture table must be free").toBeTruthy();
  const name = "Mesa " + tag();
  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  const card = page.getByRole("article", { name: free.name, exact: true });
  await expect(card).toContainText("Disponible");
  await card.getByRole("button", { name: "Nueva cuenta", exact: true }).click();
  await productTile(page, "Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Enviado a cocina");

  await page
    .getByRole("button", { name: "Cocina", exact: true })
    .first()
    .click();
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: name });
  await ticket.getByRole("button", { name: "Confirmar recepción" }).click();
  await ticket.getByRole("button", { name: "Marcar listo" }).click();
  await ticket.getByRole("button", { name: "Marcar entregado" }).click();
  await expect(ticket).toHaveCount(0);

  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  await expect(card).toContainText("Ocupada");
  await card
    .getByRole("button", { name: new RegExp(`${name} · .* por cobrar`) })
    .click();
  await expect(page.locator(".existing")).toContainText("Taco de hongos");
  await productTile(page, "Flan de vainilla").click();
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Flan de vainilla");
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Cobrado");
  await page.getByRole("button", { name: "Liberar mesa", exact: true }).click();
  await expect(page.locator(".receipt")).toHaveCount(0);

  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  await expect(card).toContainText("Disponible");
  await expect(card).not.toContainText(name);
  const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axe.violations).toEqual([]);
});

test("kitchen sees order, line and round notes with modifiers; receipt shows modifiers", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  const name = "Notas " + tag();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await productTile(page, "Taco de asada").click();
  await page
    .getByRole("dialog")
    .getByRole("radio", { name: /Salsa verde/ })
    .check();
  await page
    .getByRole("button", { name: "Agregar a la orden", exact: true })
    .click();
  await page.getByRole("button", { name: "Nota para Taco de asada" }).click();
  await page.getByRole("button", { name: "Sin cebolla", exact: true }).click();
  await page.getByRole("button", { name: "Listo", exact: true }).click();
  await expect(page.locator(".order-line").first()).toContainText(
    "Sin cebolla",
  );
  await page.getByLabel("Nota de la orden (cocina)").fill("ALERGIA: cacahuate");
  await page.getByLabel("Nombre para llamar").fill(name);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("ALERGIA: cacahuate");
  await expect(page.getByLabel("Nota para esta ronda")).toHaveValue("");

  await page
    .getByRole("button", { name: "Cocina", exact: true })
    .first()
    .click();
  const first = page.locator(".kitchen-ticket").filter({ hasText: name });
  await expect(first).toContainText("Salsa verde");
  await expect(first).toContainText("Sin cebolla");
  await expect(first).toContainText("ALERGIA: cacahuate");
  await expect(first.locator(".ticket-note.allergy")).toContainText("Alergia");

  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await productTile(page, "Flan de vainilla").click();
  await page.getByLabel("Nota para esta ronda").fill("Postres al final");
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Flan de vainilla");
  await page
    .getByRole("button", { name: "Cocina", exact: true })
    .first()
    .click();
  const second = page
    .locator(".kitchen-ticket")
    .filter({ hasText: name })
    .filter({ hasText: "Ronda 2" });
  await expect(second).toContainText("Postres al final");

  // LD-1: the pre-bill printed from order detail carries the order and round notes.
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await page
    .locator(".order-summary")
    .filter({ hasText: name })
    .getByRole("button", { name: "Detalle", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: /^Orden #\d+$/ });
  await stubPrint(page);
  await detail.getByRole("button", { name: "Imprimir cuenta" }).click();
  await expect
    .poll(async () => (await printed(page)).join("\n"))
    .toContain("Cuenta · no es comprobante de pago");
  const bill = (await printed(page))[0];
  expect(bill).toContain("ALERGIA: cacahuate");
  expect(bill).toContain("Postres al final");
  expect(bill).toContain("Sin cebolla");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Salsa verde");
  await expect(page.locator(".receipt")).toContainText("Sin cebolla");
  await expect(page.locator(".receipt")).toContainText("ALERGIA: cacahuate");
  await expect(page.locator(".receipt")).toContainText("Postres al final");
  await stubPrint(page);
  await page
    .getByRole("button", { name: "Imprimir recibo", exact: true })
    .click();
  await expect
    .poll(async () => (await printed(page)).join("\n"))
    .toContain("Sin cebolla");
  const receipt = (await printed(page))[0];
  expect(receipt).toContain("Salsa verde");
  expect(receipt).toContain("ALERGIA: cacahuate");
  expect(receipt).toContain("Postres al final");
  expect(receipt).not.toContain("Green Monkey");
});

test("terminal fields reset between sales and change follows a partial cash amount", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await productTile(page, "Taco de hongos").click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Terminal externa", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Efectivo recibido", { exact: true }),
  ).toHaveCount(0);
  await dialog.getByLabel("Referencia de aprobación").fill("4821");
  await dialog.getByLabel("Confirmo que la terminal aprobó este pago").check();
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Ref. 4821");
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();

  await productTile(page, "Taco de hongos").click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const cash = dialog.getByRole("button", { name: "Efectivo", exact: true });
  await expect(cash).toHaveAttribute("aria-pressed", "true");
  await dialog
    .getByRole("button", { name: "Terminal externa", exact: true })
    .click();
  await expect(dialog.getByLabel("Referencia de aprobación")).toHaveValue("");
  await expect(
    dialog.getByLabel("Confirmo que la terminal aprobó este pago"),
  ).not.toBeChecked();
  await cash.click();
  await dialog
    .getByRole("textbox", { name: "Importe", exact: true })
    .fill("30");
  await expect(
    dialog.getByRole("textbox", { name: "Efectivo recibido", exact: true }),
  ).toHaveValue("30.00");
  const change = dialog.locator(".row", { hasText: "Cambio" });
  await expect(change).toContainText("$0.00");
  await dialog.getByRole("button", { name: "$50.00", exact: true }).click();
  await expect(change).toContainText("$20.00");
  await page.keyboard.press("Escape");

  const bowl = productTile(page, "Bowl de la casa");
  for (let i = 0; i < 8; i++) await bowl.click();
  await expect(
    page.locator(".order-line").filter({ hasText: "Bowl de la casa" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Importe", exact: true })
    .fill("1,000");
  await expect(dialog.locator(".field-error")).toHaveCount(0);
  await expect(
    dialog.getByRole("textbox", { name: "Efectivo recibido", exact: true }),
  ).toHaveValue("1000.00");
  await expect(
    dialog.getByRole("button", { name: "Confirmar cobro", exact: true }),
  ).toBeEnabled();
  const audit = await new AxeBuilder({ page })
    .include("dialog")
    .withTags(AXE_TAGS)
    .analyze();
  expect(audit.violations).toEqual([]);
});

test("pay is blocked until a drawer is open and nothing reaches the kitchen", async ({
  page,
}) => {
  await login(page);
  const name = "Sin caja " + tag();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await productTile(page, "Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Abre caja en este dispositivo antes de cobrar."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Ir a Caja" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Confirmar cobro", exact: true }),
  ).toBeDisabled();
  // SVC-R8: "Enviar y dividir" also sends to the kitchen, so it waits too.
  await expect(
    dialog.getByRole("button", {
      name: "Enviar ronda y dividir por productos",
      exact: true,
    }),
  ).toBeDisabled();
  const feed = await call(page, "/service/kitchen?station=all");
  expect(feed.rounds.some((r: any) => r.callName === name)).toBe(false);
  await dialog.getByRole("button", { name: "Ir a Caja" }).click();
  await expect(
    page.getByRole("button", { name: "Abrir caja", exact: true }),
  ).toBeVisible();
});

test("sold-out item is flagged in the cart and removable", async ({ page }) => {
  await login(page);
  const guacamole = await product(page, "Guacamole");
  let changed = false;
  try {
    await page.getByRole("button", { name: "Vender", exact: true }).click();
    await productTile(page, "Guacamole").click();
    await productTile(page, "Limonada natural").click();
    const save = (available: boolean, expectedVersion: number) =>
      call(page, "/catalog/save", {
        operationId: uuid(),
        id: guacamole.id,
        name: guacamole.name,
        category: guacamole.category,
        price: guacamole.price,
        available,
        station: guacamole.station,
        expectedVersion,
        cost: guacamole.cost,
        recipe: guacamole.recipe ?? [],
      });
    const saved = await save(false, guacamole.version);
    changed = true;
    guacamole.version = saved.version;
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    await page.getByRole("button", { name: "Vender", exact: true }).click();
    const line = page.locator(".order-line").filter({ hasText: "Guacamole" });
    await expect(line).toContainText("No disponible. Quítalo para continuar.");
    await expect(
      page.locator(".order-line").filter({ hasText: "Limonada natural" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Quita los productos no disponibles para enviar o cobrar.",
      ),
    ).toBeVisible();
    const send = page.getByRole("button", {
      name: "Enviar a cocina",
      exact: true,
    });
    await expect(send).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Cobrar", exact: true }),
    ).toBeDisabled();
    await line.getByRole("button", { name: "Quitar", exact: true }).click();
    await expect(line).toHaveCount(0);
    await expect(send).toBeEnabled();
  } finally {
    if (changed) {
      const current = await product(page, "Guacamole");
      await call(page, "/catalog/save", {
        operationId: uuid(),
        id: current.id,
        name: current.name,
        category: current.category,
        price: current.price,
        available: true,
        station: current.station,
        expectedVersion: current.version,
        cost: current.cost,
        recipe: current.recipe ?? [],
      });
    }
  }
});

test("stale order refreshes in place and keeps unsent items", async ({
  page,
}) => {
  await login(page);
  const name = "Ronda " + tag();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await productTile(page, "Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Taco de hongos");
  const list = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  const order = await call(page, "/orders/" + list.items[0].id);
  const water = await product(page, "Agua de jamaica");
  await call(page, `/orders/${order.id}/rounds`, {
    operationId: uuid(),
    expectedVersion: order.version,
    lines: [
      { id: uuid(), productId: water.id, quantity: 1, options: [], note: "" },
    ],
    mode: order.mode,
  });
  await productTile(page, "Limonada natural").click();
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(
    page.getByText(
      "La orden cambió en otro dispositivo. Ya la actualizamos y tus productos sin enviar siguen aquí. Revisa y envía de nuevo.",
    ),
  ).toBeVisible();
  await expect(page.locator(".existing")).toContainText("Agua de jamaica");
  await expect(
    page.locator(".order-line").filter({ hasText: "Limonada natural" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Limonada natural");
  const after = await call(page, "/orders/" + order.id);
  expect(after.rounds.map((r: any) => r.number)).toContain(3);

  const draftB = "Borrador B " + tag();
  const draftA = "Borrador A " + tag();
  await page.getByRole("button", { name: "Nueva orden", exact: true }).click();
  await productTile(page, "Café de olla").click();
  await page.getByLabel("Nombre para llamar").fill(draftB);
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await productTile(page, "Ensalada verde").click();
  await page.getByLabel("Nombre para llamar").fill(draftA);
  await page.getByRole("button", { name: "Borradores", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: new RegExp(draftB) })
    .click();
  await expect(
    page.getByText("Guardamos la orden que estabas capturando en Borradores."),
  ).toBeVisible();
  await expect(page.getByLabel("Nombre para llamar")).toHaveValue(draftB);
  await page.getByRole("button", { name: "Borradores", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: new RegExp(draftA) }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // SVC-R5: a round parked from an open check goes back onto that check.
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await page
    .locator(".order-summary")
    .filter({ hasText: name })
    .getByRole("button", { name: "Abrir orden", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText(`#${order.number}`);
  await productTile(page, "Café de olla").click();
  await page.getByLabel("Nota para esta ronda").fill("Bien caliente");
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await expect(page.locator(".existing")).toHaveCount(0);
  await page.getByRole("button", { name: "Borradores", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", {
      name: new RegExp(`^#${order.number} · ronda sin enviar · ${name}`),
    })
    .click();
  await expect(page.locator(".existing")).toContainText(`#${order.number}`);
  await expect(
    page.locator(".order-line").filter({ hasText: "Café de olla" }),
  ).toBeVisible();
  await expect(page.getByLabel("Nota para esta ronda")).toHaveValue(
    "Bien caliente",
  );
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Café de olla");
  const restored = await call(page, "/orders/" + order.id);
  expect(restored.rounds.map((r: any) => r.number)).toContain(4);
  expect(
    restored.lines.filter((l: any) => l.name.es === "Café de olla"),
  ).toHaveLength(1);
  expect(restored.rounds.some((r: any) => r.note === "Bien caliente")).toBe(
    true,
  );
  const same = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  expect(same.items).toHaveLength(1);
});

test("a send whose response was lost recovers after the cart changes", async ({
  page,
}) => {
  await login(page);
  const name = "Perdida " + tag();
  const send = page.getByRole("button", {
    name: "Enviar a cocina",
    exact: true,
  });
  const cart = page.locator(".order-line");
  const failure = page.locator(".cart-bottom [role=alert]");
  const recovered = page.getByText(
    "Parte de esta orden ya había llegado a cocina. Quitamos del carrito lo que ya estaba enviado; revisa y envía el resto.",
  );
  await page.getByRole("button", { name: "Vender", exact: true }).click();

  // A new order: the server creates it, but the response never arrives.
  let creates = 0;
  await page.route("**/api/orders", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creates++;
    if (creates === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await productTile(page, "Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await send.click();
  // The transport error text belongs to offline (wave contracts D1).
  await expect(failure).toBeVisible();
  await productTile(page, "Agua de jamaica").click();
  await send.click();
  await expect(recovered).toBeVisible();
  await expect(page.locator(".existing")).toContainText("Taco de hongos");
  await expect(cart).toHaveCount(1);
  await expect(cart.first()).toContainText("Agua de jamaica");
  await send.click();
  await expect(page.locator(".existing")).toContainText("Agua de jamaica");
  await expect(cart).toHaveCount(0);
  expect(creates).toBe(2);

  // A round on the current order: same loss, then another line.
  let rounds = 0;
  await page.route("**/api/orders/*/rounds", async (route) => {
    rounds++;
    if (rounds === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await productTile(page, "Limonada natural").click();
  await send.click();
  await expect(failure).toBeVisible();
  await productTile(page, "Flan de vainilla").click();
  await send.click();
  await expect(recovered).toBeVisible();
  await expect(page.locator(".existing")).toContainText("Limonada natural");
  await expect(cart).toHaveCount(1);
  await expect(cart.first()).toContainText("Flan de vainilla");
  await send.click();
  await expect(page.locator(".existing")).toContainText("Flan de vainilla");
  await expect(cart).toHaveCount(0);
  expect(rounds).toBe(3);

  // One order holding each line exactly once.
  const list = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  expect(list.items).toHaveLength(1);
  const order = await call(page, "/orders/" + list.items[0].id);
  expect(order.lines.map((l: any) => l.name.es).sort()).toEqual(
    [
      "Agua de jamaica",
      "Flan de vainilla",
      "Limonada natural",
      "Taco de hongos",
    ].sort(),
  );
  expect(order.lines.every((l: any) => l.quantity === 1)).toBe(true);
});

test("a lost send keeps the extra unit tapped onto a line that already landed", async ({
  page,
}) => {
  await login(page);
  const name = "Unidad " + tag();
  const send = page.getByRole("button", {
    name: "Enviar a cocina",
    exact: true,
  });
  const cart = page.locator(".order-line");
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  let creates = 0;
  await page.route("**/api/orders", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creates++;
    if (creates === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await productTile(page, "Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await send.click();
  await expect(page.locator(".cart-bottom [role=alert]")).toBeVisible();
  // The customer wants two: the same cart line becomes 2 (SVC-R3 scenario A).
  await productTile(page, "Taco de hongos").click();
  await expect(cart).toHaveCount(1);
  await expect(cart.locator(".quantity span")).toHaveText("2");
  await send.click();
  await expect(
    page.getByText(
      "Parte de esta orden ya había llegado a cocina y después cambiaste cantidades o notas. En el carrito quedó solo lo que falta o cambió; revisa las cantidades y notas antes de enviar.",
    ),
  ).toBeVisible();
  await expect(page.locator(".existing")).toContainText("1 × Taco de hongos");
  await expect(cart).toHaveCount(1);
  await expect(cart.locator(".quantity span")).toHaveText("1");
  await send.click();
  await expect(cart).toHaveCount(0);
  expect(creates).toBe(2);
  const list = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  expect(list.items).toHaveLength(1);
  const order = await call(page, "/orders/" + list.items[0].id);
  const tacos = order.lines.filter((l: any) => l.name.es === "Taco de hongos");
  expect(tacos.reduce((n: number, l: any) => n + l.quantity, 0)).toBe(2);
});

test("cart changes made while a send is in flight stay in the cart and nothing is sent twice", async ({
  page,
}) => {
  // SVC-R7: a slow send must not drop what the waiter adds meanwhile, and a
  // tap landing right after the response must not bring sent lines back.
  await login(page);
  const name = "Vuelo " + tag();
  const send = page.getByRole("button", {
    name: "Enviar a cocina",
    exact: true,
  });
  const cart = page.locator(".order-line");
  const inFlight = cart.filter({ hasText: "Enviando a cocina…" });
  const tile = (n: string) => productTile(page, n);
  const existing = page.locator(".existing");
  await page.getByRole("button", { name: "Vender", exact: true }).click();

  // Each send waits until the test releases it.
  let release = () => {};
  let gate = Promise.resolve();
  const hold = () => {
    gate = new Promise<void>((resolve) => (release = resolve));
  };
  let creates = 0,
    rounds = 0;
  await page.route("**/api/orders", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creates++;
    await gate;
    await route.continue();
  });
  await page.route("**/api/orders/*/rounds", async (route) => {
    rounds++;
    await gate;
    await route.continue();
  });

  // New order: 1 taco with an order note, held in flight.
  await tile("Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await page.getByLabel("Nota de la orden (cocina)").fill("Sin prisa");
  hold();
  await send.click();
  await expect.poll(() => creates).toBe(1);
  // The line and the note in flight cannot be edited, nor the cart parked.
  await expect(inFlight).toHaveCount(1);
  await expect(
    inFlight.getByRole("button", { name: "Cantidad + Taco de hongos" }),
  ).toBeDisabled();
  await expect(
    inFlight.getByRole("button", { name: "Nota para Taco de hongos" }),
  ).toBeDisabled();
  await expect(page.getByLabel("Nota de la orden (cocina)")).not.toBeEditable();
  await expect(
    page.getByRole("button", { name: "Nueva orden", exact: true }),
  ).toBeDisabled();
  // The customer adds "y una Coca" and another taco with an allergy note.
  await tile("Agua de jamaica").click();
  await tile("Taco de hongos").click();
  await expect(cart).toHaveCount(3);
  await expect(inFlight.locator(".quantity span")).toHaveText("1");
  const newTaco = cart
    .filter({ hasText: "Taco de hongos" })
    .filter({ hasNotText: "Enviando a cocina…" });
  await newTaco
    .getByRole("button", { name: "Nota para Taco de hongos" })
    .click();
  await newTaco
    .getByRole("textbox", { name: "Nota para cocina", exact: true })
    .fill("Alergia: nuez");
  release();
  await expect(existing).toContainText("1 × Taco de hongos");
  await expect(inFlight).toHaveCount(0);
  await expect(cart).toHaveCount(2);
  await expect(cart.filter({ hasText: "Agua de jamaica" })).toHaveCount(1);
  await expect(
    newTaco.getByRole("textbox", { name: "Nota para cocina", exact: true }),
  ).toHaveValue("Alergia: nuez");
  await newTaco.getByRole("button", { name: "Listo", exact: true }).click();

  // A round on the check, held; Limonada is tapped every few ms across the
  // response so some taps land between the reconcile and the next render.
  await page.getByLabel("Nota para esta ronda").fill("Bebidas primero");
  hold();
  await send.click();
  await expect.poll(() => rounds).toBe(1);
  await expect(inFlight).toHaveCount(2);
  await expect(page.getByLabel("Nota para esta ronda")).not.toBeEditable();
  const tapping = page.evaluate(async () => {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("button.product"),
    ].find(
      (b) => b.querySelector("strong")?.textContent === "Limonada natural",
    )!;
    let taps = 0,
      after = 0;
    while (taps < 90 && after < 15) {
      button.click();
      taps++;
      if (!document.querySelector(".order-line.sending")) after++;
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    return taps;
  });
  release();
  const taps = await tapping;
  await expect(inFlight).toHaveCount(0);
  await expect(existing).toContainText("Agua de jamaica");
  const limonada = cart.filter({ hasText: "Limonada natural" });
  await expect(cart).toHaveCount(1);
  await expect(limonada.locator(".quantity span")).toHaveText(String(taps));
  await expect(page.getByLabel("Nota para esta ronda")).toHaveValue("");
  await send.click();
  await expect(existing).toContainText("Limonada natural");
  await expect(cart).toHaveCount(0);
  expect(creates).toBe(1);
  expect(rounds).toBe(2);

  // One order; every unit tapped is on it exactly once, with its notes.
  const list = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  expect(list.items).toHaveLength(1);
  const order = await call(page, "/orders/" + list.items[0].id);
  const units = (n: string) =>
    order.lines
      .filter((l: any) => l.name.es === n)
      .reduce((a: number, l: any) => a + l.quantity, 0);
  expect(units("Taco de hongos")).toBe(2);
  expect(units("Agua de jamaica")).toBe(1);
  expect(units("Limonada natural")).toBe(taps);
  expect(order.lines).toHaveLength(4);
  expect(
    order.lines.filter((l: any) => l.note === "Alergia: nuez"),
  ).toHaveLength(1);
  expect(order.note).toBe("Sin prisa");
  expect(order.rounds.map((r: any) => r.note)).toContain("Bebidas primero");
});

const SWITCH_WAITS =
  "Primero termina el envío en curso; después se abre la cuenta que elegiste.";

test("a table chosen in Mesas while a send is in flight opens only after the send lands", async ({
  page,
}) => {
  // SVC-R10: "Nueva cuenta" on another table during a slow send must not let
  // the late response put the first check back in the cart.
  await login(page);
  const free = await freeTables(page);
  expect(free.length, "two fixture tables must be free").toBeGreaterThan(1);
  const [first, second] = free;
  const name = "Mesa uno " + tag();
  const send = page.getByRole("button", {
    name: "Enviar a cocina",
    exact: true,
  });
  const cart = page.locator(".order-line");
  const existing = page.locator(".existing");
  const tile = (n: string) => productTile(page, n);
  const tableSelect = page.getByLabel("Seleccionar mesa");
  const card = (t: { name: string }) =>
    page.getByRole("article", { name: t.name, exact: true });
  let release = () => {};
  let gate = Promise.resolve();
  let creates = 0,
    rounds = 0;
  await page.route("**/api/orders", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creates++;
    await gate;
    await route.continue();
  });
  await page.route("**/api/orders/*/rounds", async (route) => {
    rounds++;
    await route.continue();
  });

  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  await card(first)
    .getByRole("button", { name: "Nueva cuenta", exact: true })
    .click();
  await expect(tableSelect).toHaveValue(first.id);
  await tile("Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  gate = new Promise<void>((resolve) => (release = resolve));
  await send.click();
  await expect.poll(() => creates).toBe(1);

  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  await card(second)
    .getByRole("button", { name: "Nueva cuenta", exact: true })
    .click();
  // The first table's cart stays on screen until its own send lands.
  await expect(page.getByText(SWITCH_WAITS)).toBeVisible();
  await expect(tableSelect).toHaveValue(first.id);
  await expect(cart.filter({ hasText: "Enviando a cocina…" })).toHaveCount(1);
  release();
  await expect(tableSelect).toHaveValue(second.id);
  await expect(page.locator(".cart .cart-heading .eyebrow")).toHaveText(
    "Nueva orden",
  );
  await expect(existing).toHaveCount(0);
  await expect(cart).toHaveCount(0);
  await expect(page.getByLabel("Nombre para llamar")).toHaveValue("");

  // The next Enviar opens a check on the second table, never a round on the first.
  await tile("Agua de jamaica").click();
  await page.getByLabel("Nombre para llamar").fill(name + " dos");
  await send.click();
  await expect(existing).toContainText("Agua de jamaica");
  expect(creates).toBe(2);
  expect(rounds).toBe(0);
  const tables = await call<any[]>(page, "/service/tables");
  const on = (t: { id: string }) => tables.find((x) => x.id === t.id)!.checks;
  expect(on(first)).toHaveLength(1);
  expect(on(second)).toHaveLength(1);
  const a = await call(page, "/orders/" + on(first)[0].id);
  const b = await call(page, "/orders/" + on(second)[0].id);
  expect(a.lines.map((l: any) => l.name.es)).toEqual(["Taco de hongos"]);
  expect(b.lines.map((l: any) => l.name.es)).toEqual(["Agua de jamaica"]);
  expect(b.tableId).toBe(second.id);
  // Nothing was parked: the first cart finished on its own check.
  await page.getByRole("button", { name: "Borradores", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toContainText(name);
  await page.keyboard.press("Escape");
  await freeCheck(page, a.id);
  await freeCheck(page, b.id);
});

test("Abrir orden on another check while a round is in flight keeps the round on its own check", async ({
  page,
}) => {
  // SVC-R10, resume path: the late response of check A's round must not turn
  // the cart back to A after the waiter opened check B.
  await login(page);
  const nameA = "Ronda A " + tag();
  const nameB = "Ronda B " + tag();
  const a = await apiOrder(page, nameA);
  const b = await apiOrder(page, nameB);
  const send = page.getByRole("button", {
    name: "Enviar a cocina",
    exact: true,
  });
  const cart = page.locator(".order-line");
  const existing = page.locator(".existing");
  const tile = (n: string) => productTile(page, n);
  let release = () => {};
  let gate = Promise.resolve();
  const roundsTo: string[] = [];
  await page.route("**/api/orders/*/rounds", async (route) => {
    roundsTo.push(new URL(route.request().url()).pathname.split("/")[3]);
    await gate;
    await route.continue();
  });
  const resume = async (name: string) => {
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    await page
      .locator(".order-summary")
      .filter({ hasText: name })
      .getByRole("button", { name: "Abrir orden", exact: true })
      .click();
  };

  await resume(nameA);
  await expect(existing).toContainText(`#${a.number} ·`);
  await tile("Flan de vainilla").click();
  gate = new Promise<void>((resolve) => (release = resolve));
  await send.click();
  await expect.poll(() => roundsTo.length).toBe(1);
  await resume(nameB);
  await expect(page.getByText(SWITCH_WAITS)).toBeVisible();
  await expect(existing).toContainText(`#${a.number} ·`);
  release();
  await expect(existing).toContainText(`#${b.number} ·`);
  await expect(existing).not.toContainText("Flan de vainilla");
  await expect(cart).toHaveCount(0);

  gate = Promise.resolve();
  await tile("Agua de jamaica").click();
  await send.click();
  await expect(existing).toContainText("Agua de jamaica");
  expect(roundsTo).toEqual([a.id, b.id]);
  const names = async (id: string) =>
    (await call(page, "/orders/" + id)).lines.map((l: any) => l.name.es).sort();
  expect(await names(a.id)).toEqual(["Flan de vainilla", "Taco de hongos"]);
  expect(await names(b.id)).toEqual(["Agua de jamaica", "Taco de hongos"]);
});

test("a round that answers after its cart moved to another check never comes back to the cart", async ({
  page,
}) => {
  // SVC-R10 backstop: check B is still loading when the waiter sends check
  // A's round, so B opens (parking A's cart) before A's response arrives.
  await login(page);
  const nameA = "Tarde A " + tag();
  const nameB = "Tarde B " + tag();
  const a = await apiOrder(page, nameA);
  const b = await apiOrder(page, nameB);
  const send = page.getByRole("button", {
    name: "Enviar a cocina",
    exact: true,
  });
  const cart = page.locator(".order-line");
  const existing = page.locator(".existing");
  const tile = (n: string) => productTile(page, n);
  let release = () => {};
  let gate = Promise.resolve();
  let releaseLoad = () => {};
  let loadGate = Promise.resolve();
  const roundsTo: string[] = [];
  await page.route("**/api/orders/*/rounds", async (route) => {
    roundsTo.push(new URL(route.request().url()).pathname.split("/")[3]);
    await gate;
    await route.continue();
  });
  await page.route(`**/api/orders/${b.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await loadGate;
    await route.continue();
  });
  const resume = async (name: string) => {
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    await page
      .locator(".order-summary")
      .filter({ hasText: name })
      .getByRole("button", { name: "Abrir orden", exact: true })
      .click();
  };

  await resume(nameA);
  await expect(existing).toContainText(`#${a.number} ·`);
  await tile("Flan de vainilla").click();
  loadGate = new Promise<void>((resolve) => (releaseLoad = resolve));
  await resume(nameB);
  // B is loading; the cart still shows A and the waiter sends its round.
  await expect(existing).toContainText(`#${a.number} ·`);
  gate = new Promise<void>((resolve) => (release = resolve));
  await send.click();
  await expect.poll(() => roundsTo.length).toBe(1);
  releaseLoad();
  await expect(existing).toContainText(`#${b.number} ·`);
  release();
  await expect(
    page.getByText(
      `La orden #${a.number} llegó a cocina mientras cambiabas de cuenta.`,
    ),
  ).toBeVisible();
  await expect(existing).toContainText(`#${b.number} ·`);
  await expect(existing).not.toContainText("Flan de vainilla");
  await expect(cart).toHaveCount(0);
  // The copy of A's cart parked by the switch left Borradores with the send.
  await page.getByRole("button", { name: "Borradores", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toContainText(nameA);
  await page.keyboard.press("Escape");

  gate = Promise.resolve();
  await tile("Agua de jamaica").click();
  await send.click();
  await expect(existing).toContainText("Agua de jamaica");
  expect(roundsTo).toEqual([a.id, b.id]);
  const names = async (id: string) =>
    (await call(page, "/orders/" + id)).lines.map((l: any) => l.name.es).sort();
  expect(await names(a.id)).toEqual(["Flan de vainilla", "Taco de hongos"]);
  expect(await names(b.id)).toEqual(["Agua de jamaica", "Taco de hongos"]);
});

const SWITCH_CANCELLED =
  "No abrimos la cuenta que elegiste porque el envío o cobro en curso no se completó. Revisa el aviso y vuelve a elegirla.";

test("a send that fails while a table switch waits keeps its error and cart until the table is chosen again", async ({
  page,
}) => {
  // SVC-REV-1: the deferred switch must not erase the failure of the send it
  // waited for; the food did not reach the kitchen and the waiter must know.
  await login(page);
  const free = await freeTables(page);
  expect(free.length, "two fixture tables must be free").toBeGreaterThan(1);
  const [first, second] = free;
  const name = "Falla mesa " + tag();
  const send = page.getByRole("button", {
    name: "Enviar a cocina",
    exact: true,
  });
  const cart = page.locator(".order-line");
  const existing = page.locator(".existing");
  const failure = page.locator(".cart-bottom [role=alert]");
  const tile = (n: string) => productTile(page, n);
  const tableSelect = page.getByLabel("Seleccionar mesa");
  const card = (t: { name: string }) =>
    page.getByRole("article", { name: t.name, exact: true });
  const newCheck = async (t: { name: string }) => {
    await page.getByRole("button", { name: "Mesas", exact: true }).click();
    await card(t)
      .getByRole("button", { name: "Nueva cuenta", exact: true })
      .click();
  };
  let release = () => {};
  let gate = Promise.resolve();
  const operations: string[] = [];
  await page.route("**/api/orders", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    operations.push(route.request().postDataJSON().operationId);
    if (operations.length === 1) {
      // The first send hangs, then the connection drops without reaching
      // the server.
      await gate;
      await route.abort("failed");
    } else await route.continue();
  });

  await newCheck(first);
  await expect(tableSelect).toHaveValue(first.id);
  await tile("Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  gate = new Promise<void>((resolve) => (release = resolve));
  await send.click();
  await expect.poll(() => operations.length).toBe(1);
  await newCheck(second);
  await expect(page.getByText(SWITCH_WAITS)).toBeVisible();
  release();

  // The send failed: its error stays, the switch did not happen and the
  // first table's cart is still on screen, ready to send again.
  await expect(page.getByText(SWITCH_CANCELLED)).toBeVisible();
  await expect(page.getByText(SWITCH_WAITS)).toHaveCount(0);
  await expect(failure).toBeVisible();
  await expect(tableSelect).toHaveValue(first.id);
  await expect(existing).toHaveCount(0);
  await expect(cart).toHaveCount(1);
  await expect(cart.first()).toContainText("Taco de hongos");
  await expect(cart.filter({ hasText: "Enviando a cocina…" })).toHaveCount(0);
  await expect(page.getByLabel("Nombre para llamar")).toHaveValue(name);
  await expect(send).toBeEnabled();
  // Nothing reached the kitchen or the tables.
  const nothing = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  expect(nothing.items).toHaveLength(0);
  const kitchen = await call(page, "/service/kitchen?station=all");
  expect(kitchen.rounds.filter((r: any) => r.callName === name)).toHaveLength(
    0,
  );

  // Choosing the table again switches: the unsent cart goes to Borradores.
  await newCheck(second);
  await expect(tableSelect).toHaveValue(second.id);
  await expect(cart).toHaveCount(0);
  await expect(
    page.getByText("Guardamos la orden que estabas capturando en Borradores."),
  ).toBeVisible();
  await expect(failure).toHaveCount(0);
  // Sent from Borradores it keeps its operation id, so it lands once, on the
  // first table.
  await page.getByRole("button", { name: "Borradores", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: new RegExp(name) })
    .click();
  await expect(tableSelect).toHaveValue(first.id);
  await expect(cart).toHaveCount(1);
  await send.click();
  await expect(existing).toContainText("Taco de hongos");
  expect(operations).toHaveLength(2);
  expect(operations[1]).toBe(operations[0]);
  const list = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  expect(list.items).toHaveLength(1);
  const order = await call(page, "/orders/" + list.items[0].id);
  expect(order.tableId).toBe(first.id);
  expect(order.lines.map((l: any) => l.name.es)).toEqual(["Taco de hongos"]);
  await freeCheck(page, order.id);
});

test("a round refused while the waiter is in Órdenes keeps its error when another check is opened", async ({
  page,
}) => {
  // SVC-REV-1: the send fails while Vender is hidden; the next Abrir orden
  // must show that failure (and its "Enviar como orden nueva") instead of
  // replacing the cart, and only a second Abrir orden switches.
  await login(page);
  const nameA = "Rechazo A " + tag();
  const nameB = "Rechazo B " + tag();
  const a = await apiOrder(page, nameA);
  const b = await apiOrder(page, nameB);
  const send = page.getByRole("button", {
    name: "Enviar a cocina",
    exact: true,
  });
  const cart = page.locator(".order-line");
  const existing = page.locator(".existing");
  const failure = page.locator(".cart-bottom [role=alert]");
  const tile = (n: string) => productTile(page, n);
  let release = () => {};
  let gate = Promise.resolve();
  let rounds = 0;
  await page.route("**/api/orders/*/rounds", async (route) => {
    rounds++;
    await gate;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "check_closed" }),
    });
  });
  const resume = async (name: string) => {
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    await page
      .locator(".order-summary")
      .filter({ hasText: name })
      .getByRole("button", { name: "Abrir orden", exact: true })
      .click();
  };

  await resume(nameA);
  await expect(existing).toContainText(`#${a.number} ·`);
  await tile("Flan de vainilla").click();
  gate = new Promise<void>((resolve) => (release = resolve));
  await send.click();
  await expect.poll(() => rounds).toBe(1);
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  release();
  // Selling is hidden; its cart takes the refusal meanwhile.
  await expect(failure).toContainText(
    "Esta cuenta ya se cerró. Tus productos sin enviar siguen aquí.",
  );
  await page
    .locator(".order-summary")
    .filter({ hasText: nameB })
    .getByRole("button", { name: "Abrir orden", exact: true })
    .click();
  await expect(page.getByText(SWITCH_CANCELLED)).toBeVisible();
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("Esta cuenta ya se cerró.");
  await expect(
    failure.getByRole("button", { name: "Enviar como orden nueva" }),
  ).toBeVisible();
  await expect(existing).toContainText(`#${a.number} ·`);
  await expect(cart).toHaveCount(1);
  await expect(cart.first()).toContainText("Flan de vainilla");

  // The second Abrir orden switches and parks the round with its check.
  await resume(nameB);
  await expect(existing).toContainText(`#${b.number} ·`);
  await expect(cart).toHaveCount(0);
  await expect(failure).toHaveCount(0);
  await page.getByRole("button", { name: "Borradores", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    `#${a.number} · ronda sin enviar`,
  );
  await page.keyboard.press("Escape");
  expect(rounds).toBe(1);
  const names = async (id: string) =>
    (await call(page, "/orders/" + id)).lines.map((l: any) => l.name.es);
  expect(await names(a.id)).toEqual(["Taco de hongos"]);
  expect(await names(b.id)).toEqual(["Taco de hongos"]);
});

test("a round that fails after its cart moved to another check says so and stays in Borradores", async ({
  page,
}) => {
  // SVC-REV-1, backstop path: check B opened while A's round was in flight
  // (B was already loading), then A's round failed.
  await login(page);
  const nameA = "Caida A " + tag();
  const nameB = "Caida B " + tag();
  const a = await apiOrder(page, nameA);
  const b = await apiOrder(page, nameB);
  const send = page.getByRole("button", {
    name: "Enviar a cocina",
    exact: true,
  });
  const cart = page.locator(".order-line");
  const existing = page.locator(".existing");
  const failure = page.locator(".cart-bottom [role=alert]");
  const tile = (n: string) => productTile(page, n);
  let release = () => {};
  let gate = Promise.resolve();
  let releaseLoad = () => {};
  let loadGate = Promise.resolve();
  let rounds = 0;
  await page.route("**/api/orders/*/rounds", async (route) => {
    rounds++;
    await gate;
    await route.abort("failed");
  });
  await page.route(`**/api/orders/${b.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await loadGate;
    await route.continue();
  });
  const resume = async (name: string) => {
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    await page
      .locator(".order-summary")
      .filter({ hasText: name })
      .getByRole("button", { name: "Abrir orden", exact: true })
      .click();
  };

  await resume(nameA);
  await expect(existing).toContainText(`#${a.number} ·`);
  await tile("Flan de vainilla").click();
  loadGate = new Promise<void>((resolve) => (releaseLoad = resolve));
  await resume(nameB);
  await expect(existing).toContainText(`#${a.number} ·`);
  gate = new Promise<void>((resolve) => (release = resolve));
  await send.click();
  await expect.poll(() => rounds).toBe(1);
  releaseLoad();
  await expect(existing).toContainText(`#${b.number} ·`);
  release();
  await expect(failure).toContainText(
    `La ronda para la orden #${a.number} no llegó a cocina:`,
  );
  await expect(failure).toContainText(
    "Quedó en Borradores; envíala desde ahí.",
  );
  await expect(existing).toContainText(`#${b.number} ·`);
  await expect(cart).toHaveCount(0);
  await page.getByRole("button", { name: "Borradores", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    `#${a.number} · ronda sin enviar`,
  );
  await page.keyboard.press("Escape");
  const names = async (id: string) =>
    (await call(page, "/orders/" + id)).lines.map((l: any) => l.name.es);
  expect(await names(a.id)).toEqual(["Taco de hongos"]);
  expect(await names(b.id)).toEqual(["Taco de hongos"]);
});

test("a recovered payment for a check the cart already left is announced, not shown as its receipt", async ({
  page,
}) => {
  // SVC-REV-2: a lost payment response, then another table opened and items
  // added before "Recuperar pago"; the recovery must not take over that cart.
  await login(page);
  await openDrawer(page);
  const free = await freeTables(page);
  expect(free.length, "a fixture table must be free").toBeGreaterThan(0);
  const table = free[0];
  const name = "Recupera " + tag();
  const a = await apiOrder(page, name);
  const cart = page.locator(".order-line");
  const existing = page.locator(".existing");
  const tableSelect = page.getByLabel("Seleccionar mesa");
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await page
    .locator(".order-summary")
    .filter({ hasText: name })
    .getByRole("button", { name: "Abrir orden", exact: true })
    .click();
  await expect(existing).toContainText(`#${a.number} ·`);
  // The server records the payment; its response never arrives.
  await page.route(
    "**/api/orders/*/payments",
    async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText(/Hay un pago anterior por confirmar/),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const recover = page.getByRole("button", {
    name: "Recuperar pago",
    exact: true,
  });
  await expect(recover).toBeVisible();

  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  await page
    .getByRole("article", { name: table.name, exact: true })
    .getByRole("button", { name: "Nueva cuenta", exact: true })
    .click();
  await expect(tableSelect).toHaveValue(table.id);
  await productTile(page, "Agua de jamaica").click();
  await expect(cart).toHaveCount(1);
  await recover.click();
  await expect(
    page.getByText(
      `El cobro pendiente de la orden #${a.number} quedó registrado. Su recibo está en Órdenes.`,
    ),
  ).toBeVisible();
  await expect(recover).toHaveCount(0);
  await expect(page.locator(".receipt")).toHaveCount(0);
  await expect(existing).toHaveCount(0);
  await expect(tableSelect).toHaveValue(table.id);
  await expect(cart).toHaveCount(1);
  await expect(cart.first()).toContainText("Agua de jamaica");
  const order = await call(page, "/orders/" + a.id);
  expect(order.tenders).toHaveLength(1);
  expect(order.paid).toBe(order.total);
});

test("Cobrar with unsent items does not announce a balance change it made itself", async ({
  page,
}) => {
  // SVC-R8: sending the cart inside Cobrar moves lines from the cart to the
  // check; the balance is the same, so a failed payment shows no change.
  await login(page);
  await openDrawer(page);
  const name = "Propio " + tag();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await productTile(page, "Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Taco de hongos");
  await productTile(page, "Flan de vainilla").click();
  let payments = 0;
  await page.route("**/api/orders/*/payments", async (route) => {
    payments++;
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "invalid_input" }),
    });
  });
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const amount = dialog.getByRole("textbox", { name: "Importe", exact: true });
  const shown = await amount.inputValue();
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect.poll(() => payments).toBe(1);
  await expect(page.locator(".existing")).toContainText("Flan de vainilla");
  await expect(
    dialog.getByRole("button", { name: "Confirmar cobro", exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByText(/^El saldo pendiente cambió a/)).toHaveCount(0);
  await expect(amount).toHaveValue(shown);
  const list = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  const order = await call(page, "/orders/" + list.items[0].id);
  expect(((order.total - order.paid) / 100).toFixed(2)).toBe(shown);
  expect(order.tenders).toHaveLength(0);
});

test("a second Confirmar cobro tap while the payment is in flight records one tender", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  const name = "Doble " + tag();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await productTile(page, "Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Taco de hongos");
  // Dessert stays unsent: Cobrar sends it first, then pays part of the check.
  await productTile(page, "Flan de vainilla").click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let payments = 0;
  await page.route("**/api/orders/*/payments", async (route) => {
    payments++;
    await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Importe", exact: true })
    .fill("20");
  const confirm = dialog.getByRole("button", {
    name: "Confirmar cobro",
    exact: true,
  });
  // "Operación" opens Vender before openDrawer's API call lands, so the cart
  // may only learn of the drawer from Cobrar's own /cash refresh; Confirm stays
  // disabled (MON-8) until then. evaluate() skips Playwright's actionability
  // wait, so wait for it here: both taps must reach an enabled button.
  await expect(confirm).toBeEnabled();
  // Two taps in the same task, before React can render the button disabled.
  await confirm.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => payments).toBe(1);
  // While the request hangs, Confirm stays disabled and the dialog does not
  // offer the "retry is safe" recovery hint.
  const busyConfirm = dialog.getByRole("button", { name: "Cargando…" });
  await expect(busyConfirm).toBeDisabled();
  await expect(
    dialog.getByText(
      "Hay un pago anterior por confirmar. Reintentar consulta la misma operación; no inicia otro cobro.",
    ),
  ).toHaveCount(0);
  await busyConfirm.click({ force: true });
  release();
  await expect(page.locator(".receipt")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(payments).toBe(1);
  const list = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  const order = await call(page, "/orders/" + list.items[0].id);
  expect(order.tenders).toHaveLength(1);
  expect(order.paid).toBe(2000);
  expect(order.lines.map((l: any) => l.name.es).sort()).toEqual(
    ["Flan de vainilla", "Taco de hongos"].sort(),
  );
});

test("Cobrar shows a stale order inside the payment dialog and moves Importe to the new balance", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  const name = "Saldo " + tag();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await productTile(page, "Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Taco de hongos");
  await productTile(page, "Flan de vainilla").click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const amount = dialog.getByRole("textbox", { name: "Importe", exact: true });
  const list = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  const order = await call(page, "/orders/" + list.items[0].id);
  const flan = await product(page, "Flan de vainilla");
  await expect(amount).toHaveValue(
    ((order.total - order.paid + flan.price) / 100).toFixed(2),
  );
  // Another device adds two waters while the dialog is open.
  const water = await product(page, "Agua de jamaica");
  await call(page, `/orders/${order.id}/rounds`, {
    operationId: uuid(),
    expectedVersion: order.version,
    lines: [
      { id: uuid(), productId: water.id, quantity: 2, options: [], note: "" },
    ],
    mode: order.mode,
  });
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(
    dialog.getByText(
      "La orden cambió en otro dispositivo. Ya la actualizamos y tus productos sin enviar siguen aquí. Revisa y envía de nuevo.",
    ),
  ).toBeVisible();
  const latest = await call(page, "/orders/" + order.id);
  const due = latest.total - latest.paid + flan.price;
  await expect(dialog.getByText(/^El saldo pendiente cambió a/)).toBeVisible();
  await expect(amount).toHaveValue((due / 100).toFixed(2));
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Cobrado");
  const paid = await call(page, "/orders/" + order.id);
  expect(paid.paid).toBe(paid.total);
  expect(paid.tenders).toHaveLength(1);
  expect(paid.lines.map((l: any) => l.name.es).sort()).toEqual(
    ["Agua de jamaica", "Flan de vainilla", "Taco de hongos"].sort(),
  );
});

test("Cobrar juntas keeps the balances it opened with and shows the change", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  const label = "Juntas " + tag();
  const first = await apiOrder(page, label + " uno");
  const second = await apiOrder(page, label + " dos");
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await page.getByLabel("Buscar por número, nombre o mesa").fill(label);
  for (const o of [first, second])
    await page
      .getByRole("checkbox", {
        name: "Seleccionar orden #" + o.number,
        exact: true,
      })
      .check();
  await page
    .getByRole("button", { name: "Cobrar juntas (2)", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const total = first.total + second.total;
  const money = (n: number) => "$" + (n / 100).toFixed(2);
  await expect(dialog).toContainText(money(total));
  // A round lands on the first check and the list behind the dialog reloads.
  const water = await product(page, "Agua de jamaica");
  await call(page, `/orders/${first.id}/rounds`, {
    operationId: uuid(),
    expectedVersion: first.version,
    lines: [
      { id: uuid(), productId: water.id, quantity: 1, options: [], note: "" },
    ],
    mode: first.mode,
  });
  const reloaded = page.waitForResponse((r) =>
    r.url().includes("/api/service/orders"),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await reloaded;
  await expect(
    page.locator(".order-summary").filter({ hasText: label + " uno" }),
  ).toContainText(money(first.total + water.price));
  await expect(dialog).toContainText(
    `#${first.number} · ${money(first.total)}`,
  );
  await expect(dialog).toContainText(money(total));
  // SVC-REV-3: the cashier is told the first check now owes more.
  await expect(
    dialog.getByText(
      `La orden #${first.number} ahora debe ${money(first.total + water.price)}, pero este cobro conjunto cubre ${money(first.total)}. Lo que falte quedará pendiente en la orden.`,
    ),
  ).toBeVisible();
  // SERVICE-MONEY-4: short cash is refused before anything is sent.
  await dialog.getByLabel("Efectivo recibido").fill(String(total / 100 - 1));
  await expect(dialog.getByRole("alert")).toHaveText(
    "El efectivo recibido no cubre el importe.",
  );
  await expect(
    dialog.getByRole("button", { name: "Guardar", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Efectivo recibido").fill(String(total / 100 + 20));
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.locator(".row", { hasText: "Cambio" })).toContainText(
    "$20.00",
  );
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  // SVC-REV-3: the dialog shows what each check still owes and prints the
  // receipts of the grouped payment.
  await expect(
    dialog.getByText("Cobro conjunto registrado. Cambio: $20.00."),
  ).toBeVisible();
  await expect(dialog).toContainText(
    `#${first.number} · Cobrado ${money(first.total)} · Saldo ${money(water.price)}`,
  );
  await expect(dialog).toContainText(
    `La orden #${first.number} todavía debe ${money(water.price)}. Cóbralo desde la orden.`,
  );
  await expect(dialog).toContainText(
    `#${second.number} · Cobrado ${money(second.total)} · Saldo $0.00`,
  );
  await expect(dialog).not.toContainText(
    `La orden #${second.number} todavía debe`,
  );
  await stubPrint(page);
  await dialog
    .getByRole("button", { name: "Imprimir recibos (2)", exact: true })
    .click();
  await expect.poll(async () => (await printed(page)).length).toBe(1);
  const [paper] = await printed(page);
  expect(paper).toContain(`#${first.number}`);
  expect(paper).toContain(`#${second.number}`);
  await dialog.getByRole("button", { name: "Listo", exact: true }).click();
  await expect(dialog).toBeHidden();
  const a = await call(page, "/orders/" + first.id);
  const b = await call(page, "/orders/" + second.id);
  expect(a.paid).toBe(first.total);
  expect(a.total).toBe(first.total + water.price);
  expect(b.paid).toBe(b.total);
});

test("orders: current tab, search, closed tab, detail, reprint and paging", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  const label = tag();
  const created = await page.evaluate(async (label) => {
    const s = await (await fetch("/api/session")).json();
    const catalog = await (await fetch("/api/catalog")).json();
    const p = catalog.find((p: any) => p.name.es === "Taco de hongos");
    const out = [];
    for (let i = 0; i < 52; i++) {
      const r = await fetch("/api/orders", {
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
          name: `${label} ${"abcdefghij"[i % 10]}${"abcdefghij"[Math.floor(i / 10)]}`,
          note: "",
          channel: "pos",
        }),
      });
      out.push(await r.json());
    }
    return out;
  }, label);
  // Keep the kitchen display small for later tests: serve every new ticket.
  await page.evaluate(async (orders: any[]) => {
    const s = await (await fetch("/api/session")).json();
    for (const o of orders)
      for (const r of o.rounds)
        for (const state of ["ready", "completed"])
          await fetch("/api/kitchen/" + r.id, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-csrf-token": s.csrf,
            },
            body: JSON.stringify({ operationId: crypto.randomUUID(), state }),
          });
  }, created);
  const paid = created[0];
  await call(page, `/orders/${paid.id}/payments`, {
    operationId: uuid(),
    amount: paid.total,
    tip: 0,
    received: paid.total,
    method: "cash",
  });
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  /** Types a search and waits for the debounced request that applies it. */
  const search = async (value: string) => {
    const applied = page.waitForResponse(
      (r) =>
        r.url().includes("/api/service/orders?") &&
        new URL(r.url()).searchParams.get("q") === value,
    );
    await page.getByLabel("Buscar por número, nombre o mesa").fill(value);
    await applied;
  };
  await search(label);
  const rows = page.locator(".order-summary");
  await expect(rows.filter({ hasNotText: label })).toHaveCount(0);
  await expect(rows).toHaveCount(50);
  await page.getByRole("button", { name: "Cargar más", exact: true }).click();
  await expect(rows).toHaveCount(52);
  const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axe.violations).toEqual([]);

  const target = created[7];
  await search(String(target.number));
  await expect(
    rows.filter({
      has: page.locator(".eyebrow", {
        hasText: new RegExp(`^#${target.number} ·`),
      }),
    }),
  ).toHaveCount(1);

  const closedTab = page.waitForResponse(
    (r) =>
      r.url().includes("/api/service/orders?") &&
      new URL(r.url()).searchParams.get("status") === "closed",
  );
  await page.getByRole("button", { name: "Cerradas", exact: true }).click();
  await closedTab;
  await search(label);
  await expect(rows.filter({ hasNotText: label })).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(paid.name);
  await expect(rows.first()).toContainText("Cerrada");
  await rows
    .first()
    .getByRole("button", { name: "Detalle", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: `Orden #${paid.number}` });
  await expect(detail).toContainText("Efectivo");
  await expect(detail).toContainText("Cobrada");
  const detailAxe = await new AxeBuilder({ page })
    .include("dialog")
    .withTags(AXE_TAGS)
    .analyze();
  expect(detailAxe.violations).toEqual([]);
  await stubPrint(page);
  await detail.getByRole("button", { name: "Reimprimir recibo" }).click();
  await expect
    .poll(async () => (await printed(page)).join("\n"))
    .toContain("REIMPRESIÓN");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
});

test("operation dialogs keep one operation id across a lost response", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  const name = "Reembolso " + tag();
  const order = await apiOrder(page, name);
  await call(page, `/orders/${order.id}/payments`, {
    operationId: uuid(),
    amount: order.total,
    tip: 0,
    received: order.total,
    method: "cash",
  });
  let refunds = 0;
  await page.route("**/api/refunds", async (route) => {
    refunds++;
    if (refunds === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  const row = page.locator(".order-summary").filter({ hasText: name });
  await row.getByRole("button", { name: "Reembolsar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Importe", { exact: true }).fill("10");
  await dialog.getByLabel("Explicación").fill("Devolución sin respuesta");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  // The transport error text belongs to offline (wave contracts D1).
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(refunds).toBe(2);
  const refunded = await call(page, "/orders/" + order.id);
  expect(refunded.refunded).toBe(1000);

  const before = (await call(page, "/cash")).expected;
  let paidOuts = 0;
  await page.route("**/api/cash/paid-out", async (route) => {
    paidOuts++;
    if (paidOuts === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await page
    .getByRole("button", { name: "Registrar salida", exact: true })
    .click();
  await dialog.getByLabel("Importe", { exact: true }).fill("5");
  await dialog.getByLabel("Explicación").fill("Compra de hielo");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(paidOuts).toBe(2);
  expect((await call(page, "/cash")).expected).toBe(before - 500);
});

test("10-inch landscape cart keeps three dine-in lines visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await login(page);
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: "En mesa", exact: true }).click();
  await page.getByRole("button", { name: /^Detalles/ }).click();
  const details = page.getByRole("dialog", { name: "Detalles de la orden" });
  await details
    .getByRole("combobox", { name: "Seleccionar mesa" })
    .selectOption({ label: "Mesa 01" });
  await details.getByLabel("Nombre para llamar").fill("Tableta");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Detalles/ })).toContainText(
    "Mesa 01",
  );
  for (const name of ["Taco de hongos", "Agua de jamaica", "Guacamole"])
    await productTile(page, name).click();
  const lines = page.locator(".order-line");
  await expect(lines).toHaveCount(3);
  for (let i = 0; i < 3; i++)
    await expect(lines.nth(i)).toBeInViewport({ ratio: 0.95 });
  await productTile(page, "Agua de jamaica").click();
  const water = lines.filter({ hasText: "Agua de jamaica" });
  await expect(water).toHaveCount(1);
  await expect(water.locator(".quantity span")).toHaveText("2");
  const waterTile = productTile(page, "Agua de jamaica");
  await expect(waterTile).toBeVisible();
  await expect(waterTile).toHaveAccessibleName(
    /Agua de jamaica.*2 en la orden/,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "docs/evidence/service-selling-1024.png" });
});

test("Spanish operator screens show labels instead of codes", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  const order = await apiOrder(page, "Etiquetas " + tag());
  await call(page, `/orders/${order.id}/payments`, {
    operationId: uuid(),
    amount: order.total,
    tip: 0,
    received: order.total,
    method: "cash",
  });
  const drawer = await call(page, "/cash");
  await call(page, "/cash/close", {
    operationId: uuid(),
    counted: drawer.expected,
    reason: "",
  });
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  await expect(page.getByText("Facturación CFDI (Facturapi)")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "facturapi", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Historial de auditoría", exact: true })
    .click();
  const audit = page.getByRole("dialog");
  await expect(audit).toContainText("Orden creada");
  await expect(audit).not.toContainText("order.created");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await page.getByText("Historial de cajas").click();
  const history = page
    .locator("details.panel")
    .filter({ hasText: "Historial de cajas" });
  await history
    .getByRole("button", { name: "Ver movimientos" })
    .first()
    .click();
  const movements = history.locator("ul").first();
  await expect(movements).toContainText("Efectivo");
  await expect(movements).not.toContainText(/\bcash\b/);
  await expect(history).not.toContainText("moneda sin evidencia");
});

test("cart note edits reach the kitchen, comandas print on send and a closed check sends as new", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  const name = "Comanda " + tag();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: "Impresión", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Imprimir comanda al enviar a cocina")
    .check();
  await page.keyboard.press("Escape");
  await stubPrint(page);
  await productTile(page, "Taco de hongos").click();
  await page.getByLabel("Nota de la orden (cocina)").fill("Sin prisa");
  await page.getByLabel("Nombre para llamar").fill(name);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Taco de hongos");
  await expect
    .poll(async () => (await printed(page)).join("\n"))
    .toContain(name);
  const comanda = (await printed(page)).join("\n");
  expect(comanda).toContain("Taco de hongos");
  expect(comanda).toContain("Sin prisa");

  // Editar nota after sending reaches the open kitchen ticket.
  await page
    .locator(".existing")
    .getByRole("button", { name: "Editar nota", exact: true })
    .click();
  const noteDialog = page.getByRole("dialog", { name: "Editar nota" });
  await noteDialog.getByLabel("Nota de la orden").fill("Alergia: nuez");
  await noteDialog
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByText("Nota enviada a cocina")).toBeVisible();
  await expect(page.locator(".existing")).toContainText("Alergia: nuez");
  // SVC-R6: the comanda printed at send time has the old note; reprint it.
  await stubPrint(page);
  await page
    .getByRole("button", { name: "Reimprimir comanda", exact: true })
    .click();
  await expect
    .poll(async () => (await printed(page)).join("\n"))
    .toContain("Alergia: nuez");
  expect((await printed(page)).join("\n")).toContain(name);

  // The check closes elsewhere (paid in full); unsent items go out as a new order.
  const list = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  const first = await call(page, "/orders/" + list.items[0].id);
  await call(page, `/orders/${first.id}/payments`, {
    operationId: uuid(),
    amount: first.total,
    tip: 0,
    received: first.total,
    method: "cash",
  });
  await productTile(page, "Agua de jamaica").click();
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(
    page.getByText(
      "Esta cuenta ya se cerró. Tus productos sin enviar siguen aquí.",
    ),
  ).toBeVisible();
  await expect(
    page.locator(".order-line").filter({ hasText: "Agua de jamaica" }),
  ).toBeVisible();
  const sendAsNew = page.getByRole("button", {
    name: "Enviar como orden nueva",
    exact: true,
  });
  await expect(sendAsNew).toBeEnabled();
  // LD-11 MENU-INT-3: while a kept line is no longer sold, "Enviar como orden
  // nueva" waits for it to be removed, like Enviar and Cobrar.
  await productTile(page, "Guacamole").click();
  await setSeededAvailable(page, "Guacamole", false);
  try {
    await page.evaluate(() =>
      window.dispatchEvent(new Event("gm-menu-refresh")),
    );
    const stale = page
      .locator(".order-line.line-error")
      .filter({ hasText: "Guacamole" });
    await expect(stale).toContainText("No disponible. Quítalo para continuar.");
    await expect(
      page.getByText(
        "Esta cuenta ya se cerró. Tus productos sin enviar siguen aquí.",
      ),
    ).toBeVisible();
    await expect(sendAsNew).toBeDisabled();
    await stale.getByRole("button", { name: "Quitar", exact: true }).click();
    await expect(stale).toHaveCount(0);
    await expect(sendAsNew).toBeEnabled();
  } finally {
    await setSeededAvailable(page, "Guacamole", true);
  }
  await sendAsNew.click();
  await expect(page.locator(".existing")).toContainText("Agua de jamaica");
  await expect(page.locator(".existing")).not.toContainText("Taco de hongos");
  const both = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  expect(both.items).toHaveLength(2);
  const second = both.items.find((o: any) => o.id !== first.id);
  expect(second.checkState).toBe("open");

  await page
    .getByRole("button", { name: "Cocina", exact: true })
    .first()
    .click();
  const ticket = page
    .locator(".kitchen-ticket")
    .filter({ hasText: new RegExp(`#${first.number}(?!\\d)`) })
    .filter({ hasText: name });
  await expect(ticket).toContainText("Alergia: nuez");
  await expect(ticket).not.toContainText("Sin prisa");
});

test("tables release a paid check from the card and before a new check", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  for (const t of await call<any[]>(page, "/service/tables"))
    for (const c of t.checks)
      if (c.checkState === "paid")
        await call(page, `/service/orders/${c.id}/close`, {
          operationId: uuid(),
        });
  const table = (await call<any[]>(page, "/service/tables")).find(
    (t) => !t.checks.length,
  );
  expect(table, "a fixture table must be free").toBeTruthy();
  const paidCheck = async (label: string) => {
    const o = await apiOrder(page, label + " " + tag(), "Taco de hongos", {
      mode: "dine_in",
      tableId: table.id,
    });
    await call(page, `/orders/${o.id}/payments`, {
      operationId: uuid(),
      amount: o.total,
      tip: 0,
      received: o.total,
      method: "cash",
    });
    return o;
  };
  const first = await paidCheck("Mesa A");
  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  const card = page.getByRole("article", { name: table.name, exact: true });
  await expect(card).toContainText(`#${first.number} · Pagada · por liberar`);
  await card.getByRole("button", { name: "Liberar mesa", exact: true }).click();
  await expect(card).toContainText("Disponible");
  expect((await call(page, "/orders/" + first.id)).closeReason).toBe(
    "released",
  );

  const second = await paidCheck("Mesa B");
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  await expect(card).toContainText(`#${second.number} · Pagada · por liberar`);
  await card.getByRole("button", { name: "Nueva cuenta", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: table.name });
  await expect(prompt).toContainText(`#${second.number}`);
  await prompt
    .getByRole("button", { name: "Liberar y abrir nueva cuenta" })
    .click();
  await expect(page.getByLabel("Seleccionar mesa")).toHaveValue(table.id);
  const released = await call(page, "/orders/" + second.id);
  expect(released.checkState).toBe("closed");
  expect(released.closeReason).toBe("released");
});

test("a counter check closed at payment still takes a note edit while its ticket is open", async ({
  page,
}) => {
  // SERVICE-KITCHEN-3: the customer mentions an allergy right after paying.
  await login(page);
  await openDrawer(page);
  const name = "Mostrador " + tag();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await productTile(page, "Taco de hongos").click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  const receipt = page
    .getByRole("dialog")
    .filter({ has: page.locator(".receipt") });
  await expect(receipt).toContainText("Cobrado");
  const list = await call(
    page,
    `/service/orders?q=${encodeURIComponent(name)}`,
  );
  const id = list.items[0].id;
  expect((await call(page, "/orders/" + id)).checkState).toBe("closed");
  await receipt
    .getByRole("button", { name: "Editar nota", exact: true })
    .click();
  const noteDialog = page.getByRole("dialog", { name: "Editar nota" });
  await noteDialog.getByLabel("Nota de la orden").fill("Alergia: piña");
  await noteDialog
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(noteDialog).toBeHidden();
  await expect(receipt.locator(".receipt")).toContainText("Alergia: piña");
  const edited = await call(page, "/orders/" + id);
  expect(edited.note).toBe("Alergia: piña");
  expect(edited.checkState).toBe("closed");
  expect(edited.paid).toBe(edited.total);
  await receipt
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();

  // Order detail offers it too, until the kitchen serves the ticket.
  const detail = async () => {
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    await page.getByLabel("Buscar por número, nombre o mesa").fill(name);
    await page
      .locator(".order-summary")
      .filter({ hasText: name })
      .getByRole("button", { name: "Detalle", exact: true })
      .click();
    return page.getByRole("dialog", { name: `Orden #${edited.number}` });
  };
  let dialog = await detail();
  await expect(dialog).toContainText("Alergia: piña");
  await expect(
    dialog.getByRole("button", { name: "Editar nota", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  for (const state of ["ready", "completed"])
    await call(page, "/kitchen/" + edited.rounds[0].id, {
      operationId: uuid(),
      state,
    });
  dialog = await detail();
  await expect(dialog).toContainText("Alergia: piña");
  await expect(
    dialog.getByRole("button", { name: "Editar nota", exact: true }),
  ).toHaveCount(0);
});

test("a paid table check takes one more round from Mesas on the same bill", async ({
  page,
}) => {
  // SERVICE-KITCHEN-10: "la última ronda" after paying stays on the check.
  await login(page);
  await openDrawer(page);
  const [table] = await freeTables(page);
  expect(table, "a fixture table must be free").toBeTruthy();
  const o = await apiOrder(page, "Última " + tag(), "Taco de hongos", {
    mode: "dine_in",
    tableId: table.id,
  });
  await call(page, `/orders/${o.id}/payments`, {
    operationId: uuid(),
    amount: o.total,
    tip: 0,
    received: o.total,
    method: "cash",
  });
  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  const card = page.getByRole("article", { name: table.name, exact: true });
  await expect(card).toContainText(`#${o.number} · Pagada · por liberar`);
  await card
    .getByRole("button", { name: `Abrir orden #${o.number}`, exact: true })
    .click();
  const existing = page.locator(".existing");
  await expect(existing).toContainText(`#${o.number} ·`);
  await expect(page.locator(".cart .check-badge")).toHaveText(
    "Pagada · por liberar",
  );
  await productTile(page, "Agua de jamaica").click();
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(existing).toContainText("Agua de jamaica");
  const water = await product(page, "Agua de jamaica");
  const after = await call(page, "/orders/" + o.id);
  expect(after.checkState).toBe("open");
  expect(after.total - after.paid).toBe(water.price);
  const tables = await call<any[]>(page, "/service/tables");
  expect(
    tables.find((t) => t.id === table.id)!.checks.map((c: any) => c.id),
  ).toEqual([o.id]);
  await freeCheck(page, o.id);
});
