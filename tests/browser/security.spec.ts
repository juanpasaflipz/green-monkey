import { test, expect } from "@playwright/test";
test("device PIN, server permission, CSRF and public capability isolation", async ({
  page,
}) => {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    const s = await (await fetch("/api/session")).json();
    const cat = await (await fetch("/api/catalog")).json();
    const csrf = await fetch("/api/cash/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: crypto.randomUUID(), opening: 0 }),
    });
    const wrongTenant = await (
      await fetch("/api/catalog", {
        headers: { "x-tenant-id": "10000000-0000-4000-8000-000000000002" },
      })
    ).json();
    const access = await (
      await fetch("/api/ordering-links", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        body: JSON.stringify({ channel: "qr", tableId: null }),
      })
    ).json();
    const token = access.path.split("/").pop();
    const publicCatalog = await (
      await fetch("/api/public/" + token + "/catalog")
    ).json();
    const badProduct = await fetch("/api/public/" + token + "/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        lines: [
          {
            id: crypto.randomUUID(),
            productId: "60000000-0000-4000-8002-000000000001",
            quantity: 1,
            options: [],
            note: "",
          },
        ],
        mode: "takeaway",
        tableId: null,
        name: "",
        note: "",
        channel: "qr",
      }),
    });
    const pin = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: s.tenantId,
        login: "cashier",
        secret: "123456",
      }),
    });
    const cashier = await (await fetch("/api/session")).json();
    const forbidden = await fetch("/api/team/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": cashier.csrf,
      },
      body: "{}",
    });
    return {
      csrf: csrf.status,
      scope: wrongTenant[0].id === cat[0].id,
      costLeak: "cost" in publicCatalog.catalog[0],
      recipeLeak: "recipe" in publicCatalog.catalog[0],
      crossPublic: badProduct.status,
      pin: pin.status,
      role: cashier.role,
      forbidden: forbidden.status,
    };
  });
  expect(result).toEqual({
    csrf: 403,
    scope: true,
    costLeak: false,
    recipeLeak: false,
    crossPublic: 400,
    pin: 200,
    role: "cashier",
    forbidden: 403,
  });
});
