/**
 * Restaurant A service (specs/acceptance.md §6.10 A10): the counter day's
 * first sixteen orders through the real UI, with RC-checks, KDS-checks, voids,
 * a discount, a courtesy, an 86 and the canonical-order timing (§11).
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { mxn, oracleA } from "./oracle.js";
import { ORDERS_A, RESTAURANT_A, type OrderDef } from "./scenario.js";
import {
  FIGURES,
  addLine,
  assertCart,
  assertTabletFit,
  cartLine,
  confirmPay,
  details,
  kdsChecks,
  kdsLines,
  kdsTicket,
  nextSale,
  norm,
  payDialog,
  squash,
  productCard,
  productDef,
  progressTicket,
  rcChecks,
  type Timing,
} from "./selling.js";
import {
  advance,
  allowing,
  checkpoint,
  escapeRe,
  fill,
  nextPrint,
  parseMxn,
  prints,
  run,
  press,
  tap,
  typePin,
  type Device,
  type Devices,
  type Print,
} from "./ui.js";
import type { RunState } from "./env.js";

const r = RESTAURANT_A;
export const orderA = (id: string) => ORDERS_A.find((o) => o.id === id)!;
export const staffA = (key: string) => r.staff.find((s) => s.key === key)!;

/** The first print of each receipt (RC-check 10 compares reprints with it). */
export const firstPrint: Record<string, Print> = {};
/** §11 samples */
export const timings: Array<Timing & { kitchenMs: number; taps: Timing["taps"]; tapCount: number; bill: boolean }> = [];

/** Vender on the rail; cashiers start there after sign-in. */
export async function toSell(d: Device) {
  const page = d.page;
  const rail = page.getByRole("navigation", { name: "Operación" });
  const sell = rail.getByRole("button", { name: "Vender", exact: true });
  if (await sell.count()) await tap(d, sell);
  await expect(page.getByRole("heading", { name: "Vender", level: 1 })).toBeVisible();
}

/** The kitchen tickets of one order's first round, KDS-checked and progressed. */
async function kitchen(k: Device, o: OrderDef, progress = true, extra: Partial<Parameters<typeof kdsChecks>[1]> = {}) {
  const tickets = await kdsChecks(k, {
    number: o.number,
    callName: o.callName,
    orderNote: o.orderNote,
    lines: kdsLines(r, o.lines),
    tenant: "A",
    ...extra,
  });
  if (progress) for (const t of Object.values(tickets)) await progressTicket(k, t);
  return tickets;
}

/** P-SELL steps 1-4 for an order book entry; returns the oracle due. */
async function build(d: Device, o: OrderDef, opts: { picker?: Record<number, Parameters<typeof addLine>[4]> } = {}) {
  await toSell(d);
  for (const [i, line] of o.lines.entries()) await addLine(d, r, line, i, opts.picker?.[i] ?? {});
  await details(d, o.callName, o.orderNote);
  const due = o.lines.reduce((s, l, i) => s + (o.removed?.includes(i) ? 0 : 0) + FIGURES[o.id]!.lines[i]!.unit * l.qty, 0);
  await assertCart(d, r, o.lines, due);
  return due;
}

/** P-SELL steps 5-7: pay, RC-check, print, next sale, kitchen. */
async function payAndCheck(caja: Device, cocina: Device, o: OrderDef, due: number, opts: { hasDraftLines?: boolean; payCheckpoint?: string; receiptCheckpoint?: string; kitchen?: boolean } = {}) {
  await payDialog(caja, o.payment!, due, { hasDraftLines: opts.hasDraftLines ?? true, checkpointId: opts.payCheckpoint });
  await confirmPay(caja);
  if (opts.receiptCheckpoint) await checkpoint(caja, opts.receiptCheckpoint, { settle: caja.page.locator(".receipt") });
  firstPrint[o.id] = (await rcChecks(caja, r, o.id, { payments: [o.payment!] }))!;
  await nextSale(caja);
  if (opts.kitchen !== false) await kitchen(cocina, o);
}

/** P-SELL for one order book entry, with the hooks the later steps need. */
export async function saleA(
  caja: Device,
  cocina: Device,
  o: OrderDef,
  opts: {
    picker?: Record<number, Parameters<typeof addLine>[4]>;
    kitchen?: boolean;
    /** runs right after "Confirmar cobro" (A14.2's lost response) */
    afterConfirm?: () => Promise<void>;
  } = {},
) {
  const due = await build(caja, o, { picker: opts.picker });
  if (!opts.afterConfirm) return payAndCheck(caja, cocina, o, due, { kitchen: opts.kitchen });
  const dialog = await payDialog(caja, o.payment!, due, { hasDraftLines: true });
  await tap(caja, dialog.getByRole("button", { name: "Confirmar cobro" }));
  await opts.afterConfirm();
  await expect(caja.page.locator(".receipt")).toContainText("Folio:", { timeout: 30_000 });
  firstPrint[o.id] = (await rcChecks(caja, r, o.id, { payments: [o.payment!] }))!;
  await nextSale(caja);
  if (opts.kitchen !== false) await kitchen(cocina, o);
}

