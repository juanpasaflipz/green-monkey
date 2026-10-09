/**
 * Branch P (payments spec §12.4, lead decision LD-80): Restaurant P's day through the UI against
 * the payments fake (tests/fakes/payments-fake.ts, scripted over HTTP: POST /__fake/…).
 *
 *   P3   the owner connects Mercado Pago and Clip (the notification URL shown once), adds one
 *        device of each as a terminal with its fee, a manual BBVA terminal, three platforms with
 *        their commission and the platform prices;
 *   P4   Ximena's day at the register: an MP sale with a tip and a Clip sale (approved at the
 *        terminal), a manual BBVA sale, an MP charge the card refuses then paid in cash, a Clip
 *        charge whose answer is lost after the reader took it (unknown: Ulises records it with
 *        the provider's reference), and three platform orders at their platform prices;
 *   P5   Ulises closes the drawer with each terminal's batch total;
 *   P6   the owner's corte Z, Excepciones and Finanzas › Pagos show the oracle's figures.
 *
 * tests/restaurant-day-db.ts reconciles the rows (tenders, attempts, exceptions, drawer counts,
 * no credential anywhere: branch P's checks).
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUT, type RunState } from "./env.js";
import { EXPECTED_P } from "./expected-p.js";
import { mxn } from "./oracle.js";
import { oracleP } from "./oracle-p.js";
import {
  ORDERS_P,
  PAYMENTS_P,
  RESTAURANT_P,
  type OrderP,
  type PlatformKey,
  type TerminalKey,
} from "./scenario-p.js";
import { nextSale, productCard } from "./selling.js";
import { switchUser, toCash, toSell } from "./service-a.js";
import { openFinance } from "./close-a.js";
import {
  checkpoint,
  escapeRe,
  fill,
  press,
  record,
  run,
  tap,
  type Device,
  type Devices,
} from "./ui.js";

const r = RESTAURANT_P;
const pay = PAYMENTS_P;
const staffP = (key: string) => r.staff.find((s) => s.key === key)!;
const O = () => oracleP();
const pesos = (centavos: number) => (centavos / 100).toFixed(2);
/** "$1,170.00" → 117000. */
const cents = (money: string) =>
  Math.round(Number(money.replace(/[$,]/g, "")) * 100);

/** The notification URLs' tokens, kept in memory only: no log line may ever hold one. */
const hookTokens: string[] = [];

// ------------------------------------------------------------------ the payments fake

type FakeCharge = {
  provider: string;
  id: string;
  reference: string;
  device: string;
  amount: number;
  status: string;
};

async function fakeCharges(state: RunState): Promise<FakeCharge[]> {
  const res = await fetch(`${state.paymentsFakeUrl}/__fake/charges`);
  expect(res.status, "GET /__fake/charges").toBe(200);
  return (await res.json()) as FakeCharge[];
}

