import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { kitchenHygiene } from "./kitchen-hygiene.js";

// Fiscal (027) browser checks. Every spec shares the demo tenant and its fiscal profile is
// tenant-wide: this spec only ever saves the general region (IVA 16%), an empty series and the
// fictional SAT test RFC EKU9003173C9 (docs/FISCAL.md), and creates its own "Prueba …"
// products instead of editing seeded ones (menu.spec convention).

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const RFC = "EKU9003173C9";
const LEGAL_NAME = "ALIMENTOS DE PRUEBA";

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
const letters = (n: number) =>
  Array.from(String(n), (d) => "abcdefghij"[Number(d)]).join("");
const tag = () => "fis" + letters(Date.now() % 1e8);
const money = (n: number) => "$" + (n / 100).toFixed(2);
async function openDrawer(page: Page) {
  const current = await call(page, "/cash");
  if (!current || current.closed_at)
    await call(page, "/cash/open", { operationId: uuid(), opening: 50000 });
}
async function product(page: Page, name: string) {
  const catalog = await call<any[]>(page, "/catalog");
  return catalog.find((p) => p.name.es === name);
}
/** The Vender tile of one catalog product, matched by its exact name. */
const productTile = (page: Page, name: string) =>
  page
    .locator("button.product")
    .filter({ has: page.getByText(name, { exact: true }) });
async function apiOrder(page: Page, name: string, productName: string) {
  const p = await product(page, productName);
  return call(page, "/orders", {
    operationId: uuid(),
    lines: [
      { id: uuid(), productId: p.id, quantity: 1, options: [], note: "" },
    ],
    mode: "takeaway",
    tableId: null,
    name,
    note: "",
    channel: "pos",
  });
}
async function apiPay(page: Page, orderId: string, amount: number) {
  return call(page, `/orders/${orderId}/payments`, {
    operationId: uuid(),
    amount,
    tip: 0,
    received: amount,
    method: "cash",
  });
}
/** Replaces window.print so the test reads what #print-root held at print time. */
async function stubPrint(page: Page) {
  await page.evaluate(() => {
    (window as any).__printed = [];
    window.print = () => {
      (window as any).__printed.push(
        document.getElementById("print-root")?.innerText ?? "",
      );
    };
  });
}
const printed = (page: Page) =>
  page.evaluate(() => (window as any).__printed as string[]);
/** Printed text without whitespace: #print-root is not laid out on screen media. */
const squash = (text: string) => text.replace(/\s+/g, "");
async function lastPrint(page: Page, count = 1) {
  await expect.poll(async () => (await printed(page)).length).toBe(count);
  return (await printed(page))[count - 1];
}
/** Saves the fictional issuer data (general region) unless the profile is complete already. */
async function ensureProfile(page: Page) {
  const profile = await call(page, "/fiscal/profile");
  if (
    profile.complete &&
    profile.taxRegion === "general" &&
    !profile.ticketSeries &&
    !profile.multipleBranches &&
    profile.issuer.rfc === RFC &&
    profile.issuer.address.neighborhood === "Roma Norte" &&
    profile.issuer.address.street === "Av. Ficticia 123"
  )
    return profile;
  return call(page, "/fiscal/profile", {
    operationId: uuid(),
    expectedVersion: profile.version,
    identity: {
      rfc: RFC,
      legalName: LEGAL_NAME,
      regime: "601",
      postalCode: "06700",
      address: {
        street: "Av. Ficticia 123",
        neighborhood: "Roma Norte",
        municipality: "Cuauhtémoc",
        state: "Ciudad de México",
      },
    },
    ticketSeries: "",
    taxRegion: "general",
    defaultTaxCategory: "iva16",
    borderConfirmed: false,
  });
}
async function settings(page: Page) {
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Datos fiscales" });
  await expect(panel.getByLabel("RFC", { exact: true })).toBeVisible();
  return panel;
}
async function sell(page: Page) {
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
}

// W3-2: every round a test sends to the kitchen is delivered after it.
kitchenHygiene();

