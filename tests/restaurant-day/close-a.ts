/**
 * Restaurant A after the outage and at close (specs/acceptance.md §6.10 A14,
 * A15): a lost payment response, a manager's own refund with the global
 * step-up and a lost refund response, a cashier's card refund with one PIN,
 * a recall, reprints, stock, the blind close and its review, corte Z, the
 * daily figures, the ticket register and CSV, offboarding and revocation.
 */
import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mxn, oracleA } from "./oracle.js";
import { REFUNDS_A, RESTAURANT_A } from "./scenario.js";
import {
  FIGURES,
  kdsChecks,
  kdsLines,
  kdsTicket,
  progressTicket,
  squash,
} from "./selling.js";
import {
  canonicalSale,
  firstPrint,
  orderA,
  orderCard,
  reportValue,
  saleA,
  setAutoLock,
  setIdleLock,
  staffA,
  switchUser,
  toCash,
  toOrders,
} from "./service-a.js";
import {
  allowing,
  checkpoint,
  escapeRe,
  fill,
  nextPrint,
  parseMxn,
  press,
  prints,
  record,
  run,
  typePin,
  type Device,
  type Devices,
} from "./ui.js";
import type { RunState } from "./env.js";

const r = RESTAURANT_A;

/** The step-up oracle's deliberate wait (§3.5.4): until an absolute instant, in the test process. */
async function waitUntil(at: number) {
  const left = at - Date.now();
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
}
const Z = () => oracleA().corteZ;

/** The step-up dialog the client opens on 403 step_up_required. */
const stepUp = (page: Page) => page.getByRole("dialog", { name: "Confirma con tu PIN" });

