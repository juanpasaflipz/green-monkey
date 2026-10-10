/**
 * Restaurant-day branch S (kiosk self-checkout, 039; critic R13, R20, R47; LD-80, LD-89): the
 * kiosk day of Restaurant S through the UI, after branch P in the restaurant-day-payments job and
 * against the same payments fake. The owner connects the readers, turns the club on and sets up
 * two kiosks («Entrada» on MP, «Terraza» on Clip) whose card charges land in the register's
 * drawer; the cashier enrols a club member at the counter; guests order and pay on the tablets
 * (para aquí and para llevar, a suggested side, a member identified at the kiosk with counts and
 * a masked phone only); each paid order reaches the kitchen with no staff tap; one charge lands in
 * review and the cashier's retry settles it; another is accepted by the manager with the kiosk
 * payment, collecting the difference in cash. Then the manager closes the drawer and the owner's
 * screens are held to the hand-typed table (expected-s.ts): the corte Z with each terminal's
 * «Del kiosco» sub-line, Excepciones (payments' kinds only), Finanzas › Pagos and › Kiosco. The DB
 * reconciliation (DS1-DS6) is in tests/restaurant-day-db.ts.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { RunState } from "./env.js";
import { EXPECTED_S, FAKE_CHARGES_S } from "./expected-s.js";
import { mxn } from "./oracle.js";
import { chargedS, oracleS } from "./oracle-s.js";
import {
  CLUB_S,
  KIOSKS_S,
  KIOSK_SETTINGS_S,
  ORDERS_S,
  PAYMENTS_S,
  RESTAURANT_S,
  type KioskKeyS,
  type OrderS,
  type TerminalKeyS,
} from "./scenario-s.js";
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
  typePin,
  type Device,
  type DeviceName,
  type Devices,
} from "./ui.js";

const r = RESTAURANT_S;
const pay = PAYMENTS_S;
const staffS = (key: string) => r.staff.find((s) => s.key === key)!;
const O = () => oracleS();
const pesos = (centavos: number) => (centavos / 100).toFixed(2);
const productS = (id: string) => r.products.find((p) => p.id === id)!;
const KIOSK_DEVICES: Record<KioskKeyS, DeviceName> = {
  entrada: "kioskEntradaS",
  terraza: "kioskTerrazaS",
};
const KIOSK_SIZES: Array<[number, number]> = [
  [1280, 800],
  [800, 1280],
];

/**
 * A checkpoint on a kiosk tablet at its two orientations. «Toca para ordenar» asks for
 * fullscreen (KIOSK.md §4), which a window cannot be resized out of: leave it first.
 */
async function kioskCheckpoint(k: Device, id: string, settle: Locator) {
  await k.page.evaluate(() =>
    document.fullscreenElement ? document.exitFullscreen() : undefined,
  );
  await checkpoint(k, id, { sizes: KIOSK_SIZES, settle });
}

// ------------------------------------------------------------------ the payments fake

type FakeCharge = {
  provider: string;
  id: string;
  reference: string;
  device: string;
  amount: number;
  tip: number;
  status: string;
};

async function fakeCharges(state: RunState): Promise<FakeCharge[]> {
  const res = await fetch(`${state.paymentsFakeUrl}/__fake/charges`);
  expect(res.status, "GET /__fake/charges").toBe(200);
  return (await res.json()) as FakeCharge[];
}

