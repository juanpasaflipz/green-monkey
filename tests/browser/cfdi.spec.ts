/**
 * cfdi (030) browser checks (spec §7.5). Role and label selectors on the demo fixture.
 *
 * Two groups:
 *  - always: the Configuración panel before activation and the public self-invoicing portal
 *    (no fiscal ticket needed);
 *  - stamping flows: fiscal 027 tickets and the worker with the Facturapi fake
 *    (`npm run dev:facturapi-fake` and the worker with FACTURAPI_BASE_URL, as CI starts them).
 *    GET /api/fiscal/context must answer; only a local run without the worker (/api/capabilities
 *    reports facturapi disabled) skips them, never CI. Each leaves CFDI paused (settings
 *    `enabled: false`) in a finally so the other specs never see Facturar buttons or the printed
 *    block.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TEST_CSD, TEST_CSD_PASSWORD } from "../fixtures/cfdi/test-csd";
import { kitchenHygiene } from "./kitchen-hygiene.js";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];
const RECEPTOR = {
  rfc: "EKU9003173C9",
  legalName: "ESCUELA KEMPER URGATE",
  regime: "601",
  postalCode: "42501",
};
const uuid = () => crypto.randomUUID();

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill("demo-green-monkey");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}

/** Calls the API from the page with the session's CSRF token. */
async function call<T = any>(
  page: Page,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ path, body }) => {
      const s = await (await fetch("/api/session")).json();
      const r = await fetch("/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: await r.json() };
    },
    { path, body },
  ) as Promise<{ status: number; body: T }>;
}

const panel = (page: Page) =>
  page.getByRole("region", {
    name: "Facturación electrónica (CFDI)",
    exact: true,
  });

async function openSettings(page: Page) {
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  await expect(panel(page)).toBeVisible();
}

async function noHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

// W3-2: every round a test sends to the kitchen is delivered after it.
kitchenHygiene();

test("Configuración shows the CFDI panel before activation: badge, prerequisites and intro, no button named Guardar, axe-clean at 390 px", async ({
  page,
}) => {
  await login(page);
  const status = await call(page, "/cfdi/status");
  expect(status.status).toBe(200);
  await openSettings(page);
  const cfdi = panel(page);
  await expect(
    cfdi.getByRole("heading", {
      name: "Facturación electrónica (CFDI)",
      exact: true,
    }),
  ).toBeVisible();
  if (!status.body.available)
    await expect(
      cfdi.getByText("No disponible", { exact: true }),
    ).toBeVisible();
  if (status.body.enabled === false && !status.body.mode) {
    await expect(
      cfdi.getByRole("heading", { name: "Requisitos", exact: true }),
    ).toBeVisible();
    await expect(cfdi.getByText(/Emitirás facturas CFDI 4\.0/)).toBeVisible();
    await expect(
      cfdi.getByRole("button", { name: "Activar en modo prueba" }),
    ).toBeVisible();
    // LD-51 F2: activation asks for the global periodicity (monthly by default, D4) and says how
    // it bounds self-invoicing (F1).
    await expect(
      cfdi.getByLabel("Periodicidad de la factura global"),
    ).toHaveValue("month");
    await expect(
      cfdi.getByText(/al cierre del mes del consumo más \d+ min/),
    ).toBeVisible();
  }
  // The Configuración view keeps a single "Guardar" (RestaurantSettings) and its status text.
  await expect(
    cfdi.getByRole("button", { name: "Guardar", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Facturación CFDI (Facturapi)", { exact: true }),
  ).toHaveCount(1);
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    const axe = await new AxeBuilder({ page })
      .include(".cfdi-settings")
      .withTags(AXE_TAGS)
      .analyze();
    expect(axe.violations).toEqual([]);
    await noHorizontalScroll(page);
  }
});

test("self-invoicing portal: /factura refuses short and unknown codes, switches to English, registers no service worker and is axe-clean at 390 px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/factura");
  await expect(
    page.getByRole("heading", { name: "Factura tu consumo", exact: true }),
  ).toBeVisible();
  const code = page.getByLabel("Código de facturación");
  await code.fill("7K3M-9QX2");
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "No encontramos ese código. Revisa que esté completo (12 caracteres).",
  );
  // Well-formed but unknown (O→0, I/L→1 normalization happens on the server too).
  await code.fill("zzzz-zzzz-zzz0");
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "No encontramos ese código. Revisa que esté completo (12 caracteres).",
  );
  expect(
    (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations,
  ).toEqual([]);
  await noHorizontalScroll(page);
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Invoice your purchase", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(
    await page.evaluate(async () =>
      "serviceWorker" in navigator
        ? (await navigator.serviceWorker.getRegistrations()).length
        : 0,
    ),
  ).toBe(0);
});

