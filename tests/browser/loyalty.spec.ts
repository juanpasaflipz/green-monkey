import "dotenv/config";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";
import { kitchenHygiene } from "./kitchen-hygiene.js";

// Loyalty club (038), specs/loyalty-w4.md §9.3. The demo owner "Alex Demo" runs the counter and
// the management screens; the kitchen is "Cocina Demo". The club is switched on for this file
// only: afterAll switches it off and restores the restaurant's privacy notice, so every other spec
// sells exactly as before (no prompt, no club controls).
test.describe.configure({ mode: "serial" });
const tenantId = "10000000-0000-4000-8000-000000000001";
const OWNER_PASSWORD = "demo-green-monkey";
const NOTICE = "https://example.com/aviso-de-privacidad-club";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const WIDTHS = [
  [1440, 900],
  [1024, 768],
  [768, 1024],
  [390, 844],
] as const;

/** Local fixture database only (same guard as discounts.spec). */
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
    throw Error("Loyalty fixtures require the isolated local dev database");
  return postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
}
async function inTenant<T>(baseURL: string | undefined, fn: (tx: any) => Promise<T>) {
  const admin = fixtureAdmin(baseURL);
  try {
    return (await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${tenantId},true)`;
      return fn(tx);
    })) as T;
  } finally {
    await admin.end();
  }
}
const uuid = () => crypto.randomUUID();
/** A fresh 10-digit Mexican number for this run. */
const newPhone = () => "55" + String(Math.floor(10_000_000 + Math.random() * 89_999_999));

async function login(page: Page) {
  await page.goto("/app");
  await page.getByLabel("Contraseña o PIN").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hoy", exact: true })).toBeVisible();
}
async function call<T = any>(page: Page, path: string, body?: unknown): Promise<T> {
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
async function openDrawer(page: Page) {
  const current = await call(page, "/cash");
  if (!current || current.closed_at)
    await call(page, "/cash/open", { operationId: uuid(), opening: 50000 });
}
async function sell(page: Page) {
  await page.locator("nav.rail").getByRole("button", { name: "Operación", exact: true }).click();
  await page.getByRole("button", { name: "Vender", exact: true }).click();
}
const product = (page: Page, name: string) =>
  page.locator("button.product").filter({ hasText: name }).first();
async function settings(page: Page) {
  await page.locator("nav.rail").getByRole("button", { name: "Configuración", exact: true }).click();
  const panel = page.locator("section.loyalty-settings");
  await expect(panel.getByRole("heading", { name: "Club de lealtad", exact: true })).toBeVisible();
  return panel;
}
async function axe(page: Page, include: string) {
  const r = await new AxeBuilder({ page }).include(include).withTags(AXE_TAGS).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}
async function stubPrint(page: Page) {
  await page.evaluate(() => {
    (window as any).__printed = [];
    window.print = () => {
      (window as any).__printed.push(document.getElementById("print-root")?.innerText ?? "");
    };
  });
}

let previousNotice: string | null = null;
let memberPhone = "";
let memberId = "";

test.beforeAll(async ({ baseURL }) => {
  await inTenant(baseURL, async (tx) => {
    const [row] = await tx`select privacy_notice_url from restaurant_account_settings where tenant_id=${tenantId}`;
    previousNotice = row?.privacy_notice_url ?? null;
    // Start from a restaurant with no notice and the club off (a rerun on the same database).
    await tx`update restaurant_account_settings set privacy_notice_url=null where tenant_id=${tenantId}`;
    await tx`update loyalty_settings set enabled=false where tenant_id=${tenantId}`;
  });
});
test.afterAll(async ({ baseURL }) => {
  await inTenant(baseURL, async (tx) => {
    await tx`update loyalty_settings set enabled=false where tenant_id=${tenantId}`;
    await tx`update restaurant_account_settings set privacy_notice_url=${previousNotice} where tenant_id=${tenantId}`;
  });
});

// W3-2: every round a test sends to the kitchen is delivered after it.
kitchenHygiene();

test("settings: turning the club on waits for the privacy notice and the attestation; a POS Lite export imports with Verificado", async ({
  page,
  baseURL,
}) => {
  await login(page);
  let panel = await settings(page);
  await expect(panel).toContainText("Primero publica el aviso de privacidad del restaurante");
  // The warning leads to Privacidad y datos (LOYALTY-UX-18); the published legal set covers the
  // club, so no "documentos legales" note (LOYALTY-PRIVACY-4).
  await expect(panel.getByRole("button", { name: "Agregar aviso de privacidad", exact: true })).toBeVisible();
  await expect(panel).not.toContainText("cuando Green Monkey publique sus documentos legales");
  await panel.getByLabel("Activar el club").check();
  await panel.getByLabel(/Mi aviso de privacidad incluye el club/).check();
  await panel.getByRole("button", { name: "Guardar club de lealtad", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "Publica el aviso de privacidad del restaurante antes de usar el club.",
  );
  await inTenant(baseURL, async (tx) => {
    await tx`insert into restaurant_account_settings(tenant_id,privacy_notice_url) values(${tenantId},${NOTICE})
      on conflict (tenant_id) do update set privacy_notice_url=excluded.privacy_notice_url`;
  });
  await page.reload();
  panel = await settings(page);
  await expect(panel.getByRole("link", { name: NOTICE, exact: true })).toHaveAttribute("href", NOTICE);
  // The import is offered while the club is off.
  await panel.getByLabel("Archivo de exportación de POS Lite (.json)").setInputFiles(
    "tests/fixtures/poslite-loyalty-export.json",
  );
  await expect(panel.locator(".loyalty-import")).toContainText(/6 socios · 17 sellos en tarjetas/);
  await expect(panel.locator(".loyalty-import")).toContainText("4 filas rechazadas");
  await panel.getByRole("button", { name: "Importar", exact: true }).click();
  await expect(panel.getByText("Verificado: los totales coinciden con POS Lite.")).toBeVisible();
  // Without the attestation the club stays off.
  await panel.getByLabel("Activar el club").check();
  await panel.getByLabel(/Mi aviso de privacidad incluye el club/).uncheck();
  await panel.getByRole("button", { name: "Guardar club de lealtad", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "Confirma que tu aviso de privacidad incluye el club.",
  );
  await panel.getByLabel(/Mi aviso de privacidad incluye el club/).check();
  await panel.getByRole("button", { name: "Guardar club de lealtad", exact: true }).click();
  await expect(panel.getByText("Configuración del club guardada.")).toBeVisible();
  await expect(panel.getByText(/Confirmado por/)).toBeVisible();
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    await axe(page, "section.loyalty-settings");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("cashier: the first item opens Cliente del club; enrollment with consent; a cash payment adds 1 stamp; the receipt prints the counts with no name or phone", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await sell(page);
  await product(page, "Taco de hongos").click();
  const dialog = page.getByRole("dialog", { name: "Cliente del club" });
  await expect(dialog).toBeVisible();
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    await axe(page, "dialog");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  memberPhone = newPhone();
  await dialog.getByLabel("Teléfono (10 dígitos)").fill(memberPhone);
  await dialog.getByRole("button", { name: "Buscar", exact: true }).first().click();
  await expect(dialog.getByText("No hay socio con ese teléfono.")).toBeVisible();
  await expect(dialog.getByText(/Guardamos tu nombre y teléfono/)).toBeVisible();
  await expect(dialog.getByLabel(/Acepta recibir promociones/)).not.toBeChecked();
  await axe(page, "dialog");
  await dialog.getByRole("button", { name: "Mostrar aviso de privacidad (QR)" }).click();
  await expect(dialog.getByRole("img", { name: "Aviso de privacidad" })).toBeVisible();
  await dialog.getByLabel("Nombre o apodo").fill("Ana Club");
  await dialog.getByLabel(/Le informé al cliente el aviso de privacidad/).check();
  await dialog.getByRole("button", { name: "Registrar", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".loyalty-chip")).toContainText("Ana · 0/10");
  await expect(page.getByLabel("Nombre para llamar")).toHaveValue("Ana");
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page.getByRole("button", { name: "Confirmar cobro", exact: true }).click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Cobrado");
  await expect(page.locator(".notice")).toContainText("Ana sumó 1 sello: 1 de 10.");
  const block = receipt.locator(".loyalty-receipt-block");
  await expect(block).toContainText("1 de 10 sellos");
  await expect(block).not.toContainText("Ana");
  await expect(block).not.toContainText(memberPhone.slice(-4));
  const found = await call(page, "/loyalty/members/lookup", { phone: memberPhone, country: "MX" });
  memberId = found.id;
  expect(found.stamps).toBe(1);
  await page.getByRole("button", { name: "Siguiente venta", exact: true }).click();
});

test("returning member with a reward: Canjear premio after Enviar productos primero comps one unit; the remainder is paid; the receipt says Recompensa del club", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  await call(page, `/loyalty/members/${memberId}/adjust`, {
    operationId: uuid(),
    rewards: 1,
    reason: "goodwill",
    note: "Premio de prueba",
  });
  await sell(page);
  await product(page, "Taco de hongos").click();
  const dialog = page.getByRole("dialog", { name: "Cliente del club" });
  await dialog.getByLabel("Teléfono (10 dígitos)").fill(memberPhone);
  await dialog.getByRole("button", { name: "Buscar", exact: true }).first().click();
  await expect(dialog.getByText("1 premio disponible")).toBeVisible();
  await dialog.getByRole("button", { name: "Usar", exact: true }).click();
  await expect(page.locator(".loyalty-chip")).toContainText("Ana · 1/10");
  await product(page, "Agua de jamaica").click();
  await page.getByRole("button", { name: "Canjear premio", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Enviar productos primero" })
    .getByRole("button", { name: "Enviar y continuar", exact: true })
    .click();
  const redeem = page.getByRole("dialog", { name: /Canjear premio: / });
  await expect(redeem).toBeVisible();
  const option = await redeem
    .locator("option")
    .filter({ hasText: "Taco de hongos" })
    .getAttribute("value");
  await redeem.getByLabel("Elige el producto").selectOption(option!);
  await expect(redeem.getByRole("status")).toContainText("Premio: −$45.00");
  await redeem.getByRole("button", { name: "Canjear", exact: true }).click();
  await expect(redeem).toBeHidden();
  await expect(page.locator(".existing")).toContainText("−$45.00");
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page.getByRole("button", { name: "Confirmar cobro", exact: true }).click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Recompensa del club");
  await page.getByRole("button", { name: "Siguiente venta", exact: true }).click();
});

test("walk-in and moves: a Sin club sale's Vender receipt shows and prints the join QR; a member picked for a new cart does not follow it to another check and comes back with its parked cart (LOYALTY-OPS-1, UX-1, UX-2)", async ({
  page,
}) => {
  await login(page);
  await openDrawer(page);
  const catalog = await call(page, "/catalog");
  const taco = catalog.find((p: any) => p.name.es === "Taco de hongos");
  await call(page, "/orders", {
    operationId: uuid(),
    lines: [{ id: uuid(), productId: taco.id, quantity: 1, options: [], note: "" }],
    mode: "takeaway",
    tableId: null,
    name: "Cuenta sin club",
    note: "",
    channel: "pos",
  });
  await sell(page);
  // A walk-in: Sin club, cash. The receipt reads its own club block and prints it.
  await product(page, "Taco de hongos").click();
  await page.getByRole("dialog", { name: "Cliente del club" }).getByRole("button", { name: "Sin club", exact: true }).click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page.getByRole("button", { name: "Confirmar cobro", exact: true }).click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Cobrado");
  const block = receipt.locator(".loyalty-receipt-block");
  await expect(block).toContainText("Únete a");
  await expect(block.getByRole("img")).toBeVisible();
  await stubPrint(page);
  await page.getByRole("button", { name: "Imprimir recibo", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => ((window as any).__printed as string[]).join("\n")))
    .toContain("Únete a");
  await page.getByRole("button", { name: "Siguiente venta", exact: true }).click();
  // Ana in a new cart, then another check from Órdenes: the check starts without her.
  await product(page, "Taco de hongos").click();
  const dialog = page.getByRole("dialog", { name: "Cliente del club" });
  await dialog.getByLabel("Teléfono (10 dígitos)").fill(memberPhone);
  await dialog.getByRole("button", { name: "Buscar", exact: true }).first().click();
  await dialog.getByRole("button", { name: "Usar", exact: true }).click();
  await expect(page.locator(".loyalty-chip")).toContainText("Ana");
  await page.getByRole("button", { name: "Órdenes", exact: true }).click();
  await page
    .locator(".order-summary")
    .filter({ hasText: "Cuenta sin club" })
    .first()
    .getByRole("button", { name: "Abrir orden" })
    .click();
  await expect(page.getByLabel("Nombre para llamar")).toHaveValue("Cuenta sin club");
  await expect(page.locator(".loyalty-chip")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Canjear premio", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Club", exact: true })).toBeVisible();
  // Ana's parked cart comes back with her.
  await page.getByRole("button", { name: "Borradores", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Borradores" })
    .getByRole("button")
    .filter({ hasText: "Ana · 1 producto" })
    .first()
    .click();
  await expect(page.locator(".loyalty-chip")).toContainText("Ana");
  await page.getByRole("button", { name: "Nueva orden", exact: true }).click();
  await expect(page.locator(".loyalty-chip")).toHaveCount(0);
});

test("offline: the Club button is disabled with its hint and the sale completes", async ({ page }) => {
  await login(page);
  await openDrawer(page);
  await sell(page);
  await expect(page.getByRole("button", { name: "Club", exact: true })).toBeEnabled();
  const pill = (name: RegExp) => page.locator(".top-actions").getByRole("button", { name });
  await pill(/^Conectado/).click();
  await page.getByRole("switch", { name: "Trabajar sin conexión" }).check();
  await expect(pill(/^Sin conexión \(manual\)/)).toBeVisible();
  await sell(page);
  const club = page.getByRole("button", { name: "Club", exact: true });
  await expect(club).toBeDisabled();
  await expect(page.locator("#loyalty-offline-hint")).toHaveText("El club requiere conexión.");
  await product(page, "Taco de hongos").click();
  await expect(page.getByRole("dialog", { name: "Cliente del club" })).toHaveCount(0);
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await page.getByRole("button", { name: "Guardar cobro en este dispositivo", exact: true }).click();
  await expect(page.locator(".receipt")).toContainText("Pendiente de sincronizar");
  await page.getByRole("button", { name: "Siguiente venta", exact: true }).click();
  await pill(/^Sin conexión \(manual\)/).click();
  await page.getByRole("switch", { name: "Trabajar sin conexión" }).uncheck();
  await expect(pill(/^Conectado/)).toBeVisible();
});

test("receipt QR: /club joins once with counts only; a second attempt says Esta compra ya sumó sellos; the page registers no service worker", async ({
  page,
  browser,
}) => {
  await login(page);
  await openDrawer(page);
  const catalog = await call(page, "/catalog");
  const taco = catalog.find((p: any) => p.name.es === "Taco de hongos");
  const order = await call(page, "/orders", {
    operationId: uuid(),
    lines: [{ id: uuid(), productId: taco.id, quantity: 1, options: [], note: "" }],
    mode: "takeaway",
    tableId: null,
    name: "Club QR",
    note: "",
    channel: "pos",
  });
  await call(page, `/orders/${order.id}/payments`, {
    operationId: uuid(),
    amount: order.total,
    tip: 0,
    received: order.total,
    method: "cash",
    externalConfirmed: false,
    reference: "",
  });
  const receipt = await call(page, `/loyalty/orders/${order.id}/receipt`);
  expect(receipt.kind).toBe("join");
  const diner = await browser.newContext({ serviceWorkers: "allow" });
  try {
    const p = await diner.newPage();
    await p.goto(`/club#${receipt.token}`);
    await expect(p.getByRole("heading", { name: /Únete a / })).toBeVisible();
    await expect(p.getByRole("link", { name: /Aviso de privacidad de/ })).toHaveAttribute("href", NOTICE);
    for (const [width, height] of WIDTHS) {
      await p.setViewportSize({ width, height });
      await axe(p, "main");
    }
    await p.getByLabel("Teléfono (10 dígitos)").fill(newPhone());
    await p.getByLabel("Nombre o apodo").fill("Diana");
    await p.getByRole("button", { name: "Sumar mis sellos", exact: true }).click();
    await expect(p.getByRole("alert")).toContainText("Se necesita la aceptación del aviso de privacidad.");
    await expect(p.getByLabel(/Acepto recibir promociones/)).not.toBeChecked();
    await p.getByLabel(/Leí el aviso de privacidad de/).check();
    await p.getByRole("button", { name: "Sumar mis sellos", exact: true }).click();
    await expect(p.getByRole("status")).toContainText("¡Listo! Sumaste 1 sello. Llevas 1 de 10.");
    await expect(p.locator("main")).not.toContainText("Diana");
    await p.reload();
    await expect(p.getByText("Esta compra ya sumó sellos.")).toBeVisible();
    expect(await p.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  } finally {
    await diner.close();
  }
});

