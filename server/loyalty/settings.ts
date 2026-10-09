/**
 * Loyalty program settings (038, specs/loyalty-w4.md §2.10). One row per restaurant; an absent row
 * is the club off with LOYALTY_DEFAULTS. Lock order: saveLoyaltySettings is ARCHITECTURE row 52:
 * 1 → 2 → 3 (loyalty_settings FOR UPDATE; insert when absent). Every other reader takes no lock.
 */
import type { Tx } from "../db.js";
import { managers, operators, permit } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { audit, once } from "../orders.js";
import { entitlement, requirePro } from "../entitlements.js";
import { restaurantPrivacyUrl } from "../account-settings.js";
import { DomainError, type Session } from "../../shared/domain.js";
import {
  LOYALTY_DEFAULTS,
  loyaltySettingsInput,
  type LoyaltyClubView,
  type LoyaltyProgram,
  type LoyaltySettingsView,
} from "../../shared/loyalty.js";

export type Program = LoyaltyProgram & {
  version: number;
  privacyAttestedAt: string | null;
  privacyAttestedBy: string | null;
};

function programOf(row: Record<string, any> | undefined): Program {
  if (!row)
    return {
      ...LOYALTY_DEFAULTS,
      version: 0,
      privacyAttestedAt: null,
      privacyAttestedBy: null,
    };
  return {
    enabled: row.enabled,
    programName: row.program_name,
    stampsRequired: row.stamps_required,
    stampThreshold: row.stamp_threshold,
    maxStampsPerOrder: row.max_stamps_per_order,
    rewardKind: row.reward_kind,
    rewardDescription: row.reward_description,
    rewardAmount: row.reward_amount,
    rewardMaxAmount: row.reward_max_amount,
    maxRewardsPerOrder: row.max_rewards_per_order,
    promptAtCheckout: row.prompt_at_checkout,
    receiptJoinQr: row.receipt_join_qr,
    linkWindowDays: row.link_window_days,
    version: row.version,
    privacyAttestedAt: row.privacy_attested_at
      ? new Date(row.privacy_attested_at).toISOString()
      : null,
    privacyAttestedBy: row.privacy_attested_by ?? null,
  };
}

/** The program in force (plain read, no lock): defaults with version 0 when never saved. */
export async function loadProgram(tx: Tx): Promise<Program> {
  const [row] =
    await tx`select * from loyalty_settings where tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid`;
  return programOf(row);
}

/** Pro plan and the club switched on (loyalty_disabled), for every club command. */
export async function requireClub(tx: Tx): Promise<Program> {
  await requirePro(tx);
  const p = await loadProgram(tx);
  if (!p.enabled) throw new DomainError("loyalty_disabled", 409);
  return p;
}

export const clubView = (
  p: Program,
  privacyUrl: string | null,
): LoyaltyClubView => ({
  enabled: p.enabled,
  promptAtCheckout: p.promptAtCheckout,
  programName: p.programName,
  stampsRequired: p.stampsRequired,
  rewardDescription: p.rewardDescription,
  rewardKind: p.rewardKind,
  rewardAmount: p.rewardAmount,
  rewardMaxAmount: p.rewardMaxAmount,
  maxRewardsPerOrder: p.maxRewardsPerOrder,
  privacyUrl,
});

/**
 * GET /api/loyalty/settings. Managers get the whole program with the privacy notice and plan;
 * operators read only what Vender needs (on Free, or with the club off, `enabled` is false).
 */
export async function getLoyaltySettings(
  tx: Tx,
  s: Session,
): Promise<LoyaltySettingsView | LoyaltyClubView> {
  permit(s, operators);
  const p = await loadProgram(tx);
  const plan = (await entitlement(tx)).plan === "pro" ? "pro" : "free";
  if (!managers.includes(s.role))
    return clubView(
      { ...p, enabled: p.enabled && plan === "pro" },
      await restaurantPrivacyUrl(tx),
    );
  const [who] = p.privacyAttestedBy
    ? await tx`select name from employees where id=${p.privacyAttestedBy}`
    : [];
  return {
    enabled: p.enabled,
    programName: p.programName,
    stampsRequired: p.stampsRequired,
    stampThreshold: p.stampThreshold,
    maxStampsPerOrder: p.maxStampsPerOrder,
    rewardKind: p.rewardKind,
    rewardDescription: p.rewardDescription,
    rewardAmount: p.rewardAmount,
    rewardMaxAmount: p.rewardMaxAmount,
    maxRewardsPerOrder: p.maxRewardsPerOrder,
    promptAtCheckout: p.promptAtCheckout,
    receiptJoinQr: p.receiptJoinQr,
    linkWindowDays: p.linkWindowDays,
    version: p.version,
    privacyAttestedAt: p.privacyAttestedAt,
    privacyAttestedByName: who?.name ?? null,
    privacyUrl: await restaurantPrivacyUrl(tx),
    plan,
    importAllowed: !p.enabled,
    canEdit: true,
  };
}

