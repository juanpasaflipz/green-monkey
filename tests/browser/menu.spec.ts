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
