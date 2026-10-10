/**
 * Branch S's oracle (kiosk self-checkout, 039; critic R13, R47; LD-80): the expected day of
 * Restaurant S computed from scenario-s.ts with the rules of the kiosk and payments specs,
 * independently of the application (nothing here imports shared/, server/ or src/).
 * tests/restaurant-day/expected-s.ts types the same figures by hand; the S self-check and
 * tests/restaurant-day-oracle.test.ts compare the two (double entry, acceptance §5.1).
 *
 * Rules:
 * - S-R1 prices: a kiosk order is charged at the menu price when the guest pays; an order the
 *   manager accepts with the kiosk payment after a price rose sells at today's price. All of
 *   Restaurant S is IVA 16 % included (R6: the tax is extracted per ticket).
 * - S-R2 tenders: each kiosk charge is one card tender on its station's reader for the amount
 *   charged (a kiosk asks no tip); its fee is estimated from the terminal's rate, half-up to the
 *   centavo (the fake reports none). An accept with the kiosk payment adds one cash tender for the
 *   difference (critic R13: never a partial refund).
 * - S-R3 the drawer: every tender lands in the receiving till's one drawer: card money per
 *   terminal (the batch totals the manager types equal each terminal's net), the difference in
 *   expected cash. The corte's «Del kiosco» sub-line counts each terminal's tenders on kiosk
 *   orders, all of them here.
 * - S-R4 attempts: one per order, settled. A retried review keeps its kiosk_settle_* code and no
 *   resolution; the manager's accept is payments' record (resolution `recorded`).
 * - S-R5 holds: every hold is accepted and paid at the accept; the kiosk decides the approved and
 *   the retried ones (decision_source `kiosk`), staff the accepted one (`staff`). Finanzas ›
 *   Kiosco counts by that decision, the reviews resolved, and the suggestion lines accepted.
 * - S-R6 Excepciones: payments' kinds only (the kiosk adds none): one «Cobro en terminal por
 *   revisar» per review, one «resuelto por gerente» per manager record, and no other row. A
 *   review names why the kiosk charge could not become the order (KIOSK-OPS-5): the 86'd product
 *   of a retry (kiosk_settle_unavailable), the price that rose before an accept with the kiosk
 *   payment (kiosk_settle_price_changed).
 * - S-R7 the club: the member's paid order earns one stamp (no extra-stamp threshold); before it
 *   the kiosk shows 0 of the stamps required, no name, the phone masked.
 */
import { extractTax, mxn } from "./oracle.js";
import {
  CLUB_S,
  KIOSKS_S,
  ORDERS_S,
  PAYMENTS_S,
  RESTAURANT_S,
  type OrderS,
  type TerminalKeyS,
} from "./scenario-s.js";

const sum = <T>(rows: T[], f: (x: T) => number) =>
  rows.reduce((n, x) => n + f(x), 0);
/** S-R2: half-up integer centavos. */
const fee = (base: number, bp: number) =>
  Math.floor((base * bp + 5000) / 10000);
const price = (id: string) =>
  RESTAURANT_S.products.find((p) => p.id === id)!.price!;

/** What the guest was charged at the kiosk (S-R1). */
export function chargedS(o: OrderS): number {
  return (
    sum(o.lines, (l) => price(l.product) * l.qty) +
    (o.suggestion ? price(o.suggestion) : 0)
  );
}
/** The order's total once accepted (S-R1). */
export function totalS(o: OrderS): number {
  const r = o.resolution;
  if (r.kind !== "acceptWithRest") return chargedS(o);
  return (
    sum(
      o.lines,
      (l) => (l.product === r.product ? r.newPrice : price(l.product)) * l.qty,
    ) + (o.suggestion ? price(o.suggestion) : 0)
  );
}

