import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { kitchenHygiene } from "./kitchen-hygiene.js";

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

// W3-2: every round a test sends to the kitchen is delivered after it.
kitchenHygiene();

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
  await dialog
    .getByLabel("Gerente que autoriza")
    .selectOption({ label: "Alex Demo" });
  await dialog.getByLabel("PIN del gerente").fill("0000");
  const axe = await new AxeBuilder({ page }).include("dialog").analyze();
  expect(axe.violations).toEqual([]);
  await dialog.getByRole("button", { name: /Anular 1 productos/ }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "PIN de gerente incorrecto o el empleado no es gerente.",
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

test("a check voided from Órdenes while it was the cart in Vender does not stay there with its old balance (restaurant-day A10.14)", async ({
  page,
}) => {
  const name = `Anulada ${Date.now()}`;
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const s = await (await fetch("/api/session")).json();
    const cash = await (await fetch("/api/cash")).json();
    if (!cash || cash.closed_at)
      await fetch("/api/cash/open", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          opening: 50000,
        }),
      });
  });
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await page
    .locator("button.product")
    .filter({ hasText: "Limonada natural" })
    .click();
  await page.getByLabel("Nombre para llamar").fill(name);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect(page.locator(".existing")).toContainText("Limonada natural");
  const number = (await page.locator(".existing strong").innerText()).match(
    /#(\d+)/,
  )![1];
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  const card = page.locator(".order-summary").filter({ hasText: name });
  await card.getByRole("button", { name: "Anular", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Anular productos" });
  await dialog.getByLabel(/Limonada natural/).fill("1");
  await dialog
    .getByLabel("Motivo de la anulación")
    .fill("Cliente cambió de opinión");
  await dialog
    .getByLabel(/^(Confirma con tu PIN|PIN del gerente)/)
    .fill("demo-green-monkey");
  await dialog.getByRole("button", { name: /Anular 1 productos/ }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText("Anulada");
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await expect(
    page.getByText(`La orden #${number} ya se cerró. Empieza una nueva.`),
  ).toBeVisible();
  await expect(page.locator(".existing")).toHaveCount(0);
  await expect(
    page.getByText("La siguiente buena orden empieza aquí."),
  ).toBeVisible();
});

/** The owner on Vender with this device's drawer open (A10.14's setup). */
async function venderWithDrawer(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const s = await (await fetch("/api/session")).json();
    const cash = await (await fetch("/api/cash")).json();
    if (!cash || cash.closed_at)
      await fetch("/api/cash/open", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          opening: 50000,
        }),
      });
  });
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
}

const limonada = (page: Page) =>
  page.locator("button.product").filter({ hasText: "Limonada natural" });
/** "$1,234.50" → 123450 */
const cents = (text: string) =>
  Math.round(Number(text.replace(/[^\d.]/g, "")) * 100);

/** Two rounds of one Limonada each, as the cart's sent check lists them. */
const TWO_ROUNDS = "1 × Limonada natural, 1 × Limonada natural";

/** Sends the cart as a new counter order; returns its id. */
async function sendNew(page: Page, name: string) {
  await page.getByLabel("Nombre para llamar").fill(name);
  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/orders",
  );
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  const order = await (await created).json();
  await expect(page.locator(".existing")).toBeVisible();
  return order.id as string;
}

test("a check partly voided from Órdenes while it was the cart in Vender shows its new balance when Vender comes back (8ee970c open branch, ACC-PR-2)", async ({
  page,
}) => {
  const name = `Parcial ${Date.now()}`;
  await venderWithDrawer(page);
  await limonada(page).click();
  await limonada(page).click();
  await sendNew(page, name);
  const existing = page.locator(".existing p").first();
  await expect(existing).toHaveText("2 × Limonada natural");
  const before = cents(await page.locator(".total strong").innerText());
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  const card = page.locator(".order-summary").filter({ hasText: name });
  await card.getByRole("button", { name: "Anular", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Anular productos" });
  await dialog.getByLabel(/Limonada natural/).fill("1");
  await dialog
    .getByLabel("Motivo de la anulación")
    .fill("Cliente cambió de opinión");
  await dialog
    .getByLabel(/^(Confirma con tu PIN|PIN del gerente)/)
    .fill("demo-green-monkey");
  await dialog.getByRole("button", { name: /Anular 1 productos/ }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  // The check is still open: Vender keeps it, with the balance after the void.
  await expect(existing).toHaveText("1 × Limonada natural");
  await expect(page.locator(".total strong")).toHaveText(
    new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
    }).format(before / 2 / 100),
  );
  await expect(page.getByText(/ya se cerró/)).toHaveCount(0);
});

test("Vender does not re-read its order after a send on Vender itself (f974181, ACC-PR-2)", async ({
  page,
}) => {
  await venderWithDrawer(page);
  await limonada(page).click();
  const reads: string[] = [];
  page.on("request", (r) => {
    if (
      r.method() === "GET" &&
      /^\/api\/orders\/[^/]+$/.test(new URL(r.url()).pathname)
    )
      reads.push(new URL(r.url()).pathname);
  });
  const id = await sendNew(page, `Sin relectura ${Date.now()}`);
  // A second round on the same check, sent from Vender too.
  await limonada(page).click();
  const round = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === `/api/orders/${id}/rounds`,
  );
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await round;
  await expect(page.locator(".existing p").first()).toHaveText(TWO_ROUNDS);
  // Whatever a re-read would have sent, it went before Órdenes' own list.
  const list = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      new URL(r.url()).pathname === "/api/service/orders",
  );
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await list;
  expect(reads).toEqual([]);
});

test("a re-read that answers after Vender sent another round never puts the older check back (ACC-PR-2)", async ({
  page,
}) => {
  await venderWithDrawer(page);
  await limonada(page).click();
  const id = await sendNew(page, `Relectura tardía ${Date.now()}`);
  const existing = page.locator(".existing p").first();
  await expect(existing).toHaveText("1 × Limonada natural");
  // Vender goes off screen and comes back: its re-read reads the check as it
  // is now (one item) and answers only after the next round landed.
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await expect(page.locator(".order-summary").first()).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  await page.route(`**/api/orders/${id}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads++;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  const reread = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      new URL(r.url()).pathname === `/api/orders/${id}`,
  );
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await expect.poll(() => reads).toBe(1);
  await limonada(page).click();
  const round = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === `/api/orders/${id}/rounds`,
  );
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await round;
  await expect(existing).toHaveText(TWO_ROUNDS);
  release();
  await reread;
  // Let the late answer reach Vender before reading the cart again.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  await expect(existing).toHaveText(TWO_ROUNDS);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