test("manager in Clientes: search, detail, Ajustar, Imprimir datos del cliente, Eliminar datos del cliente", async ({
  page,
}) => {
  await login(page);
  await page.locator("nav.rail").getByRole("button", { name: "Clientes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Clientes del club", exact: true })).toBeVisible();
  await page.getByLabel("Buscar por nombre o teléfono").fill(memberPhone);
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  const open = page.getByRole("button", { name: "Abrir Ana Club", exact: true });
  await expect(open).toHaveCount(1);
  await expect(page.locator("table.loyalty-table tbody tr")).toHaveCount(1);
  await open.click();
  await expect(page.getByRole("heading", { name: "Ana Club", exact: true })).toBeVisible();
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    await axe(page, "section.loyalty-member");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Ajustar sellos o premios", exact: true }).click();
  const adjust = page.getByRole("dialog", { name: "Ajustar sellos o premios" });
  // A refusal shows inside the dialog, not behind it (LOYALTY-UX-6).
  await adjust.getByLabel("Sellos (+ o −)").fill("-50");
  await adjust.getByLabel("Motivo (sin datos personales)").fill("Corrección de caja");
  await adjust.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(adjust.getByRole("alert")).toContainText("El ajuste dejaría la tarjeta en negativo.");
  // A double tap is one adjustment: one operationId per dialog and one request at a time.
  const adjustments = async () =>
    (await call(page, `/loyalty/members/${memberId}`)).history.filter((h: any) => h.kind === "adjustment").length;
  const before = await adjustments();
  await adjust.getByLabel("Sellos (+ o −)").fill("2");
  await adjust.getByRole("button", { name: "Confirmar", exact: true }).dblclick();
  await expect(adjust).toBeHidden();
  expect(await adjustments()).toBe(before + 1);
  await expect(page.locator(".loyalty-card")).toContainText(/de 10 sellos/);
  await expect(page.getByRole("list", { name: "Movimientos" })).toContainText("Ajuste manual");
  await stubPrint(page);
  await page.getByRole("button", { name: "Imprimir datos del cliente", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => ((window as any).__printed as string[]).join("\n")))
    .toContain("Datos del cliente en el club");
  await page.getByRole("button", { name: "Eliminar datos del cliente", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "Eliminar datos del cliente" });
  await expect(remove.getByRole("button", { name: "Eliminar datos del cliente" })).toBeDisabled();
  await remove.getByLabel("Confirmación").fill("ELIMINAR");
  await remove.getByRole("button", { name: "Eliminar datos del cliente" }).click();
  await expect(page.getByRole("heading", { name: "Datos eliminados", exact: true })).toBeVisible();
  expect(await call(page, "/loyalty/members/lookup", { phone: memberPhone, country: "MX" })).toBeNull();
});

