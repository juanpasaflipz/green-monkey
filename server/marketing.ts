import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import type { Tx } from "./db.js";
import { managers, permit, sign } from "./auth.js";
import { requirePro } from "./entitlements.js";
import { audit, once } from "./orders.js";
import { guestStats } from "./guests.js";
import { DomainError, id, type Session } from "../shared/domain.js";
import {
  automationCopy,
  automationInput,
  automationKeys,
  automationParams,
  campaignInput,
  inSegment,
  launchInput,
  marketingChannels,
  qualifies,
  reachableChannel,
  renderMessage,
  segmentInput,
  settingsInput,
  unavailableAutomations,
  type GuestStats,
  type MarketingChannel,
  type Window,
} from "../shared/marketing.js";

export type ChannelStatus = Record<
  MarketingChannel,
  { enabled: boolean; reason?: string }
>;
/**
 * A channel sends only when it is explicitly enabled, its credentials are
 * present and the restricted delivery worker is configured. Nothing is assumed
 * to work because a key exists.
 */
export function channelStatus(env: NodeJS.ProcessEnv): ChannelStatus {
  const status = (flag: string, required: string[]) =>
    env[flag] !== "true"
      ? { enabled: false, reason: "not_enabled" }
      : required.some((name) => !env[name])
        ? { enabled: false, reason: "credentials_required" }
        : !env.MARKETING_DATABASE_URL || !env.APP_URL?.startsWith("https://")
          ? { enabled: false, reason: "worker_and_https_app_url_required" }
          : { enabled: true };
  return {
    email: status("MARKETING_EMAIL_ENABLED", [
      "RESEND_API_KEY",
      "MARKETING_EMAIL_FROM",
    ]),
    sms: status("MARKETING_SMS_ENABLED", [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_MESSAGING_SERVICE_SID",
    ]),
    whatsapp: status("MARKETING_WHATSAPP_ENABLED", [
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_API_VERSION",
      "WHATSAPP_MARKETING_TEMPLATE",
    ]),
  };
}
export const configuredChannels = (status: ChannelStatus) =>
  marketingChannels.filter((c) => status[c].enabled);

export type Restaurant = {
  id: string;
  name: string;
  timezone: string;
  currency: string;
};
const settingsDefaults = {
  version: 0,
  senderName: "",
  replyTo: null as string | null,
  privacyUrl: null as string | null,
  reviewUrl: null as string | null,
  frequencyCapDays: 30,
  attributionDays: 7,
  sendHour: 11,
};
export async function getMarketingSettings(tx: Tx) {
  const [r] = await tx`select * from marketing_settings`;
  return r
    ? {
        version: r.version as number,
        senderName: r.sender_name as string,
        replyTo: r.reply_to as string | null,
        privacyUrl: r.privacy_url as string | null,
        reviewUrl: r.review_url as string | null,
        frequencyCapDays: r.frequency_cap_days as number,
        attributionDays: r.attribution_days as number,
        sendHour: r.send_hour as number,
      }
    : settingsDefaults;
}
export async function saveMarketingSettings(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = settingsInput.parse(raw);
  return once(tx, s, p.operationId, "marketing.settings", p, async () => {
    await requirePro(tx);
    const [old] = await tx`select version from marketing_settings for update`;
    if ((old?.version ?? 0) !== p.expectedVersion)
      throw new DomainError("stale_order", 409);
    await tx`insert into marketing_settings(tenant_id,version,sender_name,reply_to,privacy_url,review_url,frequency_cap_days,attribution_days,send_hour)
      values(${s.tenantId},1,${p.senderName},${p.replyTo},${p.privacyUrl},${p.reviewUrl},${p.frequencyCapDays},${p.attributionDays},${p.sendHour})
      on conflict(tenant_id) do update set version=marketing_settings.version+1,sender_name=excluded.sender_name,reply_to=excluded.reply_to,privacy_url=excluded.privacy_url,review_url=excluded.review_url,frequency_cap_days=excluded.frequency_cap_days,attribution_days=excluded.attribution_days,send_hour=excluded.send_hour,updated_at=now()`;
    await audit(tx, s, "marketing.settings", s.tenantId, {});
    return getMarketingSettings(tx);
  });
}

