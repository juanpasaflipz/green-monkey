/**
 * pos-lite member import (038, specs/loyalty-w4.md §6; ARCHITECTURE row 53). Pages of at most 500
 * members, each one transaction: 1 (the import key, class 0: tenant + 'pos-lite-loyalty' + the
 * source tenant) → 2 (restaurants FOR SHARE) → 3 (loyalty_settings FOR SHARE: refused while the
 * club is on, loyalty_import_after_enable) → member inserts → ledger inserts (rows this
 * transaction inserted) → source_mappings inserts. The first page creates the import batch. A page
 * already applied (a mapping for every row) replays; a partial one is import_existing_mapping.
 * Imported members keep their program (consent channel pos_lite_import); pos-lite's pre-checked
 * SMS opt-ins are evidence only (legacy_sms_opt_in), never marketing consent (Q16).
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { managers, permit } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { audit } from "../orders.js";
import { requirePro } from "../entitlements.js";
import { DomainError, type Session } from "../../shared/domain.js";
import { nameKey, normalizeRows } from "../../shared/loyalty.js";
import {
  importPageInput,
  POS_LITE_SOURCE,
  toConfirmNote,
  type ImportStatus,
} from "../../shared/loyalty-import.js";
import { loadProgram } from "./settings.js";
import { postLedger } from "./ledger.js";

export type ImportPageResult = {
  batchId: string;
  page: number;
  imported: number;
  replayed: boolean;
};

export async function commitLoyaltyImportPage(
  tx: Tx,
  s: Session,
  raw: unknown,
): Promise<ImportPageResult> {
  permit(s, managers);
  requireRecentAuth(s);
  const parsed = importPageInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("invalid_input", 400);
  const p = parsed.data;
  if (p.targetTenantId !== s.tenantId)
    throw new DomainError("loyalty_import_scope", 403);
  // LO-1 (class 0) before the restaurants row (LO-2), as once() takes them.
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + POS_LITE_SOURCE + p.sourceTenantId},0))`;
  const [restaurant] =
    await tx`select currency,timezone,cutoff from restaurants where id=${s.tenantId} for share`;
  if (
    !restaurant ||
    restaurant.timezone !== s.restaurant.timezone ||
    restaurant.cutoff !== s.restaurant.cutoff
  )
    throw new DomainError("settings_changed", 409);
  const [settings] =
    await tx`select enabled from loyalty_settings where tenant_id=${s.tenantId} for share`;
  if (settings?.enabled)
    throw new DomainError("loyalty_import_after_enable", 409);
  await requirePro(tx);
  const program = await loadProgram(tx);
  // Balances convert at the club's saved stamps per card: the preview must have used it.
  if (p.stampsRequired !== program.stampsRequired)
    throw new DomainError("settings_changed", 409);
  await tx`insert into import_batches(tenant_id,id,source,file_hash,report)
    values(${s.tenantId},${randomUUID()},${POS_LITE_SOURCE},${p.batchHash},
      ${tx.json({ sourceTenantId: p.sourceTenantId, policy: p.policy, pages: p.pages })})
    on conflict (tenant_id,source,file_hash) do nothing`;
  const [batch] =
    await tx`select id from import_batches where source=${POS_LITE_SOURCE} and file_hash=${p.batchHash}`;
  const legacyIds = p.rows.map((r) => r.legacyId);
  const mapped =
    await tx`select legacy_id from source_mappings where source_system=${POS_LITE_SOURCE}
      and source_tenant_id=${p.sourceTenantId} and entity_type='loyalty_member'
      and legacy_id = any(${tx.array(legacyIds)}::text[])`;
  if (mapped.length === p.rows.length)
    return { batchId: batch.id, page: p.page, imported: 0, replayed: true };
  if (mapped.length) throw new DomainError("import_existing_mapping", 409);
  // A phone twice in a page (the preview prevents it) is a refusal, never a raw unique error.
  if (new Set(p.rows.map((r) => r.phone)).size !== p.rows.length)
    throw new DomainError("loyalty_import_rejected", 409);
  const taken =
    await tx`select 1 from loyalty_members where phone_e164 = any(${tx.array(p.rows.map((r) => r.phone))}::text[]) limit 1`;
  if (taken.length) throw new DomainError("loyalty_import_member_exists", 409);
  for (const r of p.rows) {
    const memberId = randomUUID();
    await tx`insert into loyalty_members(tenant_id,id,phone_e164,name,name_key,joined_at,joined_via,
        consent_channel,consent_at,legacy_source,legacy_id,legacy_sms_opt_in,legacy_visits,legacy_spend,
        legacy_last_visit_at)
      values(${s.tenantId},${memberId},${r.phone},${r.name},${nameKey(r.name)},${r.joinedAt},'import',
        'pos_lite_import',${r.joinedAt},'pos-lite',${r.legacyId},${r.smsOptIn},${r.visits},${r.spend},
        ${r.lastVisitAt})`;
    await postLedger(tx, s.tenantId, {
      memberId,
      kind: "import",
      stampsDelta: r.stamps,
      rewardsDelta: r.rewards,
      actorId: s.employeeId,
      reason: "pos_lite_balance",
      note: toConfirmNote(r.toConfirm ?? []),
    });
    for (const n of normalizeRows(
      memberId,
      r.stamps,
      r.rewards,
      program.stampsRequired,
      false,
    ))
      await postLedger(tx, s.tenantId, { ...n, actorId: s.employeeId });
    await tx`insert into source_mappings(tenant_id,source_system,source_tenant_id,entity_type,legacy_id,target_id,import_batch_id)
      values(${s.tenantId},${POS_LITE_SOURCE},${p.sourceTenantId},'loyalty_member',${r.legacyId},${memberId},${batch.id})`;
  }
  await audit(tx, s, "loyalty.import.page", batch.id, {
    batchId: batch.id,
    page: p.page,
    pages: p.pages,
    count: p.rows.length,
  });
  return {
    batchId: batch.id,
    page: p.page,
    imported: p.rows.length,
    replayed: false,
  };
}

/** GET /import/:batchId (managers): the server's totals for "Verificado". */
export async function importStatus(
  tx: Tx,
  s: Session,
  batchId: string,
): Promise<ImportStatus> {
  permit(s, managers);
  const [b] =
    await tx`select id from import_batches where id=${batchId} and source=${POS_LITE_SOURCE}`;
  if (!b) throw new DomainError("not_found", 404);
  const [t] = await tx`select count(*)::int as members,
      coalesce(sum(m.stamps),0)::int as stamps, coalesce(sum(m.rewards),0)::int as rewards,
      coalesce(sum(l.stamps_delta),0)::int as import_stamps,
      coalesce(sum(l.rewards_delta),0)::int as import_rewards
    from source_mappings x
    join loyalty_members m on m.tenant_id=x.tenant_id and m.id=x.target_id
    left join loyalty_ledger l on l.tenant_id=m.tenant_id and l.member_id=m.id and l.kind='import'
    where x.import_batch_id=${batchId} and x.entity_type='loyalty_member'`;
  return {
    batchId,
    members: t.members,
    importStamps: t.import_stamps,
    importRewards: t.import_rewards,
    stamps: t.stamps,
    rewards: t.rewards,
  };
}
