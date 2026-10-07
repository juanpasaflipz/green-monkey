import "dotenv/config";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// LD-29: order numbers restart every business day, so after the cutoff rollover an
// open order from the day before and a new one can both read "#10". Screens name the
// business date of an order that is not from the current business day: "#10 · 5 oct".
// The demo owner runs it on the isolated local fixture database; the restaurant's
// cutoff is moved as the owner would (app.tenant_id set, LD-16) and restored after.
// LD-42 hygiene: the test pays both of its checks and completes their kitchen rounds
// (the old order's second round included) itself; it never clears other tests' tickets.
const tenantId = "10000000-0000-4000-8000-000000000001";
const uuid = () => crypto.randomUUID();

/** Local fixture database only (same guard as finance.spec and global-setup). */
function fixtureAdmin(baseURL: string | undefined) {
  const runtime = new URL(process.env.DATABASE_URL ?? "http://invalid"),
    migration = new URL(process.env.MIGRATION_DATABASE_URL ?? "http://invalid"),
    base = new URL(baseURL ?? "http://invalid");
  if (
    !["localhost", "127.0.0.1"].includes(runtime.hostname) ||
    runtime.hostname !== migration.hostname ||
    runtime.port !== migration.port ||
    runtime.pathname !== migration.pathname ||
    !/^\/green_monkey(_[a-z]+)?_dev$/.test(runtime.pathname) ||
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    throw Error(
      "Business-day fixtures require the isolated local dev database",
    );
  return postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
}

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
}

/** Calls the API from the page with the session's CSRF token. */
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

async function takeawayOrder(page: Page, name: string) {
  const catalog = await call<any[]>(page, "/catalog");
  const taco = catalog.find((p) => p.name.es === "Taco de hongos");
  return call(page, "/orders", {
    operationId: uuid(),
    lines: [
      { id: uuid(), productId: taco.id, quantity: 1, options: [], note: "" },
    ],
    mode: "takeaway",
    tableId: null,
    name,
    note: "",
    channel: "pos",
  });
}

