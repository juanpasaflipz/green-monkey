/**
 * cfdi (030) browser checks (spec §7.5). Role and label selectors on the demo fixture.
 *
 * Two groups:
 *  - always: the Configuración panel before activation and the public self-invoicing portal
 *    (no fiscal ticket needed);
 *  - stamping flows: they need fiscal 027 tickets and the worker with the Facturapi fake
 *    (`npm run dev:facturapi-fake` and the worker with FACTURAPI_BASE_URL, as CI starts them).
 *    Each test skips itself when GET /api/fiscal/context is missing or /api/capabilities reports
 *    facturapi disabled, and leaves CFDI paused (settings `enabled: false`) in a finally so the
 *    other specs never see Facturar buttons or the printed block.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TEST_CSD, TEST_CSD_PASSWORD } from "../fixtures/cfdi/test-csd";

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

/** Fiscal tickets exist and the worker published a Facturapi provider. */
/**
 * Merge gate (review CFDI-R5): the stamping flows skip only while fiscal 027 is absent from this
 * tree. Once server/fiscal-read.ts exists, a missing GET /api/fiscal/context fails the test, and
 * in CI (which starts the worker with the Facturapi fake) so does a disabled provider; only a
 * local run without the worker may still skip.
 */
const FISCAL_MERGED = existsSync(join(process.cwd(), "server/fiscal-read.ts"));
async function stampingReady(page: Page) {
  const fiscal = await call(page, "/fiscal/context");
  const caps = await call(page, "/capabilities");
  if (FISCAL_MERGED) {
    expect(fiscal.status, "fiscal 027 is merged").toBe(200);
    if (process.env.CI)
      expect(
        caps.body?.facturapi?.enabled,
        "CI runs the worker with the Facturapi fake",
      ).toBe(true);
  }
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
    selfInvoicePolicy: s.selfInvoicePolicy,
    selfInvoiceDays: s.selfInvoiceDays,
    portalReissueGlobal: s.portalReissueGlobal,
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
  test.skip(!(await stampingReady(page)), "needs fiscal 027 and the worker");
  const previous = await ensureFiscalIdentity(page);
  try {
    await openSettings(page);
    const cfdi = panel(page);
    const activate = cfdi.getByRole("button", {
      name: "Activar en modo prueba",
    });
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
  test.skip(!(await stampingReady(page)), "needs fiscal 027 and the worker");
  await ensureFiscalIdentity(page);
  await ensureCfdiOn(page);
  try {
    const order = await paidOrder(page, "CFDI staff " + Date.now());
    await page.getByRole("button", { name: "Operación", exact: true }).click();
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    await page
      .locator(".order-summary")
      .filter({ hasText: order.name })
      .click();
    await expect(page.getByText("Sin facturar", { exact: true })).toBeVisible();
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
    await cancel.getByLabel("Motivo").selectOption("02");
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
  test.skip(!(await stampingReady(page)), "needs fiscal 027 and the worker");
  await ensureFiscalIdentity(page);
  await ensureCfdiOn(page);
  const customer = await browser.newPage();
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
    await expect(
      customer.getByRole("link", { name: "Descargar PDF" }),
    ).toBeVisible();
    await expect(
      customer.getByRole("link", { name: "Descargar XML" }),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page: customer }).withTags(AXE_TAGS).analyze())
        .violations,
    ).toEqual([]);
  } finally {
    await customer.close();
    await pauseCfdi(page);
  }
});
