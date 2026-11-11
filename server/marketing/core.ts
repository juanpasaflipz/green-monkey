/**
 * Guest marketing on the loyalty club (047, docs/MARKETING.md). Web side: settings,
 * campaigns, automations, audience and attribution. Nothing here calls a provider or
 * reads a provider key; delivery is the worker's (server/marketing-worker).
 *
 * A member is reachable only when the club is on, they opted in, they are not deleted
 * and they confirmed their current phone (double opt-in, LOYALTY-PRIVACY-7). Message
 * rows and jobs carry opaque ids only: no phone and no rendered text.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import type { Tx } from "../db.js";
import { managers, permit } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { audit, once } from "../orders.js";
import { enqueueJob } from "../jobs.js";
import { requireClub } from "../loyalty/settings.js";
import { DomainError, id, type Session } from "../../shared/domain.js";
import {
  audienceInput,
  automationCopy,
  automationInput,
  automationKeys,
  automationParams,
  campaignInput,
  inSegment,
  launchInput,
  marketingChannels,
  marketingSettings,
  pickChannel,
  qualifies,
  saveMarketingSettingsInput,
  segmentInput,
  type MarketingChannel,
  type MemberStats,
  type Window,
} from "../../shared/marketing.js";

export const MARKETING_MESSAGE = "marketing_message";
export const MARKETING_DAILY = "marketing_daily";
export const MARKETING_LAUNCH = "marketing_launch";
export const phoneHash = (phone: string) =>
  createHash("sha256").update(phone).digest("hex");

/**
 * Non-secret send switches, the same on web and worker. Provider keys exist only on
 * the worker, which blocks the job when a switch is on without them.
 */
export function sendChannels(env: NodeJS.ProcessEnv): MarketingChannel[] {
  return marketingChannels.filter(
    (c) =>
      env[c === "sms" ? "MARKETING_SMS_SEND" : "MARKETING_WHATSAPP_SEND"] ===
      "1",
  );
}
export async function loadMarketing(tx: Tx) {
  const [row] = await tx`select settings,version from marketing_settings`;
  return {
    ...marketingSettings.parse(row?.settings ?? {}),
    version: (row?.version ?? 0) as number,
  };
}
export async function getMarketing(tx: Tx, s: Session, env: NodeJS.ProcessEnv) {
  permit(s, managers);
  const [counts] = await tx`select
      count(*) filter(where m.marketing_opt_in)::int as opted_in,
      count(*) filter(where m.marketing_opt_in and c.confirmed_at is not null
        and c.phone_hash=encode(sha256(convert_to(m.phone_e164,'UTF8')),'hex'))::int as confirmed,
      count(*)::int as members
    from loyalty_members m left join marketing_confirmations c
      on c.tenant_id=m.tenant_id and c.member_id=m.id
    where m.redacted_at is null`;
  return {
    settings: await loadMarketing(tx),
    channels: Object.fromEntries(
      marketingChannels.map((c) => [c, sendChannels(env).includes(c)]),
    ),
    members: counts.members as number,
    optedIn: counts.opted_in as number,
    confirmed: counts.confirmed as number,
  };
}
export async function saveMarketing(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  requireRecentAuth(s);
  const p = saveMarketingSettingsInput.safeParse(raw);
  if (!p.success) throw new DomainError("invalid_input", 400);
  return once(
    tx,
    s,
    p.data.operationId,
    "marketing.settings",
    p.data,
    async () => {
      await requireClub(tx);
      const { operationId: _op, expectedVersion, ...rest } = p.data;
      const settings = marketingSettings.parse(rest);
      const [row] =
        await tx`insert into marketing_settings(tenant_id,settings,version)
      select ${s.tenantId},${tx.json(settings)},1 where ${expectedVersion}=0
      on conflict(tenant_id) do nothing returning version`;
      if (!row) {
        const [updated] =
          await tx`update marketing_settings set settings=${tx.json(settings)},version=version+1
        where tenant_id=${s.tenantId} and version=${expectedVersion} returning version`;
        if (!updated) throw new DomainError("stale_settings", 409);
      }
      if (settings.enabled)
        await scheduleDaily(tx, s.tenantId, settings.sendHour);
      await audit(tx, s, "marketing.settings", s.tenantId, {
        enabled: settings.enabled,
      });
      return loadMarketing(tx);
    },
  );
}