test("club off: Clientes stays for ARCO while members' data is held, with a note and no Ajustar (LOYALTY-PRIVACY-3)", async ({
  page,
  baseURL,
}) => {
  await inTenant(baseURL, (tx) => tx`update loyalty_settings set enabled=false where tenant_id=${tenantId}`);
  try {
    await login(page);
    const clientes = page.locator("nav.rail").getByRole("button", { name: "Clientes", exact: true });
    await clientes.click();
    await expect(page.getByText("El club está desactivado. Aquí puedes consultar, corregir o eliminar los datos de los clientes (derechos ARCO).")).toBeVisible();
    await page.locator("table.loyalty-table tbody tr").first().getByRole("button").click();
    await expect(page.getByRole("button", { name: "Editar datos", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Imprimir datos del cliente", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Eliminar datos del cliente", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ajustar sellos o premios", exact: true })).toHaveCount(0);
  } finally {
    await inTenant(baseURL, (tx) => tx`update loyalty_settings set enabled=true where tenant_id=${tenantId}`);
  }
});

test("Finanzas › Club de lealtad shows the period's figures", async ({ page }) => {
  await login(page);
  await page.locator("nav.rail").getByRole("button", { name: "Finanzas", exact: true }).click();
  await page.getByRole("tab", { name: "Club de lealtad", exact: true }).click();
  const report = page.locator("section.loyalty-report");
  await expect(report.getByRole("heading", { name: "Club de lealtad" })).toBeVisible();
  await expect(report.locator(".loyalty-tile").filter({ hasText: "Sellos sumados" })).toBeVisible();
  await expect(report.locator(".loyalty-tile").filter({ hasText: "Premios canjeados" })).toContainText(/[1-9]/);
  await axe(page, "section.loyalty-report");
});

test("English locale: the club's strings are English", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("gm-locale", "en"));
  try {
    await page.reload();
    await page.locator("nav.rail").getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Loyalty club", exact: true })).toBeVisible();
    await expect(page.getByText("Turn on the club")).toBeVisible();
    await expect(page.locator("nav.rail").getByRole("button", { name: "Customers", exact: true })).toBeVisible();
  } finally {
    await page.evaluate(() => localStorage.setItem("gm-locale", "es"));
  }
});

test("kitchen: no Clientes and no club controls", async ({ page }) => {
  await login(page);
  const status = await page.evaluate(
    async ({ tenantId }) => {
      const s = await (await fetch("/api/session")).json();
      await fetch("/api/logout", { method: "POST", headers: { "x-csrf-token": s.csrf } });
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, login: "kitchen", secret: "654321" }),
      });
      return r.status;
    },
    { tenantId },
  );
  expect(status).toBe(200);
  await page.goto("/app");
  await expect(page.locator("nav.rail")).toBeVisible();
  await expect(page.locator("nav.rail").getByRole("button", { name: "Clientes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Club", exact: true })).toHaveCount(0);
  const r = await page.evaluate(async () => {
    const s = await (await fetch("/api/session")).json();
    const res = await fetch("/api/loyalty/members/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": s.csrf },
      body: JSON.stringify({ phone: "5512345678", country: "MX" }),
    });
    return { status: res.status, body: await res.json() };
  });
  expect([r.status, r.body.error]).toEqual([403, "forbidden"]);
});
