/**
 * Restaurant-day selling procedures (specs/acceptance.md §6.7-§6.9, §7.6):
 * P-SELL (lines, details, cart, payment), RC-checks on the receipt and its
 * print, and KDS-checks on the kitchen display. Every expected amount comes
 * from the independent oracle (§5); nothing here imports the application.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { change, mxn, ticketFigures, unitPrice } from "./oracle.js";
import {
  RESTAURANT_A,
  RESTAURANT_B,
  type GroupDef,
  type Line,
  type Payment,
  type ProductDef,
} from "./scenario.js";
import {
  checkpoint,
  escapeRe,
  fill,
  nextPrint,
  press,
  prints,
  record,
  run,
  tap,
  type Device,
  type Print,
} from "./ui.js";

export type Restaurant = typeof RESTAURANT_A | typeof RESTAURANT_B;
export const FIGURES = ticketFigures();

/** Collapses whitespace so row texts ("Total\n$82.00") compare as "Total $82.00". */
export const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** Print captures: compared without any whitespace (see rcChecks). */
export const squash = (s: string) => s.replace(/\s+/g, "");

export function productDef(r: Restaurant, id: string): ProductDef {
  const p = (r.products as ProductDef[]).find((x) => x.id === id);
  if (!p) throw Error(`unknown product ${id}`);
  return p;
}
export function groupDef(r: Restaurant, id: string): GroupDef {
  return (r.groups as GroupDef[]).find((g) => g.id === id)!;
}
export const pesos = (centavos: number) => (centavos / 100).toFixed(2);

/** A product card in Vender (its accessible name starts with the category). */
export function productCard(page: Page, name: string) {
  return page
    .locator("button.product")
    .filter({ has: page.locator("strong", { hasText: new RegExp(`^${escapeRe(name)}$`) }) });
}

/** The cart panel: the aside on a tablet, the "Ver orden" dialog on a phone. */
export function cart(page: Page): Locator {
  return page.locator("aside.cart:visible, dialog[open] .cart-heading ~ *").first().locator("xpath=ancestor-or-self::*[self::aside or self::dialog][1]");
}

/** Splits a line's option names (group order) into the product's groups. */
export function picksByGroup(r: Restaurant, p: ProductDef, options: string[] = []) {
  const left = [...options];
  return p.groups.map((gid) => {
    const g = groupDef(r, gid);
    const picks: string[] = [];
    while (left.length && g.options.some((o) => o.name === left[0])) picks.push(left.shift()!);
    return { g, picks };
  });
}

/** The option rows the receipt and KDS show: a repeat group prints "2× Pastor". */
export function optionLabels(r: Restaurant, p: ProductDef, options: string[] = []) {
  const out: string[] = [];
  for (const { g, picks } of picksByGroup(r, p, options)) {
    if (!g.repeat) {
      out.push(...picks);
      continue;
    }
    const counts = new Map<string, number>();
    for (const name of picks) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const [name, n] of counts) out.push(n > 1 ? `${n}× ${name}` : name);
  }
  return out;
}

export type PickOptions = {
  /** A06: type this open amount first and expect the maximum refusal */
  refuseOpen?: number;
  /** A10.5 / A14.7: the live price after the picks */
  livePrice?: number;
  /** checkpoint id with the picker open and a required group pending */
  checkpointId?: string;
  /** timing hook for the canonical order (§11) */
  timed?: Timing;
};

/** §11.1 latency samples for one canonical order. */
export type Timing = { order: string; taps: Array<{ tap: number; label: string; ms: number }> };
async function timed<T>(t: Timing | undefined, n: number, label: string, act: () => Promise<unknown>, done: () => Promise<T>) {
  const start = Date.now();
  await act();
  const value = await done();
  if (t) t.taps.push({ tap: n, label, ms: Date.now() - start });
  return value;
}