test("owner completes the fiscal profile: invalid RFC and regime mismatch show inline errors, then saves (FIT-6)", async ({
  page,
}) => {
  await login(page);
  const panel = await settings(page);
  const rfc = panel.getByLabel("RFC", { exact: true });
  const regime = panel.getByRole("combobox", { name: "Régimen fiscal" });
  // Before an RFC is typed every issuer régimen is offered.
  await rfc.fill("");
  await regime.selectOption("612");
  await panel.getByLabel("Nombre o razón social").fill(LEGAL_NAME);
  await panel.getByLabel("Código postal del lugar de expedición").fill("06700");
  await panel.getByLabel("Calle y número").fill("Av. Ficticia 123");
  await panel.getByLabel("Colonia").fill("Roma Norte");
  await panel.getByLabel("Municipio o alcaldía").fill("Cuauhtémoc");
  await panel.getByLabel("Estado", { exact: true }).fill("Ciudad de México");
  await panel.getByLabel("Serie de tickets (opcional)").fill("");
  await panel.getByRole("radio", { name: "Resto del país (IVA 16%)" }).check();
  await panel
    .getByRole("combobox", { name: "Impuesto predeterminado de los productos" })
    .selectOption({ label: "IVA 16%" });
  await rfc.fill("abc123");
  await expect(rfc).toHaveValue("ABC123");
  const save = panel.getByRole("button", {
    name: "Guardar datos fiscales",
    exact: true,
  });
  await save.click();
  await expect(
    panel.getByText(
      "El RFC no tiene un formato válido (12 caracteres para empresa, 13 para persona física).",
    ),
  ).toBeVisible();
  await expect(rfc).toHaveAttribute("aria-invalid", "true");
  // A company RFC (12 characters) with a régimen of individuals.
  await rfc.fill(RFC);
  await expect(
    panel.getByText(
      "Ese régimen fiscal no corresponde al tipo de RFC (persona física o moral).",
    ),
  ).toBeVisible();
  await save.click();
  await expect(panel.getByRole("status")).toHaveCount(0);
  await regime.selectOption("601");
  await expect(
    panel.getByText("Ese régimen fiscal no corresponde al tipo de RFC"),
  ).toHaveCount(0);
  await save.click();
  await expect(
    page.getByText("Datos fiscales guardados", { exact: true }),
  ).toBeVisible();
  await expect(panel.locator(".badge")).toHaveText("Completo");
  const saved = await call(page, "/fiscal/profile");
  expect(saved.issuer.rfc).toBe(RFC);
  expect(saved.issuer.regime).toBe("601");
  expect(saved.taxRegion).toBe("general");
  // A manager-only field is never named exactly "Guardar" (settlement-settings.spec).
  await expect(
    page.getByRole("button", { name: "Guardar", exact: true }),
  ).toHaveCount(1);
  const results = await new AxeBuilder({ page })
    .include(".fiscal-settings")
    .withTags(AXE_TAGS)
    .analyze();
  expect(results.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await panel.getByText("Registro de tickets").click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const narrow = await new AxeBuilder({ page })
    .include(".fiscal-settings")
    .withTags(AXE_TAGS)
    .analyze();
  expect(narrow.violations).toEqual([]);
  await panel.screenshot({ path: "docs/evidence/fiscal-settings-390.png" });
});

test("FISCAL-UI-1: an RFC whose check digit does not match shows the warning before saving, stops the first save, and «Guardar de todos modos» keeps it; the warning stays until the RFC changes", async ({
  page,
}) => {
  await login(page);
  await ensureProfile(page);
  const panel = await settings(page);
  const rfc = panel.getByLabel("RFC", { exact: true });
  const save = panel.getByRole("button", {
    name: "Guardar datos fiscales",
    exact: true,
  });
  const warning = panel.getByText(
    "El dígito verificador no coincide. Revisa el RFC; si es correcto, puedes guardarlo.",
  );
  try {
    await rfc.fill("EKU9003173C8");
    // Shown while typing, before any save.
    await expect(warning).toBeVisible();
    await save.click();
    await expect(
      panel.getByText(
        "Revisa el RFC: el dígito verificador no coincide. Si es correcto, toca «Guardar de todos modos».",
      ),
    ).toBeVisible();
    await expect(warning).toBeVisible();
    expect((await call(page, "/fiscal/profile")).issuer.rfc).toBe(RFC);
    await panel
      .getByRole("button", { name: "Guardar de todos modos", exact: true })
      .click();
    await expect(
      page.getByText("Datos fiscales guardados", { exact: true }),
    ).toBeVisible();
    await expect(warning).toBeVisible();
    expect((await call(page, "/fiscal/profile")).issuer.rfc).toBe(
      "EKU9003173C8",
    );
    // The correct RFC saves at the first tap and clears the warning.
    await rfc.fill(RFC);
    await expect(warning).toHaveCount(0);
    await expect(save).toBeVisible();
    await save.click();
    await expect
      .poll(async () => (await call(page, "/fiscal/profile")).issuer.rfc)
      .toBe(RFC);
  } finally {
    await ensureProfile(page);
  }
});

test("FISCAL-UI-2: a save that meets another device's change shows the current data instead of the stale form, and the next save never writes the old values back", async ({
  page,
}) => {
  await login(page);
  await ensureProfile(page);
  const panel = await settings(page);
  const save = panel.getByRole("button", {
    name: "Guardar datos fiscales",
    exact: true,
  });
  try {
    // This screen edits the street…
    await panel.getByLabel("Calle y número").fill("Calle Local 1");
    // …while another device changes the neighborhood.
    const current = await call(page, "/fiscal/profile");
    await call(page, "/fiscal/profile", {
      operationId: uuid(),
      expectedVersion: current.version,
      identity: {
        rfc: current.issuer.rfc,
        legalName: current.issuer.legalName,
        regime: current.issuer.regime,
        postalCode: current.issuer.postalCode,
        address: { ...current.issuer.address, neighborhood: "Colonia Remota" },
      },
      ticketSeries: current.ticketSeries,
      taxRegion: current.taxRegion,
      defaultTaxCategory: current.defaultTaxCategory,
      borderConfirmed: false,
    });
    await save.click();
    await expect(
      panel.getByText(
        "Los datos fiscales cambiaron en otro dispositivo. Ya ves los datos actuales; vuelve a hacer tus cambios y guarda.",
      ),
    ).toBeVisible();
    await expect(panel.getByLabel("Colonia")).toHaveValue("Colonia Remota");
    await expect(panel.getByLabel("Calle y número")).toHaveValue(
      "Av. Ficticia 123",
    );
    // The next save carries the other device's change.
    await panel.getByLabel("Calle y número").fill("Calle Local 2");
    await save.click();
    await expect(
      page.getByText("Datos fiscales guardados", { exact: true }),
    ).toBeVisible();
    const saved = await call(page, "/fiscal/profile");
    expect(saved.issuer.address.neighborhood).toBe("Colonia Remota");
    expect(saved.issuer.address.street).toBe("Calle Local 2");
  } finally {
    await ensureProfile(page);
  }
});

test("MON-1/FIT-6, MON-7/FOH-17: a cash sale with a modifier and a tip prints the restaurant-headed ticket with folio, RFC, régimen, lugar de expedición, the IVA 16% breakdown, the payment, received and change", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await ensureProfile(page);
  await sell(page);
  await productTile(page, "Taco de asada").click();
  const picker = page.getByRole("dialog");
  await picker.getByRole("radio", { name: /Salsa verde/ }).check();
  await picker.getByRole("checkbox", { name: /Queso/ }).check();
  await picker
    .getByRole("button", { name: "Agregar a la orden", exact: true })
    .click();
  await productTile(page, "Agua de jamaica").click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Propina", { exact: true }).fill("20");
  await dialog.getByLabel("Efectivo recibido", { exact: true }).fill("200");
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Folio:");
  const total = 5500 + 1500 + 3500;
  const tax = Math.round((total * 1600) / 11600);
  await expect(receipt).toContainText(`IVA 16%${money(tax)}`);
  await stubPrint(page);
  await page
    .getByRole("button", { name: "Imprimir recibo", exact: true })
    .click();
  const paper = await lastPrint(page);
  for (const expected of [
    LEGAL_NAME,
    `RFC: ${RFC}`,
    "Régimen fiscal: 601 General de Ley Personas Morales",
    "Lugar de expedición: C.P. 06700",
    "Folio:",
    "Fecha de expedición:",
    `Base IVA 16% ${money(total - tax)}`,
    `IVA 16% ${money(tax)}`,
    "Precios con IVA incluido",
    "Propina voluntaria; no forma parte del total de la venta.",
    "Este ticket no es una factura (CFDI).",
    "+ Queso",
    "+ Salsa verde",
    "Efectivo",
    "Propina",
    "Recibido",
    "Cambio",
  ])
    expect(squash(paper)).toContain(squash(expected));
  expect(paper).not.toContain("Green Monkey");
  // The folio printed is the order's ticket.
  const folio = squash(paper).match(/Folio:(\d{6})/)![1];
  const list = await call(page, "/fiscal/tickets?folio=" + folio);
  expect(list.rows).toHaveLength(1);
  expect(list.rows[0].gross).toBe(total);
  expect(list.rows[0].tip).toBe(2000);
});