async function fake(
  state: RunState,
  action:
    | "next"
    | "approve"
    | "decline"
    | "expire"
    | "cancelOnTerminal"
    | "atTerminalUncancellable",
  body: Record<string, unknown>,
) {
  const res = await fetch(`${state.paymentsFakeUrl}/__fake/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, `POST /__fake/${action}`).toBe(200);
}

/** The charge the push created on this device (one the fake had not seen before). */
async function newCharge(
  state: RunState,
  device: string,
  before: Set<string>,
): Promise<FakeCharge> {
  let found: FakeCharge | undefined;
  await expect
    .poll(
      async () => {
        found = (await fakeCharges(state)).find(
          (c) => c.device === device && !before.has(c.id),
        );
        return Boolean(found);
      },
      { message: `a new charge on ${device}`, timeout: 30_000 },
    )
    .toBe(true);
  return found!;
}

// ------------------------------------------------------------------ P3: Configuración

async function settings(page: Page) {
  await page
    .getByRole("navigation", { name: "Operación" })
    .getByRole("button", { name: "Configuración" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Configuración", level: 1 }),
  ).toBeVisible();
  const panel = page.locator("section.payment-settings");
  await expect(panel).toContainText("Pagos con tarjeta y plataformas");
  return panel;
}

/** One terminal row of Configuración › Terminales. */
const terminalRow = (panel: Locator, name: string) =>
  panel
    .getByRole("region", { name: "Terminales", exact: true })
    .locator("tr")
    .filter({
      has: panel.page().locator("td", {
        hasText: new RegExp(`^${escapeRe(name)}$`),
      }),
    });

async function addTerminalForm(panel: Locator, name: string, fee: string) {
  await panel.getByLabel("Nombre de la terminal", { exact: true }).fill(name);
  await panel.getByLabel("Comisión (% con IVA)", { exact: true }).fill(fee);
  await panel
    .getByRole("button", { name: "Agregar terminal", exact: true })
    .click();
}

/** P3.2: connect one provider with the fake's credentials; add its device as a terminal. */
async function connect(owner: Device, panel: Locator, key: "mp" | "clip") {
  const page = owner.page;
  const t = pay.terminals[key];
  const mp = key === "mp";
  const title = mp ? "Mercado Pago" : "Clip";
  const connectLabel = mp ? "Conectar Mercado Pago" : "Conectar Clip";
  const section = panel.getByRole("region", { name: title, exact: true });
  await expect(section).toContainText("No conectado");
  await section
    .getByRole("button", { name: connectLabel, exact: true })
    .click();
  const form = section.getByRole("form", { name: connectLabel });
  const [first, second] = mp
    ? [pay.credentials.mercadopago.token, pay.credentials.mercadopago.secret]
    : [pay.credentials.clip.key, pay.credentials.clip.secret];
  await form
    .getByLabel(mp ? "Access Token de producción" : "API key", { exact: true })
    .fill(first);
  await form
    .getByLabel(mp ? "Clave secreta de notificaciones" : "Clave secreta", {
      exact: true,
    })
    .fill(second);
  await form.getByRole("button", { name: "Conectar", exact: true }).click();
  // The notification URL, once (on the deployed origin), with Copiar; the keys never come back.
  const url = panel.getByLabel("URL de notificaciones", { exact: true });
  const shown = new RegExp(
    `^${escapeRe(new URL(owner.page.url()).origin.replace("http:", "https:"))}/api/payments/webhooks/${t.provider}/([A-Za-z0-9_-]{22})$`,
  );
  await expect(url).toHaveValue(
    new RegExp(`/api/payments/webhooks/${t.provider}/[A-Za-z0-9_-]{22}$`),
  );
  const value = await url.inputValue();
  hookTokens.push(value.split("/").at(-1)!);
  record(
    `${title} notification URL on the deployed origin`,
    true,
    shown.test(value),
  );
  await expect(panel).toContainText("Cópiala ahora: se muestra una sola vez.");
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  await panel.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(url).toHaveCount(0);
  // The worker verifies the credentials against the provider (the fake) and activates.
  await expect(section).toContainText(
    mp
      ? `Conectado como ${pay.credentials.mercadopago.account}`
      : "Conectado como Clip · 1 lector",
    { timeout: 30_000 },
  );
  await section
    .getByRole("button", {
      name: mp ? "Buscar terminales" : "Buscar lectores",
      exact: true,
    })
    .click();
  const found = section
    .getByRole("region", { name: new RegExp(`· ${title}$`) })
    .locator("tr")
    .filter({ hasText: t.device! });
  await expect(found).toBeVisible({ timeout: 30_000 });
  await found
    .getByRole("button", { name: "Agregar como terminal", exact: true })
    .click();
  await expect(
    panel.getByLabel("Nombre de la terminal", { exact: true }),
  ).toBeFocused();
  await addTerminalForm(panel, t.name, t.feeText);
  await expect(terminalRow(panel, t.name)).toContainText(
    `${t.feeText === "3.5" ? "3.50" : t.feeText === "3.6" ? "3.60" : t.feeText} %`,
  );
}

async function paymentsSetup(owner: Device) {
  const page = owner.page;
  run.step = "P3.1";
  let panel = await settings(page);
  // No provider before the owner connects one: both say «No conectado».
  // P3.1: the manual bank terminal and its fee.
  const bbva = pay.terminals.bbva;
  await addTerminalForm(panel, bbva.name, bbva.feeText);
  await expect(terminalRow(panel, bbva.name)).toContainText("1.75 %");
  await expect(terminalRow(panel, bbva.name)).toContainText("Manual");
  // P3.2: Mercado Pago, then Clip.
  run.step = "P3.2";
  await connect(owner, panel, "mp");
  await connect(owner, panel, "clip");
  // P3.3: the three platforms (off until the owner turns them on, LD-75) and their commission.
  run.step = "P3.3";
  for (const k of Object.keys(pay.platforms) as PlatformKey[]) {
    const p = pay.platforms[k];
    await expect(panel.getByLabel(p.label, { exact: true })).not.toBeChecked();
    await panel.getByLabel(p.label, { exact: true }).check();
    await panel
      .getByLabel(`Comisión estimada (%) · ${p.label}`, { exact: true })
      .fill(p.commissionText);
  }
  await panel
    .getByRole("button", { name: "Guardar plataformas", exact: true })
    .click();
  await expect(
    panel.getByRole("status").filter({ hasText: "Guardado" }).first(),
  ).toBeVisible();
  // P3.4: the platform prices.
  run.step = "P3.4";
  for (const [id, prices] of Object.entries(pay.prices)) {
    const product = r.products.find((p) => p.id === id)!;
    for (const [k, price] of Object.entries(prices) as [PlatformKey, number][])
      await panel
        .getByLabel(`${product.name} · ${pay.platforms[k].label}`, {
          exact: true,
        })
        .fill(pesos(price));
  }
  await panel
    .getByRole("button", { name: "Guardar precios", exact: true })
    .click();
  await expect(
    panel.getByRole("status").filter({ hasText: "Guardado" }).first(),
  ).toBeVisible();
  // Read back after a reload: what the owner saved, not what she typed.
  await page.reload();
  panel = await settings(page);
  for (const k of ["mp", "clip", "bbva"] as TerminalKey[])
    await expect(terminalRow(panel, pay.terminals[k].name)).toHaveCount(1);
  for (const [id, prices] of Object.entries(pay.prices)) {
    const product = r.products.find((p) => p.id === id)!;
    for (const [k, price] of Object.entries(prices) as [PlatformKey, number][])
      await expect(
        panel.getByLabel(`${product.name} · ${pay.platforms[k].label}`, {
          exact: true,
        }),
      ).toHaveValue(pesos(price));
  }
  await checkpoint(owner, "P3-payment-settings", { settle: panel });
}

// ------------------------------------------------------------------ P4: the register

const dialogOf = (page: Page) => page.getByRole("dialog", { name: /^Cobrar/ });
const receiptOf = (page: Page) => page.locator(".receipt");

function totalOf(o: OrderP) {
  return O().tickets.find((t) => t.number === o.number)!.total;
}

/**
 * «Detalles» on the register's compact cart: the order's details dialog holds the price list
 * (Precios: Mostrador or a platform, before the first line; LD-72).
 */
async function priceList(caja: Device, choose?: string) {
  const page = caja.page;
  await tap(
    caja,
    page.locator("aside.cart").getByRole("button", { name: /^Detalles/ }),
  );
  const details = page.getByRole("dialog", { name: "Detalles de la orden" });
  const list = details.getByRole("combobox", { name: "Precios", exact: true });
  await expect(list.locator("option")).toHaveText([
    "Mostrador",
    ...(Object.keys(pay.platforms) as PlatformKey[]).map(
      (k) => pay.platforms[k].label,
    ),
  ]);
  if (choose) await list.selectOption({ label: choose });
  else await expect(list.locator("option:checked")).toHaveText("Mostrador");
  await press(
    caja,
    details.getByRole("button", { name: "Cerrar", exact: true }),
  );
  await expect(details).toHaveCount(0);
}

/** The cart of one order: its price list, its lines, its total (P-R1). */
async function ring(caja: Device, o: OrderP) {
  const page = caja.page;
  await toSell(caja);
  const platform =
    o.payment.kind === "platform" ? pay.platforms[o.payment.platform] : null;
  // Every order starts on the counter's list; a platform order picks its own.
  await priceList(caja, platform?.label);
  for (const line of o.lines) {
    const product = r.products.find((p) => p.id === line.product)!;
    for (let i = 0; i < line.qty; i++)
      await tap(caja, productCard(page, product.name));
  }
  if (platform)
    await expect(page.locator(".cart-badges")).toContainText(
      `Pedido con precios de ${platform.label}`,
    );
  await expect(
    page.locator("aside.cart:visible .total strong").first(),
  ).toHaveText(totalOf(o));
}

async function openPayment(caja: Device, o: OrderP) {
  const page = caja.page;
  await tap(caja, page.getByRole("button", { name: "Cobrar", exact: true }));
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  if (o.payment.kind !== "platform")
    await expect(dialog.getByLabel("Importe", { exact: true })).toHaveValue(
      pesos(cents(totalOf(o))),
    );
  return dialog;
}

/** «Tarjeta» → the integrated terminal → «Enviar a …»; returns the fake's new charge. */
async function sendToTerminal(
  caja: Device,
  state: RunState,
  dialog: Locator,
  key: "mp" | "clip",
  tip = 0,
) {
  const t = pay.terminals[key];
  await tap(
    caja,
    dialog
      .getByRole("group", { name: "Método de pago" })
      .getByRole("button", { name: "Tarjeta", exact: true }),
  );
  await tap(
    caja,
    dialog.getByRole("button", { name: new RegExp(`^${escapeRe(t.name)}`) }),
  );
  // An integrated terminal takes no approval reference: the provider reports it.
  await expect(
    dialog.getByLabel("Referencia de aprobación", { exact: true }),
  ).toHaveCount(0);
  if (tip)
    await fill(caja, dialog.getByLabel("Propina", { exact: true }), pesos(tip));
  const before = new Set((await fakeCharges(state)).map((c) => c.id));
  await tap(
    caja,
    dialog.getByRole("button", { name: `Enviar a ${t.name}`, exact: true }),
  );
  return before;
}

async function integratedSale(caja: Device, state: RunState, o: OrderP) {
  const p = o.payment;
  if (p.kind !== "integrated") throw Error(o.id);
  const page = caja.page;
  const t = pay.terminals[p.terminal];
  await ring(caja, o);
  const dialog = await openPayment(caja, o);
  const before = await sendToTerminal(caja, state, dialog, p.terminal, p.tip);
  const charge = await newCharge(state, t.device!, before);
  // The terminal is asked for the bill plus the tip, in one charge.
  expect(charge.amount, `${o.id}: the amount sent to ${t.name}`).toBe(
    cents(totalOf(o)) + (p.tip ?? 0),
  );
  const wait = dialog.locator("section.terminal-wait");
  await expect(wait.getByRole("status")).toHaveText(
    `Esperando el pago en ${t.name}…`,
  );
  await expect(wait.locator(".large-money")).toHaveText(mxn(charge.amount));
  if (o.id === "P1")
    await checkpoint(caja, "P4-terminal-wait", { settle: wait });
  await fake(state, "approve", {
    ref: charge.id,
    approval: {
      brand: p.card.brand,
      type: p.card.type,
      last4: p.card.last4,
      ...(p.providerFee === undefined ? {} : { fee: p.providerFee }),
    },
  });
  const receipt = receiptOf(page);
  await expect(receipt).toContainText(
    `Tarjeta · ${t.name} · VISA •••• ${p.card.last4}`,
    { timeout: 30_000 },
  );
  await receiptChecks(caja, o, [...(p.tip ? [`Propina ${mxn(p.tip)}`] : [])]);
}

async function receiptChecks(caja: Device, o: OrderP, extra: string[]) {
  const receipt = receiptOf(caja.page);
  const ticket = O().tickets.find((t) => t.number === o.number)!;
  await expect(receipt).toContainText(`Folio: ${ticket.folio}`);
  const text = (await receipt.innerText()).replace(/\s+/g, " ");
  for (const s of [
    r.name,
    `RFC: ${r.fiscal.rfc}`,
    `#${o.number}`,
    `Total ${ticket.total}`,
    `Base IVA 16% ${ticket.base}`,
    `IVA 16% ${ticket.tax}`,
    ...extra,
  ])
    expect(text, `${o.id} receipt: "${s}"`).toContain(s);
  record(
    `${o.id} receipt total`,
    ticket.total,
    text.match(/Total (\$[\d,]+\.\d{2})/)?.[1],
  );
  await nextSale(caja);
}

