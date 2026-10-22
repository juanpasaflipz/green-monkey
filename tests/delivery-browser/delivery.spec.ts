import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
// Isolated component harness served by Vite; all requests use synthetic fixtures.
// No existing merchant login or database is used.
test("delivery consent, connection, store confirmation and disconnect @cross", async ({
  page,
}) => {
  let state = "disconnected";
  const commands: unknown[] = [];
  const result = () => ({
    available: ["uber_eats"],
    pro: true,
    connections: [
      {
        provider: "uber_eats",
        state,
        generation: 1,
        stores: [{ id: "cafe", name: "Synthetic Cafe" }],
        store: null,
        lastSyncedAt: null,
        errorCode: null,
        loginExpiresAt: new Date(Date.now() + 600000).toISOString(),
      },
    ],
    days: [],
  });
  await page.route("**/api/delivery**", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = req.postDataJSON();
      commands.push(body);
      if (body.action === "connect") state = "awaiting_login";
      else if (body.action === "verify") state = "choose_store";
      else if (body.action === "select") state = "connected";
      else if (body.action === "disconnect") state = "disconnected";
      else throw Error("Unexpected command envelope");
    }
    await route.fulfill({ json: result() });
  });
  await page.goto("/tests/fixtures/delivery/harness.html");
  const card = page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Uber Eats", exact: true }),
    });
  await expect(
    card.getByRole("button", { name: "Conectar", exact: true }),
  ).toBeDisabled();
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "Conectar", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Abrir inicio de sesión" }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Ya inicié sesión" }).click();
  await expect(card.getByRole("combobox")).toHaveValue("cafe");
  await card.getByRole("button", { name: "Confirmar tienda" }).click();
  await expect(card.getByRole("status")).toHaveText("Conectada");
  await card.getByRole("button", { name: "Desconectar", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Sin conectar");
  expect(commands).toEqual([
    { action: "connect", consent: "delivery-reports-v1" },
    { action: "verify", generation: 1 },
    { action: "select", generation: 1, storeId: "cafe" },
    { action: "disconnect" },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const axe = await new AxeBuilder({ page })
    .include(".delivery-connections")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
});