test("self-invoicing portal: /f/{code} pre-fills the grouped code and looks it up once; ?lang=en starts in English", async ({
  page,
}) => {
  const lookups: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/cfdi/portal/tickets/")) lookups.push(r.url());
  });
  await page.goto("/f/7k3m9qx2pa8d?lang=en");
  await expect(page.getByLabel("Invoice code")).toHaveValue("7K3M-9QX2-PA8D");
  await expect(page.getByRole("alert")).toHaveText(
    "We could not find that code. Check that it is complete (12 characters).",
  );
  expect(lookups).toHaveLength(1);
  expect(lookups[0]).toMatch(/\/tickets\/7K3M9QX2PA8D$/);
});

// ---------------------------------------------------------------------------------------------
// Stamping flows (fiscal 027 tickets + worker + Facturapi fake)
// ---------------------------------------------------------------------------------------------

/**
 * Fiscal 027 is merged, so GET /api/fiscal/context must answer. In CI (which starts the worker
 * with the Facturapi fake, qualification.yml) a disabled provider fails the test; only a local run
 * without the worker may skip the stamping flows (review CFDI-R5).
 */
async function stampingReady(page: Page) {
  const fiscal = await call(page, "/fiscal/context");
  const caps = await call(page, "/capabilities");
  expect(fiscal.status, "fiscal 027 is merged").toBe(200);
  if (process.env.CI)
    expect(
      caps.body?.facturapi?.enabled,
      "CI runs the worker with the Facturapi fake",
    ).toBe(true);
  return fiscal.status === 200 && caps.body?.facturapi?.enabled === true;
}

/** The demo fiscal profile carries the CSD fixture's identity; returns the previous profile. */
async function ensureFiscalIdentity(page: Page) {
  const before = (await call(page, "/fiscal/profile")).body;
  if (before?.complete && before.issuer?.rfc === RECEPTOR.rfc) return null;
  const saved = await call(page, "/fiscal/profile", {
    operationId: uuid(),
    expectedVersion: before?.version ?? 0,
    identity: { ...RECEPTOR },
    ticketSeries: before?.ticketSeries ?? "",
    taxRegion: before?.taxRegion ?? "general",
    defaultTaxCategory: before?.defaultTaxCategory ?? "iva16",
    borderConfirmed: false,
  });
  expect(saved.status).toBe(200);
  return before;
}

async function settings(page: Page) {
  const r = await call(page, "/cfdi/settings");
  expect(r.status).toBe(200);
  return r.body;
}

/** Activated, organization ready, CSD valid and invoicing on (API; the UI test covers it). */
async function ensureCfdiOn(page: Page) {
  let v = await settings(page);
  if (!v.settings) {
    expect(
      (
        await call(page, "/cfdi/activate", {
          operationId: uuid(),
          expectedVersion: 0,
        })
      ).status,
    ).toBe(200);
  }
  await expect
    .poll(async () => (await settings(page)).organization?.status, {
      timeout: 30_000,
    })
    .toBe("ready");
  v = await settings(page);
  if (
    v.organization.source === "own" &&
    v.organization.csd.status !== "valid"
  ) {
    await call(page, "/cfdi/csd", {
      operationId: uuid(),
      cer: TEST_CSD.cer,
      key: TEST_CSD.key,
      password: TEST_CSD_PASSWORD,
    });
    await expect
      .poll(async () => (await settings(page)).organization?.csd.status, {
        timeout: 30_000,
      })
      .toBe("valid");
    v = await settings(page);
  }
  if (!v.settings.enabled) await saveSettings(page, { enabled: true });
  // The page read its CFDI status (canInvoice, the printed block) at sign-in, before CFDI was
  // turned on through the API: reload so it reads it again, as a sign-in would.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Hoy", exact: true }),
  ).toBeVisible();
}

