import { createHash, randomBytes } from "node:crypto";
import type { Tx } from "../db.js";
import { managers, operators, permit } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { audit, once } from "../orders.js";
import { DomainError, type Session } from "../../shared/domain.js";
import { normalizeRows, programTitle } from "../../shared/loyalty.js";
import {
  engagementSettings,
  saveEngagementInput,
  referralInput,
  CARD_TOKEN,
  SCAN_CODE,
  type CardView,
} from "../../shared/loyalty-engagement.js";
import { requireClub } from "./settings.js";
import { postLedger, summaryOf } from "./ledger.js";
import { queueAllWallets } from "./engagement-events.js";
import { enqueueJob } from "../jobs.js";

export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function loadEngagement(tx: Tx) {
  const [row] =
    await tx`select settings,version from loyalty_engagement_settings`;
  return {
    ...engagementSettings.parse(row?.settings ?? {}),
    version: row?.version ?? 0,
  };
}
export async function getEngagement(tx: Tx, s: Session) {
  permit(s, managers);
  return loadEngagement(tx);
}
export async function saveEngagement(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  requireRecentAuth(s);
  const p = saveEngagementInput.safeParse(raw);
  if (!p.success) throw new DomainError("invalid_input", 400);
  return once(
    tx,
    s,
    p.data.operationId,
    "loyalty.engagement.settings",
    p.data,
    async () => {
      await requireClub(tx);
      const settings = engagementSettings.parse(
        Object.fromEntries(
          Object.entries(p.data).filter(
            ([k]) => !["operationId", "expectedVersion"].includes(k),
          ),
        ),
      );
      const [row] =
        await tx`insert into loyalty_engagement_settings(tenant_id,settings,version)
   select ${s.tenantId},${tx.json(settings)},1 where ${p.data.expectedVersion}=0
   on conflict(tenant_id) do nothing returning version`;
      if (!row) {
        const [updated] =
          await tx`update loyalty_engagement_settings set settings=${tx.json(settings)},version=version+1
    where tenant_id=${s.tenantId} and version=${p.data.expectedVersion} returning version`;
        if (!updated) throw new DomainError("stale_settings", 409);
      }
      await queueAllWallets(tx, s.tenantId, `settings:${p.data.operationId}`);
      await audit(tx, s, "loyalty.engagement.settings", s.tenantId, {
        fields: Object.keys(settings),
      });
      return loadEngagement(tx);
    },
  );
}

