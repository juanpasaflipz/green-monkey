import type { KitchenFeed, KitchenRound } from "../../shared/service";

/** A kitchen feed that carries rounds (not an "unchanged" poll). */
export type FullFeed = Extract<KitchenFeed, { unchanged: false }>;

/**
 * What one KDS screen has already shown for its station: the rounds and
 * pending cancellations it has seen, the notes each ticket last showed and,
 * when its last feed was truncated (LD-42), the earliest openedAt in that
 * feed (the open rounds that opened up to then may still be hidden).
 */
export type KdsSeen = {
  rounds: Set<string>;
  voids: Set<string>;
  notes: Map<string, string>;
  hiddenUntil: number | null;
};

export type KdsChanges = {
  seen: KdsSeen;
  /** Tickets new to the kitchen: announced, highlighted and auto-printed. */
  fresh: KitchenRound[];
  /** Seen tickets whose order or round note changed (SVC-R6). */
  noted: KitchenRound[];
  /** Tickets showing a cancellation this screen had not shown. */
  voided: KitchenRound[];
  /** The cancellations first shown by this feed (reports 029 chits). */
  newVoidIds: Set<string>;
};

const notesOf = (x: KitchenRound) => x.orderNote + "\u0000" + x.roundNote;
/**
 * When the round last entered the open set, which is what the newest-200
 * window ranks by (FLK-R9); a feed from a server before 035 has no openedAt.
 */
const openedAt = (x: KitchenRound) => Date.parse(x.openedAt ?? x.createdAt);

/**
 * Compares a full feed with what the screen has shown. The first feed of a
 * station (seen null) fills the seen sets silently.
 *
 * FLK-R1: past the cap the feed carries the most recently opened rounds, so
 * when a ticket leaves the screen (delivered, or its last item cancelled)
 * the next older hidden round slides in. That round was sent long ago, and
 * the kitchen may already have it on paper: it joins silently, with its
 * notes and pending cancellations, like the tickets of a first load. Only a
 * round that opened after the previous truncated feed's earliest openedAt is
 * new: a fresh send, and also a recalled round or a "Preparar ahora"
 * decision (FLK-R9), however long ago the round was created.
 */
export function kdsChanges(seen: KdsSeen | null, r: FullFeed): KdsChanges {
  const voidIds = r.rounds.flatMap((x) => x.pendingVoids.map((v) => v.id));
  const hiddenUntil =
    r.truncated && r.rounds.length ? Math.min(...r.rounds.map(openedAt)) : null;
  if (!seen)
    return {
      seen: {
        rounds: new Set(r.rounds.map((x) => x.id)),
        voids: new Set(voidIds),
        notes: new Map(r.rounds.map((x) => [x.id, notesOf(x)])),
        hiddenUntil,
      },
      fresh: [],
      noted: [],
      voided: [],
      newVoidIds: new Set(),
    };
  const edge = seen.hiddenUntil;
  const unseen = r.rounds.filter((x) => !seen.rounds.has(x.id));
  const slidIn = (x: KitchenRound) => edge !== null && openedAt(x) <= edge;
  for (const x of unseen.filter(slidIn))
    for (const v of x.pendingVoids) seen.voids.add(v.id);
  const fresh = unseen.filter((x) => !slidIn(x));
  // SVC-R6: an order note edited after sending changes a ticket the cook
  // already read; it is announced like a new ticket, never silently.
  const noted = r.rounds.filter(
    (x) =>
      seen.rounds.has(x.id) &&
      seen.notes.has(x.id) &&
      seen.notes.get(x.id) !== notesOf(x),
  );
  const voided = r.rounds.filter((x) =>
    x.pendingVoids.some((v) => !seen.voids.has(v.id)),
  );
  const newVoidIds = new Set(voidIds.filter((id) => !seen.voids.has(id)));
  for (const x of unseen) seen.rounds.add(x.id);
  for (const id of voidIds) seen.voids.add(id);
  for (const x of r.rounds) seen.notes.set(x.id, notesOf(x));
  seen.hiddenUntil = hiddenUntil;
  return { seen, fresh, noted, voided, newVoidIds };
}

/**
 * The count on the manager's "clear previous-day tickets" action, 0 when it
 * is not offered. A truncated feed leaves the oldest rounds out, so the
 * server counts the previous-day ones one clear retires (LD-42, FLK-R5);
 * otherwise the screen counts its own, so a ticket delivered here updates it
 * at once.
 */
export function clearStaleCount(feed: FullFeed | null, role: string): number {
  if (!feed || !["owner", "manager"].includes(role)) return 0;
  return feed.truncated
    ? feed.staleCount
    : feed.rounds.filter((r) => r.businessDate < feed.currentBusinessDate)
        .length;
}