/** Members with visit figures from their linked orders. No phone, no name. */
export async function memberStats(
  tx: Tx,
  window: Window = { start: 0, end: 0 },
): Promise<MemberStats[]> {
  const rows = await tx`select m.id,m.joined_at,
      (m.marketing_opt_in and c.confirmed_at is not null
        and c.phone_hash=encode(sha256(convert_to(m.phone_e164,'UTF8')),'hex')) as confirmed,
      m.legacy_visits,m.legacy_spend::float8 as legacy_spend,m.legacy_last_visit_at,
      coalesce(o.visits,0)::int as visits,coalesce(o.spend,0)::float8 as spend,
      o.last_at,o.last_order_id,coalesce(o.channels,'{}') as channels,
      coalesce(o.modes,'{}') as modes,coalesce(o.in_window,0)::int as in_window
    from loyalty_members m
    left join marketing_confirmations c on c.tenant_id=m.tenant_id and c.member_id=m.id
    left join lateral (
      select count(*) as visits,sum(x.total) as spend,max(x.created_at) as last_at,
        (array_agg(x.id order by x.created_at desc))[1] as last_order_id,
        array_agg(distinct x.channel) as channels,array_agg(distinct x.mode) as modes,
        count(*) filter(where x.created_at>=${new Date(window.start)} and x.created_at<${new Date(window.end)}) as in_window
      from loyalty_order_links l join orders x on x.tenant_id=l.tenant_id and x.id=l.order_id
      where l.tenant_id=m.tenant_id and l.member_id=m.id and x.state<>'cancelled'
      having count(*)>0
    ) o on true
    where m.redacted_at is null order by m.id limit 50000`;
  return rows.map((r) => {
    const last = Math.max(
      r.last_at?.getTime() ?? 0,
      r.legacy_last_visit_at?.getTime() ?? 0,
    );
    return {
      id: r.id,
      joinedAt: r.joined_at.getTime(),
      confirmed: r.confirmed === true,
      visits: r.visits + r.legacy_visits,
      spend: r.spend + r.legacy_spend,
      lastAt: last || null,
      lastOrderId: r.last_order_id ?? null,
      channels: r.channels,
      modes: r.modes,
      visitsInWindow: r.in_window,
    };
  });
}
export async function previewAudience(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  await requireClub(tx);
  const p = audienceInput.parse(raw);
  const matching = (await memberStats(tx)).filter((m) =>
    inSegment(m, p.segment, Date.now()),
  );
  return {
    matching: matching.length,
    reachable: matching.filter((m) => m.confirmed).length,
  };
}

const messageCounts = (tx: Tx) => tx`
  (select count(*) filter(where m.state in ('queued','sending'))::int as queued,
     count(*) filter(where m.state in ('sent','delivered'))::int as sent,
     count(*) filter(where m.state='failed')::int as failed,
     count(*) filter(where m.state='skipped')::int as skipped,
     count(*) filter(where m.state='unknown')::int as unknown
   from marketing_messages m where m.tenant_id=c.tenant_id and m.campaign_id=c.id) k`;
