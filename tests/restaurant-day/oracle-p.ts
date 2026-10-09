/**
 * Branch P's oracle (payments spec §12.4, LD-80): the expected day of Restaurant P computed from
 * scenario-p.ts with the rules of payments spec §2 and reports' corte, independently of the
 * application (nothing here imports shared/, server/ or src/). tests/restaurant-day/expected-p.ts
 * types the same figures by hand; the P self-check and tests/restaurant-day-oracle.test.ts
 * compare the two (double entry, acceptance §5.1).
 *
 * Rules:
 * - P-R1 prices: a platform order sells at that platform's price, every other order at the menu
 *   price; all of Restaurant P is IVA 16 % included (R6: the tax is extracted per ticket).
 * - P-R2 fees: an integrated tender carries the provider's fee when the provider reports one
 *   (MP); otherwise, and for a manual terminal, the fee is estimated from the terminal's rate on
 *   amount + tip, half-up to the centavo; a platform's commission is estimated from its rate on
 *   the amount (never a tip: a platform tender has none).
 * - P-R3 the drawer: only cash is expected cash; terminal money is counted per terminal (the
 *   batch totals the manager types equal each terminal's net: no difference); platform money is
 *   apart from both.
 * - P-R4 attempts: every integrated charge is one attempt; a decline leaves its attempt
 *   declined and the order is paid in cash; an unknown outcome is settled by the manager's
 *   record (resolution `recorded`), with no card data and the estimated fee.
 */
import { extractTax, mxn } from "./oracle.js";
import {
  ORDERS_P,
  PAYMENTS_P,
  RESTAURANT_P,
  type OrderP,
  type PlatformKey,
  type TerminalKey,
} from "./scenario-p.js";

const sum = <T>(rows: T[], f: (x: T) => number) =>
  rows.reduce((n, x) => n + f(x), 0);

/** P-R2: half-up integer centavos. */
export function estimatedFee(base: number, bp: number): number {
  return Math.floor((base * bp + 5000) / 10000);
}

function unit(o: OrderP, product: string): number {
  const p = RESTAURANT_P.products.find((x) => x.id === product)!;
  if (o.payment.kind === "platform") {
    const price = PAYMENTS_P.prices[product]?.[o.payment.platform];
    if (price === undefined)
      throw Error(`oracle P: ${p.name} has no ${o.payment.platform} price`);
    return price;
  }
  return p.price;
}

export type TenderP = {
  order: string;
  method: "cash" | "external" | "platform";
  amount: number;
  tip: number;
  terminal: TerminalKey | null;
  platform: PlatformKey | null;
  card: { brand: string; type: "credit" | "debit"; last4: string } | null;
  fee: number | null;
  feeSource: "provider" | "estimated" | null;
};

function tenderOf(o: OrderP, total: number): TenderP {
  const p = o.payment;
  const base = { order: o.id, amount: total, tip: 0 };
  switch (p.kind) {
    case "integrated": {
      const tip = p.tip ?? 0;
      const t = PAYMENTS_P.terminals[p.terminal];
      return {
        ...base,
        method: "external",
        tip,
        terminal: p.terminal,
        platform: null,
        card: {
          brand: p.card.brand,
          type: p.card.type === "credit_card" ? "credit" : "debit",
          last4: p.card.last4,
        },
        fee: p.providerFee ?? estimatedFee(total + tip, t.feeBp),
        feeSource: p.providerFee === undefined ? "estimated" : "provider",
      };
    }
    case "unknown":
    case "manual":
      return {
        ...base,
        method: "external",
        terminal: p.terminal,
        platform: null,
        card: null,
        fee: estimatedFee(total, PAYMENTS_P.terminals[p.terminal].feeBp),
        feeSource: "estimated",
      };
    case "declinedThenCash":
      return {
        ...base,
        method: "cash",
        terminal: null,
        platform: null,
        card: null,
        fee: null,
        feeSource: null,
      };
    case "platform":
      return {
        ...base,
        method: "platform",
        terminal: null,
        platform: p.platform,
        card: null,
        fee: estimatedFee(total, PAYMENTS_P.platforms[p.platform].commissionBp),
        feeSource: "estimated",
      };
  }
}