/** P-SELL step 2: one line into the cart (picker, quantity, note). */
export async function addLine(d: Device, r: Restaurant, line: Line, index: number, o: PickOptions = {}) {
  const page = d.page;
  const p = productDef(r, line.product);
  const card = productCard(page, p.name);
  const needsPicker = p.groups.length > 0 || p.price === null;
  const picker = page.getByRole("dialog", { name: p.name });
  await timed(o.timed, 1, p.name, () => tap(d, card), async () => {
    if (needsPicker) await expect(picker).toBeVisible();
  });
  if (needsPicker) {
    const add = picker.getByRole("button", { name: "Agregar a la orden", exact: true });
    const required = p.groups.map((gid) => groupDef(r, gid)).filter((g) => g.min > 0);
    if (required.length || p.price === null) {
      if (required.length)
        await expect(picker.getByRole("alert")).toHaveText(`Falta elegir: ${required.map((g) => g.name).join(", ")}`);
      await expect(add).toBeDisabled();
    }
    if (o.checkpointId) await checkpoint(d, o.checkpointId, { settle: picker });
    if (p.price === null) {
      await expect(picker.getByText(`Máximo ${mxn(p.openMax!)}`, { exact: true })).toBeVisible();
      const amount = picker.getByLabel("Importe", { exact: true });
      if (o.refuseOpen) {
        await fill(d, amount, pesos(o.refuseOpen));
        await expect(picker.getByRole("alert")).toHaveText("El importe supera el máximo");
        await expect(add).toBeDisabled();
      }
      await fill(d, amount, pesos(line.open!));
    }
    let tapNo = 2;
    for (const { g, picks } of picksByGroup(r, p, line.options)) {
      const group = picker.locator("fieldset.picker-group").filter({
        has: page.locator("legend", { hasText: new RegExp(`^${escapeRe(g.name)} · `) }),
      });
      for (const name of picks) {
        const target = g.repeat
          ? group.getByRole("button", { name: `Agregar ${name}`, exact: true })
          : group.getByRole(g.min === 1 && g.max === 1 ? "radio" : "checkbox", { name: new RegExp(`^${escapeRe(name)}\\b`) });
        await timed(o.timed, tapNo++, name, () => tap(d, target), async () => {
          if (o.timed) {
            await expect(add).toBeEnabled();
            await expect(picker.locator(".picker-price")).toHaveText(mxn(unitPrice(r, line)));
          }
        });
      }
      if (g.repeat) {
        await expect(group.locator(".picker-progress")).toHaveText(`${g.max} de ${g.max}`);
        for (const opt of g.options)
          await expect(group.getByRole("button", { name: `Agregar ${opt.name}`, exact: true })).toBeDisabled();
      }
    }
    await expect(add).toBeEnabled();
    await expect(picker.locator(".picker-price")).toHaveText(mxn(o.livePrice ?? unitPrice(r, line)));
    await timed(o.timed, 3, "Agregar a la orden", () => tap(d, add), async () => {
      await expect(picker).toHaveCount(0);
      if (o.timed) await expect(cartLine(page, index)).toContainText(p.name);
    });
  }
  const row = cartLine(page, index);
  await expect(row.locator("strong").first()).toHaveText(p.name);
  for (let q = 1; q < line.qty; q++) {
    await timed(o.timed, 4, "+", () => tap(d, row.getByRole("button", { name: `Cantidad + ${p.name}`, exact: true })), async () => {
      await expect(row.locator(".quantity span")).toHaveText(String(q + 1));
    });
  }
  if (line.note) {
    await tap(d, row.getByRole("button", { name: `Nota para ${p.name}`, exact: true }));
    const presets = ["Sin cebolla", "Sin chile", "Sin cilantro", "Salsa aparte"];
    if (presets.includes(line.note)) {
      await tap(d, row.getByRole("button", { name: line.note, exact: true }));
      await tap(d, row.getByRole("button", { name: "Listo", exact: true }));
    } else {
      // Typing scrolls the note box into view; "Listo" may then sit below it.
      await fill(d, row.getByLabel("Nota para cocina", { exact: true }), line.note);
      await press(d, row.getByRole("button", { name: "Listo", exact: true }));
    }
    await expect(row.locator(".line-note")).toHaveText(line.note);
  }
}

