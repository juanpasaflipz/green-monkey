import { z } from "zod";
import { Decimal } from "decimal.js";
import { Temporal } from "@js-temporal/polyfill";
export type Locale = "es" | "en";
export type Label = { es: string; en: string };
export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const money = z.number().int().min(0).max(100_000_000);
export const id = z.string().uuid();
export const lineInput = z
  .object({
    id: id,
    productId: id,
    quantity: z.number().int().min(1).max(99),
    options: z.array(id).max(30).default([]),
    note: z.string().max(300).default(""),
    openAmount: money.optional(),
  })
  .strict();
export const orderInput = z
  .object({
    operationId: id,
    lines: z.array(lineInput).min(1).max(100),
    mode: z.enum(["takeaway", "dine_in", "delivery"]),
    tableId: id.nullable().default(null),
    name: z.string().max(80).default(""),
    note: z.string().max(500).default(""),
    channel: z.enum(["pos", "qr", "kiosk", "offline"]).default("pos"),
  })
  .strict();
export type OrderInput = z.infer<typeof orderInput>;
export type LineInput = z.infer<typeof lineInput>;
export type Option = {
  id: string;
  name: Label;
  price: number;
  available: boolean;
};
export type Group = {
  id: string;
  name: Label;
  min: number;
  max: number;
  options: Option[];
};
export type Product = {
  id: string;
  name: Label;
  category: Label;
  price: number;
  available: boolean;
  station: "kitchen" | "bar";
  groups: Group[];
  openAmount?: boolean;
  recipe?: { stockId: string; quantity: string }[];
  cost: number | null;
  version: number;
};
export type PricedLine = LineInput & {
  name: Label;
  optionNames: Label[];
  unitPrice: number;
  total: number;
  cost: number | null;
  station: string;
  recipe: NonNullable<Product["recipe"]>;
  productVersion: number;
};
export function minor(value: string, exponent = 2): number {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new DomainError("invalid_amount");
  const n = new Decimal(value)
    .mul(new Decimal(10).pow(exponent))
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  return money.parse(n);
}
export function sum(values: number[]): number {
  const n = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(n) || Math.abs(n) > 100_000_000)
    throw new DomainError("invalid_amount");
  return n;
}
export function allocate(total: number, weights: number[]): number[] {
  money.parse(total);
  if (
    !weights.length ||
    weights.some((w) => !Number.isSafeInteger(w) || w < 0) ||
    sum(weights) <= 0
  )
    throw new DomainError("invalid_split");
  const denominator = BigInt(sum(weights));
  let left = total;
  const parts = weights.map((w) => {
    const p = Number((BigInt(total) * BigInt(w)) / denominator);
    left -= p;
    return p;
  });
  for (let i = 0; left > 0; i = (i + 1) % parts.length)
    if (weights[i] > 0) {
      parts[i]++;
      left--;
    }
  return parts;
}
export function quote(
  lines: LineInput[],
  catalog: Product[],
  canOpen = false,
): PricedLine[] {
  if (new Set(lines.map((l) => l.id)).size !== lines.length)
    throw new DomainError("duplicate_line");
  return lines.map((raw) => {
    const l = lineInput.parse(raw);
    const p = catalog.find((p) => p.id === l.productId);
    if (!p || !p.available) throw new DomainError("unavailable");
    if (l.openAmount !== undefined && (!p.openAmount || !canOpen))
      throw new DomainError("forbidden", 403);
    if (p.openAmount && l.openAmount === undefined)
      throw new DomainError("invalid_amount");
    if (new Set(l.options).size !== l.options.length)
      throw new DomainError("invalid_modifier");
    const opts = p.groups.flatMap((g) => g.options);
    if (l.options.some((o) => !opts.some((x) => x.id === o && x.available)))
      throw new DomainError("invalid_modifier");
    for (const g of p.groups) {
      const n = g.options.filter((o) => l.options.includes(o.id)).length;
      if (n < g.min || n > g.max) throw new DomainError("required_modifier");
    }
    const unitPrice = sum([
      l.openAmount ?? p.price,
      ...opts.filter((o) => l.options.includes(o.id)).map((o) => o.price),
    ]);
    return {
      ...l,
      name: p.name,
      optionNames: opts
        .filter((o) => l.options.includes(o.id))
        .map((o) => o.name),
      unitPrice,
      total: money.parse(unitPrice * l.quantity),
      cost: p.cost,
      station: p.station,
      recipe: p.recipe ?? [],
      productVersion: p.version,
    };
  });
}
export function discount(total: number, basisPoints: number) {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000)
    throw new DomainError("invalid_discount");
  return Number(
    (BigInt(money.parse(total)) * BigInt(basisPoints) + 5000n) / 10000n,
  );
}
export function tax(amount: number, bps: number, inclusive: boolean) {
  const n = discount(amount, bps);
  return inclusive
    ? Number(
        (BigInt(amount) * BigInt(bps) + BigInt(Math.floor((10000 + bps) / 2))) /
          BigInt(10000 + bps),
      )
    : n;
}
const units: Record<string, { kind: string; factor: string }> = {
  g: { kind: "mass", factor: "1" },
  kg: { kind: "mass", factor: "1000" },
  ml: { kind: "volume", factor: "1" },
  l: { kind: "volume", factor: "1000" },
  piece: { kind: "count", factor: "1" },
};
export function convert(value: string, from: string, to: string): string {
  const a = units[from],
    b = units[to];
  if (!a || !b || a.kind !== b.kind || !new Decimal(value).isFinite())
    throw new DomainError("invalid_unit");
  return new Decimal(value).mul(a.factor).div(b.factor).toFixed(6);
}
export function businessDate(instant: string, zone: string, cutoff: number) {
  const local = Temporal.Instant.from(instant).toZonedDateTimeISO(zone);
  const date = local.toPlainDate();
  return (
    local.hour * 60 + local.minute < cutoff ? date.subtract({ days: 1 }) : date
  ).toString();
}
export function boundaries(date: string, zone: string, cutoff: number) {
  const day = Temporal.PlainDate.from(date);
  const time = Temporal.PlainTime.from({
    hour: Math.floor(cutoff / 60),
    minute: cutoff % 60,
  });
  return {
    start: day
      .toZonedDateTime({ timeZone: zone, plainTime: time })
      .toInstant()
      .toString(),
    end: day
      .add({ days: 1 })
      .toZonedDateTime({ timeZone: zone, plainTime: time })
      .toInstant()
      .toString(),
  };
}
export function nextPreparation(current: string, next: string) {
  const allowed: Record<string, string[]> = {
    active: ["ready"],
    ready: ["completed"],
    completed: [],
  };
  if (!allowed[current]?.includes(next))
    throw new DomainError("invalid_transition", 409);
  return next;
}
export function finance(input: {
  gross: number;
  discounts: number;
  refunds: number;
  taxes: number;
  tips: number;
  cogs: number;
  fees: number;
  commissions: number;
  expenses: number;
}) {
  const netSales = input.gross - input.discounts - input.refunds - input.taxes;
  return {
    ...input,
    netSales,
    contribution: netSales - input.cogs - input.fees - input.commissions,
    profit:
      netSales - input.cogs - input.fees - input.commissions - input.expenses,
  };
}
export function forecast(
  sales: number,
  costs: number,
  salesChange: number,
  costChange: number,
) {
  const projectedSales = Math.round(sales * (1 + salesChange));
  const projectedCosts = Math.round(costs * (1 + costChange));
  return {
    sales: projectedSales,
    costs: projectedCosts,
    profit: projectedSales - projectedCosts,
    estimate: true,
  };
}
export type Session = {
  id: string;
  tenantId: string;
  employeeId: string;
  name: string;
  role: string;
  deviceId: string;
  expiresAt: string;
  offlineUntil: string;
  csrf: string;
  restaurant: {
    name: string;
    currency: string;
    timezone: string;
    cutoff: number;
  };
};
export type Order = {
  serviceVersion?: number;
  assignedEmployeeId?: string;
  waiterName?: string;
  tableName?: string | null;
  restaurantSnapshot?: Session["restaurant"] | null;
  itemSplitAvailable?: boolean;
  paymentUnits?: import("./settlement.js").PayableUnit[];
  id: string;
  number: number;
  version: number;
  mode: string;
  tableId: string | null;
  name: string;
  note: string;
  lines: PricedLine[];
  total: number;
  paid: number;
  refunded: number;
  state: string;
  createdAt: string;
  rounds: any[];
  tenders: any[];
};

export function currencyExponent(currency: string): number {
  return (
    new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2
  );
}
