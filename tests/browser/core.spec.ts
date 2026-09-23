import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
async function login(page: any) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
}
test("cashier order, modifier, kitchen acknowledgement, payment and receipt", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  const open = page.getByRole("button", { name: "Abrir caja", exact: true });
  await expect(open).toBeVisible();
  await open.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: /Taco de asada/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("radio").first().check();
  await page
    .getByRole("button", { name: "Agregar a la orden", exact: true })
    .click();
  await page.getByRole("button", { name: /Agua de jamaica/ }).click();
  await page.getByLabel("Nombre para llamar").fill("Browser acceptance");
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Enviado a cocina");
  await page
    .getByRole("button", { name: "Cocina", exact: true })
    .first()
    .click();
  const ticket = page
    .locator(".kitchen-ticket")
    .filter({ hasText: "Browser acceptance" })
    .last();
  await ticket.getByRole("button", { name: "Confirmar recepción" }).click();
  await expect(ticket).toContainText("Cocina recibió");
  await ticket.getByRole("button", { name: "Marcar listo" }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Cobrado");
  await page.screenshot({ path: "docs/evidence/receipt-1440.png" });
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();
});
test("responsive selling, keyboard modifier, accessibility", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `docs/evidence/selling-${width}.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    if (width === 390) {
      await expect(
        page.getByRole("button", { name: /Ver orden/ }),
      ).toBeVisible();
      await page.getByRole("button", { name: /Ver orden/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.screenshot({ path: "docs/evidence/cart-390.png" });
      await page.keyboard.press("Escape");
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("/");
  await expect(
    page.getByRole("textbox", { name: "Buscar producto…" }),
  ).toBeFocused();
  await page.getByRole("textbox", { name: "Buscar producto…" }).fill("asada");
  await page.keyboard.press("Tab");
  await page.getByRole("button", { name: /Taco de asada/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: "docs/evidence/modifier-1440.png" });
  await page.keyboard.press("Escape");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("additional round, partial payment reload, refund and drawer close", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await page.getByRole("button", { name: "Abrir caja", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await page.getByLabel("Nombre para llamar").fill("Split browser");
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toBeVisible();
  await page.getByRole("button", { name: /Agua de jamaica/ }).click();
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("$80.00");
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page.getByRole("textbox", { name: "Importe", exact: true }).fill("30");
  await page
    .getByRole("textbox", { name: "Efectivo recibido", exact: true })
    .fill("30");
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Pago parcial");
  await page.getByRole("button", { name: "Volver", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await expect(page.locator(".existing")).toContainText("Cobrado: $30.00");
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Cobrado");
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  const order = page
    .locator(".order-summary")
    .filter({ hasText: "Split browser" })
    .first();
  await order.getByRole("button", { name: "Reembolsar", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Importe", { exact: true })
    .fill("10");
  await page
    .getByRole("dialog")
    .getByLabel("Explicación")
    .fill("Devolución de prueba");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(order).toContainText("Reembolsado");
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await page.getByRole("button", { name: "Cerrar caja", exact: true }).click();
  await page.getByLabel("Efectivo contado").fill("570");
  await page.getByLabel("Explicación").fill("Conciliación de prueba");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByText("Caja cerrada", { exact: true })).toBeVisible();
});

test("inventory receipt, count conflict-safe adjustment and owner drilldown", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "Menú e inventario", exact: true })
    .click();
  const stock = page
    .locator(".stock-grid .panel")
    .filter({ hasText: "Tortilla preparada" });
  await stock.getByRole("button", { name: "Recibir", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Cantidad", { exact: true })
    .fill("10");
  await page
    .getByRole("dialog")
    .getByLabel("Explicación")
    .fill("Recepción de prueba");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await stock
    .getByRole("button", { name: "Conteo físico", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Cantidad", { exact: true })
    .fill("900");
  await page
    .getByRole("dialog")
    .getByLabel("Explicación")
    .fill("Conteo físico de prueba");
  await page.screenshot({ path: "docs/evidence/inventory-count-1440.png" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(stock.locator(".large-money")).toHaveText("900");
  await page.getByRole("button", { name: "Hoy", exact: true }).click();
  await expect(page.locator(".metric-grid")).toBeVisible();
  await page.screenshot({ path: "docs/evidence/today-1440.png" });
  await page.locator(".metric").first().click();
  await expect(
    page.getByRole("heading", { name: "Órdenes", exact: true }),
  ).toBeVisible();
});

test("offline cash persists and synchronizes after reconnect", async ({
  page,
  context,
}) => {
  test.skip(
    !process.env.TEST_PRODUCTION,
    "Service worker recovery requires compiled same-origin server",
  );
  await login(page);
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await page.getByRole("button", { name: "Abrir caja", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page.getByRole("button", { name: /Taco de hongos/ }).click();
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "Sin conexión", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Guardar cobro en este dispositivo",
      exact: true,
    })
    .click();
  await expect(page.locator(".receipt")).toContainText(
    "Pendiente de sincronizar",
  );
  await page.reload();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: /Sin conexión/ }).click();
  await expect(page.locator(".workspace")).toContainText(
    "Efectivo registrado localmente; pendiente en el servidor",
  );
  await page.screenshot({ path: "docs/evidence/offline-queue-1440.png" });
  await context.setOffline(false);
  const update = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register(
      "/sw.js?revision=browser-recovery-test",
    );
    const worker = registration.installing ?? registration.waiting;
    if (worker && !["installed", "activated"].includes(worker.state))
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("service_worker_update_timeout")),
          10000,
        );
        worker.addEventListener("statechange", () => {
          if (["installed", "activated"].includes(worker.state)) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    const names = await caches.keys();
    const updated = names.find((name) =>
      name.includes("browser-recovery-test"),
    );
    const requests = updated
      ? await (await caches.open(updated)).keys()
      : [];
    return {
      waiting: !!registration.waiting,
      names,
      paths: requests.map((request) => new URL(request.url).pathname),
    };
  });
  expect(update.waiting).toBe(true);
  expect(update.names.some((name) => name.includes("browser-recovery-test"))).toBe(
    true,
  );
  expect(update.paths.some((path) => path.startsWith("/assets/"))).toBe(true);
  expect(update.paths.some((path) => path.startsWith("/api/"))).toBe(false);
  await expect(page.locator(".workspace")).toContainText(
    "Efectivo registrado localmente; pendiente en el servidor",
  );
  await page
    .getByRole("button", { name: "Reintentar sincronización", exact: true })
    .click();
  await expect(page.locator(".workspace")).toContainText(
    "Registrado en el servidor",
  );
});

test("QR shares authoritative order pricing and exposes a narrow receipt", async ({
  page,
  context,
}) => {
  await login(page);
  const access = await page.evaluate(async () => {
    const s = await (await fetch("/api/session")).json();
    const r = await fetch("/api/ordering-links", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
      body: JSON.stringify({ channel: "qr", tableId: null }),
    });
    return r.json();
  });
  const customer = await context.newPage();
  await customer.goto(access.path);
  await expect(
    customer.getByRole("heading", { name: "Casa del Bosque · Demo" }),
  ).toBeVisible();
  await customer.getByRole("button", { name: /Taco de hongos/ }).click();
  await customer
    .getByRole("textbox", { name: "Nombre para llamar" })
    .fill("QR acceptance");
  await customer
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(
    customer.getByText("Sin cobrar", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    customer.getByText("Enviado a cocina", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await expect(
    page.locator(".order-summary").filter({ hasText: "QR acceptance" }).first(),
  ).toContainText("$45.00");
  await customer.close();
});

test("grouped cash settlement preserves distinct kitchen orders", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await page.getByRole("button", { name: "Abrir caja", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  const created = await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const cat = await (await fetch("/api/catalog")).json();
    const p = cat.find((p: any) => p.name.es === "Taco de hongos");
    const results = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": session.csrf,
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
          name: "Grouped " + crypto.randomUUID() + " " + i,
          note: "",
          channel: "pos",
        }),
      });
      results.push(await res.json());
    }
    return results;
  });
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  for (const o of created)
    await page
      .getByRole("article")
      .filter({ hasText: o.name })
      .getByRole("checkbox", {
        name: "Seleccionar orden #" + o.number,
        exact: true,
      })
      .check();
  await page
    .getByRole("button", { name: "Cobrar juntas (2)", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  for (const o of created) {
    const order = await page.evaluate(async (id) => {
      const r = await fetch("/api/orders/" + id);
      if (!r.ok) throw Error("order_read_failed");
      return r.json();
    }, o.id);
    expect(order.paid).toBe(order.total);
    expect(order.rounds).toHaveLength(1);
    expect(order.state).toBe("active");
  }
  expect(created[0].id).not.toBe(created[1].id);
});

test("menu editor preserves multiple recipe ingredients across price edits", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "Menú e inventario", exact: true })
    .click();
  await page.getByRole("button", { name: "Editar menú", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const name = `Receta ${Date.now()}`;
  await dialog.getByLabel("Nombre · Español").fill(name);
  await dialog.getByLabel("Name · English").fill(name);
  await dialog.getByLabel("Categoría · Español").fill("Pruebas");
  await dialog.getByLabel("Category · English").fill("Tests");
  await dialog.getByLabel("Precio", { exact: true }).fill("50");
  await dialog.getByLabel("Costo", { exact: true }).fill("15");
  await dialog.getByRole("button", { name: "Agregar ingrediente" }).click();
  await dialog
    .getByRole("combobox", { name: "Existencias 1", exact: true })
    .selectOption({ index: 1 });
  await dialog.getByRole("button", { name: "Agregar ingrediente" }).click();
  await dialog
    .getByRole("combobox", { name: "Existencias 2", exact: true })
    .selectOption({ index: 2 });
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Editar menú", exact: true }).click();
  await dialog
    .getByRole("combobox", { name: "Producto", exact: true })
    .selectOption({ label: name });
  await expect(
    dialog.getByRole("combobox", { name: "Existencias 2", exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("Precio", { exact: true }).fill("55");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const products = await page.evaluate(async () =>
    (await fetch("/api/catalog")).json(),
  );
  expect(products.find((p: any) => p.name.es === name).recipe).toHaveLength(2);
});