export const canonicalSale = (caja: Device, cocina: Device, o: OrderDef) => canonical(caja, cocina, o);

/** §11: the canonical order, eight (or nine) taps, each latency measured. */
async function canonical(caja: Device, cocina: Device, o: OrderDef) {
  const page = caja.page;
  const t: Timing = { order: o.id, taps: [] };
  const tapsBefore = run.taps;
  await toSell(caja);
  const tapsStart = run.taps;
  const tp = productDef(r, "TP");
  const tk = productDef(r, "TK");
  const picker = page.getByRole("dialog", { name: tp.name });
  const add = picker.getByRole("button", { name: "Agregar a la orden", exact: true });
  const total = page.locator("aside.cart .total strong");
  const sample = async (n: number, label: string, act: () => Promise<unknown>, done: () => Promise<unknown>) => {
    const start = Date.now();
    await act();
    await done();
    t.taps.push({ tap: n, label, ms: Date.now() - start });
  };
  await sample(1, tp.name, () => tap(caja, productCard(page, tp.name)), () => expect(picker).toBeVisible());
  await sample(2, "Maíz", () => tap(caja, picker.getByRole("radio", { name: /^Maíz\b/ })), async () => {
    await expect(add).toBeEnabled();
    await expect(picker.locator(".picker-price")).toHaveText("$28.00");
  });
  await sample(3, "Agregar a la orden", () => tap(caja, add), async () => {
    await expect(picker).toHaveCount(0);
    await expect(cartLine(page, 0)).toContainText(tp.name);
    await expect(cartLine(page, 0).locator(".line-option")).toHaveText(["+ Maíz"]);
    await expect(total).toHaveText("$28.00");
  });
  await sample(4, "+", () => tap(caja, cartLine(page, 0).getByRole("button", { name: `Cantidad + ${tp.name}`, exact: true })), async () => {
    await expect(cartLine(page, 0).locator(".quantity span")).toHaveText("2");
    await expect(total).toHaveText("$56.00");
  });
  await sample(5, tk.name, () => tap(caja, productCard(page, tk.name)), async () => {
    await expect(cartLine(page, 1)).toContainText(tk.name);
    await expect(total).toHaveText("$82.00");
  });
  const dialog = page.getByRole("dialog", { name: /^Cobrar/ });
  await sample(6, "Cobrar", () => tap(caja, page.getByRole("button", { name: "Cobrar", exact: true })), async () => {
    await expect(dialog.getByLabel("Importe", { exact: true })).toHaveValue("82.00");
    await expect(dialog.getByRole("button", { name: "Efectivo", exact: true })).toHaveAttribute("aria-pressed", "true");
  });
  const bill = o.payment!.bill;
  if (bill) {
    await tap(caja, dialog.getByRole("group", { name: "Efectivo recibido rápido" }).getByRole("button", { name: new RegExp(`^\\$${bill}(\\.00)?$`) }));
    await expect(dialog.locator(".row.between", { hasText: "Cambio" }).locator("strong")).toHaveText(mxn(bill * 100 - 8200));
  } else await expect(dialog.locator(".row.between", { hasText: "Cambio" }).locator("strong")).toHaveText("$0.00");
  // Two primary activations from a prepared cart to confirmation (UX-02).
  const confirmAt = Date.now();
  await sample(7, "Confirmar cobro", () => tap(caja, dialog.getByRole("button", { name: "Confirmar cobro" })), () =>
    expect(page.locator(".receipt")).toContainText("Folio:"),
  );
  const resolvedAt = Date.now();
  const tapCount = run.taps - tapsStart;
  // RC-checks read the receipt before the next sale (their print tap is not part of the budget).
  const tapsAtReceipt = run.taps;
  firstPrint[o.id] = (await rcChecks(caja, r, o.id, { payments: [o.payment!] }))!;
  const kitchenSeen = expect(kdsTicket(cocina.page, o.number, "Cocina")).toBeVisible({ timeout: 10_000 }).then(() => Date.now());
  const kitchenMs = (await kitchenSeen) - resolvedAt;
  const printTaps = run.taps - tapsAtReceipt;
  await sample(8, "Siguiente venta", () => tap(caja, page.getByRole("button", { name: "Siguiente venta", exact: true })), () =>
    expect(page.getByText("La siguiente buena orden empieza aquí.", { exact: true })).toBeVisible(),
  );
  const taps = tapCount + 1; // + Siguiente venta
  expect(taps, `${o.id}: tap budget (§11.1)`).toBe(bill ? 9 : 8);
  expect(Date.now() - confirmAt).toBeGreaterThan(0);
  expect(printTaps).toBe(1);
  void tapsBefore;
  timings.push({ ...t, kitchenMs, tapCount: taps, bill: Boolean(bill) });
  await kitchen(cocina, o);
}

/** Nearest-rank is the max for five samples; the gate uses linear interpolation. */
export function p95(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const pos = 0.95 * (s.length - 1);
  const lo = Math.floor(pos);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (pos - lo);
}