const view = (r: any) => ({
  id: r.id as string,
  version: r.version as number,
  kind: r.kind as "one_off" | "automation",
  automationKey: r.automation_key as string | null,
  name: r.name as string,
  channels: r.channels as MarketingChannel[],
  body: r.body as string,
  segment: r.segment,
  params: r.params,
  state: r.state as string,
  scheduledAt: r.scheduled_at?.toISOString() ?? null,
  launchedAt: r.launched_at?.toISOString() ?? null,
  audience: r.audience as number | null,
  messages: {
    queued: r.queued as number,
    sent: r.sent as number,
    failed: r.failed as number,
    skipped: r.skipped as number,
    unknown: r.unknown as number,
  },
});
export async function listCampaigns(tx: Tx, s: Session) {
  permit(s, managers);
  // A campaign is finished once nothing is left to deliver.
  await tx`update marketing_campaigns c set state='sent' where c.kind='one_off' and c.state='sending'
    and not exists(select 1 from marketing_messages m where m.tenant_id=c.tenant_id and m.campaign_id=c.id and m.state in ('queued','sending'))`;
  const rows =
    await tx`select c.*,k.* from marketing_campaigns c cross join lateral ${messageCounts(tx)}
    where c.kind='one_off' order by c.created_at desc limit 200`;
  return rows.map(view);
}
export async function saveCampaign(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = campaignInput.safeParse(raw);
  if (!p.success) throw new DomainError("invalid_input", 400);
  return once(
    tx,
    s,
    p.data.operationId,
    "marketing.campaign",
    p.data,
    async () => {
      await requireClub(tx);
      const c = p.data.campaign;
      const [old] =
        await tx`select version,state,kind from marketing_campaigns where id=${c.id} for update`;
      if ((old?.version ?? 0) !== p.data.expectedVersion)
        throw new DomainError("stale_campaign", 409);
      if (old && (old.kind !== "one_off" || old.state !== "draft"))
        throw new DomainError("campaign_locked", 409);
      if (old)
        await tx`update marketing_campaigns set version=version+1,name=${c.name},channels=${c.channels},body=${c.body},segment=${tx.json(c.segment)} where id=${c.id}`;
      else
        await tx`insert into marketing_campaigns(tenant_id,id,kind,name,channels,body,segment,state,created_by)
        values(${s.tenantId},${c.id},'one_off',${c.name},${c.channels},${c.body},${tx.json(c.segment)},'draft',${s.employeeId})`;
      await audit(tx, s, "marketing.campaign.saved", c.id, {});
      const [row] =
        await tx`select c.*,k.* from marketing_campaigns c cross join lateral ${messageCounts(tx)} where c.id=${c.id}`;
      return view(row);
    },
  );
}
export async function listAutomations(tx: Tx, s: Session) {
  permit(s, managers);
  const rows =
    await tx`select c.*,k.* from marketing_campaigns c cross join lateral ${messageCounts(tx)} where c.kind='automation'`;
  return automationKeys.map((key) => {
    const row = rows.find((r) => r.automation_key === key);
    const saved = row ? view(row) : null;
    return {
      key,
      name: automationCopy[key].name,
      defaultBody: automationCopy[key].body,
      configured: !!saved,
      active: saved?.state === "active",
      channels: saved?.channels ?? (["sms"] as MarketingChannel[]),
      body: saved?.body ?? automationCopy[key].body,
      params: automationParams.parse(saved?.params ?? {}),
      messages: saved?.messages ?? null,
    };
  });
}
export async function saveAutomation(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = automationInput.safeParse(raw);
  if (!p.success) throw new DomainError("invalid_input", 400);
  return once(
    tx,
    s,
    p.data.operationId,
    "marketing.automation",
    p.data,
    async () => {
      await requireClub(tx);
      const a = p.data,
        state = a.active ? "active" : "paused";
      const [row] =
        await tx`insert into marketing_campaigns(tenant_id,id,kind,automation_key,name,channels,body,params,state,created_by)
      values(${s.tenantId},${randomUUID()},'automation',${a.key},${automationCopy[a.key].name.es},${a.channels},${a.body},${tx.json(a.params)},${state},${s.employeeId})
      on conflict(tenant_id,automation_key) where automation_key is not null
      do update set version=marketing_campaigns.version+1,channels=excluded.channels,body=excluded.body,params=excluded.params,state=excluded.state
      returning id`;
      if (a.active) {
        const settings = await loadMarketing(tx);
        await scheduleDaily(tx, s.tenantId, settings.sendHour);
      }
      await audit(tx, s, "marketing.automation.saved", row.id, {
        key: a.key,
        active: a.active,
      });
      return { key: a.key, active: a.active };
    },
  );
}

