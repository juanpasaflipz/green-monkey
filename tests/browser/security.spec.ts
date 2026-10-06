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
    // Public ordering (032): an opaque link token in a header, held orders.
    const post = (path: string, body: unknown, headers = {}) =>
      fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": s.csrf,
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const link = await (
      await post("/api/ordering/links", {
        kind: "counter",
        label: "Seguridad " + crypto.randomUUID().slice(0, 5),
      })
    ).json();
    const token = { "x-gm-link-token": link.token };
    const publicMenu = await (
      await fetch("/api/public/menu", { headers: token })
    ).json();
    const product = publicMenu.catalog.find(
      (p: { groups: unknown[]; available: boolean }) =>
        !p.groups.length && p.available,
    );
    const ordersBefore = (
      await (await fetch("/api/service/orders?status=current&limit=100")).json()
    ).items.length;
    const order = (productId: string, price: number) => ({
      operationId: crypto.randomUUID(),
      statusKey: crypto.randomUUID().replace(/-/g, "").slice(0, 22),
      lines: [{ id: crypto.randomUUID(), productId, quantity: 1, options: [] }],
      expectedTotal: price,
    });
    const badProduct = await post(
      "/api/public/orders",
      order("60000000-0000-4000-8002-000000000001", 100),
      token,
    );
    const badProductError = (await badProduct.json()).error;
    const held = await post(
      "/api/public/orders",
      order(product.id, product.price),
      token,
    );
    const hold = await held.json();
    const ordersAfter = (
      await (await fetch("/api/service/orders?status=current&limit=100")).json()
    ).items.length;
    // Clean up: decide the hold, then deactivate the link.
    const inbox = await (await fetch("/api/ordering/inbox")).json();
    for (const h of inbox.holds)
      if (h.label === hold.label)
        await post(`/api/ordering/holds/${h.id}/reject`, {
          operationId: crypto.randomUUID(),
          reason: "other",
        });
    await post(`/api/ordering/links/${link.id}/revoke`, {
      operationId: crypto.randomUUID(),
    });
    const revoked = await (
      await fetch("/api/public/menu", { headers: token })
    ).json();
    const unknown = await (
      await fetch("/api/public/menu", {
        headers: { "x-gm-link-token": "A".repeat(22) },
      })
    ).json();
    const legacyRoute = await fetch("/api/public/" + link.token + "/catalog");
    // SEC-2/SEC-4: without a device paired to that restaurant, a login for
    // another tenant is refused before any PIN counter is touched.
    const unpaired = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: "10000000-0000-4000-8000-000000000002",
        login: "cashier",
        secret: "000000",
      }),
    });
    const unpairedError = (await unpaired.json()).error;
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
    const cashierLink = await fetch("/api/ordering/links", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": cashier.csrf,
      },
      body: JSON.stringify({ kind: "counter", label: "No" }),
    });
    await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: s.tenantId,
        login: "kitchen",
        secret: "654321",
      }),
    });
    const kitchenInbox = await fetch("/api/ordering/inbox");
    return {
      csrf: csrf.status,
      scope: wrongTenant.error === "session_changed",
      costLeak: publicMenu.catalog.some((p: object) => "cost" in p),
      recipeLeak: publicMenu.catalog.some((p: object) => "recipe" in p),
      crossPublic: `${badProduct.status} ${badProductError}`,
      holdOnly: hold.state === "pending" && ordersAfter === ordersBefore,
      revoked: revoked.error,
      unknown: unknown.error,
      legacyRoute: legacyRoute.status,
      cashierLink: cashierLink.status,
      kitchenInbox: kitchenInbox.status,
      unpaired: `${unpaired.status} ${unpairedError}`,
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
    crossPublic: "400 unavailable",
    holdOnly: true,
    revoked: "public_link_invalid",
    unknown: "public_link_invalid",
    legacyRoute: 404,
    cashierLink: 403,
    kitchenInbox: 403,
    unpaired: "401 device_not_paired",
    pin: 200,
    role: "cashier",
    forbidden: 403,
  });
});
