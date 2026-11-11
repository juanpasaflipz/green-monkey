/**
 * Marketing delivery (047), worker only: the provider keys live here. Mirrors the
 * club's message handler: current consent, confirmation, club, marketing switch and
 * Pro are rechecked under the row lock; a send whose answer was lost becomes
 * `unknown` and is never repeated; phone and text exist only in memory.
 */
import { createHash, randomBytes } from "node:crypto";
import type { JobHandler, JobOutcome } from "../jobs.js";
import { entitlement } from "../entitlements.js";
import {
  confirmationText,
  marketingSettings,
  renderMarketing,
  smsText,
  type MarketingChannel,
} from "../../shared/marketing.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
type Prepared =
  | { poll: string; channel: MarketingChannel }
  | {
      channel: MarketingChannel;
      phone: string;
      text: string;
      name: string;
      restaurant: string;
    };
type Sent =
  { ok: true; id: string } | { ok: false; final: boolean; code: string };

export function providerConfig(env: NodeJS.ProcessEnv) {
  return {
    sms:
      env.MARKETING_SMS_SEND === "1" &&
      env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      env.TWILIO_MESSAGING_SERVICE_SID
        ? {
            account: env.TWILIO_ACCOUNT_SID,
            secret: env.TWILIO_AUTH_TOKEN,
            service: env.TWILIO_MESSAGING_SERVICE_SID,
          }
        : null,
    whatsapp:
      env.MARKETING_WHATSAPP_SEND === "1" &&
      env.WHATSAPP_ACCESS_TOKEN &&
      env.WHATSAPP_PHONE_NUMBER_ID &&
      env.WHATSAPP_API_VERSION &&
      env.WHATSAPP_MARKETING_TEMPLATE
        ? {
            token: env.WHATSAPP_ACCESS_TOKEN,
            phoneId: env.WHATSAPP_PHONE_NUMBER_ID,
            version: env.WHATSAPP_API_VERSION,
            template: env.WHATSAPP_MARKETING_TEMPLATE,
          }
        : null,
  };
}
type Config = ReturnType<typeof providerConfig>;
/** Twilio: an explicit rejection is final; HTTP 5xx is ambiguous. */
async function sendSms(
  c: NonNullable<Config["sms"]>,
  to: string,
  body: string,
  signal: AbortSignal,
  http: typeof fetch,
): Promise<Sent> {
  const res = await http(
    `https://api.twilio.com/2010-04-01/Accounts/${c.account}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.account}:${c.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: to,
        Body: body,
        MessagingServiceSid: c.service,
      }),
      signal,
    },
  );
  const data = (await res.json().catch(() => ({}))) as any;
  return res.ok && typeof data.sid === "string"
    ? { ok: true, id: data.sid }
    : {
        ok: false,
        final: res.status < 500,
        code: String(data.code ?? "provider_rejected"),
      };
}
/**
 * WhatsApp Cloud API: an approved marketing template with three positional body
 * parameters (guest first name, restaurant, message).
 */
async function sendWhatsapp(
  c: NonNullable<Config["whatsapp"]>,
  to: string,
  p: { name: string; restaurant: string; text: string },
  signal: AbortSignal,
  http: typeof fetch,
): Promise<Sent> {
  const res = await http(
    `https://graph.facebook.com/${encodeURIComponent(c.version)}/${encodeURIComponent(c.phoneId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to.replace(/^\+/, ""),
        type: "template",
        template: {
          name: c.template,
          language: { code: "es_MX" },
          components: [
            {
              type: "body",
              parameters: [p.name, p.restaurant, p.text].map((text) => ({
                type: "text",
                text: text.replace(/\s+/g, " ").trim().slice(0, 900),
              })),
            },
          ],
        },
      }),
      signal,
    },
  );
  const data = (await res.json().catch(() => ({}))) as any;
  const id = data?.messages?.[0]?.id;
  return res.ok && typeof id === "string"
    ? { ok: true, id }
    : {
        ok: false,
        final: res.status < 500,
        code: String(data?.error?.code ?? "provider_rejected"),
      };
}

