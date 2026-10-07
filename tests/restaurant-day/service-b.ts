/**
 * Restaurant B (specs/acceptance.md §7.6-§7.8): table service on phones, a
 * transfer, rounds after delivery, concurrent rounds, split payments, the
 * refund guidance before the ticket, the CFDI request (branch N), a paid
 * check waiting for "Liberar mesa", the blind close and the day's figures.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { mxn, oracleB } from "./oracle.js";
import { CHECKS_B, RESTAURANT_B, type CheckDef, type Payment } from "./scenario.js";
import {
  FIGURES,
  addLine,
  kdsChecks,
  kdsLines,
  kdsTicket,
  pesos,
  progressTicket,
  rcChecks,
  receiptStrings,
  squash,
} from "./selling.js";
import { reportValue, switchUser } from "./service-a.js";
import { dayFigures, registerChecks, stockChecks } from "./close-a.js";
import {
  checkpoint,
  escapeRe,
  fill,
  parseMxn,
  press,
  readApi,
  record,
  run,
  tap,
  type Device,
  type Devices,
} from "./ui.js";
import type { RunState } from "./env.js";

const r = RESTAURANT_B;
const check = (id: string) => CHECKS_B.find((c) => c.id === id)!;
const staffB = (key: string) => r.staff.find((s) => s.key === key)!;
const table = (page: Page, name: string) => page.locator(`article.table-card[aria-label="${name}"]`);

/** Operación → Mesas on a terminal or phone. */
async function toTables(d: Device) {
  // Already on Mesas: "Actualizar" re-reads the floor, as a person would.
  if (await d.page.locator(".table-grid").isVisible()) {
    await press(d, d.page.getByRole("button", { name: "Actualizar", exact: true }));
  } else
    await press(d, d.page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Mesas", exact: true }));
  await expect(d.page.locator(".table-grid")).toBeVisible();
}

/** P-ROUND (§7.6): one round on a waiter's phone, sent to the kitchen. */
async function round(
  waiter: Device,
  c: CheckDef,
  n: number,
  opts: { newCheck?: boolean; tableName?: string; send?: boolean; pickerOptions?: Parameters<typeof addLine>[4] } = {},
) {
  const page = waiter.page;
  const rd = c.rounds[n - 1]!;
  const where = opts.tableName ?? c.table;
  await toTables(waiter);
  const card = table(page, where);
  if (opts.newCheck) await press(waiter, card.getByRole("button", { name: "Nueva cuenta", exact: true }));
  else await press(waiter, card.getByRole("button", { name: new RegExp(`^#${c.number} · `) }));
  await expect(page.getByRole("heading", { name: "Vender", level: 1 })).toBeVisible();
  // The cart starts from the previous rounds' lines (sent), so new lines start at index 0 of the draft.
  const before = n === 1 ? 0 : 0;
  for (const [i, line] of rd.lines.entries()) await addLine(waiter, r, line, before + i, opts.pickerOptions ?? {});
  await press(waiter, page.locator("button.mobile-order"));
  const cartDialog = page.getByRole("dialog", { name: "Orden" });
  if (n === 1 && c.orderNote) await fill(waiter, cartDialog.getByLabel("Nota de la orden (cocina)", { exact: true }), c.orderNote);
  if (n > 1 && rd.note) await fill(waiter, cartDialog.getByLabel("Nota para esta ronda", { exact: true }), rd.note);
  if (opts.send === false) return cartDialog;
  await press(waiter, cartDialog.getByRole("button", { name: "Enviar a cocina", exact: true }));
  await sent(waiter, cartDialog);
  await press(waiter, cartDialog.getByRole("button", { name: "Cerrar", exact: true }));
  return cartDialog;
}

/** After "Enviar a cocina": the draft is empty and the check shows the round. */
async function sent(waiter: Device, cartDialog: Locator) {
  await expect(cartDialog.locator(".order-line")).toHaveCount(0);
  await expect(cartDialog.locator(".existing")).toContainText("Enviado a cocina");
  await expect(waiter.page.getByRole("alert")).toHaveCount(0);
}

/** KDS-checks for a round of a B check (header "{Mesa} · {mesero}"). */
async function kitchenRound(k: Device, c: CheckDef, n: number, opts: { tableName?: string; progress?: boolean } = {}) {
  const waiter = staffB(c.waiter).name;
  const rd = c.rounds[n - 1]!;
  const tickets = await kdsChecks(k, {
    number: c.number,
    round: n,
    mode: "En mesa",
    where: `${opts.tableName ?? c.table} · ${waiter}`,
    orderNote: c.orderNote,
    roundNote: rd.note,
    lines: kdsLines(r, rd.lines),
    tenant: "B",
  });
  if (opts.progress !== false) for (const t of Object.values(tickets)) await progressTicket(k, t);
  return tickets;
}

/** P-PAYB step 1: Mesas → the table card → its check → Vender → Cobrar. */
async function openCheck(caja: Device, c: CheckDef, tableName = c.movedTo ?? c.table) {
  const page = caja.page;
  await toTables(caja);
  await press(caja, table(page, tableName).getByRole("button", { name: new RegExp(`^#${c.number} · `) }));
  await expect(page.locator("aside.cart .existing")).toContainText(`#${c.number}`);
}

/** One payment of P-PAYB; returns after the receipt (partial or settling) is shown. */
async function payment(caja: Device, c: CheckDef, p: Payment, due: number, opts: { last: boolean; checkpointId?: string } = { last: false }) {
  const page = caja.page;
  await tap(caja, page.getByRole("button", { name: "Cobrar", exact: true }));
  const dialog = page.getByRole("dialog", { name: /^Cobrar/ });
  await expect(dialog.getByLabel("Importe", { exact: true })).toHaveValue(pesos(due));
  const amount = p.units ? p.units.reduce((sum, u) => sum + unitAmount(c, u), 0) : (p.amount ?? due);
  if (p.units) {
    await press(caja, dialog.getByRole("button", { name: "Dividir por productos", exact: true }));
    const units = dialog.getByRole("group", { name: "Productos de este pago" });
    for (const u of p.units) await press(caja, units.getByRole("checkbox", { name: new RegExp(`^${escapeRe(u)}\\b`) }));
    await expect(dialog.getByLabel("Importe", { exact: true })).toHaveAttribute("readonly", "");
    await expect(dialog.getByLabel("Importe", { exact: true })).toHaveValue(pesos(amount));
    if (opts.checkpointId) await checkpoint(caja, opts.checkpointId, { settle: dialog });
  } else if (amount !== due) await fill(caja, dialog.getByLabel("Importe", { exact: true }), pesos(amount));
  if (p.tip) await fill(caja, dialog.getByLabel("Propina", { exact: true }), String(p.tip / 100));
  if (p.method === "cash") {
    if (p.bill) {
      await tap(caja, dialog.getByRole("group", { name: "Efectivo recibido rápido" }).getByRole("button", { name: new RegExp(`^\\$${p.bill}(\\.00)?$`) }));
      await expect(dialog.locator(".row.between", { hasText: "Cambio" }).locator("strong")).toHaveText(
        mxn(p.bill * 100 - amount - (p.tip ?? 0)),
      );
    }
  } else {
    await tap(caja, dialog.getByRole("group", { name: "Método de pago" }).getByRole("button", { name: "Terminal externa", exact: true }));
    await fill(caja, dialog.getByLabel("Referencia de aprobación", { exact: true }), p.ref!);
    await tap(caja, dialog.getByRole("checkbox", { name: "Confirmo que la terminal aprobó este pago" }));
  }
  await tap(caja, dialog.getByRole("button", { name: "Confirmar cobro" }));
  const receipt = page.locator(".receipt");
  await expect(receipt).toBeVisible();
  if (!opts.last) {
    await expect(receipt).toContainText("Comprobante de pago parcial. El ticket con folio se emite al liquidar la cuenta.");
    await press(caja, page.getByRole("button", { name: "Volver", exact: true }));
    await expect(receipt).toHaveCount(0);
  } else await expect(receipt).toContainText("Folio:");
  return amount;
}

/** P-PAYB for a whole check; the last payment ends at the RC-checks. */
async function payCheck(caja: Device, c: CheckDef, opts: { afterFirst?: () => Promise<void>; checkpointId?: string } = {}) {
  await openCheck(caja, c);
  let due = FIGURES[c.id]!.total;
  for (const [i, p] of c.payments.entries()) {
    const last = i === c.payments.length - 1;
    due -= await payment(caja, c, p, due, { last, checkpointId: p.units ? opts.checkpointId : undefined });
    if (i === 0 && opts.afterFirst) await opts.afterFirst();
  }
  const payments = c.payments.map((p) =>
    p.units ? { ...p, amount: p.units.reduce((s, u) => s + unitAmount(c, u), 0) } : p,
  );
  return rcChecks(caja, r, c.id, {
    payments,
    absent: ["IVA 16%"],
  });
}

/** The unit price of a "{product} · {n}" split unit of one check. */
function unitAmount(c: CheckDef, label: string) {
  const name = label.replace(/ · \d+$/, "");
  const line = FIGURES[c.id]!.lines.find((l) => l.name === name);
  if (!line) throw Error(`unit ${label} of ${c.id}`);
  return line.unit;
}

/** "Liberar mesa" on the receipt (the table becomes Disponible). */
async function releaseFromReceipt(caja: Device, c: CheckDef) {
  const page = caja.page;
  await press(caja, page.getByRole("button", { name: "Liberar mesa", exact: true }));
  await expect(page.locator(".receipt")).toHaveCount(0);
  await toTables(caja);
  await expect(table(page, c.movedTo ?? c.table)).toContainText("Disponible");
}

export async function serviceB(dev: Devices, state: RunState) {
  const caja = await dev("cajaB");
  const sofia = await dev("sofiaB");
  const tomas = await dev("tomasB");
  const cocina = await dev("cocinaB");
  const owner = await dev("ownerB");
  const B1 = check("B1"),
    B2 = check("B2"),
    B3 = check("B3"),
    B4 = check("B4"),
    B5 = check("B5"),
    B6 = check("B6"),
    B7 = check("B7");

  // B6.1: B1 R1 on Sofía's phone.
  run.step = "B6.1";
  const cart = await round(sofia, B1, 1, { newCheck: true, send: false });
  await checkpoint(sofia, "B6-phone-cart", { settle: cart });
  await press(sofia, cart.getByRole("button", { name: "Enviar a cocina", exact: true }));
  await sent(sofia, cart);
  await press(sofia, cart.getByRole("button", { name: "Cerrar", exact: true }));
  await kitchenRound(cocina, B1, 1);

  // B6.2: B2 R1, then the transfer to Terraza 1 (Ramón only acknowledges).
  run.step = "B6.2";
  await round(tomas, B2, 1, { newCheck: true });
  const b2 = await kitchenRound(cocina, B2, 1, { progress: false });
  for (const t of Object.values(b2)) await press(cocina, t.getByRole("button", { name: "Confirmar recepción", exact: true }));
  {
    const page = tomas.page;
    await press(tomas, page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Órdenes", exact: true }));
    const card = page.locator("article.order-summary").filter({ has: page.locator(".eyebrow", { hasText: /^#2 · / }) });
    await press(tomas, card.getByRole("button", { name: "Mesa y mesero", exact: true }));
    const dialog = page.getByRole("dialog", { name: "Mesa y mesero" });
    await dialog.getByLabel(/^Seleccionar mesa/).selectOption({ label: B2.movedTo! });
    await fill(tomas, dialog.getByLabel("Explicación", { exact: true }), "Clientes pidieron terraza");
    await checkpoint(tomas, "B6-transfer", { settle: dialog });
    await press(tomas, dialog.getByRole("button", { name: "Guardar", exact: true }));
    await expect(dialog).toHaveCount(0);
    // Built: the order card shows the new table; "Asignación actualizada" is the kitchen's badge.
    await expect(card).toContainText(`${B2.movedTo} · ${staffB("tomas").name}`);
  }
  for (const station of ["Cocina", "Barra"] as const) {
    const t = kdsTicket(cocina.page, 2, station);
    await expect(t.locator(":scope > p").first()).toHaveText(`${B2.movedTo} · ${staffB("tomas").name}`, { timeout: 10_000 });
    await expect(t).toContainText("Asignación actualizada");
  }
  await toTables(caja);
  await expect(table(caja.page, "Mesa 2")).toContainText("Disponible");
  await expect(table(caja.page, "Terraza 1")).toContainText("Ocupada");

  // B6.3: B1 R2 (the Arrachera picker needs both groups).
  run.step = "B6.3";
  await round(sofia, B1, 2);
  await kitchenRound(cocina, B1, 2);
  await toTables(caja);
  await expect(table(caja.page, "Mesa 1")).toContainText("Ocupada");
  await expect(table(caja.page, "Mesa 1").getByRole("button", { name: new RegExp(`^#1 · Sin nombre · ${escapeRe(mxn(147000))} por cobrar · \\d+ min$`) })).toBeVisible();

  // B6.4: B3 with the allergy note.
  run.step = "B6.4";
  await round(sofia, B3, 1, { newCheck: true });
  const b3 = await kitchenRound(cocina, B3, 1, { progress: false });
  for (const t of Object.values(b3)) {
    await expect(t.locator(".ticket-note.allergy strong")).toHaveText("Alergia");
    await progressTicket(cocina, t);
  }

  // B6.5: B2 R2 from Terraza 1; B4 R1 and B5 R1 sent one after the other.
  run.step = "B6.5";
  await round(tomas, B2, 2, { tableName: B2.movedTo });
  await kitchenRound(cocina, B2, 2, { tableName: B2.movedTo });
  for (const t of Object.values(b2)) await progressTicket(cocina, t, "seen");
  await round(tomas, B4, 1, { newCheck: true });
  await kitchenRound(cocina, B4, 1);
  await round(sofia, B5, 1, { newCheck: true });
  await kitchenRound(cocina, B5, 1);

  // B6.6: B1 R3 after R2 was delivered (MON-2).
  run.step = "B6.6";
  await round(sofia, B1, 3);
  await kitchenRound(cocina, B1, 3);

  // B6.7: concurrent rounds that lock the same stock item (DB-5).
  run.step = "B6.7";
  {
    const d4 = await round(tomas, B4, 2, { send: false });
    const d5 = await round(sofia, B5, 2, { send: false });
    await Promise.all([
      press(tomas, d4.getByRole("button", { name: "Enviar a cocina", exact: true })),
      press(sofia, d5.getByRole("button", { name: "Enviar a cocina", exact: true })),
    ]);
    for (const [d, dialog] of [
      [tomas, d4],
      [sofia, d5],
    ] as const) {
      await sent(d, dialog);
      await expect(d.page.getByText("Otra terminal cambió lo mismo al mismo tiempo. Intenta de nuevo.")).toHaveCount(0);
      await press(d, d.page.getByRole("dialog", { name: "Orden" }).getByRole("button", { name: "Cerrar", exact: true }));
    }
    await kitchenRound(cocina, B4, 2);
    await kitchenRound(cocina, B5, 2);
  }

  // B6.8: B1 (the refund guidance before the ticket) and B2 (split by items).
  run.step = "B6.8";
  {
    const page = caja.page;
    const refunds: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && /\/refunds$/.test(new URL(req.url()).pathname)) refunds.push(req.url());
    });
    await payCheck(caja, B1, {
      afterFirst: async () => {
        await press(caja, page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Órdenes", exact: true }));
        const card = page.locator("article.order-summary").filter({ has: page.locator(".eyebrow", { hasText: /^#1 · / }) });
        await press(caja, card.getByRole("button", { name: "Reembolsar", exact: true }));
        const dialog = page.getByRole("dialog", { name: "Reembolso · Orden #1" });
        await expect(dialog.getByRole("note")).toHaveText(
          "Esta cuenta tiene saldo pendiente y aún no tiene ticket: cobra el saldo o anula las líneas en lugar de reembolsar.",
        );
        for (const absent of ["Por productos", "Por importe"]) await expect(dialog.getByRole("button", { name: absent })).toHaveCount(0);
        await expect(dialog.getByRole("group", { name: "Autorización de gerente" })).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: /^Reembolsar \$/ })).toHaveCount(0);
        await press(caja, dialog.getByRole("button", { name: "Cancelar", exact: true }));
        await openCheck(caja, B1);
      },
    });
    expect(refunds, "B6.8: no refund request leaves the page").toEqual([]);
    await releaseFromReceipt(caja, B1);
    await payCheck(caja, B2, { checkpointId: "B6-split-items" });
    await press(caja, page.getByRole("button", { name: "Siguiente venta", exact: true }));
    await toTables(caja);
    await press(caja, table(page, B2.movedTo!).getByRole("button", { name: "Liberar mesa", exact: true }));
    await expect(table(page, B2.movedTo!)).toContainText("Disponible");
  }

  // B6.9: B3 and the CFDI request (branch N: provider disabled).
  run.step = "B6.9";
  await payCheck(caja, B3, {});
  {
    const page = caja.page;
    await expect(page.locator(".receipt")).toContainText(`¿Necesitas factura? Pídela con el folio ${FIGURES.B3!.folio}.`);
    await expect(page.getByRole("button", { name: "Facturar" })).toHaveCount(0);
    await expect(page.locator(".receipt")).not.toContainText("/factura");
    await releaseFromReceipt(caja, B3);
    const op = owner.page;
    await op.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Configuración" }).click();
    const cfdi = op.locator(".cfdi-settings");
    await expect(cfdi.getByText("No disponible", { exact: true })).toBeVisible();
    // The provider note and the failed platform prerequisite (✗ …) both carry the sentence.
    await expect(cfdi.getByText("La facturación electrónica no está configurada en este entorno.")).toHaveCount(2);
    await expect(cfdi.getByRole("button", { name: "Activar en modo prueba" })).toBeDisabled();
    await expect(op.getByText("Facturación CFDI (Facturapi)", { exact: true })).toBeVisible();
    // The integration card: its heading row, then the hint below it.
    const integration = op.getByRole("heading", { name: "Facturación CFDI (Facturapi)" }).locator("xpath=../..");
    await expect(integration).toContainText("Deshabilitado");
    await expect(integration).toContainText("Requiere configuración y verificación externa.");
    const caps = await readApi(owner, "/api/capabilities");
    const facturapi = (caps.body as Array<{ key?: string; id?: string; enabled: boolean; reason?: string }>).find?.(
      (x) => x.key === "facturapi" || x.id === "facturapi",
    ) ?? (caps.body as Record<string, { enabled: boolean; reason?: string }>).facturapi;
    expect(facturapi).toMatchObject({ enabled: false, reason: "provider_not_configured" });
    await checkpoint(owner, "B6-cfdi", { settle: cfdi });
  }

  // B6.10: B4 paid and not released.
  run.step = "B6.10";
  await payCheck(caja, B4, {});
  {
    const page = caja.page;
    await press(caja, page.getByRole("button", { name: "Siguiente venta", exact: true }));
    await toTables(caja);
    await expect(table(page, "Terraza 2")).toContainText("#4 · Pagada · por liberar");
    await expect(table(page, "Terraza 2").getByRole("button", { name: "Liberar mesa", exact: true })).toBeVisible();
    await expect(table(page, "Terraza 2")).not.toContainText("Disponible");
    await checkpoint(caja, "B6-paid-not-released");
    await press(caja, page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Órdenes", exact: true }));
    const card4 = page.locator("article.order-summary").filter({ has: page.locator(".eyebrow", { hasText: /^#4 · / }) });
    await expect(card4.locator(".badges")).toContainText("Pagada · por liberar");
    await press(caja, page.getByRole("button", { name: "Abiertas", exact: true }));
    for (const n of [4, 5])
      await expect(page.locator("article.order-summary").filter({ has: page.locator(".eyebrow", { hasText: new RegExp(`^#${n} · `) }) })).toHaveCount(1);
    const op = owner.page;
    await op.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Hoy" }).click();
    await expect(op.getByText(`1 cuenta con saldo · Pendiente ${mxn(40000)}`, { exact: true })).toBeVisible();
  }

  // B6.11: B5 (two tax rates).
  run.step = "B6.11";
  await payCheck(caja, B5, {});
  await releaseFromReceipt(caja, B5);

  // B6.12: B6 releases B4 through the prompt.
  run.step = "B6.12";
  {
    const page = tomas.page;
    await toTables(tomas);
    await press(tomas, table(page, B6.table).getByRole("button", { name: "Nueva cuenta", exact: true }));
    const prompt = page.getByRole("dialog");
    await expect(prompt).toContainText("La mesa tiene cuentas pagadas sin liberar: #4.");
    await press(tomas, prompt.getByRole("button", { name: "Liberar y abrir nueva cuenta", exact: true }));
    await expect(page.getByRole("heading", { name: "Vender", level: 1 })).toBeVisible();
    for (const [i, line] of B6.rounds[0]!.lines.entries()) await addLine(tomas, r, line, i);
    await press(tomas, page.locator("button.mobile-order"));
    const dialog = page.getByRole("dialog", { name: "Orden" });
    await press(tomas, dialog.getByRole("button", { name: "Enviar a cocina", exact: true }));
    await sent(tomas, dialog);
    await press(tomas, dialog.getByRole("button", { name: "Cerrar", exact: true }));
    await kitchenRound(cocina, B6, 1);
    const cp = caja.page;
    await press(caja, cp.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Órdenes", exact: true }));
    const card4 = cp.locator("article.order-summary").filter({ has: cp.locator(".eyebrow", { hasText: /^#4 · / }) });
    await press(caja, cp.getByRole("button", { name: "Cerradas", exact: true }));
    await press(caja, card4.getByRole("button", { name: "Detalle", exact: true }));
    const detail = cp.getByRole("dialog", { name: "Orden #4" });
    await expect(detail).toContainText(/Cerrada \d{2}:\d{2} · Mesa liberada/);
    await press(caja, detail.getByRole("button", { name: "Cerrar", exact: true }));
  }
  await payCheck(caja, B6, {});
  await releaseFromReceipt(caja, B6);

  // B6.13: B7, R2 after delivery.
  run.step = "B6.13";
  await round(tomas, B7, 1, { newCheck: true });
  await kitchenRound(cocina, B7, 1);
  await round(tomas, B7, 2);
  await kitchenRound(cocina, B7, 2);
  await payCheck(caja, B7, {});
  await releaseFromReceipt(caja, B7);

  // B7.1: every table is free; nothing open.
  run.step = "B7.1";
  {
    const page = caja.page;
    await toTables(caja);
    for (const card of await page.locator("article.table-card").all()) await expect(card).toContainText("Disponible");
    await press(caja, page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Órdenes", exact: true }));
    await press(caja, page.getByRole("button", { name: "Abiertas", exact: true }));
    await expect(page.getByText("No hay cuentas abiertas.", { exact: true })).toBeVisible();
  }

  // B7.2: Karla's blind close (no difference to review).
  run.step = "B7.2";
  {
    const page = caja.page;
    const z = oracleB().corteZ;
    await press(caja, page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Caja", exact: true }));
    await press(caja, page.getByRole("button", { name: "Cerrar caja", exact: true }));
    const close = page.getByRole("dialog", { name: "Cerrar caja" });
    await expect(close).not.toContainText(z.expectedCash);
    await fill(caja, close.getByLabel("Efectivo contado", { exact: true }), pesos(r.countedCash));
    await press(caja, close.getByRole("button", { name: "Continuar", exact: true }));
    await expect(close.getByText(`¿Cerrar la caja con ${mxn(r.countedCash)} contados? Después no se puede cambiar.`)).toBeVisible();
    await press(caja, close.getByRole("button", { name: "Guardar conteo y cerrar", exact: true }));
    const result = page.getByRole("dialog", { name: "Corte registrado" });
    await press(caja, result.getByRole("button", { name: "Listo", exact: true }));
    await expect(page.getByText("Caja cerrada", { exact: true }).first()).toBeVisible();
    const op = owner.page;
    await op.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Operación" }).click();
    await op.getByRole("button", { name: "Caja", exact: true }).click();
    const history = op.locator("details.panel").filter({ has: op.locator("summary", { hasText: "Historial de cajas" }) });
    await history.locator("summary").click();
    const row = history.locator("article.panel").filter({ has: op.locator("h3", { hasText: /^Caja · / }) });
    const line = async (label: string) =>
      parseMxn((await row.locator("p", { hasText: new RegExp(`^${escapeRe(label)}: `) }).innerText()).split(": ")[1]!.replace(/^neto /, ""));
    expect(await line("Esperado al cerrar")).toBe(parseMxn(z.expectedCash));
    expect(await line("Conteo original")).toBe(r.countedCash);
    expect(await line("Diferencia original")).toBe(0);
    expect(await line("Terminal")).toBe(parseMxn(z.terminalTotal));
    await expect(row).toContainText("Corte ciego");
    await expect(row).not.toContainText("Diferencia por revisar");
    await expect(row.getByRole("button", { name: "Revisar diferencia" })).toHaveCount(0);
  }

  // B7.3: corte Z on the terminal (Ernesto, a manager) and the day on the owner's laptop.
  run.step = "B7.3";
  {
    await switchUser(caja, staffB("ernesto"));
    const page = caja.page;
    await press(caja, page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Caja", exact: true }));
    await press(caja, page.getByRole("button", { name: /corte Z/i }).first());
    const preview = page.getByRole("dialog", { name: "Vista previa" });
    const doc = preview.locator(".corte-doc");
    const z = oracleB().corteZ;
    expect({
      cashSales: await reportValue(doc, "Ventas en efectivo"),
      cashTips: await reportValue(doc, "Propinas en efectivo"),
      expected: await reportValue(doc, "Efectivo esperado"),
      counted: await reportValue(doc, "Efectivo contado"),
      terminalNet: await reportValue(doc, "Neto en terminal"),
    }).toEqual({
      cashSales: parseMxn(z.cash),
      cashTips: parseMxn(z.cashTips),
      expected: parseMxn(z.expectedCash),
      counted: parseMxn(z.countedCash),
      terminalNet: parseMxn(z.terminalTotal),
    });
    await press(caja, preview.getByRole("button", { name: "Cerrar", exact: true }));
    await expect(preview).toHaveCount(0);
    await dayFigures(owner, "B", state.businessDateB);
  }

  // B7.4 / B7.5: the register (gapless J-000001…J-000007) and global readiness (branch N).
  run.step = "B7.4";
  await registerChecks(owner, "B", state.businessDateB);
  await expect(owner.page.getByText("Ventas cobradas sin ticket")).toHaveCount(0);
  for (const d of [caja, sofia, tomas]) {
    const pending = await readApi(d, "/api/session");
    record(`${d.name} session`, 200, pending.status);
  }

  // B7.6: stock.
  run.step = "B7.6";
  await stockChecks(owner, "B");
  void receiptStrings;
  void squash;
  void B6;
}

export type { Locator };