test("partial payment receipt says the numbered ticket comes later; the settling payment shows the folio", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await ensureProfile(page);
  await sell(page);
  await productTile(page, "Agua de jamaica").click();
  await productTile(page, "Agua de jamaica").click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Importe", { exact: true }).fill("35");
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText(
    "Comprobante de pago parcial. El ticket con folio se emite al liquidar la cuenta.",
  );
  await expect(receipt).not.toContainText("Folio:");
  await page.getByRole("button", { name: "Volver", exact: true }).click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(receipt).toContainText("Folio:");
  await expect(receipt).not.toContainText("Comprobante de pago parcial");
});

test("reprint from order detail shows REIMPRESIÓN and the same folio and date of issue; order detail shows Folio:", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await ensureProfile(page);
  const name = "Reimpresión " + tag();
  const order = await apiOrder(page, name, "Taco de hongos");
  const paid = await apiPay(page, order.id, order.total);
  const ticket = paid.fiscal.ticket;
  expect(ticket.folio).toMatch(/^\d{6,}$/);
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await page.getByLabel("Buscar por número, nombre o mesa").fill(name);
  await page
    .locator(".order-summary")
    .filter({ hasText: name })
    .getByRole("button", { name: "Detalle", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: /^Orden #\d+$/ });
  await expect(detail).toContainText(`Folio: ${ticket.folio}`);
  await stubPrint(page);
  await detail.getByRole("button", { name: "Reimprimir recibo" }).click();
  const paper = await lastPrint(page);
  expect(paper).toContain("REIMPRESIÓN");
  expect(paper).toContain(`Folio: ${ticket.folio}`);
  const issued = new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: paid.restaurantSnapshot.timezone,
  }).formatToParts(new Date(ticket.issuedAt));
  const part = (type: string) => issued.find((p) => p.type === type)!.value;
  expect(squash(paper)).toContain(
    squash(
      `Fecha de expedición: ${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`,
    ),
  );
});

