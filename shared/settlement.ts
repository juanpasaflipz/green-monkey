import {
  allocate,
  DomainError,
  money,
  sum,
  type Label,
  type PricedLine,
} from "./domain.js";
export type Allocation = { lineId: string; unit: number; amount: number };
export type PayableUnit = {
  key: string;
  lineId: string;
  unit: number;
  name: Label;
  total: number;
  paid: number;
  due: number;
};
export function payableUnits(
  lines: PricedLine[],
  allocations: Allocation[],
): PayableUnit[] {
  const units = lines.flatMap((line) =>
    allocate(line.total, Array(line.quantity).fill(1)).map((total, unit) => ({
      key: `${line.id}:${unit}`,
      lineId: line.id,
      unit,
      name: line.name,
      total,
      paid: 0,
      due: total,
    })),
  );
  const byKey = new Map(units.map((unit) => [unit.key, unit]));
  for (const allocation of allocations) {
    const unit = byKey.get(`${allocation.lineId}:${allocation.unit}`);
    if (!unit) throw new DomainError("invalid_allocation", 409);
    unit.paid = sum([unit.paid, money.parse(allocation.amount)]);
    unit.due = unit.total - unit.paid;
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