/** Órdenes → #n → Reembolsar → "Por importe", the tender, amount, reason and note. */
async function refundDialog(caja: Device, n: number, refund: (typeof REFUNDS_A)[number], tenderOption: string) {
  const page = caja.page;
  await toOrders(caja);
  await press(caja, orderCard(page, n).getByRole("button", { name: "Reembolsar", exact: true }));
  const dialog = page.getByRole("dialog", { name: `Reembolso · Orden #${n}` });
  const modes = dialog.getByRole("group", { name: /./ }).filter({ has: page.getByRole("button", { name: "Por importe" }) });
  await expect(modes.getByRole("button", { name: "Por productos", exact: true })).toHaveAttribute("aria-pressed", "true");
  await press(caja, modes.getByRole("button", { name: "Por importe", exact: true }));
  await expect(modes.getByRole("button", { name: "Por importe", exact: true })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByLabel(/^Pago a reembolsar/).selectOption({ label: tenderOption });
  await fill(caja, dialog.getByLabel("Importe", { exact: true }), (refund.amount / 100).toFixed(2));
  await expect(dialog.getByText("La propina no se reembolsa desde aquí.", { exact: true })).toBeVisible();
  await dialog.getByLabel(/^Motivo del reembolso/).selectOption({ label: refund.reasonLabel });
  await fill(caja, dialog.getByLabel("Explicación", { exact: true }), refund.explanation);
  return dialog;
}

export async function serviceA4(dev: Devices, state: RunState) {
  const caja = await dev("cajaA");
  const cocina = await dev("cocinaA");
  const owner = await dev("ownerA");
  const page = caja.page;
  const diego = staffA("diego");
  const marisol = staffA("marisol");

  // A14.1: Caja 1 never locks from its next session on.
  run.step = "A14.1";
  await setAutoLock(owner, "Caja 1", "Nunca");

  // A14.2: A23, the payment's response is lost after the server recorded it.
  run.step = "A14.2";
  {
    const o = orderA("A23");
    let lost = false;
    await caja.context.route("**/api/orders/*/payments", async (route: Route) => {
      if (route.request().method() !== "POST" || lost) return route.fallback();
      lost = true;
      caja.injected.add(route.request());
      caja.outage = true;
      await route.fetch();
      await route.abort("connectionreset");
    });
    await saleA(caja, cocina, o, {
      afterConfirm: async () => {
        await expect(
          page.getByText("Hay un pago anterior por confirmar. Reintentar consulta la misma operación; no inicia otro cobro.").first(),
        ).toBeVisible({ timeout: 30_000 });
        await caja.context.unrouteAll({ behavior: "ignoreErrors" });
        caja.outage = false;
        // Built (offline 026 settleActiveAttempt): when the server answers again the
        // client looks the same operation up by itself; "Recuperar pago" is the
        // manual path while that has not happened yet.
        const recover = page.getByRole("button", { name: "Recuperar pago", exact: true }).first();
        const receipt = page.locator(".receipt");
        await expect(receipt.or(recover.and(page.locator("button:enabled")))).toBeVisible({ timeout: 45_000 });
        if (!(await receipt.isVisible())) await press(caja, recover);
      },
    });
    expect(lost, "A14.2: the first payment response was lost").toBe(true);
  }

  // A14.3: Marisol switches in (her session gets "Nunca").
  run.step = "A14.3";
  await switchUser(caja, marisol);
  setIdleLock(false);

  // A14.4: R1, a manager's own refund: the global step-up, then a lost response.
  run.step = "A14.4";
  {
    const refund = REFUNDS_A.find((x) => x.id === "R1")!;
    const dialog = await refundDialog(caja, 6, refund, `Efectivo · ${mxn(12950)} cobrado · ${mxn(12950)} reembolsable`);
    await expect(dialog.getByText(`Entrega ${mxn(4500)} en efectivo de la caja de este dispositivo.`, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Autorización de gerente" })).toHaveCount(0);
    await checkpoint(caja, "A14-refund", { settle: dialog });
    // Her own session must be older than 70 s for the step-up to be due (§3.5.4).
    const since = run.lastAuthAt[`${marisol.name}@${caja.name}`]!;
    await waitUntil(since + 71_000);
    const posts: number[] = [];
    let lostRefund = false;
    await caja.context.route("**/api/orders/*/refunds", async (route: Route) => {
      if (route.request().method() !== "POST" || lostRefund) return route.fallback();
      const response = await route.fetch();
      posts.push(response.status());
      if (response.status() === 403 && /step_up_required/.test(await response.text())) return route.fulfill({ response });
      lostRefund = true;
      caja.injected.add(route.request());
      caja.outage = true;
      return route.abort("failed");
    });
    await allowing([{ method: "POST", url: /\/api\/orders\/[^/]+\/refunds$/, status: 403 }], async () => {
      await press(caja, dialog.getByRole("button", { name: `Reembolsar ${mxn(4500)}`, exact: true }));
      const up = stepUp(page);
      await expect(up).toBeVisible();
      await expect(up.getByText(`Esta acción necesita que confirmes que eres ${marisol.name}.`, { exact: true })).toBeVisible();
      await expect(up.getByLabel(`PIN de ${marisol.name}`, { exact: true })).toBeVisible();
      await checkpoint(caja, "A10-stepup", { settle: up });
      await typePin(caja, up, marisol.name, marisol.pin, "Confirmar");
      run.lastAuthAt[`${marisol.name}@${caja.name}`] = Date.now();
      run.stepUpDialogs++;
    });
    await expect(dialog.getByRole("alert")).toHaveText(
      "Sin conexión con el servidor. Puedes seguir vendiendo; las ventas se guardan en este dispositivo.",
      { timeout: 20_000 },
    );
    caja.outage = false;
    const again = dialog.getByRole("button", { name: `Reembolsar ${mxn(4500)}`, exact: true });
    await expect(again).toBeEnabled({ timeout: 30_000 });
    await press(caja, again);
    await caja.context.unrouteAll({ behavior: "ignoreErrors" });
    await expect(stepUp(page)).toHaveCount(0);
    await expect(dialog.getByText(`Entrega ${mxn(4500)} en efectivo`, { exact: true })).toBeVisible();
    await expect(dialog.getByText(`Reembolso registrado: ${mxn(4500)}`, { exact: true })).toBeVisible();
    expect(lostRefund, "A14.4: the accepted refund's response was lost").toBe(true);
    expect(posts.filter((s) => s === 403), "A14.4: exactly one step-up refusal").toHaveLength(1);
    expect(run.stepUpDialogs, "A14.4: exactly one step-up dialog").toBe(1);
    const before = (await prints(page)).length;
    await press(caja, dialog.getByRole("button", { name: "Imprimir comprobante", exact: true }));
    const slip = squash((await nextPrint(page, before, "refund-R1")).text);
    for (const s of [
      "COMPROBANTE DE REEMBOLSO",
      "Orden #6",
      `Ticket original: ${FIGURES.A06!.folio}`,
      "Efectivo",
      mxn(4500),
      `Total reembolsado ${mxn(4500)}`,
      `Importe sin IVA ${mxn(3880)} · IVA reembolsado ${mxn(620)}`,
      `Motivo: ${refund.reasonLabel}`,
      `Registró ${marisol.name} · autorizó ${marisol.name}`,
      "Este comprobante no es una factura (CFDI).",
    ])
      expect(slip, `A14.4 slip: ${s}`).toContain(squash(s));
    await press(caja, dialog.getByRole("button", { name: "Listo", exact: true }));
    await expect(orderCard(page, 6).locator(".badges")).toContainText("Reembolsado");
    await press(caja, orderCard(page, 6).getByRole("button", { name: "Detalle", exact: true }));
    const detail = page.getByRole("dialog", { name: "Orden #6" });
    await expect(detail).toContainText(`Registró ${marisol.name} · autorizó ${marisol.name}`);
    await press(caja, detail.getByRole("button", { name: "Cerrar", exact: true }));
  }

  // A14.5: the owner reprints A-000001 from the register; same folio and date.
  run.step = "A14.5";
  {
    const op = owner.page;
    const register = await openRegister(owner);
    await register.getByLabel(/^Buscar folio/).fill(FIGURES.A01!.folio!);
    await register.getByRole("button", { name: "Mostrar", exact: true }).click();
    const before = (await prints(op)).length;
    await register.getByRole("button", { name: `Reimprimir ticket ${FIGURES.A01!.folio}`, exact: true }).click();
    const reprint = (await nextPrint(op, before, "reprint-A01")).text;
    expect(squash(reprint)).toContain("REIMPRESIÓN");
    const issued = (t: string) => t.match(/Fecha de expedición:\s*(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})/)?.[1];
    expect(issued(reprint), "A14.5: the reprint keeps the original issue date").toBe(issued(firstPrint.A01!.text));
    expect(squash(reprint)).toContain(squash(`Folio: ${FIGURES.A01!.folio}`));
    await register.getByLabel(/^Buscar folio/).fill("");
  }
  await switchUser(caja, diego);

  // A14.6: R2, a cashier's card refund: Marisol's PIN is the only PIN.
  run.step = "A14.6";
  await canonicalSale(caja, cocina, orderA("A24"));
  {
    const refund = REFUNDS_A.find((x) => x.id === "R2")!;
    const dialog = await refundDialog(
      caja,
      2,
      refund,
      `Terminal bancaria externa · ${mxn(13500)} cobrado · ${mxn(13500)} reembolsable · Ref. 000102`,
    );
    await expect(dialog.getByText(`Reembolso en terminal externa: ${mxn(4500)}`, { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("Primero haz el reembolso en la terminal. Aquí solo se registra; el POS no mueve dinero de tarjetas.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(dialog.getByText(`Terminal · pago original Ref. 000102 · ${mxn(4500)}`, { exact: true })).toBeVisible();
    await fill(caja, dialog.getByLabel("Referencia del reembolso en la terminal", { exact: true }), refund.terminalRef!);
    await press(caja, dialog.getByRole("checkbox", { name: `Confirmo que la terminal aprobó el reembolso de ${mxn(4500)}` }));
    const approval = dialog.getByRole("group", { name: "Autorización de gerente" });
    await approval.getByLabel(/^Gerente que autoriza/).selectOption({ label: marisol.name });
    await fill(caja, approval.getByLabel("PIN del gerente", { exact: true }), marisol.pin);
    await checkpoint(caja, "A14-stepup", { settle: dialog });
    await press(caja, dialog.getByRole("button", { name: `Reembolsar ${mxn(4500)}`, exact: true }));
    await expect(dialog.getByText(`Terminal: ${mxn(4500)}, ya reembolsado en la terminal (Ref. ${refund.terminalRef})`)).toBeVisible();
    await expect(dialog.getByText(`Reembolso registrado: ${mxn(4500)}`, { exact: true })).toBeVisible();
    await expect(stepUp(page)).toHaveCount(0);
    await press(caja, dialog.getByRole("button", { name: "Listo", exact: true }));
  }

  // A14.7: A25 and A26 (the combo's Suadero is still on offer after the product's 86).
  run.step = "A14.7";
  await saleA(caja, cocina, orderA("A25"), { kitchen: false });
  await saleA(caja, cocina, orderA("A26"), { picker: { 0: { livePrice: 10300 } }, kitchen: false });

  // A14.8: recall (FOH-9) and the combo comanda (FIT-9).
  run.step = "A14.8";
  {
    const k = cocina.page;
    const a25 = orderA("A25");
    const tickets = await kdsChecks(cocina, { number: 25, callName: a25.callName, lines: kdsLines(r, a25.lines), tenant: "A" });
    await progressTicket(cocina, tickets.Cocina!);
    await press(cocina, k.getByRole("button", { name: /^Entregados recientes \(\d+\)$/ }));
    const recent = k.getByRole("dialog", { name: "Entregados recientes" });
    const row = recent.locator("li").filter({ hasText: /^#25 · Gerardo · Ronda 1 · Cocina · \d{2}:\d{2}/ });
    await expect(row).toHaveCount(1);
    await checkpoint(cocina, "A14-kds-recent", { settle: recent });
    await press(cocina, row.getByRole("button", { name: "Regresar a pantalla", exact: true }));
    const back = kdsTicket(k, 25, "Cocina");
    await expect(back).toBeVisible({ timeout: 10_000 });
    await expect(back).toContainText("Listo");
    await progressTicket(cocina, back, "ready");
    await progressTicket(cocina, tickets.Barra!);
    const a26 = orderA("A26");
    const t26 = await kdsChecks(cocina, { number: 26, callName: a26.callName, lines: kdsLines(r, a26.lines), tenant: "A" });
    const before = (await prints(k)).length;
    await press(cocina, t26.Cocina!.getByRole("button", { name: "Imprimir comanda", exact: true }));
    const comanda = squash((await nextPrint(k, before, "comanda-26")).text);
    for (const s of ["1 × Combo Pastor", "Pastor", "2× Suadero", "Horchata"]) expect(comanda).toContain(squash(s));
    await progressTicket(cocina, t26.Cocina!);
  }

  // A14.9: reprints after the refunds.
  run.step = "A14.9";
  for (const [key, n, tax, extra] of [
    ["A06", 6, 620, null],
    ["A02", 2, 621, `Terminal · Ref. reembolso ${REFUNDS_A[1]!.terminalRef}`],
  ] as const) {
    await toOrders(caja);
    await press(caja, orderCard(page, n).getByRole("button", { name: "Detalle", exact: true }));
    const detail = page.getByRole("dialog", { name: `Orden #${n}` });
    if (n === 6) await checkpoint(caja, "A14-detail", { settle: detail });
    const before = (await prints(page)).length;
    await press(caja, detail.getByRole("button", { name: "Reimprimir recibo", exact: true }));
    const text = squash((await nextPrint(page, before, `reprint-${key}`)).text);
    for (const s of ["REIMPRESIÓN", `Folio: ${FIGURES[key]!.folio}`, `Reembolso −${mxn(4500)}`, `IVA reembolsado −${mxn(tax)}`, ...(extra ? [extra] : [])])
      expect(text, `${key} reprint: ${s}`).toContain(squash(s));
    await press(caja, detail.getByRole("button", { name: "Cerrar", exact: true }));
  }

  // A14.10: theoretical stock (§6.16), Suadero negative.
  run.step = "A14.10";
  await stockChecks(owner);
  void state;
}

/** Configuración → Datos fiscales → "Registro de tickets" (disclosure). */
export async function openRegister(owner: Device) {
  const page = owner.page;
  await page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Configuración" }).click();
  const fiscal = page.getByRole("region", { name: "Datos fiscales" });
  const details = fiscal.locator("details").filter({ has: page.locator("summary", { hasText: "Registro de tickets" }) });
  if (!(await details.evaluate((d: HTMLDetailsElement) => d.open))) await details.locator("summary").click();
  return details;
}

/** A14.10 / B7.6: "Existencia teórica" of every stock item equals the oracle. */
export async function stockChecks(owner: Device, restaurant: "A" | "B" = "A") {
  const page = owner.page;
  await page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Menú e inventario" }).click();
  await page.getByRole("navigation", { name: "Menú e inventario" }).getByRole("button", { name: "Insumos", exact: true }).click();
  const stock = (restaurant === "A" ? oracleA() : (await import("./oracle.js")).oracleB()).stock;
  const fmt = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 6 });
  for (const s of stock) {
    const row = page.getByRole("row", { name: new RegExp(`^${escapeRe(s.name)}`) });
    const shown = (await row.getByRole("cell").nth(2).innerText()).trim();
    record(`stock ${s.name}`, s.final, shown);
    expect(Number(shown.replace(/[−‐]/g, "-").replace(/,/g, "")), `stock ${s.name}`).toBeCloseTo(s.final, 6);
    if (s.negative) {
      await expect(row).toContainText("Negativo");
      await expect(row.locator(".menu-negative-hint")).toHaveText(
        /^La existencia teórica quedó en negativo desde .+\. Registra la compra o haz un conteo; no indica faltante por sí sola\.$/,
      );
      await row.getByRole("button", { name: "Movimientos" }).click();
      const history = page.getByRole("dialog", { name: `Movimientos de ${s.name}` });
      await expect(history.locator("td[data-label='Saldo']").first()).toBeVisible();
      const balances = await history.locator("td[data-label='Saldo']").allInnerTexts();
      expect(balances.map((b) => Number(b.replace(/[−‐]/g, "-"))), "DB-4: the movements end at the on-hand balance").toContain(s.final);
      await history.getByRole("button", { name: "Cerrar", exact: true }).click();
    } else await expect(row).not.toContainText("Negativo");
  }
  void fmt;
}

// ------------------------------------------------------------------ A15

export async function serviceA5(dev: Devices, state: RunState) {
  const caja = await dev("cajaA");
  const owner = await dev("ownerA");
  const respaldo = await dev("respaldoA");
  const page = caja.page;
  const diego = staffA("diego");
  const paola = staffA("paola");
  const z = Z();

  // A15.1: nothing open, nothing unsynced.
  run.step = "A15.1";
  await toOrders(caja);
  await press(caja, page.getByRole("button", { name: "Abiertas", exact: true }));
  await expect(page.getByText("No hay cuentas abiertas.", { exact: true })).toBeVisible();

  // A15.2: Diego's blind close.
  run.step = "A15.2";
  await toCash(caja);
  await expect(
    page.getByText("Corte ciego: el efectivo esperado se muestra a un responsable después del conteo.", { exact: true }),
  ).toBeVisible();
  await press(caja, page.getByRole("button", { name: "Cerrar caja", exact: true }));
  const close = page.getByRole("dialog", { name: "Cerrar caja" });
  await expect(close.getByRole("heading", { name: "Cuenta el efectivo de la caja" })).toBeVisible();
  await expect(
    close.getByText("Cuenta todo el efectivo, incluido el fondo. El efectivo esperado no se muestra hasta guardar el conteo.", {
      exact: true,
    }),
  ).toBeVisible();
  for (const hidden of [z.expectedCash, "Efectivo esperado", "Diferencia"]) {
    await expect(close).not.toContainText(hidden);
    await expect(page.locator("main")).not.toContainText(hidden);
  }
  await fill(caja, close.getByLabel("Efectivo contado", { exact: true }), (r.countedCash / 100).toFixed(2));
  await checkpoint(caja, "A15-close", { settle: close });
  await press(caja, close.getByRole("button", { name: "Continuar", exact: true }));
  await expect(close.getByText(`¿Cerrar la caja con ${mxn(r.countedCash)} contados? Después no se puede cambiar.`)).toBeVisible();
  await press(caja, close.getByRole("button", { name: "Guardar conteo y cerrar", exact: true }));
  const result = page.getByRole("dialog", { name: "Corte registrado" });
  await expect(result).toContainText("Un responsable revisará el resultado.");
  await expect(result).not.toContainText("Efectivo esperado");
  await checkpoint(caja, "A15-close-result", { settle: result });
  await press(caja, result.getByRole("button", { name: "Listo", exact: true }));
  await expect(page.getByText("Caja cerrada", { exact: true }).first()).toBeVisible();
  await expect(page.locator("main")).not.toContainText(z.expectedCash);

  // The owner reviews the difference.
  const op = owner.page;
  await op.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Operación" }).click();
  await op.getByRole("button", { name: "Caja", exact: true }).click();
  const history = op.locator("details.panel").filter({ has: op.locator("summary", { hasText: "Historial de cajas" }) });
  await history.locator("summary").click();
  const row = history.locator("article.panel").filter({ has: op.locator("h3", { hasText: /^Caja 1 · / }) });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`Cerró ${diego.name}`);
  await expect(row).toContainText("Corte ciego");
  await expect(row).toContainText("Diferencia por revisar");
  const line = async (label: string) =>
    parseMxn((await row.locator("p", { hasText: new RegExp(`^${escapeRe(label)}: `) }).innerText()).split(": ")[1]!.replace(/^neto /, ""));
  expect(await line("Esperado al cerrar")).toBe(parseMxn(z.expectedCash));
  expect(await line("Conteo original")).toBe(r.countedCash);
  expect(await line("Diferencia original")).toBe(parseMxn(z.difference));
  expect(await line("Terminal")).toBe(parseMxn(z.terminalNet));
  await row.getByRole("button", { name: "Revisar diferencia", exact: true }).click();
  const review = op.getByRole("dialog", { name: "Revisar diferencia de caja" });
  await expect(review).toContainText(`Esperado ${z.expectedCash} · contado ${mxn(r.countedCash)} · diferencia -${z.difference.replace(/^−/, "")}`);
  await review.getByLabel("Explicación del responsable", { exact: true }).fill("Faltante en cambio");
  await review.getByRole("button", { name: "Guardar revisión", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(row).toContainText(`Revisó ${r.owner.name} · Faltante en cambio`);
  await expect(row).not.toContainText("Diferencia por revisar");
  await expect(row.getByRole("button", { name: "Revisar diferencia" })).toHaveCount(0);

  // A15.3: corte Z of Caja 1 (reports 029 labels; one REPEATABLE READ snapshot on paper).
  run.step = "A15.3";
  await openFinance(owner, "Cortes");
  const cortes = op.locator("main");
  const drawerRow = cortes.getByRole("row").filter({ hasText: "Caja 1" }).first();
  await drawerRow.getByRole("button", { name: /corte Z/i }).click();
  const preview = op.getByRole("dialog", { name: "Vista previa" });
  const doc = preview.locator(".corte-doc");
  await expect(doc).toContainText("CORTE Z · CIERRE DE CAJA");
  const corteZ = {
    opening: await reportValue(doc, "Fondo inicial"),
    cashSales: await reportValue(doc, "Ventas en efectivo"),
    cashTips: await reportValue(doc, "Propinas en efectivo"),
    cashRefunds: await reportValue(doc, "Reembolsos en efectivo"),
    expected: await reportValue(doc, "Efectivo esperado"),
    counted: await reportValue(doc, "Efectivo contado"),
    difference: await reportValue(doc, "Diferencia (faltante)"),
    terminalSales: await reportValue(doc, /^Cobros con terminal \(8\)$/),
    terminalTips: await reportValue(doc, "Propinas con terminal"),
    terminalRefunds: await reportValue(doc, "Reembolsos en terminal"),
    terminalNet: await reportValue(doc, "Neto en terminal"),
  };
  expect(corteZ).toEqual({
    opening: parseMxn(z.opening),
    cashSales: parseMxn(z.cash),
    cashTips: parseMxn(z.cashTips),
    cashRefunds: -parseMxn(z.cashRefunds),
    expected: parseMxn(z.expectedCash),
    counted: parseMxn(z.countedCash),
    difference: parseMxn(z.difference),
    terminalSales: parseMxn(z.external),
    terminalTips: parseMxn(z.externalTips),
    terminalRefunds: -parseMxn(z.cardRefunds),
    terminalNet: parseMxn(z.terminalNet),
  });
  await expect(doc).toContainText(`Folios ${z.folios} (25 tickets)`);
  await expect(doc).toContainText(`Revisó ${r.owner.name}: Faltante en cambio`);
  await checkpoint(owner, "A15-cortez", { settle: preview });
  {
    const before = (await prints(op)).length;
    await preview.getByRole("button", { name: "Imprimir", exact: true }).click();
    const paper = squash((await nextPrint(op, before, "corte-z")).text);
    // Deductions print "−$45.00"; the difference prints Intl's "-$20.00" (either minus parses, §5.3).
    for (const v of Object.values(corteZ))
      expect(paper).toMatch(new RegExp(v < 0 ? `[−-]${escapeRe(mxn(-v))}` : escapeRe(mxn(v))));
  }
  await preview.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(preview).toHaveCount(0);

  // A15.4: the day's figures (corte del día; §6.14, §6.15).
  run.step = "A15.4";
  await dayFigures(owner, "A", state.businessDateA);

  // A15.5: the ticket register, its IVA summary and the CSV.
  run.step = "A15.5";
  await registerChecks(owner, "A", state.businessDateA);

  // A15.6: Paola is deactivated; the backup terminal's roster drops her (SEC-3).
  run.step = "A15.6";
  await op.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Equipo" }).click();
  const team = op.getByRole("region", { name: "Equipo" });
  await team.getByRole("button", { name: `Editar ${paola.name}` }).click();
  await op.getByRole("button", { name: "Desactivar empleado", exact: true }).click();
  const confirm = op.getByRole("dialog", { name: "Desactivar empleado" });
  await expect(confirm).toContainText(
    `${paola.name} ya no podrá entrar en ningún dispositivo y se cerrarán sus sesiones abiertas. Sus ventas y registros se conservan.`,
  );
  await confirm.getByRole("button", { name: "Desactivar empleado", exact: true }).click();
  const edit = op.getByRole("dialog", { name: `Editar a ${paola.name}` });
  await expect(edit.getByRole("button", { name: "Reactivar", exact: true })).toBeVisible();
  await edit.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(team.getByRole("row", { name: new RegExp(`^${paola.name}`) })).toContainText("Inactivo");
  await expect(respaldo.page.locator(".roster .roster-person").filter({ hasText: paola.name })).toHaveCount(0, { timeout: 30_000 });

  // A15.7: Caja 2 (respaldo) is unpaired (SEC-5).
  run.step = "A15.7";
  await op.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Configuración" }).click();
  const devices = op.getByRole("region", { name: "Dispositivos" });
  await devices.getByRole("button", { name: "Desvincular · Caja 2 (respaldo)", exact: true }).click();
  const revoke = op.getByRole("dialog", { name: "Desvincular" });
  await expect(revoke).toContainText(
    "«Caja 2 (respaldo)» dejará de funcionar de inmediato y se cerrarán sus sesiones. Para usarlo de nuevo necesitará un código nuevo.",
  );
  await revoke.getByRole("button", { name: "Desvincular", exact: true }).click();
  await expect(revoke).toHaveCount(0);
  await allowing([{ method: "GET", url: /\/api\/access\/terminal$/, status: 401 }], async () => {
    await respaldo.page.reload();
    await expect(
      respaldo.page.getByText("Este dispositivo fue desvinculado o su vinculación venció. Pide un código nuevo a un responsable."),
    ).toBeVisible();
    await expect(respaldo.page.getByLabel("Código de vinculación")).toBeVisible();
  });

  // A15.8: Diego signs out with an empty queue.
  run.step = "A15.8";
  await press(caja, page.getByRole("button", { name: "Salir", exact: true }));
  await expect(page.getByRole("dialog", { name: /Ventas sin enviar/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "¿Quién entra?" })).toBeVisible();
}

/** Finanzas → a tab, for the run's business day ("Hoy"). */
export async function openFinance(owner: Device, tab: string) {
  const page = owner.page;
  await page.getByRole("navigation", { name: "Operación" }).getByRole("button", { name: "Finanzas" }).click();
  await page.getByRole("tab", { name: tab, exact: true }).or(page.getByRole("button", { name: tab, exact: true })).first().click();
}

/** §6.14 / §7.10: the corte del día (one snapshot of the day's figures). */
export async function dayFigures(owner: Device, restaurant: "A" | "B", businessDate: string) {
  const page = owner.page;
  await openFinance(owner, "Cortes");
  await page.getByRole("button", { name: /^Corte del día/ }).first().click();
  const preview = page.getByRole("dialog", { name: "Vista previa" });
  const doc = preview.locator(".day-doc");
  await expect(doc).toBeVisible();
  const o = restaurant === "A" ? oracleA().corteZ : (await import("./oracle.js")).oracleB().corteZ;
  const want: Array<[string | RegExp, number]> =
    restaurant === "A"
      ? [
          ["Ventas brutas (IVA incluido)", parseMxn((o as ReturnType<typeof oracleA>["corteZ"]).gross)],
          ["Descuentos y cortesías", -parseMxn((o as ReturnType<typeof oracleA>["corteZ"]).discounts)],
          ["de ellos, cortesías", -parseMxn((o as ReturnType<typeof oracleA>["corteZ"]).courtesies)],
          ["Ventas totales (IVA incluido)", parseMxn(o.net)],
          ["Reembolsos", -parseMxn(o.refunds)],
          ["Venta IVA 16%", parseMxn((o as ReturnType<typeof oracleA>["corteZ"]).iva16.sales)],
          ["Base IVA 16%", parseMxn((o as ReturnType<typeof oracleA>["corteZ"]).iva16.base)],
          ["IVA 16%", parseMxn((o as ReturnType<typeof oracleA>["corteZ"]).iva16.tax)],
          ["Venta a tasa 0%", parseMxn(o.tasa0)],
          ["IVA reembolsado", -parseMxn((o as ReturnType<typeof oracleA>["corteZ"]).refundTax)],
          ["IVA neto del periodo", parseMxn((o as ReturnType<typeof oracleA>["corteZ"]).ivaNet)],
        ]
      : [
          ["Ventas brutas (IVA incluido)", parseMxn(o.gross)],
          ["Ventas totales (IVA incluido)", parseMxn(o.net)],
          ["Venta IVA 8%", parseMxn((o as ReturnType<typeof import("./oracle.js").oracleB>["corteZ"]).iva8.sales)],
          ["Base IVA 8%", parseMxn((o as ReturnType<typeof import("./oracle.js").oracleB>["corteZ"]).iva8.base)],
          ["IVA 8%", parseMxn((o as ReturnType<typeof import("./oracle.js").oracleB>["corteZ"]).iva8.tax)],
          ["Venta a tasa 0%", parseMxn(o.tasa0)],
        ];
  // Sales and tax rows live in the VENTAS and IVA sections; the payments section
  // repeats "Reembolsos" per method.
  const section = (title: string) =>
    doc.locator("section.doc-section").filter({ has: page.locator("h3.doc-section-title", { hasText: new RegExp(`^${title}$`) }) });
  const scope = doc.locator("section.doc-section").filter({
    has: page.locator("h3.doc-section-title", { hasText: /^(VENTAS|IVA)$/ }),
  });
  const read: Record<string, number> = {};
  for (const [label, value] of want) {
    read[String(label)] = await reportValue(scope, label);
    record(`${restaurant} day ${label}`, value, read[String(label)]);
  }
  expect(read).toEqual(Object.fromEntries(want.map(([l, v]) => [String(l), v])));
  await expect(section("COSTO")).toContainText(`Costo de lo vendido ${o.cogs}`);
  await checkpoint(owner, restaurant === "A" ? "A15-report" : "B7-report", { settle: preview });
  await preview.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(preview).toHaveCount(0);
  void businessDate;
}

/** A15.5 / B7.4: the ticket register for the business day, its IVA summary and CSV. */
export async function registerChecks(owner: Device, restaurant: "A" | "B", businessDate: string) {
  const page = owner.page;
  const register = await openRegister(owner);
  await register.getByLabel(/^Desde/).fill(businessDate);
  await register.getByLabel(/^Hasta/).fill(businessDate);
  await register.getByRole("button", { name: "Mostrar", exact: true }).click();
  const tickets = (restaurant === "A" ? oracleA() : (await import("./oracle.js")).oracleB()).tickets;
  // The ticket table carries the sr-only caption; the IVA summary table does not.
  const table = register.locator("table.fiscal-table").filter({ has: page.locator("caption") });
  await expect(table.locator("tbody tr")).toHaveCount(tickets.length);
  // "Resumen de IVA" (A15.5, B7.4): every cell by row and column, Ventas/Reembolsos/Neto × Base/IVA.
  const summaryTable = register.locator("section.fiscal-summary table");
  const o = restaurant === "A" ? oracleA() : (await import("./oracle.js")).oracleB();
  const z = o.corteZ as Record<string, any>;
  const rate = restaurant === "A" ? "iva16" : "iva8";
  const refundBase = restaurant === "A" ? parseMxn(z.refundBase) : 0;
  const refundTax = restaurant === "A" ? parseMxn(z.refundTax) : 0;
  const sales = { base: parseMxn(z[rate].base), tax: parseMxn(z[rate].tax) };
  const zero = parseMxn(z.tasa0);
  const want: Record<string, number[]> = {
    [restaurant === "A" ? "IVA 16%" : "IVA 8% (región fronteriza)"]: [
      sales.base,
      sales.tax,
      refundBase,
      refundTax,
      sales.base - refundBase,
      sales.tax - refundTax,
    ],
    "IVA 0%": [zero, 0, 0, 0, zero, 0],
    Total: [sales.base + zero, sales.tax, refundBase, refundTax, sales.base + zero - refundBase, sales.tax - refundTax],
  };
  const shownRows = await summaryTable.locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => [row.querySelector("th")?.textContent?.trim() ?? "", ...Array.from(row.querySelectorAll("td")).map((td) => td.textContent?.trim() ?? "")]),
  );
  expect(
    Object.fromEntries(shownRows.map(([head, ...cells]) => [head!, cells.map((c) => parseMxn(c))])),
    `${restaurant}: Resumen de IVA`,
  ).toEqual(want);
  for (const t of tickets) {
    const row = table.locator("tbody tr").filter({ has: page.locator("td, th", { hasText: new RegExp(`^${t.folio}$`) }) });
    await expect(row).toHaveCount(1);
    const cells = (await row.locator("td").allInnerTexts()).map((c) => c.trim());
    record(`${restaurant} register ${t.folio}`, t, cells);
    expect(cells).toContain(t.total);
  }
  const summary = register.locator("section.fiscal-summary");
  await expect(summary).toContainText(`${tickets[0]!.folio} a ${tickets.at(-1)!.folio} (${tickets.length} tickets)`);
  await checkpoint(owner, restaurant === "A" ? "A15-register" : "B7-global", { settle: register });
  // CSV (LD-16 L13): UTF-8 with BOM, CRLF, fixed headers.
  const download = page.waitForEvent("download");
  await register.getByRole("button", { name: "Descargar CSV", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`tickets_${businessDate}_${businessDate}.csv`);
  const csv = readFileSync((await file.path())!, "utf8");
  expect(csv.charCodeAt(0), "CSV BOM").toBe(0xfeff);
  const lines = csv.slice(1).split("\r\n").filter(Boolean);
  expect(lines[0]).toBe(
    "folio,serie,numero,fecha_expedicion,dia_negocio,orden,total,base_iva16,iva16,base_iva8,iva8,venta_tasa0,venta_exenta,descuentos,propinas,reembolsos,iva_reembolsado,formas_pago,codigo_facturacion",
  );
  expect(lines).toHaveLength(tickets.length + 1);
  return { csv: lines };
}

export type { Locator };