/** §11.1/§11.2 budgets over the five canonical samples. */
export function assertTimingBudgets() {
  const budget: Record<number, [number, number]> = {
    1: [300, 500],
    2: [150, 300],
    3: [300, 500],
    4: [200, 400],
    5: [300, 500],
    6: [700, 1200],
    7: [2000, 3000],
    8: [300, 500],
  };
  const rows: string[] = [];
  const problems: string[] = [];
  for (let n = 1; n <= 8; n++) {
    const ms = timings.map((t) => t.taps.find((x) => x.tap === n)!.ms);
    const [p, max] = budget[n]!;
    rows.push(`tap ${n}: ${ms.join(", ")} ms (p95 ${Math.round(p95(ms))}, max ${Math.max(...ms)})`);
    if (p95(ms) > p) problems.push(`tap ${n} p95 ${Math.round(p95(ms))} > ${p}`);
    if (Math.max(...ms) > max) problems.push(`tap ${n} max ${Math.max(...ms)} > ${max}`);
  }
  const system = timings.map((t) => t.taps.reduce((s, x) => s + x.ms, 0));
  const kitchenMs = timings.map((t) => t.kitchenMs);
  rows.push(`system: ${system.join(", ")} ms; kitchen: ${kitchenMs.join(", ")} ms`);
  if (p95(system) > 4000 || Math.max(...system) > 5000) problems.push(`system time ${system.join("/")}`);
  if (p95(kitchenMs) > 3500 || Math.max(...kitchenMs) > 5000) problems.push(`kitchen appearance ${kitchenMs.join("/")}`);
  for (const t of timings) {
    const modelled = 1.1 * t.tapCount + 1.2 + p95(system) / 1000;
    rows.push(`${t.order}: ${t.tapCount} taps, modelled ${modelled.toFixed(1)} s`);
    if (modelled > (t.bill ? 16 : 15)) problems.push(`${t.order} modelled ${modelled.toFixed(1)} s`);
  }
  return { rows, problems };
}

// ------------------------------------------------------------------ A10

/** The order card on Órdenes for #n (today: no date suffix). */
export function orderCard(page: Page, n: number) {
  return page
    .locator("article.order-summary")
    .filter({ has: page.locator(".eyebrow", { hasText: new RegExp(`^#${n} · `) }) });
}

export async function toOrders(d: Device) {
  const rail = d.page.getByRole("navigation", { name: "Operación" });
  await tap(d, rail.getByRole("button", { name: "Órdenes", exact: true }));
  await expect(d.page.locator(".orders-view")).toBeVisible();
}

/** Sends the cart without paying ("Enviar a cocina"). */
async function send(d: Device) {
  await tap(d, d.page.getByRole("button", { name: "Enviar a cocina", exact: true }));
  await expect(d.page.locator("aside.cart .existing")).toBeVisible();
}

/** The void dialog from Órdenes with a ManagerApproval (A10.8, A10.9, A10.14). */
async function voidFromOrders(
  caja: Device,
  o: OrderDef,
  v: NonNullable<OrderDef["voids"]>[number],
  opts: { returnAllowed: boolean; wrongPinFirst?: boolean; checkpointId?: string },
) {
  const page = caja.page;
  await toOrders(caja);
  await press(caja, orderCard(page, o.number).getByRole("button", { name: "Anular", exact: true }));
  const dialog = page.getByRole("dialog", { name: "Anular productos" });
  const p = productDef(r, o.lines[v.line]!.product);
  await fill(caja, dialog.getByLabel(new RegExp(`^${escapeRe(p.name)} · `)), String(v.units));
  await fill(caja, dialog.getByLabel("Motivo de la anulación", { exact: true }), v.reason);
  const back = dialog.getByRole("radio", { name: "Regresar ingredientes al inventario" });
  if (opts.returnAllowed) {
    await expect(back).toBeEnabled();
    if (v.restock) await press(caja, back);
  } else {
    await expect(back).toBeDisabled();
    await expect(dialog.getByText("Cocina ya vio este pedido; los ingredientes no regresan al inventario.", { exact: true })).toBeVisible();
    await press(caja, dialog.getByRole("radio", { name: "No regresar (ya se preparó o se desecha)" }));
  }
  const approval = dialog.getByRole("group", { name: "Autorización de gerente" });
  const marisol = staffA("marisol");
  await approval.getByLabel(/^Gerente que autoriza/).selectOption({ label: marisol.name });
  const submit = dialog.getByRole("button", { name: new RegExp(`^Anular ${v.units} productos`) });
  if (opts.wrongPinFirst) {
    await allowing([{ method: "POST", url: /\/api\/orders\/[^/]+\/voids$/, status: 403 }], async () => {
      await fill(caja, approval.getByLabel("PIN del gerente", { exact: true }), "000000");
      await press(caja, submit);
      await expect(dialog.getByRole("alert")).toHaveText("PIN de gerente incorrecto o el empleado no es gerente.");
    });
  }
  await fill(caja, approval.getByLabel("PIN del gerente", { exact: true }), marisol.pin);
  if (opts.checkpointId) await checkpoint(caja, opts.checkpointId, { settle: dialog });
  await press(caja, submit);
  await expect(dialog).toHaveCount(0);
  // Marisol's PIN authorized this command only: no session's lastAuthAt changes (§3.5.4).
}

