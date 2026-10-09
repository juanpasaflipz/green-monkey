/**
 * Branch L (loyalty spec §9.4, lead decision LD-80): Restaurant L's club day
 * through the UI. The owner publishes the restaurant's privacy notice and turns
 * the club on; Mariana enrolls Rosa at the "Cliente del club" prompt (L1, a
 * full card), answers "Sin club" for a walk-in (L2, the join QR), redeems
 * Rosa's reward without a PIN (L3) and records a refund on L1 with Joaquín's
 * PIN, which reverses one of its stamps. The register's corte X, the owner's
 * Clientes, Excepciones, corte del día and Finanzas › Club de lealtad then show
 * the oracle's figures (R18, R19); tests/restaurant-day-db.ts reconciles the
 * rows (D20-D23).
 *
 * The club exists only in this restaurant, which sells nothing else, so A's and
 * B's sales never meet its prompt, its receipt block or its Club button.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { clubCheckouts, mxn, oracleL } from "./oracle.js";
import {
  CLUB_L,
  ORDERS_L,
  REFUNDS_L,
  RESTAURANT_L,
  type OrderDef,
} from "./scenario.js";
import {
  FIGURES,
  addLine,
  assertCart,
  confirmPay,
  nextSale,
  payDialog,
  rcChecks,
} from "./selling.js";
import {
  orderCard,
  reportValue,
  switchUser,
  toCash,
  toOrders,
  toSell,
} from "./service-a.js";
import { openFinance } from "./close-a.js";
import {
  checkpoint,
  escapeRe,
  fill,
  parseMxn,
  press,
  record,
  run,
  type Device,
  type Devices,
} from "./ui.js";
import type { RunState } from "./env.js";

const r = RESTAURANT_L;
const c = CLUB_L;
const orderL = (id: string) => ORDERS_L.find((o) => o.id === id)!;
const staffL = (key: string) => r.staff.find((s) => s.key === key)!;

/** Rosa's counts right after each of her checkouts (R19), and before her first. */
const CHECKOUTS = clubCheckouts();
const NEW_MEMBER = { stamps: 0, rewards: 0, earned: 0, completed: 0 };

const prompt = (page: Page) =>
  page.getByRole("dialog", { name: "Cliente del club" });
const chip = (page: Page) => page.locator(".loyalty-chip");
const receiptBlock = (page: Page) =>
  page.locator(".receipt .loyalty-receipt-block");

