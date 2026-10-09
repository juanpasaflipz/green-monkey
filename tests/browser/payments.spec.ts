import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { kitchenHygiene } from "./kitchen-hygiene.js";

// Payments (037), phase P1 (spec §12.3 items 5, 9 and the P1 parts of 1, 6, 8): named manual
// terminals with a fee, delivery platforms with a commission and per-platform prices (LD-72),
// the "Pagado por plataforma" tender, the drawer by terminal and platform, and the CFDI
// platform FormaPago. The demo owner "Alex Demo" configures and sells. Every setting the spec
// changes is undone at the end, so later specs see the demo restaurant as before.
const OWNER_PASSWORD = "demo-green-monkey";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const tag = () => "pay" + Math.random().toString(36).slice(2, 7);
kitchenHygiene();

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
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
const uuid = () => crypto.randomUUID();
async function openDrawer(page: Page, opening = 50000) {
  const current = await call(page, "/cash");
  if (!current || current.closed_at)
    await call(page, "/cash/open", { operationId: uuid(), opening });
}
async function axe(page: Page, selector: string) {
  const result = await new AxeBuilder({ page })
    .include(selector)
    .withTags(AXE_TAGS)
    .analyze();
  expect(result.violations).toEqual([]);
}

test("Configuración: a terminal with its fee, a platform's commission and a product's Uber Eats price; a platform sale and a named-terminal sale; the drawer splits them; all undone at the end", async ({
  page,
}) => {
  const terminal = "BBVA " + tag();
  await login(page);
  await openDrawer(page);
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  const panel = page.locator("section.payment-settings");
  await expect(panel).toContainText("Pagos con tarjeta y plataformas");
  // A manual bank terminal with its fee (1.75 %).
  await panel
    .getByLabel("Nombre de la terminal", { exact: true })
    .fill(terminal);
  await panel.getByLabel("Comisión (% con IVA)", { exact: true }).fill("1.75");
  await panel
    .getByRole("button", { name: "Agregar terminal", exact: true })
    .click();
  const row = panel.locator("tr").filter({ hasText: terminal });
  await expect(row).toContainText("1.75 %");
  await expect(row).toContainText("Manual");
  // Platforms are off until the owner turns them on (LD-75): Uber Eats on, and DiDi Food's
  // estimated commission.
  await expect(
    panel.getByLabel("Uber Eats", { exact: true }),
  ).not.toBeChecked();
  await expect(panel.getByLabel("Otra", { exact: true })).not.toBeChecked();
  await panel.getByLabel("Uber Eats", { exact: true }).check();
  await panel
    .getByLabel("Comisión estimada (%) · DiDi Food", { exact: true })
    .fill("25");
  await panel
    .getByRole("button", { name: "Guardar plataformas", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("Guardado");
  // Taco de hongos sells at $59.00 on Uber Eats.
  await panel
    .getByLabel("Buscar producto", { exact: true })
    .fill("Taco de hongos");
  await panel
    .getByLabel("Taco de hongos · Uber Eats", { exact: true })
    .fill("59");
  await panel
    .getByRole("button", { name: "Guardar precios", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("Guardado");
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await axe(page, "section.payment-settings");
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // An order rung at Uber Eats prices, paid by the platform.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await go(page, "Vender");
  await page
    .getByRole("combobox", { name: "Precios", exact: true })
    .selectOption({ label: "Uber Eats" });
  await page
    .getByRole("button", { name: /Taco de hongos/ })
    .first()
    .click();
  await expect(page.locator(".cart-lines")).toContainText("$59.00");
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Plataforma", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(dialog).toContainText(
    "La plataforma cubre todo el saldo: $59.00. Sin propina.",
  );
  await expect(dialog.getByLabel("Propina", { exact: true })).toHaveCount(0);
  // Uber Eats needs its order number (LD-75).
  await dialog.getByLabel("La plataforma ya cobró este pedido").check();
  await expect(
    dialog.getByRole("button", { name: "Confirmar cobro", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Número de pedido de la plataforma", { exact: true })
    .fill("UE-1");
  await axe(page, "dialog");
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Pagado en Uber Eats");
  await expect(page.locator(".receipt")).toContainText("UE-1");
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();

  // A card sale recorded on the named terminal.
  await page
    .getByRole("button", { name: /Taco de hongos/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Terminal externa", exact: true })
    .click();
  await dialog.getByRole("button", { name: terminal, exact: true }).click();
  await dialog.getByLabel("Referencia de aprobación").fill("4471");
  await dialog.getByLabel("Confirmo que la terminal aprobó este pago").check();
  await axe(page, "dialog");
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText(`Tarjeta · ${terminal}`);
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();

  // Caja: the platform money is apart from cash and card; card money by terminal.
  await go(page, "Caja");
  const platforms = page
    .locator(".drawer-card")
    .filter({ hasText: "Pagado por plataformas" });
  await expect(platforms).toContainText("Uber Eats");
  await expect(platforms).toContainText("$59.00");
  const byTerminal = page.locator("table").filter({ hasText: terminal });
  await expect(byTerminal).toContainText("Tarjeta por terminal");
  await expect(byTerminal).toContainText("$45.00");

  // Undo: archive the terminal, clear the price, turn Uber Eats off and clear DiDi's commission
  // (both platforms back to their default: off).
  const view = await call(page, "/payments/settings");
  const created = view.terminals.find((t: any) => t.name === terminal);
  await call(page, `/payments/terminals/${created.id}/archive`, {
    operationId: uuid(),
    expectedVersion: created.version,
  });
  const catalog = await call<any[]>(page, "/catalog");
  const taco = catalog.find((p) => p.name.es === "Taco de hongos");
  const price = view.prices.find(
    (p: any) => p.productId === taco.id && p.platform === "uber_eats",
  );
  await call(page, "/payments/platform-prices", {
    operationId: uuid(),
    prices: [
      {
        productId: taco.id,
        platform: "uber_eats",
        price: null,
        expectedVersion: price.version,
      },
    ],
  });
  await call(page, "/payments/platforms", {
    operationId: uuid(),
    platforms: ["didi_food", "uber_eats"].map((code) => ({
      platform: code,
      enabled: false,
      commissionBp: null,
      expectedVersion: view.platforms.find((p: any) => p.platform === code)
        .version,
    })),
  });
  const after = await call<any[]>(page, "/catalog");
  expect(after.some((p) => p.platformPrices)).toBe(false);
});

test("CFDI: the platform FormaPago select offers 31 (recommended), 03, 04 and 28 and never 99", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  const settings = await call(page, "/cfdi/settings").catch(() => null);
  test.skip(
    !settings?.settings,
    "CFDI is not activated for the demo restaurant in this run",
  );
  const select = page.getByRole("combobox", {
    name: "Forma de pago SAT para pedidos pagados por plataforma",
    exact: true,
  });
  await expect(select).toBeVisible();
  const options = await select.locator("option").allTextContents();
  expect(options.map((o) => o.slice(0, 2))).toEqual(["31", "03", "04", "28"]);
  expect(options[0]).toContain("recomendado");
  expect(options.join(" ")).not.toContain("99");
});