/** The index-th line of the visible cart. */
export function cartLine(page: Page, index: number) {
  return page.locator("aside.cart .order-line, dialog[open] .order-line").nth(index);
}

/** P-SELL step 3: call name and order note through "Detalles" (compact layout). */
export async function details(d: Device, callName?: string, orderNote?: string) {
  if (!callName && !orderNote) return;
  const page = d.page;
  await tap(d, page.getByRole("button", { name: /^Detalles/ }));
  const dialog = page.getByRole("dialog", { name: "Detalles de la orden" });
  if (callName) await fill(d, dialog.getByLabel("Nombre para llamar", { exact: true }), callName);
  if (orderNote) await fill(d, dialog.getByLabel("Nota de la orden (cocina)", { exact: true }), orderNote);
  await tap(d, dialog.getByRole("button", { name: "Listo", exact: true }));
  await expect(dialog).toHaveCount(0);
}

/** P-SELL step 4: each line, its options and note, and the totals equal the oracle. */
export async function assertCart(d: Device, r: Restaurant, lines: Line[], due: number) {
  const page = d.page;
  for (const [i, line] of lines.entries()) {
    const p = productDef(r, line.product);
    const row = cartLine(page, i);
    await expect(row.locator("strong").first()).toHaveText(p.name);
    await expect(row.locator(".line-option")).toHaveText(optionLabels(r, p, line.options).map((n) => `+ ${n}`));
    if (line.note) await expect(row.locator(".line-note")).toHaveText(line.note);
    await expect(row.locator(":scope > strong")).toHaveText(mxn(unitPrice(r, line) * line.qty));
  }
  await expect(page.locator("aside.cart .order-line, dialog[open] .order-line")).toHaveCount(lines.length);
  await expect(page.locator("aside.cart .total strong, dialog[open] .total strong").first()).toHaveText(mxn(due));
}

