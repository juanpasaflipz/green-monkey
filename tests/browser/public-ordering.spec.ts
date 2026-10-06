import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Public QR/kiosk ordering (032). Every test makes its own "QR <runId>" tables
// and links and, in a finally, decides or cancels every hold, revokes every
// link, resumes ordering, restores the policies, settles every check it
// opened and archives its tables (LD-P9), so later specs never see an inbox,
// a banner or an occupied table from here.

// Local helpers (wave rule: no shared helper module in-wave).
async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
/** Authenticated JSON call from the page (same cookies and CSRF as the app). */
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
const op = () => crypto.randomUUID();
const runId = () => Math.random().toString(36).slice(2, 7);
async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

type Table = { id: string; name: string; version: number };
type Link = {
  id: string;
  path: string;
  token: string;
  tableName: string | null;
};

/** Everything one test created, undone in its finally. */
class Fixture {
  links: string[] = [];
  tables: Table[] = [];
  orders: string[] = [];
  policies = false;
  /** The restaurant's privacy notice URL before setPrivacy (account 031). */
  privacyBefore: { url: string | null } | null = null;
  done = false;
  constructor(
    public page: Page,
    public id = runId(),
  ) {}
  /** Three fresh tables "QR <id> 1..3" for this test only. */
  async makeTables(n = 3) {
    const r = await call(this.page, "/floor/tables/bulk", {
      operationId: op(),
      areaId: null,
      prefix: `QR ${this.id}`,
      from: 1,
      to: n,
    });
    expect(r.status).toBe(200);
    const floor = await call(this.page, "/floor");
    this.tables = (floor.data.tables as Table[]).filter((t) =>
      t.name.startsWith(`QR ${this.id} `),
    );
    expect(this.tables).toHaveLength(n);
    return this.tables;
  }
  async link(body: object): Promise<Link> {
    const r = await call(this.page, "/ordering/links", body);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    this.links.push(r.data.id);
    return r.data;
  }
  /** Saves the restaurant's privacy notice URL (account 031); cleanup restores it. */
  async setPrivacy(url: string | null) {
    const v = (await call(this.page, "/account/restaurant-privacy")).data;
    this.privacyBefore ??= { url: v.privacyNoticeUrl };
    const r = await call(this.page, "/account/restaurant-privacy", {
      operationId: op(),
      expectedVersion: v.version,
      privacyNoticeUrl: url,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
  }
  async restorePrivacy() {
    if (!this.privacyBefore) return;
    await this.setPrivacy(this.privacyBefore.url);
    this.privacyBefore = null;
  }
  /** Rejects every pending hold of this test's links, by table or link name. */
  async decideHolds() {
    const inbox = await call(this.page, "/ordering/inbox");
    if (inbox.status !== 200) return;
    for (const h of inbox.data.holds)
      if (
        (h.tableName ?? "").includes(`QR ${this.id}`) ||
        (h.linkLabel ?? "").includes(this.id)
      )
        await call(this.page, `/ordering/holds/${h.id}/reject`, {
          operationId: op(),
          reason: "other",
        });
  }
  /** Pays (on this device's drawer) and releases every check this test opened. */
  async settleOrders() {
    await call(this.page, "/cash/open", { operationId: op(), opening: 0 });
    for (const id of this.orders) {
      const o = (await call(this.page, `/orders/${id}`)).data;
      if (!o || o.checkState === "closed") continue;
      const due = o.total - o.paid;
      if (due > 0)
        await call(this.page, `/orders/${id}/payments`, {
          operationId: op(),
          amount: due,
          received: due,
          method: "cash",
        });
      await call(this.page, `/service/orders/${id}/close`, {
        operationId: op(),
      });
    }
  }
  async cleanup() {
    if (this.done) return;
    this.done = true;
    // A test may have switched this page to the cashier: clean up as the owner.
    const who = await call(this.page, "/session").catch(() => null);
    if (who?.data?.role !== "owner") {
      await this.page.evaluate(() => fetch("/api/logout", { method: "POST" }));
      await login(this.page);
    }
    // The LD-P9 steps run first and whatever happens to the privacy restore,
    // which asserts its status (PUB-B3-3).
    try {
      await this.decideHolds();
      for (const id of this.links)
        await call(this.page, `/ordering/links/${id}/revoke`, {
          operationId: op(),
        });
      const s = await call(this.page, "/ordering/settings");
      if (s.data?.paused)
        await call(this.page, "/ordering/pause", {
          operationId: op(),
          paused: false,
        });
      if (this.policies) {
        const v = (await call(this.page, "/ordering/settings")).data;
        await call(this.page, "/ordering/settings", {
          operationId: op(),
          expectedVersion: v.version,
          tablePolicy: "accept",
          counterPolicy: "accept",
          holdMinutes: 30,
          maxOrderTotal: 1_000_000,
        });
      }
      await this.settleOrders();
      const floor = await call(this.page, "/floor");
      for (const t of floor.data.tables as (Table & { archived: boolean })[])
        if (t.name.startsWith(`QR ${this.id} `) && !t.archived)
          await call(this.page, "/floor/tables/archive", {
            operationId: op(),
            id: t.id,
            expectedVersion: t.version,
            archived: true,
          });
    } finally {
      await this.restorePrivacy();
    }
  }
}
let open: Fixture | null = null;
async function withFixture(page: Page, fn: (f: Fixture) => Promise<void>) {
  const f = (open = new Fixture(page));
  try {
    await fn(f);
  } finally {
    await f.cleanup();
    open = null;
  }
}
// A timed-out test never reaches its finally: undo its state here.
test.afterEach(async () => {
  const f = open;
  open = null;
  if (f) await f.cleanup();
});
/** The accepted check of a hold, for cleanup. */
async function acceptedOrder(page: Page, name: string) {
  const list = await call(
    page,
    "/service/orders?status=open&limit=100&q=" + encodeURIComponent(name),
  );
  return (list.data.items as { id: string; name: string }[]).find((o) =>
    o.name.includes(name),
  );
}
async function stubPrint(page: Page) {
  await page.evaluate(() => {
    (window as any).__printed = [];
    window.print = () => {
      (window as any).__printed.push(
        document.getElementById("print-root")!.innerText,
      );
      window.dispatchEvent(new Event("afterprint"));
    };
  });
}
async function goToOrders(page: Page) {
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
}
const inbox = (page: Page) => page.locator(".public-inbox");
const inboxTitle = (page: Page) => page.locator("#public-inbox-title");
/**
 * PUB-HR-1: the next inbox read that finds no active code and nothing
 * pending, the read after which the section used to unmount. Register it
 * before the action that handles the last hold.
 */
const emptyInboxRead = (page: Page) =>
  page.waitForResponse(async (r) => {
    if (
      !r.url().endsWith("/api/ordering/inbox") ||
      r.request().method() !== "GET"
    )
      return false;
    const body = await r.json().catch(() => null);
    return body?.active === false && body.holds?.length === 0;
  });
const holdCard = (page: Page, label: string) =>
  page.locator(".hold-card").filter({ hasText: label });
/** A diner page with its own clock-free context (cookies shared with staff). */
async function diner(context: BrowserContext, path: string) {
  const page = await context.newPage();
  await page.goto(path);
  return page;
}
async function addTaco(customer: Page, option = 0) {
  await customer.getByRole("button", { name: /^Taco de asada/ }).click();
  const picker = customer.getByRole("dialog");
  await picker.getByRole("radio").nth(option).check();
  await picker.getByRole("button", { name: "Agregar a la orden" }).click();
}
/** MONEY-2: the accepted notice names the order the hold became. */
const acceptedNotice = (label: string) =>
  new RegExp(`${label} → Orden #\\d+ enviada a cocina\\.`);
async function sendOrder(customer: Page, name: string) {
  await customer.getByLabel("Nombre (opcional)").fill(name);
  await customer
    .getByRole("button", { name: "Enviar pedido", exact: true })
    .click();
}

test("table QR end to end: create and print the code, the diner orders, staff accept from Órdenes, the kitchen gets it and the diner follows it", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await withFixture(page, async (f) => {
    const [mesa] = await f.makeTables();
    await page
      .getByRole("button", { name: "Menú e inventario", exact: true })
      .click();
    await page.getByRole("button", { name: "Mesas", exact: true }).click();
    await page
      .getByRole("button", { name: `Código QR de ${mesa.name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Código QR de ${mesa.name}`,
    });
    await dialog.getByRole("button", { name: "Crear código QR" }).click();
    const qr = dialog.locator('svg[role="img"]');
    await expect(qr).toBeVisible();
    await expect(qr.locator("title")).toHaveText(
      `Código QR para pedir en ${mesa.name}`,
    );
    await expect(dialog).toContainText(
      "Guárdalo o imprímelo ahora: por seguridad no se vuelve a mostrar.",
    );
    await page.setViewportSize({ width: 1024, height: 768 });
    await axe(page);
    await page.screenshot({ path: "docs/evidence/public-table-qr-1024.png" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await stubPrint(page);
    await dialog.getByRole("button", { name: "Imprimir", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__printed.length))
      .toBe(1);
    expect(
      await page.evaluate(() => (window as any).__printed[0] as string),
    ).toContain("Escanea para ver el menú y pedir");
    await dialog.getByRole("button", { name: "Copiar enlace" }).click();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toMatch(/\/qr#[A-Za-z0-9_-]{22}$/);
    await dialog.getByRole("button", { name: "Cerrar" }).click();
    const links = await call(page, "/ordering/links");
    f.links.push(
      ...(links.data.links as { id: string; tableId: string }[])
        .filter((l) => l.tableId === mesa.id)
        .map((l) => l.id),
    );
    await expect(
      page.locator(".menu-row").filter({ hasText: mesa.name }),
    ).toContainText("QR activo · Ref.");

    const customer = await diner(context, url);
    await expect(
      customer.getByRole("heading", { name: "Casa del Bosque · Demo" }),
    ).toBeVisible();
    await expect(customer.getByText(`Pedido para ${mesa.name}`)).toBeVisible();
    await expect(
      customer.getByText("Precios en MXN con IVA incluido."),
    ).toBeVisible();
    // PRIVACY-7: without a restaurant notice account's copy says so, and the
    // platform notice opens in a new tab on a phone.
    const noNotice = customer.getByText(
      "Este restaurante aún no publicó un aviso de privacidad; no escribas datos personales.",
    );
    await expect(noNotice).toBeVisible();
    // B3: once the owner saves the restaurant's own notice (account 031), the
    // diner sees it as a link that opens in a new tab; the value is restored.
    await f.setPrivacy("https://casa-del-bosque.mx/privacidad");
    await customer.reload();
    const restaurantNotice = customer.getByRole("link", {
      name: "Aviso de privacidad de Casa del Bosque · Demo",
      exact: true,
    });
    await expect(restaurantNotice).toHaveAttribute(
      "href",
      "https://casa-del-bosque.mx/privacidad",
    );
    await expect(restaurantNotice).toHaveAttribute("target", "_blank");
    await expect(restaurantNotice).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    await expect(noNotice).toHaveCount(0);
    await f.restorePrivacy();
    await customer.reload();
    await expect(noNotice).toBeVisible();
    await expect(restaurantNotice).toHaveCount(0);
    const platform = customer.getByRole("link", {
      name: "Pedido procesado con Green Monkey · Privacidad de la plataforma",
    });
    await expect(platform).toHaveAttribute(
      "href",
      "/legal/privacidad#restaurantes",
    );
    await expect(platform).toHaveAttribute("target", "_blank");
    await expect(platform).toHaveAttribute("rel", "noopener noreferrer");
    await expect(
      customer.getByRole("button", { name: "Taco de hongos, $45.00" }),
    ).toBeVisible();
    await expect(customer.getByRole("button", { name: /^Varios/ })).toHaveCount(
      0,
    );
    await customer.setViewportSize({ width: 390, height: 844 });
    expect(await noHorizontalScroll(customer)).toBe(true);
    await axe(customer);
    await customer.screenshot({
      path: "docs/evidence/public-diner-menu-390.png",
    });
    await customer.setViewportSize({ width: 768, height: 1024 });
    await axe(customer);
    await addTaco(customer);
    await sendOrder(customer, `QR ${f.id}`);
    const head = customer.locator(".diner-status-head");
    await expect(head).toContainText(
      /Q-\d+ · Esperando confirmación del personal/,
    );
    const label = (await customer.locator(".diner-code").innerText()).trim();
    // UX-6: the confirmation is announced from the page's persistent live
    // region, focus lands on the status heading, and the status region was
    // mounted before its text arrived.
    await expect(
      customer.locator('main > p.sr-only[aria-live="polite"]'),
    ).toHaveText(
      `Pedido ${label} enviado. Esperando confirmación del personal.`,
    );
    await expect(
      customer.getByRole("heading", { name: "Estado de tu pedido" }),
    ).toBeFocused();
    await expect(head).toHaveAttribute("role", "status");
    await customer.setViewportSize({ width: 390, height: 844 });
    await axe(customer);
    await customer.screenshot({ path: "docs/evidence/public-status-390.png" });

    // Nothing reached the kitchen.
    const kitchen = await call(page, "/kitchen");
    expect(
      (kitchen.data as { name: string }[]).some((r) =>
        r.name.includes(`QR ${f.id}`),
      ),
    ).toBe(false);

    // Staff: the badge and the banner lead to the inbox.
    await page.reload();
    await expect(
      page
        .locator(".rail")
        .getByRole("button", { name: "Operación", exact: true }),
    ).toContainText(/\d/);
    const banner = page.locator(".public-banner");
    await expect(banner).toContainText(/pedidos? en línea por confirmar/);
    await banner.getByRole("button", { name: "Ver", exact: true }).click();
    // LD-P8: the live regions stay mounted while empty, so their next text is
    // announced (the banner's region in Órdenes, the inbox notice).
    await expect(
      page.locator('.public-banner-live[aria-live="polite"]'),
    ).toBeEmpty();
    const notice = inbox(page).locator('.public-notice[aria-live="polite"]');
    await expect(notice).toBeEmpty();
    const card = holdCard(page, label);
    await expect(card).toContainText(mesa.name);
    await expect(card).toContainText(`QR ${f.id}`);
    await page.setViewportSize({ width: 1024, height: 768 });
    await axe(page);
    await page.screenshot({ path: "docs/evidence/public-inbox-1024.png" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await axe(page);
    await card
      .getByRole("button", { name: "Aceptar y enviar a cocina", exact: true })
      .click();
    await expect(notice).toHaveText(acceptedNotice(label));
    const order = await acceptedOrder(page, `QR ${f.id}`);
    expect(order).toBeTruthy();
    f.orders.push(order!.id);
    // MONEY-2: the diner knows only the label; it leads the call name.
    expect(order!.name).toBe(`${label} · QR ${f.id}`);
    // B1: staff collect the check at the table while the kitchen works; the
    // payment issues its fiscal ticket (027).
    await call(page, "/cash/open", { operationId: op(), opening: 0 });
    const due = (await call(page, `/orders/${order!.id}`)).data;
    const paid = await call(page, `/orders/${order!.id}/payments`, {
      operationId: op(),
      amount: due.total - due.paid,
      received: due.total - due.paid,
      method: "cash",
    });
    expect(paid.status, JSON.stringify(paid.data)).toBe(200);
    const folio = paid.data.fiscal?.ticket?.folio as string;
    expect(folio).toMatch(/^(?:[A-Z0-9]{1,10}-)?\d{6}$/);

    // The kitchen has it now; the diner follows the round.
    await page
      .getByRole("button", { name: "Cocina", exact: true })
      .first()
      .click();
    await expect(
      page.locator(".kitchen-ticket").filter({ hasText: `QR ${f.id}` }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(".kitchen-ticket").filter({ hasText: `QR ${f.id}` }),
    ).toContainText(label);
    await expect(head).toContainText(/Confirmado · Orden #\d+/, {
      timeout: 15000,
    });
    await expect(head).toContainText("En preparación");
    const rounds = (await call(page, "/kitchen")).data as {
      id: string;
      name: string;
    }[];
    for (const r of rounds.filter((r) => r.name.includes(`QR ${f.id}`)))
      await call(page, `/kitchen/${r.id}`, {
        operationId: op(),
        state: "ready",
      });
    await expect(head).toContainText("Listo", { timeout: 30000 });
    // B1: the poll that shows "Listo" also carries the payment made above:
    // the check's fiscal ticket exists, and the diner sees its folio as the
    // printed ticket shows it (027).
    await expect(customer.locator(".diner-money")).toHaveText(
      `Pagado · Folio ${folio}`,
    );
  });
});

test("append: a table order joins the table's open check as a new round with the hold label; the diner sees no money", async ({
  page,
  context,
}) => {
  await login(page);
  await withFixture(page, async (f) => {
    const [, mesa] = await f.makeTables();
    const catalog = (await call(page, "/catalog")).data as {
      id: string;
      name: { es: string };
    }[];
    const hongos = catalog.find((p) => p.name.es === "Taco de hongos")!;
    const check = await call(page, "/orders", {
      operationId: op(),
      lines: [
        { id: op(), productId: hongos.id, quantity: 1, options: [], note: "" },
      ],
      mode: "dine_in",
      tableId: mesa.id,
      name: `Mesa ${f.id}`,
      note: "",
      channel: "pos",
    });
    expect(check.status).toBe(200);
    f.orders.push(check.data.id);
    const link = await f.link({ kind: "table", tableId: mesa.id });
    const customer = await diner(context, link.path);
    await addTaco(customer);
    await sendOrder(customer, `Ana ${f.id}`);
    const head = customer.locator(".diner-status-head");
    await expect(head).toContainText("Esperando confirmación del personal");
    const label = (await customer.locator(".diner-code").innerText()).trim();
    await goToOrders(page);
    const card = holdCard(page, label);
    await expect(card.getByLabel("Enviar a")).toHaveValue(check.data.id);
    await expect(card.getByLabel("Enviar a")).toContainText(
      `Cuenta #${check.data.number} de ${mesa.name}`,
    );
    await card
      .getByRole("button", { name: "Aceptar y enviar a cocina", exact: true })
      .click();
    await expect(inbox(page)).toContainText(acceptedNotice(label));
    const order = (await call(page, `/orders/${check.data.id}`)).data;
    const round2 = order.rounds.find((r: { number: number }) => r.number === 2);
    // PRIVACY-3 (deliberate change): the round note prints on the shared
    // check's receipt, so it carries the label, never the diner's name.
    expect(round2.note).toBe(label);
    await expect(head).toContainText(
      "Confirmado · se agregó a la cuenta de tu mesa",
    );
    await expect(customer.locator(".diner-money")).toHaveCount(0);
    await expect(customer.getByText(/Por pagar|Pagado/)).toHaveCount(0);
  });
});

test("reject and restore: the diner sees the reason and gets the cart back", async ({
  page,
  context,
}) => {
  await login(page);
  await withFixture(page, async (f) => {
    const link = await f.link({ kind: "counter", label: `Ventanilla ${f.id}` });
    const customer = await diner(context, link.path);
    await expect(
      customer.getByText(`Para llevar · Ventanilla ${f.id}`),
    ).toBeVisible();
    await addTaco(customer);
    await sendOrder(customer, `Beto ${f.id}`);
    const head = customer.locator(".diner-status-head");
    await expect(head).toContainText("Esperando confirmación del personal");
    const label = (await customer.locator(".diner-code").innerText()).trim();
    await goToOrders(page);
    await holdCard(page, label)
      .getByRole("button", { name: "Rechazar", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Rechazar pedido ${label}`,
    });
    await dialog
      .getByRole("radio", { name: "Productos no disponibles" })
      .check();
    await dialog.getByRole("button", { name: "Rechazar pedido" }).click();
    await expect(inbox(page)).toContainText(`${label} rechazado.`);
    await expect(head).toContainText("El personal no pudo aceptar tu pedido.", {
      timeout: 20000,
    });
    await expect(head).toContainText("Algún producto no está disponible.");
    await customer.getByRole("button", { name: "Volver al menú" }).click();
    await expect(customer.locator(".diner-line")).toHaveCount(1);
    await expect(customer.locator(".diner-line")).toContainText(
      "Taco de asada",
    );
    // UX-2: browsing the menu again, the diner gets back to their orders.
    await customer
      .getByRole("button", { name: `Tus pedidos (${label})`, exact: true })
      .click();
    await expect(head).toContainText("El personal no pudo aceptar tu pedido.");
    await expect(
      customer.getByRole("heading", { name: "Estado de tu pedido" }),
    ).toBeFocused();
  });
});

test("pay-first kiosk: the kiosk shows its code and resets; the cashier charges before the kitchen gets it", async ({
  page,
  context,
}) => {
  await login(page);
  await withFixture(page, async (f) => {
    f.policies = true;
    await call(page, "/cash/open", { operationId: op(), opening: 0 });
    await page
      .getByRole("button", { name: "Configuración", exact: true })
      .click();
    const panel = page.locator(".public-settings");
    await panel
      .getByRole("combobox", { name: "Pedidos para llevar y kiosco" })
      .selectOption({ label: "Se cobra antes de enviar a cocina" });
    await panel
      .getByRole("button", { name: "Guardar pedidos en línea", exact: true })
      .click();
    await expect(panel).toContainText("Pedidos en línea guardados");
    await expect(
      page.getByText("Configuración guardada", { exact: true }),
    ).toHaveCount(0);
    await panel.getByLabel("Nombre del kiosco").fill(`Entrada ${f.id}`);
    await panel.getByRole("button", { name: "Agregar kiosco" }).click();
    const reveal = page.getByRole("dialog", { name: "Código listo" });
    await expect(reveal).toContainText(
      "Abre este enlace en el navegador del kiosco y déjalo en pantalla completa.",
    );
    const url = await reveal.getByLabel("Enlace").inputValue();
    expect(url).toMatch(/\/kiosk#[A-Za-z0-9_-]{22}$/);
    await reveal.getByRole("button", { name: "Cerrar" }).click();
    const listed = await call(page, "/ordering/links");
    const kioskIds = (listed.data.links as { id: string; label: string }[])
      .filter((l) => l.label === `Entrada ${f.id}`)
      .map((l) => l.id);
    expect(kioskIds).toHaveLength(1);
    f.links.push(...kioskIds);
    await page.setViewportSize({ width: 1440, height: 900 });
    await axe(page);
    await panel.screenshot({ path: "docs/evidence/public-settings-1440.png" });

    const kiosk = await context.newPage();
    await kiosk.clock.install();
    await kiosk.goto(url);
    await kiosk.setViewportSize({ width: 1024, height: 768 });
    // PRIVACY-2/UX-5: a kiosk renders no navigational link; its privacy
    // notices open in an in-page dialog with codes to scan.
    await expect(
      kiosk.getByRole("button", { name: /^Taco de asada/ }),
    ).toBeVisible();
    expect(await kiosk.locator("a[href]").count()).toBe(0);
    await kiosk
      .getByRole("button", {
        name: "Pedido procesado con Green Monkey · Privacidad de la plataforma",
      })
      .click();
    const privacy = kiosk.getByRole("dialog", { name: "Privacidad" });
    await expect(privacy).toContainText(
      "Este restaurante aún no publicó un aviso de privacidad",
    );
    await expect(privacy.locator('svg[role="img"]')).toHaveCount(1);
    await axe(kiosk);
    await privacy.getByRole("button", { name: "Cerrar" }).click();
    await expect(privacy).toHaveCount(0);
    await expect(kiosk).toHaveURL(url);
    // UX-4: with three lines on a 1024×768 kiosk the total and "Enviar
    // pedido" stay in view (the side cart scrolls inside).
    await addTaco(kiosk);
    await addTaco(kiosk, 1);
    await kiosk.getByRole("button", { name: /^Taco de hongos/ }).click();
    await expect(kiosk.locator(".diner-line")).toHaveCount(3);
    const name = kiosk.getByLabel("Nombre (opcional)");
    const note = kiosk.getByLabel("Indicaciones para la cocina (opcional)");
    await name.fill(`Kiosco ${f.id}`);
    await note.fill("sin cebolla");
    const sendButton = kiosk.getByRole("button", {
      name: "Enviar pedido",
      exact: true,
    });
    await expect(sendButton).toBeInViewport();
    await expect(kiosk.locator(".diner-total").first()).toBeInViewport();
    await sendButton.click();
    const code = kiosk.locator(".kiosk-code");
    await expect(code).toHaveText(/^K-\d+$/);
    const label = (await code.innerText()).trim();
    await expect(kiosk.locator(".kiosk-done")).toContainText(
      "Paga en caja con este código para que preparemos tu pedido.",
    );
    // UX-3: the code is the largest thing on the screen.
    expect(await code.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      "120px",
    );
    // UX-6: a plain heading; the page's live region announces the code.
    await expect(code).not.toHaveAttribute("role", "status");
    await expect(
      kiosk.locator('main > p.sr-only[aria-live="polite"]'),
    ).toHaveText(
      `Tu código es ${label}. Paga en caja con este código para que preparemos tu pedido.`,
    );
    expect(await kiosk.locator("a[href]").count()).toBe(0);
    await axe(kiosk);
    await kiosk.screenshot({
      path: "docs/evidence/public-kiosk-done-1024.png",
    });
    await kiosk.clock.fastForward(20_000);
    await expect(code).toHaveCount(0);
    await expect(
      kiosk.getByRole("button", { name: /^Taco de asada/ }),
    ).toBeVisible();
    // PRIVACY-7: the next customer finds no name or note.
    await expect(name).toHaveValue("");
    await expect(note).toHaveValue("");

    // PUB-HR-1: a manager deactivates the only code while its order waits;
    // the cashier still charges it and the receipt outlives the next inbox
    // read, which finds nothing active and nothing pending.
    const revoked = await call(page, `/ordering/links/${kioskIds[0]}/revoke`, {
      operationId: op(),
    });
    expect(revoked.status, JSON.stringify(revoked.data)).toBe(200);
    const before = await call(page, "/ordering/inbox");
    expect(before.data.active).toBe(false);
    expect(before.data.holds).toHaveLength(1);

    await goToOrders(page);
    const card = holdCard(page, label);
    await expect(card).toContainText("Se cobra antes de cocina");
    await expect(
      card.getByRole("button", {
        name: "Aceptar y enviar a cocina",
        exact: true,
      }),
    ).toHaveCount(0);
    await card
      .getByRole("button", { name: "Cobrar y enviar a cocina", exact: true })
      .click();
    const emptied = emptyInboxRead(page);
    await page
      .getByRole("button", { name: "Confirmar cobro", exact: true })
      .click();
    await expect(page.locator(".receipt")).toContainText("Cobrado");
    await emptied;
    await expect(inboxTitle(page)).toHaveText(
      "Pedidos en línea por confirmar (0)",
    );
    await expect(page.locator(".receipt")).toBeVisible();
    // MONEY-2: the receipt carries the code the diner holds (order note).
    await expect(page.locator(".receipt")).toContainText(label);
    // B1: the accept's payment issued the fiscal ticket in the same
    // transaction, so the receipt prints its folio, and the ticket's gross is
    // the total the inbox showed for the hold (fiscal 027, X26).
    const folioLine = page.locator(".receipt .fiscal-folio");
    await expect(folioLine).toHaveText(/^Folio: (?:[A-Z0-9]{1,10}-)?\d{6}$/);
    const folio = (await folioLine.innerText()).replace(/^Folio:\s*/, "");
    const tickets = await call(
      page,
      "/fiscal/tickets?folio=" + encodeURIComponent(folio),
    );
    expect(tickets.status, JSON.stringify(tickets.data)).toBe(200);
    expect(tickets.data.rows).toHaveLength(1);
    expect(tickets.data.rows[0].gross).toBe(before.data.holds[0].currentTotal);
    await expect(inbox(page)).toContainText(acceptedNotice(label));
    await page
      .getByRole("button", { name: /Siguiente|Listo/ })
      .first()
      .click();
    await expect(page.locator(".receipt")).toHaveCount(0);
    await expect(inbox(page).locator(".public-notice")).toHaveText(
      acceptedNotice(label),
    );
    const rounds = (await call(page, "/kitchen")).data as { name: string }[];
    expect(rounds.some((r) => r.name === `${label} · Kiosco ${f.id}`)).toBe(
      true,
    );
  });
});

test("kiosk idle: a warning at 75 s keeps the cart; at 90 s idle the kiosk clears it and returns to Spanish", async ({
  page,
  context,
}) => {
  await login(page);
  await withFixture(page, async (f) => {
    const link = await f.link({ kind: "kiosk", label: `Idle ${f.id}` });
    const kiosk = await context.newPage();
    await kiosk.clock.install();
    await kiosk.goto(link.path);
    await addTaco(kiosk);
    await expect(kiosk.locator(".diner-line")).toHaveCount(1);
    const name = kiosk.getByLabel("Nombre (opcional)");
    const note = kiosk.getByLabel("Indicaciones para la cocina (opcional)");
    await name.fill(`Idle ${f.id}`);
    await note.fill("sin cebolla");
    await kiosk.clock.fastForward(75_000);
    const warning = kiosk.getByRole("dialog", { name: "¿Sigues ahí?" });
    await expect(warning).toBeVisible();
    await warning
      .getByRole("button", { name: "Seguir pidiendo" })
      .first()
      .click();
    await expect(warning).toHaveCount(0);
    await expect(kiosk.locator(".diner-line")).toHaveCount(1);
    await kiosk.getByRole("button", { name: "English", exact: true }).click();
    await expect(
      kiosk.getByRole("button", { name: "Send order" }),
    ).toBeVisible();
    await kiosk.clock.fastForward(90_000);
    await expect(kiosk.locator(".diner-line")).toHaveCount(0);
    // PRIVACY-7: the reset leaves no name or note for the next customer.
    await expect(kiosk.getByLabel("Nombre (opcional)")).toHaveValue("");
    await expect(
      kiosk.getByLabel("Indicaciones para la cocina (opcional)"),
    ).toHaveValue("");
    await expect(
      kiosk.getByRole("button", { name: "Enviar pedido", exact: true }),
    ).toBeDisabled();
    await expect(kiosk.getByRole("button", { name: "English" })).toBeVisible();
  });
});

test("revoke and rotate: a deactivated code and a replaced table code stop working at once; the new one works", async ({
  page,
  context,
}) => {
  await login(page);
  await withFixture(page, async (f) => {
    const [mesa] = await f.makeTables();
    const counter = await f.link({ kind: "counter", label: `Puerta ${f.id}` });
    const customer = await diner(context, counter.path);
    await expect(
      customer.getByRole("button", { name: /^Taco de asada/ }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Configuración", exact: true })
      .click();
    await page
      .getByRole("button", { name: `Desactivar Puerta ${f.id}`, exact: true })
      .click();
    // UX-8: the confirmation is a dialog with its own button text.
    const confirm = page.getByRole("dialog", {
      name: `Desactivar Puerta ${f.id}`,
    });
    await expect(confirm).toContainText("Nadie podrá pedir con este código.");
    await confirm
      .getByRole("button", {
        name: `Sí, desactivar Puerta ${f.id}`,
        exact: true,
      })
      .click();
    await expect(confirm).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: `Desactivar Puerta ${f.id}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await customer.reload();
    await expect(
      customer.getByRole("heading", { name: "Este código ya no funciona" }),
    ).toBeVisible();

    const table = await f.link({ kind: "table", tableId: mesa.id });
    const old = await diner(context, table.path);
    await expect(old.getByText(`Pedido para ${mesa.name}`)).toBeVisible();
    // A phone that ordered with the old code keeps following its order.
    const ordered = await context.newPage();
    await ordered.clock.install();
    await ordered.goto(table.path);
    await addTaco(ordered);
    await sendOrder(ordered, `Rota ${f.id}`);
    const orderedHead = ordered.locator(".diner-status-head");
    await expect(orderedHead).toContainText(
      "Esperando confirmación del personal",
    );
    // It goes back to the menu (loaded) before the code is replaced.
    await ordered
      .getByRole("button", { name: "Hacer otro pedido", exact: true })
      .click();
    await expect(
      ordered.getByRole("button", { name: /^Taco de asada/ }),
    ).toBeVisible();
    // A second phone of the same table is mid-order when the code changes.
    const sending = await diner(context, table.path);
    await addTaco(sending);
    await sendOrder(sending, `Envía ${f.id}`);
    const sendingHead = sending.locator(".diner-status-head");
    await expect(sendingHead).toContainText(
      "Esperando confirmación del personal",
    );
    await sending
      .getByRole("button", { name: "Hacer otro pedido", exact: true })
      .click();
    await sending.getByRole("button", { name: /^Taco de hongos/ }).click();
    await expect(sending.locator(".diner-line")).toHaveCount(1);
    const rotated = await call(page, `/ordering/links/${table.id}/rotate`, {});
    expect(rotated.status).toBe(200);
    f.links.push(rotated.data.id);
    await old.reload();
    await expect(
      old.getByRole("heading", { name: "Este código ya no funciona" }),
    ).toBeVisible();
    // UX-10: the new code pasted into the same tab (a same-document
    // navigation) opens it without a reload.
    await old.evaluate((path) => {
      location.href = path;
    }, rotated.data.path);
    await expect(old.getByText(`Pedido para ${mesa.name}`)).toBeVisible();
    // UX-1: sending with the replaced code keeps the menu and the cart and
    // says so next to the way back to this phone's orders.
    await sending
      .getByRole("button", { name: "Enviar pedido", exact: true })
      .click();
    await expect(sending.locator(".diner-cart")).toContainText(
      "Este código ya no funciona. Pide al personal un código nuevo.",
    );
    await expect(sending.locator(".diner-line")).toHaveCount(1);
    await sending
      .getByRole("button", { name: "Ver mis pedidos", exact: true })
      .click();
    await expect(sending.getByRole("alert").first()).toContainText(
      "Este código QR ya no funciona: se reemplazó o se desactivó.",
    );
    await expect(sendingHead).toContainText(
      "Esperando confirmación del personal",
    );
    // Its next menu poll learns the code was replaced: the page falls back to
    // its pending order, says why, and the notice it reaches from "Hacer
    // otro pedido" leads back to the order.
    await ordered.clock.fastForward(61_000);
    await expect(orderedHead).toContainText(
      "Esperando confirmación del personal",
    );
    await expect(ordered.locator(".diner-closed")).toContainText(
      "Este código QR ya no funciona: se reemplazó o se desactivó.",
    );
    await ordered
      .getByRole("button", { name: "Hacer otro pedido", exact: true })
      .click();
    await expect(
      ordered.getByRole("heading", { name: "Este código ya no funciona" }),
    ).toBeVisible();
    await ordered
      .getByRole("button", { name: "Ver mis pedidos", exact: true })
      .click();
    await expect(orderedHead).toContainText(
      "Esperando confirmación del personal",
    );
    await ordered.reload();
    await expect(ordered.locator(".diner-status-head")).toContainText(
      "Esperando confirmación del personal",
    );
    const fresh = await diner(context, rotated.data.path);
    await expect(fresh.getByText(`Pedido para ${mesa.name}`)).toBeVisible();
  });
});

test("paused: the cashier pauses from the inbox; the diner keeps the menu with sending disabled until ordering resumes", async ({
  page,
  context,
}) => {
  await login(page);
  await withFixture(page, async (f) => {
    const link = await f.link({ kind: "counter", label: `Pausa ${f.id}` });
    const customer = await context.newPage();
    await customer.clock.install();
    await customer.goto(link.path);
    await addTaco(customer);
    const send = customer.getByRole("button", {
      name: "Enviar pedido",
      exact: true,
    });
    await expect(send).toBeEnabled();
    // Sign in as the cashier on the same terminal.
    await page.evaluate(async () => {
      const s = await (await fetch("/api/session")).json();
      await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: s.tenantId,
          login: "cashier",
          secret: "123456",
        }),
      });
    });
    await page.goto("/app");
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    await inbox(page)
      .getByRole("button", { name: "Pausar", exact: true })
      .click();
    await expect(inbox(page)).toContainText("En pausa");
    await customer.clock.fastForward(61_000);
    await expect(customer.locator(".diner-closed").first()).toContainText(
      "El restaurante no está recibiendo pedidos en línea en este momento.",
    );
    await expect(send).toBeDisabled();
    await expect(
      customer.getByRole("button", { name: /^Taco de hongos/ }),
    ).toBeVisible();
    await inbox(page)
      .getByRole("button", { name: "Reanudar", exact: true })
      .click();
    await expect(inbox(page)).toContainText("Recibiendo pedidos");
    await customer.clock.fastForward(61_000);
    await expect(send).toBeEnabled();
    // Back to the owner for the cleanup.
    await page.evaluate(() => fetch("/api/logout", { method: "POST" }));
    await login(page);
  });
});

test("staff offline: the inbox says it is available when the connection returns and disables its actions", async ({
  page,
  context,
}) => {
  await login(page);
  await withFixture(page, async (f) => {
    const link = await f.link({ kind: "counter", label: `Red ${f.id}` });
    const customer = await diner(context, link.path);
    await addTaco(customer);
    await sendOrder(customer, `Red ${f.id}`);
    await expect(customer.locator(".diner-status-head")).toContainText(
      "Esperando confirmación del personal",
    );
    const label = (await customer.locator(".diner-code").innerText()).trim();
    await customer.close();
    await goToOrders(page);
    const card = holdCard(page, label);
    await expect(card).toBeVisible();
    await page
      .locator(".top-actions")
      .getByRole("button", { name: /^Conectado/ })
      .click();
    await page.getByRole("switch", { name: "Trabajar sin conexión" }).check();
    await goToOrders(page);
    await expect(inbox(page)).toContainText(
      "Disponible al volver la conexión.",
    );
    await expect(
      card.getByRole("button", {
        name: "Aceptar y enviar a cocina",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      card.getByRole("button", { name: "Rechazar", exact: true }),
    ).toBeDisabled();
    await page
      .locator(".top-actions")
      .getByRole("button", { name: /^Sin conexión/ })
      .click();
    await page.getByRole("switch", { name: "Trabajar sin conexión" }).uncheck();
    await goToOrders(page);
    await expect(
      card.getByRole("button", {
        name: "Aceptar y enviar a cocina",
        exact: true,
      }),
    ).toBeEnabled();
  });
});

test("abuse: deactivating a code as abuse flags its other orders; accepting one needs the acknowledgement", async ({
  page,
  context,
}) => {
  await login(page);
  await withFixture(page, async (f) => {
    const link = await f.link({ kind: "counter", label: `Abuso ${f.id}` });
    const labels: string[] = [];
    for (const who of ["Uno", "Dos"]) {
      const customer = await diner(context, link.path);
      await customer.getByRole("button", { name: /^Taco de hongos/ }).click();
      await sendOrder(customer, `${who} ${f.id}`);
      await expect(customer.locator(".diner-status-head")).toContainText(
        "Esperando confirmación del personal",
      );
      labels.push((await customer.locator(".diner-code").innerText()).trim());
      await customer.close();
    }
    const [fake, other] = labels;
    await goToOrders(page);
    await holdCard(page, fake)
      .getByRole("button", { name: "Rechazar", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Rechazar pedido ${fake}`,
    });
    await dialog.getByRole("radio", { name: "Pedido falso o abuso" }).check();
    await dialog
      .getByLabel(
        "Desactivar también este código QR (dejará de funcionar el impreso)",
      )
      .check();
    await dialog.getByRole("button", { name: "Rechazar pedido" }).click();
    await expect(inbox(page)).toContainText(`${fake} rechazado.`);
    // PUB-HR-1: the abused code was the only active one, so accepting its
    // last hold empties the next inbox read.
    const before = await call(page, "/ordering/inbox");
    expect(before.data.active).toBe(false);
    expect(before.data.holds).toHaveLength(1);
    // ABUSE-1: the code's other order is flagged and needs a deliberate check.
    const card = holdCard(page, other);
    await expect(card).toContainText(
      "Código desactivado por abuso: verifica con el cliente antes de aceptar.",
    );
    const acceptButton = card.getByRole("button", {
      name: "Aceptar y enviar a cocina",
      exact: true,
    });
    await expect(acceptButton).toBeDisabled();
    await card
      .getByLabel("Lo verifiqué con el cliente; aceptar de todos modos.")
      .check();
    await axe(page);
    const emptied = emptyInboxRead(page);
    await acceptButton.click();
    await emptied;
    // The empty read rendered and the outcome is still announced (MONEY-2).
    await expect(inboxTitle(page)).toHaveText(
      "Pedidos en línea por confirmar (0)",
    );
    const notice = inbox(page).locator('.public-notice[aria-live="polite"]');
    await expect(notice).toHaveText(acceptedNotice(other));
    await expect(holdCard(page, other)).toHaveCount(0);
    await axe(page);
    // Dismissing the notice lets the empty inbox go.
    await inbox(page)
      .getByRole("button", { name: "Ocultar aviso", exact: true })
      .click();
    await expect(inbox(page)).toHaveCount(0);
    const order = await acceptedOrder(page, `Dos ${f.id}`);
    expect(order).toBeTruthy();
    f.orders.push(order!.id);
  });
});

test("price change: the acknowledgement covers the total staff saw; a newer price needs a new one, and the diner sees the confirmed total", async ({
  page,
  context,
}) => {
  await login(page);
  const menu = (await call(page, "/menu")).data as {
    categories: { id: string; name: { es: string } }[];
  };
  const id = crypto.randomUUID();
  const productName = `Precio ${runId()}`;
  const save = async (price: number, expectedVersion: number) => {
    const r = await call(page, "/menu/products/save", {
      operationId: op(),
      id,
      expectedVersion,
      name: { es: productName, en: "" },
      categoryId: menu.categories.find((c) => c.name.es === "Antojitos")!.id,
      kind: "item",
      price,
      station: "kitchen",
      groupIds: [],
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return r.data.version as number;
  };
  let version = await save(4000, 0);
  try {
    await withFixture(page, async (f) => {
      const link = await f.link({ kind: "counter", label: `Precio ${f.id}` });
      const customer = await diner(context, link.path);
      await customer
        .getByRole("button", { name: new RegExp(`^${productName}`) })
        .click();
      await sendOrder(customer, `Precio ${f.id}`);
      const head = customer.locator(".diner-status-head");
      await expect(head).toContainText("Esperando confirmación del personal");
      const label = (await customer.locator(".diner-code").innerText()).trim();
      version = await save(5000, version);
      await goToOrders(page);
      const card = holdCard(page, label);
      await expect(card).toContainText("Total actual");
      await expect(card).toContainText("$50.00");
      const ack = card.getByLabel(
        "El precio cambió desde que el cliente pidió. Ya le avisé.",
      );
      const acceptButton = card.getByRole("button", {
        name: "Aceptar y enviar a cocina",
        exact: true,
      });
      await expect(acceptButton).toBeDisabled();
      await ack.check();
      await expect(acceptButton).toBeEnabled();
      // MONEY-1: the price moves again; the next inbox read clears the
      // acknowledgement, so the new total needs a new one.
      version = await save(6500, version);
      await expect(card).toContainText("$65.00", { timeout: 20000 });
      await expect(ack).not.toBeChecked();
      await expect(acceptButton).toBeDisabled();
      await ack.check();
      await acceptButton.click();
      await expect(inbox(page)).toContainText(acceptedNotice(label));
      const order = await acceptedOrder(page, `Precio ${f.id}`);
      expect(order).toBeTruthy();
      f.orders.push(order!.id);
      const full = (await call(page, `/orders/${order!.id}`)).data;
      expect(full.total).toBe(6500);
      // PRIVACY-1: the diner sees the confirmed price, not the one sent.
      await expect(customer.locator(".diner-price-changed")).toContainText(
        "El precio cambió al confirmar tu pedido; total confirmado: $65.00.",
        { timeout: 20000 },
      );
      await expect(customer.locator(".diner-status .diner-line")).toContainText(
        "$65.00",
      );
    });
  } finally {
    await call(page, "/menu/products/archive", {
      operationId: op(),
      id,
      expectedVersion: version,
      archived: true,
    });
  }
});

test("inbox details: a table's second order pre-selects the check the first one opened; a card another terminal handled keeps its outcome in the notice", async ({
  page,
  context,
}) => {
  await login(page);
  await withFixture(page, async (f) => {
    const [mesa] = await f.makeTables();
    const link = await f.link({ kind: "table", tableId: mesa.id });
    const labels: string[] = [];
    for (const who of ["Uno", "Dos", "Tres"]) {
      const customer = await diner(context, link.path);
      await customer.getByRole("button", { name: /^Taco de hongos/ }).click();
      await sendOrder(customer, `${who} ${f.id}`);
      await expect(customer.locator(".diner-status-head")).toContainText(
        "Esperando confirmación del personal",
      );
      labels.push((await customer.locator(".diner-code").innerText()).trim());
      await customer.close();
    }
    const [first, second, third] = labels;
    await goToOrders(page);
    // No check is open yet: every card offers "Cuenta nueva".
    await expect(holdCard(page, second).getByLabel("Enviar a")).toHaveValue(
      "new",
    );
    await holdCard(page, first)
      .getByRole("button", { name: "Aceptar y enviar a cocina", exact: true })
      .click();
    await expect(inbox(page)).toContainText(acceptedNotice(first));
    const order = await acceptedOrder(page, `Uno ${f.id}`);
    expect(order).toBeTruthy();
    f.orders.push(order!.id);
    // MONEY-3: the next read finds the check the first order opened; the
    // untouched second card now pre-selects it.
    await expect(holdCard(page, second).getByLabel("Enviar a")).toHaveValue(
      order!.id,
    );
    // UX-7: another terminal rejects the third order; this card's accept
    // then meets "already handled", and the outcome outlives the card.
    const listed = await call(page, "/ordering/inbox");
    const hold = (listed.data.holds as { id: string; label: string }[]).find(
      (h) => h.label === third,
    )!;
    await call(page, `/ordering/holds/${hold.id}/reject`, {
      operationId: op(),
      reason: "duplicate",
    });
    await holdCard(page, third)
      .getByRole("button", { name: "Aceptar y enviar a cocina", exact: true })
      .click();
    const notice = inbox(page).locator('.public-notice[aria-live="polite"]');
    await expect(notice).toHaveText(`${third}: Este pedido ya fue atendido.`);
    await expect(holdCard(page, third)).toHaveCount(0);
    await expect(notice).toHaveText(`${third}: Este pedido ya fue atendido.`);
  });
});

test("legacy signed links show the invalid-code page without calling the API", async ({
  context,
}) => {
  const page = await context.newPage();
  const calls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/public"))
      calls.push(r.url());
  });
  for (const path of [
    "/qr/eyJhbGciOi.fake",
    "/kiosk/v2.k1.payload.sig",
    "/qr",
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "Este código ya no funciona" }),
    ).toBeVisible();
    await expect(
      page.getByText("Pide al personal un código nuevo."),
    ).toBeVisible();
  }
  expect(calls).toEqual([]);
});

test("diner pages never register the service worker", async ({
  page,
  browser,
}) => {
  test.skip(!process.env.TEST_PRODUCTION, "Needs the compiled service worker");
  await login(page);
  await withFixture(page, async (f) => {
    const link = await f.link({ kind: "counter", label: `SW ${f.id}` });
    // A fresh browser profile: only the diner page ever loads in it.
    const fresh = await (browser as Browser).newContext();
    try {
      const customer = await fresh.newPage();
      await customer.goto(link.path);
      await expect(
        customer.getByRole("button", { name: /^Taco de asada/ }),
      ).toBeVisible();
      await customer.waitForTimeout(1500);
      expect(
        await customer.evaluate(
          async () => (await navigator.serviceWorker.getRegistrations()).length,
        ),
      ).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});
