import type { Tx } from "./db.js";
import { permit, managers } from "./auth.js";
import { once, audit } from "./orders.js";
import { restaurantSettings } from "../shared/restaurant.js";
import { DomainError, type Session } from "../shared/domain.js";
type Settings = {
  name: string;
  currency: string;
  timezone: string;
  cutoff: number;
  openingDays: number[];
  version: number;
};
export async function getSettings(tx: Tx, s: Session) {
  permit(s, managers);
  const [r] = await tx<
    Settings[]
  >`select name,currency,timezone,cutoff,opening_days as "openingDays",config_version as version from restaurants where id=${s.tenantId}`;
  const [used] =
    await tx`select exists(select 1 from catalog) or exists(select 1 from orders) or exists(select 1 from cash_sessions) or exists(select 1 from expenses) or exists(select 1 from receipts) or exists(select 1 from shifts) as locked`;
  return { ...r, currencyLocked: used.locked };
}
export async function saveSettings(tx: Tx, s: Session, raw: unknown) {
  permit(s, ["owner"]);
  const p = restaurantSettings.parse(raw);
  return once(tx, s, p.operationId, "restaurant.settings", p, async () => {
    await tx`select id from restaurants where id=${s.tenantId} for update`;
    const old = await getSettings(tx, s);
    if (old.version !== p.expectedVersion)
      throw new DomainError("settings_changed", 409);
    if (old.currencyLocked && old.currency !== p.currency)
      throw new DomainError("currency_locked", 409);
    await tx`update restaurants set name=${p.name},currency=${p.currency},timezone=${p.timezone},cutoff=${p.cutoff},opening_days=${p.openingDays},config_version=config_version+1 where id=${s.tenantId}`;
    await audit(tx, s, "restaurant.settings", s.tenantId, {
      before: old,
      after: { ...p, operationId: undefined },
    });
    return getSettings(tx, s);
  });
}