/** One outbox row and one job per target; a repeated key queues nothing. */
export async function queueMessage(
  tx: Tx,
  tenantId: string,
  o: {
    memberId: string;
    campaignId: string | null;
    kind: "campaign" | "automation" | "confirmation";
    channel: MarketingChannel;
    dedupe: string;
  },
) {
  const messageId = randomUUID();
  const rows =
    await tx`insert into marketing_messages(tenant_id,id,member_id,campaign_id,kind,channel,dedupe_key)
    values(${tenantId},${messageId},${o.memberId},${o.campaignId},${o.kind},${o.channel},${o.dedupe})
    on conflict(tenant_id,dedupe_key) do nothing returning id`;
  if (!rows.length) return 0;
  await enqueueJob(
    tx,
    { tenantId },
    { kind: MARKETING_MESSAGE, dedupeKey: o.dedupe, payload: { messageId } },
  );
  return 1;
}
async function send(
  tx: Tx,
  tenantId: string,
  campaign: any,
  env: NodeJS.ProcessEnv,
) {
  const channel = pickChannel(campaign.channels, sendChannels(env));
  const targets = channel
    ? (await memberStats(tx)).filter(
        (m) =>
          m.confirmed &&
          inSegment(m, segmentInput.parse(campaign.segment), Date.now()),
      )
    : [];
  for (const m of targets)
    await queueMessage(tx, tenantId, {
      memberId: m.id,
      campaignId: campaign.id,
      kind: "campaign",
      channel: channel!,
      dedupe: `c:${campaign.id}:${m.id}`,
    });
  await tx`update marketing_campaigns set state=${targets.length ? "sending" : "sent"},scheduled_at=null,launched_at=clock_timestamp(),audience=${targets.length} where id=${campaign.id}`;
  return targets.length;
}
async function requireEnabled(tx: Tx) {
  await requireClub(tx);
  if (!(await loadMarketing(tx)).enabled)
    throw new DomainError("marketing_disabled", 409);
}
export async function launchCampaign(
  tx: Tx,
  s: Session,
  raw: unknown,
  env: NodeJS.ProcessEnv,
) {
  permit(s, managers);
  requireRecentAuth(s);
  const p = launchInput.safeParse(raw);
  if (!p.success) throw new DomainError("invalid_input", 400);
  return once(
    tx,
    s,
    p.data.operationId,
    "marketing.launch",
    p.data,
    async () => {
      await requireEnabled(tx);
      const [campaign] =
        await tx`select * from marketing_campaigns where id=${p.data.campaignId} and kind='one_off' for update`;
      if (!campaign) throw new DomainError("not_found", 404);
      if (
        campaign.version !== p.data.expectedVersion ||
        campaign.state !== "draft"
      )
        throw new DomainError("stale_campaign", 409);
      if (!pickChannel(campaign.channels, sendChannels(env)))
        throw new DomainError("channel_not_configured", 409);
      if (p.data.scheduledAt) {
        const at = new Date(p.data.scheduledAt);
        if (at.getTime() < Date.now() + 60_000)
          throw new DomainError("invalid_schedule", 400);
        await tx`update marketing_campaigns set state='scheduled',scheduled_at=${at} where id=${campaign.id}`;
        await enqueueJob(tx, s, {
          kind: MARKETING_LAUNCH,
          dedupeKey: `launch:${campaign.id}`,
          payload: { campaignId: campaign.id },
          runAt: at,
        });
        await audit(tx, s, "marketing.campaign.scheduled", campaign.id, {});
        return { state: "scheduled", audience: null as number | null };
      }
      const audience = await send(tx, s.tenantId, campaign, env);
      await audit(tx, s, "marketing.campaign.launched", campaign.id, {
        audience,
      });
      return { state: audience ? "sending" : "sent", audience };
    },
  );
}
/** Job: start a scheduled campaign. A cancelled or already started one is a no-op. */
export async function launchScheduled(
  tx: Tx,
  tenantId: string,
  campaignId: string,
  env: NodeJS.ProcessEnv,
) {
  const [campaign] =
    await tx`select * from marketing_campaigns where id=${campaignId} and state='scheduled' and scheduled_at<=clock_timestamp() for update`;
  if (!campaign) return null;
  try {
    await requireEnabled(tx);
  } catch {
    await tx`update marketing_campaigns set state='cancelled',scheduled_at=null where id=${campaignId}`;
    return null;
  }
  return send(tx, tenantId, campaign, env);
}
export async function cancelCampaign(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = z
    .object({ operationId: id, campaignId: id })
    .strict()
    .safeParse(raw);
  if (!p.success) throw new DomainError("invalid_input", 400);
  return once(
    tx,
    s,
    p.data.operationId,
    "marketing.cancel",
    p.data,
    async () => {
      const [campaign] =
        await tx`select state from marketing_campaigns where id=${p.data.campaignId} and kind='one_off' for update`;
      if (!campaign) throw new DomainError("not_found", 404);
      if (!["scheduled", "sending"].includes(campaign.state))
        throw new DomainError("campaign_locked", 409);
      const stopped =
        await tx`update marketing_messages set state='skipped',error_code='cancelled',updated_at=clock_timestamp()
      where campaign_id=${p.data.campaignId} and state='queued' returning id`;
      await tx`update marketing_campaigns set state='cancelled',scheduled_at=null where id=${p.data.campaignId}`;
      await audit(tx, s, "marketing.campaign.cancelled", p.data.campaignId, {
        stopped: stopped.length,
      });
      return { state: "cancelled", stopped: stopped.length };
    },
  );
}

