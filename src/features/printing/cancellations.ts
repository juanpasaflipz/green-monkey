import type { Label, Order } from "../../../shared/domain";
import type { KitchenRound } from "../../../shared/service";

/**
 * A printed kitchen cancellation chit ("CANCELACIÓN · NO PREPARAR"): one per round and station,
 * listing the units the kitchen must not prepare (reports 029, FIT-9).
 */
export type KitchenCancellationModel = {
  kind: "void" | "refund";
  /** "#142" */
  label: string;
  callName: string;
  /** "kitchen" | "bar" */
  station: string;
  round: number;
  /** ISO instant of the cancellation. */
  time: string;
  tableName: string | null;
  reason: string;
  lines: { quantity: number; name: Label; optionNames: Label[] }[];
};

/** The reasons of a chit, distinct, in order, joined with "; ". */
function joinReasons(reasons: readonly string[]): string {
  return [...new Set(reasons.map((r) => r.trim()).filter(Boolean))].join("; ");
}
const latest = (times: readonly string[]) =>
  times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));

/**
 * KDS auto-print: one chit per round that shows pending voids first seen in this load
 * (`newVoidIds`). The feed holds only the station filter's rounds, so a bar screen prints bar
 * cancellations only. A chit is a refund chit when every one of its voids is a refund
 * cancellation (discounts 028 adds `kind`); a void without `kind` is a void.
 */
export function cancellationsFromKitchenRounds(
  rounds: readonly KitchenRound[],
  newVoidIds: ReadonlySet<string>,
): KitchenCancellationModel[] {
  return rounds.flatMap((round): KitchenCancellationModel[] => {
    const voids = round.pendingVoids.filter((v) => newVoidIds.has(v.id));
    if (!voids.length) return [];
    const kindOf = (v: (typeof voids)[number]) =>
      (v as { kind?: string }).kind === "refund" ? "refund" : "void";
    return [
      {
        kind: voids.every((v) => kindOf(v) === "refund") ? "refund" : "void",
        label: "#" + round.orderNumber,
        callName: round.callName,
        station: round.station,
        round: round.roundNumber,
        time: latest(voids.map((v) => v.createdAt)),
        tableName: round.tableName,
        reason: joinReasons(voids.map((v) => v.reason)),
        lines: voids.map((v) => ({
          quantity: v.quantity,
          name: v.name,
          optionNames:
            round.lines.find((l) => l.id === v.lineId)?.optionNames ?? [],
        })),
      },
    ];
  });
}

type LineGroup = { round: number; station: string };
const groupKey = (g: LineGroup) => g.round + ":" + g.station;
function grouped<T extends LineGroup>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = groupKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].sort(
    (a, b) =>
      a[0].round - b[0].round ||
      (a[0].station < b[0].station ? -1 : a[0].station > b[0].station ? 1 : 0),
  );
}

/**
 * A selling device with "Imprimir comanda al enviar": after a void, the units newly voided on
 * each line (`after` minus `before`), one chit per (round, station).
 */
export function cancellationsFromVoid(
  before: Order,
  after: Order,
  reason: string,
): KitchenCancellationModel[] {
  const voidedBefore = new Map(
    before.lines.map((l) => [l.id, l.voidedUnits?.length ?? 0]),
  );
  const items = after.lines.flatMap((l) => {
    const delta = (l.voidedUnits?.length ?? 0) - (voidedBefore.get(l.id) ?? 0);
    return delta > 0
      ? [
          {
            round: l.round ?? 1,
            station: l.station,
            quantity: delta,
            name: l.name,
            optionNames: l.optionNames,
          },
        ]
      : [];
  });
  const time =
    (after.voids ?? []).map((v) => v.createdAt).filter(Boolean).length > 0
      ? latest((after.voids ?? []).map((v) => v.createdAt).filter(Boolean))
      : new Date().toISOString();
  return grouped(items).map((group) => ({
    kind: "void",
    label: "#" + after.number,
    callName: after.name,
    station: group[0].station,
    round: group[0].round,
    time,
    tableName: after.tableName ?? null,
    reason: reason.trim(),
    lines: group.map((g) => ({
      quantity: g.quantity,
      name: g.name,
      optionNames: g.optionNames,
    })),
  }));
}

/**
 * The refund batch fields the chits read (discounts 028 RefundBatchView: each line's refunded
 * unit indexes and whether the kitchen still has to cancel them).
 */
export type RefundBatchLines = {
  lines: readonly {
    lineId: string;
    units: readonly number[];
    kitchenPending: boolean;
  }[];
  createdAt?: string;
};

/**
 * A selling device with "Imprimir comanda al enviar": after an item refund, the kitchen-pending
 * lines of the batch (units of rounds not served), one chit per (round, station). Amount
 * refunds have no lines and never print. `reason` is the refund's reason label plus its note.
 */
export function cancellationsFromRefund(
  order: Order,
  batch: RefundBatchLines,
  reason: string,
): KitchenCancellationModel[] {
  const items = batch.lines.flatMap((entry) => {
    const line = order.lines.find((l) => l.id === entry.lineId);
    return entry.kitchenPending && line && entry.units.length > 0
      ? [
          {
            round: line.round ?? 1,
            station: line.station,
            quantity: entry.units.length,
            name: line.name,
            optionNames: line.optionNames,
          },
        ]
      : [];
  });
  return grouped(items).map((group) => ({
    kind: "refund",
    label: "#" + order.number,
    callName: order.name,
    station: group[0].station,
    round: group[0].round,
    time: batch.createdAt ?? new Date().toISOString(),
    tableName: order.tableName ?? null,
    reason: reason.trim(),
    lines: group.map((g) => ({
      quantity: g.quantity,
      name: g.name,
      optionNames: g.optionNames,
    })),
  }));
}
