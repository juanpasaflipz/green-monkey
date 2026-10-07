// Kitchen display client logic (LD-42 newest-200 feed): which tickets a feed
// announces as new (FLK-R1) and the count on the manager's clear action with
// the truncated alert that points to it (FLK-R6).
import { describe, expect, it } from "vitest";
import type { KitchenRound } from "../shared/service";
import {
  clearStaleCount,
  kdsChanges,
  type FullFeed,
  type KdsSeen,
} from "../src/features/kitchenFeed";
import { strings } from "../src/i18n";

const TODAY = "2026-10-06";
const YESTERDAY = "2026-10-05";
const BASE = Date.parse("2026-10-06T15:00:00.000Z");

/** Round n, created n minutes after BASE (higher n = newer). */
function round(n: number, extra: Partial<KitchenRound> = {}): KitchenRound {
  return {
    id: `r${n}`,
    orderId: `o${n}`,
    orderNumber: n,
    roundNumber: 1,
    station: "kitchen",
    state: "active",
    seenAt: null,
    readyAt: null,
    createdAt: new Date(BASE + n * 60000).toISOString(),
    orderCreatedAt: new Date(BASE + n * 60000).toISOString(),
    businessDate: TODAY,
    mode: "takeaway",
    channel: "pos",
    callName: `Cliente ${n}`,
    tableName: null,
    waiterName: "Mesero",
    serviceUpdated: false,
    orderNote: "",
    roundNote: "",
    lines: [],
    pendingVoids: [],
    ...extra,
  };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => round(from + i));

function feed(
  rounds: KitchenRound[],
  truncated = false,
  extra: Partial<FullFeed> = {},
): FullFeed {
  return {
    version: 1,
    unchanged: false,
    serverTime: new Date(BASE + 600 * 60000).toISOString(),
    currentBusinessDate: TODAY,
    rounds,
    recent: [],
    truncated,
    staleCount: 0,
    ...extra,
  };
}

const ids = (rounds: KitchenRound[]) => rounds.map((r) => r.id);
const pendingVoid = (id: string) => ({
  id,
  lineId: "l1",
  quantity: 1,
  name: { es: "Taco", en: "Taco" },
  reason: "Cliente cambió de opinión",
  createdAt: new Date(BASE).toISOString(),
});