/** "5 oct" / "Oct 5" as the browser formats a business date (its own ICU). */
const dayLabel = (page: Page, date: string, locale: "es" | "en") =>
  page.evaluate(
    ({ date, locale }) =>
      new Intl.DateTimeFormat(locale === "es" ? "es-MX" : "en-US", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(new Date(date + "T12:00:00Z")),
    { date, locale },
  );

test("LD-29: an open order from the previous business day shows its date next to its number in Órdenes, the cart, the payment dialog, Borradores and the kitchen (tickets, printed comandas and announcements); today's orders keep the plain number", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const admin = fixtureAdmin(baseURL);
  const asOwner = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    }) as Promise<T>;
  const setCutoff = (cutoff: number) =>
    asOwner(
      (tx) =>
        tx`update restaurants set cutoff = ${cutoff} where id = ${tenantId}`,
    );
  const [restaurant] = await asOwner(
    (tx) =>
      tx<{ cutoff: number; timezone: string }[]>`
        select cutoff, timezone from restaurants where id = ${tenantId}`,
  );
  const minuteOfDay = () => {
    const [h, m] = new Intl.DateTimeFormat("en-GB", {
      timeZone: restaurant.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(new Date())
      .split(":")
      .map(Number);
    return h * 60 + m;
  };
  // With the cutoff at 23:59 an order belongs to the day before (unless it is 23:59
  // already: wait for midnight). Today's order is created under the restaurant's own
  // cutoff once it has passed, so it belongs to the real current business day and
  // nothing stays dated ahead of it after the restore; before the cutoff (early
  // morning) only 00:00 makes the calendar day the business day.
  if (minuteOfDay() >= 1438) await page.waitForTimeout(150_000);
  const run = uuid().slice(0, 6);
  const oldName = "Ayer " + run,
    freshName = "Hoy " + run;
  let old: any = null,
    fresh: any = null;
  try {
    await login(page);
    await setCutoff(1439);
    old = await takeawayOrder(page, oldName);
    await setCutoff(minuteOfDay() >= restaurant.cutoff ? restaurant.cutoff : 0);
    fresh = await takeawayOrder(page, freshName);
    expect(old.businessDate < fresh.businessDate).toBe(true);
    // A fresh session reads the moved cutoff.
    await page.reload();
    await page.getByRole("button", { name: "Operación", exact: true }).click();
    const es = await dayLabel(page, old.businessDate, "es");
    const oldLabel = `#${old.number} · ${es}`;
    // As the documents carry it: non-breaking spaces, so the date never wraps
    // apart from the number (LD-48, POLISH-UX-2). Locators normalise them.
    const oldText = oldLabel.replace(/ /g, "\u00a0");

    // Órdenes: the card and its checkbox name the date; today's order does not.
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    const oldCard = page.locator("article.order-summary").filter({
      has: page.getByRole("heading", { name: oldName, exact: true }),
    });
    await expect(oldCard.locator(".eyebrow")).toContainText(oldLabel + " ·");
    await expect(
      oldCard.getByRole("checkbox", {
        name: `Seleccionar orden ${oldLabel}`,
        exact: true,
      }),
    ).toBeVisible();
    const freshCard = page.locator("article.order-summary").filter({
      has: page.getByRole("heading", { name: freshName, exact: true }),
    });
    await expect(freshCard.locator(".eyebrow")).toContainText(
      `#${fresh.number} · Para llevar`,
    );
    await expect(
      freshCard.getByRole("checkbox", {
        name: `Seleccionar orden #${fresh.number}`,
        exact: true,
      }),
    ).toBeVisible();
    // The discount dialog's title names it the same way (POL-R2-2).
    await oldCard
      .getByRole("button", { name: "Descuento", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", {
        name: `Descuento · Orden ${oldLabel}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // The kitchen ticket list.
    await page.getByRole("button", { name: "Cocina", exact: true }).click();
    const oldHeader = page
      .locator("article.kitchen-ticket")
      .filter({ hasText: oldName })
      .locator("h2");
    await expect(oldHeader).toContainText(oldLabel);
    expect(await oldHeader.textContent()).toContain(oldText);
    await expect(
      page
        .locator("article.kitchen-ticket")
        .filter({ hasText: freshName })
        .locator("h2"),
    ).toHaveText(`#${fresh.number} ${freshName}`);
    // The comanda printed from the kitchen screen names the date as its header
    // does; today's prints its plain number (LD-44).
    await page.evaluate(() => {
      (window as any).__printed = [];
      window.print = () =>
        (window as any).__printed.push(
          document.getElementById("print-root")?.innerText ?? "",
        );
    });
    for (const name of [oldName, freshName])
      await page
        .locator("article.kitchen-ticket")
        .filter({ hasText: name })
        .getByRole("button", { name: "Imprimir comanda", exact: true })
        .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__printed as string[]))
      .toEqual([
        expect.stringContaining(`${oldText} ${oldName}`),
        expect.stringContaining(`#${fresh.number} ${freshName}`),
      ]);
    // A new round of the old order is announced with its date, as its header
    // reads, so it never sounds like today's #N (POL-R2-2).
    const catalog = await call<any[]>(page, "/catalog");
    const taco = catalog.find((p) => p.name.es === "Taco de hongos");
    const before = await call(page, "/orders/" + old.id);
    await call(page, `/orders/${old.id}/rounds`, {
      operationId: uuid(),
      expectedVersion: before.version,
      lines: [
        { id: uuid(), productId: taco.id, quantity: 1, options: [], note: "" },
      ],
      mode: before.mode,
    });
    old = await call(page, "/orders/" + old.id);
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: `Nuevo ticket ${oldLabel}, ronda 2` }),
    ).toHaveCount(1, { timeout: 15_000 });

    // Resumed into the cart and opened for payment.
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    await oldCard
      .getByRole("button", { name: "Abrir orden", exact: true })
      .click();
    await expect(page.locator(".cart-heading .eyebrow")).toHaveText(oldLabel);
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: `Cobrar ${oldLabel}`, exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    // A round tapped for it and parked in Borradores names the date too (POL-R2-2).
    await page
      .locator("button.product")
      .filter({ has: page.getByText("Taco de hongos", { exact: true }) })
      .click();
    await page
      .getByRole("button", { name: "Nueva orden", exact: true })
      .click();
    await expect(page.locator(".cart-heading .eyebrow")).toHaveText(
      "Nueva orden",
    );
    await page.getByRole("button", { name: "Borradores", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Borradores" })
        .getByRole("button")
        .filter({ hasText: `${oldLabel} · ronda sin enviar` }),
    ).toHaveCount(1);
    await page.keyboard.press("Escape");

    // English: "#10 · Oct 5".
    await page.getByRole("button", { name: "ES", exact: true }).click();
    await page.getByRole("button", { name: "Orders", exact: true }).click();
    const en = await dayLabel(page, old.businessDate, "en");
    await expect(oldCard.locator(".eyebrow")).toContainText(
      `#${old.number} · ${en} ·`,
    );
    await expect(freshCard.locator(".eyebrow")).toContainText(
      `#${fresh.number} · Takeaway`,
    );

    // Órdenes › Cobrar juntas with both checks: each line names its order as the
    // cards do, before and after the payment (POL-1).
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    const cash = await call(page, "/cash");
    if (!cash || cash.closed_at)
      await call(page, "/cash/open", { operationId: uuid(), opening: 50000 });
    await oldCard
      .getByRole("checkbox", { name: `Seleccionar orden ${oldLabel}` })
      .check();
    await freshCard
      .getByRole("checkbox", { name: `Seleccionar orden #${fresh.number}` })
      .check();
    await page
      .getByRole("button", { name: "Cobrar juntas (2)", exact: true })
      .click();
    const settle = page.getByRole("dialog", {
      name: "Cobrar juntas",
      exact: true,
    });
    const money = (n: number) => "$" + (n / 100).toFixed(2);
    await expect(
      settle.getByText(`${oldLabel} · ${money(old.total)}`, { exact: true }),
    ).toBeVisible();
    await expect(
      settle.getByText(`#${fresh.number} · ${money(fresh.total)}`, {
        exact: true,
      }),
    ).toBeVisible();
    await settle.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(settle).toContainText(
      `${oldLabel} · Cobrado ${money(old.total)} · Saldo $0.00`,
    );
    await expect(settle).toContainText(
      `#${fresh.number} · Cobrado ${money(fresh.total)} · Saldo $0.00`,
    );
    await settle.getByRole("button", { name: "Listo", exact: true }).click();
  } finally {
    // Pay what is still due and complete both checks' kitchen rounds (only this
    // test's), then restore the restaurant's cutoff.
    try {
      const cash = await call(page, "/cash");
      if (!cash || cash.closed_at)
        await call(page, "/cash/open", { operationId: uuid(), opening: 50000 });
      for (const o of [old, fresh].filter(Boolean)) {
        const current = await call(page, "/orders/" + o.id);
        if (current.total > current.paid)
          await call(page, `/orders/${o.id}/payments`, {
            operationId: uuid(),
            amount: current.total - current.paid,
            tip: 0,
            received: current.total - current.paid,
            method: "cash",
          });
        for (const round of current.rounds ?? []) {
          if (round.state === "active")
            await call(page, "/kitchen/" + round.id, {
              operationId: uuid(),
              state: "ready",
            });
          if (round.state === "active" || round.state === "ready")
            await call(page, "/kitchen/" + round.id, {
              operationId: uuid(),
              state: "completed",
            });
        }
      }
    } finally {
      await setCutoff(restaurant.cutoff);
      await admin.end();
    }
  }
});
