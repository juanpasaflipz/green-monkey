import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { kitchenHygiene } from "./kitchen-hygiene.js";

// Payments (037), phase P1 (spec §12.3 items 5, 9 and the P1 parts of 1, 6, 8): named manual
// terminals with a fee, delivery platforms with a commission and per-platform prices (LD-72),
// the "Pagado por plataforma" tender, the drawer by terminal and platform, and the CFDI
// platform FormaPago. The demo owner "Alex Demo" configures and sells. Every setting the spec
// changes is undone at the end, so later specs see the demo restaurant as before.
const OWNER_PASSWORD = "demo-green-monkey";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const tag = () => "pay" + Math.random().toString(36).slice(2, 7);
kitchenHygiene();

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}
async function go(page: Page, view: string, operation = "Operación") {
  await expect(page.locator("nav.rail")).toBeVisible();
  const rail = page
    .locator("nav.rail")
    .getByRole("button", { name: operation, exact: true });
  if (await rail.count()) await rail.click();
  await page.getByRole("button", { name: view, exact: true }).click();
}
/** Calls the API as the page's session. */
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
const uuid = () => crypto.randomUUID();
async function openDrawer(page: Page, opening = 50000) {
  const current = await call(page, "/cash");
  if (!current || current.closed_at)
    await call(page, "/cash/open", { operationId: uuid(), opening });
}
async function axe(page: Page, selector: string) {
  const result = await new AxeBuilder({ page })
    .include(selector)
    .withTags(AXE_TAGS)
    .analyze();
  expect(result.violations).toEqual([]);
}

