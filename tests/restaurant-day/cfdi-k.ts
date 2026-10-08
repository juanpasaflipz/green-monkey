/**
 * Branch K of Restaurant B (specs/acceptance.md §7.5 B1.6, §7.8 B6.9 and B7.5,
 * cfdi §2.3-§2.12): the worker files against the Facturapi sandbox shared by
 * the platform (provider `sandbox_shared`, test mode). The owner activates
 * CFDI before any sale, the cashier invoices J-000003 for a customer, and the
 * day's factura global stays open with the other six tickets.
 *
 * Runs only in the day-cfdi job (FACTURAPI_TEST_KEY) or in the local triage
 * against the Facturapi fake (RD_CFDI_FAKE_PORT), never in branch N.
 */
import { expect, type Download, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mxn } from "./oracle.js";
import { FIGURES } from "./selling.js";
import { orderCard, toOrders } from "./service-a.js";
import {
  checkpoint,
  fill,
  press,
  readApi,
  record,
  run,
  type Device,
} from "./ui.js";
import { EXPECTED } from "./expected.js";
import type { RunState } from "./env.js";

/** cfdi D22 (docs/CFDI.md): the SAT test receptor, the same values as tests/browser/cfdi.spec.ts. */
export const RECEPTOR = {
  rfc: "EKU9003173C9",
  legalName: "ESCUELA KEMPER URGATE",
  regime: "601",
  postalCode: "42501",
  use: "G03",
};
const SHARED_SANDBOX =
  "Entorno de prueba compartido: las facturas usan la organización de prueba de la plataforma y no tienen validez fiscal.";
const CODE =
  /Código: ([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})/;
const GENERATED =
  /^Factura (\S+-\d+) generada · Folio fiscal ([0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12})$/i;

/** Configuración → "Facturación electrónica (CFDI)" on the owner's laptop. */
export async function cfdiPanel(owner: Device) {
  const page = owner.page;
  await page
    .getByRole("navigation", { name: "Operación" })
    .getByRole("button", { name: "Configuración" })
    .click();
  const panel = page.locator(".cfdi-settings");
  await expect(
    panel.getByRole("heading", { name: "Facturación electrónica (CFDI)" }),
  ).toBeVisible();
  return panel;
}