async function approve(
  state: RunState,
  ref: string,
  card: OrderS["card"],
): Promise<void> {
  const res = await fetch(`${state.paymentsFakeUrl}/__fake/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref,
      approval: { brand: card.brand, type: card.type, last4: card.last4 },
    }),
  });
  expect(res.status, "POST /__fake/approve").toBe(200);
}

/** The charge the worker pushed to this reader for the guest (one the fake had not seen). */
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

// ------------------------------------------------------------------ S3: Configuración

async function settings(page: Page) {
  await page
    .getByRole("navigation", { name: "Operación" })
    .getByRole("button", { name: "Configuración" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Configuración", level: 1 }),
  ).toBeVisible();
}
const paymentsPanel = (page: Page) => page.locator("section.payment-settings");
const terminalRow = (panel: Locator, name: string) =>
  panel
    .getByRole("region", { name: "Terminales", exact: true })
    .locator("tr")
    .filter({
      has: panel.page().locator("td", {
        hasText: new RegExp(`^${escapeRe(name)}$`),
      }),
    });

/** S3.1: one provider connected with the fake's credentials; its device added as a terminal. */
async function connect(owner: Device, key: TerminalKeyS) {
  const page = owner.page;
  const panel = paymentsPanel(page);
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
  await expect(
    panel.getByLabel("URL de notificaciones", { exact: true }),
  ).toHaveValue(
    new RegExp(`/api/payments/webhooks/${t.provider}/[A-Za-z0-9_-]{22}$`),
  );
  await panel.getByRole("button", { name: "Cerrar", exact: true }).click();
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
    .filter({ hasText: t.device });
  await expect(found).toBeVisible({ timeout: 30_000 });
  await found
    .getByRole("button", { name: "Agregar como terminal", exact: true })
    .click();
  await panel.getByLabel("Nombre de la terminal", { exact: true }).fill(t.name);
  await panel
    .getByLabel("Comisión (% con IVA)", { exact: true })
    .fill(t.feeText);
  await panel
    .getByRole("button", { name: "Agregar terminal", exact: true })
    .click();
  await expect(terminalRow(panel, t.name)).toContainText(
    `${t.feeText === "3.5" ? "3.50" : "3.60"} %`,
  );
}

/** S3.2: the restaurant's privacy notice, then the club on (one stamp per paid order). */
async function clubOn(owner: Device) {
  const page = owner.page;
  run.step = "S3.2";
  await settings(page);
  const privacy = page.getByRole("region", { name: "Privacidad y datos" });
  await privacy
    .getByLabel("Enlace al aviso de privacidad de tu restaurante", {
      exact: true,
    })
    .fill(r.privacyNoticeUrl);
  await privacy
    .getByRole("button", { name: "Guardar enlace", exact: true })
    .click();
  await expect(
    privacy.getByRole("status").filter({ hasText: "Enlace guardado" }),
  ).toBeVisible();
  await page.reload();
  await settings(page);
  const club = page.getByRole("region", { name: "Club de lealtad" });
  await club.getByLabel(/^Mi aviso de privacidad incluye el club/).check();
  await club.getByLabel("Activar el club", { exact: true }).check();
  await club.getByLabel(/^Nombre del club/).fill(CLUB_S.programName);
  await club
    .getByLabel(/^Sellos para un premio/)
    .fill(String(CLUB_S.stampsRequired));
  await club
    .getByLabel(/^Un sello extra por cada/)
    .fill(pesos(CLUB_S.threshold));
  await club
    .getByRole("button", { name: "Guardar club de lealtad", exact: true })
    .click();
  await expect(
    club.getByText("Configuración del club guardada.", { exact: true }),
  ).toBeVisible();
}

/** The link a kiosk opens: the reveal dialog's «Enlace», on this run's origin. */
async function addKiosk(owner: Device, label: string): Promise<string> {
  const page = owner.page;
  const section = page.locator("section.public-settings");
  await section.getByLabel("Nombre del kiosco", { exact: true }).fill(label);
  await section
    .getByRole("button", { name: "Agregar kiosco", exact: true })
    .click();
  const reveal = page.getByRole("dialog", { name: "Código listo" });
  await expect(reveal).toBeVisible();
  const url = new URL(
    await reveal.getByLabel("Enlace", { exact: true }).inputValue(),
  );
  expect(url.pathname, "a kiosk link").toBe("/kiosk");
  await reveal.getByRole("button", { name: "Cerrar" }).first().click();
  await expect(reveal).toHaveCount(0);
  return `${url.pathname}${url.hash}`;
}

const stationRow = (page: Page, label: string) =>
  page.locator(".kiosk-station", { hasText: label });

/** S3.3: two kiosks, their reader and receiving till, the kiosk settings and the cart's side. */
async function kiosksSetup(owner: Device, state: RunState) {
  const page = owner.page;
  run.step = "S3.3";
  await settings(page);
  const paths: Record<string, string> = {};
  for (const k of Object.keys(KIOSKS_S) as KioskKeyS[])
    paths[k] = await addKiosk(owner, KIOSKS_S[k].label);
  state.kioskPaths = paths;
  // The kiosk section reads its stations and the club's state when it loads.
  await page.reload();
  await settings(page);
  const kiosk = page.getByRole("region", { name: "Kiosco de autoservicio" });
  await kiosk
    .getByRole("radio", { name: KIOSK_SETTINGS_S.paymentMode, exact: true })
    .check();
  for (const label of [
    "Preguntar para aquí o para llevar",
    "Sugerencias",
    "Club en el kiosco",
  ])
    await kiosk.getByLabel(label, { exact: true }).check();
  await kiosk
    .getByRole("button", { name: "Guardar configuración", exact: true })
    .click();
  await expect(kiosk.getByText("Kiosco guardado").first()).toBeVisible();
  for (const k of Object.keys(KIOSKS_S) as KioskKeyS[]) {
    const row = stationRow(page, KIOSKS_S[k].label);
    await row
      .getByLabel(/^Terminal/)
      .selectOption({ label: pay.terminals[KIOSKS_S[k].terminal].name });
    await row
      .getByLabel(/^Caja que recibe los cobros/)
      .selectOption({ label: "Caja" });
    await row
      .getByRole("button", { name: "Guardar estación", exact: true })
      .click();
    await expect(kiosk.getByText("Kiosco guardado").first()).toBeVisible();
  }
  const sides = kiosk.locator("fieldset", {
    hasText: "Sugerencias del carrito",
  });
  for (const id of KIOSK_SETTINGS_S.cartSuggestions)
    await sides.getByLabel(productS(id).name, { exact: true }).check();
  await sides
    .getByRole("button", { name: "Guardar sugerencias", exact: true })
    .click();
  await expect(kiosk.getByText("Kiosco guardado").first()).toBeVisible();
  // Read back after a reload: what the owner saved.
  await page.reload();
  await settings(page);
  for (const k of Object.keys(KIOSKS_S) as KioskKeyS[])
    await expect(
      stationRow(page, KIOSKS_S[k].label).getByLabel(/^Terminal/),
    ).toHaveValue(/.+/);
  await checkpoint(owner, "S3-kiosk-settings", { settle: kiosk });
}

/** S3.4: «Vincular tableta» on the owner's computer, the code typed on the tablet. */
async function pairTablet(
  owner: Device,
  tablet: Device,
  k: KioskKeyS,
  path: string,
) {
  const page = owner.page;
  const label = KIOSKS_S[k].label;
  await stationRow(page, label)
    .getByRole("button", { name: "Vincular tableta", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Vincular tableta" });
  const code = (await dialog.locator(".kiosk-pair-code").innerText())
    .replace(/\D/g, "")
    .slice(0, 8);
  expect(code).toMatch(/^\d{8}$/);
  await dialog.getByRole("button", { name: "Cerrar" }).first().click();
  const kiosk = tablet.page;
  await kiosk.goto(path);
  await expect(
    kiosk.getByRole("heading", { level: 1, name: r.name }),
  ).toBeVisible();
  // The hidden setup: a 3-second press on the restaurant's name.
  await kiosk.getByRole("heading", { level: 1 }).hover();
  await kiosk.mouse.down();
  await kiosk.waitForTimeout(3200);
  await kiosk.mouse.up();
  const setup = kiosk.getByRole("dialog", { name: "Configurar este kiosco" });
  await expect(setup).toContainText("Kiosco sin vincular: solo pago en caja");
  await setup.getByLabel("Código de vinculación").fill(code);
  await setup.getByRole("button", { name: "Vincular", exact: true }).click();
  await expect(setup).toContainText(`Kiosco vinculado: ${label}`);
  await setup.getByRole("button", { name: "Cerrar" }).first().click();
  await expect(
    kiosk.getByRole("button", { name: "Toca para ordenar", exact: true }),
  ).toBeVisible();
  // The owner's screen reads the station again: the tablet is bound.
  await page.reload();
  await settings(page);
  await expect(
    stationRow(page, label).getByText(/^Tableta vinculada · vista hace /),
  ).toBeVisible();
}

// ------------------------------------------------------------------ S4: the register

/** The register: unlock when the idle lock came down while the kiosks sold. */
async function awake(caja: Device, who: { name: string; pin: string }) {
  const lock = caja.page.locator("dialog.lock-screen");
  if (await lock.isVisible()) {
    await typePin(caja, lock, who.name, who.pin);
    await expect(lock).toHaveCount(0);
  }
}

/** Órdenes on the register (the online orders inbox sits on top). */
async function toOrdersS(caja: Device) {
  await press(
    caja,
    caja.page
      .getByRole("navigation", { name: "Operación" })
      .getByRole("button", { name: "Órdenes", exact: true }),
  );
  await expect(
    caja.page.getByRole("heading", { name: "Órdenes", level: 1 }),
  ).toBeVisible();
}

/** S4.1: Inés enrols the member at the counter (the club's own lookup and consent). */
async function enrolMember(caja: Device) {
  const page = caja.page;
  run.step = "S4.1";
  await toSell(caja);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const club = page
    .locator(".loyalty-cart")
    .getByRole("button", { name: "Club", exact: true });
  await expect(club).toBeVisible({ timeout: 20_000 });
  await press(caja, club);
  const dialog = page.getByRole("dialog", { name: "Cliente del club" });
  await expect(dialog).toBeVisible();
  await fill(
    caja,
    dialog.getByLabel("Teléfono (10 dígitos)"),
    CLUB_S.member.phone,
  );
  await press(
    caja,
    dialog.getByRole("button", { name: "Buscar teléfono", exact: true }),
  );
  await expect(
    dialog.getByText("No hay socio con ese teléfono.", { exact: true }),
  ).toBeVisible();
  await fill(caja, dialog.getByLabel("Nombre o apodo"), CLUB_S.member.name);
  await press(
    caja,
    dialog.getByLabel(/^Le informé al cliente el aviso de privacidad/),
  );
  await press(
    caja,
    dialog.getByRole("button", { name: "Registrar", exact: true }),
  );
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".loyalty-chip")).toContainText(
    `${CLUB_S.member.firstName} · 0/${CLUB_S.stampsRequired}`,
  );
}

// ------------------------------------------------------------------ S5: the guests

/** «Soy del club» on the welcome screen: counts and the masked phone, never a name. */
async function memberAtKiosk(k: Device) {
  const page = k.page;
  const club = O().club;
  await tap(k, page.getByRole("button", { name: "Soy del club", exact: true }));
  const dialog = page.getByRole("dialog", { name: "Soy del club" });
  const keypad = dialog.getByRole("group", {
    name: "Tu número de celular (10 dígitos)",
  });
  for (const d of CLUB_S.member.phone)
    await tap(k, keypad.getByRole("button", { name: d, exact: true }));
  await expect(dialog.locator(".kiosk-phone")).toHaveText(club.masked);
  await tap(k, dialog.getByRole("button", { name: "Buscar", exact: true }));
  await expect(dialog.getByRole("status")).toHaveText(
    `¡Hola! Llevas ${club.before}.`,
  );
  const text = await dialog.innerText();
  expect(text, "no member name at the kiosk").not.toContain(
    CLUB_S.member.firstName,
  );
  expect(text, "no full phone at the kiosk").not.toContain(
    CLUB_S.member.phone.slice(-4),
  );
  await kioskCheckpoint(k, "S5-kiosk-member", dialog);
  await tap(k, dialog.getByRole("button", { name: "Cerrar" }).first());
  await expect(dialog).toHaveCount(0);
}

/** The guest's order up to «Sigue las instrucciones en la terminal»; returns the fake's charge. */
async function guestPays(k: Device, state: RunState, o: OrderS) {
  const page = k.page;
  const t = pay.terminals[KIOSKS_S[o.kiosk].terminal];
  if (o.member) await memberAtKiosk(k);
  await tap(
    k,
    page.getByRole("button", { name: "Toca para ordenar", exact: true }),
  );
  const cartAside = page.locator("aside.diner-cart");
  for (const line of o.lines)
    for (let i = 0; i < line.qty; i++)
      await tap(
        k,
        page.locator(".diner-main").getByRole("button", {
          name: new RegExp(`^${escapeRe(productS(line.product).name)}`),
        }),
      );
  if (o.suggestion) {
    const side = productS(o.suggestion);
    const strip = cartAside.getByRole("region", { name: "¿Algo más?" });
    await expect(strip).toBeVisible();
    await tap(
      k,
      strip.getByRole("button", {
        name: `Agregar ${side.name}, ${mxn(side.price!)}`,
        exact: true,
      }),
    );
  }
  await fill(k, cartAside.getByLabel("Nombre (opcional)"), o.name);
  await expect(cartAside).toContainText(mxn(chargedS(o)));
  if (o.id === "S1") await kioskCheckpoint(k, "S5-kiosk-cart", cartAside);
  await tap(
    k,
    cartAside.getByRole("button", { name: "Enviar pedido", exact: true }),
  );
  await expect(
    page.getByRole("heading", { name: "¿Para aquí o para llevar?" }),
  ).toBeVisible();
  await tap(
    k,
    page.getByRole("button", {
      name: o.fulfillment === "here" ? "Para aquí" : "Para llevar",
      exact: true,
    }),
  );
  await expect(
    page.getByRole("heading", { name: "¿Cómo quieres pagar?" }),
  ).toBeVisible();
  const before = new Set((await fakeCharges(state)).map((c) => c.id));
  await tap(
    k,
    page.getByRole("button", { name: "Pagar aquí con tarjeta", exact: true }),
  );
  await expect(
    page.getByRole("heading", {
      name: `Sigue las instrucciones en la terminal · ${mxn(chargedS(o))}`,
    }),
  ).toBeVisible({ timeout: 20_000 });
  const charge = await newCharge(state, t.device, before);
  // No tip at a kiosk: MP's order is the total, Clip's the bill with no tip apart.
  expect(charge.amount, `${o.id}: the amount sent to ${t.name}`).toBe(
    chargedS(o),
  );
  expect(charge.tip, `${o.id}: no tip`).toBe(0);
  (state.kioskCharges as Record<string, string>)[o.id] = charge.id;
  return charge;
}

/** The kiosk's code for the order (K-n), from the screen it ended on. */
async function kioskCode(k: Device) {
  return (await k.page.locator(".kiosk-code").first().innerText()).trim();
}

/** Approved: «¡Pagado!», to the kitchen with no staff tap (LD-72). */
async function paidAtKiosk(k: Device, state: RunState, o: OrderS, ref: string) {
  const page = k.page;
  await approve(state, ref, o.card);
  await expect(
    page.getByRole("heading", {
      name: /^¡Pagado! Tu pedido K-\d+ ya se está preparando\.$/,
    }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".kiosk-paid")).toContainText(
    `Folio S-${String(o.number).padStart(6, "0")}`,
  );
  const label = await kioskCode(k);
  (state.kioskLabels as Record<string, string>)[o.id] = label;
  if (o.member)
    await expect(page.locator(".kiosk-paid")).toContainText(
      `Sumaste 1 sello(s) · 1 de ${CLUB_S.stampsRequired}`,
      { timeout: 30_000 },
    );
  if (o.id === "S1")
    await kioskCheckpoint(k, "S5-kiosk-paid", page.locator(".kiosk-paid"));
  await tap(k, page.getByRole("button", { name: "Nuevo pedido", exact: true }));
  await expect(
    page.getByRole("button", { name: "Toca para ordenar", exact: true }),
  ).toBeVisible();
}

/** Approved after the product changed: «Tu pago se registró. Pasa a caja…» (review). */
async function paidNoOrder(k: Device, state: RunState, o: OrderS, ref: string) {
  const page = k.page;
  await approve(state, ref, o.card);
  await expect(
    page.getByText(
      /^Tu pago se registró\. Pasa a caja con tu código K-\d+ para confirmar tu pedido\.$/,
    ),
  ).toBeVisible({ timeout: 60_000 });
  const label = /K-\d+/.exec(
    await page
      .getByText(/^Tu pago se registró\./)
      .first()
      .innerText(),
  )![0];
  (state.kioskLabels as Record<string, string>)[o.id] = label;
  const next = page.getByRole("button", { name: "Nuevo pedido", exact: true });
  if (await next.count()) await tap(k, next.first());
  await expect(
    page.getByRole("button", { name: "Toca para ordenar", exact: true }),
  ).toBeVisible({ timeout: 40_000 });
  return label;
}

/** The owner's menu: Productos. */
async function ownerProducts(owner: Device) {
  const page = owner.page;
  await page
    .getByRole("navigation", { name: "Operación" })
    .getByRole("button", { name: "Menú e inventario" })
    .click();
  await page
    .getByRole("navigation", { name: "Menú e inventario" })
    .getByRole("button", { name: "Menú", exact: true })
    .click();
  await page.getByRole("tab", { name: "Productos" }).click();
}

async function setAvailable(owner: Device, id: string, available: boolean) {
  const page = owner.page;
  await ownerProducts(owner);
  const toggle = page.getByRole("switch", {
    name: `Disponible: ${productS(id).name}`,
  });
  if ((await toggle.isChecked()) !== available) await toggle.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Cambios guardados" }),
  ).toBeVisible();
  if (available) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
}

async function setPrice(owner: Device, id: string, price: number) {
  const page = owner.page;
  await ownerProducts(owner);
  await page
    .getByRole("button", { name: `Editar ${productS(id).name}`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Editar producto" });
  await dialog.getByLabel(/^Precio al cliente \(con IVA\)/).fill(pesos(price));
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/** The red card in the register's inbox, then payments' resolve dialog. */
async function resolveCard(caja: Device, o: OrderS, label: string) {
  const page = caja.page;
  const t = pay.terminals[KIOSKS_S[o.kiosk].terminal];
  await toOrdersS(caja);
  const card = page.locator("article.hold-card", { hasText: label });
  const reason =
    o.resolution.kind === "retry"
      ? "un producto ya no está disponible"
      : "cambió un precio";
  await expect(card.getByRole("alert").locator("p").first()).toHaveText(
    `${label} pagó ${mxn(chargedS(o))} con tarjeta (${t.name}) y no se pudo enviar a cocina: ${reason}.`,
    { timeout: 30_000 },
  );
  await press(
    caja,
    card.getByRole("button", {
      name: "Resolver cobro del kiosco",
      exact: true,
    }),
  );
  const dialog = page.getByRole("dialog", {
    name: "Resolver cobro en terminal",
  });
  await expect(dialog).toBeVisible();
  return { card, dialog };
}

/** S3's review: the product is back; the cashier's «Registrar el cobro aprobado» (no PIN). */
async function retryAtCounter(
  owner: Device,
  caja: Device,
  o: OrderS,
  label: string,
) {
  if (o.resolution.kind !== "retry") throw Error(o.id);
  await setAvailable(owner, o.resolution.product, true);
  await awake(caja, staffS("ines"));
  const { card, dialog } = await resolveCard(caja, o, label);
  // A cashier has no manager outcome: only the retry (and «Volver a consultar»).
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await press(
    caja,
    dialog.getByRole("button", {
      name: "Registrar el cobro aprobado",
      exact: true,
    }),
  );
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(card).toHaveCount(0, { timeout: 30_000 });
}

/**
 * S4's review: the manager accepts the hold at today's price with the kiosk payment, and the
 * difference is collected in cash in the same accept (critic R13).
 */
async function acceptWithRest(caja: Device, o: OrderS, label: string) {
  const res = o.resolution;
  if (res.kind !== "acceptWithRest") throw Error(o.id);
  const page = caja.page;
  const total = O().holds.find((h) => h.order === o.id)!.acceptedTotal;
  const charged = mxn(chargedS(o));
  const rest = mxn(Number(total.replace(/[$,]/g, "")) * 100 - chargedS(o));
  await awake(caja, staffS("ines"));
  await switchUser(caja, staffS("saul"));
  const { dialog } = await resolveCard(caja, o, label);
  const accept = dialog.getByRole("radio", {
    name: "Aceptar con el pago del kiosco",
    exact: true,
  });
  await expect(accept).toBeChecked();
  await expect(
    dialog.getByRole("radio", { name: "Rechazar y reembolsar", exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText(
    `Total del pedido: ${total} · Cobrado en el kiosco: ${charged}`,
  );
  await expect(dialog).toContainText(
    `Falta cobrar ${rest}: al aceptar lo cobras en efectivo o con una terminal.`,
  );
  await fill(
    caja,
    dialog.getByLabel("Motivo (mínimo 10 caracteres)"),
    res.note,
  );
  await dialog.getByLabel("Revisé el historial del proveedor").check();
  await checkpoint(caja, "S5-accept-with-kiosk-payment", { settle: dialog });
  await press(
    caja,
    dialog.getByRole("button", {
      name: `Aceptar y cobrar ${rest}`,
      exact: true,
    }),
  );
  await expect(dialog).toHaveCount(0);
  const payment = page.getByRole("dialog", { name: /^Cobrar/ });
  await expect(payment).toBeVisible();
  await expect(payment.getByLabel("Importe", { exact: true })).toHaveValue(
    rest.slice(1),
  );
  await tap(
    caja,
    payment
      .getByRole("group", { name: "Efectivo recibido rápido" })
      .getByRole("button", {
        name: new RegExp(`^\\$${res.received / 100}(\\.00)?$`),
      }),
  );
  await tap(
    caja,
    payment.getByRole("button", { name: "Confirmar cobro", exact: true }),
  );
  const receipt = page.getByRole("dialog", { name: "Recibo" });
  await expect(receipt).toBeVisible({ timeout: 30_000 });
  const text = (await receipt.innerText()).replace(/\s+/g, " ");
  for (const s of [
    `Tarjeta · ${pay.terminals[KIOSKS_S[o.kiosk].terminal].name} · VISA •••• ${o.card.last4}`,
    `Efectivo ${rest}`,
    `Total ${total}`,
  ])
    expect(text, `S4 receipt: ${s}`).toContain(s);
  await press(
    caja,
    receipt.getByRole("button", { name: "Siguiente venta", exact: true }),
  );
  await expect(receipt).toHaveCount(0);
  await switchUser(caja, staffS("ines"));
}

/** No staff tap: the register's inbox never shows a paid kiosk order. */
async function noCard(caja: Device, label: string) {
  await awake(caja, staffS("ines"));
  await toOrdersS(caja);
  await expect(
    caja.page.locator("article.hold-card", { hasText: label }),
  ).toHaveCount(0);
}

// ------------------------------------------------------------------ S6: close and the owner

async function closeDrawer(caja: Device) {
  const page = caja.page;
  const z = O().corteZ;
  run.step = "S6.1";
  await awake(caja, staffS("ines"));
  await switchUser(caja, staffS("saul"));
  await toCash(caja);
  await press(
    caja,
    page.getByRole("button", { name: "Cerrar caja", exact: true }),
  );
  const close = page.getByRole("dialog", { name: "Cerrar caja" });
  await fill(
    caja,
    close.getByLabel("Efectivo contado", { exact: true }),
    pesos(r.countedCash),
  );
  for (const k of ["mp", "clip"] as TerminalKeyS[]) {
    const t = pay.terminals[k];
    const row = Object.entries(z.terminal.byTerminal).find(([l]) =>
      l.startsWith(`${t.name} (`),
    )!;
    await fill(
      caja,
      close.getByLabel(`Total del lote · ${t.name}`, { exact: true }),
      row[1].batch.replace(/[$,]/g, ""),
    );
  }
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
  record("S close result", z.cash, shown);
  for (const s of [
    `Efectivo esperado ${z.cash.expected}`,
    `Efectivo contado ${z.cash.counted}`,
    `Diferencia ${z.cash.difference} · Cuadra`,
    `Neto en terminal ${z.terminal.net}`,
    `Total reportado de la terminal ${z.terminal.reported}`,
    `Diferencia en terminal $0.00 · Cuadra`,
  ])
    expect(shown, `close result: ${s}`).toContain(s);
  await press(caja, result.getByRole("button", { name: "Listo", exact: true }));
}

async function sectionRows(doc: Locator, title: RegExp) {
  const section = doc.locator("section.doc-section").filter({
    has: doc.page().locator("h3.doc-section-title", { hasText: title }),
  });
  await expect(section).toHaveCount(1);
  const out: Array<[string, string]> = [];
  for (const row of await section.locator(".doc-row").all())
    out.push([
      (await row.locator(".doc-label").innerText()).trim(),
      (await row.locator(".doc-amount").innerText()).trim(),
    ]);
  return out;
}

async function corteZ(owner: Device) {
  const page = owner.page;
  const z = O().corteZ;
  run.step = "S6.2";
  await openFinance(owner, "Cortes");
  const drawerRow = page
    .locator("main")
    .getByRole("row")
    .filter({ hasText: "Cerrada" })
    .filter({ hasText: staffS("saul").name });
  await expect(drawerRow).toHaveCount(1);
  await drawerRow.getByRole("button", { name: /corte Z/i }).click();
  const preview = page.getByRole("dialog", { name: "Vista previa" });
  const doc = preview.locator(".corte-doc");
  await expect(doc).toContainText("CORTE Z · CIERRE DE CAJA");
  const cash = await sectionRows(doc, /^EFECTIVO$/);
  const terminal = await sectionRows(doc, /^TERMINAL EXTERNA$/);
  record("S corte Z cash", z.cash, cash);
  record("S corte Z terminal", z.terminal, terminal);
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
  const names = /^(MP Kiosco|Clip Kiosco) \(\d+\)$/;
  expect(
    terminal.filter(([l]) => !names.test(l) && !l.startsWith("· ")),
  ).toEqual([
    [`Cobros con terminal (${z.terminal.count})`, z.terminal.sales],
    ["Propinas con terminal", z.terminal.tips],
    ["Reembolsos en terminal", "$0.00"],
    ["Neto en terminal", z.terminal.net],
    ["Total reportado por la terminal", z.terminal.reported],
    ["Diferencia en terminal (cuadra)", "$0.00"],
  ]);
  // Each terminal, its batch total, its «Del kiosco» sub-line and its estimated fees.
  const grouped: Record<string, Array<[string, string]>> = {};
  let current: string | null = null;
  for (const [label, amount] of terminal) {
    if (names.test(label)) grouped[(current = label)] = [["", amount]];
    else if (label.startsWith("· ") && current)
      grouped[current]!.push([label.slice(2), amount]);
  }
  expect(grouped).toEqual(
    Object.fromEntries(
      Object.entries(z.terminal.byTerminal).map(([label, v]) => [
        label,
        [
          ["", v.net],
          ["Total del lote", v.batch],
          [v.kiosk, ""],
          ["Comisiones estimadas", v.fees],
        ],
      ]),
    ),
  );
  expect(await sectionRows(doc, /^COBROS$/)).toEqual([
    ["Cobros registrados", String(z.payments)],
  ]);
  await expect(doc).toContainText(`Folios ${z.folios} (${z.tickets} tickets)`);
  await checkpoint(owner, "S6-corte-z", { settle: preview });
  await preview.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(preview).toHaveCount(0);
}

/** Excepciones: payments' attempt kinds only; the kiosk adds none (critic R13). */
async function exceptions(owner: Device) {
  const page = owner.page;
  const e = O().exceptions;
  run.step = "S6.3";
  await openFinance(owner, "Excepciones");
  const review = page
    .getByRole("row")
    .filter({ hasText: "Cobro en terminal por revisar" });
  await expect(review).toHaveCount(e.review.length);
  for (const x of e.review)
    await expect(
      review.filter({ hasText: `#${x.number}` }).filter({ hasText: x.amount }),
    ).toContainText(x.terminal);
  const recorded = page
    .getByRole("row")
    .filter({ hasText: "Cobro en terminal resuelto por gerente" });
  await expect(recorded).toHaveCount(e.recorded.length);
  for (const x of e.recorded)
    for (const s of [
      `#${x.number}`,
      x.amount,
      staffS("saul").name,
      `${x.terminal} · registrado`,
    ])
      await expect(recorded).toContainText(s);
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "Cobro en terminal sin confirmar" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("row").filter({ hasText: /[Kk]iosco/ }),
  ).toHaveCount(0);
}

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
  run.step = "S6.4";
  await openFinance(owner, "Pagos");
  const byTerminal = await tableRows(page, "Por terminal");
  const byMethod = await tableRows(page, "Cobros por método");
  const total = (
    await page
      .locator("section.panel")
      .filter({
        has: page.getByRole("heading", {
          name: "Cobros por método",
          exact: true,
        }),
      })
      .locator("tfoot tr")
      .first()
      .locator("td,th")
      .allInnerTexts()
  ).map((x) => x.replace(/\s+/g, " ").trim());
  record("S Finanzas por terminal", f.byTerminal, byTerminal);
  record("S Finanzas por método", f.byMethod, byMethod);
  expect(byTerminal).toEqual(f.byTerminal);
  expect(byMethod).toEqual(f.byMethod);
  expect(total).toEqual(f.byMethodTotal);
  run.step = "S6.5";
  await openFinance(owner, "Kiosco");
  const k = O().kioskReport;
  const report = page.locator("section.loyalty-report", {
    has: page.getByRole("heading", { name: "Kiosco", exact: true }),
  });
  const tiles: Array<[string, string]> = [];
  await expect(report.locator(".loyalty-tile")).toHaveCount(9);
  for (const tile of await report.locator(".loyalty-tile").all())
    tiles.push([
      (await tile.locator("span").innerText()).trim(),
      (await tile.locator("strong").innerText()).trim(),
    ]);
  record("S Finanzas Kiosco", k, tiles);
  expect(tiles).toEqual([
    ["Pedidos del kiosco", k.orders],
    ["Pagados en el kiosco", k.paidAtKiosk],
    ["Pagados en caja", k.paidAtCounter],
    ["Cobros por resolver", k.reviewOpen],
    ["Cobros resueltos", k.reviewResolved],
    ["Reembolsados en el proveedor", k.refunded],
    ["Importe reembolsado", k.refundedAmount],
    ["Líneas sugeridas aceptadas", k.suggestionLines],
    ["Importe de sugerencias", k.suggestionAmount],
  ]);
  await checkpoint(owner, "S6-finance-kiosk", { settle: report });
}

