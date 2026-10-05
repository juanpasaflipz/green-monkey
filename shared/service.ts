import { z } from "zod";
import {
  DomainError,
  minor,
  quote,
  type Label,
  type LineInput,
  type PricedLine,
  type Product,
} from "./domain.js";

/** Financial lifecycle of a check, independent of the kitchen state. */
export type CheckState = "open" | "paid" | "closed";
export type CloseReason = "settled" | "released" | "voided" | "recovery";

export type OrderSummary = {
  id: string;
  number: number;
  businessDate: string;
  createdAt: string;
  mode: string;
  channel: string;
  tableId: string | null;
  tableName: string | null;
  name: string;
  note: string;
  waiterName: string;
  serviceState: string;
  checkState: CheckState;
  closedAt: string | null;
  closeReason: CloseReason | null;
  total: number;
  paid: number;
  refunded: number;
  balance: number;
  refundableCash: number;
  itemCount: number;
  preview: { quantity: number; name: Label }[];
  previewMore: number;
  openRounds: number;
  readyRounds: number;
  recovery: boolean;
  voidAckPending: boolean;
};
export type OrderListResponse = {
  items: OrderSummary[];
  nextCursor: string | null;
  businessDate: string;
};
export type TableCheck = {
  id: string;
  number: number;
  name: string;
  createdAt: string;
  businessDate: string;
  waiterName: string;
  total: number;
  paid: number;
  balance: number;
  checkState: CheckState;
  openRounds: number;
  readyRounds: number;
};
export type TableOccupancy = { id: string; name: string; checks: TableCheck[] };
export type KitchenLine = {
  id: string;
  quantity: number;
  voidedQuantity: number;
  name: Label;
  optionNames: Label[];
  note: string;
};
export type KitchenPendingVoid = {
  id: string;
  lineId: string;
  quantity: number;
  name: Label;
  reason: string;
  createdAt: string;
};
export type KitchenRound = {
  id: string;
  orderId: string;
  orderNumber: number;
  roundNumber: number;
  station: string;
  state: string;
  seenAt: string | null;
  readyAt: string | null;
  createdAt: string;
  orderCreatedAt: string;
  businessDate: string;
  mode: string;
  channel: string;
  callName: string;
  tableName: string | null;
  waiterName: string;
  serviceUpdated: boolean;
  orderNote: string;
  roundNote: string;
  lines: KitchenLine[];
  pendingVoids: KitchenPendingVoid[];
};
export type KitchenRecent = {
  id: string;
  orderNumber: number;
  callName: string;
  tableName: string | null;
  roundNumber: number;
  station: string;
  completedAt: string;
};
export type KitchenFeed =
  | { version: number; unchanged: true; serverTime: string }
  | {
      version: number;
      unchanged: false;
      serverTime: string;
      currentBusinessDate: string;
      rounds: KitchenRound[];
      recent: KitchenRecent[];
      truncated: boolean;
    };

export const RECALL_WINDOW_MINUTES = 120;
export const KITCHEN_FEED_LIMIT = 200;
export const ORDER_PAGE_MAX = 100;

/** Dine-in with a table and not an offline sale: stays "paid" until released. */
export function holdsTable(o: {
  mode: string;
  tableId?: string | null;
  table_id?: string | null;
  channel: string;
}): boolean {
  return (
    o.mode === "dine_in" &&
    (o.tableId ?? o.table_id ?? null) !== null &&
    o.channel !== "offline"
  );
}

/** A bumped (completed) round can only return to ready. */
export function recallPreparation(current: string): "ready" {
  if (current !== "completed")
    throw new DomainError("round_not_recallable", 409);
  return "ready";
}

const thousands = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
/**
 * es-MX money input. Trims, removes "$" and spaces, accepts thousands commas
 * only in valid three-digit groups, and treats "" as 0 when allowed.
 */
export function parseMoneyInput(
  raw: string,
  exponent: number,
  opts: { emptyAsZero?: boolean } = {},
): number {
  const text = String(raw ?? "").replace(/[\s$]/g, ""); // \s covers no-break spaces
  if (!text) {
    if (opts.emptyAsZero) return 0;
    throw new DomainError("invalid_amount");
  }
  let plain = text;
  if (text.includes(",")) {
    if (!thousands.test(text)) throw new DomainError("invalid_amount");
    plain = text.replace(/,/g, "");
  }
  try {
    return minor(plain, exponent);
  } catch {
    throw new DomainError("invalid_amount");
  }
}

/** MXN bills in circulation, in pesos. */
const MXN_BILLS = [20, 50, 100, 200, 500, 1000];
/**
 * Exact amount first, then the next multiple of each MXN bill strictly above
 * `total`, unique, at most three extra. Other currencies get the exact amount.
 */