/** B1.6: activation in test mode before any sale, then the settings (owner, no step-up). */
export async function activateCfdi(owner: Device, state: RunState) {
  run.step = "B1.6";
  const panel = await cfdiPanel(owner);
  const header = panel.locator(".row.between").first();
  await expect(header).toContainText("Desactivada");
  await expect(
    panel.getByRole("note").filter({ hasText: SHARED_SANDBOX }),
  ).toBeVisible();
  const checklist = panel.locator("ul.cfdi-checklist");
  for (const item of [
    "Facturación disponible en la plataforma",
    "Datos fiscales completos",
    "Moneda MXN",
    "Razón social de hasta 100 caracteres",
  ])
    await expect(
      checklist.locator("li.cfdi-check.ok", { hasText: item }),
    ).toHaveCount(1);
  await expect(checklist.locator("li.cfdi-check.missing")).toHaveCount(0);
  // Built (cfdi LD-51 F2): the periodicity is chosen in the activation step (default Mensual), so
  // the spec's "Diaria" is chosen there and the first period is daily. The step says how the
  // periodicity bounds self-invoicing while the portal does not reissue globals (LD-51 F1).
  const activation = panel.locator(".cfdi-activation");
  const grace = await graceMinutes(owner);
  state.cfdiGraceMinutes = grace;
  const chosen = activation.getByLabel("Periodicidad de la factura global");
  await expect(chosen).toHaveValue("month");
  await chosen.selectOption({ label: "Diaria" });
  await expect(
    activation.getByText(`al cierre del día del consumo más ${grace} min`),
  ).toBeVisible();
  const activate = panel.getByRole("button", {
    name: "Activar en modo prueba",
    exact: true,
  });
  await expect(activate).toBeEnabled();
  await activate.click();
  // The organization is set up by the worker; the panel polls every 3 s for up to 2 min.
  const ready = panel.locator("dl.cfdi-facts dd", { hasText: /^Lista$/ });
  await expect(
    panel
      .getByText("Configurando la organización emisora…", { exact: true })
      .or(ready),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(ready).toBeVisible({ timeout: 120_000 });
  await expect(header).toContainText("Modo prueba");
  const form = panel.locator("form.cfdi-settings-form");
  const periodicity = form.getByLabel("Periodicidad de la factura global");
  await expect(periodicity).toHaveValue("day");
  // The server's decision, read twice: its settings (what applies on its business date and any
  // change that waits) and the "Periodicidad actual" line the select is described by. The only
  // outcome that passes is Diaria in force today with nothing waiting; any other fails here.
  await expectDailyNow(owner, periodicity, state);
  await expect(
    form.getByRole("checkbox", {
      name: "Emitir la factura global automáticamente",
    }),
  ).toBeChecked();
  await form.getByRole("radio", { name: "Tarjeta de crédito (04)" }).check();
  await form
    .getByRole("button", { name: "Guardar configuración", exact: true })
    .click();
  // The periodicity did not change, so the save's status carries no periodicity note (UX-2).
  await expect(form.getByRole("status")).toHaveText(
    "Configuración de facturación guardada",
  );
  await expect(periodicity).toHaveValue("day");
  await expectDailyNow(owner, periodicity, state);
}

type SettingsBody = {
  businessDate: string;
  globalGraceMinutes: number;
  settings: null | {
    globalPeriodicity: string;
    nextPeriodicity: string | null;
    nextPeriodicityFrom: string | null;
  };
};

/** The worker's global grace as the server publishes it (GET /api/cfdi/settings, LD-51 F1). */
async function graceMinutes(owner: Device) {
  const { status, body } = await readApi<SettingsBody>(
    owner,
    "/api/cfdi/settings",
  );
  expect(status).toBe(200);
  expect(
    Number.isInteger(body.globalGraceMinutes) && body.globalGraceMinutes > 0,
    "globalGraceMinutes",
  ).toBe(true);
  return body.globalGraceMinutes;
}

/**
 * The server's periodicity decision for the business date (GET /api/cfdi/settings): the
 * periodicity in force (a pending change counts from its first day) and a change that waits.
 */
async function periodicityDecision(owner: Device) {
  const { status, body } = await readApi<SettingsBody>(
    owner,
    "/api/cfdi/settings",
  );
  expect(status).toBe(200);
  const s = body.settings;
  expect(s, "CFDI settings after activation").not.toBeNull();
  const from = s!.nextPeriodicity ? s!.nextPeriodicityFrom : null;
  return {
    businessDate: body.businessDate,
    current:
      from && from <= body.businessDate
        ? s!.nextPeriodicity
        : s!.globalPeriodicity,
    waiting:
      from && from > body.businessDate
        ? { periodicity: s!.nextPeriodicity, from }
        : null,
  };
}

/** B1.6 K: Diaria applies on the business date, by the server's settings and by its status line. */
async function expectDailyNow(
  owner: Device,
  periodicity: Locator,
  state: RunState,
) {
  const decision = await periodicityDecision(owner);
  record(
    "B1.6 periodicity decision (server)",
    "day in force, nothing waiting",
    decision,
  );
  expect(decision).toEqual({
    businessDate: state.businessDateB,
    current: "day",
    waiting: null,
  });
  await expect(periodicity).toHaveAccessibleDescription(
    "Periodicidad actual: diaria.",
  );
}

/**
 * The printed self-invoicing deadline (B6.9 K (a)). The spec's "{fin de mes}" is the "month"
 * policy; built (cfdi LD-51 F1, LD-55 CFDIFIX-FISCAL-1), while «Sustituir la factura global» is off
 * (the default) the ticket can be self-invoiced only until its global is built, and the receipt
 * prints that when it comes first: a daily period closes at the next business day's start (the
 * cutoff) and the worker builds it the grace later, printed with its time. On the month's last
 * business date the month end comes first, with its time (it falls on the purchase day).
 * Wall-clock arithmetic in the restaurant's zone: no DST transition falls between the cutoff
 * (04:00 or 16:00) and the build.
 */
function receiptDeadline(state: RunState) {
  const [y, m, d] = state.businessDateB.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const [h, min] = state.cutoffB.split(":").map(Number) as [number, number];
  const grace = state.cfdiGraceMinutes as number;
  const built = new Date(Date.UTC(y, m - 1, d + 1, h, min + grace));
  const monthEnd = new Date(Date.UTC(y, m, 0, 23, 59));
  const at = built < monthEnd ? built : monthEnd;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(at.getUTCDate())}/${two(at.getUTCMonth() + 1)}/${at.getUTCFullYear()} a las ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
}

