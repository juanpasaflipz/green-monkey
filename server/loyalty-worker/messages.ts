import type { JobHandler } from "../jobs.js";
import {
  engagementSettings,
  loyaltyMessage,
  type MessageKind,
} from "../../shared/loyalty-engagement.js";
import { entitlement } from "../entitlements.js";

export const messageHandler: JobHandler = async (ctx) => {
  const id = (ctx.job.payload as any)?.messageId;
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  )
    return { status: "dead", code: "loyalty_payload_invalid" };
  const account = process.env.TWILIO_ACCOUNT_SID,
    secret = process.env.TWILIO_AUTH_TOKEN,
    service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!account || !secret || !service || process.env.LOYALTY_SMS_SEND !== "1")
    return { status: "blocked", code: "loyalty_sms_not_configured" };
  const prepared = await ctx.tenant(async (tx) => {
    const [msg] =
      await tx`select * from loyalty_messages where id=${id} for update`;
    if (
      !msg ||
      ["delivered", "failed", "unknown", "skipped"].includes(msg.state)
    )
      return null;
    // A prior send with a lost response must never be retried blindly.
    if (msg.state === "sending") {
      await tx`update loyalty_messages set state='unknown',error_code='delivery_uncertain',updated_at=clock_timestamp() where id=${id}`;
      return null;
    }
    const [m] =
      await tx`select phone_e164,marketing_opt_in,redacted_at,stamps,rewards from loyalty_members where id=${msg.member_id}`;
    const [p] = await tx`select enabled,stamps_required from loyalty_settings`;
    const [row] = await tx`select settings from loyalty_engagement_settings`;
    const e = engagementSettings.parse(row?.settings ?? {});
    if (
      !m ||
      m.redacted_at ||
      !m.marketing_opt_in ||
      !p?.enabled ||
      !e.smsEnabled ||
      (await entitlement(tx)).plan !== "pro" ||
      (msg.kind === "reminder" && m.rewards <= 0)
    ) {
      await tx`update loyalty_messages set state='skipped',updated_at=clock_timestamp() where id=${id}`;
      return null;
    }
    if (msg.provider_id) return { sid: msg.provider_id as string };
    // Multiple cards completed together produce one reminder for the member in a 24-hour window.
    if (msg.kind === "reminder") {
      await tx`select pg_advisory_xact_lock(935,hashtext(${ctx.job.tenantId + ":" + msg.member_id}))`;
      const [recent] =
        await tx`select 1 from loyalty_messages where member_id=${msg.member_id} and kind='reminder'
    and id<>${id} and state in ('sending','sent','delivered','unknown') and updated_at>now()-interval '24 hours' limit 1`;
      if (recent) {
        await tx`update loyalty_messages set state='skipped' where id=${id}`;
        return null;
      }
    }
    const [r] =
      await tx`select name from restaurants where id=${ctx.job.tenantId}`;
    const body = loyaltyMessage(msg.kind as MessageKind, {
      restaurant: r.name,
      stamps: m.stamps,
      required: p.stamps_required,
      rewards: m.rewards,
      reviewUrl: e.reviewUrl,
    });
    await tx`update loyalty_messages set state='sending',updated_at=clock_timestamp() where id=${id}`;
    return { phone: m.phone_e164 as string, body };
  });
  if (!prepared) return;
  const root = `https://api.twilio.com/2010-04-01/Accounts/${account}/Messages`;
  const headers = {
    Authorization: `Basic ${Buffer.from(`${account}:${secret}`).toString("base64")}`,
  };
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]);
  if ("sid" in prepared) {
    const res = await fetch(`${root}/${prepared.sid}.json`, {
      headers,
      signal,
    });
    if (!res.ok)
      return {
        status: "retry",
        code: "loyalty_sms_status_unavailable",
        afterMs: 60000,
      };
    const data = (await res.json()) as any;
    const state = ["delivered", "read"].includes(data.status)
      ? "delivered"
      : ["failed", "undelivered", "canceled"].includes(data.status)
        ? "failed"
        : "sent";
    await ctx.tenant(async (tx) => {
      await tx`update loyalty_messages set state=${state},error_code=${data.error_code ? String(data.error_code) : null},updated_at=clock_timestamp() where id=${id}`;
    });
    if (state === "sent" && ctx.job.attempts < 8)
      return { status: "retry", code: "delivery_pending", afterMs: 60000 };
    return;
  }
  try {
    const res = await fetch(`${root}.json`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: prepared.phone,
        Body: prepared.body,
        MessagingServiceSid: service,
      }),
      signal,
    });
    const data = (await res.json()) as any;
    if (!res.ok || typeof data.sid !== "string") {
      // Explicit rejection is final; HTTP 5xx is ambiguous and never automatically resent.
      const state = res.status >= 500 ? "unknown" : "failed";
      await ctx.tenant(async (tx) => {
        await tx`update loyalty_messages set state=${state},error_code=${String(data.code ?? "provider_rejected")},updated_at=clock_timestamp() where id=${id}`;
      });
      return;
    }
    await ctx.tenant(async (tx) => {
      await tx`update loyalty_messages set state='sent',provider_id=${data.sid},updated_at=clock_timestamp() where id=${id}`;
    });
    return { status: "retry", code: "delivery_pending", afterMs: 60000 };
  } catch {
    await ctx.tenant(async (tx) => {
      await tx`update loyalty_messages set state='unknown',error_code='delivery_uncertain',updated_at=clock_timestamp() where id=${id}`;
    });
  }
};
