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

test("an order note edited after sending alerts the ticket the cook already saw", async ({
  page,
  browser,
  baseURL,
}) => {
  await kitchenScreen(page);
  const owner = await ownerPage(browser, baseURL!);
  try {
    const name = "Nota " + tag();
    const order = await createOrder(owner, name);
    const ticket = page.locator(".kitchen-ticket").filter({ hasText: name });
    await expect(ticket).toBeVisible({ timeout: 15000 });
    await ticket.getByRole("button", { name: "Confirmar recepción" }).click();
    await expect(ticket).toContainText("Cocina recibió");
    await owner.evaluate(async (id) => {
      const s = await (await fetch("/api/session")).json();
      const r = await fetch(`/api/service/orders/${id}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          note: "ALERGIA: mariscos",
        }),
      });
      if (!r.ok) throw new Error("note " + r.status);
    }, order.id);
    await expect(ticket).toContainText("ALERGIA: mariscos", { timeout: 15000 });
    await expect(ticket).toHaveClass(/ticket-new/);
    await expect(ticket).toContainText("Nota actualizada");
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: `Nota actualizada en ticket #${order.number}` }),
    ).toHaveCount(1);
  } finally {
    await owner.close();
  }
});

test("a ticket stays disabled while its own request is in flight and shows the next step at once", async ({
  page,
  browser,
  baseURL,
}) => {
  // SVC-K5: one shared busy id let another ticket's tap re-enable this one,
  // and the old action stayed under the finger until the next poll.
  await kitchenScreen(page);
  const owner = await ownerPage(browser, baseURL!);
  try {
    const nameA = "Uno " + tag();
    const nameB = "Dos " + tag();
    await createOrder(owner, nameA);
    await createOrder(owner, nameB);
    const a = page.locator(".kitchen-ticket").filter({ hasText: nameA });
    const b = page.locator(".kitchen-ticket").filter({ hasText: nameB });
    await expect(a).toBeVisible({ timeout: 15000 });
    await expect(b).toBeVisible({ timeout: 15000 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    await page.route("**/api/kitchen/*", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      held++;
      await gate;
      await route.continue();
    });
    const ackA = a.getByRole("button", { name: "Confirmar recepción" });
    await ackA.click();
    await expect(ackA).toBeDisabled();
    await b.getByRole("button", { name: "Confirmar recepción" }).click();
    await expect.poll(() => held).toBe(2);
    await expect(ackA).toBeDisabled();
    // From here the feed never answers, so the next step can only come from
    // each ticket's own result.
    await page.route("**/api/service/kitchen*", (route) => route.abort());
    release();
    await expect(a.getByRole("button", { name: "Marcar listo" })).toBeEnabled();
    await expect(b.getByRole("button", { name: "Marcar listo" })).toBeEnabled();
    await expect(
      a.getByRole("button", { name: "Confirmar recepción" }),
    ).toHaveCount(0);
  } finally {
    await owner.close();
  }
});

test("the sound button and banner follow the live audio state", async ({
  page,
}) => {
  // SVC-K8: an interrupted or suspended context must not keep "Sonido activado".
  await page.addInitScript(() => {
    const Base = window.AudioContext;
    (window as any).AudioContext = class extends Base {
      constructor(options?: AudioContextOptions) {
        super(options);
        (window as any).__kdsAudio = this;
      }
    };
  });
  await kitchenScreen(page);
  await page.getByRole("button", { name: "Activar sonido" }).click();
  await expect(
    page.getByRole("button", { name: "Sonido activado" }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).__kdsAudio.suspend());
  await expect(
    page.getByRole("button", { name: "Activar sonido" }),
  ).toBeVisible();
  await expect(
    page.getByText("Toca «Activar sonido» para escuchar los tickets nuevos."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Activar sonido" }).click();
  await expect(
    page.getByRole("button", { name: "Sonido activado" }),
  ).toBeVisible();
  await expect(
    page.getByText("Toca «Activar sonido» para escuchar los tickets nuevos."),
  ).toHaveCount(0);
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
    // A print() that returns at once (iOS Safari) must not blank the job: the
    // document stays until afterprint.
    await expect(page.locator("#print-root")).toContainText(`#${order.number}`);
    await expect(page.locator("body")).toHaveClass(/printing-doc/);
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await expect(page.locator("#print-root")).toBeEmpty();
    await expect(page.locator("body")).not.toHaveClass(/printing-doc/);
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