export function marketingMessageHandler(
  env: NodeJS.ProcessEnv = process.env,
  http: typeof fetch = fetch,
): JobHandler {
  return async (ctx): Promise<JobOutcome> => {
    const id = (ctx.job.payload as any)?.messageId;
    if (typeof id !== "string" || !UUID.test(id))
      return { status: "dead", code: "marketing_payload_invalid" };
    const config = providerConfig(env);
    const appUrl = (env.APP_URL ?? "").replace(/\/+$/, "");
    let blocked: string | null = null;
    const prepared = await ctx.tenant(async (tx): Promise<Prepared | null> => {
      const [msg] =
        await tx`select * from marketing_messages where id=${id} for update`;
      if (
        !msg ||
        ["delivered", "failed", "unknown", "skipped"].includes(msg.state)
      )
        return null;
      const channel = msg.channel as MarketingChannel;
      if (!config[channel]) {
        blocked = `marketing_${channel}_not_configured`;
        return null;
      }
      // A prior send with a lost response must never be retried blindly.
      if (msg.state === "sending") {
        await tx`update marketing_messages set state='unknown',error_code='delivery_uncertain',updated_at=clock_timestamp() where id=${id}`;
        return null;
      }
      if (msg.provider_id)
        return channel === "sms" ? { poll: msg.provider_id, channel } : null;
      const skip = async (code: string) => {
        await tx`update marketing_messages set state='skipped',error_code=${code},updated_at=clock_timestamp() where id=${id}`;
        return null;
      };
      const [m] =
        await tx`select name,phone_e164,marketing_opt_in,redacted_at from loyalty_members where id=${msg.member_id}`;
      const [club] = await tx`select enabled from loyalty_settings`;
      const [row] = await tx`select settings from marketing_settings`;
      const settings = marketingSettings.parse(row?.settings ?? {});
      if (!m || m.redacted_at || !m.marketing_opt_in)
        return skip("consent_withdrawn");
      if (!club?.enabled || !settings.enabled)
        return skip("marketing_disabled");
      if ((await entitlement(tx)).plan !== "pro") return skip("pro_required");
      const [c] =
        await tx`select phone_hash,confirmed_at from marketing_confirmations where member_id=${msg.member_id}`;
      if (!c || c.phone_hash !== sha(m.phone_e164))
        return skip("phone_changed");
      const [r] =
        await tx`select name from restaurants where id=${ctx.job.tenantId}`;
      let text: string;
      if (msg.kind === "confirmation") {
        if (c.confirmed_at) return skip("already_confirmed");
        if (!appUrl.startsWith("https://")) {
          blocked = "marketing_app_url_required";
          return null;
        }
        const secret = randomBytes(32).toString("base64url");
        const token = `${ctx.job.tenantId}.${msg.member_id}.${secret}`;
        await tx`update marketing_confirmations set token_hash=${sha(token)},requested_at=clock_timestamp() where member_id=${msg.member_id}`;
        text = confirmationText(r.name, `${appUrl}/club/confirm#${token}`);
      } else {
        if (!c.confirmed_at) return skip("not_confirmed");
        const [campaign] =
          await tx`select body,state from marketing_campaigns where id=${msg.campaign_id}`;
        if (!campaign || ["cancelled", "paused"].includes(campaign.state))
          return skip("campaign_stopped");
        const vars = { name: m.name as string, restaurant: r.name as string };
        text =
          channel === "sms"
            ? smsText(campaign.body, vars)
            : renderMarketing(campaign.body, vars);
      }
      await tx`update marketing_messages set state='sending',updated_at=clock_timestamp() where id=${id}`;
      return {
        channel,
        phone: m.phone_e164,
        text,
        name: (m.name as string).trim().split(/\s+/)[0] ?? "",
        restaurant: r.name,
      };
    });
    if (blocked) return { status: "blocked", code: blocked };
    if (!prepared) return;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]);
    const set = (
      state: string,
      extra: { provider?: string; code?: string | null } = {},
    ) =>
      ctx.tenant(async (tx) => {
        await tx`update marketing_messages set state=${state},
            provider_id=coalesce(${extra.provider ?? null},provider_id),
            error_code=${extra.code ?? null},
            sent_at=case when ${state} in ('sent','delivered') then coalesce(sent_at,clock_timestamp()) else sent_at end,
            updated_at=clock_timestamp() where id=${id}`;
      });
    if ("poll" in prepared) {
      const c = config.sms!;
      const res = await http(
        `https://api.twilio.com/2010-04-01/Accounts/${c.account}/Messages/${prepared.poll}.json`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${c.account}:${c.secret}`).toString("base64")}`,
          },
          signal,
        },
      );
      if (!res.ok)
        return {
          status: "retry",
          code: "marketing_status_unavailable",
          afterMs: 60000,
        };
      const data = (await res.json()) as any;
      const state = ["delivered", "read"].includes(data.status)
        ? "delivered"
        : ["failed", "undelivered", "canceled"].includes(data.status)
          ? "failed"
          : "sent";
      await set(state, {
        code: data.error_code ? String(data.error_code) : null,
      });
      if (state === "sent" && ctx.job.attempts < 8)
        return { status: "retry", code: "delivery_pending", afterMs: 60000 };
      return;
    }
    try {
      const result =
        prepared.channel === "sms"
          ? await sendSms(
              config.sms!,
              prepared.phone,
              prepared.text,
              signal,
              http,
            )
          : await sendWhatsapp(
              config.whatsapp!,
              prepared.phone,
              prepared,
              signal,
              http,
            );
      if (!result.ok) {
        await set(result.final ? "failed" : "unknown", { code: result.code });
        return;
      }
      await set("sent", { provider: result.id });
      if (prepared.channel === "sms")
        return { status: "retry", code: "delivery_pending", afterMs: 60000 };
    } catch {
      await set("unknown", { code: "delivery_uncertain" });
    }
  };
}