describe("kdsChanges: which tickets a KDS announces as new", () => {
  it("fills the seen sets silently on a station's first feed", () => {
    const first = kdsChanges(
      null,
      feed([round(1, { pendingVoids: [pendingVoid("v1")] }), round(2)]),
    );
    expect(first.fresh).toEqual([]);
    expect(first.noted).toEqual([]);
    expect(first.voided).toEqual([]);
    expect([...first.newVoidIds]).toEqual([]);
    expect([...first.seen.rounds]).toEqual(["r1", "r2"]);
    expect([...first.seen.voids]).toEqual(["v1"]);
  });

  it("announces a sent round, an edited note and a new cancellation (unchanged behaviour)", () => {
    const { seen } = kdsChanges(null, feed([round(1), round(2)]));
    const next = kdsChanges(
      seen,
      feed([
        round(1, { orderNote: "Sin cebolla" }),
        round(2, { pendingVoids: [pendingVoid("v2")] }),
        round(3),
      ]),
    );
    expect(ids(next.fresh)).toEqual(["r3"]);
    expect(ids(next.noted)).toEqual(["r1"]);
    expect(ids(next.voided)).toEqual(["r2"]);
    expect([...next.newVoidIds]).toEqual(["v2"]);
    // Shown once: the same feed again announces nothing.
    const again = kdsChanges(
      next.seen,
      feed([
        round(1, { orderNote: "Sin cebolla" }),
        round(2, { pendingVoids: [pendingVoid("v2")] }),
        round(3),
      ]),
    );
    expect([...again.fresh, ...again.noted, ...again.voided]).toEqual([]);
  });

  it("FLK-R1: delivering the oldest ticket of a truncated feed lets the next older round slide in without announcing, highlighting or printing it", () => {
    // 201 open rounds after a reload: r1 is hidden (with a note and a pending
    // cancellation the screen never showed); r2..r201 are on screen.
    const hidden = round(1, {
      orderNote: "Para llevar",
      pendingVoids: [pendingVoid("v1")],
    });
    const loaded = kdsChanges(null, feed(range(2, 201), true));
    // The cook delivers r2: 200 open rounds, all on screen, r1 at the top.
    const slid = kdsChanges(loaded.seen, feed([hidden, ...range(3, 201)]));
    expect(slid.fresh).toEqual([]);
    expect(slid.noted).toEqual([]);
    expect(slid.voided).toEqual([]);
    expect([...slid.newVoidIds]).toEqual([]);
    expect(slid.seen.rounds.has("r1")).toBe(true);
    expect(slid.seen.voids.has("v1")).toBe(true);
    // A ticket sent afterwards is new as always, and r1 stays quiet.
    const sent = kdsChanges(
      slid.seen,
      feed([hidden, ...range(3, 201), round(202)]),
    );
    expect(ids(sent.fresh)).toEqual(["r202"]);
    expect(sent.voided).toEqual([]);
  });

  it("FLK-R1: rounds keep sliding in quietly while the feed stays truncated, and a round sent meanwhile is still new", () => {
    // 203 open: r1 and r2 hidden behind r3..r202.
    const loaded = kdsChanges(null, feed(range(3, 202), true));
    // r3 is delivered (a fully cancelled round acknowledged works the same
    // way) and r203 is sent in the same interval: r2 slides in.
    const first = kdsChanges(
      loaded.seen,
      feed([round(2), ...range(4, 203)], true),
    );
    expect(ids(first.fresh)).toEqual(["r203"]);
    // r4 is delivered: r1 slides in under the new oldest edge.
    const second = kdsChanges(
      first.seen,
      feed([round(1), round(2), ...range(5, 203)], true),
    );
    expect(second.fresh).toEqual([]);
    expect(second.voided).toEqual([]);
  });

  it("without truncation an unseen round is new whatever its age (nothing was hidden)", () => {
    // E.g. a round recalled after a reload: the screen never showed it.
    const { seen } = kdsChanges(null, feed(range(5, 10)));
    const next = kdsChanges(seen, feed([round(1), ...range(5, 10)]));
    expect(ids(next.fresh)).toEqual(["r1"]);
  });

  it("a station's first feed being truncated hides nothing new later", () => {
    const { seen } = kdsChanges(null, feed(range(2, 201), true));
    expect(seen.hiddenUntil).toBe(Date.parse(round(2).createdAt));
    const after: KdsSeen = kdsChanges(seen, feed(range(2, 201))).seen;
    expect(after.hiddenUntil).toBeNull();
  });
});

describe("clearStaleCount and the truncated alert (FLK-R6)", () => {
  // A truncated feed whose visible rounds are all of today: the previous-day
  // ones it hides come only from the server's count.
  const truncated = feed(range(2, 201), true, { staleCount: 7 });

  it("a manager sees the clear action with the server's count when the feed is truncated", () => {
    expect(
      truncated.rounds.some((r) => r.businessDate < TODAY),
      "no previous-day round among the visible ones",
    ).toBe(false);
    for (const role of ["owner", "manager"])
      expect(clearStaleCount(truncated, role)).toBe(7);
    expect(
      strings.es.serviceKdsClearStale.replace(
        "{n}",
        String(clearStaleCount(truncated, "manager")),
      ),
    ).toBe("Retirar tickets de días anteriores (7)");
    expect(
      strings.en.serviceKdsClearStale.replace(
        "{n}",
        String(clearStaleCount(truncated, "owner")),
      ),
    ).toBe("Clear tickets from previous days (7)");
  });

  it("other roles are not offered the action", () => {
    for (const role of ["kitchen", "server", "cashier"])
      expect(clearStaleCount(truncated, role)).toBe(0);
    expect(clearStaleCount(null, "manager")).toBe(0);
  });

  it("without truncation the screen counts its own previous-day tickets", () => {
    const shown = feed(
      [
        round(1, { businessDate: YESTERDAY }),
        round(2, { businessDate: YESTERDAY }),
        round(3),
      ],
      false,
      { staleCount: 99 },
    );
    expect(clearStaleCount(shown, "manager")).toBe(2);
  });

  it("the truncated alert names the clear action in both languages", () => {
    for (const locale of ["es", "en"] as const) {
      const action = strings[locale].serviceKdsClearStale.replace(
        / \(\{n\}\)$/,
        "",
      );
      expect(action).not.toContain("{n}");
      expect(strings[locale].serviceKdsTruncated).toContain(action);
    }
  });
});