/** B6.9 K (a): the receipt's self-invoicing block replaces fiscal's "Pídela con el folio" line. */
export async function selfInvoiceReceipt(caja: Device, state: RunState) {
  const receipt = caja.page.locator(".receipt");
  const block = receipt.locator(".cfdi-receipt-block");
  await expect(block).toBeVisible();
  await expect(block.locator("strong")).toHaveText(
    "¿Necesitas factura? (modo prueba)",
  );
  await expect(block).toContainText(
    `Escanea o entra a ${new URL(state.baseUrl).host}/factura`,
  );
  await expect(block).toContainText(CODE);
  const deadline = receiptDeadline(state);
  await expect(block.getByText(/^Disponible hasta el /)).toHaveText(
    `Disponible hasta el ${deadline}`,
  );
  record(
    "B6.9 K receipt deadline",
    "fin de mes (spec); the daily global's build (built)",
    deadline,
  );
  await expect(receipt).not.toContainText(
    `Pídela con el folio ${FIGURES.B3!.folio}`,
  );
  await expect(
    block.getByRole("img", { name: "Código QR para facturar este ticket" }),
  ).toBeVisible();
}

/** Attribute values of every `<tag …/>` element in an XML string (no XML dependency here). */
function elements(xml: string, tag: string) {
  return [...xml.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, "g"))].map((m) =>
    Object.fromEntries(
      [...m[1]!.matchAll(/([\w:]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
    ),
  );
}

/** B6.9 K (b)-(f): Órdenes → #3 → Detalle → Facturar, the negative RFC, stamping, the XML. */
export async function invoiceB3(caja: Device, state: RunState) {
  const page = caja.page;
  const f = FIGURES.B3!;
  const openDetail = async () => {
    await toOrders(caja);
    await press(
      caja,
      orderCard(page, 3).getByRole("button", { name: "Detalle", exact: true }),
    );
    const detail = page.getByRole("dialog", { name: "Orden #3" });
    await expect(detail.locator(".cfdi-order-actions")).toBeVisible();
    return detail;
  };
  let detail = await openDetail();
  await expect(detail.locator(".cfdi-order-actions")).toContainText(
    "Sin facturar",
  );
  await press(
    caja,
    detail.getByRole("button", { name: "Facturar", exact: true }),
  );
  const dialog = page.getByRole("dialog", {
    name: new RegExp(
      `^Facturar ticket ${f.folio} · ${escape(mxn(f.total))} · `,
    ),
  });
  await expect(
    dialog.getByText("Modo prueba: la factura no tiene validez fiscal.", {
      exact: true,
    }),
  ).toBeVisible();
  await fill(
    caja,
    dialog.getByLabel("Nombre o razón social"),
    RECEPTOR.legalName,
  );
  // (c) Negative first: the generic RFC is refused inline, before any request.
  await fill(caja, dialog.getByLabel("RFC", { exact: true }), "XAXX010101000");
  await dialog
    .getByLabel("Régimen fiscal")
    .selectOption(RECEPTOR.regime)
    .catch(() => {});
  await fill(
    caja,
    dialog.getByLabel("Código postal del domicilio fiscal"),
    RECEPTOR.postalCode,
  );
  await press(
    caja,
    dialog.getByRole("button", { name: "Generar factura", exact: true }),
  );
  await expect(
    dialog
      .getByRole("alert")
      .filter({
        hasText:
          "Para público en general no se emite factura individual: el ticket se incluye en la factura global.",
      }),
  ).toBeVisible();
  await fill(caja, dialog.getByLabel("RFC", { exact: true }), RECEPTOR.rfc);
  await dialog.getByLabel("Régimen fiscal").selectOption(RECEPTOR.regime);
  await dialog.getByLabel("Uso del CFDI").selectOption(RECEPTOR.use);
  // The field appears because J-000003 was paid on the terminal.
  const card = dialog.getByRole("group", { name: "Pago con tarjeta" });
  await card.getByRole("radio", { name: "Crédito" }).check();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await checkpoint(caja, "B6-cfdi", { settle: dialog });
  // (d) Stamping: the dialog polls the document every 2 s for up to 90 s.
  await press(
    caja,
    dialog.getByRole("button", { name: "Generar factura", exact: true }),
  );
  const result = dialog.locator(".cfdi-result strong");
  await expect(
    dialog.getByText("Timbrando con el SAT…", { exact: true }).or(result),
  ).toBeVisible({ timeout: 30_000 });
  await expect(result).toHaveText(GENERATED, { timeout: 90_000 });
  const [, label, uuid] = (await result.innerText()).match(GENERATED)!;
  record("B6.9 factura", "F-{n}", label);
  record("B6.9 folio fiscal", "UUID", uuid);
  state.cfdiInvoice = { label, uuid };
  await expect(dialog.getByRole("link", { name: "Descargar PDF" })).toBeVisible(
    { timeout: 90_000 },
  );
  // (e) The stamped XML: the ticket's total without the tip, one 8% transfer, card form 04.
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "Descargar XML" }).click();
  const xml: string = readFileSync(
    await (await (downloading as Promise<Download>)).path(),
    "utf8",
  );
  const [comprobante] = elements(xml, "cfdi:Comprobante");
  expect(comprobante).toMatchObject({ Total: "385.00", FormaPago: "04" });
  const totals = xml.slice(xml.lastIndexOf("</cfdi:Conceptos>"));
  expect(elements(totals, "cfdi:Traslado")).toEqual([
    expect.objectContaining({
      TasaOCuota: "0.080000",
      Base: "356.48",
      Importe: "28.52",
    }),
  ]);
  await press(
    caja,
    dialog.getByRole("button", { name: "Cerrar", exact: true }),
  );
  await expect(detail.locator(".cfdi-order-actions")).toContainText(
    `Facturado ${label}`,
    { timeout: 15_000 },
  );
  await press(
    caja,
    detail.getByRole("button", { name: "Cerrar", exact: true }),
  );
  // (f) A second request finds the invoice.
  detail = await openDetail();
  await press(
    caja,
    detail.getByRole("button", { name: "Facturar", exact: true }),
  );
  const again = page.getByRole("dialog", { name: /^Facturar ticket / });
  await expect(
    again.getByText(`Este ticket ya tiene la factura ${label}.`, {
      exact: true,
    }),
  ).toBeVisible();
  await press(caja, again.getByRole("button", { name: "Cerrar", exact: true }));
  await press(
    caja,
    detail.getByRole("button", { name: "Cerrar", exact: true }),
  );
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "7 oct 2026": cfdi's dateLabel for a business date. */
function dateLabel(businessDate: string) {
  const [y, m, d] = businessDate.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * B7.5 K: the period D{business date} is open (a global is built after its period
 * closes) and offers no "Emitir ahora"; the ticket chips on Detalle. The register
 * counts what the open period's global will take (cfdi LD-51 F11, "N por emitir"):
 * the six tickets J-000003 is not in and the §7.11 row K totals (gross and IVA),
 * which D19 also reconciles from the fiscal tables.
 */
export async function globalReadiness(
  owner: Device,
  caja: Device,
  state: RunState,
) {
  const panel = await cfdiPanel(owner);
  await panel.locator("summary", { hasText: /^Facturas globales$/ }).click();
  const globals = panel.getByRole("region", { name: "Facturas globales" });
  const row = globals
    .getByRole("row")
    .filter({
      has: owner.page
        .getByRole("cell")
        .filter({ hasText: dateLabel(state.businessDateB) }),
    });
  await expect(row).toHaveCount(1);
  const cells = row.getByRole("cell");
  await expect(cells.nth(0)).toContainText("Prueba");
  // The daily period closes at the next business day's start (the cutoff), printed with a
  // 24-hour time (cfdi dateTimeLabel, ACC-PR-5b; G3 refuses "a.m./p.m." at B7-global).
  const [y, m, d] = state.businessDateB.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  await expect(cells.nth(1)).toHaveText(
    `Abierto hasta ${dateLabel(next)}, ${state.cutoffB}`,
  );
  const k = EXPECTED.B.globalK;
  const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);
  await expect(cells.nth(2)).toHaveText(String(k.tickets));
  await expect(cells.nth(3)).toHaveText(
    mxn(cents(k.iva8.sales) + cents(k.tasa0)),
  );
  await expect(cells.nth(4)).toHaveText(k.iva8.tax);
  await expect(cells.nth(5)).toContainText(`${k.tickets} por emitir`);
  await expect(
    globals.getByRole("button", { name: "Emitir ahora" }),
  ).toHaveCount(0);
  await checkpoint(owner, "B7-global", { settle: globals });
  // The chips: J-000003 invoiced individually, the other six waiting for the global.
  const page = caja.page;
  await toOrders(caja);
  // B7.1 left Órdenes on "Abiertas"; the day's closed checks are under "Hoy y abiertas".
  await press(
    caja,
    page.getByRole("button", { name: "Hoy y abiertas", exact: true }),
  );
  for (let n = 1; n <= 7; n++) {
    await toOrders(caja);
    await press(
      caja,
      orderCard(page, n).getByRole("button", { name: "Detalle", exact: true }),
    );
    const detail = page.getByRole("dialog", { name: `Orden #${n}` });
    const chip = detail.locator(".cfdi-order-actions");
    await expect(chip).toContainText(
      n === 3
        ? `Facturado ${(state.cfdiInvoice as { label: string }).label}`
        : "Sin facturar",
    );
    await press(
      caja,
      detail.getByRole("button", { name: "Cerrar", exact: true }),
    );
  }
}

export type { Locator };