test("FIT-7 (fiscal part): the ticket register lists the folio, finds it by folio search, and downloads the accountant's CSV", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await ensureProfile(page);
  const order = await apiOrder(page, "Registro " + tag(), "Agua de jamaica");
  const paid = await apiPay(page, order.id, order.total);
  const folio = paid.fiscal.ticket.folio;
  const panel = await settings(page);
  await panel.getByText("Registro de tickets").click();
  await panel.getByRole("button", { name: "Mostrar", exact: true }).click();
  const table = panel.locator(".fiscal-table").last();
  // W3-2 (FLK-R7): the day's register lists the oldest 200 first, so on a
  // database that keeps earlier runs' tickets the new folio may be on a later
  // page. The day's listing is shown and summarized here; the folio is listed
  // on the search result below, and the CSV (every page of the same day's
  // listing) contains it, so the time does not grow with the day's tickets.
  await expect(table.locator("tbody tr").first()).toBeVisible();
  await expect(
    panel.getByRole("region", { name: "Resumen de IVA" }),
  ).toContainText("IVA 16%");
  await panel.getByLabel("Buscar folio").fill(folio);
  await panel.getByRole("button", { name: "Mostrar", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(
    table.getByRole("cell", { name: folio, exact: true }),
  ).toBeVisible();
  await expect(table).toContainText(`#${order.number}`);
  await expect(
    panel.getByRole("button", { name: `Reimprimir ticket ${folio}` }),
  ).toBeVisible();
  await panel.getByLabel("Buscar folio").fill("");
  const today = paid.businessDate;
  const download = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "Descargar CSV", exact: true })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`tickets_${today}_${today}.csv`);
  const text = readFileSync((await file.path())!, "utf8");
  expect(text.startsWith("﻿")).toBe(true);
  expect(text.slice(1).split("\r\n")[0]).toBe(
    "folio,serie,numero,fecha_expedicion,dia_negocio,orden,total,base_iva16,iva16,base_iva8,iva8,venta_tasa0,venta_exenta,descuentos,propinas,reembolsos,iva_reembolsado,formas_pago,codigo_facturacion",
  );
  expect(text).toContain(`${folio},,${Number(folio)},`);
  // FISCAL-UI-11: with both tables shown, 390 px is axe-clean (the summary's scroll region is
  // focusable) and the page does not scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("button", { name: "Mostrar", exact: true }).click();
  await expect(
    panel.getByRole("region", { name: "IVA por tipo de impuesto" }),
  ).toBeVisible();
  const narrow = await new AxeBuilder({ page })
    .include(".fiscal-settings")
    .withTags(AXE_TAGS)
    .analyze();
  expect(narrow.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("58 mm print layout: the fiscal blocks do not overflow 48 mm", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await ensureProfile(page);
  await page.evaluate(() =>
    localStorage.setItem(
      "gm-print-settings",
      JSON.stringify({
        paper: "58",
        kitchenOnSend: false,
        kdsAutoPrint: false,
      }),
    ),
  );
  try {
    await page.reload();
    await sell(page);
    await productTile(page, "Bowl de la casa").click();
    await productTile(page, "Café de olla").click();
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Confirmar cobro", exact: true })
      .click();
    await expect(page.locator(".receipt")).toContainText("Folio:");
    await stubPrint(page);
    await page
      .getByRole("button", { name: "Imprimir recibo", exact: true })
      .click();
    await lastPrint(page);
    await expect(page.locator("#print-root .print-doc.paper-58")).toHaveCount(
      1,
    );
    await page.emulateMedia({ media: "print" });
    const layout = await page.evaluate(() => {
      const doc = document.querySelector<HTMLElement>(
        "#print-root .print-doc.paper-58",
      )!;
      const blocks = [
        ...doc.querySelectorAll<HTMLElement>(
          ".fiscal-header p, .fiscal-footer p, .fiscal-row",
        ),
      ];
      return {
        scroll: doc.scrollWidth,
        client: doc.clientWidth,
        blocks: blocks.length,
        inside: blocks.every(
          (b) =>
            b.getBoundingClientRect().right <=
            doc.getBoundingClientRect().right + 0.5,
        ),
      };
    });
    expect(layout.blocks).toBeGreaterThan(6);
    expect(layout.scroll).toBeLessThanOrEqual(layout.client);
    expect(layout.inside).toBe(true);
    await page.screenshot({ path: "docs/evidence/fiscal-ticket-58mm.png" });
  } finally {
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("afterprint"));
      localStorage.removeItem("gm-print-settings");
    });
  }
});

