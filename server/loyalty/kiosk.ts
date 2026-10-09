/**
 * Loyalty's server interface for the self-service kiosk (039), per the Wave 4 critic R20–R23 and
 * LD-72: kiosk owns the screens, the device-bound route (POST /api/public/kiosk/member) and the
 * order path; loyalty provides these functions. There is no enrolment at the kiosk and no name on
 * its screen: a lookup returns counts and a masked phone only. Members join on their own phone
 * through /club (join.ts). Web only.
 *
 *   lookupMemberForKiosk(tx, {phone, country}, {stationId})  → KioskMemberView (with memberToken)
 *   issueKioskMemberToken(tenantId, memberId, stationId)      → seal("loyalty-member", {t, m, s}, 900 s)
 *   memberFromToken(tx, token, {tenantId, stationId})         → member id, or loyalty_member_token_invalid
 *   linkFromKiosk (links.ts), reconcileOrder + orderLoyaltyView (ledger.ts),
 *   joinUrlForOrder (links.ts), loyaltyKioskConfig (below).
 */
import type { Tx } from "../db.js";
import { seal, unseal } from "../tokens.js";
import { entitlement } from "../entitlements.js";
import { DomainError } from "../../shared/domain.js";
import {
  kioskLookupInput,
  maskPhone,
  parsePhone,
  type KioskMemberView,
  type LoyaltyKioskConfig,
} from "../../shared/loyalty.js";
import { loadProgram } from "./settings.js";

export const KIOSK_MEMBER_TOKEN_SECONDS = 900;

export function issueKioskMemberToken(
  tenantId: string,
  memberId: string,
  stationId: string,
): string {
  return seal(
    "loyalty-member",
    { t: tenantId, m: memberId, s: stationId },
    { ttlSeconds: KIOSK_MEMBER_TOKEN_SECONDS },
  );
}

/** The club as the kiosk shows it, or null when it is off (or the plan is Free). */
export async function loyaltyKioskConfig(
  tx: Tx,
): Promise<LoyaltyKioskConfig | null> {
  const p = await loadProgram(tx);
  if (!p.enabled || (await entitlement(tx)).plan !== "pro") return null;
  return {
    enabled: true,
    stampsRequired: p.stampsRequired,
    rewardLabel: p.rewardDescription,
  };
}

/**
 * "Soy del club" at the kiosk: an exact phone match, inside the tenant transaction kiosk's route
 * opened from the device binding. The club must be on (loyalty_disabled). Counts and a masked
 * phone only (R21, LD-72); the token binds the member to this tenant and station for 15 minutes.
 */
export async function lookupMemberForKiosk(
  tx: Tx,
  raw: unknown,
  o: { stationId: string },
): Promise<KioskMemberView> {
  const config = await loyaltyKioskConfig(tx);
  if (!config) throw new DomainError("loyalty_disabled", 409);
  const parsed = kioskLookupInput.safeParse(raw);
  const phone = parsed.success
    ? parsePhone(parsed.data.phone, parsed.data.country)
    : null;
  if (!phone) throw new DomainError("loyalty_invalid_phone", 400);
  const [m] =
    await tx`select tenant_id,id,phone_e164,stamps,rewards from loyalty_members where phone_e164=${phone}`;
  if (!m) return { found: false };
  return {
    found: true,
    memberToken: issueKioskMemberToken(m.tenant_id, m.id, o.stationId),
    maskedPhone: maskPhone(m.phone_e164),
    stamps: m.stamps,
    required: config.stampsRequired,
    rewards: m.rewards,
  };
}

/**
 * The member id a kiosk order carries: the token must be loyalty-member, of this tenant and
 * station, unexpired, and the member must still exist and not be deleted (plain read).
 */
export async function memberFromToken(
  tx: Tx,
  token: string,
  o: { tenantId: string; stationId: string },
): Promise<string> {
  let c: { t?: unknown; m?: unknown; s?: unknown };
  try {
    c = unseal("loyalty-member", token);
  } catch {
    throw new DomainError("loyalty_member_token_invalid", 400);
  }
  if (
    !c ||
    c.t !== o.tenantId ||
    c.s !== o.stationId ||
    typeof c.m !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.m)
  )
    throw new DomainError("loyalty_member_token_invalid", 400);
  const [m] =
    await tx`select id from loyalty_members where id=${c.m} and redacted_at is null`;
  if (!m) throw new DomainError("loyalty_member_token_invalid", 400);
  return m.id;
}