/** Operación → Configuración on the owner's computer. */
async function settings(page: Page) {
  await page
    .getByRole("navigation", { name: "Operación" })
    .getByRole("button", { name: "Configuración" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Configuración", level: 1 }),
  ).toBeVisible();
}

/** L3: the restaurant's privacy notice, then Configuración › Club de lealtad. */
async function turnClubOn(owner: Device) {
  const page = owner.page;
  run.step = "L3.1";
  await settings(page);
  const club = page.getByRole("region", { name: "Club de lealtad" });
  // Without the restaurant's notice the club cannot be turned on (LFPDPPP; LOYALTY.md Privacy).
  await expect(club).toContainText(
    "Primero publica el aviso de privacidad del restaurante en Configuración › Privacidad y datos.",
  );
  const privacy = page.getByRole("region", { name: "Privacidad y datos" });
  await privacy
    .getByLabel("Enlace al aviso de privacidad de tu restaurante", {
      exact: true,
    })
    .fill(c.privacyNoticeUrl);
  await privacy
    .getByRole("button", { name: "Guardar enlace", exact: true })
    .click();
  await expect(
    privacy.getByRole("status").filter({ hasText: "Enlace guardado" }),
  ).toBeVisible();
  run.step = "L3.2";
  await page.reload();
  await settings(page);
  await expect(
    club.getByRole("link", { name: c.privacyNoticeUrl, exact: true }),
  ).toHaveAttribute("href", c.privacyNoticeUrl);
  // The published legal set already lists the club (LOYALTY-PRIVACY-4): nothing waits on it.
  await expect(club).not.toContainText("cuando Green Monkey publique");
  await club.getByLabel(/^Mi aviso de privacidad incluye el club/).check();
  await club.getByLabel("Activar el club", { exact: true }).check();
  // A label wraps its control, so a filled field's accessible name carries its value
  // ("Sellos para un premio 10"): match the start (setup-flows label()).
  await club.getByLabel(/^Nombre del club/).fill(c.programName);
  await club
    .getByLabel(/^Sellos para un premio/)
    .fill(String(c.stampsRequired));
  await club
    .getByLabel(/^Un sello extra por cada/)
    .fill((c.threshold / 100).toFixed(2));
  await expect(
    club.getByText(
      `Cada compra pagada da 1 sello, más 1 por cada ${mxn(c.threshold)} pagados. Usa $0.00 para dar siempre 1 sello.`,
      { exact: true },
    ),
  ).toBeVisible();
  // The defaults the scenario relies on: one product up to $150.00, the prompt and the QR.
  await expect(
    club.getByRole("radio", { name: "Un producto gratis", exact: true }),
  ).toBeChecked();
  await expect(
    club.getByLabel(/^Valor máximo del producto \(opcional\)/),
  ).toHaveValue((c.rewardCap / 100).toFixed(2));
  await expect(
    club.getByLabel(/^Texto del premio \(se imprime en el ticket\)/),
  ).toHaveValue(c.rewardDescription);
  await expect(
    club.getByLabel("Preguntar por el club al empezar cada venta", {
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    club.getByLabel("Imprimir QR para unirse en el ticket", { exact: true }),
  ).toBeChecked();
  await checkpoint(owner, "L3-club-settings", { settle: club });
  await club
    .getByRole("button", { name: "Guardar club de lealtad", exact: true })
    .click();
  await expect(
    club.getByText("Configuración del club guardada.", { exact: true }),
  ).toBeVisible();
  await expect(
    club.getByText(new RegExp(`^Confirmado por ${escapeRe(r.owner.name)} el `)),
  ).toBeVisible();
}

/** The register reads the club state again when it comes back into focus (LOYALTY-UX-5). */
async function registerSeesClub(caja: Device) {
  const page = caja.page;
  await toSell(caja);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page
      .locator(".loyalty-cart")
      .getByRole("button", { name: "Club", exact: true }),
  ).toBeVisible({ timeout: 20_000 });
}

/** The first line opens "Cliente del club"; the cashier answers per the order book. */
async function firstLineAndPrompt(caja: Device, o: OrderDef) {
  const page = caja.page;
  const m = c.member;
  await addLine(caja, r, o.lines[0]!, 0);
  const dialog = prompt(page);
  await expect(dialog).toBeVisible();
  // The phone field has the focus (LOYALTY-UX-10).
  await expect(dialog.getByLabel("Teléfono (10 dígitos)")).toBeFocused();
  if (o.club === "skip") {
    await press(
      caja,
      dialog.getByRole("button", { name: "Sin club", exact: true }),
    );
    await expect(dialog).toHaveCount(0);
    await expect(chip(page)).toHaveCount(0);
    return;
  }
  await fill(caja, dialog.getByLabel("Teléfono (10 dígitos)"), m.phone);
  await press(
    caja,
    dialog.getByRole("button", { name: "Buscar teléfono", exact: true }),
  );
  if (o.club === "enroll") {
    await expect(
      dialog.getByText("No hay socio con ese teléfono.", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByLabel(/^Acepta recibir promociones/),
    ).not.toBeChecked();
    await fill(caja, dialog.getByLabel("Nombre o apodo"), m.name);
    await press(
      caja,
      dialog.getByLabel(/^Le informé al cliente el aviso de privacidad/),
    );
    await checkpoint(caja, "L4-enroll", { settle: dialog });
    await press(
      caja,
      dialog.getByRole("button", { name: "Registrar", exact: true }),
    );
  } else {
    const before = CHECKOUTS[previousMemberOrder(o.id)]!;
    const row = dialog.locator(".loyalty-member-row");
    await expect(row).toContainText(
      `${m.firstName} · ${before.stamps} de ${c.stampsRequired} sellos`,
    );
    await expect(row).toContainText(
      before.rewards === 1
        ? "1 premio disponible"
        : `${before.rewards} premios disponibles`,
    );
    // The phone is masked: never all ten digits on screen.
    await expect(row).not.toContainText(m.phone);
    await press(
      caja,
      dialog.getByRole("button", {
        name: new RegExp(`^Usar a ${escapeRe(m.firstName)} `),
      }),
    );
  }
  await expect(dialog).toHaveCount(0);
  const before =
    o.club === "enroll" ? NEW_MEMBER : CHECKOUTS[previousMemberOrder(o.id)]!;
  await expect(chip(page)).toContainText(
    `${m.firstName} · ${before.stamps}/${c.stampsRequired}`,
  );
  if (before.rewards) await expect(chip(page)).toContainText("1 premio");
}

/** The member's order before this one in the order book (her last balance). */
function previousMemberOrder(id: string) {
  const i = ORDERS_L.findIndex((o) => o.id === id);
  return ORDERS_L.slice(0, i)
    .filter((o) => o.club === "enroll" || o.club === "lookup")
    .at(-1)!.id;
}

/** "Canjear premio" → "Enviar productos primero" → the reward on the most valuable unit (R18). */
async function redeem(caja: Device, o: OrderDef) {
  const page = caja.page;
  const f = FIGURES[o.id]!;
  const line = f.lines[o.reward!.line]!;
  const amount = Math.min(line.unit, c.rewardCap);
  await press(
    caja,
    page
      .locator("aside.cart")
      .getByRole("button", { name: "Canjear premio", exact: true }),
  );
  const first = page.getByRole("dialog", { name: "Enviar productos primero" });
  await press(
    caja,
    first.getByRole("button", { name: "Enviar y continuar", exact: true }),
  );
  const dialog = page.getByRole("dialog", { name: /^Canjear premio: / });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(
    `Canjear premio: ${c.rewardDescription}`,
  );
  const pick = dialog.getByLabel("Elige el producto");
  // The default unit is the one worth most to the customer (LOYALTY-UX-11).
  await expect(pick.locator("option:checked")).toHaveText(
    `${line.name} · ${mxn(line.unit)}`,
  );
  await expect(dialog.getByRole("status")).toContainText(
    `Premio: −${mxn(amount)} · Saldo nuevo: ${mxn(f.total)}`,
  );
  await checkpoint(caja, "L6-redeem", { settle: dialog });
  await press(
    caja,
    dialog.getByRole("button", { name: "Canjear", exact: true }),
  );
  await expect(dialog).toHaveCount(0);
  // No PIN and no manager: the reward is the club's, not a staff discount.
  await expect(
    page.getByRole("dialog", { name: "Confirma con tu PIN" }),
  ).toHaveCount(0);
  await expect(page.locator("aside.cart .existing")).toContainText(
    `−${mxn(amount)}`,
  );
  await expect(page.locator("aside.cart .total strong")).toHaveText(
    mxn(f.total),
  );
  await expect(chip(page)).not.toContainText("premio");
  await expect(
    page.getByRole("button", { name: "Canjear premio", exact: true }),
  ).toHaveCount(0);
}

/** One order book entry through Vender: prompt, lines, reward, payment, receipt. */
async function clubSale(caja: Device, o: OrderDef) {
  const page = caja.page;
  const f = FIGURES[o.id]!;
  const due = f.lines.reduce((s, l) => s + l.unit * l.qty, 0);
  await toSell(caja);
  await firstLineAndPrompt(caja, o);
  for (const [i, line] of o.lines.entries())
    if (i > 0) await addLine(caja, r, line, i);
  await assertCart(caja, r, o.lines, due);
  if (o.reward) await redeem(caja, o);
  await payDialog(caja, o.payment!, o.reward ? f.total : due, {
    hasDraftLines: !o.reward,
  });
  await confirmPay(caja);
  const status = page.locator(".receipt-status");
  const block = receiptBlock(page);
  const extra: string[] = [];
  if (o.club === "skip") {
    const join = `Únete a ${c.programName}: escanea y suma tus sellos de esta compra.`;
    const rule = `Con ${c.stampsRequired} sellos: ${c.rewardDescription}.`;
    await expect(block).toContainText(join);
    await expect(block).toContainText(rule);
    await expect(block.getByRole("img", { name: join })).toBeVisible();
    await expect(status).toHaveCount(0);
    extra.push(join, rule);
  } else {
    const after = CHECKOUTS[o.id]!;
    const name = c.member.firstName;
    // The club's after-payment result sits in the receipt dialog (LOYALTY-UX-3, R18 exit).
    await expect(status).toHaveText(
      after.completed
        ? `¡${name} completó su tarjeta! Tiene ${after.rewards === 1 ? "1 premio disponible" : `${after.rewards} premios disponibles`}.`
        : after.earned === 1
          ? `${name} sumó 1 sello: ${after.stamps} de ${c.stampsRequired}.`
          : `${name} sumó ${after.earned} sellos: ${after.stamps} de ${c.stampsRequired}.`,
    );
    const progress = `${c.programName}: ${after.stamps} de ${c.stampsRequired} sellos`;
    await expect(block).toContainText(progress);
    extra.push(progress);
    if (after.rewards) {
      const rewards = `1 premio disponible: ${c.rewardDescription}`;
      await expect(block).toContainText(rewards);
      extra.push(rewards);
    }
    // Receipts are left on tables: no name and no phone in the club block.
    await expect(block).not.toContainText(c.member.name);
    await expect(block).not.toContainText(c.member.phone.slice(-4));
    if (o.reward) extra.push("Recompensa del club");
  }
  await rcChecks(caja, r, o.id, { payments: [o.payment!], extra });
  record(`${o.id} receipt club block`, extra, await block.innerText());
  await nextSale(caja);
  await expect(chip(page)).toHaveCount(0);
}

/** L7: Órdenes → #n → Reembolsar → "Por importe", cash, with the manager's PIN. */
async function refundWithApproval(
  caja: Device,
  refund: (typeof REFUNDS_L)[number],
) {
  const page = caja.page;
  const f = FIGURES[refund.order]!;
  const approver = staffL(refund.approver);
  await toOrders(caja);
  await press(
    caja,
    orderCard(page, f.number).getByRole("button", {
      name: "Reembolsar",
      exact: true,
    }),
  );
  const dialog = page.getByRole("dialog", {
    name: `Reembolso · Orden #${f.number}`,
  });
  const modes = dialog
    .getByRole("group", { name: /./ })
    .filter({ has: page.getByRole("button", { name: "Por importe" }) });
  await press(
    caja,
    modes.getByRole("button", { name: "Por importe", exact: true }),
  );
  await dialog.getByLabel(/^Pago a reembolsar/).selectOption({
    label: `Efectivo · ${mxn(f.total)} cobrado · ${mxn(f.total)} reembolsable`,
  });
  await fill(
    caja,
    dialog.getByLabel("Importe", { exact: true }),
    (refund.amount / 100).toFixed(2),
  );
  await dialog
    .getByLabel(/^Motivo del reembolso/)
    .selectOption({ label: refund.reasonLabel });
  await fill(
    caja,
    dialog.getByLabel("Explicación", { exact: true }),
    refund.explanation,
  );
  await expect(
    dialog.getByText(
      `Entrega ${mxn(refund.amount)} en efectivo de la caja de este dispositivo.`,
      { exact: true },
    ),
  ).toBeVisible();
  const approval = dialog.getByRole("group", {
    name: "Autorización de gerente",
  });
  await approval
    .getByLabel(/^Gerente que autoriza/)
    .selectOption({ label: approver.name });
  await fill(
    caja,
    approval.getByLabel("PIN del gerente", { exact: true }),
    approver.pin,
  );
  await press(
    caja,
    dialog.getByRole("button", {
      name: `Reembolsar ${mxn(refund.amount)}`,
      exact: true,
    }),
  );
  await expect(
    dialog.getByText(`Reembolso registrado: ${mxn(refund.amount)}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Confirma con tu PIN" }),
  ).toHaveCount(0);
  await press(caja, dialog.getByRole("button", { name: "Listo", exact: true }));
  await expect(orderCard(page, f.number).locator(".badges")).toContainText(
    "Reembolsado",
  );
}

/** L7.2: Joaquín's corte X: the cash refund leaves the drawer; the card sale is the terminal's. */
async function corteX(caja: Device) {
  const page = caja.page;
  const day = oracleL().day;
  const terminal = ORDERS_L.filter((o) => o.payment?.method === "external");
  await switchUser(caja, staffL("joaquin"));
  await toCash(caja);
  await press(caja, page.getByRole("button", { name: "Corte X", exact: true }));
  const preview = page.getByRole("dialog", { name: "Vista previa" });
  const doc = preview.locator(".corte-doc");
  await expect(doc).toContainText("CORTE X · LECTURA PARCIAL");
  const read = {
    opening: await reportValue(doc, "Fondo inicial"),
    cashSales: await reportValue(doc, "Ventas en efectivo"),
    cashRefunds: await reportValue(doc, "Reembolsos en efectivo"),
    expected: await reportValue(doc, "Efectivo esperado"),
    terminalSales: await reportValue(
      doc,
      new RegExp(`^Cobros con terminal \\(${terminal.length}\\)$`),
    ),
    terminalNet: await reportValue(doc, "Neto en terminal"),
  };
  expect(read).toEqual({
    opening: parseMxn(day.opening),
    cashSales: parseMxn(day.cash),
    cashRefunds: -parseMxn(day.cashRefunds),
    expected: parseMxn(day.expectedCash),
    terminalSales: parseMxn(day.external),
    terminalNet: parseMxn(day.terminalNet),
  });
  await expect(doc).toContainText(
    `Folios ${day.folios} (${day.tickets} tickets)`,
  );
  await press(
    caja,
    preview.getByRole("button", { name: "Cerrar", exact: true }),
  );
  await expect(preview).toHaveCount(0);
}

/** A labelled tile of Finanzas › Club de lealtad. */
const tile = (scope: Locator, label: string) =>
  scope
    .locator(".loyalty-tile")
    .filter({
      has: scope.page().locator("span", {
        hasText: new RegExp(`^${escapeRe(label)}$`),
      }),
    })
    .locator("strong");

/** L8: the owner's Clientes, Excepciones, corte del día and club report. */
async function ownerChecks(owner: Device) {
  const page = owner.page;
  const o = oracleL();
  const m = o.club.member;
  const rail = page.getByRole("navigation", { name: "Operación" });
  // L8.1: Clientes › Rosa: the reversal posted by the refund's reconcile job (worker).
  run.step = "L8.1";
  await expect(async () => {
    await page.reload();
    await rail.getByRole("button", { name: "Clientes", exact: true }).click();
    const list = page.getByRole("region", { name: "Clientes del club" });
    await list
      .getByRole("button", { name: `Abrir ${c.member.name}`, exact: true })
      .click({ timeout: 5_000 });
    const card = page.getByRole("region", { name: c.member.name });
    await expect(card.locator(".loyalty-card")).toContainText(
      `${m.stamps} de ${c.stampsRequired} sellos`,
      { timeout: 2_000 },
    );
    await expect(card.locator(".loyalty-history").first()).toContainText(
      "Sellos revertidos (reembolso)",
      { timeout: 2_000 },
    );
  }).toPass({ timeout: 45_000, intervals: [1_000, 2_000, 3_000] });
  const card = page.getByRole("region", { name: c.member.name });
  await expect(card).toContainText(`Sellos totales: ${m.lifetimeStamps}`);
  await expect(card).toContainText(
    `Premios ganados: ${m.rewardsEarned} · canjeados: ${m.rewardsRedeemed}`,
  );
  const history = card.locator(".loyalty-history").first();
  for (const label of [
    "Sellos por compra",
    "Tarjeta completa",
    "Premio canjeado",
    "Sellos revertidos (reembolso)",
  ])
    await expect(history).toContainText(label);
  await checkpoint(owner, "L8-member", { settle: card });

  // L8.2: Excepciones: the reward (no approver) and the refund (Joaquín).
  run.step = "L8.2";
  await openFinance(owner, "Excepciones");
  const reward = o.adjustments[0]!;
  const rewardRow = page
    .getByRole("row")
    .filter({ hasText: "Recompensa del club" });
  await expect(rewardRow).toHaveCount(1);
  await expect(rewardRow).toContainText(`#${orderL("L3").number}`);
  await expect(rewardRow).toContainText(reward.courtesy);
  await expect(rewardRow).toContainText(staffL("mariana").name);
  const refundRow = page
    .getByRole("row")
    .filter({ hasText: REFUNDS_L[0]!.explanation });
  await expect(refundRow).toHaveCount(1);
  await expect(refundRow).toContainText(`#${orderL("L1").number}`);
  await expect(refundRow).toContainText(staffL("joaquin").name);

  // L8.3: the corte del día: the reward among the cortesías, the refund and its IVA.
  run.step = "L8.3";
  await openFinance(owner, "Cortes");
  await page
    .getByRole("button", { name: /^Corte del día/ })
    .first()
    .click();
  const preview = page.getByRole("dialog", { name: "Vista previa" });
  const doc = preview.locator(".day-doc");
  await expect(doc).toBeVisible();
  const d = o.day;
  const want: Array<[string, number]> = [
    ["Ventas brutas (IVA incluido)", parseMxn(d.gross)],
    ["Descuentos y cortesías", -parseMxn(d.discounts)],
    ["de ellos, cortesías", -parseMxn(d.courtesies)],
    ["Ventas totales (IVA incluido)", parseMxn(d.net)],
    ["Reembolsos", -parseMxn(d.refunds)],
    ["Venta IVA 16%", parseMxn(d.iva16.sales)],
    ["Base IVA 16%", parseMxn(d.iva16.base)],
    ["IVA 16%", parseMxn(d.iva16.tax)],
    ["IVA reembolsado", -parseMxn(d.refundTax)],
    ["IVA neto del periodo", parseMxn(d.ivaNet)],
  ];
  const scope = doc.locator("section.doc-section").filter({
    has: page.locator("h3.doc-section-title", { hasText: /^(VENTAS|IVA)$/ }),
  });
  const read: Record<string, number> = {};
  for (const [label, value] of want) {
    read[label] = await reportValue(scope, label);
    record(`L day ${label}`, value, read[label]);
  }
  expect(read).toEqual(Object.fromEntries(want));
  await expect(
    doc
      .locator("section.doc-section")
      .filter({
        has: page.locator("h3.doc-section-title", { hasText: /^COSTO$/ }),
      }),
  ).toContainText(`Costo de lo vendido ${d.cogs}`);
  await preview.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(preview).toHaveCount(0);

  // L8.4: Finanzas › Club de lealtad for the day.
  run.step = "L8.4";
  await openFinance(owner, "Club de lealtad");
  const report = page.getByRole("region", { name: "Club de lealtad" });
  const rp = o.club.report;
  const tiles: Array<[string, string]> = [
    ["Socios", String(rp.members)],
    ["Socios nuevos", String(rp.new)],
    ["Socios con compras", String(rp.active)],
    ["Sellos sumados", String(rp.stampsEarned)],
    ["Sellos revertidos", String(rp.stampsReversed)],
    ["Premios ganados", String(rp.rewardsEarned)],
    ["Premios canjeados", String(rp.rewardsRedeemed)],
    ["Valor de premios", rp.rewardValue],
  ];
  for (const [label, value] of tiles)
    await expect(tile(report, label), label).toHaveText(value);
  await expect(tile(report, "Ventas de socios")).toContainText(
    new RegExp(`^${escapeRe(rp.memberSales)} · `),
  );
  await expect(report.locator("table")).toContainText(c.member.name);
  await checkpoint(owner, "L8-club-report", { settle: report });
}

export async function serviceL(dev: Devices, state: RunState) {
  const owner = await dev("ownerL");
  const caja = await dev("cajaL");
  await turnClubOn(owner);
  run.step = "L3.3";
  await registerSeesClub(caja);
  // L4: Rosa joins at the prompt; her first purchase completes a card.
  run.step = "L4";
  await clubSale(caja, orderL("L1"));
  // L5: a walk-in answers "Sin club" and takes the join QR.
  run.step = "L5";
  await clubSale(caja, orderL("L2"));
  // L6: Rosa redeems her reward with no PIN and pays the rest by card.
  run.step = "L6";
  await clubSale(caja, orderL("L3"));
  // L7: a refund on L1 (Joaquín's PIN) lowers its stamp base; the corte X shows the cash out.
  run.step = "L7.1";
  await refundWithApproval(caja, REFUNDS_L[0]!);
  run.step = "L7.2";
  await corteX(caja);
  await ownerChecks(owner);
  void state;
}