test("product editor: IVA 8% is disabled outside a border region; saving IVA 0% persists and the next sale's receipt shows Venta a tasa 0%", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await ensureProfile(page);
  const name = "Prueba café en grano " + tag();
  await page
    .getByRole("button", { name: "Menú e inventario", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "Productos" })).toBeVisible();
  await page
    .getByRole("button", { name: "Nuevo producto", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nombre en español").fill(name);
  await dialog
    .getByRole("combobox", { name: "Categoría *", exact: true })
    .selectOption({ label: "Bebidas" });
  await dialog.getByLabel("Precio al cliente (con IVA)").fill("180");
  const tax = dialog.getByRole("combobox", { name: "Impuesto", exact: true });
  await expect(tax).toHaveValue("default");
  await expect(
    tax.locator("option", {
      hasText: "Predeterminado del restaurante (IVA 16%)",
    }),
  ).toHaveCount(1);
  await expect(
    tax.locator("option", { hasText: "IVA 8% (región fronteriza)" }),
  ).toHaveJSProperty("disabled", true);
  await expect(dialog).toContainText("Solo disponible en región fronteriza.");
  await tax.selectOption({ label: "IVA 0%" });
  await dialog.getByText("Claves SAT (opcional)").click();
  await dialog.getByLabel("Clave de producto o servicio SAT").fill("123");
  await expect(
    dialog.getByText("La clave SAT no tiene un formato válido."),
  ).toBeVisible();
  await dialog.getByLabel("Clave de producto o servicio SAT").fill("50201708");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const saved = await product(page, name);
  expect(saved.fiscal).toEqual({
    taxCategory: "iva0",
    satProductKey: "50201708",
    satUnitKey: null,
  });
  await sell(page);
  await page.getByRole("textbox", { name: "Buscar producto…" }).fill(name);
  await productTile(page, name).click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirmar cobro", exact: true })
    .click();
  await expect(page.locator(".receipt")).toContainText("Folio:");
  await stubPrint(page);
  await page
    .getByRole("button", { name: "Imprimir recibo", exact: true })
    .click();
  const paper = await lastPrint(page);
  expect(paper).toContain("Venta a tasa 0%");
  expect(paper).toContain(money(18000));
  expect(paper).not.toContain("IVA 16%");
});

