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
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
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
  await page.getByRole("button", { name: /Flan de vainilla/ }).click();
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
  await page.getByRole("button", { name: /Taco de asada/ }).click();
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
  await page.getByRole("button", { name: /Flan de vainilla/ }).click();
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
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
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

  await page.getByRole("button", { name: /Taco de hongos/ }).click();
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

  const bowl = page.locator("button.product", { hasText: "Bowl de la casa" });
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
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
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
    await page.getByRole("button", { name: /Guacamole/ }).click();
    await page.getByRole("button", { name: /Limonada natural/ }).click();
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
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
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
  await page.getByRole("button", { name: /Limonada natural/ }).click();
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
  await page.getByRole("button", { name: /Café de olla/ }).click();
  await page.getByLabel("Nombre para llamar").fill(draftB);
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await page.getByRole("button", { name: /Ensalada verde/ }).click();
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
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await send.click();
  // The transport error text belongs to offline (wave contracts D1).
  await expect(failure).toBeVisible();
  await page.getByRole("button", { name: /Agua de jamaica/ }).click();
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
  await page.getByRole("button", { name: /Limonada natural/ }).click();
  await send.click();
  await expect(failure).toBeVisible();
  await page.getByRole("button", { name: /Flan de vainilla/ }).click();
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
    await page.getByRole("button", { name: new RegExp(name) }).click();
  const lines = page.locator(".order-line");
  await expect(lines).toHaveCount(3);
  for (let i = 0; i < 3; i++)
    await expect(lines.nth(i)).toBeInViewport({ ratio: 0.95 });
  await page.locator("button.product", { hasText: "Agua de jamaica" }).click();
  const water = lines.filter({ hasText: "Agua de jamaica" });
  await expect(water).toHaveCount(1);
  await expect(water.locator(".quantity span")).toHaveText("2");
  await expect(
    page.getByRole("button", { name: /Agua de jamaica.*2 en la orden/ }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
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
  await page.getByRole("button", { name: /Agua de jamaica/ }).click();
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
  await page
    .getByRole("button", { name: "Enviar como orden nueva", exact: true })
    .click();
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