export function cashSuggestions(
  total: number,
  currency: string,
  exponent: number,
): number[] {
  if (currency !== "MXN") return [total];
  const unit = 10 ** exponent;
  const next = MXN_BILLS.map((bill) => {
    const b = bill * unit;
    return Math.floor(total / b) * b + b;
  });
  const extra = [...new Set(next)]
    .filter((n) => n > total)
    .sort((a, b) => a - b)
    .slice(0, 3);
  return [total, ...extra];
}

export function changeDue(received: number, amount: number, tip: number) {
  return Math.max(0, received - amount - tip);
}

/** A voluntary tip suggestion, rounded to the whole currency unit. */
export function tipFromPercent(
  amount: number,
  percent: 10 | 15,
  exponent: number,
): number {
  const unit = 10 ** exponent;
  return Math.round((amount * percent) / (100 * unit)) * unit;
}

export type PaymentValues = {
  amount: number;
  tip: number;
  received: number;
  method: "cash" | "external";
  reference: string;
  confirmed: boolean;
};
export type PaymentProblem = {
  field: "drawer" | "amount" | "tip" | "received" | "reference" | "confirmed";
  key: string;
};
/** Pure validation used by PaymentDialog; `key` is an i18n key from src/i18n/service.ts. */
export function validatePayment(input: {
  amountText: string;
  tipText: string;
  receivedText: string;
  method: "cash" | "external";
  reference: string;
  confirmed: boolean;
  due: number;
  exponent: number;
  drawerOpen: boolean;
  online: boolean;
}):
  { ok: true; values: PaymentValues } | { ok: false; problem: PaymentProblem } {
  const fail = (field: PaymentProblem["field"], key: string) =>
    ({ ok: false, problem: { field, key } }) as const;
  if (input.online && !input.drawerOpen)
    return fail("drawer", "servicePayDrawer");
  let amount: number;
  try {
    amount = parseMoneyInput(input.amountText, input.exponent);
  } catch {
    return fail("amount", "servicePayAmountInvalid");
  }
  if (amount === 0) return fail("amount", "servicePayAmountZero");
  if (amount > input.due) return fail("amount", "servicePayAmountExceeds");
  let tip: number;
  try {
    tip = parseMoneyInput(input.tipText, input.exponent, { emptyAsZero: true });
  } catch {
    return fail("tip", "servicePayTipInvalid");
  }
  if (input.method === "cash") {
    let received: number;
    try {
      received = parseMoneyInput(input.receivedText, input.exponent);
    } catch {
      return fail("received", "servicePayReceivedShort");
    }
    if (received < amount + tip)
      return fail("received", "servicePayReceivedShort");
    return {
      ok: true,
      values: {
        amount,
        tip,
        received,
        method: "cash",
        reference: "",
        confirmed: false,
      },
    };
  }
  if (!input.reference.trim())
    return fail("reference", "servicePayReferenceRequired");
  if (!input.confirmed) return fail("confirmed", "servicePayConfirmRequired");
  return {
    ok: true,
    values: {
      amount,
      tip,
      received: amount + tip,
      method: "external",
      reference: input.reference.trim(),
      confirmed: true,
    },
  };
}

export type CartLine = {
  input: LineInput;
  priced: PricedLine | null;
  error: string | null;
};
/** Prices each line on its own, so one unavailable product never blanks the cart. */
export function priceCart(
  lines: LineInput[],
  catalog: Product[],
  canOpen: boolean,
): { lines: CartLine[]; total: number; blocked: boolean } {
  const result = lines.map((input): CartLine => {
    try {
      return {
        input,
        priced: quote([input], catalog, canOpen)[0],
        error: null,
      };
    } catch (e) {
      return {
        input,
        priced: null,
        error: e instanceof DomainError ? e.code : "invalid_input",
      };
    }
  });
  return {
    lines: result,
    total: result.reduce((a, l) => a + (l.priced?.total ?? 0), 0),
    blocked: result.some((l) => l.error !== null),
  };
}

const sameOptions = (a: readonly string[] = [], b: readonly string[] = []) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();
/**
 * Adds one unit of a product. A line with the same product, the same sorted
 * option multiset, an empty note, no open amount and fewer than 99 units is
 * incremented; anything else (including every open-amount line) is appended.
 */
export function mergeLine(
  lines: LineInput[],
  product: Product,
  selection: { options: string[]; openAmount?: number },
): { lines: LineInput[]; lineId: string } {
  if (selection.openAmount === undefined && !product.openAmount) {
    const match = lines.find(
      (l) =>
        l.productId === product.id &&
        l.openAmount === undefined &&
        !(l.note ?? "").trim() &&
        sameOptions(l.options ?? [], selection.options) &&
        l.quantity < 99,
    );
    if (match)
      return {
        lineId: match.id,
        lines: lines.map((l) =>
          l.id === match.id ? { ...l, quantity: l.quantity + 1 } : l,
        ),
      };
  }
  const line: LineInput = {
    id: crypto.randomUUID(),
    productId: product.id,
    quantity: 1,
    options: selection.options,
    note: "",
    ...(selection.openAmount !== undefined
      ? { openAmount: selection.openAmount }
      : {}),
  };
  return { lines: [...lines, line], lineId: line.id };
}