async function saveSettings(page: Page, patch: Record<string, unknown>) {
  const v = await settings(page);
  const s = v.settings;
  const r = await call(page, "/cfdi/settings", {
    operationId: uuid(),
    expectedVersion: s.version,
    enabled: s.enabled,
    globalPeriodicity: s.nextPeriodicity ?? s.globalPeriodicity,
    globalAuto: s.globalAuto,
    conceptMode: s.conceptMode,
    conceptDescription: s.conceptDescription,
    cardPaymentForm: s.cardPaymentForm,
    defaultUse: s.defaultUse,
    selfInvoiceEnabled: s.selfInvoiceEnabled,
    // A self-invoicing change that waits is kept, as the panel's form keeps it (LD-55).
    selfInvoicePolicy: s.selfInvoicePending?.policy ?? s.selfInvoicePolicy,
    selfInvoiceDays: s.selfInvoicePending?.days ?? s.selfInvoiceDays,
    portalReissueGlobal: s.selfInvoicePending?.reissue ?? s.portalReissueGlobal,
    supportEmail: s.supportEmail,
    ...patch,
  });
  expect(r.status).toBe(200);
}

/** Leaves CFDI paused so other specs never see its buttons or printed block. */
async function pauseCfdi(page: Page) {
  const v = await settings(page);
  if (v.settings?.enabled) await saveSettings(page, { enabled: false });
}

async function paidOrder(page: Page, name: string) {
  const drawer = (await call(page, "/cash")).body;
  if (!drawer || drawer.closed_at)
    await call(page, "/cash/open", { operationId: uuid(), opening: 50000 });
  const catalog = (await call<any[]>(page, "/catalog")).body;
  const product = catalog.find((p) => p.name.es === "Taco de hongos");
  const order = (
    await call(page, "/orders", {
      operationId: uuid(),
      lines: [
        {
          id: uuid(),
          productId: product.id,
          quantity: 2,
          options: [],
          note: "",
        },
      ],
      mode: "takeaway",
      tableId: null,
      name,
      note: "",
      channel: "pos",
    })
  ).body;
  await call(page, `/orders/${order.id}/payments`, {
    operationId: uuid(),
    amount: order.total,
    tip: 0,
    received: order.total,
    method: "cash",
  });
  const paid = (await call(page, `/orders/${order.id}`)).body;
  expect(paid.fiscal?.ticket?.selfInvoiceCode).toMatch(/^[0-9A-Z]{12}$/);
  return paid;
}

async function fillReceptor(
  scope: ReturnType<Page["getByRole"]> | Page,
  r: { rfc: string; legalName: string; regime: string; postalCode: string },
  email?: string,
) {
  await scope.getByLabel("RFC", { exact: true }).fill(r.rfc);
  await scope.getByLabel("Nombre o razón social").fill(r.legalName);
  await scope.getByLabel("Régimen fiscal").selectOption(r.regime);
  await scope
    .getByLabel("Código postal del domicilio fiscal")
    .fill(r.postalCode);
  if (email !== undefined)
    await scope.getByLabel(/^Correo electrónico/).fill(email);
}

