import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const tenantId = "10000000-0000-4000-8000-000000000001";

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

test("cashier voids an item with manager approval and the kitchen acknowledges it", async ({
  page,
}) => {
  const name = `Anulación ${Date.now()}`;
  // The owner pairs this browser as a device, then creates a two-unit order.
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  const product = await page.evaluate(async (orderName) => {
    const s = await (await fetch("/api/session")).json();
    const catalog = await (await fetch("/api/catalog")).json();
    const p = catalog.find(
      (p: any) =>
        p.station === "kitchen" &&
        !p.groups.length &&
        p.available &&
        !p.openAmount,
    );
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
            options: [],
            note: "",
          },
        ],
        mode: "takeaway",
        tableId: null,
        name: orderName,
        note: "",
        channel: "pos",
      }),
    });
    if (!r.ok) throw new Error("order " + r.status);
    return p.name.es as string;
  }, name);

  await switchEmployee(page, "cashier", "123456");
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  const card = page.locator(".order-summary").filter({ hasText: name });
  await card.getByRole("button", { name: "Anular", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Anular productos");
  await dialog.getByLabel(new RegExp(product)).fill("1");
  await dialog
    .getByLabel("Motivo de la anulación")
    .fill("Cliente cambió de opinión");
  await dialog.getByLabel("Regresar ingredientes al inventario").check();
  await dialog.getByLabel("Usuario del gerente").fill("owner");
  await dialog.getByLabel("PIN del gerente").fill("0000");
  const axe = await new AxeBuilder({ page }).include("dialog").analyze();
  expect(axe.violations).toEqual([]);
  await dialog.getByRole("button", { name: /Anular 1 productos/ }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Usuario o PIN de gerente incorrecto.",
  );
  await dialog.getByLabel("PIN del gerente").fill("demo-green-monkey");
  await dialog.getByRole("button", { name: /Anular 1 productos/ }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText(`1 ${product}`);
  // service (024): the void history moved from the row into the order detail.
  await expect(
    card.getByRole("button", { name: "Anular", exact: true }),
  ).toBeVisible();
  await expect(card).toContainText("Cocina aún no confirma");
  await card.getByRole("button", { name: "Detalle", exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("Anulaciones (1)");
  await expect(detail).toContainText("autorizó Alex Demo");
  await expect(detail).toContainText("Cocina aún no confirma");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  await switchEmployee(page, "kitchen", "654321");
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: name });
  const alert = ticket.locator(".void-alert");
  await expect(alert).toContainText("Cancelado");
  await expect(alert).toContainText(`1 × ${product}`);
  await ticket.screenshot({ path: "docs/evidence/void-kitchen-ticket.png" });
  await ticket
    .getByRole("button", { name: "Enterado de la cancelación" })
    .click();
  await expect(alert).toBeHidden();
  await expect(ticket).toContainText(`1 × ${product}`);
});