/** G2.4 (FOH-10): every line of a 3-line cart, Enviar and Cobrar fit a 1024×768 tablet. */
export async function assertTabletFit(d: Device) {
  const page = d.page;
  for (const row of await page.locator("aside.cart .order-line").all()) await expect(row).toBeInViewport();
  await expect(page.getByRole("button", { name: "Enviar a cocina", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Cobrar", exact: true })).toBeInViewport();
}

export type PayOptions = {
  hasDraftLines?: boolean;
  /** the amount for a partial payment (B), centavos */
  amount?: number;
  checkpointId?: string;
  timed?: Timing;
  /** stop before "Confirmar cobro" (lost-response route set by the caller) */
  confirm?: boolean;
};

/** P-SELL step 5: the payment dialog (FOH-3 fresh state) and the method's fields. */
export async function payDialog(d: Device, payment: Payment, due: number, o: PayOptions = {}) {
  const page = d.page;
  const dialog = page.getByRole("dialog", { name: /^Cobrar/ });
  await timed(o.timed, 6, "Cobrar", () => tap(d, page.getByRole("button", { name: "Cobrar", exact: true })), async () => {
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Importe", { exact: true })).toHaveValue(pesos(o.amount ?? due));
  });
  // FOH-3: every dialog opens fresh.
  const methods = dialog.getByRole("group", { name: "Método de pago" });
  await expect(methods.getByRole("button", { name: "Efectivo", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(methods.getByRole("button", { name: "Terminal externa", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.getByLabel("Propina", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Referencia de aprobación", { exact: true })).toHaveCount(0);
  if (o.hasDraftLines)
    await expect(dialog.getByText("Al confirmar, los productos nuevos se enviarán a cocina.", { exact: true })).toBeVisible();
  if (o.amount !== undefined && o.amount !== due) await fill(d, dialog.getByLabel("Importe", { exact: true }), pesos(o.amount));
  const amount = o.amount ?? payment.amount ?? due;
  if (payment.tip) await fill(d, dialog.getByLabel("Propina", { exact: true }), String(payment.tip / 100));
  if (payment.method === "cash") {
    if (payment.bill) {
      const quick = dialog.getByRole("group", { name: "Efectivo recibido rápido" });
      await tap(d, quick.getByRole("button", { name: new RegExp(`^\\$${payment.bill}(\\.00)?$`) }));
      const received = payment.bill * 100;
      await expect(dialog.getByLabel("Efectivo recibido", { exact: true })).toHaveValue(pesos(received));
      await expect(dialog.locator(".row.between", { hasText: "Cambio" }).locator("strong")).toHaveText(
        mxn(change(received, amount, payment.tip ?? 0)),
      );
    } else {
      await expect(dialog.getByLabel("Efectivo recibido", { exact: true })).toHaveValue(pesos(amount + (payment.tip ?? 0)));
      await expect(dialog.locator(".row.between", { hasText: "Cambio" }).locator("strong")).toHaveText(mxn(0));
    }
  } else {
    await tap(d, methods.getByRole("button", { name: "Terminal externa", exact: true }));
    await expect(dialog.getByText("Con terminal externa no se captura efectivo recibido.", { exact: true })).toBeVisible();
    await fill(d, dialog.getByLabel("Referencia de aprobación", { exact: true }), payment.ref!);
    await tap(d, dialog.getByRole("checkbox", { name: "Confirmo que la terminal aprobó este pago" }));
  }
  if (o.checkpointId) await checkpoint(d, o.checkpointId, { settle: dialog });
  return dialog;
}

/** Taps "Confirmar cobro" and waits for the receipt with its folio (§11 tap 7). */
export async function confirmPay(d: Device, o: { timed?: Timing; partial?: boolean } = {}) {
  const page = d.page;
  const dialog = page.getByRole("dialog", { name: /^Cobrar/ });
  await timed(o.timed, 7, "Confirmar cobro", () => tap(d, dialog.getByRole("button", { name: "Confirmar cobro" })), async () => {
    await expect(page.locator(".receipt")).toBeVisible();
    if (!o.partial) await expect(page.locator(".receipt")).toContainText("Folio:");
  });
}

/** RC-checks (§6.8): the receipt on screen, then its print. Returns the print. */
export async function rcChecks(
  d: Device,
  r: Restaurant,
  key: string,
  opts: { payments: Payment[]; due?: number; print?: boolean; extra?: string[]; absent?: string[] } = { payments: [] },
) {
  const page = d.page;
  const f = FIGURES[key]!;
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Folio:");
  const text = norm(await receipt.innerText());
  const expected = receiptStrings(r, key, opts.payments);
  for (const s of [...expected, ...(opts.extra ?? [])])
    expect(text, `${key} receipt: "${s}"`).toContain(s);
  for (const s of opts.absent ?? []) expect(text, `${key} receipt must not show "${s}"`).not.toContain(s);
  expect(text.startsWith(r.name), `${key}: the trade name comes first`).toBe(true);
  expect(text, `${key}: no "Green Monkey" on the receipt (FOH-17)`).not.toContain("Green Monkey");
  record(`${key} receipt total`, mxn(f.total), text.match(/Total (\$[\d,]+\.\d{2})/)?.[1]);
  if (opts.print === false) return null;
  const before = (await prints(page)).length;
  await tap(d, page.getByRole("button", { name: "Imprimir recibo", exact: true }));
  const printed = await nextPrint(page, before, `receipt-${key}`);
  // The print root is never laid out on screen, so its text has no line
  // breaks between blocks: compare without whitespace.
  const paper = squash(printed.text);
  for (const s of [...expected, ...(opts.extra ?? [])]) expect(paper, `${key} print: "${s}"`).toContain(squash(s));
  return printed;
}

/** Every string RC-checks requires for this ticket (§6.8 items 1-8). */
export function receiptStrings(r: Restaurant, key: string, payments: Payment[]) {
  const f = FIGURES[key]!;
  const fiscal = r.fiscal;
  const out = [
    r.name,
    fiscal.legalName,
    `RFC: ${fiscal.rfc}`,
    `Régimen fiscal: ${fiscal.receiptRegime}`,
    `${fiscal.street}, ${fiscal.neighborhood}, ${fiscal.municipality}, ${fiscal.state}`,
    `Lugar de expedición: C.P. ${fiscal.zip}`,
    `Folio: ${f.folio}`,
    `#${f.number}`,
    `Total ${mxn(f.total)}`,
    "Precios con IVA incluido",
    "Este ticket no es una factura (CFDI).",
  ];
  for (const l of f.lines) {
    if (!l.remaining) continue;
    out.push(`${l.remaining} × ${l.name} ${mxn(l.total)}`);
    const p = (r.products as ProductDef[]).find((x) => x.name === l.name)!;
    for (const o of optionLabels(r, p, l.options)) out.push(`+ ${o}`);
    if (l.note) out.push(l.note);
  }
  const rate = r === RESTAURANT_B ? "8%" : "16%";
  const g = r === RESTAURANT_B ? f.groups.iva8 : f.groups.iva16;
  if (g.gross) out.push(`Base IVA ${rate} ${mxn(g.base)}`, `IVA ${rate} ${mxn(g.tax)}`);
  if (f.groups.iva0.gross) out.push(`Venta a tasa 0% ${mxn(f.groups.iva0.gross)}`);
  for (const p of payments) {
    const amount = p.amount ?? f.total;
    out.push(`${p.method === "cash" ? "Efectivo" : "Terminal bancaria externa"} ${mxn(amount)}`);
    if (p.method === "external") out.push(`Ref. ${p.ref}`);
    if (p.tip) out.push(`Propina ${mxn(p.tip)}`);
    if (p.method === "cash") {
      const received = p.bill ? p.bill * 100 : amount + (p.tip ?? 0);
      out.push(`Recibido ${mxn(received)}`, `Cambio ${mxn(change(received, amount, p.tip ?? 0))}`);
    }
  }
  if (f.tips > 0) out.push("Propina voluntaria; no forma parte del total de la venta.");
  return out;
}

/** Waits for "Siguiente venta" to empty the cart (§11 tap 8). */
export async function nextSale(d: Device, o: { timed?: Timing } = {}) {
  const page = d.page;
  await timed(o.timed, 8, "Siguiente venta", () => tap(d, page.getByRole("button", { name: "Siguiente venta", exact: true })), async () => {
    await expect(page.getByText("La siguiente buena orden empieza aquí.", { exact: true })).toBeVisible();
  });
}

// ------------------------------------------------------------------ kitchen

const STATION = { Cocina: "Cocina", Barra: "Barra" } as const;

/** A kitchen ticket by order number and station ("#1" never matches "#10"). */
export function kdsTicket(page: Page, number: number, station: "Cocina" | "Barra", round = 1) {
  return page
    .locator("article.kitchen-ticket")
    .filter({ has: page.locator("h2", { hasText: new RegExp(`^#${number}(\\s|$)`) }) })
    .filter({ has: page.locator("header > div:first-child > span", { hasText: new RegExp(`^Ronda ${round} · .* · ${STATION[station]}$`) }) });
}

export type KdsExpectation = {
  number: number;
  callName?: string;
  round?: number;
  mode?: string;
  /** "{Mesa} · {mesero}" line for table service */
  where?: string;
  orderNote?: string;
  roundNote?: string;
  lines: Array<{ qty: number; name: string; options: string[]; note?: string; station: "Cocina" | "Barra" }>;
  tenant: "A" | "B";
};

/** KDS-checks (§6.9) for every station ticket of one round; returns the tickets. */
export async function kdsChecks(k: Device, e: KdsExpectation) {
  const page = k.page;
  const stations = [...new Set(e.lines.map((l) => l.station))];
  const tickets: Record<string, Locator> = {};
  for (const station of stations) {
    const ticket = kdsTicket(page, e.number, station, e.round ?? 1);
    // One poll interval (3 s) plus render.
    await expect(ticket).toBeVisible({ timeout: 10_000 });
    tickets[station] = ticket;
    if (e.callName) await expect(ticket.locator("h2")).toHaveText(`#${e.number} ${e.callName}`);
    await expect(ticket.locator("header > div:first-child > span")).toHaveText(
      `Ronda ${e.round ?? 1} · ${e.mode ?? "Para llevar"} · ${STATION[station]}`,
    );
    if (e.where) await expect(ticket.locator(":scope > p").first()).toHaveText(e.where);
    const mine = e.lines.filter((l) => l.station === station);
    const rows = ticket.locator(".ticket-lines > div");
    await expect(rows).toHaveCount(mine.length);
    // The kitchen lists lines in its own order: compare the lines as a multiset.
    const shown = await rows.evaluateAll((els) =>
      els.map((el) => ({
        title: (el.querySelector("strong")?.textContent ?? "").replace(/\s+/g, " ").trim(),
        options: Array.from(el.querySelectorAll(".ticket-option")).map((o) => (o.textContent ?? "").trim()),
        note: (el.querySelector(".ticket-note")?.textContent ?? "").replace(/\s+/g, " ").trim(),
      })),
    );
    const want = mine.map((l) => ({
      title: `${l.qty} × ${l.name}`,
      options: l.options.map((o) => `+ ${o}`),
      note: l.note ?? "",
    }));
    const key = (x: { title: string; options: string[]; note: string }) => JSON.stringify(x);
    expect(shown.map(key).sort(), `#${e.number} ${station}: kitchen lines`).toEqual(want.map(key).sort());
    if (e.orderNote) {
      const allergy = /alerg/i.test(e.orderNote);
      const block = ticket.locator(":scope > .ticket-note").first();
      await expect(block).toHaveText(`${allergy ? "Alergia" : "Nota"} ${e.orderNote}`);
      if (allergy) await expect(block).toHaveClass(/allergy/);
    }
    if (e.roundNote) await expect(ticket.locator(":scope > .ticket-note").last()).toHaveText(`Nota de ronda ${e.roundNote}`);
    await expect(ticket.locator(".ticket-badges")).toContainText(/\d+ min/);
    await expect(ticket).not.toContainText(/Pagad|Cobrad|Pendiente de pago/);
    run.seenKds[e.tenant].add(await ticket.innerText());
  }
  return tickets;
}

/** "Confirmar recepción" → "Marcar listo" → "Marcar entregado" on one ticket. */
export async function progressTicket(k: Device, ticket: Locator, from: "sent" | "seen" | "ready" = "sent") {
  const steps = ["Confirmar recepción", "Marcar listo", "Marcar entregado"];
  for (const label of steps.slice(from === "sent" ? 0 : from === "seen" ? 1 : 2)) {
    await press(k, ticket.getByRole("button", { name: label, exact: true }));
    if (label !== "Marcar entregado") await expect(ticket.getByRole("button", { name: steps[steps.indexOf(label) + 1]!, exact: true })).toBeVisible();
  }
  await expect(ticket).toHaveCount(0);
}

/** Every kitchen line of an order book entry, with the station of its product. */
export function kdsLines(r: Restaurant, lines: Line[]) {
  return lines.map((l) => {
    const p = productDef(r, l.product);
    return { qty: l.qty, name: p.name, options: optionLabels(r, p, l.options), note: l.note, station: p.station };
  });
}

export type { Print };
