import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { kitchenHygiene } from "./kitchen-hygiene.js";
async function login(page: any) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
// W3-2: every round a test sends to the kitchen is delivered after it, and
// every offline sale it leaves in the kitchen review lane is decided (FLK-R3).
kitchenHygiene();

test("one of three items is paid once and stays allocated after refresh", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  await page.getByRole("button", { name: "Abrir caja", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  const order = await page.evaluate(async () => {
    const s = await (await fetch("/api/session")).json();
    const cat = await (await fetch("/api/catalog")).json();
    const product = cat.find((p: any) => p.name.es === "Taco de hongos");
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        lines: [
          {
            id: crypto.randomUUID(),
            productId: product.id,
            quantity: 3,
            options: [],
            note: "",
          },
        ],
        mode: "dine_in",
        tableId: null,
        name: "Item split test " + Date.now(),
        note: "",
        channel: "pos",
      }),
    });
    if (!response.ok) throw Error("create_failed");
    return response.json();
  });
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await page
    .locator(".order-summary")
    .filter({ hasText: order.name })
    .getByRole("button", { name: "Mesa y mesero", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Seleccionar mesa", exact: true })
    .selectOption({ label: "Mesa 02" });
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Mesero responsable", exact: true })
    .selectOption({ label: "Dani Demo" });
  await page
    .getByRole("dialog")
    .getByLabel("Explicación", { exact: true })
    .fill("Cambio de mesa solicitado");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.locator(".order-summary").filter({ hasText: order.name }),
  ).toContainText("Mesa 02 · Dani Demo");

  await page
    .locator(".order-summary")
    .filter({ hasText: order.name })
    .getByRole("button", { name: "Abrir orden", exact: true })
    .click();
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await page
    .getByRole("button", { name: "Dividir por productos", exact: true })
    .click();
  await page.getByRole("checkbox", { name: /Taco de hongos · 1/ }).check();
  await expect(
    page.getByRole("dialog").getByLabel("Importe", { exact: true }),
  ).toHaveValue("45.00");
  // The payment commits but its response is lost, and so is the client's one
  // automatic idempotent retry, so the recovery path is exercised.
  let paymentCalls = 0;
  await page.route(
    "**/api/orders/*/payments",
    async (route) => {
      if (++paymentCalls === 1) {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
      }
      await route.abort("failed");
    },
    { times: 2 },
  );
  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText(/Hay un pago anterior por confirmar/),
  ).toBeVisible();
  // Wait until the lost request and its retry have both failed.
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page.screenshot({ path: "docs/evidence/payment-recovery-1440.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: /Conectado/ }).click();
  await expect(
    page.getByRole("heading", { name: /Pago por confirmar/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Consultar estado", exact: true })
    .click();
  await expect(page.getByText(/El servidor ya registró este mismo pago/)).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Recibo", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cerrar", exact: true })
    .click();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await page
    .getByRole("button", { name: "Dividir por productos", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: /Taco de hongos · 1/ }),
  ).toBeDisabled();
  await page.getByRole("checkbox", { name: /Taco de hongos · 2/ }).check();
  await page.getByRole("checkbox", { name: /Taco de hongos · 3/ }).check();
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(
      page.getByRole("button", { name: "Confirmar cobro", exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: `docs/evidence/split-items-${width}.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  const audit = await new AxeBuilder({ page })
    .include("dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(audit.violations).toEqual([]);

  await page
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Recibo", exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(
    async (id) => (await fetch("/api/orders/" + id)).json(),
    order.id,
  );
  expect(result.paid).toBe(13500);
  expect(result.tenders).toHaveLength(2);
  expect(result.paymentUnits.every((u: any) => u.due === 0)).toBe(true);
  expect(result.rounds).toHaveLength(1);
  expect(result.tableName).toBe("Mesa 02");
  expect(result.waiterName).toBe("Dani Demo");
  expect(result.serviceVersion).toBe(1);
});
test("restaurant configuration persists and English labels remain usable", async ({
  page,
}) => {
  await login(page);
  const original = await page.evaluate(async () =>
    (await fetch("/api/restaurant")).json(),
  );
  try {
    await page
      .getByRole("button", { name: "Configuración", exact: true })
      .click();
    const plan = page.getByRole("region", { name: "Plan y suscripción" });
    await expect(plan).toContainText("799.00");
    await expect(plan).toContainText("7,990.00");
    await expect(plan).toContainText("1,598.00");
    await expect(plan).toContainText("sin cargo por empleado");
    await expect(
      page.getByRole("combobox", { name: "Moneda", exact: true }),
    ).toBeDisabled();
    await page
      .getByLabel("Sucursal", { exact: true })
      .fill("Casa del Bosque · Settings test");
    await page
      .getByRole("combobox", { name: "Zona horaria", exact: true })
      .selectOption("UTC");
    await page
      .getByLabel("Cierre del día de negocio", { exact: true })
      .fill("05:30");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(
      page.getByText("Configuración guardada", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".scope strong")).toHaveText(
      "Casa del Bosque · Settings test",
    );
    await page.reload();
    await page
      .getByRole("button", { name: "Configuración", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Zona horaria", exact: true }),
    ).toHaveValue("UTC");
    await expect(
      page.getByLabel("Cierre del día de negocio", { exact: true }),
    ).toHaveValue("05:30");
    await page.getByRole("button", { name: "ES", exact: true }).click();
    await expect(page.getByRole("region", { name: "Plan and subscription" }))
      .toContainText("annually, paid upfront");
    await expect(
      page.getByRole("heading", { name: "Restaurant details", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "docs/evidence/settings-en-1440.png" });
  } finally {
    await page.evaluate(async (old) => {
      const s = await (await fetch("/api/session")).json();
      const current = await (await fetch("/api/restaurant")).json();
      const response = await fetch("/api/restaurant", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedVersion: current.version,
          name: old.name,
          currency: old.currency,
          timezone: old.timezone,
          cutoff: old.cutoff,
          openingDays: old.openingDays,
        }),
      });
      if (!response.ok) throw Error("restore_settings_failed");
    }, original);
  }
});
