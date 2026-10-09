/**
 * §5.1 oracle self-check: the oracle's day deep-equals the hand-typed tables.
 * Breakdown rows are compared as sets (the spec prints them in its own order).
 */
import { EXPECTED } from "./expected.js";
import { oracle } from "./oracle.js";

const BY_NAME = ["byProduct", "byCategory", "byEmployee", "byWaiter"] as const;

function sortRows<T extends Record<string, unknown>>(day: T): T {
  const copy: Record<string, unknown> = { ...day };
  for (const key of BY_NAME)
    if (Array.isArray(copy[key]))
      copy[key] = [...(copy[key] as Array<{ name: string }>)].sort((a, b) =>
        a.name.localeCompare(b.name, "es"),
      );
  return copy as T;
}

export function oracleDay() {
  const day = oracle();
  return { A: sortRows(day.A), B: sortRows(day.B), L: day.L };
}

export function expectedDay() {
  return { A: sortRows(EXPECTED.A), B: sortRows(EXPECTED.B), L: EXPECTED.L };
}