const cursorTime =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[ T]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;
export const orderCursor = z
  .object({
    t: z.string().min(10).max(64).regex(cursorTime),
    i: z.string().uuid(),
  })
  .strict();
const toBase64Url = (s: string) =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (s: string) =>
  atob(s.replace(/-/g, "+").replace(/_/g, "/"));
/** Opaque keyset cursor: base64url(JSON {t: created_at text, i: id}). */
export function encodeCursor(c: { t: string; i: string }): string {
  return toBase64Url(JSON.stringify(orderCursor.parse(c)));
}
export function decodeCursor(s: string): { t: string; i: string } {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(s)) throw Error("format");
    return orderCursor.parse(JSON.parse(fromBase64Url(s)));
  } catch {
    throw new DomainError("invalid_input");
  }
}

export function paymentStatus(o: {
  total: number;
  paid: number;
  refunded: number;
}): "unpaid" | "partial" | "paid" | "refunded" {
  if (o.refunded > 0) return "refunded";
  if (o.paid > 0 && o.paid >= o.total) return "paid";
  if (o.paid > 0) return "partial";
  return "unpaid";
}
export function kitchenStatus(o: {
  openRounds: number;
  readyRounds: number;
}): "preparing" | "ready" | "served" {
  if (o.openRounds === 0) return "served";
  return o.readyRounds >= o.openRounds ? "ready" : "preparing";
}

/** Matches allergy notes in Spanish and English ("alergia", "alérgico", "allergy"). */
export const ALLERGY_PATTERN = /al+[eé]rg/i;

/**
 * The non-empty round notes of an order, one per round number in round order,
 * leaving out notes identical to the order note (as kitchen tickets do).
 */
export function roundNotes(order: {
  note?: string | null;
  rounds?: readonly { number: number; note?: string | null }[] | null;
}): { round: number; note: string }[] {
  const notes = new Map<number, string>();
  for (const r of order.rounds ?? []) {
    const note = (r.note ?? "").trim();
    if (note && note !== (order.note ?? "").trim() && !notes.has(r.number))
      notes.set(r.number, note);
  }
  return [...notes]
    .sort(([a], [b]) => a - b)
    .map(([round, note]) => ({ round, note }));
}

/** The fields of a cart or order line that decide what the kitchen makes. */
type LostSendLine = {
  id: string;
  quantity: number;
  options?: readonly string[];
  note?: string;
  openAmount?: number;
};
/**
 * FOH-11: an earlier send with the draft's operation id committed, but its
 * response was lost and the cart changed since. Each draft line the order
 * already holds is compared with the stored line:
 * - identical (quantity, option set, note, open amount): it leaves the draft;
 * - only the quantity grew: the extra units stay, as a new line (new id) with
 *   the same product, options and note;
 * - anything else changed (note, options, open amount, or fewer units): a copy
 *   with a new id stays in the cart for the cashier to review.
 * Lines the order does not hold stay as they are. The operation id is replaced
 * (the old one is consumed) and the note is dropped when it already reached
 * the order. `sent` is true when nothing is left to send; `changed` is true
 * when a line that had already landed was edited afterwards, so Selling must
 * ask the cashier to review before sending; `rounds` lists the rounds where
 * draft lines landed.
 */
export function reconcileLostSend<
  L extends LostSendLine,
  D extends { operationId: string; lines: L[]; note: string },
>(
  draft: D,
  order: {
    note?: string | null;
    lines: readonly (LostSendLine & { round?: number })[];
    rounds?: readonly { note?: string | null }[] | null;
  },
  operationId: string,
  newId: () => string = () => crypto.randomUUID(),
): { draft: D; sent: boolean; changed: boolean; rounds: number[] } {
  const onOrder = new Map(order.lines.map((l) => [l.id, l]));
  const rounds = new Set<number>();
  let changed = false;
  const lines = draft.lines.flatMap((l): L[] => {
    const stored = onOrder.get(l.id);
    if (!stored) return [l];
    rounds.add(stored.round ?? 0);
    const sameKind =
      sameOptions(l.options, stored.options) &&
      (l.note ?? "") === (stored.note ?? "") &&
      (l.openAmount ?? null) === (stored.openAmount ?? null);
    if (sameKind && l.quantity === stored.quantity) return [];
    changed = true;
    if (sameKind && l.quantity > stored.quantity)
      return [{ ...l, id: newId(), quantity: l.quantity - stored.quantity }];
    return [{ ...l, id: newId() }];
  });
  const note = draft.note.trim();
  const noteDelivered =
    !note ||
    note === (order.note ?? "").trim() ||
    (order.rounds ?? []).some((r) => (r.note ?? "").trim() === note);
  return {
    draft: {
      ...draft,
      operationId,
      lines,
      note: noteDelivered ? "" : draft.note,
    },
    sent: lines.length === 0,
    changed,
    rounds: [...rounds].sort((a, b) => a - b),
  };
}