/** Next local occurrence of the send hour, as a job that reschedules itself. */
export async function scheduleDaily(
  tx: Tx,
  tenantId: string,
  sendHour: number,
) {
  const [r] = await tx`select timezone from restaurants where id=${tenantId}`;
  const now = Temporal.Now.zonedDateTimeISO(r.timezone);
  const today = now.with({
    hour: sendHour,
    minute: 0,
    second: 0,
    millisecond: 0,
    microsecond: 0,
    nanosecond: 0,
  });
  const at = Temporal.ZonedDateTime.compare(now, today) < 0 ? today : now;
  const key = `daily:${at.toPlainDate().toString()}`;
  // A job that already ran today (for instance while marketing was off) would swallow
  // this one under the same key. The pass is fenced by marketing_runs, so a second job
  // for the day is harmless and keeps the chain alive.
  const [existing] =
    await tx`select state from jobs where kind=${MARKETING_DAILY} and dedupe_key=${key}`;
  const spent =
    existing && !["available", "queued", "running"].includes(existing.state);
  await enqueueJob(
    tx,
    { tenantId },
    {
      kind: MARKETING_DAILY,
      dedupeKey: spent ? `${key}:${randomUUID().slice(0, 8)}` : key,
      payload: {},
      runAt: new Date(at.epochMilliseconds),
    },
  );
}

/**
 * Job: once per restaurant per local day, after the send hour. Asks newly opted-in
 * members to confirm their phone, then evaluates the active automations over the
 * window since the previous run (bounded to 72 hours, so a missed day is caught up).
 */
export async function runDaily(
  tx: Tx,
  tenantId: string,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
) {
  const settings = await loadMarketing(tx);
  try {
    await requireClub(tx);
  } catch {
    return null;
  }
  if (!settings.enabled) return null;
  const [r] = await tx`select timezone from restaurants where id=${tenantId}`;
  const local = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(
    r.timezone,
  );
  const tomorrow = local.add({ days: 1 }).with({
    hour: settings.sendHour,
    minute: 0,
    second: 0,
    millisecond: 0,
    microsecond: 0,
    nanosecond: 0,
  });
  // Keep the chain alive first; a duplicate key is ignored.
  await enqueueJob(
    tx,
    { tenantId },
    {
      kind: MARKETING_DAILY,
      dedupeKey: `daily:${tomorrow.toPlainDate().toString()}`,
      payload: {},
      runAt: new Date(tomorrow.epochMilliseconds),
    },
  );
  if (local.hour < settings.sendHour) return null;
  const localDate = local.toPlainDate().toString();
  await tx`select pg_advisory_xact_lock(947,hashtext(${tenantId}))`;
  const [done] =
    await tx`select 1 from marketing_runs where local_date=${localDate}`;
  if (done) return null;
  const channels = sendChannels(env);
  let confirmations = 0;
  if (channels.includes("sms")) {
    // Ask members with no confirmation, and again when an unanswered request expired.
    // Each request has its own key, so opting back in or an expired link gets a fresh
    // SMS; three requests per member is the limit.
    const pending = await tx`select m.id,m.phone_e164,
        (select count(*)::int from marketing_messages x where x.tenant_id=m.tenant_id
           and x.member_id=m.id and x.kind='confirmation') as asked
      from loyalty_members m
      left join marketing_confirmations c on c.tenant_id=m.tenant_id and c.member_id=m.id
      where m.redacted_at is null and m.marketing_opt_in
        and (c.member_id is null or (c.confirmed_at is null
          and c.requested_at<clock_timestamp()-interval '30 days'))
      order by m.id limit 2000`;
    for (const m of pending) {
      if (m.asked >= 3) continue;
      const hash = phoneHash(m.phone_e164);
      await tx`insert into marketing_confirmations(tenant_id,member_id,phone_hash) values(${tenantId},${m.id},${hash}) on conflict do nothing`;
      confirmations += await queueMessage(tx, tenantId, {
        memberId: m.id,
        campaignId: null,
        kind: "confirmation",
        channel: "sms",
        dedupe: `confirm:${m.id}:${hash.slice(0, 16)}:${m.asked}`,
      });
    }
  }
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
    await tx`select * from marketing_campaigns where kind='automation' and state='active'`;
  let queued = 0;
  if (automations.length && channels.length) {
    const capped = new Set(
      (
        await tx`select distinct member_id from marketing_messages where kind='automation' and state<>'skipped'
          and created_at>=${new Date(now - settings.frequencyCapDays * 86_400_000)}`
      ).map((m) => m.member_id as string),
    );
    for (const member of await memberStats(tx, window)) {
      if (!member.confirmed || capped.has(member.id)) continue;
      for (const key of automationKeys) {
        const automation = automations.find((a) => a.automation_key === key);
        if (!automation) continue;
        const suffix = qualifies(
          key,
          member,
          automationParams.parse(automation.params),
          window,
        );
        const channel = pickChannel(automation.channels, channels);
        if (!suffix || !channel) continue;
        queued += await queueMessage(tx, tenantId, {
          memberId: member.id,
          campaignId: automation.id,
          kind: "automation",
          channel,
          dedupe: `a:${key}:${member.id}:${suffix}`,
        });
        break;
      }
    }
  }
  await tx`insert into marketing_runs(tenant_id,local_date,window_start,window_end,queued) values(${tenantId},${localDate},${new Date(window.start)},${new Date(window.end)},${queued})`;
  return { localDate, window, queued, confirmations };
}