/** The kitchen acknowledges a void ("Cancelado" → "Enterado de la cancelación"). */
async function ackVoid(cocina: Device, ticket: Locator, number: number, line: string) {
  const alert = ticket.locator(".void-alert");
  await expect(alert).toContainText("Cancelado");
  await expect(alert).toContainText(line);
  await expect(cocina.page.locator(".kds [aria-live=polite][role=status]")).toContainText(`Cancelación en ticket #${number}`);
  await press(cocina, alert.getByRole("button", { name: "Enterado de la cancelación", exact: true }));
  await expect(alert).toHaveCount(0);
}

/** Resumes an order from Órdenes ("Abrir orden") into Vender. */
async function resume(caja: Device, n: number) {
  await toOrders(caja);
  await press(caja, orderCard(caja.page, n).getByRole("button", { name: "Abrir orden", exact: true }));
  await expect(caja.page.getByRole("heading", { name: "Vender", level: 1 })).toBeVisible();
  await expect(caja.page.locator("aside.cart .existing")).toContainText(`#${n}`);
}

export async function serviceA1(dev: Devices, state: RunState) {
  const caja = await dev("cajaA");
  const cocina = await dev("cocinaA");
  const owner = await dev("ownerA");
  const diego = staffA("diego");

  // A01: first sale; "Nuevo" and the live region on the kitchen display.
  run.step = "A10.1";
  {
    const o = orderA("A01");
    await toSell(caja);
    await addLine(caja, r, o.lines[0]!, 0);
    await addLine(caja, r, o.lines[1]!, 1, { checkpointId: "A10-picker" });
    await details(caja, o.callName, o.orderNote);
    const due = FIGURES[o.id]!.total;
    await assertCart(caja, r, o.lines, due);
    await assertTabletFit(caja);
    await checkpoint(caja, "A10-selling");
    await payAndCheck(caja, cocina, o, due, { payCheckpoint: "A10-pay-cash", receiptCheckpoint: "A10-receipt", kitchen: false });
    const tickets = await kitchen(cocina, o, false);
    for (const t of Object.values(tickets)) await expect(t.locator(".ticket-badges")).toContainText("Nuevo");
    await expect(cocina.page.locator(".kds [aria-live=polite][role=status]")).toContainText("Nuevo ticket #1, ronda 1");
    await checkpoint(cocina, "A10-kds");
    for (const t of Object.values(tickets)) await progressTicket(cocina, t);
  }
  // A02: card with tip.
  run.step = "A10.2";
  {
    const o = orderA("A02");
    const due = await build(caja, o);
    await payAndCheck(caja, cocina, o, due, { payCheckpoint: "A10-pay-card" });
  }
  // A03: canonical #1 (FOH-3: the dialog opens fresh after A02's card payment).
  run.step = "A10.3";
  await canonical(caja, cocina, orderA("A03"));
  // A04: allergy note on both station tickets.
  run.step = "A10.4";
  {
    const o = orderA("A04");
    const due = await build(caja, o);
    await payAndCheck(caja, cocina, o, due, { kitchen: false });
    const tickets = await kitchen(cocina, o, false);
    for (const t of Object.values(tickets)) {
      await expect(t.locator(".ticket-note.allergy")).toBeVisible();
      await expect(t.locator(".ticket-note.allergy strong")).toHaveText("Alergia");
    }
    for (const t of Object.values(tickets)) await progressTicket(cocina, t);
  }
  // A05: combo with repeat steppers, live price $101.00.
  run.step = "A10.5";
  {
    const o = orderA("A05");
    const due = await build(caja, o, { picker: { 0: { livePrice: 10100 } } });
    await payAndCheck(caja, cocina, o, due);
  }
  // A06: open price; 350.00 is refused first.
  run.step = "A10.6";
  {
    const o = orderA("A06");
    const due = await build(caja, o, { picker: { 0: { refuseOpen: 35000 } } });
    await payAndCheck(caja, cocina, o, due);
  }
  run.step = "A10.7";
  await canonical(caja, cocina, orderA("A07"));
  // A08: sent unpaid; void 1 × TS before the kitchen acknowledges, stock returned; one wrong manager PIN.
  run.step = "A10.8";
  {
    const o = orderA("A08");
    await build(caja, o);
    await send(caja);
    const tickets = await kitchen(cocina, o, false);
    await voidFromOrders(caja, o, o.voids![0]!, { returnAllowed: true, wrongPinFirst: true });
    const card = orderCard(caja.page, o.number);
    await expect(card).toContainText("Cocina aún no confirma");
    await ackVoid(cocina, tickets.Cocina!, o.number, `1 × ${productDef(r, "TS").name}`);
    await expect(tickets.Cocina!.locator(".ticket-lines > div.voided, .ticket-lines s").first()).toBeVisible();
    await progressTicket(cocina, tickets.Cocina!);
    await resume(caja, o.number);
    await payAndCheck(caja, cocina, o, FIGURES[o.id]!.total, { hasDraftLines: false, kitchen: false });
  }
  // A09: the kitchen confirms; the void returns nothing.
  run.step = "A10.9";
  {
    const o = orderA("A09");
    await build(caja, o);
    await send(caja);
    const tickets = await kitchen(cocina, o, false);
    await press(cocina, tickets.Cocina!.getByRole("button", { name: "Confirmar recepción", exact: true }));
    await expect(tickets.Cocina!).toContainText("Cocina recibió");
    await voidFromOrders(caja, o, o.voids![0]!, { returnAllowed: false, checkpointId: "A10-void" });
    await ackVoid(cocina, tickets.Cocina!, o.number, `1 × ${productDef(r, "GR").name}`);
    await progressTicket(cocina, tickets.Cocina!, "seen");
    await progressTicket(cocina, tickets.Barra!);
    await resume(caja, o.number);
    await payAndCheck(caja, cocina, o, FIGURES[o.id]!.total, { hasDraftLines: false, kitchen: false });
  }
  // A10: 10% on the whole check, Marisol approves; one PIN, no step-up (LD-2).
  run.step = "A10.10";
  {
    const o = orderA("A10");
    await build(caja, o);
    await discountFlow(caja, o, "A10-discount");
    const f = FIGURES[o.id]!;
    await expect(caja.page.locator("aside.cart .total strong")).toHaveText(mxn(f.total));
    await toOrders(caja);
    await expect(orderCard(caja.page, o.number).locator(".badges")).toContainText(`Descuento −${mxn(1820)}`);
    await resume(caja, o.number);
    const tickets = await kitchen(cocina, o, false);
    await payAndCheck(caja, cocina, o, f.total, {
      hasDraftLines: false,
      kitchen: false,
    });
    for (const t of Object.values(tickets)) await progressTicket(cocina, t);
  }
  run.step = "A10.11";
  await canonical(caja, cocina, orderA("A11"));
  // A12: a courtesy on the Agua fresca line.
  run.step = "A10.12";
  {
    const o = orderA("A12");
    await build(caja, o);
    await courtesyFlow(caja, o);
    const tickets = await kitchen(cocina, o, false);
    await expect(tickets.Barra!).toBeVisible();
    await payAndCheck(caja, cocina, o, FIGURES[o.id]!.total, { hasDraftLines: false, kitchen: false });
    for (const t of Object.values(tickets)) await progressTicket(cocina, t);
  }
  // A13: Taco de suadero is 86'd mid-draft.
  run.step = "A10.13";
  await eightySix(caja, cocina, owner, orderA("A13"));
  // A14: sent, then fully voided before the kitchen sees it; no folio.
  run.step = "A10.14";
  {
    const o = orderA("A14");
    await build(caja, o);
    await send(caja);
    const tickets = await kitchen(cocina, o, false);
    await voidFromOrders(caja, o, o.voids![0]!, { returnAllowed: true });
    const card = orderCard(caja.page, o.number);
    await expect(card.locator(".badges")).toContainText("Anulada");
    for (const b of ["Abrir orden", "Anular", "Reembolsar", "Cobrar"])
      await expect(card.getByRole("button", { name: b, exact: true })).toHaveCount(0);
    await press(caja, card.getByRole("button", { name: "Detalle", exact: true }));
    const detail = caja.page.getByRole("dialog", { name: `Orden #${o.number}` });
    await expect(detail).toContainText(/Cerrada \d{2}:\d{2} · Anulada/);
    await press(caja, detail.getByRole("button", { name: "Cerrar", exact: true }));
    await ackVoid(cocina, tickets.Cocina!, o.number, `1 × ${productDef(r, "GR").name}`);
    await expect(tickets.Cocina!).toHaveCount(0);
  }
  run.step = "A10.15";
  {
    const o = orderA("A15");
    const due = await build(caja, o);
    await payAndCheck(caja, cocina, o, due);
  }
  run.step = "A10.16";
  await canonical(caja, cocina, orderA("A16"));
  void diego;
  void state;
}

