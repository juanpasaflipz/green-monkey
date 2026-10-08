/**
 * The independent money oracle of the restaurant-day gate (specs/acceptance.md
 * §5). It implements rules R1-R17 from the spec text and imports nothing from
 * shared/, server/ or src/: if the application and this file ever agree, it is
 * because both follow the rules, not because they share code.
 *
 * Output is formatted the way the spec's literal tables print it, so
 * tests/restaurant-day/expected.ts (typed by hand from the spec) can be
 * compared with a deep equality (double entry, §5.1).
 */
import {
  CHECKS_B,
  ORDERS_A,
  REFUNDS_A,
  RESTAURANT_A,
  RESTAURANT_B,
  type Line,
  type OrderDef,
  type Payment,
  type ProductDef,
} from "./scenario.js";

// ---------------------------------------------------------------- time (R14)

function localParts(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The business date: the local date, minus one day before the cutoff (§3.5.2). */
export function businessDate(now: Date, tz: string, cutoff: string): string {
  const [h, m] = cutoff.split(":").map(Number);
  const local = localParts(tz, now);
  return local.minutes < h! * 60 + m! ? addDays(local.date, -1) : local.date;
}

/** Minutes from now until the next local time `minuteOfDay` in `tz`. */
export function minutesUntilLocal(tz: string, now: Date, minuteOfDay: number) {
  const local = localParts(tz, now).minutes;
  return (minuteOfDay - local + 1440) % 1440;
}

/** True when the UTC offset of `tz` changes within the next `minutes`. */
export function dstChangeWithin(tz: string, now: Date, minutes: number) {
  const offset = (at: Date) => {
    const p = localParts(tz, at);
    const [y, mo, d] = p.date.split("-").map(Number);
    const asUtc = Date.UTC(
      y!,
      mo! - 1,
      d!,
      Math.floor(p.minutes / 60),
      p.minutes % 60,
    );
    return Math.round(
      (asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000,
    );
  };
  const start = offset(now);
  for (let t = 5; t <= minutes; t += 5)
    if (offset(new Date(now.getTime() + t * 60000)) !== start) return true;
  return false;
}

// --------------------------------------------------------------- money rules

/** es-MX money as the spec prints it: "$1,234.50", negatives with U+2212. */
export function mxn(centavos: number): string {
  const sign = centavos < 0 ? "−" : "";
  const abs = Math.abs(centavos);
  const pesos = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${pesos}.${String(abs % 100).padStart(2, "0")}`;
}

/** R6: the tax inside a tax-included gross, per ticket and category. */
export function extractTax(gross: number, bps: number): number {
  if (bps === 0 || gross === 0) return 0;
  return Math.floor((2 * gross * bps + (10000 + bps)) / (2 * (10000 + bps)));
}

/** R4: floor split with the leftover centavos to the first weights. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0 && i < parts.length; i++)
    if (weights[i]! > 0) {
      parts[i]! += 1;
      left--;
    }
  return parts;
}

type Category = "iva16" | "iva8" | "iva0";
const RATE: Record<Category, number> = { iva16: 1600, iva8: 800, iva0: 0 };

type Restaurant = typeof RESTAURANT_A | typeof RESTAURANT_B;

function product(r: Restaurant, id: string): ProductDef {
  const p = (r.products as ProductDef[]).find((x) => x.id === id);
  if (!p) throw Error(`oracle: unknown product ${id}`);
  return p;
}
function option(r: Restaurant, p: ProductDef, name: string, index: number) {
  // Options are listed in group order; a repeat group consumes several names.
  for (const gid of p.groups) {
    const group = r.groups.find((g) => g.id === gid)!;
    const o = group.options.find((x) => x.name === name);
    if (o) return o;
  }
  throw Error(`oracle: ${p.name} has no option ${name} (#${index})`);
}
function categoryOf(r: Restaurant, p: ProductDef): Category {
  if (p.tax === "iva0") return "iva0";
  return r === RESTAURANT_B ? "iva8" : "iva16";
}
/** R1: the unit price of a line. */
export function unitPrice(r: Restaurant, line: Line): number {
  const p = product(r, line.product);
  const base = line.open ?? p.price;
  if (base === null) throw Error(`oracle: ${p.name} needs an open amount`);
  return (
    base +
    (line.options ?? []).reduce((s, n, i) => s + option(r, p, n, i).price, 0)
  );
}
function unitCost(r: Restaurant, line: Line): number | null {
  const p = product(r, line.product);
  if (p.cost === null) return null;
  return (
    p.cost +
    (line.options ?? []).reduce((s, n, i) => s + option(r, p, n, i).cost, 0)
  );
}

type SoldLine = {
  line: Line;
  product: ProductDef;
  category: Category;
  unit: number;
  /** units sent to the kitchen */
  sent: number;
  /** units still on the check (sent minus voided) */
  remaining: number;
  /** units voided with their ingredients returned */
  restocked: number;
  voidedAmount: number;
  /** discount allocated to this line (R4, R5) */
  discount: number;
};

type Ticket = {
  key: string;
  number: number;
  folio: string | null;
  lines: SoldLine[];
  grossBeforeDiscount: number;
  discount: number;
  courtesy: number;
  total: number;
  groups: Record<Category, { gross: number; base: number; tax: number }>;
  payments: Payment[];
  tips: number;
  cash: number;
  external: number;
  employee: string;
  offline: boolean;
};

function soldLines(r: Restaurant, o: OrderDef): SoldLine[] {
  const lines = o.lines
    .map((line, i) => ({ line, i }))
    .filter(({ i }) => !(o.removed ?? []).includes(i))
    .map(({ line, i }) => {
      const p = product(r, line.product);
      const unit = unitPrice(r, line);
      const voided = (o.voids ?? []).filter((v) => v.line === i);
      const units = voided.reduce((s, v) => s + v.units, 0);
      return {
        line,
        product: p,
        category: categoryOf(r, p),
        unit,
        sent: line.qty,
        remaining: line.qty - units,
        restocked: voided
          .filter((v) => v.restock)
          .reduce((s, v) => s + v.units, 0),
        voidedAmount: unit * units,
        discount: 0,
        index: i,
      };
    });
  if (o.discountBps) {
    // R4: base = Σ unpaid due of the target units; per unit, floor then +1 to the first units.
    const units = lines.flatMap((l) =>
      Array.from({ length: l.remaining }, () => l),
    );
    const base = units.reduce((s, l) => s + l.unit, 0);
    const amount = Math.floor((base * o.discountBps.bps + 5000) / 10000);
    allocate(
      amount,
      units.map((l) => l.unit),
    ).forEach((share, i) => (units[i]!.discount += share));
  }
  if (o.courtesy) {
    const l = lines.find((x) => x.index === o.courtesy!.line)!;
    l.discount += l.unit * l.remaining; // R5
  }
  return lines;
}

function ticketFor(r: Restaurant, o: OrderDef): Omit<Ticket, "folio"> {
  const lines = soldLines(r, o);
  const groups: Ticket["groups"] = {
    iva16: { gross: 0, base: 0, tax: 0 },
    iva8: { gross: 0, base: 0, tax: 0 },
    iva0: { gross: 0, base: 0, tax: 0 },
  };
  let grossBefore = 0;
  for (const l of lines) {
    grossBefore += l.unit * l.remaining;
    groups[l.category].gross += l.unit * l.remaining - l.discount;
  }
  for (const c of Object.keys(groups) as Category[]) {
    groups[c].tax = extractTax(groups[c].gross, RATE[c]); // R6, R7
    groups[c].base = groups[c].gross - groups[c].tax;
  }
  const total = groups.iva16.gross + groups.iva8.gross + groups.iva0.gross;
  const payments = o.payment ? [o.payment] : [];
  return {
    key: o.id,
    number: o.number,
    lines,
    grossBeforeDiscount: grossBefore,
    discount: o.discountBps ? lines.reduce((s, l) => s + l.discount, 0) : 0,
    courtesy: o.courtesy ? lines.reduce((s, l) => s + l.discount, 0) : 0,
    total,
    groups,
    payments,
    tips: payments.reduce((s, p) => s + (p.tip ?? 0), 0),
    cash: payments
      .filter((p) => p.method === "cash")
      .reduce((s, p) => s + (p.amount ?? total), 0),
    external: payments
      .filter((p) => p.method === "external")
      .reduce((s, p) => s + (p.amount ?? total), 0),
    employee: o.cashier,
    offline: Boolean(o.offline),
  };
}

const folio = (series: string, n: number) =>
  `${series}-${String(n).padStart(6, "0")}`;

/** R13: folios in issue order, only for checks that reach zero with total > 0. */
function issue(
  series: string,
  tickets: Array<Omit<Ticket, "folio">>,
): Ticket[] {
  let n = 0;
  return tickets.map((t) => ({
    ...t,
    folio: t.total > 0 && t.payments.length ? folio(series, ++n) : null,
  }));
}

/** R8: complement extraction for an amount refund on a single-category ticket. */
export function refundTax(
  saleGross: number,
  alreadyRefunded: number,
  split: number,
  bps: number,
) {
  const tax =
    extractTax(saleGross - alreadyRefunded, bps) -
    extractTax(saleGross - alreadyRefunded - split, bps);
  return { tax, base: split - tax };
}

const staffName = (r: Restaurant, key: string) =>
  r.staff.find((s) => s.key === key)!.name;
const METHOD = { cash: "Efectivo", external: "Terminal" } as const;

function ticketRow(t: Ticket) {
  const methods = new Map<string, number>();
  for (const p of t.payments)
    methods.set(p.method, (methods.get(p.method) ?? 0) + (p.amount ?? t.total));
  return {
    folio: t.folio!,
    number: t.number,
    total: mxn(t.total),
    base16: t.groups.iva16.gross ? mxn(t.groups.iva16.base) : "—",
    iva16: t.groups.iva16.gross ? mxn(t.groups.iva16.tax) : "—",
    base8: t.groups.iva8.gross ? mxn(t.groups.iva8.base) : "—",
    iva8: t.groups.iva8.gross ? mxn(t.groups.iva8.tax) : "—",
    tasa0: t.groups.iva0.gross ? mxn(t.groups.iva0.gross) : "—",
    tips: mxn(t.tips),
    payments: [...methods]
      .map(([m, a]) => `${METHOD[m as keyof typeof METHOD]} ${mxn(a)}`)
      .join("; "),
  };
}

function sum<T>(rows: T[], f: (r: T) => number) {
  return rows.reduce((s, r) => s + f(r), 0);
}

function stockFinal(r: Restaurant, orders: Array<{ lines: SoldLine[] }>) {
  const used = new Map<string, number>();
  const add = (id: string, qty: number) =>
    used.set(id, (used.get(id) ?? 0) + qty);
  for (const o of orders)
    for (const l of o.lines) {
      const net = l.sent - l.restocked; // R16: voids after the kitchen saw them return nothing
      for (const e of l.product.recipe) add(e.stock, e.qty * net);
      (l.line.options ?? []).forEach((name, i) => {
        for (const e of option(r, l.product, name, i).recipe)
          add(e.stock, e.qty * net);
      });
    }
  return r.stock.map((s) => {
    const final = Math.round((s.opening - (used.get(s.id) ?? 0)) * 1000) / 1000;
    return { name: s.name, opening: s.opening, final, negative: final < 0 };
  });
}

function cogs(r: Restaurant, tickets: Array<{ lines: SoldLine[] }>) {
  // R15: remaining units, courtesies included, no-cost products excluded.
  let total = 0;
  for (const t of tickets)
    for (const l of t.lines) {
      const c = unitCost(r, l.line);
      if (c !== null) total += c * l.remaining;
    }
  return total;
}

function breakdowns(r: Restaurant, tickets: Ticket[]) {
  const byProduct = new Map<string, { units: number; amount: number }>();
  const byCategory = new Map<string, { units: number; amount: number }>();
  for (const t of tickets)
    for (const l of t.lines) {
      if (!l.remaining) continue;
      const p = byProduct.get(l.product.name) ?? { units: 0, amount: 0 };
      p.units += l.remaining;
      p.amount += l.unit * l.remaining;
      byProduct.set(l.product.name, p);
      const c = byCategory.get(l.product.category) ?? { units: 0, amount: 0 };
      c.units += l.remaining;
      c.amount += l.unit * l.remaining;
      byCategory.set(l.product.category, c);
    }
  const rows = (m: Map<string, { units: number; amount: number }>) =>
    [...m]
      .sort(
        (a, b) => b[1].amount - a[1].amount || a[0].localeCompare(b[0], "es"),
      )
      .map(([name, v]) => ({ name, units: v.units, amount: mxn(v.amount) }));
  return { byProduct: rows(byProduct), byCategory: rows(byCategory) };
}

function dayTotals(tickets: Ticket[]) {
  const t = (c: Category, k: "gross" | "base" | "tax") =>
    sum(tickets, (x) => x.groups[c][k]);
  return {
    gross: sum(tickets, (x) => x.grossBeforeDiscount),
    discounts: sum(tickets, (x) => x.discount + x.courtesy),
    net: sum(tickets, (x) => x.total),
    iva16: {
      gross: t("iva16", "gross"),
      base: t("iva16", "base"),
      tax: t("iva16", "tax"),
    },
    iva8: {
      gross: t("iva8", "gross"),
      base: t("iva8", "base"),
      tax: t("iva8", "tax"),
    },
    tasa0: t("iva0", "gross"),
    cash: sum(tickets, (x) => x.cash),
    external: sum(tickets, (x) => x.external),
    cashTips: sum(tickets, (x) =>
      sum(
        x.payments.filter((p) => p.method === "cash"),
        (p) => p.tip ?? 0,
      ),
    ),
    externalTips: sum(tickets, (x) =>
      sum(
        x.payments.filter((p) => p.method === "external"),
        (p) => p.tip ?? 0,
      ),
    ),
  };
}

// ------------------------------------------------------------- Restaurant A

export function oracleA() {
  const r = RESTAURANT_A;
  const all = issue(
    r.fiscal.series,
    ORDERS_A.map((o) => ticketFor(r, o)),
  );
  const tickets = all.filter((t) => t.folio);
  const voidedOrders = all.filter((t) => !t.folio);
  const voidedUnits = sum(all, (t) =>
    sum(t.lines, (l) => l.sent - l.remaining),
  );
  const voidedAmount = sum(all, (t) => sum(t.lines, (l) => l.voidedAmount));

  const refunds = REFUNDS_A.map((rf) => {
    const t = tickets.find((x) => x.key === rf.order)!;
    const split = refundTax(t.groups.iva16.gross, 0, rf.amount, RATE.iva16);
    return { ...rf, folio: t.folio!, number: t.number, ...split };
  }).sort((a, b) => a.folio.localeCompare(b.folio));

  const x = dayTotals(tickets.filter((t) => t.number <= 16));
  const xVoided = all.filter((t) => t.number <= 16 && !t.folio);
  const z = dayTotals(tickets);
  const refundTotal = sum(refunds, (rf) => rf.amount);
  const refundTaxTotal = sum(refunds, (rf) => rf.tax);
  const refundBaseTotal = sum(refunds, (rf) => rf.base);
  const cashRefunds = sum(
    refunds.filter((rf) => rf.method === "cash"),
    (rf) => rf.amount,
  );
  const cardRefunds = sum(
    refunds.filter((rf) => rf.method === "external"),
    (rf) => rf.amount,
  );
  const expectedCash = r.openingCash + z.cash + z.cashTips - cashRefunds; // R11
  const offline = tickets.filter((t) => t.offline);
  const employees = [...new Set(tickets.map((t) => t.employee))].map((key) => {
    const mine = tickets.filter((t) => t.employee === key);
    return {
      name: staffName(r, key),
      tickets: mine.length,
      net: mxn(sum(mine, (t) => t.total)),
      tips: mxn(sum(mine, (t) => t.tips)),
    };
  });
  const { byProduct, byCategory } = breakdowns(r, tickets);
  const iva16Net = {
    gross: z.iva16.gross - refundTotal,
    base: z.iva16.base - refundBaseTotal,
    tax: z.iva16.tax - refundTaxTotal,
  };

  return {
    tickets: tickets.map(ticketRow),
    adjustments: tickets
      .filter((t) => t.discount || t.courtesy)
      .map((t) => ({
        folio: t.folio!,
        discount: t.discount ? mxn(t.discount) : "—",
        courtesy: t.courtesy ? mxn(t.courtesy) : "—",
        grossBeforeDiscount: mxn(t.grossBeforeDiscount),
      })),
    refunds: refunds.map((rf) => ({
      folio: rf.folio,
      amount: mxn(rf.amount),
      base: mxn(rf.base),
      tax: mxn(rf.tax),
    })),
    noTicket: voidedOrders.map((t) => t.number),
    corteX: {
      tickets: tickets.filter((t) => t.number <= 16).length,
      folios: `${tickets[0]!.folio} a ${tickets.filter((t) => t.number <= 16).at(-1)!.folio}`,
      voidedOrders: xVoided.length,
      voidedUnits: sum(
        all.filter((t) => t.number <= 16),
        (t) => sum(t.lines, (l) => l.sent - l.remaining),
      ),
      voidedAmount: mxn(
        sum(
          all.filter((t) => t.number <= 16),
          (t) => sum(t.lines, (l) => l.voidedAmount),
        ),
      ),
      gross: mxn(x.gross),
      discounts: mxn(x.discounts),
      net: mxn(x.net),
      iva16: {
        sales: mxn(x.iva16.gross),
        base: mxn(x.iva16.base),
        tax: mxn(x.iva16.tax),
      },
      tasa0: mxn(x.tasa0),
      cash: mxn(x.cash),
      external: mxn(x.external),
      cashTips: mxn(x.cashTips),
      externalTips: mxn(x.externalTips),
      opening: mxn(r.openingCash),
      expectedCash: mxn(r.openingCash + x.cash + x.cashTips),
    },
    corteZ: {
      orders: all.length,
      tickets: tickets.length,
      folios: `${tickets[0]!.folio} a ${tickets.at(-1)!.folio}`,
      voidedOrders: voidedOrders.length,
      voidedOrdersAmount: mxn(
        sum(voidedOrders, (t) => sum(t.lines, (l) => l.voidedAmount)),
      ),
      voidedUnits,
      voidedAmount: mxn(voidedAmount),
      gross: mxn(z.gross),
      discounts: mxn(z.discounts),
      discountOnly: mxn(sum(tickets, (t) => t.discount)),
      courtesies: mxn(sum(tickets, (t) => t.courtesy)),
      net: mxn(z.net),
      iva16: {
        sales: mxn(z.iva16.gross),
        base: mxn(z.iva16.base),
        tax: mxn(z.iva16.tax),
      },
      tasa0: mxn(z.tasa0),
      refunds: mxn(refundTotal),
      cashRefunds: mxn(cashRefunds),
      cardRefunds: mxn(cardRefunds),
      refundBase: mxn(refundBaseTotal),
      refundTax: mxn(refundTaxTotal),
      netAfterRefunds: mxn(z.net - refundTotal),
      ivaNet: mxn(iva16Net.tax),
      iva16Net: {
        gross: mxn(iva16Net.gross),
        base: mxn(iva16Net.base),
        tax: mxn(iva16Net.tax),
      },
      cash: mxn(z.cash),
      external: mxn(z.external),
      cashTips: mxn(z.cashTips),
      externalTips: mxn(z.externalTips),
      terminalNet: mxn(z.external + z.externalTips - cardRefunds), // R12
      offline: {
        count: offline.length,
        amount: mxn(sum(offline, (t) => t.total)),
        tips: mxn(sum(offline, (t) => t.tips)),
      },
      opening: mxn(r.openingCash),
      expectedCash: mxn(expectedCash),
      countedCash: mxn(r.countedCash),
      difference: mxn(r.countedCash - expectedCash),
      cogs: mxn(cogs(r, all)),
    },
    byProduct,
    byCategory,
    byEmployee: employees,
    byMethod: [
      {
        method: "Efectivo",
        collected: mxn(z.cash),
        tips: mxn(z.cashTips),
        refunds: mxn(cashRefunds),
      },
      {
        method: "Terminal externa",
        collected: mxn(z.external),
        tips: mxn(z.externalTips),
        refunds: mxn(cardRefunds),
      },
    ],
    stock: stockFinal(r, all),
  };
}

// ------------------------------------------------------------- Restaurant B

function checkTicket(
  r: Restaurant,
  c: (typeof CHECKS_B)[number],
): Omit<Ticket, "folio"> {
  const order: OrderDef = {
    id: c.id,
    number: c.number,
    cashier: c.waiter,
    lines: c.rounds.flatMap((round) => round.lines),
    payment: null,
  };
  const t = ticketFor(r, order);
  // Payments by amount or by items; the item split's amount is the units' prices.
  const payments = c.payments.map((p) => {
    if (!p.units) return p;
    const amount = p.units.reduce((s, label) => {
      const name = label.replace(/ · \d+$/, "");
      const line = order.lines.find(
        (l) => product(r, l.product).name === name,
      )!;
      return s + unitPrice(r, line);
    }, 0);
    return { ...p, amount };
  });
  return {
    ...t,
    payments,
    tips: payments.reduce((s, p) => s + (p.tip ?? 0), 0),
    cash: payments
      .filter((p) => p.method === "cash")
      .reduce((s, p) => s + p.amount!, 0),
    external: payments
      .filter((p) => p.method === "external")
      .reduce((s, p) => s + p.amount!, 0),
  };
}

export function oracleB() {
  const r = RESTAURANT_B;
  const tickets = issue(
    r.fiscal.series,
    CHECKS_B.map((c) => checkTicket(r, c)),
  );
  const z = dayTotals(tickets);
  const expectedCash = r.openingCash + z.cash + z.cashTips;
  const waiters = [...new Set(tickets.map((t) => t.employee))].map((key) => {
    const mine = tickets.filter((t) => t.employee === key);
    return {
      name: staffName(r, key),
      checks: `${mine.length} (${mine.map((t) => "#" + t.number).join(", ")})`,
      net: mxn(sum(mine, (t) => t.total)),
      tips: mxn(sum(mine, (t) => t.tips)),
    };
  });
  const { byProduct, byCategory } = breakdowns(r, tickets);
  // Factura global (fiscal §6.2): one concept per ticket per category.
  const global = (included: Ticket[]) => {
    const tt = dayTotals(included);
    return {
      tickets: included.length,
      concepts: sum(
        included,
        (t) =>
          (["iva8", "iva16", "iva0"] as Category[]).filter(
            (c) => t.groups[c].gross,
          ).length,
      ),
      iva8: {
        sales: mxn(tt.iva8.gross),
        base: mxn(tt.iva8.base),
        tax: mxn(tt.iva8.tax),
      },
      tasa0: mxn(tt.tasa0),
    };
  };
  return {
    tickets: tickets.map(ticketRow),
    corteZ: {
      orders: tickets.length,
      tickets: tickets.length,
      folios: `${tickets[0]!.folio} a ${tickets.at(-1)!.folio}`,
      gross: mxn(z.gross),
      net: mxn(z.net),
      iva8: {
        sales: mxn(z.iva8.gross),
        base: mxn(z.iva8.base),
        tax: mxn(z.iva8.tax),
      },
      tasa0: mxn(z.tasa0),
      refunds: mxn(0),
      cash: mxn(z.cash),
      external: mxn(z.external),
      cashTips: mxn(z.cashTips),
      externalTips: mxn(z.externalTips),
      terminalTotal: mxn(z.external + z.externalTips),
      opening: mxn(r.openingCash),
      expectedCash: mxn(expectedCash),
      countedCash: mxn(r.countedCash),
      difference: mxn(r.countedCash - expectedCash),
      cogs: mxn(cogs(r, tickets)),
    },
    byWaiter: waiters,
    byProduct,
    byCategory,
    byService: [
      { name: "En mesa", orders: tickets.length, amount: mxn(z.net) },
    ],
    globalN: global(tickets),
    globalK: global(tickets.filter((t) => t.key !== "B3")),
    stock: stockFinal(r, tickets),
  };
}

/** The full expected day (§5.1, §13.3 oracle.json). */
export function oracle() {
  return { A: oracleA(), B: oracleB() };
}

/** Per-ticket figures the browser and DB suites assert, keyed by order-book id (centavos). */
export function ticketFigures() {
  const out: Record<
    string,
    {
      folio: string | null;
      number: number;
      total: number;
      grossBeforeDiscount: number;
      groups: Record<Category, { gross: number; base: number; tax: number }>;
      tips: number;
      lines: Array<{
        name: string;
        qty: number;
        remaining: number;
        unit: number;
        total: number;
        options: string[];
        note?: string;
      }>;
    }
  > = {};
  const add = (r: Restaurant, t: Ticket) =>
    (out[t.key] = {
      folio: t.folio,
      number: t.number,
      total: t.total,
      grossBeforeDiscount: t.grossBeforeDiscount,
      groups: t.groups,
      tips: t.tips,
      lines: t.lines.map((l) => ({
        name: l.product.name,
        qty: l.sent,
        remaining: l.remaining,
        unit: l.unit,
        total: l.unit * l.remaining,
        options: l.line.options ?? [],
        note: l.line.note,
      })),
    });
  for (const t of issue(
    RESTAURANT_A.fiscal.series,
    ORDERS_A.map((o) => ticketFor(RESTAURANT_A, o)),
  ))
    add(RESTAURANT_A, t);
  for (const t of issue(
    RESTAURANT_B.fiscal.series,
    CHECKS_B.map((c) => checkTicket(RESTAURANT_B, c)),
  ))
    add(RESTAURANT_B, t);
  return out;
}

/** R10: change for one cash tender. */
export function change(received: number, amount: number, tip = 0) {
  return received - amount - tip;
}
