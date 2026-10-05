/**
 * How orders are named on receipts and in the cart (§2.4, OFF-R22): the
 * provisional number and its "assigned when it syncs" hint only while the
 * device alone knows the order; afterwards "B-07 → #142".
 */
import { describe, expect, it } from "vitest";
import { orderLabel, provisionalOnly } from "../src/features/offline/format";

const id = "00000000-0000-4000-8000-000000000142";

describe("order labels (OFF-R22)", () => {
  it("a local receipt shows its provisional number and the hint", () => {
    const local = { id, number: 0, offline: { provisionalNumber: "B-07" } };
    expect(orderLabel(local)).toBe("B-07");
    expect(provisionalOnly(local)).toBe(true);
  });

  it("a synced order shows both numbers and never the hint", () => {
    const synced = { id, number: 142, offline: { provisionalNumber: "B-07" } };
    expect(orderLabel(synced)).toBe("B-07 → #142");
    expect(provisionalOnly(synced)).toBe(false);
  });

  it("an online order shows its server number only", () => {
    expect(orderLabel({ id, number: 142, offline: null })).toBe("#142");
    expect(provisionalOnly({ number: 142, offline: null })).toBe(false);
    // A legacy record without a number falls back to its id prefix.
    expect(orderLabel({ id, number: 0 })).toBe("#00000000");
  });
});
