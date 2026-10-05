import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Local helpers (wave rule: no shared helper module in-wave).
async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
async function openMenu(page: Page) {
  await page
    .getByRole("button", { name: "Menú e inventario", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "Productos" })).toBeVisible();
}
async function sell(page: Page) {
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
}
/** Authenticated JSON call from the page (same cookies and CSRF as the app). */
async function call(page: Page, path: string, body?: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const s = await (await fetch("/api/session")).json();
      const r = await fetch("/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() };
    },
    { path, body },
  );
}
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}
const suffix = () => Math.random().toString(36).slice(2, 7);

test("manager builds a taquería menu with required, optional and repeatable choices, a combo and an open-price item, then sells it", async ({
  page,
}) => {
  const id = suffix();
  const category = `Taquería ${id}`;
  await login(page);
  await openMenu(page);

  await page
    .getByRole("button", { name: "Nueva categoría", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Nombre de la categoría", { exact: true })
    .fill(category);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Cambios guardados");

  await page.getByRole("tab", { name: "Modificadores" }).click();
  const newGroup = async (template: string | null, name: string) => {
    await page
      .getByRole("button", {
        name: "Nuevo grupo de modificadores",
        exact: true,
      })
      .click();
    dialog = page.getByRole("dialog");
    if (template)
      await dialog
        .getByRole("combobox", { name: "Plantillas" })
        .selectOption({ label: template });
    await dialog.getByLabel("Nombre del grupo", { exact: true }).fill(name);
  };
  await newGroup("Tortilla (maíz / harina)", `Tortilla ${id}`);
  await expect(dialog.getByText("Regla: Obligatorio · elige 1")).toBeVisible();
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await newGroup("Extras (queso, aguacate)", `Extras ${id}`);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await newGroup(null, `Tacos del combo ${id}`);
  await dialog.getByLabel("Mínimo a elegir").fill("3");
  await dialog.getByLabel("Máximo a elegir").fill("3");
  await dialog.getByLabel("Permitir repetir una opción").check();
  await expect(
    dialog.getByText("Regla: Obligatorio · elige 3 · puedes repetir"),
  ).toBeVisible();
  await dialog.getByLabel("Opción 1", { exact: true }).fill("Pastor");
  await dialog.getByRole("button", { name: "Agregar opción" }).click();
  await dialog.getByLabel("Opción 2", { exact: true }).fill("Suadero");
  await dialog.getByLabel("Precio extra 2").fill("5");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(`Tacos del combo ${id}`)).toBeVisible();

  await page.getByRole("tab", { name: "Productos" }).click();
  const newProduct = async (name: string) => {
    await page
      .getByRole("button", { name: "Nuevo producto", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nombre en español").fill(name);
    await dialog
      .getByRole("combobox", { name: "Categoría *", exact: true })
      .selectOption({ label: category });
  };
  const addGroup = (label: string) =>
    dialog
      .getByRole("combobox", { name: "Agregar grupo", exact: true })
      .selectOption({ label });
  await newProduct(`Taco al pastor ${id}`);
  await dialog.getByLabel("Precio al cliente (con IVA)").fill("25");
  await addGroup(`Tortilla ${id} · Obligatorio · elige 1`);
  await addGroup(`Extras ${id} · Opcional · hasta 2`);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await newProduct(`Combo taquero ${id}`);
  await dialog.getByRole("radio", { name: "Combo" }).check();
  await dialog.getByLabel("Precio al cliente (con IVA)").fill("99");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog.getByRole("alert").first()).toContainText(
    "Un combo necesita al menos un grupo obligatorio.",
  );
  await addGroup(
    `Tacos del combo ${id} · Obligatorio · elige 3 · puedes repetir`,
  );
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await newProduct(`Varios ${id}`);
  await dialog.getByRole("checkbox", { name: /Precio abierto/ }).check();
  await dialog.getByLabel("Importe máximo permitido").fill("500");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const list = page.locator(".menu-row").filter({ hasText: `Varios ${id}` });
  await expect(list).toContainText("Precio abierto · máx. $500.00");
  await expect(
    page.locator(".menu-row").filter({ hasText: `Combo taquero ${id}` }),
  ).toContainText("Combo");

  // The combo's only required group cannot be archived out from under it.
  await page.getByRole("tab", { name: "Modificadores" }).click();
  await page
    .locator(".menu-group-card")
    .filter({ hasText: `Tacos del combo ${id}` })
    .getByRole("button", { name: "Archivar", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText(
    `es el único grupo obligatorio de Combo taquero ${id}`,
  );
  await expect(
    dialog.getByRole("button", { name: "Archivar", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await sell(page);
  const search = page.getByRole("textbox", { name: "Buscar producto…" });
  await search.fill(id);
  await page
    .locator(".product")
    .filter({ hasText: `Taco al pastor ${id}` })
    .click();
  let picker = page.getByRole("dialog");
  await expect(
    picker.getByRole("button", { name: "Agregar a la orden" }),
  ).toBeDisabled();
  await expect(picker.getByRole("alert")).toHaveText(
    `Falta elegir: Tortilla ${id}`,
  );
  await picker.getByRole("radio", { name: /Harina/ }).check();
  await picker.getByRole("checkbox", { name: /Queso/ }).check();
  await expect(picker.locator(".picker-price")).toHaveText("$40.00");
  await picker.getByRole("button", { name: "Agregar a la orden" }).click();

  await page
    .locator(".product")
    .filter({ hasText: `Combo taquero ${id}` })
    .click();
  picker = page.getByRole("dialog");
  await picker.getByRole("button", { name: "Agregar Pastor" }).click();
  await picker.getByRole("button", { name: "Agregar Pastor" }).click();
  await picker.getByRole("button", { name: "Agregar Suadero" }).click();
  await expect(
    picker.getByRole("button", { name: "Agregar Pastor" }),
  ).toBeDisabled();
  await expect(picker.locator(".picker-price")).toHaveText("$104.00");
  await picker.getByRole("button", { name: "Agregar a la orden" }).click();

  await page
    .locator(".product")
    .filter({ hasText: `Varios ${id}` })
    .click();
  picker = page.getByRole("dialog");
  await expect(picker).toContainText("Máximo $500.00");
  await picker.getByLabel("Importe").fill("600");
  await expect(picker.getByRole("alert")).toHaveText(
    "El importe supera el máximo",
  );
  await picker.getByLabel("Importe").fill("120");
  await picker.getByRole("button", { name: "Agregar a la orden" }).click();

  const cart = page.locator(".cart");
  await expect(cart.locator(".order-line").nth(0)).toContainText(
    "Harina · Queso",
  );
  await expect(cart.locator(".order-line").nth(1)).toContainText(
    "2× Pastor · Suadero",
  );
  await expect(cart.locator(".total strong")).toHaveText("$264.00");
  await page.getByLabel("Nombre para llamar").fill(`Menú ${id}`);
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
    .filter({ hasText: `Menú ${id}` })
    .first();
  await expect(ticket).toContainText("Harina · Queso");
  await expect(ticket).toContainText("2× Pastor · Suadero");
});

test("FIT-4: optional extras are offered in POS and QR ordering", async ({
  page,
  context,
}) => {
  await login(page);
  await sell(page);
  await page.locator(".product").filter({ hasText: "Taco de asada" }).click();
  let picker = page.getByRole("dialog");
  await expect(picker.getByRole("checkbox", { name: /Queso/ })).toBeVisible();
  await picker.getByRole("radio").first().check();
  await expect(picker.locator(".picker-price")).toHaveText("$55.00");
  await picker.getByRole("button", { name: "Agregar a la orden" }).click();
  await page.locator(".product").filter({ hasText: "Taco de asada" }).click();
  picker = page.getByRole("dialog");
  await picker.getByRole("radio").first().check();
  await picker.getByRole("checkbox", { name: /Queso/ }).check();
  await expect(picker.locator(".picker-price")).toHaveText("$70.00");
  await picker.getByRole("button", { name: "Agregar a la orden" }).click();
  const lines = page.locator(".cart .order-line");
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText("$55.00");
  await expect(lines.nth(1)).toContainText("Queso");
  await expect(lines.nth(1)).toContainText("$70.00");
  // The open-price item is sold from the POS grid.
  await expect(
    page
      .locator(".product")
      .filter({ has: page.getByText("Varios", { exact: true }) })
      .first(),
  ).toContainText("Precio abierto");

  const link = await call(page, "/ordering-links", {
    channel: "qr",
    tableId: null,
  });
  expect(link.status).toBe(200);
  const customer = await context.newPage();
  await customer.goto(link.data.path);
  await expect(
    customer.getByRole("heading", { name: "Casa del Bosque · Demo" }),
  ).toBeVisible();
  await expect(customer.getByRole("button", { name: /^Varios/ })).toHaveCount(
    0,
  );
  await customer.getByRole("button", { name: /Taco de asada/ }).click();
  const qrPicker = customer.getByRole("dialog");
  await qrPicker.getByRole("radio").first().check();
  await qrPicker.getByRole("checkbox", { name: /Aguacate/ }).check();
  await expect(qrPicker.locator(".picker-price")).toHaveText("$75.00");
  await qrPicker.getByRole("button", { name: "Agregar a la orden" }).click();
  await expect(customer.locator(".large-money")).toHaveText("$75.00");
  await customer.close();
});

test("manager sets up areas and tables; archived tables leave Mesas; an open check blocks archiving", async ({
  page,
}) => {
  const id = suffix();
  await login(page);
  await openMenu(page);
  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Mesas y áreas" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Nueva área", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nombre del área").fill(`Patio ${id}`);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Agregar varias mesas", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Área" })
    .selectOption({ label: `Patio ${id}` });
  await dialog.getByLabel("Prefijo").fill(`P${id}`);
  await dialog.getByLabel("Hasta").fill("3");
  await expect(dialog).toContainText(
    `Se crearán: P${id} 1 … P${id} 3 (3 mesas)`,
  );
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const section = page
    .locator(".menu-section-list")
    .filter({ hasText: `Patio ${id}` })
    .last();
  await expect(section.locator(".menu-row")).toHaveCount(3);

  // Duplicates reject the whole batch.
  await page
    .getByRole("button", { name: "Agregar varias mesas", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Prefijo").fill(`P${id}`);
  await dialog.getByLabel("Desde").fill("3");
  await dialog.getByLabel("Hasta").fill("4");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Ya existe un elemento activo con ese nombre.",
  );
  await page.keyboard.press("Escape");

  await section
    .locator(".menu-row")
    .filter({ hasText: `P${id} 3` })
    .getByRole("button", { name: `Archivar P${id} 3` })
    .click();
  // Archiving a table asks first (OWNER-7).
  dialog = page.getByRole("dialog", { name: `Archivar P${id} 3` });
  await dialog.getByRole("button", { name: "Archivar", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Cambios guardados");

  const tables = (await call(page, "/tables")).data as any[];
  expect(tables.some((t) => t.name === `P${id} 3`)).toBe(false);
  const first = tables.find((t) => t.name === `P${id} 1`);
  expect(first.area_name).toBe(`Patio ${id}`);
  const catalog = (await call(page, "/catalog")).data as any[];
  const plain = catalog.find((p) => p.name.es === "Taco de hongos");
  const order = await call(page, "/orders", {
    operationId: crypto.randomUUID(),
    lines: [
      {
        id: crypto.randomUUID(),
        productId: plain.id,
        quantity: 1,
        options: [],
        note: "",
      },
    ],
    mode: "dine_in",
    tableId: first.id,
    name: `Mesa ${id}`,
    note: "",
    channel: "pos",
  });
  expect(order.status).toBe(200);
  await page.reload();
  await openMenu(page);
  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  const row = page.locator(".menu-row").filter({ hasText: `P${id} 1` });
  await expect(row).toContainText("Cuenta abierta");
  await expect(
    row.getByRole("button", { name: `Archivar P${id} 1` }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  await expect(
    page.locator(".table-card").filter({ hasText: `P${id} 2` }),
  ).toBeVisible();
  await expect(
    page.locator(".table-card").filter({ hasText: `P${id} 3` }),
  ).toHaveCount(0);
});

test("ingredients: opening stock, recipe link, Negativo badge under allow, blocked sale under block", async ({
  page,
}) => {
  const id = suffix();
  const ingredient = `Chile ${id}`;
  const product = `Salsa macha ${id}`;
  await login(page);
  try {
    await openMenu(page);
    await page.getByRole("button", { name: "Insumos", exact: true }).click();
    await expect(
      page.getByRole("radio", {
        name: /Permitir la venta y marcar la diferencia/,
      }),
    ).toBeChecked();
    await page
      .getByRole("button", { name: "Nuevo insumo", exact: true })
      .click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nombre del insumo").fill(ingredient);
    await dialog
      .getByRole("combobox", { name: "Unidad de inventario" })
      .selectOption("piece");
    await dialog.getByLabel("Existencia inicial").fill("1");
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const row = page
      .locator(".menu-table tbody tr")
      .filter({ hasText: ingredient });
    await expect(row).toContainText("Bien");

    await page.getByRole("button", { name: "Menú", exact: true }).click();
    await page
      .getByRole("button", { name: "Nuevo producto", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nombre en español").fill(product);
    await dialog
      .getByRole("combobox", { name: "Categoría *", exact: true })
      .selectOption({ label: "Antojitos" });
    await dialog.getByLabel("Precio al cliente (con IVA)").fill("30");
    await dialog.getByRole("button", { name: "Agregar insumo" }).click();
    await dialog
      .getByRole("combobox", { name: "Insumo 1", exact: true })
      .selectOption({ label: `${ingredient} (piezas)` });
    await dialog.getByLabel("Cantidad 1").fill("1");
    await expect(dialog).toContainText("= 1 piezas");
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog).not.toBeVisible();

    // Allow (default): selling past zero succeeds and flags the ingredient.
    await sell(page);
    await page.getByRole("textbox", { name: "Buscar producto…" }).fill(product);
    await page.locator(".product").filter({ hasText: product }).click();
    await page.getByRole("button", { name: `Cantidad + ${product}` }).click();
    await page.getByLabel("Nombre para llamar").fill(`Insumos ${id}`);
    await page
      .getByRole("button", { name: "Enviar a cocina", exact: true })
      .click();
    await expect(page.locator(".existing")).toContainText("Enviado a cocina");

    await page
      .getByRole("button", { name: "Menú e inventario", exact: true })
      .click();
    await page.getByRole("button", { name: "Insumos", exact: true }).click();
    await expect(row).toContainText("Negativo");
    await expect(row).toContainText("no indica faltante por sí sola");
    // History: translated causes and the running balance, never internal
    // reason codes such as "dispatch" (MENU-4).
    await row.getByRole("button", { name: "Movimientos", exact: true }).click();
    dialog = page.getByRole("dialog", { name: `Movimientos de ${ingredient}` });
    const sale = dialog.locator("tbody tr").filter({ hasText: "Venta" });
    await expect(sale).toHaveCount(1);
    await expect(sale.locator('td[data-label="Saldo"]')).toHaveText("-1");
    await expect(
      dialog.locator("tbody tr").filter({ hasText: "Existencia inicial" }),
    ).toHaveCount(1);
    await expect(dialog).not.toContainText("dispatch");
    await dialog.getByRole("button", { name: "Cerrar" }).click();
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole("button", { name: "Existencias", exact: true })
      .click();
    await expect(
      page.locator(".stock-grid .panel").filter({ hasText: ingredient }),
    ).toContainText("Negativo");

    // Block: the next sale is refused with the policy copy.
    await page.getByRole("button", { name: "Insumos", exact: true }).click();
    await page.getByRole("radio", { name: /Bloquear la venta/ }).check();
    await expect(page.getByRole("status")).toHaveText("Cambios guardados");
    await sell(page);
    await page
      .getByRole("button", { name: "Nueva orden", exact: true })
      .click();
    await page.getByRole("textbox", { name: "Buscar producto…" }).fill(product);
    await page.locator(".product").filter({ hasText: product }).click();
    await page
      .getByRole("button", { name: "Enviar a cocina", exact: true })
      .click();
    await expect(page.locator(".cart").getByRole("alert")).toContainText(
      "este restaurante bloquea esas ventas",
    );
  } finally {
    const reset = await call(page, "/stock-items/policy", {
      operationId: crypto.randomUUID(),
      policy: "allow",
    });
    expect(reset.status).toBe(200);
  }
});

test("menu editor and picker are accessible and fit at 1440, 1024, 768 and 390 (es and en)", async ({
  page,
}) => {
  await login(page);
  await openMenu(page);
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(page.getByRole("tab", { name: "Productos" })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBeTruthy();
    await page.screenshot({ path: `docs/evidence/menu-products-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await axe(page);

  await page
    .getByRole("button", { name: "Editar Taco de asada", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: "docs/evidence/menu-product-editor-1440.png" });
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBeTruthy();
  await page.screenshot({ path: "docs/evidence/menu-product-editor-390.png" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("tab", { name: "Modificadores" }).click();
  await page
    .getByRole("button", { name: "Editar Tacos del combo", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: "docs/evidence/menu-group-editor-1440.png" });
  await axe(page);
  await page.keyboard.press("Escape");

  for (const view of ["Insumos", "Mesas"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(page.locator(".menu-workspace")).toBeVisible();
    await axe(page);
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      expect(await noHorizontalScroll(page)).toBeTruthy();
      await page.screenshot({
        path: `docs/evidence/menu-${view === "Insumos" ? "stock" : "floor"}-${width}.png`,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }

  // English, then the picker at phone width.
  await page.getByRole("button", { name: "ES", exact: true }).click();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Products" })).toBeVisible();
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBeTruthy();
  await page.screenshot({ path: "docs/evidence/menu-products-390-en.png" });
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await page.getByRole("button", { name: "Sell", exact: true }).click();
  await page.locator(".product").filter({ hasText: "Forest combo" }).click();
  const picker = page.getByRole("dialog");
  await expect(
    picker.getByRole("button", { name: "Add to order" }),
  ).toBeDisabled();
  await picker.getByRole("button", { name: "Add Grilled beef taco" }).click();
  expect(await noHorizontalScroll(page)).toBeTruthy();
  await page.screenshot({ path: "docs/evidence/menu-picker-390-en.png" });
  await axe(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "EN", exact: true }).click();
});

test("MON-3: a management dialog keeps one operation id, so a retry after a lost response does not duplicate", async ({
  page,
}) => {
  const reason = `Hielo ${suffix()}`;
  await login(page);
  await page.getByRole("button", { name: "Finanzas", exact: true }).click();
  await page
    .getByRole("button", { name: "Agregar gasto", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Importe", { exact: true }).fill("800");
  await dialog.getByLabel("Explicación").fill(reason);
  // The first save commits on the server but its response never arrives.
  let lost = false;
  await page.route("**/api/expenses", async (route) => {
    if (route.request().method() === "POST" && !lost) {
      lost = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(lost).toBe(true);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const expenses = (await call(page, "/expenses")).data as any[];
  expect(expenses.filter((e) => e.reason === reason)).toHaveLength(1);
});

/** Reads (or rewrites) the offline cache that App keeps in IndexedDB. */
async function offlineCache(page: Page, offlineUntil?: string) {
  return page.evaluate(
    (offlineUntil) =>
      new Promise<{ offlineUntil: string; catalog: any[] | null }>(
        (resolve, reject) => {
          const open = indexedDB.open("green-monkey-v1");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(
              "cache",
              offlineUntil ? "readwrite" : "readonly",
            );
            const store = tx.objectStore("cache");
            const result = { offlineUntil: "", catalog: null as any[] | null };
            const session = store.get("session");
            session.onsuccess = () => {
              const entry = session.result;
              if (offlineUntil)
                store.put({
                  ...entry,
                  value: { ...entry.value, offlineUntil },
                });
              result.offlineUntil = offlineUntil ?? entry.value.offlineUntil;
            };
            const all = store.getAll();
            all.onsuccess = () => {
              const catalog = all.result.find((e: any) =>
                String(e.id).endsWith(":catalog"),
              );
              result.catalog = catalog?.value ?? null;
            };
            tx.oncomplete = () => {
              db.close();
              resolve(result);
            };
            tx.onerror = () => reject(tx.error);
          };
        },
      ),
    offlineUntil,
  );
}

test("FOH-8: an 86 reaches an open Vender screen through the minute poll, focus and gm-menu-refresh, and only the catalog cache is rewritten", async ({
  page,
}) => {
  // Fake timers (time still flows) so the 60 s poll can be fast-forwarded.
  await page.clock.install();
  await login(page);
  const menu = (await call(page, "/menu")).data as {
    products: { id: string; name: { es: string } }[];
  };
  const brownie = menu.products.find((p) => p.name.es === "Brownie de cacao")!;
  const toggle = async (available: boolean) =>
    expect(
      (
        await call(page, "/menu/products/availability", {
          operationId: crypto.randomUUID(),
          id: brownie.id,
          available,
        })
      ).status,
    ).toBe(200);
  let catalogs = 0;
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === "/api/catalog") catalogs++;
  });
  try {
    // Entering Vender always starts with a revision check. Whether it also
    // refetches depends on whether the brief "sell" render during sign-in
    // already recorded a baseline (MENU-12), so wait for the check and then
    // for the catalog fetches to go quiet instead of counting them.
    const firstCheck = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/menu/revision",
    );
    await sell(page);
    await firstCheck;
    const card = page
      .locator(".product")
      .filter({ hasText: "Brownie de cacao" });
    await expect(card).toBeEnabled();
    await expect
      .poll(async () => {
        const seen = catalogs;
        await page.waitForTimeout(400);
        return catalogs === seen;
      })
      .toBe(true);
    // Simulate access's heartbeat renewing the offline window in the cache;
    // a catalog refresh must never put the login-time session back (MENU-2).
    const renewed = "2999-01-01T00:00:00.000Z";
    await expect
      .poll(async () => {
        await offlineCache(page, renewed);
        await page.waitForTimeout(150);
        return (await offlineCache(page)).offlineUntil;
      })
      .toBe(renewed);

    // 1. The 60 s revision poll, with no view change. Nothing refetches
    // until the poll fires.
    const quiet = catalogs;
    await toggle(false);
    await expect(card).toBeEnabled();
    expect(catalogs).toBe(quiet);
    await page.clock.fastForward(60_000);
    await expect(card).toBeDisabled();
    await expect(card).toContainText("Agotado");
    expect(catalogs).toBe(quiet + 1);

    // 2. Focus (the terminal comes back to the foreground).
    await toggle(true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(card).toBeEnabled();
    await expect(card).not.toContainText("Agotado");

    // 3. gm-menu-refresh (dispatched by Selling after catalog send errors).
    await toggle(false);
    await expect(card).toBeEnabled();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("gm-menu-refresh")),
    );
    await expect(card).toBeDisabled();

    // Still on Vender: no view change was involved.
    await expect(
      page.getByRole("button", { name: "Vender", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    const cache = await offlineCache(page);
    expect(cache.offlineUntil).toBe(renewed);
    expect(
      cache.catalog?.find((p: any) => p.id === brownie.id)?.available,
    ).toBe(false);
  } finally {
    await toggle(true);
  }
});

test('money and quantity entry: "1,200" is $1,200.00 and an ambiguous "25,50" is refused, never read as a decimal', async ({
  page,
}) => {
  const name = `Pastel ${suffix()}`;
  await login(page);
  await openMenu(page);
  await page
    .getByRole("button", { name: "Nuevo producto", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nombre en español").fill(name);
  await dialog
    .getByRole("combobox", { name: "Categoría *", exact: true })
    .selectOption({ label: "Postres" });
  await dialog.getByLabel("Precio al cliente (con IVA)").fill("1,200");
  // The editor shows how the typed text will be saved before saving.
  await expect(dialog.getByText("Se guardará: $1,200.00")).toBeVisible();
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const saved = ((await call(page, "/catalog")).data as any[]).find(
    (p) => p.name.es === name,
  );
  expect(saved.price).toBe(120000);

  await page
    .getByRole("button", { name: `Editar ${name}`, exact: true })
    .click();
  dialog = page.getByRole("dialog");
  for (const typed of ["25,50", "12.505"]) {
    await dialog.getByLabel("Precio al cliente (con IVA)").fill(typed);
    await expect(dialog.getByText(/^Se guardará/)).toHaveCount(0);
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Escribe un importe válido, por ejemplo 1250.50 o 1,250.50.",
    );
    await expect(
      dialog.getByLabel("Precio al cliente (con IVA)"),
    ).toHaveAttribute("aria-invalid", "true");
  }
  // Closing a changed form asks first (OWNER-5); discarding saves nothing.
  await dialog.getByRole("button", { name: "Cerrar" }).click();
  await page
    .getByRole("dialog", { name: "¿Descartar los cambios?" })
    .getByRole("button", { name: "Descartar cambios", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const unchanged = ((await call(page, "/catalog")).data as any[]).find(
    (p) => p.name.es === name,
  );
  expect(unchanged.price).toBe(120000);
  expect(unchanged.version).toBe(saved.version);
});

test("modifier groups: a blank group starts optional, a forced paid extra is flagged, and each bad choice field says what is wrong", async ({
  page,
}) => {
  const name = `Extra queso ${suffix()}`;
  await login(page);
  await openMenu(page);
  await page.getByRole("tab", { name: "Modificadores" }).click();
  await page
    .getByRole("button", { name: "Nuevo grupo de modificadores", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Mínimo a elegir")).toHaveValue("0");
  await expect(dialog.getByText("Regla: Opcional · hasta 1")).toBeVisible();
  await dialog.getByLabel("Nombre del grupo", { exact: true }).fill(name);
  await dialog.getByLabel("Opción 1", { exact: true }).fill("Queso");
  await dialog.getByLabel("Precio extra 1").fill("15");
  const warning = dialog.getByText("Todos los clientes pagarán este extra");
  await expect(warning).toHaveCount(0);
  // Making it required with one priced choice warns that every sale pays it.
  await dialog.getByLabel("Mínimo a elegir").fill("1");
  await expect(warning).toBeVisible();

  // A currency sign in the price: the message names the price, not the rules.
  await dialog.getByLabel("Precio extra 1").fill("$15");
  await dialog.getByRole("button", { name: "Agregar opción" }).click();
  await dialog.getByLabel("Opción 2", { exact: true }).fill("queso");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(
    dialog.getByText("Escribe un precio válido, por ejemplo 15.00"),
  ).toBeVisible();
  await expect(
    dialog.getByText("Ya hay otra opción con este nombre en el grupo."),
  ).toBeVisible();
  await expect(dialog.getByText(/Revisa el grupo/)).toHaveCount(0);
  const price = dialog.getByLabel("Precio extra 1");
  await expect(price).toHaveAttribute("aria-invalid", "true");
  // Invalid fields are visibly marked (red border), not only for screen readers.
  // (Polled: the border color has a 0.12 s transition.)
  await expect
    .poll(() => price.evaluate((el) => getComputedStyle(el).borderTopColor))
    .toBe("rgb(192, 39, 28)");

  await price.fill("15");
  await dialog.getByLabel("Opción 2", { exact: true }).fill("Doble queso");
  await dialog.getByLabel("Mínimo a elegir").fill("0");
  await expect(warning).toHaveCount(0);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.locator(".menu-group-card").filter({ hasText: name }),
  ).toContainText("Opcional · hasta 1");
});

/** Creates a product through the menu API in a demo category. */
async function createProduct(
  page: Page,
  name: string,
  price: number,
  category: string,
  groupIds: string[] = [],
) {
  const menu = (await call(page, "/menu")).data as {
    categories: { id: string; name: { es: string } }[];
  };
  const saved = await call(page, "/menu/products/save", {
    operationId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    expectedVersion: 0,
    name: { es: name, en: "" },
    categoryId: menu.categories.find((c) => c.name.es === category)!.id,
    kind: "item",
    price,
    station: "kitchen",
    groupIds,
  });
  expect(saved.status).toBe(200);
  return saved.data as { id: string; version: number };
}
async function setAvailable(page: Page, id: string, available: boolean) {
  const r = await call(page, "/menu/products/availability", {
    operationId: crypto.randomUUID(),
    id,
    available,
  });
  expect(r.status).toBe(200);
}

test("OWNER-5/OWNER-7: editors ask before dropping unsaved edits, and archiving a product or a table asks first", async ({
  page,
}) => {
  const id = suffix();
  const name = `Gringa ${id}`;
  await login(page);
  await openMenu(page);
  const discard = page.getByRole("dialog", { name: "¿Descartar los cambios?" });

  // A new product: Escape on a changed form asks; "Seguir editando" keeps it.
  await page
    .getByRole("button", { name: "Nuevo producto", exact: true })
    .click();
  const created = page.getByRole("dialog", { name: "Nuevo producto" });
  await created.getByLabel("Nombre en español").fill(name);
  await created
    .getByRole("combobox", { name: "Categoría *", exact: true })
    .selectOption({ label: "Tacos" });
  await created.getByLabel("Precio al cliente (con IVA)").fill("45");
  await page.keyboard.press("Escape");
  await expect(discard).toContainText("Hay cambios sin guardar");
  await discard
    .getByRole("button", { name: "Seguir editando", exact: true })
    .click();
  await expect(discard).toHaveCount(0);
  await expect(created.getByLabel("Precio al cliente (con IVA)")).toHaveValue(
    "45",
  );
  // Escape pressed again and again with no click in between: the browser may
  // stop letting the page keep the editor open, but "Seguir editando" always
  // brings the form back with what was typed.
  await page.keyboard.press("Escape");
  await expect(discard).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(discard).toHaveCount(0);
  await page.keyboard.press("Escape");
  await discard
    .getByRole("button", { name: "Seguir editando", exact: true })
    .click();
  await expect(created).toBeVisible();
  await expect(created.getByLabel("Precio al cliente (con IVA)")).toHaveValue(
    "45",
  );
  await created.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(created).toHaveCount(0);

  // An unchanged editor closes at once; a changed one asks on X and on
  // Duplicar, and discarding leaves the saved product as it was.
  const edit = page.getByRole("dialog", { name: "Editar producto" });
  const open = () =>
    page.getByRole("button", { name: `Editar ${name}`, exact: true }).click();
  await open();
  await edit.getByRole("button", { name: "Cerrar" }).click();
  await expect(edit).toHaveCount(0);
  await open();
  await edit.getByLabel("Precio al cliente (con IVA)").fill("48");
  await edit.getByRole("button", { name: "Duplicar", exact: true }).click();
  await expect(discard).toContainText("no pasan a la copia");
  await discard
    .getByRole("button", { name: "Seguir editando", exact: true })
    .click();
  await expect(edit.getByLabel("Precio al cliente (con IVA)")).toHaveValue(
    "48",
  );
  await edit.getByRole("button", { name: "Cerrar" }).click();
  await discard
    .getByRole("button", { name: "Descartar cambios", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const product = ((await call(page, "/catalog")).data as any[]).find(
    (p) => p.name.es === name,
  );
  expect(product.price).toBe(4500);

  // Archivar asks before hiding the product from the POS and QR menu.
  await open();
  await edit.getByRole("button", { name: "Archivar", exact: true }).click();
  const archive = page.getByRole("dialog", { name: `Archivar ${name}` });
  await expect(archive).toContainText(
    "Se ocultará del punto de venta y del menú QR",
  );
  await archive.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(archive).toHaveCount(0);
  await expect(edit).toBeVisible();
  await edit.getByRole("button", { name: "Archivar", exact: true }).click();
  await archive.getByRole("button", { name: "Archivar", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Cambios guardados");
  expect(
    ((await call(page, "/catalog")).data as any[]).some(
      (p) => p.name.es === name,
    ),
  ).toBe(false);

  // Group editor: a template never silently replaces typed choices, and X
  // asks once something was typed.
  await page.getByRole("tab", { name: "Modificadores" }).click();
  const newGroup = () =>
    page
      .getByRole("button", {
        name: "Nuevo grupo de modificadores",
        exact: true,
      })
      .click();
  const group = page.getByRole("dialog", {
    name: "Nuevo grupo de modificadores",
  });
  const templates = group.getByRole("combobox", { name: "Plantillas" });
  await newGroup();
  // Nothing typed yet: templates apply at once, one after another.
  await templates.selectOption({ label: "Tortilla (maíz / harina)" });
  await templates.selectOption({ label: "Salsa (verde / roja / sin salsa)" });
  await expect(discard).toHaveCount(0);
  await expect(group.getByLabel("Opción 3", { exact: true })).toBeVisible();
  await group.getByRole("button", { name: "Cerrar" }).click();
  await expect(group).toHaveCount(0);
  await newGroup();
  await group
    .getByLabel("Nombre del grupo", { exact: true })
    .fill(`Guisados ${id}`);
  await group.getByLabel("Opción 1", { exact: true }).fill("Chicharrón");
  await templates.selectOption({ label: "Salsa (verde / roja / sin salsa)" });
  await expect(discard).toContainText("La plantilla reemplazará");
  await discard
    .getByRole("button", { name: "Seguir editando", exact: true })
    .click();
  await expect(group.getByLabel("Opción 1", { exact: true })).toHaveValue(
    "Chicharrón",
  );
  await expect(templates).toHaveValue("");
  await group.getByRole("button", { name: "Cerrar" }).click();
  await discard
    .getByRole("button", { name: "Descartar cambios", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Ingredient dialog: Escape on a typed name asks too.
  await page.getByRole("button", { name: "Insumos", exact: true }).click();
  await page.getByRole("button", { name: "Nuevo insumo", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Nuevo insumo" })
    .getByLabel("Nombre del insumo")
    .fill(`Nopal ${id}`);
  await page.keyboard.press("Escape");
  await discard
    .getByRole("button", { name: "Descartar cambios", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A table is archived only after confirming.
  const table = `Barra ${id}`;
  const saved = await call(page, "/floor/tables/save", {
    operationId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    expectedVersion: 0,
    name: table,
    areaId: null,
    seats: null,
  });
  expect(saved.status).toBe(200);
  await page.getByRole("button", { name: "Mesas", exact: true }).click();
  const row = page.locator(".menu-row").filter({ hasText: table });
  await row.getByRole("button", { name: `Archivar ${table}` }).click();
  const confirm = page.getByRole("dialog", { name: `Archivar ${table}` });
  await expect(confirm).toContainText(
    "Ya no se podrá elegir para nuevas órdenes",
  );
  await confirm.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: `Archivar ${table}` }).click();
  await confirm.getByRole("button", { name: "Archivar", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Cambios guardados");
  await expect(row).toHaveCount(0);
});

test("OWNER-4: an 86 made inside an editor shows in the list at once; sold-out choices are marked and switched on the group card", async ({
  page,
}) => {
  const id = suffix();
  await login(page);
  const groupId = crypto.randomUUID();
  const group = `Toppings ${id}`;
  const aguacate = `Aguacate ${id}`;
  const savedGroup = await call(page, "/menu/groups/save", {
    operationId: crypto.randomUUID(),
    id: groupId,
    expectedVersion: 0,
    name: { es: group, en: "" },
    min: 0,
    max: 2,
    repeat: false,
    options: [
      { id: crypto.randomUUID(), name: { es: aguacate, en: "" }, price: 2000 },
      {
        id: crypto.randomUUID(),
        name: { es: `Queso ${id}`, en: "" },
        price: 1500,
      },
    ],
  });
  expect(savedGroup.status).toBe(200);
  const name = `Sope ${id}`;
  const product = await createProduct(page, name, 3500, "Antojitos", [groupId]);
  await openMenu(page);
  const row = page.locator(".menu-row").filter({ hasText: name });
  const listSwitch = row.getByRole("switch", { name: `Disponible: ${name}` });
  await expect(listSwitch).toBeChecked();

  // 1. The switch in the editor header: the list follows without a reload.
  await page
    .getByRole("button", { name: `Editar ${name}`, exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Editar producto" });
  await editor.getByRole("switch", { name: `Disponible: ${name}` }).uncheck();
  await editor.getByRole("button", { name: "Cerrar" }).click();
  await expect(editor).toHaveCount(0);
  await expect(listSwitch).not.toBeChecked();

  // 2. The list switch moves at once, before the server has answered.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/menu/products/availability", async (route) => {
    await held;
    await route.continue();
  });
  const answered = page.waitForResponse((r) =>
    r.url().endsWith("/api/menu/products/availability"),
  );
  await listSwitch.check();
  await expect(listSwitch).toBeChecked();
  release();
  await answered;
  await page.unroute("**/api/menu/products/availability");
  await expect(page.getByRole("status")).toHaveText("Cambios guardados");
  await expect(listSwitch).toBeChecked();

  // 3. A choice 86'd in the group editor is marked on its card, and the
  // editor reopens with the current state.
  await page.getByRole("tab", { name: "Modificadores" }).click();
  const card = page.locator(".menu-group-card").filter({ hasText: group });
  const groupEditor = page.getByRole("dialog", { name: "Editar grupo" });
  await card
    .getByRole("button", { name: `Editar ${group}`, exact: true })
    .click();
  await groupEditor
    .getByRole("switch", { name: `Disponible: ${aguacate}` })
    .uncheck();
  await groupEditor.getByRole("button", { name: "Cerrar" }).click();
  await expect(groupEditor).toHaveCount(0);
  await expect(card.locator(".menu-option-preview")).toContainText(
    `${aguacate} Agotado`,
  );
  await expect(card.locator("summary")).toHaveText(
    "Disponibilidad de opciones · 1 agotadas",
  );
  await card
    .getByRole("button", { name: `Editar ${group}`, exact: true })
    .click();
  await expect(
    groupEditor.getByRole("switch", { name: `Disponible: ${aguacate}` }),
  ).not.toBeChecked();
  await groupEditor.getByRole("button", { name: "Cerrar" }).click();
  await expect(groupEditor).toHaveCount(0);

  // 4. One tap on the card brings it back, like a product in the list.
  await card.locator("summary").click();
  const restored = page.waitForResponse((r) =>
    r.url().endsWith("/api/menu/groups/option-availability"),
  );
  await card.getByRole("switch", { name: `Disponible: ${aguacate}` }).check();
  await expect(card.locator(".menu-option-preview")).not.toContainText(
    "Agotado",
  );
  expect((await restored).status()).toBe(200);
  const menu = (await call(page, "/menu")).data as any;
  expect(
    menu.groups
      .find((g: any) => g.id === groupId)
      .options.every((o: any) => o.available),
  ).toBe(true);
  expect(
    menu.products
      .find((p: any) => p.id === product.id)
      .groups[0].options.every((o: any) => o.available),
  ).toBe(true);
});

test("OWNER-6: an 86 while a product is in the POS cart flags that line with Quitar; the cart never goes blank", async ({
  page,
}) => {
  const name = `Agua de horchata ${suffix()}`;
  await login(page);
  const product = await createProduct(page, name, 3000, "Bebidas");
  try {
    await sell(page);
    const search = page.getByRole("textbox", { name: "Buscar producto…" });
    await search.fill(name);
    await page.locator(".product").filter({ hasText: name }).click();
    await search.fill("Taco de hongos");
    await page
      .locator(".product")
      .filter({ hasText: "Taco de hongos" })
      .click();
    const cart = page.locator(".cart");
    await expect(cart.locator(".order-line")).toHaveCount(2);
    await expect(cart.locator(".total strong")).toHaveText("$75.00");

    // Another terminal 86es it; the next catalog refresh reaches this one.
    await setAvailable(page, product.id, false);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("gm-menu-refresh")),
    );
    const stale = cart.locator(".order-line.line-unavailable");
    await expect(stale).toContainText(name);
    await expect(stale.getByRole("alert")).toHaveText(
      "Ya no está disponible. Quítalo de la orden.",
    );
    await expect(
      cart.locator(".order-line").filter({ hasText: "Taco de hongos" }),
    ).toContainText("$45.00");
    await expect(cart.locator(".total strong")).toHaveText("$45.00");
    const send = page.getByRole("button", {
      name: "Enviar a cocina",
      exact: true,
    });
    await expect(send).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Cobrar", exact: true }),
    ).toBeDisabled();
    await stale.getByRole("button", { name: `Quitar ${name}` }).click();
    await expect(stale).toHaveCount(0);
    await expect(cart.locator(".order-line")).toHaveCount(1);
    await expect(send).toBeEnabled();
  } finally {
    await setAvailable(page, product.id, true);
  }
});

test("OWNER-2/OWNER-11: QR and kiosk pages follow menu changes, flag a stale line, list the choices, and a kiosk reset starts clean", async ({
  page,
  context,
}) => {
  // Fake timers for the whole context (staff, QR and kiosk pages).
  await page.clock.install();
  const id = suffix();
  const tostada = `Tostada ${id}`;
  const agua = `Agua de jamaica ${id}`;
  await login(page);
  const first = await createProduct(page, tostada, 4000, "Antojitos");
  const second = await createProduct(page, agua, 2500, "Bebidas");
  try {
    const qr = await call(page, "/ordering-links", {
      channel: "qr",
      tableId: null,
    });
    const customer = await context.newPage();
    await customer.goto(qr.data.path);
    await expect(
      customer.getByRole("heading", { name: "Casa del Bosque · Demo" }),
    ).toBeVisible();
    // OWNER-11: the order summary lists the chosen options.
    await customer.getByRole("button", { name: /Taco de asada/ }).click();
    const picker = customer.getByRole("dialog");
    await picker.getByRole("radio", { name: /Salsa roja/ }).check();
    await picker.getByRole("checkbox", { name: /Queso/ }).check();
    await picker.getByRole("button", { name: "Agregar a la orden" }).click();
    await expect(customer.locator(".report-row").first()).toContainText(
      "Salsa roja · Queso",
    );
    const grid = customer
      .locator(".product-grid")
      .getByRole("button", { name: new RegExp(tostada) });
    await grid.click();
    await expect(customer.locator(".large-money")).toHaveText("$110.00");

    // OWNER-2: the open page learns about the 86 on its minute poll.
    await setAvailable(page, first.id, false);
    await page.clock.fastForward(60_000);
    await expect(grid).toBeDisabled();
    await expect(grid).toContainText("Agotado");
    const stale = customer.locator(".line-unavailable");
    await expect(stale).toContainText(tostada);
    await expect(stale.getByRole("alert")).toHaveText(
      "Ya no está disponible. Quítalo de la orden.",
    );
    await expect(customer.locator(".large-money")).toHaveText("$70.00");
    const send = customer.getByRole("button", {
      name: "Enviar a cocina",
      exact: true,
    });
    await expect(send).toBeDisabled();
    await stale.getByRole("button", { name: `Quitar ${tostada}` }).click();
    await customer
      .getByRole("textbox", { name: "Nombre para llamar" })
      .fill(`QR ${id}`);
    await send.click();
    await expect(
      customer.getByText("Enviado a cocina", { exact: true }),
    ).toBeVisible();
    await customer.close();

    // Kiosk: an item 86'd before any poll is refused by the server; the page
    // refetches at once and marks the line. The idle reset clears the order
    // and the message for the next customer.
    const kioskLink = await call(page, "/ordering-links", {
      channel: "kiosk",
      tableId: null,
    });
    const kiosk = await context.newPage();
    await kiosk.goto(kioskLink.data.path);
    await kiosk
      .locator(".product-grid")
      .getByRole("button", { name: new RegExp(agua) })
      .click();
    await setAvailable(page, second.id, false);
    await kiosk
      .getByRole("button", { name: "Enviar a cocina", exact: true })
      .click();
    const message = kiosk.locator(".public-ordering > p.error");
    await expect(message).toHaveText(
      "Un producto ya no está disponible. Quítalo de la orden.",
    );
    await expect(kiosk.locator(".line-unavailable")).toContainText(agua);
    await page.clock.fastForward(90_000);
    await expect(message).toHaveCount(0);
    await expect(kiosk.locator(".line-unavailable")).toHaveCount(0);
    await expect(kiosk.locator(".large-money")).toHaveText("$0.00");
    await kiosk.close();
  } finally {
    await setAvailable(page, first.id, true);
    await setAvailable(page, second.id, true);
  }
});
