import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { tenant, type Tx } from "./db.js";
import { entitlement } from "./entitlements.js";
import {
  configuredChannels,
  getMarketingSettings,
  launchScheduled,
  runAutomations,
  unsubscribeToken,
  type ChannelStatus,
  type Restaurant,
} from "./marketing.js";
import { emailHtml, type MarketingChannel } from "../shared/marketing.js";

export type Outbound = {
  id: string;
  channel: MarketingChannel;
  to: string;
  subject: string;
  text: string;
  locale: "es" | "en";
  guestName: string;
  restaurant: string;
  replyTo: string | null;
  privacyUrl: string | null;
  unsubscribeUrl: string;
  oneClickUrl: string;
};
export type SendResult =
  | { ok: true; providerId: string }
  | { ok: false; retryable: boolean; code: string };
export type Provider = (message: Outbound) => Promise<SendResult>;
export type Providers = Partial<Record<MarketingChannel, Provider>>;
type Fetch = typeof fetch;

const failure = (provider: string, status: number): SendResult => ({
  ok: false,
  retryable: status === 429 || status >= 500,
  code: `${provider}_${status}`,
});
const plainName = (value: string) =>
  value
    .replace(/[<>"\r\n]/g, " ")
    .trim()
    .slice(0, 60);
/** Resend: POST /emails with an Idempotency-Key, so a retry never duplicates. */
export function resendProvider(
  env: { apiKey: string; from: string },
  http: Fetch = fetch,
): Provider {
  return async (m) => {
    const response = await http("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": m.id,
      },
      body: JSON.stringify({
        from: `${plainName(m.restaurant)} <${env.from}>`,
        to: [m.to],
        subject: m.subject,
        html: emailHtml(m.text, {
          restaurant: m.restaurant,
          unsubscribeUrl: m.unsubscribeUrl,
          privacyUrl: m.privacyUrl,
          locale: m.locale,
        }),
        text: `${m.text}\n\n${m.locale === "es" ? "Darme de baja" : "Unsubscribe"}: ${m.unsubscribeUrl}`,
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
        headers: {
          "List-Unsubscribe": `<${m.oneClickUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    });
    if (!response.ok) return failure("resend", response.status);
    const data = (await response.json()) as { id?: string };
    return data.id
      ? { ok: true, providerId: data.id }
      : { ok: false, retryable: false, code: "resend_no_id" };
  };
}
/** Twilio Programmable Messaging through a Messaging Service. */
export function twilioProvider(
  env: { accountSid: string; authToken: string; messagingServiceSid: string },
  http: Fetch = fetch,
): Provider {
  return async (m) => {
    const response = await http(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.accountSid)}/Messages.json`,
      {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`${env.accountSid}:${env.authToken}`).toString(
              "base64",
            ),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: m.to,
          MessagingServiceSid: env.messagingServiceSid,
          Body: m.text,
        }),
      },
    );
    if (!response.ok) return failure("twilio", response.status);
    const data = (await response.json()) as { sid?: string };
    return data.sid
      ? { ok: true, providerId: data.sid }
      : { ok: false, retryable: false, code: "twilio_no_sid" };
  };
}
const templateText = (value: string) =>
  value.replace(/\s+/g, " ").trim().slice(0, 900);
/**
 * WhatsApp Cloud API. Marketing messages must use a template approved by Meta
 * with four positional body parameters: guest name, restaurant, message and
 * unsubscribe link.
 */
export function whatsappProvider(
  env: {
    accessToken: string;
    phoneNumberId: string;
    apiVersion: string;
    template: string;
  },
  http: Fetch = fetch,
): Provider {
  return async (m) => {
    const response = await http(
      `https://graph.facebook.com/${encodeURIComponent(env.apiVersion)}/${encodeURIComponent(env.phoneNumberId)}/messages`,
      {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${env.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: m.to.replace(/^\+/, ""),
          type: "template",
          template: {
            name: env.template,
            language: { code: m.locale === "es" ? "es_MX" : "en_US" },
            components: [
              {
                type: "body",
                parameters: [
                  m.guestName || (m.locale === "es" ? "qué tal" : "there"),
                  m.restaurant,
                  m.text,
                  m.unsubscribeUrl,
                ].map((text) => ({ type: "text", text: templateText(text) })),
              },
            ],
          },
        }),
      },
    );
    if (!response.ok) return failure("whatsapp", response.status);
    const data = (await response.json()) as { messages?: { id?: string }[] };
    const providerId = data.messages?.[0]?.id;
    return providerId
      ? { ok: true, providerId }
      : { ok: false, retryable: false, code: "whatsapp_no_id" };
  };
}
export function providersFromEnv(
  env: NodeJS.ProcessEnv,
  status: ChannelStatus,
): Providers {
  return {
    ...(status.email.enabled
      ? {
          email: resendProvider({
            apiKey: env.RESEND_API_KEY!,
            from: env.MARKETING_EMAIL_FROM!,
          }),
        }
      : {}),
    ...(status.sms.enabled
      ? {
          sms: twilioProvider({
            accountSid: env.TWILIO_ACCOUNT_SID!,
            authToken: env.TWILIO_AUTH_TOKEN!,
            messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID!,
          }),
        }
      : {}),
    ...(status.whatsapp.enabled
      ? {
          whatsapp: whatsappProvider({
            accessToken: env.WHATSAPP_ACCESS_TOKEN!,
            phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
            apiVersion: env.WHATSAPP_API_VERSION!,
            template: env.WHATSAPP_MARKETING_TEMPLATE!,
          }),
        }
      : {}),
  };
}