test("offline local receipt shows Folio fiscal pendiente with the cached issuer; with the UI in English it prints in Spanish", async ({
  page,
  context,
}) => {
  await login(page);
  await ensureProfile(page);
  // Reload so the fiscal context (and its Dexie copy) is the saved profile's.
  await page.reload();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  const open = page.getByRole("button", { name: "Abrir caja", exact: true });
  await expect(
    open.or(page.getByText("Caja abierta", { exact: true })),
  ).toBeVisible();
  if (await open.isVisible()) {
    await open.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Guardar", exact: true })
      .click();
    await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  }
  const cached = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/cash",
  );
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await cached;
  await page.getByRole("button", { name: "ES", exact: true }).click();
  await productTile(page, "Mushroom taco").click();
  await context.route("**/api/**", (route) =>
    route.abort("internetdisconnected"),
  );
  try {
    await page
      .getByRole("button", { name: "Collect payment", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm payment", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Save cash payment on this device",
        exact: true,
      })
      .click();
    const receipt = page.locator(".receipt");
    await expect(receipt).toContainText(
      "Ticket number pending: assigned on sync.",
    );
    await expect(receipt).toContainText(`RFC: ${RFC}`);
    await stubPrint(page);
    await page
      .getByRole("button", { name: "Print receipt", exact: true })
      .click();
    const paper = await lastPrint(page);
    expect(paper).toContain("Número provisional");
    expect(paper).toContain(
      "Folio fiscal pendiente: se asigna al sincronizar.",
    );
    expect(paper).toContain(`RFC: ${RFC}`);
    expect(paper).toContain("Precios con IVA incluido");
    expect(paper).not.toContain("Provisional number");
    expect(paper).not.toContain("Folio:");
  } finally {
    await context.unroute("**/api/**");
  }
});

