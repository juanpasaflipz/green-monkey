// Reports (029): the restaurant settings a report reads, from the current row (not the
// session snapshot, which may predate a settings change).
import type { Tx } from "../db.js";
import { DomainError, type Session } from "../../shared/domain.js";

export type ReportRestaurant = {
  name: string;
  currency: string;
  timezone: string;
  cutoff: number;
};

export async function restaurantOf(
  tx: Tx,
  s: Session,
): Promise<ReportRestaurant> {
  const [r] = await tx<
    ReportRestaurant[]
  >`select name, currency, timezone, cutoff from restaurants where id = ${s.tenantId}`;
  if (!r) throw new DomainError("not_found", 404);
  return {
    name: r.name,
    currency: r.currency,
    timezone: r.timezone,
    cutoff: Number(r.cutoff),
  };
}