export async function checkMarketingRole(sql: postgres.Sql) {
  const [r] =
    await sql`select rolsuper,rolbypassrls,pg_has_role(current_user,'gm_marketing_worker','member') as marketing from pg_roles where rolname=current_user`;
  const [owned] =
    await sql`select 1 from pg_tables where schemaname='public' and tableowner=current_user limit 1`;
  if (!r.marketing || r.rolsuper || r.rolbypassrls || owned)
    throw Error("restricted_marketing_role_required");
}
const MAX_ATTEMPTS = 5;
const optIn = {
  email: "email_opt_in",
  sms: "sms_opt_in",
  whatsapp: "whatsapp_opt_in",
} as const;
type Claimed = Outbound & { tenantId: string; leaseToken: string };
/** Leases one due message for a restaurant, or resolves why it must not send. */
async function claim(
  tx: Tx,
  tenantId: string,
  appUrl: string,
  channels: readonly MarketingChannel[],
): Promise<Claimed | null> {
  // An expired lease means the previous attempt's outcome is unknown. E-mail is
  // idempotent at the provider and is retried; SMS and WhatsApp are not, so they
  // are parked as uncertain instead of risking a duplicate.
  await tx`update messages set state='uncertain',error_code='outcome_unknown',lease_until=null
    where state='sending' and lease_until<now() and channel<>'email'`;
  const [m] = await tx`select m.*,g.name as guest_name,g.locale,g.email,g.phone,
      g.email_opt_in,g.sms_opt_in,g.whatsapp_opt_in,r.name as restaurant_name,c.state as campaign_state
    from messages m join guests g on g.tenant_id=m.tenant_id and g.id=m.guest_id
      join campaigns c on c.tenant_id=m.tenant_id and c.id=m.campaign_id
      join restaurants r on r.id=m.tenant_id
    where m.channel=any(${tx.array(channels as string[])}::text[])
      and ((m.state='queued' and m.next_at<=now()) or (m.state='sending' and m.lease_until<now()))
    order by m.next_at limit 1 for update of m skip locked`;
  if (!m) return null;
  const channel = m.channel as MarketingChannel;
  const address = channel === "email" ? m.email : m.phone;
  const stop =
    !m[optIn[channel]] || address !== m.to_address
      ? "consent_withdrawn"
      : m.campaign_state === "cancelled" || m.campaign_state === "paused"
        ? "campaign_stopped"
        : (await entitlement(tx)).plan !== "pro"
          ? "pro_required"
          : null;
  if (stop) {
    await tx`update messages set state='suppressed',error_code=${stop},lease_until=null where id=${m.id}`;
    return claim(tx, tenantId, appUrl, channels);
  }
  const leaseToken = randomUUID();
  await tx`update messages set state='sending',attempts=attempts+1,lease_token=${leaseToken},lease_until=now()+interval '2 minutes' where id=${m.id}`;
  const settings = await getMarketingSettings(tx);
  const token = unsubscribeToken(tenantId, m.guest_id, channel);
  return {
    tenantId,
    leaseToken,
    id: m.id,
    channel,
    to: m.to_address,
    subject: m.subject,
    text: m.body,
    locale: m.locale,
    guestName: (m.guest_name as string).trim().split(/\s+/)[0] ?? "",
    restaurant: settings.senderName || m.restaurant_name,
    replyTo: settings.replyTo,
    privacyUrl: settings.privacyUrl,
    unsubscribeUrl: `${appUrl}/u/${token}`,
    oneClickUrl: `${appUrl}/api/guest/unsubscribe/${token}`,
  };
}
async function settle(
  sql: postgres.Sql,
  m: Claimed,
  result: SendResult | "unknown",
) {
  await tenant(sql, m.tenantId, async (tx) => {
    const [row] =
      await tx`select attempts from messages where id=${m.id} and lease_token=${m.leaseToken} and state='sending' for update`;
    // Another worker took over after our lease expired; it owns the outcome.
    if (!row) return;
    if (result === "unknown") {
      if (m.channel === "email" && row.attempts < MAX_ATTEMPTS)
        await tx`update messages set state='queued',error_code='network',lease_until=null,next_at=now()+make_interval(mins=>${2 ** row.attempts}) where id=${m.id}`;
      else
        await tx`update messages set state=${m.channel === "email" ? "failed" : "uncertain"},error_code='outcome_unknown',lease_until=null where id=${m.id}`;
    } else if (result.ok)
      await tx`update messages set state='sent',provider_id=${result.providerId},error_code=null,sent_at=now(),lease_until=null where id=${m.id}`;
    else if (result.retryable && row.attempts < MAX_ATTEMPTS)
      await tx`update messages set state='queued',error_code=${result.code},lease_until=null,next_at=now()+make_interval(mins=>${2 ** row.attempts}) where id=${m.id}`;
    else
      await tx`update messages set state='failed',error_code=${result.code},lease_until=null where id=${m.id}`;
  });
}
/**
 * One pass of the marketing worker: start scheduled campaigns, evaluate daily
 * automations, then deliver due messages. Provider calls never run inside a
 * database transaction.
 */