async function manualSale(caja: Device, o: OrderP) {
  const p = o.payment;
  if (p.kind !== "manual") throw Error(o.id);
  const t = pay.terminals[p.terminal];
  await ring(caja, o);
  const dialog = await openPayment(caja, o);
  await tap(
    caja,
    dialog
      .getByRole("group", { name: "Método de pago" })
      .getByRole("button", { name: "Tarjeta", exact: true }),
  );
  await tap(caja, dialog.getByRole("button", { name: t.name, exact: true }));
  await fill(
    caja,
    dialog.getByLabel("Referencia de aprobación", { exact: true }),
    p.reference,
  );
  await tap(
    caja,
    dialog.getByRole("checkbox", {
      name: "Confirmo que la terminal aprobó este pago",
    }),
  );
  await tap(
    caja,
    dialog.getByRole("button", { name: "Confirmar cobro", exact: true }),
  );
  await expect(receiptOf(caja.page)).toContainText(`Tarjeta · ${t.name}`);
  await receiptChecks(caja, o, [`Ref. ${p.reference}`]);
}

/** An MP charge the card refuses, then «Otra forma de pago» → cash with a $200 bill. */
async function declinedThenCash(caja: Device, state: RunState, o: OrderP) {
  const p = o.payment;
  if (p.kind !== "declinedThenCash") throw Error(o.id);
  const t = pay.terminals[p.terminal];
  await ring(caja, o);
  const dialog = await openPayment(caja, o);
  const before = await sendToTerminal(caja, state, dialog, p.terminal);
  const charge = await newCharge(state, t.device!, before);
  await fake(state, "decline", { ref: charge.id });
  const wait = dialog.locator("section.terminal-wait");
  await expect(wait.getByRole("status")).toContainText(
    "La terminal rechazó el cobro",
    { timeout: 30_000 },
  );
  // A refused card is never a fallback to the manual terminal: retry or another method.
  await expect(
    wait.getByRole("button", { name: "Cobrar sin integración", exact: true }),
  ).toHaveCount(0);
  await tap(
    caja,
    wait.getByRole("button", { name: "Otra forma de pago", exact: true }),
  );
  await expect(
    dialog
      .getByRole("group", { name: "Método de pago" })
      .getByRole("button", { name: "Efectivo", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const total = cents(totalOf(o));
  await tap(
    caja,
    dialog
      .getByRole("group", { name: "Efectivo recibido rápido" })
      .getByRole("button", { name: new RegExp(`^\\$${p.bill}(\\.00)?$`) }),
  );
  await expect(
    dialog.locator(".row.between", { hasText: "Cambio" }).locator("strong"),
  ).toHaveText(mxn(p.bill * 100 - total));
  await tap(
    caja,
    dialog.getByRole("button", { name: "Confirmar cobro", exact: true }),
  );
  await receiptChecks(caja, o, [
    `Efectivo ${mxn(total)}`,
    `Recibido ${mxn(p.bill * 100)}`,
    `Cambio ${mxn(p.bill * 100 - total)}`,
  ]);
}

/**
 * Clip loses the create's answer after the reader took the request: the outcome is unknown
 * (never a blind retry). The cashier calls the manager; Ulises, on the same register, records it
 * from «Cobros en terminal en curso» with the reference from Clip's history (step-up: his PIN).
 */
async function unknownResolved(caja: Device, state: RunState, o: OrderP) {
  const p = o.payment;
  if (p.kind !== "unknown") throw Error(o.id);
  const page = caja.page;
  const t = pay.terminals[p.terminal];
  await ring(caja, o);
  const dialog = await openPayment(caja, o);
  await fake(state, "next", { provider: "clip", behaviour: "timeoutTaken" });
  const before = await sendToTerminal(caja, state, dialog, p.terminal);
  await newCharge(state, t.device!, before);
  const wait = dialog.locator("section.terminal-wait");
  await expect(wait.getByRole("status")).toContainText(
    "No sabemos si el cobro se completó.",
    { timeout: 45_000 },
  );
  // A cashier only re-checks; a manager resolves.
  await expect(
    wait.getByRole("button", { name: "Reintentar", exact: true }),
  ).toHaveCount(0);
  await expect(
    wait.getByRole("button", { name: "Resolver cobro", exact: true }),
  ).toHaveCount(0);
  await expect(
    wait.getByRole("button", { name: "Volver a consultar", exact: true }),
  ).toBeVisible();
  // The dialog closes only with a confirmation: the charge goes on at the terminal.
  page.once("dialog", (d) => void d.accept());
  await press(
    caja,
    dialog.getByRole("button", { name: "Cerrar", exact: true }),
  );
  await expect(dialog).toHaveCount(0);
  const banner = page.locator("section.active-charges");
  await expect(banner).toContainText("Cobros en terminal en curso (1)", {
    timeout: 20_000,
  });

  run.step = "P4.5b";
  const ulises = staffP("ulises");
  await switchUser(caja, ulises);
  await toSell(caja);
  await expect(banner).toContainText("Cobros en terminal en curso (1)", {
    timeout: 20_000,
  });
  await press(caja, banner.getByRole("button", { name: "Ver", exact: true }));
  await expect(banner).toContainText(
    `#${o.number} · ${t.name} · ${totalOf(o)} · Sin confirmar`,
  );
  await press(
    caja,
    banner.getByRole("button", {
      name: `Resolver cobro #${o.number}`,
      exact: true,
    }),
  );
  const resolveDialog = page.getByRole("dialog", {
    name: "Resolver cobro en terminal",
  });
  await expect(resolveDialog).toBeVisible();
  await resolveDialog
    .getByRole("radio", { name: "Sí se cobró: registrar en la orden" })
    .check();
  await fill(
    caja,
    resolveDialog.getByLabel("Referencia del proveedor"),
    p.reference,
  );
  // Clip reported no amount: the manager types the one its history shows.
  await fill(
    caja,
    resolveDialog.getByLabel("Importe cobrado (según el proveedor)"),
    pesos(cents(totalOf(o))),
  );
  await fill(
    caja,
    resolveDialog.getByLabel("Motivo (mínimo 10 caracteres)"),
    p.note,
  );
  await resolveDialog.getByLabel("Revisé el historial del proveedor").check();
  await checkpoint(caja, "P4-resolve", { settle: resolveDialog });
  await press(
    caja,
    resolveDialog.getByRole("button", { name: "Resolver", exact: true }),
  );
  await expect(resolveDialog).toHaveCount(0, { timeout: 20_000 });
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
  // The reader completes the payment the manager recorded (the fake's reader is free again).
  await fake(state, "approve", { device: t.device, approval: {} });
  run.step = "P4.5c";
  await switchUser(caja, staffP("ximena"));
  // The paid order may still be the cart's: «Nueva orden» starts the next sale.
  await toSell(caja);
  await press(
    caja,
    page.getByRole("button", { name: "Nueva orden", exact: true }),
  );
  await expect(
    page.getByText("La siguiente buena orden empieza aquí.", { exact: true }),
  ).toBeVisible();
}

async function platformSale(caja: Device, o: OrderP) {
  const p = o.payment;
  if (p.kind !== "platform") throw Error(o.id);
  const label = pay.platforms[p.platform].label;
  await ring(caja, o);
  const dialog = await openPayment(caja, o);
  await expect(
    dialog
      .getByRole("group", { name: "Método de pago" })
      .getByRole("button", { name: "Plataforma", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog
      .getByRole("group", { name: "Plataforma" })
      .getByRole("button", { name: label, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(dialog).toContainText(
    `La plataforma cubre todo el saldo: ${totalOf(o)}. Sin propina.`,
  );
  await expect(dialog.getByLabel("Propina", { exact: true })).toHaveCount(0);
  await fill(
    caja,
    dialog.getByLabel("Número de pedido de la plataforma", { exact: true }),
    p.orderNumber,
  );
  await tap(caja, dialog.getByLabel("La plataforma ya cobró este pedido"));
  await tap(
    caja,
    dialog.getByRole("button", { name: "Confirmar cobro", exact: true }),
  );
  await expect(receiptOf(caja.page)).toContainText(`Pagado en ${label}`);
  await receiptChecks(caja, o, [`Pagado en ${label}`, p.orderNumber]);
}

// ------------------------------------------------------------------ P5: the close

async function closeDrawer(caja: Device) {
  const page = caja.page;
  const z = O().corteZ;
  run.step = "P5.1";
  await switchUser(caja, staffP("ulises"));
  await toCash(caja);
  await press(
    caja,
    page.getByRole("button", { name: "Cerrar caja", exact: true }),
  );
  const close = page.getByRole("dialog", { name: "Cerrar caja" });
  // The restaurant's default close is blind: the expected cash shows only after the count.
  await expect(close).toContainText(
    "El efectivo esperado no se muestra hasta guardar el conteo.",
  );
  await expect(close).not.toContainText(z.cash.expected);
  await fill(
    caja,
    close.getByLabel("Efectivo contado", { exact: true }),
    pesos(r.countedCash),
  );
  // The batch total of each terminal that took money in this drawer (all or none).
  for (const k of ["mp", "clip", "bbva"] as TerminalKey[]) {
    const t = pay.terminals[k];
    const row = Object.entries(z.terminal.byTerminal).find(([label]) =>
      label.startsWith(`${t.name} (`),
    )!;
    await fill(
      caja,
      close.getByLabel(`Total del lote · ${t.name}`, { exact: true }),
      pesos(cents(row[1].batch)),
    );
  }
  await checkpoint(caja, "P5-close", { settle: close });
  await press(
    caja,
    close.getByRole("button", { name: "Continuar", exact: true }),
  );
  await press(
    caja,
    close.getByRole("button", { name: "Guardar conteo y cerrar", exact: true }),
  );
  const result = page.getByRole("dialog", { name: "Corte registrado" });
  await expect(result).toBeVisible();
  const shown = (await result.innerText()).replace(/\s+/g, " ");
  record("P close result", z.cash, shown);
  // A manager sees the figures once the count is saved: exact cash, terminals as reported.
  if (shown.includes("Efectivo esperado"))
    for (const s of [z.cash.expected, z.cash.counted, z.terminal.net])
      expect(shown, `close result: ${s}`).toContain(s);
  await press(caja, result.getByRole("button", { name: "Listo", exact: true }));
  await expect(
    page.getByText("Caja cerrada", { exact: true }).first(),
  ).toBeVisible();
}

// ------------------------------------------------------------------ P6: the owner's screens

/** The rows of one corte section as "label amount" pairs, in screen order. */
async function sectionRows(doc: Locator, title: RegExp) {
  const section = doc.locator("section.doc-section").filter({
    has: doc.page().locator("h3.doc-section-title", { hasText: title }),
  });
  await expect(section).toHaveCount(1);
  const rows = section.locator(".doc-row");
  const out: Array<[string, string]> = [];
  for (const row of await rows.all())
    out.push([
      (await row.locator(".doc-label").innerText()).trim(),
      (await row.locator(".doc-amount").innerText()).trim(),
    ]);
  return out;
}

/** Groups "Name (n)" rows with the "· …" rows under them. */
function grouped(rows: Array<[string, string]>, header: RegExp) {
  const out: Record<string, Record<string, string>> = {};
  let current: string | null = null;
  for (const [label, amount] of rows) {
    if (header.test(label) && !label.startsWith("·")) {
      current = label;
      out[current] = { net: amount };
    } else if (label.startsWith("· ") && current)
      out[current]![label.slice(2)] = amount;
  }
  return out;
}

async function corteZ(owner: Device) {
  const page = owner.page;
  const z = O().corteZ;
  run.step = "P6.1";
  await openFinance(owner, "Cortes");
  // The one drawer of the day, closed by Ulises (the header row also says «Caja»).
  const drawerRow = page
    .locator("main")
    .getByRole("row")
    .filter({ hasText: "Cerrada" })
    .filter({ hasText: staffP("ulises").name });
  await expect(drawerRow).toHaveCount(1);
  await drawerRow.getByRole("button", { name: /corte Z/i }).click();
  const preview = page.getByRole("dialog", { name: "Vista previa" });
  const doc = preview.locator(".corte-doc");
  await expect(doc).toContainText("CORTE Z · CIERRE DE CAJA");
  const cash = await sectionRows(doc, /^EFECTIVO$/);
  const terminal = await sectionRows(doc, /^TERMINAL EXTERNA$/);
  const platforms = await sectionRows(doc, /^Pagado por plataformas/);
  const payments = await sectionRows(doc, /^COBROS$/);
  record("P corte Z cash", z.cash, cash);
  record("P corte Z terminal", z.terminal, terminal);
  record("P corte Z platforms", z.platforms, platforms);
  expect(cash).toEqual([
    ["Fondo inicial", z.cash.opening],
    ["Ventas en efectivo", z.cash.sales],
    ["Propinas en efectivo", "$0.00"],
    ["Reembolsos en efectivo", "$0.00"],
    ["Retiros", "$0.00"],
    ["Efectivo esperado", z.cash.expected],
    ["Efectivo contado", z.cash.counted],
    ["Diferencia (cuadra)", z.cash.difference],
  ]);
  const terminalNames = /^(MP Mostrador|Clip Mostrador|BBVA) \(\d+\)$/;
  expect(
    terminal.filter(([l]) => !terminalNames.test(l) && !l.startsWith("· ")),
  ).toEqual([
    [`Cobros con terminal (${z.terminal.count})`, z.terminal.sales],
    ["Propinas con terminal", z.terminal.tips],
    ["Reembolsos en terminal", "$0.00"],
    ["Neto en terminal", z.terminal.net],
    ["Total reportado por la terminal", z.terminal.reported],
    ["Diferencia en terminal (cuadra)", "$0.00"],
  ]);
  expect(grouped(terminal, terminalNames)).toEqual(
    Object.fromEntries(
      Object.entries(z.terminal.byTerminal).map(([label, v]) => [
        label,
        {
          net: v.net,
          "Total del lote": v.batch,
          "Comisiones estimadas": v.fees,
        },
      ]),
    ),
  );
  expect(grouped(platforms, /\(\d+\)$/)).toEqual(
    Object.fromEntries(
      Object.entries(z.platforms).map(([label, v]) => [
        label,
        { net: v.net, "Comisión estimada": v.commission },
      ]),
    ),
  );
  expect(payments).toEqual([["Cobros registrados", String(z.payments)]]);
  await expect(doc).toContainText(`Folios ${z.folios} (${z.tickets} tickets)`);
  await checkpoint(owner, "P6-corte-z", { settle: preview });
  await preview.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(preview).toHaveCount(0);
}

async function exceptions(owner: Device) {
  const page = owner.page;
  const e = O().exception;
  run.step = "P6.2";
  await openFinance(owner, "Excepciones");
  const rows = page.getByRole("row").filter({
    hasText: "Cobro en terminal resuelto por gerente",
  });
  await expect(rows).toHaveCount(1);
  for (const s of [
    `#${e.number}`,
    e.amount,
    staffP("ximena").name,
    staffP("ulises").name,
    `${e.terminal} · registrado`,
  ])
    await expect(rows).toContainText(s);
  // Nothing else of the terminal charges is an exception: no review, nothing left unconfirmed.
  for (const other of [
    "Cobro en terminal por revisar",
    "Cobro en terminal sin confirmar",
  ])
    await expect(page.getByRole("row").filter({ hasText: other })).toHaveCount(
      0,
    );
}

/** The body rows of one Finanzas › Pagos table, each as its cells' texts. */
async function tableRows(page: Page, heading: string) {
  const section = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: heading, exact: true }),
  });
  await expect(section).toHaveCount(1);
  const out: string[][] = [];
  for (const row of await section.locator("tbody tr").all())
    out.push(
      (await row.locator("td,th").allInnerTexts()).map((s) =>
        s.replace(/\s+/g, " ").trim(),
      ),
    );
  return out.sort((a, b) => a[0]!.localeCompare(b[0]!, "es"));
}

async function finance(owner: Device) {
  const page = owner.page;
  const f = O().finance;
  run.step = "P6.3";
  await openFinance(owner, "Pagos");
  const sorted = (rows: string[][]) =>
    [...rows].sort((a, b) => a[0]!.localeCompare(b[0]!, "es"));
  const byTerminal = await tableRows(page, "Por terminal");
  const byPlatform = await tableRows(page, "Por plataforma");
  record("P Finanzas por terminal", f.byTerminal, byTerminal);
  record("P Finanzas por plataforma", f.byPlatform, byPlatform);
  expect(byTerminal).toEqual(sorted(f.byTerminal));
  expect(byPlatform).toEqual(sorted(f.byPlatform));
  await checkpoint(owner, "P6-finance-payments", {
    settle: page.getByRole("heading", { name: "Por terminal", exact: true }),
  });
}

/** No notification token in any process log (payments spec §9.4; DB check DP5 covers tables). */
function tokensNowhere() {
  expect(hookTokens).toHaveLength(2);
  for (const file of ["server.log", "worker.log", "payments-fake.log"]) {
    const text = readFileSync(resolve(OUT, file), "utf8");
    for (const token of hookTokens)
      expect(text.includes(token), `${file} holds a notification token`).toBe(
        false,
      );
  }
}

export async function serviceP(dev: Devices, state: RunState) {
  const owner = await dev("ownerP");
  const caja = await dev("cajaP");
  expect(
    state.paymentsFakeUrl,
    "branch P runs with the payments fake",
  ).toBeTruthy();
  // The unknown outcome alerts the operator by design (payments spec §8).
  run.expectedAlerts.push(/^payments_attempt_unknown_/);
  await paymentsSetup(owner);
  // The register reads the new options (terminals, platforms, prices) on a reload.
  run.step = "P4.0";
  await caja.page.reload();
  await toSell(caja);
  for (const o of ORDERS_P) {
    run.step = `P4 ${o.id}`;
    switch (o.payment.kind) {
      case "integrated":
        await integratedSale(caja, state, o);
        break;
      case "manual":
        await manualSale(caja, o);
        break;
      case "declinedThenCash":
        await declinedThenCash(caja, state, o);
        break;
      case "unknown":
        await unknownResolved(caja, state, o);
        break;
      case "platform":
        await platformSale(caja, o);
        break;
    }
  }
  await closeDrawer(caja);
  await corteZ(owner);
  await exceptions(owner);
  await finance(owner);
  run.step = "P6.4";
  tokensNowhere();
  // The hand-typed table is the one the screens were held to (§5.1 double entry).
  expect(O()).toEqual(EXPECTED_P);
}