/** The day as the screens and the database show it (strings are es-MX money). */
export function oracleP() {
  const r = RESTAURANT_P;
  const orders = ORDERS_P.map((o, i) => {
    const total = sum(o.lines, (l) => unit(o, l.product) * l.qty);
    const tax = extractTax(total, 1600);
    return {
      o,
      folio: `${r.fiscal.series}-${String(i + 1).padStart(6, "0")}`,
      total,
      tax,
      base: total - tax,
      tender: tenderOf(o, total),
    };
  });
  const tenders = orders.map((x) => x.tender);
  const cash = tenders.filter((t) => t.method === "cash");
  const card = tenders.filter((t) => t.method === "external");
  const platform = tenders.filter((t) => t.method === "platform");
  const cashSales = sum(cash, (t) => t.amount);
  const cardSales = sum(card, (t) => t.amount);
  const cardTips = sum(card, (t) => t.tip);
  const expectedCash = r.openingCash + cashSales;
  const terminalKeys = Object.keys(PAYMENTS_P.terminals) as TerminalKey[];
  const byTerminal = terminalKeys.map((k) => {
    const rows = card.filter((t) => t.terminal === k);
    const fees = sum(rows, (t) => t.fee ?? 0);
    const amount = sum(rows, (t) => t.amount);
    const tips = sum(rows, (t) => t.tip);
    return {
      key: k,
      name: PAYMENTS_P.terminals[k].name,
      count: rows.length,
      amount,
      tips,
      net: amount + tips,
      fees,
      estimated: rows.some((t) => t.feeSource === "estimated"),
    };
  });
  const platformKeys = Object.keys(PAYMENTS_P.platforms) as PlatformKey[];
  const byPlatform = platformKeys.map((k) => {
    const rows = platform.filter((t) => t.platform === k);
    const amount = sum(rows, (t) => t.amount);
    const commission = sum(rows, (t) => t.fee ?? 0);
    return {
      key: k,
      label: PAYMENTS_P.platforms[k].label,
      count: rows.length,
      amount,
      commission,
    };
  });
  type AttemptP = {
    order: string;
    terminal: "mp" | "clip";
    state: string;
    errorCode: string | null;
    resolution: string | null;
  };
  const attempts = ORDERS_P.flatMap((o): AttemptP[] => {
    const p = o.payment;
    if (p.kind === "integrated")
      return [
        {
          order: o.id,
          terminal: p.terminal,
          state: "settled",
          errorCode: null,
          resolution: null,
        },
      ];
    if (p.kind === "declinedThenCash")
      return [
        {
          order: o.id,
          terminal: p.terminal,
          state: "declined",
          errorCode: "payments_card_declined",
          resolution: null,
        },
      ];
    if (p.kind === "unknown")
      return [
        {
          order: o.id,
          terminal: p.terminal,
          state: "settled",
          errorCode: "payments_clip_create_outcome_unknown",
          resolution: "recorded",
        },
      ];
    return [];
  });
  const resolved = ORDERS_P.find((o) => o.payment.kind === "unknown")!;
  const resolvedRow = orders.find((x) => x.o.id === resolved.id)!;
  return {
    tickets: orders.map((x) => ({
      folio: x.folio,
      number: x.o.number,
      total: mxn(x.total),
      base: mxn(x.base),
      tax: mxn(x.tax),
    })),
    tenders: tenders.map((t) => ({
      order: t.order,
      method: t.method,
      amount: mxn(t.amount),
      tip: mxn(t.tip),
      terminal: t.terminal ? PAYMENTS_P.terminals[t.terminal].name : null,
      platform: t.platform,
      card: t.card ? `${t.card.brand} ${t.card.type} ${t.card.last4}` : null,
      fee: t.fee === null ? null : mxn(t.fee),
      feeSource: t.feeSource,
    })),
    attempts,
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
        tips: mxn(cardTips),
        net: mxn(cardSales + cardTips),
        reported: mxn(sum(byTerminal, (t) => t.net)),
        byTerminal: Object.fromEntries(
          byTerminal.map((t) => [
            `${t.name} (${t.count})`,
            { net: mxn(t.net), batch: mxn(t.net), fees: mxn(t.fees) },
          ]),
        ),
      },
      platforms: Object.fromEntries(
        byPlatform.map((p) => [
          `${p.label} (${p.count})`,
          { net: mxn(p.amount), commission: mxn(p.commission) },
        ]),
      ),
      payments: tenders.length,
      folios: `${orders[0]!.folio} a ${orders.at(-1)!.folio}`,
      tickets: orders.length,
    },
    finance: {
      byTerminal: byTerminal.map((t) => [
        t.name,
        String(t.count),
        mxn(t.amount),
        mxn(t.tips),
        mxn(0),
        mxn(t.fees) + (t.estimated ? " (estimadas)" : ""),
        mxn(t.net - t.fees),
      ]),
      byPlatform: byPlatform.map((p) => [
        p.label,
        String(p.count),
        mxn(p.amount),
        mxn(0),
        mxn(p.commission),
        mxn(p.amount),
        mxn(p.amount - p.commission),
      ]),
      collected: mxn(sum(tenders, (t) => t.amount)),
    },
    exception: {
      number: resolved.number,
      amount: mxn(resolvedRow.total),
      terminal: PAYMENTS_P.terminals.clip.name,
    },
  };
}