/** The fake's charges for Restaurant S per device, in creation order (none pushed twice). */
async function fakeAtClose(state: RunState) {
  const res = await fetch(`${state.paymentsFakeUrl}/__fake/violations`);
  expect(await res.json(), "the fake saw no contract breach").toEqual([]);
  const ids = state.kioskCharges as Record<string, string>;
  const mine = new Set(Object.values(ids));
  const byDevice: typeof FAKE_CHARGES_S = {};
  for (const c of await fakeCharges(state))
    if (mine.has(c.id))
      (byDevice[c.device] ??= []).push({
        order: Object.entries(ids).find(([, id]) => id === c.id)![0],
        amount: c.amount,
        tip: c.tip,
        status: c.status,
      });
  record("S fake charges", FAKE_CHARGES_S, byDevice);
  expect(byDevice).toEqual(FAKE_CHARGES_S);
}

export async function serviceS(dev: Devices, state: RunState) {
  const owner = await dev("ownerS");
  const caja = await dev("cajaS");
  expect(
    state.paymentsFakeUrl,
    "branch S runs with the payments fake",
  ).toBeTruthy();
  state.kioskCharges = {};
  state.kioskLabels = {};
  run.step = "S3.1";
  await settings(owner.page);
  await connect(owner, "mp");
  await connect(owner, "clip");
  await clubOn(owner);
  await kiosksSetup(owner, state);
  const paths = state.kioskPaths as Record<KioskKeyS, string>;
  const tablets = {} as Record<KioskKeyS, Device>;
  run.step = "S3.4";
  for (const k of Object.keys(KIOSKS_S) as KioskKeyS[]) {
    tablets[k] = await dev(KIOSK_DEVICES[k]);
    await pairTablet(owner, tablets[k], k, paths[k]);
  }
  await checkpoint(tablets.entrada, "S3-kiosk-welcome", {
    sizes: KIOSK_SIZES,
    settle: tablets.entrada.page.getByRole("button", {
      name: "Toca para ordenar",
      exact: true,
    }),
  });
  // The register reads the club and the new terminals on a reload.
  await caja.page.reload();
  await awake(caja, staffS("ines"));
  await enrolMember(caja);
  for (const o of ORDERS_S) {
    run.step = `S5 ${o.id}`;
    const k = tablets[o.kiosk];
    const charge = await guestPays(k, state, o);
    const res = o.resolution;
    if (res.kind === "approved") {
      await paidAtKiosk(k, state, o, charge.id);
      await noCard(caja, (state.kioskLabels as Record<string, string>)[o.id]!);
      continue;
    }
    // The product changes while the guest's card is on the reader.
    if (res.kind === "retry") await setAvailable(owner, res.product, false);
    else await setPrice(owner, res.product, res.newPrice);
    const label = await paidNoOrder(k, state, o, charge.id);
    if (res.kind === "retry") await retryAtCounter(owner, caja, o, label);
    else await acceptWithRest(caja, o, label);
  }
  await closeDrawer(caja);
  await corteZ(owner);
  await exceptions(owner);
  await finance(owner);
  run.step = "S6.6";
  await fakeAtClose(state);
  // The hand-typed table is the one the screens were held to (§5.1 double entry).
  expect(O()).toEqual(EXPECTED_S);
}