/** Card credentials are issued at the counter, never from a public phone lookup. Reissue revokes old links. */
export async function issueCard(tx: Tx, s: Session, memberId: string) {
  permit(s, operators);
  await requireClub(tx);
  const [m] =
    await tx`select id,redacted_at from loyalty_members where id=${memberId} for no key update`;
  if (!m || m.redacted_at)
    throw new DomainError("loyalty_member_not_found", 404);
  const token = `${s.tenantId}.${memberId}.${randomBytes(32).toString("base64url")}`;
  const scan = randomBytes(16).toString("hex");
  const code = randomBytes(8).toString("hex").toUpperCase();
  await tx`insert into loyalty_member_cards(tenant_id,member_id,access_hash,scan_token,referral_code)
  values(${s.tenantId},${memberId},${digest(token)},${scan},${code})
  on conflict(tenant_id,member_id) do update set access_hash=excluded.access_hash,scan_token=excluded.scan_token,
   revoked_at=null,updated_at=clock_timestamp()`;
  await enqueueJob(tx, s, {
    kind: "loyalty_wallet_sync",
    dedupeKey: `card:${digest(token)}`,
    payload: { memberId },
  });
  await audit(tx, s, "loyalty.card.issued", memberId, { memberId });
  return { path: `/club/card#${token}` };
}
export async function revokeCard(tx: Tx, s: Session, memberId: string) {
  permit(s, managers);
  requireRecentAuth(s);
  await tx`update loyalty_member_cards set revoked_at=clock_timestamp(),updated_at=clock_timestamp() where member_id=${memberId}`;
  await enqueueJob(tx, s, {
    kind: "loyalty_wallet_sync",
    dedupeKey: `revoke:${memberId}:${Date.now()}`,
    payload: { memberId },
  });
  await audit(tx, s, "loyalty.card.revoked", memberId, { memberId });
  return { ok: true };
}
export function cardClaims(token: string) {
  if (!CARD_TOKEN.test(token)) throw new DomainError("unauthorized", 401);
  const [tenantId, memberId] = token.split(".");
  // Strict UUID validation prevents database errors for malformed public credentials.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(tenantId) || !uuid.test(memberId))
    throw new DomainError("unauthorized", 401);
  return { tenantId, memberId };
}
export async function authenticateCard(tx: Tx, token: string) {
  const { memberId } = cardClaims(token);
  const [row] =
    await tx`select c.*,m.stamps,m.rewards,m.marketing_opt_in,m.redacted_at
  from loyalty_member_cards c join loyalty_members m on m.tenant_id=c.tenant_id and m.id=c.member_id
  where c.member_id=${memberId} and c.access_hash=${digest(token)} and c.revoked_at is null and m.redacted_at is null`;
  if (!row) throw new DomainError("unauthorized", 401);
  return row;
}
export async function cardView(tx: Tx, token: string): Promise<CardView> {
  const c = await authenticateCard(tx, token);
  const p = await requireClub(tx),
    e = await loadEngagement(tx);
  const [r] = await tx`select name from restaurants where id=${c.tenant_id}`;
  return {
    restaurantName: r.name,
    programName: programTitle(p.programName, r.name),
    stamps: c.stamps,
    required: p.stampsRequired,
    rewards: c.rewards,
    rewardDescription: p.rewardDescription,
    scanCode: `gm-club:${c.scan_token}`,
    referralCode: e.referralsEnabled ? c.referral_code : null,
    reviewUrl: e.reviewUrl,
    marketingOptIn: c.marketing_opt_in,
    walletEnabled: e.walletEnabled,
  };
}
export async function scanCard(tx: Tx, s: Session, raw: unknown) {
  permit(s, operators);
  const p = await requireClub(tx);
  const code =
    typeof (raw as any)?.code === "string"
      ? SCAN_CODE.exec((raw as any).code.trim())
      : null;
  if (!code) throw new DomainError("invalid_input", 400);
  const [m] =
    await tx`select m.* from loyalty_members m join loyalty_member_cards c
  on c.tenant_id=m.tenant_id and c.member_id=m.id where c.scan_token=${code[1]}
  and c.revoked_at is null and m.redacted_at is null`;
  return m ? summaryOf(m, p.stampsRequired) : null;
}
/** Both members are locked in UUID order. The unique referee key makes concurrent claims single-award. */
export async function applyReferral(
  tx: Tx,
  tenantId: string,
  memberId: string,
  code: string,
) {
  const p = await requireClub(tx),
    e = await loadEngagement(tx);
  if (!e.referralsEnabled)
    throw new DomainError("loyalty_referrals_disabled", 409);
  const [card] =
    await tx`select member_id from loyalty_member_cards where referral_code=${code} and revoked_at is null`;
  if (!card || card.member_id === memberId)
    throw new DomainError("loyalty_referral_invalid", 400);
  const members =
    await tx`select id,stamps,rewards,redacted_at,joined_at from loyalty_members
  where id=any(${[memberId, card.member_id]}::uuid[]) order by id for no key update`;
  if (members.length !== 2 || members.some((m) => m.redacted_at))
    throw new DomainError("loyalty_referral_invalid", 400);
  const member = members.find((m) => m.id === memberId)!;
  const [prior] =
    await tx`select referrer_id from loyalty_referrals where member_id=${memberId}`;
  if (prior) {
    if (prior.referrer_id !== card.member_id)
      throw new DomainError("loyalty_referral_used", 409);
    return { awarded: false };
  }
  if (Date.now() - new Date(member.joined_at).getTime() > 7 * 86400000)
    throw new DomainError("loyalty_referral_expired", 409);
  await tx`insert into loyalty_referrals(tenant_id,member_id,referrer_id,bonus) values(${tenantId},${memberId},${card.member_id},${e.referralBonus})`;
  for (const m of members) {
    await postLedger(tx, tenantId, {
      memberId: m.id,
      kind: "referral_bonus",
      stampsDelta: e.referralBonus,
      rewardsDelta: 0,
      reason: "referral",
    });
    for (const row of normalizeRows(
      m.id,
      m.stamps + e.referralBonus,
      m.rewards,
      p.stampsRequired,
      false,
    ))
      await postLedger(tx, tenantId, row);
  }
  return { awarded: true };
}
export async function referMember(tx: Tx, s: Session, raw: unknown) {
  permit(s, operators);
  const p = referralInput.safeParse(raw);
  if (!p.success) throw new DomainError("invalid_input", 400);
  return once(
    tx,
    s,
    p.data.operationId,
    "loyalty.referral",
    p.data,
    async () => {
      const result = await applyReferral(
        tx,
        s.tenantId,
        p.data.memberId,
        p.data.code,
      );
      await audit(tx, s, "loyalty.referral.applied", p.data.memberId, {
        memberId: p.data.memberId,
      });
      return result;
    },
  );
}
export async function engagementActivity(tx: Tx, s: Session, memberId: string) {
  permit(s, managers);
  const [card] =
    await tx`select referral_code,revoked_at from loyalty_member_cards where member_id=${memberId}`;
  const [stats] =
    await tx`select count(*)::int as referrals,coalesce(sum(bonus),0)::int as stamps from loyalty_referrals where referrer_id=${memberId}`;
  const messages =
    await tx`select kind,state,error_code,created_at from loyalty_messages where member_id=${memberId} order by created_at desc limit 30`;
  return {
    referralCode: card && !card.revoked_at ? card.referral_code : null,
    ...stats,
    messages,
  };
}
