import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { enqueueJob } from "../jobs.js";
import type { MessageKind } from "../../shared/loyalty-engagement.js";

/** Only opaque ids enter jobs. The delivery worker rechecks current consent and club state. */
export async function queueMemberMessage(
  tx: Tx,
  tenantId: string,
  memberId: string,
  kind: MessageKind,
  key: string,
  runAt?: Date,
) {
  const [e] = await tx`select settings from loyalty_engagement_settings`;
  if (e?.settings?.smsEnabled !== true) return;
  const [m] =
    await tx`select marketing_opt_in,redacted_at from loyalty_members where id=${memberId}`;
  if (!m?.marketing_opt_in || m.redacted_at) return;
  const id = randomUUID();
  await tx`insert into loyalty_messages(tenant_id,id,member_id,kind) values(${tenantId},${id},${memberId},${kind})`;
  await enqueueJob(
    tx,
    { tenantId },
    {
      kind: "loyalty_message",
      dedupeKey: key,
      payload: { messageId: id },
      runAt,
    },
  );
}
export async function queueLoyaltyEvent(
  tx: Tx,
  tenantId: string,
  memberId: string,
  kind: string,
  key: string,
) {
  const message =
    kind === "reward_earned"
      ? "reward"
      : kind === "earn"
        ? "stamp"
        : kind === "referral_bonus"
          ? "referral"
          : null;
  if (message) await queueMemberMessage(tx, tenantId, memberId, message, key);
  if (kind === "reward_earned") {
    const [e] = await tx`select settings from loyalty_engagement_settings`;
    const days = e?.settings?.reminderDays ?? 7;
    await queueMemberMessage(
      tx,
      tenantId,
      memberId,
      "reminder",
      `${key}:reminder`,
      new Date(Date.now() + days * 86400000),
    );
  }
  const [card] =
    await tx`select 1 from loyalty_member_cards where member_id=${memberId}`;
  if (card)
    await enqueueJob(
      tx,
      { tenantId },
      { kind: "loyalty_wallet_sync", dedupeKey: key, payload: { memberId } },
    );
}

export async function queueAllWallets(tx: Tx, tenantId: string, key: string) {
  await tx`insert into jobs(tenant_id,id,kind,dedupe_key,payload,state,next_at)
  select tenant_id,gen_random_uuid(),'loyalty_wallet_sync',${key}||':'||member_id::text,
   jsonb_build_object('memberId',member_id),'available',now()
  from loyalty_member_cards where tenant_id=${tenantId}
  on conflict(tenant_id,kind,dedupe_key) do nothing`;
}