const campaignRow = (r: any) => ({
  id: r.id as string,
  version: r.version as number,
  kind: r.kind as "one_off" | "automation",
  automationKey: r.automation_key as string | null,
  name: r.name as string,
  channels: r.channels as MarketingChannel[],
  subject: r.subject as string,
  body: r.body as string,
  segment: r.segment,
  params: r.params,
  promotionId: r.promotion_id as string | null,
  state: r.state as string,
  scheduledAt: r.scheduled_at?.toISOString() ?? null,
  launchedAt: r.launched_at?.toISOString() ?? null,
  audience: r.audience as number | null,
  createdAt: r.created_at.toISOString(),
  messages: {
    queued: r.queued ?? 0,
    sent: r.sent ?? 0,
    failed: r.failed ?? 0,
    suppressed: r.suppressed ?? 0,
    uncertain: r.uncertain ?? 0,
  },
});
const counts = (tx: Tx) => tx`
  (select count(*) filter(where m.state in ('queued','sending'))::int as queued,
    count(*) filter(where m.state='sent')::int as sent,
    count(*) filter(where m.state='failed')::int as failed,
    count(*) filter(where m.state='suppressed')::int as suppressed,
    count(*) filter(where m.state='uncertain')::int as uncertain
   from messages m where m.tenant_id=c.tenant_id and m.campaign_id=c.id) k`;