const FIELDS = [
  "enabled",
  "programName",
  "stampsRequired",
  "stampThreshold",
  "maxStampsPerOrder",
  "rewardKind",
  "rewardDescription",
  "rewardAmount",
  "rewardMaxAmount",
  "maxRewardsPerOrder",
  "promptAtCheckout",
  "receiptJoinQr",
  "linkWindowDays",
] as const;

/**
 * PUT /api/loyalty/settings (owner and manager, step-up). Turning the club on needs Pro, the
 * restaurant's privacy notice URL (031) and the attestation that the notice covers the club; the
 * attestation records who and when, and is kept while it stays checked. A stale expectedVersion
 * is stale_settings.
 */
export async function saveLoyaltySettings(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  requireRecentAuth(s);
  const parsed = loyaltySettingsInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("loyalty_settings_invalid", 400);
  const p = parsed.data;
  return once(tx, s, p.operationId, "loyalty.settings", p, async () => {
    const [row] =
      await tx`select * from loyalty_settings where tenant_id=${s.tenantId} for update`;
    const before = programOf(row);
    if (before.version !== p.expectedVersion)
      throw new DomainError("stale_settings", 409);
    if (p.enabled) {
      await requirePro(tx);
      if (!(await restaurantPrivacyUrl(tx)))
        throw new DomainError("loyalty_privacy_notice_required", 409);
      if (!p.privacyAttested)
        throw new DomainError("loyalty_privacy_attestation_required", 400);
    }
    const attestedAt = p.privacyAttested
      ? (before.privacyAttestedAt ?? new Date().toISOString())
      : null;
    const attestedBy = p.privacyAttested
      ? (before.privacyAttestedBy ?? s.employeeId)
      : null;
    const rewardMax = p.rewardKind === "item" ? p.rewardMaxAmount : null;
    if (!row) {
      const [inserted] =
        await tx`insert into loyalty_settings(tenant_id,enabled,program_name,stamps_required,stamp_threshold,
          max_stamps_per_order,reward_kind,reward_description,reward_amount,reward_max_amount,max_rewards_per_order,
          prompt_at_checkout,receipt_join_qr,link_window_days,privacy_attested_at,privacy_attested_by,version,
          updated_at,updated_by)
        values(${s.tenantId},${p.enabled},${p.programName},${p.stampsRequired},${p.stampThreshold},
          ${p.maxStampsPerOrder},${p.rewardKind},${p.rewardDescription},${p.rewardAmount},${rewardMax},
          ${p.maxRewardsPerOrder},${p.promptAtCheckout},${p.receiptJoinQr},${p.linkWindowDays},${attestedAt},
          ${attestedBy},1,now(),${s.employeeId})
        on conflict (tenant_id) do nothing returning tenant_id`;
      if (!inserted) throw new DomainError("stale_settings", 409);
    } else
      await tx`update loyalty_settings set enabled=${p.enabled},program_name=${p.programName},
          stamps_required=${p.stampsRequired},stamp_threshold=${p.stampThreshold},
          max_stamps_per_order=${p.maxStampsPerOrder},reward_kind=${p.rewardKind},
          reward_description=${p.rewardDescription},reward_amount=${p.rewardAmount},
          reward_max_amount=${rewardMax},max_rewards_per_order=${p.maxRewardsPerOrder},
          prompt_at_checkout=${p.promptAtCheckout},receipt_join_qr=${p.receiptJoinQr},
          link_window_days=${p.linkWindowDays},privacy_attested_at=${attestedAt},
          privacy_attested_by=${attestedBy},version=version+1,updated_at=now(),updated_by=${s.employeeId}
        where tenant_id=${s.tenantId}`;
    const after: Record<string, unknown> = {
      ...p,
      rewardMaxAmount: rewardMax,
    };
    const changed = FIELDS.filter(
      (f) =>
        JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null),
    );
    if (Boolean(before.privacyAttestedAt) !== p.privacyAttested)
      changed.push("privacyAttested" as never);
    await audit(tx, s, "loyalty.settings.saved", s.tenantId, {
      fields: changed,
      enabled: p.enabled,
    });
    return getLoyaltySettings(tx, s);
  });
}

/** /api/capabilities `loyalty` (R30): {enabled, reason?} with snake_case reasons. */
export async function loyaltyCapability(
  tx: Tx,
): Promise<{ enabled: boolean; reason?: string }> {
  if ((await entitlement(tx)).plan !== "pro")
    return { enabled: false, reason: "pro_required" };
  const p = await loadProgram(tx);
  return p.enabled ? { enabled: true } : { enabled: false, reason: "club_off" };
}