export function oracleS() {
  const r = RESTAURANT_S;
  const orders = ORDERS_S.map((o) => {
    const total = totalS(o);
    const tax = extractTax(total, 1600);
    const terminal = KIOSKS_S[o.kiosk].terminal;
    const charged = chargedS(o);
    return { o, total, tax, terminal, charged, rest: total - charged };
  }).sort((a, b) => a.o.number - b.o.number);
  const card = orders.map((x) => ({
    order: x.o.id,
    method: "external" as const,
    amount: x.charged,
    terminal: x.terminal,
    fee: fee(x.charged, PAYMENTS_S.terminals[x.terminal].feeBp),
    card: `${x.o.card.brand} ${x.o.card.type === "credit_card" ? "credit" : "debit"} ${x.o.card.last4}`,
  }));
  const cash = orders
    .filter((x) => x.rest > 0)
    .map((x) => ({ order: x.o.id, method: "cash" as const, amount: x.rest }));
  const cashSales = sum(cash, (t) => t.amount);
  const expectedCash = r.openingCash + cashSales;
  const keys = (Object.keys(PAYMENTS_S.terminals) as TerminalKeyS[]).sort(
    (a, b) =>
      PAYMENTS_S.terminals[a].name.localeCompare(
        PAYMENTS_S.terminals[b].name,
        "es",
      ),
  );
  const byTerminal = keys.map((k) => {
    const rows = card.filter((t) => t.terminal === k);
    return {
      name: PAYMENTS_S.terminals[k].name,
      count: rows.length,
      amount: sum(rows, (t) => t.amount),
      fees: sum(rows, (t) => t.fee),
    };
  });
  const cardSales = sum(card, (t) => t.amount);
  const tickets = orders.map((x) => ({
    folio: `${r.fiscal.series}-${String(x.o.number).padStart(6, "0")}`,
    number: x.o.number,
    total: mxn(x.total),
    base: mxn(x.total - x.tax),
    tax: mxn(x.tax),
  }));
  const reviews = orders.filter((x) => x.o.resolution.kind !== "approved");
  const recorded = orders.filter(
    (x) => x.o.resolution.kind === "acceptWithRest",
  );
  return {
    tickets,
    tenders: [
      ...card.map((t) => ({
        order: t.order,
        method: t.method,
        amount: mxn(t.amount),
        terminal: PAYMENTS_S.terminals[t.terminal].name,
        card: t.card,
        fee: mxn(t.fee),
      })),
      ...cash.map((t) => ({
        order: t.order,
        method: t.method,
        amount: mxn(t.amount),
        terminal: null,
        card: null,
        fee: null,
      })),
    ],
    attempts: orders.map((x) => ({
      order: x.o.id,
      terminal: x.terminal,
      amount: mxn(x.charged),
      state: "settled",
      errorCode:
        x.o.resolution.kind === "retry"
          ? "kiosk_settle_unavailable"
          : x.o.resolution.kind === "acceptWithRest"
            ? "kiosk_settle_price_changed"
            : null,
      resolution: x.o.resolution.kind === "acceptWithRest" ? "recorded" : null,
    })),
    holds: orders.map((x) => ({
      order: x.o.id,
      number: x.o.number,
      decisionSource:
        x.o.resolution.kind === "acceptWithRest" ? "staff" : "kiosk",
      mode: x.o.fulfillment === "here" ? "dine_in" : "takeaway",
      acceptedTotal: mxn(x.total),
    })),
    corteZ: {
      cash: {
        opening: mxn(r.openingCash),
        sales: mxn(cashSales),
        expected: mxn(expectedCash),
        counted: mxn(r.countedCash),
        difference: mxn(r.countedCash - expectedCash),
      },
      terminal: {
        count: card.length,
        sales: mxn(cardSales),
        tips: mxn(0),
        net: mxn(cardSales),
        reported: mxn(cardSales),
        byTerminal: Object.fromEntries(
          byTerminal.map((t) => [
            `${t.name} (${t.count})`,
            {
              net: mxn(t.amount),
              batch: mxn(t.amount),
              kiosk: `Del kiosco: ${t.count} · ${mxn(t.amount)}`,
              fees: mxn(t.fees),
            },
          ]),
        ),
      },
      payments: card.length + cash.length,
      folios: `${tickets[0]!.folio} a ${tickets.at(-1)!.folio}`,
      tickets: tickets.length,
    },
    finance: {
      byTerminal: byTerminal.map((t) => [
        t.name,
        String(t.count),
        mxn(t.amount),
        mxn(0),
        mxn(0),
        `${mxn(t.fees)} (estimadas)`,
        mxn(t.amount - t.fees),
      ]),
      byMethod: [
        [
          "Efectivo",
          String(cash.length),
          mxn(cashSales),
          mxn(0),
          mxn(0),
          mxn(cashSales),
        ],
        [
          "Terminal bancaria externa",
          String(card.length),
          mxn(cardSales),
          mxn(0),
          mxn(0),
          mxn(cardSales),
        ],
      ],
      byMethodTotal: [
        "Total",
        String(card.length + cash.length),
        mxn(cardSales + cashSales),
        mxn(0),
        mxn(0),
        mxn(cardSales + cashSales),
      ],
    },
    kioskReport: {
      orders: String(orders.length),
      // KIOSK-OPS-3: by payment. Every S order carries its kiosk card tender; S4's cash rest is a
      // counter tender too, so it counts in both.
      paidAtKiosk: String(orders.length),
      paidAtCounter: String(recorded.length),
      reviewOpen: "0",
      reviewResolved: String(reviews.length),
      // No S review is refunded at the provider (S3 approves, S4 accepts with a cash rest).
      refunded: "0",
      refundedAmount: mxn(0),
      suggestionLines: String(orders.filter((x) => x.o.suggestion).length),
      suggestionAmount: mxn(
        sum(
          orders.filter((x) => x.o.suggestion),
          (x) => price(x.o.suggestion!),
        ),
      ),
    },
    exceptions: {
      review: reviews.map((x) => ({
        number: x.o.number,
        amount: mxn(x.charged),
        terminal: PAYMENTS_S.terminals[x.terminal].name,
        reason:
          x.o.resolution.kind === "retry"
            ? "un producto ya no está disponible"
            : "cambió un precio",
      })),
      recorded: recorded.map((x) => ({
        number: x.o.number,
        amount: mxn(x.charged),
        terminal: PAYMENTS_S.terminals[x.terminal].name,
      })),
    },
    club: {
      before: `0 de ${CLUB_S.stampsRequired} sellos`,
      masked: CLUB_S.member.masked,
      stampsAfter: 1,
    },
  };
}
