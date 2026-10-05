import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const tenantId =
  process.env.DEMO_TENANT_ID ?? "10000000-0000-4000-8000-000000000001";

/** Pairs this browser as an owner device, then signs in the kitchen employee. */
async function kitchenScreen(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  const status = await page.evaluate(async (tenantId) => {
    const s = await (await fetch("/api/session")).json();
    await fetch("/api/logout", {
      method: "POST",
      headers: { "x-csrf-token": s.csrf },
    });
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, login: "kitchen", secret: "654321" }),
    });
    return r.status;
  }, tenantId);
  expect(status).toBe(200);
  await page.goto("/app");
  await expect(page.getByRole("group", { name: "Estación" })).toBeVisible();
}

/** A separate owner browser context, so the kitchen screen's own session is untouched. */
async function ownerPage(browser: Browser, baseURL: string) {
  const page = await browser.newPage({ baseURL });
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  return page;
}
async function createOrder(
  owner: Page,
  name: string,
  productName = "Taco de asada",
) {
  return owner.evaluate(
    async ({ name, productName }) => {
      const s = await (await fetch("/api/session")).json();
      const catalog = await (await fetch("/api/catalog")).json();
      const p = catalog.find((x: any) => x.name.es === productName);
      const options = p.groups.length ? [p.groups[0].options[0].id] : [];
      const r = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          lines: [
            {
              id: crypto.randomUUID(),
              productId: p.id,
              quantity: 2,
              options,
              note: "Sin cebolla",
            },
          ],
          mode: "takeaway",
          tableId: null,
          name,
          note: "",
          channel: "pos",
        }),
      });
      if (!r.ok) throw new Error("order " + r.status);
      return r.json();
    },
    { name, productName },
  );
}
const tag = () =>
  "kds" +
  Array.from(String(Date.now() % 1e8), (d) => "abcdefghij"[Number(d)]).join("");

test("kitchen display persists station, alerts new tickets and recalls a bump", async ({
  page,
  browser,
  baseURL,
}) => {
  await kitchenScreen(page);
  await page.getByRole("radio", { name: "Barra" }).check();
  await page.reload();
  await expect(page.getByRole("radio", { name: "Barra" })).toBeChecked();
  await page.getByRole("radio", { name: "Todas" }).check();
  await expect(page.getByText(/Última actualización/)).toBeVisible();
  const owner = await ownerPage(browser, baseURL!);
  try {
    const name = "Nuevo " + tag();
    const order = await createOrder(owner, name);
    const ticket = page.locator(".kitchen-ticket").filter({ hasText: name });
    await expect(ticket).toBeVisible({ timeout: 15000 });
    await expect(ticket).toHaveClass(/ticket-new/);
    await expect(ticket).toContainText("Nuevo");
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: `Nuevo ticket #${order.number}, ronda 1` }),
    ).toHaveCount(1);
    await ticket.getByRole("button", { name: "Confirmar recepción" }).click();
    await ticket.getByRole("button", { name: "Marcar listo" }).click();
    await ticket.getByRole("button", { name: "Marcar entregado" }).click();
    await expect(ticket).toHaveCount(0);
    await page
      .getByRole("button", { name: /Entregados recientes \(\d+\)/ })
      .click();
    const recent = page.getByRole("dialog");
    const row = recent
      .locator("li")
      .filter({ hasText: `#${order.number} · ${name}` });
    await row.getByRole("button", { name: "Regresar a pantalla" }).click();
    await expect(recent).toBeHidden();
    await expect(ticket).toBeVisible();
    await expect(ticket).toContainText("Listo");
    await expect(
      ticket.getByRole("button", { name: "Marcar entregado" }),
    ).toBeVisible();
  } finally {
    await owner.close();
  }
});

test("kitchen polling is single-flight and backs off", async ({ page }) => {
  await kitchenScreen(page);
  let inFlight = 0,
    maxInFlight = 0,
    requests = 0,
    fail = false;
  await page.route("**/api/service/kitchen*", async (route) => {
    requests++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (fail) {
        await route.abort("failed");
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
      await route.continue();
    } finally {
      inFlight--;
    }
  });
  await page.waitForTimeout(12000);
  expect(maxInFlight).toBe(1);
  expect(requests).toBeGreaterThan(0);
  expect(requests).toBeLessThanOrEqual(4);
  fail = true;
  await expect(
    page.getByRole("alert").filter({ hasText: "Sin actualizar desde" }),
  ).toBeVisible({
    timeout: 25000,
  });
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "los tickets pueden estar desactualizados" }),
  ).toBeVisible();
});

test("kitchen ticket prints through the browser print path", async ({
  page,
  browser,
  baseURL,
}) => {
  await kitchenScreen(page);
  const owner = await ownerPage(browser, baseURL!);
  try {
    const name = "Comanda " + tag();
    const order = await createOrder(owner, name);
    const ticket = page.locator(".kitchen-ticket").filter({ hasText: name });
    await expect(ticket).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => {
      (window as any).__printed = [];
      window.print = () => {
        const root = document.getElementById("print-root")!;
        (window as any).__printed.push({
          text: root.innerText,
          html: root.innerHTML,
        });
      };
    });
    await ticket.getByRole("button", { name: "Imprimir comanda" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__printed.length))
      .toBe(1);
    const job = await page.evaluate(() => (window as any).__printed[0]);
    expect(job.text).toContain(`#${order.number}`);
    expect(job.text).toContain("Salsa verde");
    expect(job.text).toContain("Sin cebolla");
    // Render the captured job as the print medium shows it, for evidence.
    await page.evaluate((html) => {
      const root = document.getElementById("print-root")!;
      root.innerHTML = html;
      document.body.classList.add("printing-doc");
    }, job.html);
    await page.emulateMedia({ media: "print" });
    await page.screenshot({ path: "docs/evidence/kitchen-ticket-80mm.png" });
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => {
      document.getElementById("print-root")!.replaceChildren();
      document.body.classList.remove("printing-doc");
    });
  } finally {
    await owner.close();
  }
});

test("manager clears previous-day tickets", async () => {
  // The server exposes no business-date control, so previous-day tickets cannot
  // be created through the browser. tests/service-db.ts covers clear-stale
  // ("clear stale completes only previous-day rounds and acknowledges their voids").
  test.skip(
    true,
    "covered by the isolated DB suite; no browser date control exists",
  );
});

test("kitchen display has no accessibility violations", async ({ page }) => {
  await kitchenScreen(page);
  await expect(page.getByText(/Última actualización/)).toBeVisible();
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
});