test("Configuración: a terminal with its fee, a platform's commission and a product's Uber Eats price; a platform sale and a named-terminal sale; the drawer splits them; all undone at the end", async ({
  page,
}) => {
  const terminal = "BBVA " + tag();
  await login(page);
  await openDrawer(page);
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  const panel = page.locator("section.payment-settings");
  await expect(panel).toContainText("Pagos con tarjeta y plataformas");
  // A manual bank terminal with its fee (1.75 %).
  await panel
    .getByLabel("Nombre de la terminal", { exact: true })
    .fill(terminal);
  await panel.getByLabel("Comisión (% con IVA)", { exact: true }).fill("1.75");
  await panel
    .getByRole("button", { name: "Agregar terminal", exact: true })
    .click();
  const row = panel.locator("tr").filter({ hasText: terminal });
  await expect(row).toContainText("1.75 %");
  await expect(row).toContainText("Manual");
  // Platforms are off until the owner turns them on (LD-75): Uber Eats on, and DiDi Food's
  // estimated commission.
  await expect(
    panel.getByLabel("Uber Eats", { exact: true }),
  ).not.toBeChecked();
  await expect(panel.getByLabel("Otra", { exact: true })).not.toBeChecked();
  await panel.getByLabel("Uber Eats", { exact: true }).check();
  const didiCommission = panel.getByLabel("Comisión estimada (%) · DiDi Food", {
    exact: true,
  });
  // PAYMENTS-UX-6: a bad percentage is named under «Guardar plataformas» and its field is marked.
  await didiCommission.fill("treinta");
  await panel
    .getByRole("button", { name: "Guardar plataformas", exact: true })
    .click();
  await expect(panel.locator("#payments-platforms-error")).toContainText(
    "Comisión estimada (%) · DiDi Food",
  );
  await expect(didiCommission).toHaveAttribute("aria-invalid", "true");
  await didiCommission.fill("25");
  await panel
    .getByRole("button", { name: "Guardar plataformas", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("Guardado");
  // Taco de hongos sells at $59.00 on Uber Eats.
  await panel
    .getByLabel("Buscar producto", { exact: true })
    .fill("Taco de hongos");
  const tacoUber = panel.getByLabel("Taco de hongos · Uber Eats", {
    exact: true,
  });
  await tacoUber.fill("59");
  // PAYMENTS-UX-5: saving another section keeps the typed, unsaved price.
  await panel
    .getByRole("button", { name: "Guardar plataformas", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("Guardado");
  await expect(tacoUber).toHaveValue("59");
  await panel
    .getByRole("button", { name: "Guardar precios", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("Guardado");
  await expect(tacoUber).toHaveValue("59.00");
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await axe(page, "section.payment-settings");
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // An order rung at Uber Eats prices, paid by the platform.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await go(page, "Vender");
  await page
    .getByRole("combobox", { name: "Precios", exact: true })
    .selectOption({ label: "Uber Eats" });
  // PAYMENTS-MONEY-7: the tile shows the list's price, as the cart line will.
  await expect(
    page.getByRole("button", { name: /Taco de hongos/ }).first(),
  ).toContainText("$59.00");
  await page
    .getByRole("button", { name: /Taco de hongos/ })
    .first()
    .click();
  await expect(page.locator(".cart-lines")).toContainText("$59.00");
  // PAYMENTS-UX-1: the price list is visible next to the cart's state.
  await expect(page.locator(".cart-badges")).toContainText(
    "Pedido con precios de Uber Eats",
  );
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Plataforma", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(dialog).toContainText(
    "La plataforma cubre todo el saldo: $59.00. Sin propina.",
  );
  await expect(dialog.getByLabel("Propina", { exact: true })).toHaveCount(0);
  // Uber Eats needs its order number (LD-75).
  await dialog.getByLabel("La plataforma ya cobró este pedido").check();
  await expect(
    dialog.getByRole("button", { name: "Confirmar cobro", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Número de pedido de la plataforma", { exact: true })
    .fill("UE-1");
  await axe(page, "dialog");
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Pagado en Uber Eats");
  await expect(page.locator(".receipt")).toContainText("UE-1");
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();

  // A card sale recorded on the named terminal, on the pilot's iPad (1024×768, the compact
  // layout; PAYMENTS-UX-18): the card form with its terminal chips never pushes Confirm below
  // the fold (FOH-10).
  await page.setViewportSize({ width: 1024, height: 768 });
  await page
    .getByRole("button", { name: /Taco de hongos/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await dialog.getByRole("button", { name: "Tarjeta", exact: true }).click();
  await dialog.getByRole("button", { name: terminal, exact: true }).click();
  await dialog.getByLabel("Referencia de aprobación").fill("4471");
  await dialog.getByLabel("Confirmo que la terminal aprobó este pago").check();
  await expect(
    dialog.getByRole("button", { name: "Confirmar cobro", exact: true }),
  ).toBeInViewport();
  await axe(page, "dialog");
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText(`Tarjeta · ${terminal}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();

  // Caja: the platform money is apart from cash and card; card money by terminal.
  await go(page, "Caja");
  const platforms = page
    .locator(".drawer-card")
    .filter({ hasText: "Pagado por plataformas" });
  await expect(platforms).toContainText("Uber Eats");
  await expect(platforms).toContainText("$59.00");
  // PAYMENTS-UX-7: the platforms total is not a terminal net.
  await expect(platforms).toContainText("Total plataformas");
  await expect(platforms).not.toContainText("Neto en terminal");
  const byTerminal = page.locator("table").filter({ hasText: terminal });
  await expect(byTerminal).toContainText("Tarjeta por terminal");
  await expect(byTerminal).toContainText("$45.00");
  // PAYMENTS-UX-13: refunds have their own column.
  await expect(byTerminal.locator("thead")).toContainText("Reembolsos");

  // Undo: archive the terminal, clear the price, turn Uber Eats off and clear DiDi's commission
  // (both platforms back to their default: off).
  const view = await call(page, "/payments/settings");
  const created = view.terminals.find((t: any) => t.name === terminal);
  await call(page, `/payments/terminals/${created.id}/archive`, {
    operationId: uuid(),
    expectedVersion: created.version,
  });
  const catalog = await call<any[]>(page, "/catalog");
  const taco = catalog.find((p) => p.name.es === "Taco de hongos");
  const price = view.prices.find(
    (p: any) => p.productId === taco.id && p.platform === "uber_eats",
  );
  await call(page, "/payments/platform-prices", {
    operationId: uuid(),
    prices: [
      {
        productId: taco.id,
        platform: "uber_eats",
        price: null,
        expectedVersion: price.version,
      },
    ],
  });
  await call(page, "/payments/platforms", {
    operationId: uuid(),
    platforms: ["didi_food", "uber_eats"].map((code) => ({
      platform: code,
      enabled: false,
      commissionBp: null,
      expectedVersion: view.platforms.find((p: any) => p.platform === code)
        .version,
    })),
  });
  const after = await call<any[]>(page, "/catalog");
  expect(after.some((p) => p.platformPrices)).toBe(false);
});

test("CFDI: the platform FormaPago select offers 31 (recommended), 03, 04 and 28 and never 99", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  const settings = await call(page, "/cfdi/settings").catch(() => null);
  test.skip(
    !settings?.settings,
    "CFDI is not activated for the demo restaurant in this run",
  );
  const select = page.getByRole("combobox", {
    name: "Forma de pago SAT para pedidos pagados por plataforma",
    exact: true,
  });
  await expect(select).toBeVisible();
  const options = await select.locator("option").allTextContents();
  expect(options.map((o) => o.slice(0, 2))).toEqual(["31", "03", "04", "28"]);
  expect(options[0]).toContain("recomendado");
  expect(options.join(" ")).not.toContain("99");
});

// ---------------------------------------------------------------------------------------------
// P2: integrated Mercado Pago Point and Clip charging against the payments fake
// (`npm run dev:payments-fake`, the worker with PAYMENTS_PROVIDERS and the fake's API bases, as
// CI starts them). Spec §12.3 items 1-4. Every credential typed here is fictional.
// ---------------------------------------------------------------------------------------------

const FAKE_URL = process.env.PAYMENTS_FAKE_URL ?? "http://127.0.0.1:4899";
/**
 * Scripts the payments fake: the customer pays, the card is refused, the next create is lost…
 * An action on a device waits (up to 20 s) for the worker to have pushed the charge there.
 */
async function fake(action: string, body: object) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${FAKE_URL}/__fake/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    expect(r.status === 404 && i < 80, `payments fake ${action}`).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
/**
 * The worker serves both providers. In CI (which starts the worker with the payments fake,
 * qualification.yml) a worker without them fails the test; only a local run may skip.
 */
async function integratedReady(page: Page) {
  const caps = await call(page, "/capabilities");
  const served =
    caps.mercadopago?.reason !== "worker_not_configured" &&
    caps.clip?.reason !== "worker_not_configured";
  if (process.env.CI)
    expect(served, "CI runs the worker with the payments fake").toBe(true);
  return served;
}
const TEST_CREDENTIALS = {
  mercadopago: [
    "TEST-mp-access-token-not-real-0000",
    "testWebhookSecretNotReal0000",
  ],
  clip: ["test-clip-api-key-not-real", "test-clip-secret-key-not-real"],
} as const;

test("integrated charging: the owner connects Mercado Pago and Clip (the URL shown once), adds the found devices as terminals; a cashier's charge waits on the terminal and settles with the card; a decline retries; an unknown outcome is resolved by a manager; all undone at the end", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await login(page);
  test.skip(
    !(await integratedReady(page)),
    "needs the worker with the payments fake",
  );
  await openDrawer(page);
  const suffix = tag();
  const names = { mp: "MP Caja " + suffix, clip: "Clip Caja " + suffix };
  // A previous run's terminals on the fake's devices are archived and its accounts
  // disconnected first (the owner's step-up is fresh).
  const before = await call(page, "/payments/settings");
  for (const left of before.terminals.filter(
    (t: any) =>
      !t.archivedAt &&
      ["NEWLAND_N950__FAKE0001", "P8220724FAKE01"].includes(t.providerDeviceId),
  ))
    await call(page, `/payments/terminals/${left.id}/archive`, {
      operationId: uuid(),
      expectedVersion: left.version,
    });
  for (const provider of ["mercadopago", "clip"])
    await call(page, `/payments/providers/${provider}/disable`, {});
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  const panel = page.locator("section.payment-settings");
  for (const [provider, title, connectLabel, find, device, name, account] of [
    [
      "mercadopago",
      "Mercado Pago",
      "Conectar Mercado Pago",
      "Buscar terminales",
      "NEWLAND_N950__FAKE0001",
      names.mp,
      "Conectado como RESTAURANTE_FICTICIO",
    ],
    [
      "clip",
      "Clip",
      "Conectar Clip",
      "Buscar lectores",
      "P8220724FAKE01",
      names.clip,
      "Conectado como Clip · 1 lector",
    ],
  ] as const) {
    const section = panel.getByRole("region", { name: title, exact: true });
    await section
      .getByRole("button", { name: connectLabel, exact: true })
      .click();
    const form = section.getByRole("form", { name: connectLabel });
    const [first, second] = TEST_CREDENTIALS[provider];
    await form
      .getByLabel(
        provider === "mercadopago" ? "Access Token de producción" : "API key",
        { exact: true },
      )
      .fill(first);
    await form
      .getByLabel(
        provider === "mercadopago"
          ? "Clave secreta de notificaciones"
          : "Clave secreta",
        { exact: true },
      )
      .fill(second);
    await form.getByRole("button", { name: "Conectar", exact: true }).click();
    // The notification URL, once, with Copiar; the keys never come back.
    const url = panel.getByLabel("URL de notificaciones", { exact: true });
    await expect(url).toHaveValue(
      new RegExp(`/api/payments/webhooks/${provider}/[A-Za-z0-9_-]{22}$`),
    );
    await expect(panel).toContainText(
      "Cópiala ahora: se muestra una sola vez.",
    );
    await expect(page.locator("input[type=password]")).toHaveCount(0);
    // Clip takes the URL with every charge: the panel says there is nowhere to paste it.
    if (provider === "clip")
      await expect(panel).toContainText(
        "Clip la recibe con cada cobro: no tienes que pegarla en ningún lado.",
      );
    await panel.getByRole("button", { name: "Cerrar", exact: true }).click();
    await expect(url).toHaveCount(0);
    await expect(section).toContainText(account, { timeout: 30_000 });
    await section.getByRole("button", { name: find, exact: true }).click();
    const found = section
      .getByRole("region", { name: new RegExp(`· ${title}$`) })
      .locator("tr")
      .filter({ hasText: device });
    await expect(found).toBeVisible({ timeout: 30_000 });
    await found
      .getByRole("button", { name: "Agregar como terminal", exact: true })
      .click();
    // The form above takes the focus (and scrolls into view on a phone).
    await expect(
      panel.getByLabel("Nombre de la terminal", { exact: true }),
    ).toBeFocused();
    await panel.getByLabel("Nombre de la terminal", { exact: true }).fill(name);
    await panel.getByLabel("Comisión (% con IVA)", { exact: true }).fill("3.5");
    await panel
      .getByRole("button", { name: "Agregar terminal", exact: true })
      .click();
    await expect(
      panel
        .getByRole("region", { name: "Terminales", exact: true })
        .locator("tr")
        .filter({ hasText: name }),
    ).toContainText("3.50 %");
  }
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await axe(page, "section.payment-settings");
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // A cashier's card charge: Tarjeta → the MP terminal → Enviar → the customer pays.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
  await go(page, "Vender");
  const dialog = page.getByRole("dialog");
  async function sendOn(terminal: string) {
    await page
      .getByRole("button", { name: /Taco de hongos/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await dialog.getByRole("button", { name: "Tarjeta", exact: true }).click();
    await dialog
      .getByRole("button", { name: new RegExp(`^${terminal}`) })
      .click();
    await expect(dialog.getByLabel("Referencia de aprobación")).toHaveCount(0);
    await dialog
      .getByRole("button", { name: `Enviar a ${terminal}`, exact: true })
      .click();
  }
  await sendOn(names.mp);
  await expect(dialog.getByRole("status").first()).toContainText(
    `Esperando el pago en ${names.mp}…`,
  );
  // What the terminal charges cannot change while it waits: the split controls are off.
  await expect(
    dialog.getByRole("button", { name: "Dividir por importe", exact: true }),
  ).toBeDisabled();
  await axe(page, "dialog");
  await fake("approve", {
    device: "NEWLAND_N950__FAKE0001",
    approval: { brand: "visa", type: "credit_card", last4: "4242" },
  });
  await expect(page.locator(".receipt")).toContainText(
    `Tarjeta · ${names.mp}`,
    {
      timeout: 20_000,
    },
  );
  await expect(page.locator(".receipt")).toContainText("4242");
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();

  // Declined at the terminal → Reintentar → paid.
  await sendOn(names.mp);
  await expect(dialog).toContainText(`Esperando el pago en ${names.mp}…`);
  await fake("decline", { device: "NEWLAND_N950__FAKE0001" });
  await expect(dialog).toContainText("La terminal rechazó el cobro", {
    timeout: 20_000,
  });
  await dialog.getByRole("button", { name: "Reintentar", exact: true }).click();
  await dialog
    .getByRole("button", { name: `Enviar a ${names.mp}`, exact: true })
    .click();
  await expect(dialog).toContainText(`Esperando el pago en ${names.mp}…`);
  await fake("approve", {
    device: "NEWLAND_N950__FAKE0001",
    approval: { brand: "visa", type: "credit_card", last4: "4242" },
  });
  await expect(page.locator(".receipt")).toContainText(
    `Tarjeta · ${names.mp}`,
    {
      timeout: 20_000,
    },
  );
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();

  // Clip loses the create's answer and the reader has already taken the request: unknown, never a
  // blind retry; the manager records it. (A request the reader had not taken is withdrawn by
  // serial number and cancelled: P2 DB suite.)
  await fake("next", { provider: "clip", behaviour: "timeoutTaken" });
  await sendOn(names.clip);
  await expect(dialog).toContainText("No sabemos si el cobro se completó", {
    timeout: 30_000,
  });
  await expect(
    dialog.getByRole("button", { name: "Reintentar", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Resolver cobro", exact: true })
    .click();
  const resolve = page.getByRole("dialog", {
    name: "Resolver cobro en terminal",
  });
  await resolve
    .getByRole("radio", { name: "Sí se cobró: registrar en la orden" })
    .check();
  // A reference unique to this run: the browser suite may run twice on one database, and a
  // reference already recorded on another charge is refused (payments_reference_taken).
  await resolve
    .getByLabel("Referencia del proveedor")
    .fill(`AUT${Date.now().toString(36).toUpperCase()}`);
  // No amount from Clip: the manager types what the provider's history shows (the amount sent).
  const sent = /\$([\d,]+\.\d{2})/.exec(
    (await resolve.locator("p strong").first().textContent()) ?? "",
  )?.[1];
  expect(sent).toBeTruthy();
  await resolve.getByLabel("Importe cobrado (según el proveedor)").fill(sent!);
  await resolve
    .getByLabel("Motivo (mínimo 10 caracteres)")
    .fill("Aprobado en la pantalla del lector (prueba)");
  await resolve.getByLabel("Revisé el historial del proveedor").check();
  await axe(page, "dialog[open]");
  await resolve.getByRole("button", { name: "Resolver", exact: true }).click();
  await expect(page.locator(".receipt")).toContainText(
    `Tarjeta · ${names.clip}`,
    {
      timeout: 20_000,
    },
  );
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();
  // The reader completes the payment the manager recorded (the fake's reader is free again).
  await fake("approve", { device: "P8220724FAKE01", approval: {} });

  // P2-UX-15. «Cancelar cobro» while the order is still on the device (MP cancels an order it has
  // not handed over); the waiting panel passes axe at the tablet and phone widths.
  await sendOn(names.mp);
  await expect(dialog).toContainText(`Esperando el pago en ${names.mp}…`);
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await axe(page, "dialog[open]");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog
    .getByRole("button", { name: "Cancelar cobro", exact: true })
    .click();
  await expect(dialog).toContainText("Cobro cancelado", { timeout: 20_000 });
  // «Cambiar de terminal»: the MP charge is cancelled first (confirmed), then the same order goes
  // to Clip, where it is paid.
  await dialog.getByRole("button", { name: "Reintentar", exact: true }).click();
  await dialog
    .getByRole("button", { name: `Enviar a ${names.mp}`, exact: true })
    .click();
  await expect(dialog).toContainText(`Esperando el pago en ${names.mp}…`);
  await dialog
    .getByRole("button", { name: "Cambiar de terminal", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: new RegExp(`^${names.clip}`) })
    .click({ timeout: 20_000 });
  await dialog
    .getByRole("button", { name: `Enviar a ${names.clip}`, exact: true })
    .click();
  await expect(dialog).toContainText(`Esperando el pago en ${names.clip}…`);
  // The reader took it: Clip refuses the cancel («Cancélalo en la terminal»); the cashier cancels
  // on the reader and «Volver a consultar» confirms it.
  await fake("atTerminalUncancellable", { device: "P8220724FAKE01" });
  await dialog
    .getByRole("button", { name: "Cancelar cobro", exact: true })
    .click();
  await expect(dialog).toContainText(
    "La terminal ya tomó el cobro. Cancélalo en la terminal.",
    { timeout: 20_000 },
  );
  await fake("cancelOnTerminal", { device: "P8220724FAKE01" });
  await dialog
    .getByRole("button", { name: "Volver a consultar", exact: true })
    .click();
  await expect(dialog).toContainText("Cobro cancelado", { timeout: 20_000 });
  await dialog.getByRole("button", { name: "Reintentar", exact: true }).click();
  await dialog
    .getByRole("button", { name: `Enviar a ${names.clip}`, exact: true })
    .click();
  await fake("approve", {
    device: "P8220724FAKE01",
    approval: { brand: "visa", type: "debit_card", last4: "4444" },
  });
  await expect(page.locator(".receipt")).toContainText(
    `Tarjeta · ${names.clip}`,
    { timeout: 20_000 },
  );
  await page
    .getByRole("button", { name: "Siguiente venta", exact: true })
    .click();
  // A reload mid-charge (P2-MONEY-6, P2-UX-2): the charge goes on, «Cobros en terminal en curso»
  // lists it after the reload, and any operator cancels it there.
  await sendOn(names.mp);
  await expect(dialog).toContainText(`Esperando el pago en ${names.mp}…`);
  await page.reload();
  await go(page, "Vender");
  const banner = page.locator("section.active-charges");
  await expect(banner).toContainText("Cobros en terminal en curso (1)", {
    timeout: 20_000,
  });
  await banner.getByRole("button", { name: "Ver", exact: true }).click();
  await axe(page, "section.active-charges");
  await banner.getByRole("button", { name: /^Cancelar cobro #/ }).click();
  await expect(banner).toHaveCount(0, { timeout: 30_000 });

  // Undo: archive both terminals and disconnect both accounts (the worker wipes the keys).
  const view = await call(page, "/payments/settings");
  for (const name of [names.mp, names.clip]) {
    const created = view.terminals.find((t: any) => t.name === name);
    await call(page, `/payments/terminals/${created.id}/archive`, {
      operationId: uuid(),
      expectedVersion: created.version,
    });
  }
  for (const provider of ["mercadopago", "clip"])
    await call(page, `/payments/providers/${provider}/disable`, {});
  const caps = await call(page, "/capabilities");
  expect(caps.mercadopago).toEqual({ enabled: false, reason: "not_connected" });
  expect(caps.clip).toEqual({ enabled: false, reason: "not_connected" });
});