test("FISCAL-OFFLINE-1: a synced offline sale is found in Órdenes by the provisional number on the customer's paper; the sync list, the detail and the reprint name it with the folio", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await login(page);
  await ensureProfile(page);
  await page.reload();
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Caja", exact: true }).click();
  const open = page.getByRole("button", { name: "Abrir caja", exact: true });
  await expect(
    open.or(page.getByText("Caja abierta", { exact: true })),
  ).toBeVisible();
  if (await open.isVisible()) {
    await open.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Guardar", exact: true })
      .click();
    await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  }
  const cached = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/cash",
  );
  await page.getByRole("button", { name: "Vender", exact: true }).click();
  await cached;
  await productTile(page, "Taco de hongos").click();
  await context.route("**/api/**", (route) =>
    route.abort("internetdisconnected"),
  );
  let number: string;
  try {
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await page
      .getByRole("button", { name: "Confirmar cobro", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Guardar cobro en este dispositivo",
        exact: true,
      })
      .click();
    const receipt = page.locator(".receipt");
    await expect(receipt).toContainText("Número provisional");
    number = ((await receipt.textContent()) ?? "").match(
      /[A-Z][A-Z0-9]{0,2}-\d{2,4}/,
    )![0];
    await page
      .getByRole("button", { name: "Siguiente venta", exact: true })
      .click();
    await expect(receipt).toHaveCount(0);
  } finally {
    await context.unroute("**/api/**");
  }
  // The queue syncs on its own once the probes reach the server again.
  const pill = (name: RegExp) =>
    page.locator(".top-actions").getByRole("button", { name });
  await expect(pill(/^Conectado/)).toBeVisible({ timeout: 40_000 });
  await pill(/^Conectado/).click();
  await expect(page.locator(".workspace")).toContainText(
    new RegExp(`${number} → #\\d+ · Folio \\d{6,}`),
    { timeout: 45_000 },
  );
  const found = await call(
    page,
    `/service/orders?status=all&q=${encodeURIComponent(number)}`,
  );
  expect(found.items).toHaveLength(1);
  const synced = await call(page, `/orders/${found.items[0].id}`);
  const folio = synced.fiscal.ticket.folio;
  // Staff type the number printed on the customer's local receipt.
  await page.getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await page.getByLabel("Buscar por número, nombre o mesa").fill(number);
  await expect(page.locator(".order-summary")).toHaveCount(1);
  await page
    .locator(".order-summary")
    .getByRole("button", { name: "Detalle", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: /^Orden #\d+$/ });
  await expect(detail).toContainText(`Folio: ${folio}`);
  await expect(detail).toContainText(`Venta sin conexión ${number}`);
  await stubPrint(page);
  await detail.getByRole("button", { name: "Reimprimir recibo" }).click();
  const paper = await lastPrint(page);
  expect(paper).toContain(`Folio: ${folio}`);
  expect(paper).toContain(`Venta sin conexión ${number}`);
});

test("print language: with the UI in English, the printed receipt, pre-bill and grouped receipts are in Spanish while the on-screen receipt is in English", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await ensureProfile(page);
  await page.getByRole("button", { name: "ES", exact: true }).click();
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await page.getByRole("button", { name: "Sell", exact: true }).click();
  await productTile(page, "Hibiscus agua fresca").click();
  await page
    .getByRole("button", { name: "Collect payment", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm payment", exact: true })
    .click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Ticket no.:");
  await expect(receipt).toContainText("Prices include VAT");
  await stubPrint(page);
  await page
    .getByRole("button", { name: "Print receipt", exact: true })
    .click();
  let paper = await lastPrint(page);
  expect(paper).toContain("Folio:");
  expect(paper).toContain("Precios con IVA incluido");
  expect(paper).not.toContain("Prices include VAT");
  await page.getByRole("button", { name: "Next sale", exact: true }).click();

  // The pre-bill (cuenta) of an unpaid order, from order detail.
  const label = "Idioma " + tag();
  const first = await apiOrder(page, label + " uno", "Taco de hongos");
  const second = await apiOrder(page, label + " dos", "Agua de jamaica");
  await page.getByRole("button", { name: "Orders", exact: true }).click();
  await page.getByLabel(/Search by number/).fill(label);
  await page
    .locator(".order-summary")
    .filter({ hasText: label + " uno" })
    .getByRole("button", { name: "Details", exact: true })
    .click();
  const detail = page.getByRole("dialog");
  await detail.getByRole("button", { name: "Print check" }).click();
  paper = await lastPrint(page, 2);
  expect(paper).toContain("IVA incluido en la cuenta");
  expect(paper).toContain("Precios con IVA incluido");
  expect(paper).not.toContain("VAT");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  // "Cobrar juntas" prints both receipts in Spanish too.
  for (const o of [first, second])
    await page
      .getByRole("checkbox", { name: new RegExp(`#${o.number}$`) })
      .check();
  await page
    .getByRole("button", { name: "Settle together (2)", exact: true })
    .click();
  const settle = page.getByRole("dialog");
  await settle
    .getByLabel("Cash received")
    .fill(String((first.total + second.total) / 100));
  await settle.getByRole("button", { name: "Save", exact: true }).click();
  await settle.getByRole("button", { name: /^Print receipts \(2\)$/ }).click();
  paper = await lastPrint(page, 3);
  expect(paper.match(/Folio:/g)?.length).toBe(2);
  expect(paper).toContain("Precios con IVA incluido");
  expect(paper).not.toContain("Ticket no.");
  await settle.getByRole("button", { name: "Done", exact: true }).click();
});