/** A10.10: "Descuento" from the cart sends first, then a 10% check discount with Marisol's PIN. */
async function discountFlow(caja: Device, o: OrderDef, checkpointId: string) {
  const page = caja.page;
  const marisol = staffA("marisol");
  await press(caja, page.locator("aside.cart").getByRole("button", { name: "Descuento", exact: true }));
  const first = page.getByRole("dialog", { name: "Enviar productos primero" });
  await press(caja, first.getByRole("button", { name: "Enviar y continuar", exact: true }));
  const dialog = page.getByRole("dialog", { name: `Descuento · Orden #${o.number}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Toda la cuenta" })).toBeChecked();
  await expect(dialog.getByRole("group", { name: "Tipo" }).getByRole("button", { name: "Porcentaje", exact: true })).toHaveAttribute("aria-pressed", "true");
  await press(caja, dialog.getByRole("button", { name: "10 %", exact: true }));
  await dialog.getByLabel(/^Motivo/).selectOption({ label: o.discountBps!.reasonLabel });
  const preview = dialog.locator(".discount-preview");
  await expect(preview.locator("strong")).toHaveText(`Descuento: −${mxn(1820)} · Saldo nuevo: ${mxn(16380)}`);
  await expect(preview.locator("small")).toHaveText(`10 % de ${mxn(18200)} pendiente`);
  await expect(dialog.getByText("Este descuento supera tu límite. Un gerente debe autorizarlo.", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^Descuentos sin autorización en esta cuenta/)).toHaveCount(0);
  const approval = dialog.getByRole("group", { name: "Autorización de gerente" });
  await approval.getByLabel(/^Gerente que autoriza/).selectOption({ label: marisol.name });
  await fill(caja, approval.getByLabel("PIN del gerente", { exact: true }), marisol.pin);
  await checkpoint(caja, checkpointId, { settle: dialog });
  const posts: string[] = [];
  const listener = (req: import("@playwright/test").Request) => {
    if (req.method() === "POST" && /\/api\/orders\/[^/]+\/discounts$/.test(new URL(req.url()).pathname)) posts.push(req.url());
  };
  page.on("request", listener);
  await press(caja, dialog.getByRole("button", { name: `Aplicar descuento −${mxn(1820)}`, exact: true }));
  await expect(dialog).toHaveCount(0);
  // One PIN (LD-2): Diego last authenticated at A8.5, yet no step-up dialog appears.
  await expect(page.getByRole("dialog", { name: "Confirma con tu PIN" })).toHaveCount(0);
  page.off("request", listener);
  expect(posts, "A10.10: a single POST …/discounts").toHaveLength(1);
}

/** A10.12: a 100% courtesy on one line, Marisol approves (no step-up). */
async function courtesyFlow(caja: Device, o: OrderDef) {
  const page = caja.page;
  const marisol = staffA("marisol");
  await press(caja, page.locator("aside.cart").getByRole("button", { name: "Descuento", exact: true }));
  const first = page.getByRole("dialog", { name: "Enviar productos primero" });
  await press(caja, first.getByRole("button", { name: "Enviar y continuar", exact: true }));
  const dialog = page.getByRole("dialog", { name: `Descuento · Orden #${o.number}` });
  await press(caja, dialog.getByRole("radio", { name: "Un producto" }));
  await dialog.getByLabel(/^Producto/).selectOption({ label: `1 × Agua fresca (Jamaica, Grande) · ${mxn(4500)} pendiente` });
  await press(caja, dialog.getByRole("group", { name: "Tipo" }).getByRole("button", { name: "Cortesía (100%)", exact: true }));
  await expect(dialog.getByLabel(/^Cantidad/)).toHaveValue("1");
  await expect(dialog.getByText("1 pieza sin cobrar", { exact: true })).toBeVisible();
  await dialog.getByLabel(/^Motivo/).selectOption({ label: o.courtesy!.reasonLabel });
  await fill(caja, dialog.getByLabel(/^Nota/), o.courtesy!.note);
  const approval = dialog.getByRole("group", { name: "Autorización de gerente" });
  await approval.getByLabel(/^Gerente que autoriza/).selectOption({ label: marisol.name });
  await fill(caja, approval.getByLabel("PIN del gerente", { exact: true }), marisol.pin);
  await press(caja, dialog.getByRole("button", { name: `Aplicar descuento −${mxn(4500)}`, exact: true }));
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Confirma con tu PIN" })).toHaveCount(0);
  await expect(page.locator("aside.cart .total strong")).toHaveText(mxn(6000));
  // Built: the check summary names the comped line ("Cortesía · Agua fresca (Jamaica, Grande) −$45.00").
  await expect(page.locator("aside.cart .existing")).toContainText(`Cortesía · Agua fresca (Jamaica, Grande)−${mxn(4500)}`);
}

/** A10.13: an 86 mid-draft blocks the line until it is removed. */
async function eightySix(caja: Device, cocina: Device, owner: Device, o: OrderDef) {
  const page = caja.page;
  const ts = productDef(r, "TS");
  await toSell(caja);
  for (const [i, line] of o.lines.entries()) await addLine(caja, r, line, i);
  await details(caja, o.callName);
  // The owner marks Taco de suadero unavailable.
  const op = owner.page;
  await op.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Menú e inventario" }).click();
  await op.getByRole("navigation", { name: "Menú e inventario" }).getByRole("button", { name: "Menú", exact: true }).click();
  await op.getByRole("tab", { name: "Productos" }).click();
  await op.getByRole("switch", { name: `Disponible: ${ts.name}` }).click();
  await expect(op.getByRole("status").filter({ hasText: "Cambios guardados" })).toBeVisible();
  await expect(op.getByRole("switch", { name: `Disponible: ${ts.name}` })).not.toBeChecked();
  // The menu revision poll refetches within 60 s (one poll period of device time;
  // a second period only if the first poll ran before the owner's save landed).
  const blocked = page.locator("aside.cart .order-line.line-error");
  for (let period = 0; period < 2 && !(await blocked.count()); period++) {
    await advance(caja, 61_000);
    await caja.context.clock.setSystemTime(Date.now() + caja.skew);
    await blocked.waitFor({ timeout: 15_000 }).catch(() => {});
  }
  await expect(blocked).toContainText(ts.name);
  await expect(blocked.getByRole("alert")).toHaveText("No disponible. Quítalo para continuar.");
  await expect(page.locator("aside.cart").getByText("Quita los productos no disponibles para enviar o cobrar.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enviar a cocina", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cobrar", exact: true })).toBeDisabled();
  await expect(page.locator("aside.cart .total strong")).toHaveText(mxn(5600));
  await expect(productCard(page, ts.name)).toBeDisabled();
  await expect(productCard(page, ts.name)).toContainText("Agotado");
  await checkpoint(caja, "A10-86");
  // The combo still offers Suadero (an option, not the product).
  await tap(caja, productCard(page, productDef(r, "CP").name));
  const picker = page.getByRole("dialog", { name: productDef(r, "CP").name });
  await expect(picker.getByRole("button", { name: "Agregar Suadero", exact: true })).toBeEnabled();
  await tap(caja, picker.getByRole("button", { name: "Cerrar", exact: true }));
  await tap(caja, blocked.getByRole("button", { name: "Quitar", exact: true }));
  const lines = o.lines.filter((_, i) => !o.removed?.includes(i));
  await assertCart(caja, r, lines, FIGURES[o.id]!.total);
  await payAndCheck(caja, cocina, { ...o, lines }, FIGURES[o.id]!.total);
  run.lastAuthAt = { ...run.lastAuthAt };
}

export { norm, typePin };

// ------------------------------------------------------------- A11 / A12

/** A row of a printed or previewed document (DocRow): its amount by its exact label (§5.3). */
export function docRow(scope: Locator, label: string | RegExp) {
  const page = scope.page();
  return scope
    .locator(".doc-row")
    .filter({
      has: page.locator(".doc-label", {
        hasText: typeof label === "string" ? new RegExp(`^${escapeRe(label)}$`) : label,
      }),
    })
    .locator(".doc-amount");
}

/** reportValue (§5.3): a missing row fails; the amount is parsed to centavos. */
export async function reportValue(scope: Locator, label: string | RegExp) {
  const cell = docRow(scope, label);
  await expect(cell, `row "${label}"`).toHaveCount(1);
  return parseMxn(await cell.innerText());
}

/** "Bloquear pantalla" → "Cambiar de usuario" → name → PIN (quick switch). */
export async function switchUser(d: Device, to: { name: string; pin: string }, opts: { lockedAlready?: boolean } = {}) {
  const page = d.page;
  if (!opts.lockedAlready) await press(d, page.getByRole("button", { name: "Bloquear pantalla", exact: true }));
  const lock = page.locator("dialog.lock-screen");
  await expect(lock.getByRole("heading", { name: "Pantalla bloqueada" })).toBeVisible();
  await press(d, lock.getByRole("button", { name: "Cambiar de usuario", exact: true }));
  await press(d, lock.locator(".roster-person").filter({ hasText: to.name }));
  await typePin(d, lock, to.name, to.pin);
  await expect(lock).toHaveCount(0);
  run.lastAuthAt[`${to.name}@${d.name}`] = Date.now();
}

/** §3.5.5 idle oracle for cajaA while "Bloqueo automático" is 1 min. */
export async function idleOracle(d: Device, current: { name: string; pin: string }) {
  if (!idleLockOn) return;
  const lock = d.page.locator("dialog.lock-screen");
  const idle = Date.now() - d.lastInputAt;
  if (idle < 45_000) {
    await expect(lock).toHaveCount(0);
    return;
  }
  if (idle < 71_000)
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, d.lastInputAt + 71_000 - Date.now())));
  await expect(lock.getByRole("heading", { name: "Pantalla bloqueada" })).toBeVisible({ timeout: 15_000 });
  await typePin(d, lock, current.name, current.pin);
  await expect(lock).toHaveCount(0);
  run.lastAuthAt[`${current.name}@${d.name}`] = Date.now();
}
export let idleLockOn = false;
export function setIdleLock(on: boolean) {
  idleLockOn = on;
}

/** Operación → Caja on a terminal. */
export async function toCash(d: Device) {
  await press(d, d.page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Caja", exact: true }));
}

/** A11.3 / A14.1: the owner sets Caja 1's "Bloqueo automático". */
export async function setAutoLock(owner: Device, device: string, choice: "1 min" | "Nunca") {
  const page = owner.page;
  await page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Configuración" }).click();
  const list = page.getByRole("region", { name: "Dispositivos" });
  await list.getByRole("button", { name: `Editar · ${device}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Editar «${device}»` });
  await dialog.getByLabel(/^Bloqueo automático/).selectOption({ label: choice });
  await dialog.getByRole("button", { name: "Guardar cambios", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Cambios guardados" })).toBeVisible();
}

export async function serviceA2(dev: Devices) {
  const caja = await dev("cajaA");
  const cocina = await dev("cocinaA");
  const owner = await dev("ownerA");
  const marisol = staffA("marisol");
  const diego = staffA("diego");
  const paola = staffA("paola");
  // A11.1: Marisol switches in.
  run.step = "A11.1";
  await switchUser(caja, marisol);
  // A11.2: corte X is a read-only partial reading (§6.13, labels bound to reports 029).
  run.step = "A11.2";
  await toCash(caja);
  await expect(caja.page.getByText("Caja abierta", { exact: true }).first()).toBeVisible();
  await press(caja, caja.page.getByRole("button", { name: "Corte X", exact: true }));
  const preview = caja.page.getByRole("dialog", { name: "Vista previa" });
  const doc = preview.locator(".corte-doc");
  await expect(doc).toContainText("CORTE X · LECTURA PARCIAL");
  const x = expectedCorteX();
  const read = {
    opening: await reportValue(doc, "Fondo inicial"),
    cashSales: await reportValue(doc, "Ventas en efectivo"),
    cashTips: await reportValue(doc, "Propinas en efectivo"),
    cashRefunds: await reportValue(doc, "Reembolsos en efectivo"),
    expected: await reportValue(doc, "Efectivo esperado"),
    terminalSales: await reportValue(doc, /^Cobros con terminal \(\d+\)$/),
    terminalTips: await reportValue(doc, "Propinas con terminal"),
    terminalNet: await reportValue(doc, "Neto en terminal"),
  };
  expect(read).toEqual(x);
  await expect(doc).toContainText("Folios A-000001 a A-000015 (15 tickets)");
  await expect(doc).toContainText("Lectura parcial: la caja sigue abierta.");
  await checkpoint(caja, "A11-cortex", { settle: preview });
  const before = (await prints(caja.page)).length;
  await press(caja, preview.getByRole("button", { name: "Imprimir", exact: true }));
  const printed = squash((await nextPrint(caja.page, before, "corte-x")).text);
  for (const amount of [x.opening, x.cashSales, x.cashTips, x.expected, x.terminalSales, x.terminalTips, x.terminalNet])
    expect(printed).toContain(squash(mxn(amount)));
  await press(caja, preview.getByRole("button", { name: "Cerrar", exact: true }));
  await expect(preview).toHaveCount(0);
  await expect(caja.page.getByText("Caja abierta", { exact: true }).first()).toBeVisible();
  // A11.3 / A11.4: Caja 1 locks after 1 min from Diego's next session.
  run.step = "A11.3";
  await setAutoLock(owner, "Caja 1", "1 min");
  run.step = "A11.4";
  await switchUser(caja, diego);
  setIdleLock(true);
  // A12.1: Diego's draft (A18), not sent.
  run.step = "A12.1";
  const a18 = orderA("A18");
  await toSell(caja);
  for (const [i, line] of a18.lines.entries()) await addLine(caja, r, line, i);
  await details(caja, a18.callName);
  // A12.2: one minute idle locks the screen; the cart stays mounted underneath.
  run.step = "A12.2";
  await advance(caja, 61_000);
  await caja.context.clock.setSystemTime(Date.now() + caja.skew);
  const lock = caja.page.locator("dialog.lock-screen");
  await expect(lock.getByRole("heading", { name: "Pantalla bloqueada" })).toBeVisible({ timeout: 15_000 });
  expect(await lock.evaluate((d: HTMLDialogElement) => d.matches(":modal"))).toBe(true);
  await expect(caja.page.locator("aside.cart .order-line")).toHaveCount(2);
  await focusTrapped(caja, lock);
  await checkpoint(caja, "A12-lock", { settle: lock });
  // A12.3: Paola's workspace is fresh.
  run.step = "A12.3";
  await switchUser(caja, paola, { lockedAlready: true });
  await toSell(caja);
  await expect(caja.page.getByText("La siguiente buena orden empieza aquí.", { exact: true })).toBeVisible();
  // A12.4: Paola rings A17.
  run.step = "A12.4";
  await idleOracle(caja, paola);
  {
    const o = orderA("A17");
    const due = await build(caja, o);
    await payAndCheck(caja, cocina, o, due);
  }
  // A12.5: back to Diego; his draft is restored and paid.
  run.step = "A12.5";
  await idleOracle(caja, paola);
  await switchUser(caja, diego);
  await toSell(caja);
  await assertCart(caja, r, a18.lines, FIGURES.A18!.total);
  await payAndCheck(caja, cocina, a18, FIGURES.A18!.total);
  // A12.6: PIN rate (§3.8).
  const now = Date.now();
  expect(run.pinLedger.filter((t) => now - t < 60_000).length).toBeLessThanOrEqual(20);
}

/** The corte X figures (§6.13) from the oracle's tickets #1-#16. */
function expectedCorteX() {
  const x = oracleA().corteX;
  const terminal = ORDERS_A.filter((o) => o.number <= 16 && o.payment?.method === "external");
  const sales = terminal.reduce((s, o) => s + FIGURES[o.id]!.total, 0);
  const tips = terminal.reduce((s, o) => s + (o.payment!.tip ?? 0), 0);
  return {
    opening: parseMxn(x.opening),
    cashSales: parseMxn(x.cash),
    cashTips: parseMxn(x.cashTips),
    cashRefunds: 0,
    expected: parseMxn(x.expectedCash),
    terminalSales: sales,
    terminalTips: tips,
    terminalNet: sales + tips,
  };
}

/** access §1.8: Tab ten times never leaves the dialog. */
export async function focusTrapped(d: Device, dialog: Locator) {
  for (let i = 0; i < 10; i++) {
    await d.page.keyboard.press("Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  d.lastInputAt = Date.now();
}
