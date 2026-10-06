import {
  allocate,
  DomainError,
  money,
  sum,
  type Label,
  type PricedLine,
} from "./domain.js";
import type { UnitDiscount } from "./discounts.js";
export type Allocation = { lineId: string; unit: number; amount: number };
export type PayableUnit = {
  key: string;
  lineId: string;
  unit: number;
  name: Label;
  total: number;
  /** discounts (028): active discount allocations on this unit (tax-inclusive). */
  discount: number;
  /** discounts (028): an active line-level discount covers this unit (no stacking). */
  lineDiscounted: boolean;
  paid: number;
  due: number;
};
/**
 * Every payable unit of the lines with what was paid and what is still due:
 * due = gross - active discount - paid. Discounts (028) pass the active unit
 * discounts of the order; two-argument callers see no discounts.
 */
export function payableUnits(
  lines: PricedLine[],
  allocations: Allocation[],
  discounts: readonly UnitDiscount[] = [],
): PayableUnit[] {
  const units: PayableUnit[] = lines.flatMap((line) =>
    allocate(line.total, Array(line.quantity).fill(1)).map((total, unit) => ({
      key: `${line.id}:${unit}`,
      lineId: line.id,
      unit,
      name: line.name,
      total,
      discount: 0,
      lineDiscounted: false,
      paid: 0,
      due: total,
    })),
  );
  const byKey = new Map(units.map((unit) => [unit.key, unit]));
  for (const d of discounts) {
    const unit = byKey.get(`${d.lineId}:${d.unit}`);
    if (!unit) throw new DomainError("invalid_allocation", 409);
    unit.discount = sum([unit.discount, money.parse(d.amount)]);
    if (d.scope === "line") unit.lineDiscounted = true;
    unit.due = unit.total - unit.discount;
    if (unit.due < 0) throw new DomainError("invalid_allocation", 409);
  }
  for (const allocation of allocations) {
    const unit = byKey.get(`${allocation.lineId}:${allocation.unit}`);
    if (!unit) throw new DomainError("invalid_allocation", 409);
    unit.paid = sum([unit.paid, money.parse(allocation.amount)]);
    unit.due = unit.total - unit.discount - unit.paid;
    if (unit.due < 0) throw new DomainError("invalid_allocation", 409);
  }
  return units;
}
export function allocatePayment(
  units: PayableUnit[],
  amount: number,
  selected?: string[],
): Allocation[] {
  money.parse(amount);
  if (amount <= 0) throw new DomainError("invalid_amount");
  let candidates = units.filter((u) => u.due > 0);
  if (selected !== undefined) {
    if (!selected.length || new Set(selected).size !== selected.length)
      throw new DomainError("invalid_split");
    candidates = units.filter((u) => selected.includes(u.key));
    if (
      candidates.length !== selected.length ||
      candidates.some((u) => u.due <= 0) ||
      sum(candidates.map((u) => u.due)) !== amount
    )
      throw new DomainError("items_changed", 409);
  }
  let left = amount;
  const allocations: Allocation[] = [];
  for (const unit of candidates) {
    const n = Math.min(left, unit.due);
    if (n > 0)
      allocations.push({ lineId: unit.lineId, unit: unit.unit, amount: n });
    left -= n;
  }
  if (left) throw new DomainError("overpayment", 409);
  return allocations;
}

/** Quantity and amount still standing on a line after voids. */
export function lineRemaining(line: PricedLine): {
  quantity: number;
  total: number;
} {
  const voided = new Set(line.voidedUnits ?? []);
  if (!voided.size) return { quantity: line.quantity, total: line.total };
  const units = allocate(line.total, Array(line.quantity).fill(1));
  return {
    quantity: line.quantity - voided.size,
    total: sum(units.filter((_, unit) => !voided.has(unit))),
  };
}