export async function marketingTick(
  sql: postgres.Sql,
  providers: Providers,
  status: ChannelStatus,
  appUrl: string,
  options: { now?: number; batch?: number } = {},
) {
  const now = options.now ?? Date.now();
  const configured = configuredChannels(status).filter((c) => providers[c]);
  const planned = await sql<
    Restaurant[]
  >`select r.id,r.name,r.timezone,r.currency from restaurants r
    where r.id in (select tenant_id from campaigns where state in ('scheduled','sending','active'))`;
  let started = 0,
    queued = 0;
  for (const r of planned)
    await tenant(sql, r.id, async (tx) => {
      if ((await entitlement(tx)).plan !== "pro") return;
      started += await launchScheduled(tx, r, configured, appUrl, now);
      queued +=
        (await runAutomations(tx, r, configured, appUrl, now))?.queued ?? 0;
    });
  let delivered = 0;
  if (configured.length) {
    const tenants = await sql<
      { tenant_id: string }[]
    >`select distinct tenant_id from messages
      where (state='queued' and next_at<=now()) or (state='sending' and lease_until<now()) limit 100`;
    for (const { tenant_id: tenantId } of tenants)
      for (let n = 0; n < (options.batch ?? 25); n++) {
        const message = await tenant(sql, tenantId, (tx) =>
          claim(tx, tenantId, appUrl, configured),
        );
        if (!message) break;
        let result: SendResult | "unknown";
        try {
          result = await providers[message.channel]!(message);
        } catch {
          result = "unknown";
        }
        await settle(sql, message, result);
        if (result !== "unknown" && result.ok) delivered++;
      }
  }
  return { started, queued, delivered };
}