export async function listCampaigns(tx: Tx, s: Session) {
  permit(s, managers);
  const rows =
    await tx`select c.*,k.* from campaigns c cross join lateral ${counts(tx)}
      where c.kind='one_off' order by c.created_at desc limit 200`;
  return rows.map(campaignRow);
}
async function requirePromotion(tx: Tx, promotionId: string | null) {
  if (!promotionId) return;
  const [promotion] =
    await tx`select code from promotions where id=${promotionId} and active`;
  if (!promotion?.code) throw new DomainError("promotion_code_required");
}
export async function saveCampaign(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = campaignInput.parse(raw);
  return once(tx, s, p.operationId, "campaign.save", p, async () => {
    await requirePro(tx);
    const c = p.campaign;
    const [old] =
      await tx`select version,state,kind from campaigns where id=${c.id} for update`;
    if ((old?.version ?? 0) !== p.expectedVersion)
      throw new DomainError("stale_order", 409);
    if (old && (old.kind !== "one_off" || old.state !== "draft"))
      throw new DomainError("campaign_locked", 409);
    await requirePromotion(tx, c.promotionId);
    await tx`insert into campaigns(tenant_id,id,version,kind,name,channels,subject,body,segment,promotion_id,state,created_by)
      values(${s.tenantId},${c.id},1,'one_off',${c.name},${c.channels},${c.subject},${c.body},${tx.json(c.segment)},${c.promotionId},'draft',${s.employeeId})
      on conflict(tenant_id,id) do update set version=campaigns.version+1,name=excluded.name,channels=excluded.channels,subject=excluded.subject,body=excluded.body,segment=excluded.segment,promotion_id=excluded.promotion_id`;
    await audit(tx, s, "campaign.saved", c.id, {});
    const [row] =
      await tx`select c.*,k.* from campaigns c cross join lateral ${counts(tx)} where c.id=${c.id}`;
    return campaignRow(row);
  });
}
export async function listAutomations(tx: Tx, s: Session) {
  permit(s, managers);
  const rows =
    await tx`select c.*,k.* from campaigns c cross join lateral ${counts(tx)} where c.kind='automation'`;
  const locale = "es";
  return {
    automations: automationKeys.map((key) => {
      const row = rows.find((r) => r.automation_key === key);
      const saved = row ? campaignRow(row) : null;
      return {
        key,
        name: automationCopy[key].name,
        defaults: {
          subject: automationCopy[key].subject,
          body: automationCopy[key].body,
        },
        active: saved?.state === "active",
        configured: !!saved,
        channels: saved?.channels ?? (["email"] as MarketingChannel[]),
        subject: saved?.subject ?? automationCopy[key].subject[locale],
        body: saved?.body ?? automationCopy[key].body[locale],
        params: automationParams.parse(saved?.params ?? {}),
        promotionId: saved?.promotionId ?? null,
        messages: saved?.messages ?? null,
      };
    }),
    unavailable: unavailableAutomations,
  };
}
export async function saveAutomation(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = automationInput.parse(raw);
  return once(tx, s, p.operationId, "automation.save", p, async () => {
    await requirePro(tx);
    await requirePromotion(tx, p.promotionId);
    const state = p.active ? "active" : "paused";
    const [row] =
      await tx`insert into campaigns(tenant_id,id,kind,automation_key,name,channels,subject,body,params,promotion_id,state,created_by)
        values(${s.tenantId},${randomUUID()},'automation',${p.key},${automationCopy[p.key].name.es},${p.channels},${p.subject},${p.body},${tx.json(p.params)},${p.promotionId},${state},${s.employeeId})
        on conflict(tenant_id,automation_key) where automation_key is not null do update set version=campaigns.version+1,channels=excluded.channels,subject=excluded.subject,body=excluded.body,params=excluded.params,promotion_id=excluded.promotion_id,state=excluded.state
        returning id`;
    await audit(tx, s, "automation.saved", row.id, {
      key: p.key,
      active: p.active,
    });
    return { key: p.key, active: p.active };
  });
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";
export const unsubscribeToken = (
  tenantId: string,
  guestId: string,
  channel: MarketingChannel,
) => sign({ purpose: "unsubscribe", tenantId, guestId, channel });
type Target = { guest: GuestStats; channel: MarketingChannel; dedupe: string };
/** Renders and stores one outbox row per target. Duplicate keys are ignored, so
 * re-running a launch or an automation evaluation never sends twice. */
export async function enqueue(
  tx: Tx,
  r: Restaurant,
  campaign: {
    id: string;
    subject: string;
    body: string;
    promotionId: string | null;
  },
  targets: Target[],
  automated: boolean,
  appUrl: string,
) {
  if (!targets.length) return 0;
  const settings = await getMarketingSettings(tx);
  const [promotion] = campaign.promotionId
    ? await tx`select name,code from promotions where id=${campaign.promotionId} and active`
    : [];
  let queued = 0;
  for (const { guest, channel, dedupe } of targets) {
    const vars = {
      name: firstName(guest.name),
      restaurant: settings.senderName || r.name,
      code: promotion?.code ?? null,
      offerName: promotion?.name ?? null,
      review: settings.reviewUrl,
      locale: guest.locale,
    };
    const text = renderMessage(campaign.body, vars);
    const link = `${appUrl}/u/${unsubscribeToken(r.id, guest.id, channel)}`;
    const body =
      channel === "sms"
        ? `${text}\n${guest.locale === "es" ? "Baja" : "Stop"}: ${link}`
        : text;
    const rows =
      await tx`insert into messages(tenant_id,id,campaign_id,guest_id,channel,to_address,subject,body,dedupe_key,automated)
        values(${r.id},${randomUUID()},${campaign.id},${guest.id},${channel},${channel === "email" ? guest.email : guest.phone},${channel === "email" ? renderMessage(campaign.subject, vars) : ""},${body},${dedupe},${automated})
        on conflict(tenant_id,dedupe_key) do nothing returning id`;
    queued += rows.length;
  }
  return queued;
}
export function audience(
  guests: GuestStats[],
  segment: unknown,
  channels: readonly MarketingChannel[],
  configured: readonly MarketingChannel[],
  now: number,
) {
  const parsed = segmentInput.parse(segment);
  const matching = guests.filter((g) => inSegment(g, parsed, now));
  const targets = matching.flatMap((guest) => {
    const channel = reachableChannel(guest, channels, configured);
    return channel ? [{ guest, channel }] : [];
  });
  return { matching: matching.length, targets };
}
export async function previewAudience(
  tx: Tx,
  s: Session,
  raw: unknown,
  status: ChannelStatus,
) {
  permit(s, managers);
  await requirePro(tx);
  const p = z
    .object({
      segment: segmentInput.default({}),
      channels: z.array(z.enum(marketingChannels)).min(1).max(3),
    })
    .strict()
    .parse(raw);
  const result = audience(
    await guestStats(tx),
    p.segment,
    p.channels,
    // Preview by consent even while a channel is still being configured.
    marketingChannels,
    Date.now(),
  );
  return {
    matching: result.matching,
    reachable: result.targets.length,
    byChannel: Object.fromEntries(
      marketingChannels.map((c) => [
        c,
        result.targets.filter((t) => t.channel === c).length,
      ]),
    ),
    blockedChannels: p.channels.filter((c) => !status[c].enabled),
  };
}
async function restaurant(tx: Tx, tenantId: string): Promise<Restaurant> {
  const [r] =
    await tx`select id,name,timezone,currency from restaurants where id=${tenantId}`;
  return r as Restaurant;
}
async function send(
  tx: Tx,
  r: Restaurant,
  campaign: any,
  configured: readonly MarketingChannel[],
  appUrl: string,
  now: number,
) {
  const result = audience(
    await guestStats(tx),
    campaign.segment,
    campaign.channels,
    configured,
    now,
  );
  await enqueue(
    tx,
    r,
    {
      id: campaign.id,
      subject: campaign.subject,
      body: campaign.body,
      promotionId: campaign.promotion_id,
    },
    result.targets.map((t) => ({
      ...t,
      dedupe: `c:${campaign.id}:${t.guest.id}`,
    })),
    false,
    appUrl,
  );
  await tx`update campaigns set state='sending',launched_at=now(),audience=${result.targets.length} where id=${campaign.id}`;
  return result.targets.length;
}
export async function launchCampaign(
  tx: Tx,
  s: Session,
  raw: unknown,
  status: ChannelStatus,
  appUrl: string,
) {
  permit(s, managers);
  const p = launchInput.parse(raw);
  return once(tx, s, p.operationId, "campaign.launch", p, async () => {
    await requirePro(tx);
    const [campaign] =
      await tx`select * from campaigns where id=${p.campaignId} and kind='one_off' for update`;
    if (!campaign) throw new DomainError("not_found", 404);
    if (campaign.version !== p.expectedVersion || campaign.state !== "draft")
      throw new DomainError("stale_order", 409);
    const blocked = (campaign.channels as MarketingChannel[]).filter(
      (c) => !status[c].enabled,
    );
    if (blocked.length) throw new DomainError("channel_not_configured", 409);
    if (p.scheduledAt) {
      const at = new Date(p.scheduledAt);
      if (at.getTime() < Date.now() + 60_000)
        throw new DomainError("invalid_schedule");
      await tx`update campaigns set state='scheduled',scheduled_at=${at} where id=${campaign.id}`;
      await audit(tx, s, "campaign.scheduled", campaign.id, {
        at: p.scheduledAt,
      });
      return { state: "scheduled", audience: null };
    }
    const count = await send(
      tx,
      await restaurant(tx, s.tenantId),
      campaign,
      configuredChannels(status),
      appUrl,
      Date.now(),
    );
    await audit(tx, s, "campaign.launched", campaign.id, { audience: count });
    return { state: "sending", audience: count };
  });
}
export async function cancelCampaign(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = z.object({ operationId: id, campaignId: id }).strict().parse(raw);
  return once(tx, s, p.operationId, "campaign.cancel", p, async () => {
    const [campaign] =
      await tx`select state from campaigns where id=${p.campaignId} and kind='one_off' for update`;
    if (!campaign) throw new DomainError("not_found", 404);
    if (!["scheduled", "sending"].includes(campaign.state))
      throw new DomainError("campaign_locked", 409);
    const stopped =
      await tx`update messages set state='suppressed',error_code='cancelled' where campaign_id=${p.campaignId} and state='queued' returning id`;
    await tx`update campaigns set state='cancelled' where id=${p.campaignId}`;
    await audit(tx, s, "campaign.cancelled", p.campaignId, {
      stopped: stopped.length,
    });
    return { state: "cancelled", stopped: stopped.length };
  });
}

/** Worker: start scheduled campaigns whose time has come. */
export async function launchScheduled(
  tx: Tx,
  r: Restaurant,
  configured: readonly MarketingChannel[],
  appUrl: string,
  now: number,
) {
  const due =
    await tx`select * from campaigns where kind='one_off' and state='scheduled' and scheduled_at<=${new Date(now)} order by scheduled_at for update skip locked`;
  for (const campaign of due)
    await send(tx, r, campaign, configured, appUrl, now);
  // A campaign is finished when nothing is left to deliver.
  await tx`update campaigns c set state='sent' where c.kind='one_off' and c.state='sending'
    and not exists(select 1 from messages m where m.tenant_id=c.tenant_id and m.campaign_id=c.id and m.state in ('queued','sending'))`;
  return due.length;
}
/**
 * Worker: evaluate automations once per restaurant per local day, after the
 * configured hour. The window continues from the previous run so a missed day
 * is caught up (bounded to 72 hours) instead of skipped.
 */
export async function runAutomations(
  tx: Tx,
  r: Restaurant,
  configured: readonly MarketingChannel[],
  appUrl: string,
  now: number,
) {
  const settings = await getMarketingSettings(tx);
  const local = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(
    r.timezone,
  );
  if (local.hour < settings.sendHour) return null;
  const localDate = local.toPlainDate().toString();
  await tx`select pg_advisory_xact_lock(hashtextextended(${r.id + ":marketing-run"},0))`;
  const [done] =
    await tx`select 1 from marketing_runs where local_date=${localDate}`;
  if (done) return null;
  const [previous] =
    await tx`select window_end from marketing_runs order by local_date desc limit 1`;
  const window: Window = {
    start: Math.max(
      previous?.window_end.getTime() ?? now - 86_400_000,
      now - 3 * 86_400_000,
    ),
    end: now,
  };
  const automations =
    await tx`select * from campaigns where kind='automation' and state='active'`;
  let queued = 0;
  if (automations.length) {
    const capped = new Set(
      (
        await tx`select distinct guest_id from messages where automated and state<>'suppressed'
          and created_at>=${new Date(now - settings.frequencyCapDays * 86_400_000)}`
      ).map((m) => m.guest_id as string),
    );
    for (const guest of await guestStats(tx, window)) {
      if (capped.has(guest.id)) continue;
      for (const key of automationKeys) {
        const automation = automations.find((a) => a.automation_key === key);
        if (!automation) continue;
        const suffix = qualifies(
          key,
          guest,
          automationParams.parse(automation.params),
          window,
        );
        if (!suffix) continue;
        const channel = reachableChannel(
          guest,
          automation.channels,
          configured,
        );
        if (!channel) continue;
        queued += await enqueue(
          tx,
          r,
          {
            id: automation.id,
            subject: automation.subject,
            body: automation.body,
            promotionId: automation.promotion_id,
          },
          [{ guest, channel, dedupe: `a:${key}:${guest.id}:${suffix}` }],
          true,
          appUrl,
        );
        break;
      }
    }
  }
  await tx`insert into marketing_runs(tenant_id,local_date,window_start,window_end,queued) values(${r.id},${localDate},${new Date(window.start)},${new Date(window.end)},${queued})`;
  return { localDate, window, queued };
}

/**
 * Last-touch attribution: an order counts for the most recent delivered message
 * its guest received in the attribution window before ordering. Each order is
 * attributed at most once. Code redemptions are reported separately and are
 * never added to attributed sales.
 */
export async function performance(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  await requirePro(tx);
  const p = z
    .object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      campaignId: id.optional(),
    })
    .strict()
    .parse(raw);
  const settings = await getMarketingSettings(tx);
  const since = new Date(Date.now() - p.days * 86_400_000);
  const campaign = p.campaignId ?? null;
  const attributed = await tx`
    with touched as (
      select o.id,o.total,o.channel,o.created_at,o.guest_id,
        (select m.id from messages m where m.tenant_id=o.tenant_id and m.guest_id=o.guest_id and m.state='sent'
           and m.sent_at<o.created_at and m.sent_at>=o.created_at-make_interval(days=>${settings.attributionDays})
           order by m.sent_at desc limit 1) as message_id,
        not exists(select 1 from orders e where e.tenant_id=o.tenant_id and e.guest_id=o.guest_id and e.created_at<o.created_at) as first_order
      from orders o where o.guest_id is not null and o.created_at>=${since}
    )
    select m.campaign_id,t.id as order_id,t.total,t.channel as order_channel,t.first_order,
      to_char(t.created_at at time zone ${s.restaurant.timezone},'YYYY-MM-DD') as day
    from touched t join messages m on m.id=t.message_id
    where ${campaign}::uuid is null or m.campaign_id=${campaign}::uuid`;
  const sent =
    await tx`select m.campaign_id,m.channel,m.state,count(*)::int as count
    from messages m where m.created_at>=${since} and (${campaign}::uuid is null or m.campaign_id=${campaign}::uuid)
    group by 1,2,3`;
  const redemptions =
    await tx`select c.id as campaign_id,count(r.id)::int as count,coalesce(sum(r.amount),0)::int as discount
    from campaigns c join promotion_redemptions r on r.tenant_id=c.tenant_id and r.promotion_id=c.promotion_id and r.created_at>=${since}
    where ${campaign}::uuid is null or c.id=${campaign}::uuid group by c.id`;
  const names = await tx`select id,name,kind,automation_key from campaigns`;
  const total = (rows: readonly any[]) => rows.reduce((a, r) => a + r.total, 0);
  const group = (rows: readonly any[], key: string) =>
    Object.entries(
      rows.reduce<Record<string, any[]>>((acc, row) => {
        (acc[String(row[key])] ??= []).push(row);
        return acc;
      }, {}),
    ).map(([label, list]) => ({
      label,
      orders: list.length,
      sales: total(list),
    }));
  const orders = attributed.length,
    sales = total(attributed);
  return {
    days: p.days,
    attributionDays: settings.attributionDays,
    method: "last_message_within_window",
    estimate: true,
    messages: Object.fromEntries(
      ["sent", "queued", "sending", "failed", "suppressed", "uncertain"].map(
        (state) => [
          state,
          sent
            .filter((r) => r.state === state)
            .reduce((a, r) => a + r.count, 0),
        ],
      ),
    ),
    byMessageChannel: marketingChannels.map((channel) => ({
      channel,
      sent: sent
        .filter((r) => r.channel === channel && r.state === "sent")
        .reduce((a, r) => a + r.count, 0),
    })),
    attributedOrders: orders,
    attributedSales: sales,
    averageOrder: orders ? Math.round(sales / orders) : 0,
    byDay: group(attributed, "day").sort((a, b) =>
      a.label.localeCompare(b.label),
    ),
    byOrderSource: group(attributed, "order_channel"),
    byGuestType: [
      {
        label: "new",
        ...((list) => ({ orders: list.length, sales: total(list) }))(
          attributed.filter((r) => r.first_order),
        ),
      },
      {
        label: "returning",
        ...((list) => ({ orders: list.length, sales: total(list) }))(
          attributed.filter((r) => !r.first_order),
        ),
      },
    ],
    byCampaign: names
      .map((c) => {
        const list = attributed.filter((r) => r.campaign_id === c.id);
        const code = redemptions.find((r) => r.campaign_id === c.id);
        return {
          id: c.id,
          name: c.name,
          kind: c.kind,
          automationKey: c.automation_key,
          sent: sent
            .filter((r) => r.campaign_id === c.id && r.state === "sent")
            .reduce((a, r) => a + r.count, 0),
          orders: list.length,
          sales: total(list),
          codeRedemptions: code?.count ?? 0,
          codeDiscount: code?.discount ?? 0,
        };
      })
      .filter((c) => c.sent || c.orders || c.codeRedemptions),
  };
}

export const socialInput = z
  .object({
    operationId: id,
    id,
    network: z.enum(["instagram", "facebook", "tiktok", "google"]),
    body: z.string().trim().min(1).max(2200),
    plannedFor: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
    state: z.enum(["draft", "posted", "discarded"]).default("draft"),
  })
  .strict();
export async function listSocial(tx: Tx, s: Session) {
  permit(s, managers);
  return tx`select id,network,body,to_char(planned_for,'YYYY-MM-DD') as "plannedFor",state,created_at as "createdAt"
    from social_posts where state<>'discarded' order by planned_for nulls last,created_at desc limit 200`;
}
/** Posts are drafts to copy into the network; nothing is published for you. */
export async function saveSocial(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = socialInput.parse(raw);
  return once(tx, s, p.operationId, "social.save", p, async () => {
    await requirePro(tx);
    await tx`insert into social_posts(tenant_id,id,network,body,planned_for,state,created_by)
      values(${s.tenantId},${p.id},${p.network},${p.body},${p.plannedFor},${p.state},${s.employeeId})
      on conflict(tenant_id,id) do update set network=excluded.network,body=excluded.body,planned_for=excluded.planned_for,state=excluded.state`;
    return { id: p.id, state: p.state };
  });
}