/** Public: the member opens the link from the confirmation message. */
export async function confirmMarketing(
  tx: Tx,
  memberId: string,
  tokenHash: string,
) {
  // The only writer of confirmed_at (047): it needs the digest of the token that was sent.
  const [row] =
    await tx`select marketing_confirm(${memberId}::uuid,${tokenHash}) as ok`;
  if (!row?.ok) throw new DomainError("unauthorized", 401);
  const [r] = await tx`select name from restaurants`;
  return { confirmed: true, restaurant: r.name as string };
}

/**
 * Last-touch estimate: an order counts for the most recent message its member was
 * sent within the attribution window before ordering; each order counts once.
 */
export async function performance(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  await requireClub(tx);
  const p = z
    .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
    .strict()
    .parse(raw);
  const settings = await loadMarketing(tx);
  const since = new Date(Date.now() - p.days * 86_400_000);
  const [r] = await tx`select timezone from restaurants where id=${s.tenantId}`;
  const attributed = await tx`
    with touched as (
      select o.id,o.total,o.channel,o.created_at,
        (select m.id from marketing_messages m where m.tenant_id=o.tenant_id and m.member_id=l.member_id
           and m.kind<>'confirmation' and m.sent_at<o.created_at
           and m.sent_at>=o.created_at-make_interval(days=>${settings.attributionDays})
           order by m.sent_at desc limit 1) as message_id
      from orders o join loyalty_order_links l on l.tenant_id=o.tenant_id and l.order_id=o.id
      where l.member_id is not null and o.state<>'cancelled' and o.created_at>=${since}
    )
    select m.campaign_id,t.total,t.channel as order_channel,
      to_char(t.created_at at time zone ${r.timezone},'YYYY-MM-DD') as day
    from touched t join marketing_messages m on m.id=t.message_id`;
  const sent =
    await tx`select campaign_id,state,count(*)::int as count from marketing_messages
    where kind<>'confirmation' and created_at>=${since} group by 1,2`;
  const names =
    await tx`select id,name,kind,automation_key from marketing_campaigns`;
  const sum = (rows: readonly any[]) => rows.reduce((a, x) => a + x.total, 0);
  const group = (key: string) =>
    Object.entries(
      attributed.reduce<Record<string, any[]>>((acc, row) => {
        (acc[String(row[key])] ??= []).push(row);
        return acc;
      }, {}),
    )
      .map(([label, list]) => ({
        label,
        orders: list.length,
        sales: sum(list),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  const count = (states: string[], campaignId?: string) =>
    sent
      .filter(
        (x) =>
          states.includes(x.state) &&
          (!campaignId || x.campaign_id === campaignId),
      )
      .reduce((a, x) => a + x.count, 0);
  return {
    days: p.days,
    attributionDays: settings.attributionDays,
    estimate: true,
    sent: count(["sent", "delivered"]),
    failed: count(["failed"]),
    skipped: count(["skipped"]),
    unknown: count(["unknown"]),
    attributedOrders: attributed.length,
    attributedSales: sum(attributed),
    averageOrder: attributed.length
      ? Math.round(sum(attributed) / attributed.length)
      : 0,
    byDay: group("day"),
    byOrderSource: group("order_channel"),
    byCampaign: names
      .map((c) => {
        const list = attributed.filter((x) => x.campaign_id === c.id);
        return {
          id: c.id as string,
          name: c.name as string,
          automationKey: c.automation_key as string | null,
          sent: count(["sent", "delivered"], c.id),
          orders: list.length,
          sales: sum(list),
        };
      })
      .filter((c) => c.sent || c.orders),
  };
}