test("FIT-6: owner activates CFDI in test mode, a wrong CSD password is refused inline and the right one is accepted; Modo prueba shows and the panel is axe-clean", async ({
  page,
}) => {
  await login(page);
  test.skip(
    !(await stampingReady(page)),
    "needs the cfdi worker with the Facturapi fake",
  );
  const previous = await ensureFiscalIdentity(page);
  try {
    // Activation is once per restaurant and this test pauses it when it ends: on a rerun against
    // the same database, turn the activated restaurant back on so the panel shows its mode.
    const before = await settings(page);
    if (before.settings && !before.settings.enabled)
      await saveSettings(page, { enabled: true });
    await openSettings(page);
    const cfdi = panel(page);
    const activate = cfdi.getByRole("button", {
      name: "Activar en modo prueba",
    });
    // The panel loads its settings first: decide only once it shows either state.
    await expect(
      activate.or(cfdi.getByText("Modo prueba", { exact: true })).first(),
    ).toBeVisible();
    if (await activate.isVisible()) await activate.click();
    await expect(cfdi.getByText("Lista", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(cfdi.getByText("Modo prueba", { exact: true })).toBeVisible();
    const upload = cfdi.getByRole("button", { name: "Subir certificado" });
    if (await upload.isVisible()) {
      await cfdi.getByLabel("Archivo .cer").setInputFiles({
        name: "csd.cer",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(TEST_CSD.cer, "base64"),
      });
      await cfdi.getByLabel("Archivo .key").setInputFiles({
        name: "csd.key",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(TEST_CSD.key, "base64"),
      });
      await cfdi
        .getByLabel("Contraseña de la clave privada")
        .fill("wrong-1234");
      await upload.click();
      await expect(cfdi.getByRole("alert")).toContainText("contraseña");
      await expect(
        cfdi.getByLabel("Contraseña de la clave privada"),
      ).toHaveValue("");
      await cfdi
        .getByLabel("Contraseña de la clave privada")
        .fill(TEST_CSD_PASSWORD);
      await upload.click();
      await expect(cfdi.getByText(/Vigente hasta el/)).toBeVisible({
        timeout: 30_000,
      });
    }
    // LD-51 F9: the issuer RFC is the one Facturapi reports for the organization (its CSD's).
    await expect(cfdi.getByText(RECEPTOR.rfc, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(
      (
        await new AxeBuilder({ page })
          .include(".cfdi-settings")
          .withTags(AXE_TAGS)
          .analyze()
      ).violations,
    ).toEqual([]);
  } finally {
    await pauseCfdi(page);
    if (previous?.issuer)
      await call(page, "/fiscal/profile", {
        operationId: uuid(),
        expectedVersion: (await call(page, "/fiscal/profile")).body.version,
        identity: {
          rfc: previous.issuer.rfc,
          legalName: previous.issuer.legalName,
          regime: previous.issuer.regime,
          postalCode: previous.issuer.postalCode,
        },
        ticketSeries: previous.ticketSeries,
        taxRegion: previous.taxRegion,
        defaultTaxCategory: previous.defaultTaxCategory,
        borderConfirmed: false,
      });
  }
});

test("MON-1/FIT-6: a paid ticket is invoiced from Órdenes (régimen and uso filtered), its PDF and XML download, and a cancel with motive 02 returns the chip to Sin facturar", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  test.skip(
    !(await stampingReady(page)),
    "needs the cfdi worker with the Facturapi fake",
  );
  await ensureFiscalIdentity(page);
  await ensureCfdiOn(page);
  try {
    const order = await paidOrder(page, "CFDI staff " + Date.now());
    await page.getByRole("button", { name: "Operación", exact: true }).click();
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    // Detalle de orden opens from the card's Detalle button, not from the card itself.
    await page
      .locator(".order-summary")
      .filter({ hasText: order.name })
      .getByRole("button", { name: "Detalle", exact: true })
      .click();
    await expect(page.getByText("Sin facturar", { exact: true })).toBeVisible();
    // The order's CFDI actions with the chip, whose label is visually hidden text (CFDI-R2-7).
    expect(
      (
        await new AxeBuilder({ page })
          .include(".cfdi-order-actions")
          .withTags(AXE_TAGS)
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole("button", { name: "Facturar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /^Facturar ticket/ });
    await expect(dialog.getByText(/Modo prueba/)).toBeVisible();
    // A 13-character RFC offers persona-física regimes only.
    await dialog.getByLabel("RFC", { exact: true }).fill("XEXX010101AB1");
    await expect(
      dialog.getByLabel("Régimen fiscal").locator('option[value="601"]'),
    ).toHaveCount(0);
    await fillReceptor(dialog, RECEPTOR, "facturas@example.com");
    await dialog.getByRole("button", { name: "Generar factura" }).click();
    await expect(
      dialog.getByText(/Factura .+ generada · Folio fiscal/),
    ).toBeVisible({
      timeout: 30_000,
    });
    const pdf = page.waitForEvent("download");
    await dialog.getByRole("link", { name: "Descargar PDF" }).click();
    expect((await pdf).suggestedFilename()).toMatch(/\.pdf$/);
    const xml = page.waitForEvent("download");
    await dialog.getByRole("link", { name: "Descargar XML" }).click();
    expect((await xml).suggestedFilename()).toMatch(/\.xml$/);
    await dialog.getByRole("button", { name: "Cerrar" }).click();
    await expect(page.getByText(/^Facturado /)).toBeVisible();

    // Cancel it from the register with motive 02.
    await page.getByRole("button", { name: "Cerrar" }).first().click();
    await openSettings(page);
    await panel(page).getByText("Facturas emitidas", { exact: true }).click();
    await panel(page)
      .getByRole("row")
      .filter({ hasText: RECEPTOR.legalName })
      .first()
      .getByRole("button")
      .click();
    const detail = page.getByRole("dialog", { name: /^Factura / });
    await detail.getByRole("button", { name: "Cancelar…" }).click();
    const cancel = page.getByRole("dialog", { name: /^Cancelar factura/ });
    // "Motivo" alone also matches the "Explica el motivo" textarea.
    await cancel.getByRole("combobox", { name: /^Motivo/ }).selectOption("02");
    await cancel
      .getByLabel("Explica el motivo")
      .fill("Datos del cliente con error");
    await cancel.getByRole("button", { name: "Cancelar factura" }).click();
    await expect(detail.getByText(/Cancelación:/)).toBeVisible();
    await expect
      .poll(
        async () =>
          (await call(page, `/cfdi/tickets/${order.fiscal.ticket.id}`)).body
            .covering?.status ?? "none",
        { timeout: 30_000 },
      )
      .not.toBe("valid");
  } finally {
    await pauseCfdi(page);
  }
});

test("customer self-invoices from /f/{code}: inline receptor errors, then success with the masked email and both downloads; axe passes", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await login(page);
  test.skip(
    !(await stampingReady(page)),
    "needs the cfdi worker with the Facturapi fake",
  );
  await ensureFiscalIdentity(page);
  await ensureCfdiOn(page);
  // axe needs a page from a context the test owns (browser.newPage() pages are refused).
  const customerContext = await browser.newContext();
  const customer = await customerContext.newPage();
  try {
    const order = await paidOrder(page, "CFDI portal " + Date.now());
    await customer.goto(`/f/${order.fiscal.ticket.selfInvoiceCode}`);
    await expect(customer.getByText(/Puedes facturar hasta el/)).toBeVisible();
    await customer.getByRole("button", { name: "Generar factura" }).click();
    await fillReceptor(
      customer,
      { ...RECEPTOR, rfc: "ABC" },
      "cliente@example.com",
    );
    await customer.getByLabel("He leído el aviso de privacidad").check();
    await customer.getByRole("button", { name: "Generar factura" }).click();
    await expect(customer.getByRole("alert").first()).toContainText("RFC");
    await fillReceptor(customer, RECEPTOR, "cliente@example.com");
    await customer.getByRole("button", { name: "Generar factura" }).click();
    await expect(
      customer.getByText(/Te enviamos la factura a c\*+@example\.com/),
    ).toBeVisible({
      timeout: 30_000,
    });
    // The links wait for cfdi_deliver to store the files (CFDI-UX-4): "Preparando los
    // archivos…" until the worker's next sweep (5 s) runs it and the portal's next poll (2 s)
    // sees filesReady.
    await expect(
      customer.getByRole("link", { name: "Descargar PDF" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      customer.getByRole("link", { name: "Descargar XML" }),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page: customer }).withTags(AXE_TAGS).analyze())
        .violations,
    ).toEqual([]);
  } finally {
    await customerContext.close();
    await pauseCfdi(page);
  }
});

test("LD-51 F1/F2/F10, CFDIFIX-1/5/7: the owner switches the global to daily in the panel; a ticket sold this month already printed the monthly deadline, so the change waits for next month, the panel says from when and why, and the portal keeps the printed deadline", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await login(page);
  test.skip(
    !(await stampingReady(page)),
    "needs the cfdi worker with the Facturapi fake",
  );
  await ensureFiscalIdentity(page);
  await ensureCfdiOn(page);
  const customerContext = await browser.newContext();
  const customer = await customerContext.newPage();
  /** Monthly in force on the server's business date, with no change pending. */
  const monthly = (v: Awaited<ReturnType<typeof settings>>) =>
    (v.settings.nextPeriodicity &&
    v.settings.nextPeriodicityFrom <= v.businessDate
      ? v.settings.nextPeriodicity
      : v.settings.globalPeriodicity) === "month";
  try {
    let before = await settings(page);
    if (
      before.settings.globalPeriodicity !== "month" ||
      before.settings.nextPeriodicity
    )
      await saveSettings(page, { globalPeriodicity: "month" });
    before = await settings(page);
    // An earlier run's daily month whose way back waits for next month: nothing to switch.
    test.skip(
      !monthly(before) || !!before.settings.nextPeriodicity,
      "daily globals in force this month (an earlier run), monthly from next month",
    );
    // The month, and its last day, are the server's business date's (CFDIFIX-7), never the
    // browser's clock: around a month boundary they differ.
    const today: string = before.businessDate;
    const [y, m] = today.split("-").map(Number);
    const lastDay =
      new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) === today;
    // A ticket of today, its receipt printed under the monthly global.
    const order = await paidOrder(page, "CFDI periodicity " + Date.now());
    const code = order.fiscal.ticket.selfInvoiceCode;
    await customer.goto(`/f/${code}`);
    const deadline = customer.getByText(/^Puedes facturar hasta el /);
    await expect(deadline).toBeVisible();
    const printed = await deadline.textContent();

    await openSettings(page);
    const cfdi = panel(page);
    await expect(cfdi.getByText("Periodicidad actual: mensual.")).toBeVisible();
    await cfdi
      .getByLabel("Periodicidad de la factura global")
      .selectOption("day");
    // The bound in force (monthly) and the one chosen (daily), CFDIFIX-6.
    await expect(
      cfdi.getByText(/al cierre del mes del consumo más \d+ min/),
    ).toBeVisible();
    await expect(
      cfdi.getByText(
        /Con periodicidad diaria: al cierre del día del consumo más \d+ min\./,
      ),
    ).toBeVisible();
    await cfdi
      .getByRole("button", { name: "Guardar configuración", exact: true })
      .click();
    await expect(
      cfdi.getByText("Configuración de facturación guardada"),
    ).toBeVisible();
    const after = (await settings(page)).settings;
    const status = cfdi.getByRole("status").filter({
      hasText: "Configuración de facturación guardada",
    });
    const select = cfdi.getByLabel("Periodicidad de la factura global");
    if (after.globalPeriodicity === "month") {
      // LD-55 CFDIFIX-UX-2: the save's own status says the change waits, until when and why,
      // and the select (which shows the chosen daily) is described by the line in force.
      await expect(status).toContainText(
        /La periodicidad cambia a diaria desde el .+: .+\./,
      );
      await expect(select).toHaveAccessibleDescription(
        /^Periodicidad actual: mensual\. Cambia a diaria desde el /,
      );
      // Deferred: today's ticket (CFDIFIX-1), or a global of the month, decides it.
      expect(after.nextPeriodicity).toBe("day");
      const reason = after.periodicityDeferred?.reason;
      if (!lastDay) expect(["deadline", "globals"]).toContain(reason);
      await expect(
        cfdi.getByText(
          /^Periodicidad actual: mensual\. Cambia a diaria desde el .+\. No se aplicó al momento: .+\.$/,
        ),
      ).toBeVisible();
      // The reason, in the periodicity line and in the save's status (UX-2).
      const why =
        reason === "globals"
          ? "el mes ya tiene una factura global"
          : reason === "overdue"
            ? "un ticket del mes quedaría en un periodo cuya factura global ya está atrasada"
            : "acortaría el plazo para autofacturar de tickets ya vendidos este mes";
      await expect(
        cfdi.getByText(/^Periodicidad actual: mensual\./),
      ).toContainText(why);
      await expect(status).toContainText(why);
      // The portal keeps answering the deadline the receipt printed.
      await customer.reload();
      await expect(customer.getByText(/^Puedes facturar hasta el /)).toHaveText(
        printed!,
      );
    } else {
      // Only on the month's last day: a monthly and a daily global of today close together, so
      // today's ticket keeps its deadline and the change may apply at once.
      expect(lastDay).toBe(true);
      expect(after.globalPeriodicity).toBe("day");
      await expect(
        cfdi.getByText("Periodicidad actual: diaria."),
      ).toBeVisible();
      await expect(status).toContainText(
        "La periodicidad diaria aplica desde hoy.",
      );
      await customer.reload();
      await expect(
        customer.getByText(/^Puedes facturar hasta el /),
      ).toBeVisible();
    }
  } finally {
    await customerContext.close();
    // Back to monthly: a pending change is cancelled; a daily month whose way back has to wait
    // stays daily with monthly pending from next month, which the next run accepts (it skips).
    await saveSettings(page, { globalPeriodicity: "month" });
    await pauseCfdi(page);
  }
});
