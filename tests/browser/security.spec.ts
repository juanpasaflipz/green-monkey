import { test, expect, type Page } from "@playwright/test";
async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
/** Authenticated JSON call from the page (GET without a body). */
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
/**
 * LD-P9: as the owner, rejects every hold the codes labelled with this run's
 * id received and deactivates those codes.
 */
async function closeOrderingLinks(page: Page, runId: string) {
  const who = await call(page, "/session").catch(() => null);
  if (who?.data?.role !== "owner") {
    await page.evaluate(() => fetch("/api/logout", { method: "POST" }));
    await login(page);
  }
  const inbox = await call(page, "/ordering/inbox");
  for (const h of (inbox.data?.holds ?? []) as {
    id: string;
    linkLabel: string;
  }[])
    if (h.linkLabel.includes(runId))
      await call(page, `/ordering/holds/${h.id}/reject`, {
        operationId: crypto.randomUUID(),
        reason: "other",
      });
  const links = await call(page, "/ordering/links");
  for (const l of (links.data?.links ?? []) as {
    id: string;
    label: string;
    revokedAt: string | null;
  }[])
    if (!l.revokedAt && l.label.includes(runId))
      await call(page, `/ordering/links/${l.id}/revoke`, {
        operationId: crypto.randomUUID(),
      });
}
test("device PIN, server permission, CSRF and public capability isolation", async ({
  page,
}) => {
  await login(page);
  const runId = crypto.randomUUID().slice(0, 5);
  const staff = await page.evaluate(async () => {
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
    return {
      csrf: csrf.status,
      scope: wrongTenant.error === "session_changed",
    };
  });
  // Public ordering (032): an opaque link token in a header, held orders. The
  // code and every hold it received are undone in the finally (LD-P9).
  let token: string;
  let capability: Record<string, unknown>;
  try {
    const link = await call(page, "/ordering/links", {
      kind: "counter",
      label: `Seguridad ${runId}`,
    });
    expect(link.status, JSON.stringify(link.data)).toBe(200);
    token = link.data.token;
    capability = await page.evaluate(async (linkToken) => {
      const s = await (await fetch("/api/session")).json();
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
      const token = { "x-gm-link-token": linkToken };
      const publicMenu = await (
        await fetch("/api/public/menu", { headers: token })
      ).json();
      const product = publicMenu.catalog.find(
        (p: { groups: unknown[]; available: boolean }) =>
          !p.groups.length && p.available,
      );
      const ordersBefore = (
        await (
          await fetch("/api/service/orders?status=current&limit=100")
        ).json()
      ).items.length;
      const order = (productId: string, price: number) => ({
        operationId: crypto.randomUUID(),
        statusKey: crypto.randomUUID().replace(/-/g, "").slice(0, 22),
        lines: [
          { id: crypto.randomUUID(), productId, quantity: 1, options: [] },
        ],
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
        await (
          await fetch("/api/service/orders?status=current&limit=100")
        ).json()
      ).items.length;
      return {
        costLeak: publicMenu.catalog.some((p: object) => "cost" in p),
        recipeLeak: publicMenu.catalog.some((p: object) => "recipe" in p),
        crossPublic: `${badProduct.status} ${badProductError}`,
        holdOnly: hold.state === "pending" && ordersAfter === ordersBefore,
      };
    }, token);
  } finally {
    // Decide the hold, then deactivate the code.
    await closeOrderingLinks(page, runId);
  }
  let sessions: Record<string, unknown> | undefined;
  try {
    sessions = await page.evaluate(
      async ({ linkToken, runId }) => {
        const s = await (await fetch("/api/session")).json();
        const token = { "x-gm-link-token": linkToken };
        const revoked = await (
          await fetch("/api/public/menu", { headers: token })
        ).json();
        const unknown = await (
          await fetch("/api/public/menu", {
            headers: { "x-gm-link-token": "A".repeat(22) },
          })
        ).json();
        const legacyRoute = await fetch(
          "/api/public/" + linkToken + "/catalog",
        );
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
          body: JSON.stringify({ kind: "counter", label: `No ${runId}` }),
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
      },
      { linkToken: token, runId },
    );
  } finally {
    // The cashier is refused and creates nothing; should a regression let the
    // code through, the owner deactivates it here (LD-P9).
    if (sessions?.cashierLink !== 403) await closeOrderingLinks(page, runId);
  }
  expect({ ...staff, ...capability, ...sessions }).toEqual({
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
