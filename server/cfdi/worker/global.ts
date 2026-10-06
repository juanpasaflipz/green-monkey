/**
 * cfdi_global (spec §4.8.6): the global-invoice scheduler, builder and sweeps. DB only; stamping
 * is cfdi_stamp's.
 *
 *   1. settings (exit when paused); 2. add the period rows after the mode's last one through the
 *      current period, never re-deriving a past date (periodsAfter); 3. promote a pending
 *      periodicity on its first day;
 *   4. build each due period (closed + grace), oldest first, in its own transaction under a
 *      per-(tenant, mode, period) advisory key: every ticket of the period not claimed in this mode,
 *      in folio order, split into parts of ≤ 4,000 concepts (a ticket never split);
 *   5. late sweep: tickets of recent built/empty periods still unclaimed (offline syncs, repairs,
 *      tickets freed by a cancellation) go into a SUPPLEMENTARY part of THEIR OWN period (decision
 *      D5, binding), flagged and alerted when created after the period's due time;
 *   5b. refund sweep: re-enqueues credit-note decisions a dead cfdi_refund job left behind (never
 *       for a refund that already has a credit note, failed ones included: those wait for
 *       Reintentar);
 *   5c. recovery sweep: re-enqueues the job of a document whose job is gone (server/cfdi/recovery.ts);
 *   6. overdue alert (once per period); 7. CSD expiry notice;
 *   8. the next tick at the next close + grace or within 6 h (bucketed so concurrent chains merge).
 * The chain never ends on errors (review CFDI-R3): the last failing attempt schedules a fresh tick
 * at the next hour before it goes dead (jobs_dead_cfdi_global still alerts), and the worker boot
 * and GET /cfdi/status restart a chain that has no live tick (ensureTick).
 */
import { randomUUID } from "node:crypto";
import type { JobContext, JobOutcome } from "../../jobs.js";
import type { Tx } from "../../db.js";
import { Temporal } from "@js-temporal/polyfill";
import { businessDate } from "../../../shared/domain.js";
import {
  firstOfNextMonth,
  globalPeriodFor,
  periodClosesAt,
  periodicityOn,
  type GlobalPeriod,
  type Periodicity,
} from "../../../shared/cfdi.js";
import { buildGlobalRequests } from "../build.js";
import { lockPeriod } from "../locks.js";
import {
  cfdiEnqueue,
  dedupe,
  enqueueStamp,
  GLOBAL_MAX_ATTEMPTS,
  lastAttempt,
  liveJob,
  retryOrExhaust,
} from "../jobs.js";
import {
  enqueueRecovery,
  recoveryAction,
  recoveryCandidates,
} from "../recovery.js";
import {
  fiscalFacts,
  loadDocument,
  loadOrganization,
  loadSettings,
  modeFrom,
  unclaimedTickets,
  type FiscalFacts,
  type SettingsRow,
} from "../store.js";
import { event, HOUR, MINUTE, runtimeOr } from "./common.js";
import { raise, tenantTag, type CfdiRuntime } from "./runtime.js";
import { loadTickets } from "./tickets.js";
import { rejectAbandonedUploads } from "./csd.js";

type Payload = { periodKey?: string; force?: boolean };
type PeriodRow = {
  periodKey: string;
  periodicity: Periodicity;
  from: string;
  to: string;
  closesAt: string;
  dueAt: string;
  status: "open" | "built" | "empty";
};

const plusDays = (date: string, n: number) =>
  Temporal.PlainDate.from(date).add({ days: n }).toString();

/**
 * The period rows to add after `last`, the latest existing row of this mode (from the mode's start
 * date when there is none), through the one containing `today` (CFDI-R2-1). Past dates are never
 * re-derived, so a periodicity change can only shape dates that have no row yet: a period in the
 * month of the previous row continues that row's periodicity (periods never cross a month, so the
 * month's partition goes on), and a new month takes the periodicity in force on its first day (a
 * pending change applies from the first of a month). At most `cap` rows per tick; the next tick
 * continues after the last one.
 */
export function periodsAfter(
  last: { to: string; periodicity: Periodicity } | null,
  from: string,
  today: string,
  s: Pick<
    SettingsRow,
    "globalPeriodicity" | "nextPeriodicity" | "nextPeriodicityFrom"
  >,
  cap = 2000,
): GlobalPeriod[] {
  const out: GlobalPeriod[] = [];
  let prev = last;
  let start = last ? plusDays(last.to, 1) : from;
  while (start <= today && out.length < cap) {
    const p = globalPeriodFor(
      start,
      prev && prev.to.slice(0, 7) === start.slice(0, 7)
        ? prev.periodicity
        : periodicityOn(start, s),
    );
    out.push(p);
    prev = p;
    start = plusDays(p.to, 1);
  }
  return out;
}

/** 6-hour UTC boundaries after `now`: shared by every tick chain, so chains merge by dedupe key. */
export function nextSixHours(now: Date): Date {
  const six = 6 * HOUR;
  return new Date((Math.floor(now.getTime() / six) + 1) * six);
}

function periodRow(r: Record<string, any>): PeriodRow {
  return {
    periodKey: r.period_key,
    periodicity: r.periodicity,
    from: r.from_date,
    to: r.to_date,
    closesAt: new Date(r.closes_at).toISOString(),
    dueAt: new Date(r.due_at).toISOString(),
    status: r.status,
  };
}

/** Unclaimed tickets of a period in this mode with net gross > 0, in folio order. */
async function eligibleTicketIds(
  tx: Tx,
  period: Pick<PeriodRow, "from" | "to">,
  mode: string,
  from: string,
  limit?: number,
): Promise<string[]> {
  const rows = await tx`
    select t.id, t.gross,
      coalesce((select sum(a.gross) from fiscal_adjustments a
        where a.tenant_id = t.tenant_id and a.order_id = t.order_id), 0)::int as refunded
    from fiscal_tickets t
    where t.business_date between ${period.from}::date and ${period.to}::date
      and t.business_date >= ${from}::date
      and not exists (select 1 from cfdi_document_tickets c where c.tenant_id = t.tenant_id
        and c.ticket_id = t.id and c.mode = ${mode} and c.state <> 'released')
    order by t.series, t.number
    ${limit ? tx`limit ${limit}` : tx``}`;
  return rows.filter((r) => r.refunded < r.gross).map((r) => r.id as string);
}

class NoTickets extends Error {}

/** Step 4 for one period: parts, claims and stamping jobs. Returns the parts created. */
async function buildPeriod(
  rt: CfdiRuntime,
  ctx: JobContext,
  key: string,
  ctxData: {
    settings: SettingsRow;
    facts: FiscalFacts;
    mode: "test" | "live";
    from: string;
  },
  o: { force: boolean },
): Promise<void> {
  const tenantId = ctx.job.tenantId;
  const { settings, facts, mode } = ctxData;
  const created: { id: string; part: number; late: boolean }[] = [];
  let excludedCount = 0;
  let periodDue = "";
  await ctx.tenant(async (tx) => {
    await tx`select set_config('statement_timeout', '30s', true)`;
    await lockPeriod(tx, tenantId, mode, key);
    const [row] = await tx`
      select *, date_from::text as from_date, date_to::text as to_date from cfdi_global_periods
      where mode = ${mode} and period_key = ${key} for update`;
    if (!row) return;
    const period = periodRow(row);
    periodDue = period.dueAt;
    if (Date.parse(period.closesAt) > Date.now()) return;
    if (period.status === "open" && !settings.globalAuto && !o.force) return;
    const ids = await eligibleTicketIds(tx, period, mode, ctxData.from);
    const { tickets, excluded } = await loadTickets(tx, ids);
    excludedCount = excluded.length;
    for (const x of excluded)
      await event(tx, ctx, null, "ticket_excluded", {
        ticketId: x.id,
        folio: x.folio,
        code: x.code,
        period: key,
      });
    const kept = tickets.filter((t) => t.groups.length > 0);
    const [{ parts: existing }] = await tx`
      select count(*)::int as parts from cfdi_documents
      where kind = 'global' and mode = ${mode} and period_key = ${key}`;
    if (!kept.length) {
      if (period.status === "open" && existing === 0)
        await tx`
          update cfdi_global_periods set status = 'empty', built_at = now()
          where mode = ${mode} and period_key = ${key}`;
      return;
    }
    if (!facts.postalCode) return;
    const late = period.status !== "open";
    const parts = buildGlobalRequests({
      docIds: randomUUID,
      tickets: kept,
      period: {
        periodicity: period.periodicity,
        months: period.from.slice(5, 7),
        year: Number(period.from.slice(0, 4)),
      },
      issuerPostalCode: facts.postalCode,
      cardForm: settings.cardPaymentForm,
    });
    let claimed = 0;
    for (const part of parts) {
      const won = await tx
        .savepoint(async (raw) => {
          const sp = raw as Tx;
          const [{ next }] = await sp`
            select coalesce(max(part), 0) + 1 as next from cfdi_documents
            where kind = 'global' and mode = ${mode} and period_key = ${key}`;
          await sp`
            insert into cfdi_documents(tenant_id, id, kind, source, mode, status, period_key, global_info, part)
            values (${tenantId}, ${part.docId}, 'global', 'scheduler', ${mode}, 'queued', ${key},
              ${sp.json({ periodicity: period.periodicity, months: period.from.slice(5, 7), year: Number(period.from.slice(0, 4)), from: period.from, to: period.to })},
              ${next})`;
          const rows = await sp`
            insert into cfdi_document_tickets(tenant_id, document_id, ticket_id, mode, state)
            select ${tenantId}, ${part.docId}, t, ${mode}, 'active' from unnest(${part.ticketIds}::uuid[]) t
            on conflict (tenant_id, ticket_id, mode) where state = 'active' do nothing
            returning ticket_id`;
          if (!rows.length) throw new NoTickets();
          return { part: Number(next), tickets: rows.length };
        })
        .catch((e) => {
          if (e instanceof NoTickets) return null;
          throw e;
        });
      if (!won) continue;
      claimed += won.tickets;
      const isLate = late && Date.now() > Date.parse(period.dueAt);
      created.push({ id: part.docId, part: won.part, late: isLate });
      await enqueueStamp(tx, tenantId, part.docId, {
        maxAttempts: GLOBAL_MAX_ATTEMPTS,
      });
      await event(tx, ctx, part.docId, "requested", {
        source: "scheduler",
        tickets: won.tickets,
        late,
      });
      if (isLate)
        await event(tx, ctx, part.docId, "late_global", {
          dueAt: period.dueAt,
        });
    }
    if (created.length)
      await tx`
        update cfdi_global_periods set status = 'built', built_at = coalesce(built_at, now()),
          documents = documents + ${created.length},
          late_tickets = late_tickets + ${late ? claimed : 0}
        where mode = ${mode} and period_key = ${key}`;
  });
  for (const c of created)
    if (c.late)
      raise(rt, {
        key: `cfdi_global_late:${tenantTag(tenantId)}:${mode}:${key}:p${c.part}`,
        severity: "warning",
        title: "CFDI global issued late",
        body: `tenant ${tenantTag(tenantId)} period ${key} part ${c.part} due ${periodDue}`,
      });
  if (excludedCount)
    raise(rt, {
      key: `cfdi_ticket_excluded:${tenantTag(tenantId)}:${mode}:${key}`,
      severity: "warning",
      title: "CFDI tickets left out of a global",
      body: `tenant ${tenantTag(tenantId)} period ${key} tickets ${excludedCount}`,
    });
}

/** The top of the next UTC hour: a failing chain's fresh tick (merges with any tick keyed there). */
export function nextHour(now: Date): Date {
  return new Date((Math.floor(now.getTime() / HOUR) + 1) * HOUR);
}

/**
 * Arms the chain's next tick at runAt. That hour's key may already belong to a tick that ran
 * ahead of its time (a restarted chain, "Emitir ahora"): the jobs uniqueness then drops the
 * insert, so a key suffixed with the current job keeps one live tick. Every path that ends a
 * tick and must keep the chain alive arms through here.
 */
async function armNextTick(
  tx: Tx,
  tenantId: string,
  runAt: Date,
  currentJobId: string,
): Promise<void> {
  await cfdiEnqueue(tx, tenantId, {
    kind: "cfdi_global",
    dedupeKey: dedupe.tick(runAt),
    payload: {},
    runAt,
  });
  if (!(await liveJob(tx, "cfdi_global", {}, { exceptId: currentJobId })))
    await cfdiEnqueue(tx, tenantId, {
      kind: "cfdi_global",
      dedupeKey: `${dedupe.tick(runAt)}:${currentJobId.slice(0, 8)}`,
      payload: {},
      runAt,
    });
}

export async function globalJob(ctx: JobContext): Promise<JobOutcome> {
  const { rt, outcome } = await runtimeOr(ctx);
  if (!rt) return outcome;
  try {
    return await runTick(rt, ctx);
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const failure = {
      code:
        typeof code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(code)
          ? code
          : "cfdi_global_error",
      afterMs: 5 * MINUTE,
    };
    if (lastAttempt(ctx.job)) {
      // The chain must outlive a persistent error: its next tick is scheduled before this job
      // goes dead (jobs_dead_cfdi_global alerts the operator).
      const runAt = nextHour(new Date());
      await ctx
        .tenant((tx) => armNextTick(tx, ctx.job.tenantId, runAt, ctx.job.id))
        .catch((error) =>
          ctx.log.warn("cfdi_global_handover_failed", {}, error),
        );
    }
    return retryOrExhaust(ctx.job, failure);
  }
}

async function runTick(rt: CfdiRuntime, ctx: JobContext): Promise<JobOutcome> {
  const p = (ctx.job.payload ?? {}) as Payload;
  const tenantId = ctx.job.tenantId;
  const grace = rt.config.graceMinutes * MINUTE;
  const now = new Date();

  // 0. CSD uploads whose job is gone never keep their sealed box (CFDI-SECRETS-1), paused or not.
  await ctx.tenant((tx) => rejectAbandonedUploads(tx, ctx));

  // 1-3. Settings, period rows, then the periodicity promotion. The settings row is locked so a
  // periodicity save (which checks for period rows under the same lock) and this tick serialize.
  const plan = await ctx.tenant(async (tx) => {
    let settings = await loadSettings(tx, { forUpdate: true });
    if (!settings?.enabled) return null;
    const facts = await fiscalFacts(tx);
    const today = businessDate(now.toISOString(), facts.timezone, facts.cutoff);
    const mode = settings.mode;
    // A restaurant that became RESICO (626) after choosing another periodicity moves to monthly
    // globals from the first of next month (decision D4; CFDI-SAT-4): past periods keep theirs.
    if (
      facts.regime === "626" &&
      (settings.nextPeriodicity ?? settings.globalPeriodicity) !== "month"
    ) {
      await tx`
        update cfdi_settings set next_periodicity = 'month',
          next_periodicity_from = ${firstOfNextMonth(today)}::date, version = version + 1,
          updated_at = now()`;
      settings = (await loadSettings(tx))!;
    }
    const from = modeFrom(settings);
    // New rows only, after the last one of this mode, with the settings as they are BEFORE the
    // promotion: a pending change still applies only from its first-of-month date, even when
    // this tick runs days after it (CFDI-R2-1).
    const [last] = await tx`
      select date_to::text as to_date, periodicity from cfdi_global_periods
      where mode = ${mode} order by date_to desc limit 1`;
    const periods = periodsAfter(
      last ? { to: last.to_date, periodicity: last.periodicity } : null,
      from,
      today,
      settings,
    );
    if (periods.length)
      await tx`
        insert into cfdi_global_periods(tenant_id, mode, period_key, periodicity, date_from, date_to, closes_at, due_at)
        select ${tenantId}, ${mode}, k, p, f::date, t::date, c::timestamptz, c::timestamptz + interval '24 hours'
        from unnest(${periods.map((x) => x.key)}::text[], ${periods.map((x) => x.periodicity)}::text[],
          ${periods.map((x) => x.from)}::text[], ${periods.map((x) => x.to)}::text[],
          ${periods.map((x) => periodClosesAt(x, facts.timezone, facts.cutoff))}::text[]) as v(k, p, f, t, c)
        on conflict (tenant_id, mode, period_key) do nothing`;
    if (
      settings.nextPeriodicity &&
      settings.nextPeriodicityFrom &&
      settings.nextPeriodicityFrom <= today
    ) {
      await tx`
        update cfdi_settings set global_periodicity = next_periodicity, next_periodicity = null,
          next_periodicity_from = null, version = version + 1, updated_at = now()
        where next_periodicity is not null and next_periodicity_from <= ${today}::date`;
      settings = (await loadSettings(tx))!;
    }
    const due = await tx`
      select period_key from cfdi_global_periods
      where mode = ${mode} and status = 'open' and closes_at <= ${new Date(now.getTime() - grace)}
      order by date_from`;
    // Late sweep candidates: recent built/empty periods whose latest part did not fail.
    const recent = await tx`
      select g.period_key, g.date_from::text as from_date, g.date_to::text as to_date from cfdi_global_periods g
      where g.mode = ${mode} and g.status in ('built','empty')
        and g.date_to >= (${today}::date - 62)
        and not exists (select 1 from cfdi_documents d where d.tenant_id = g.tenant_id and d.mode = g.mode
          and d.kind = 'global' and d.period_key = g.period_key and d.status = 'failed'
          and not exists (select 1 from cfdi_documents n where n.tenant_id = d.tenant_id and n.mode = d.mode
            and n.kind = 'global' and n.period_key = d.period_key and n.part > d.part))
      order by g.date_from`;
    const late: string[] = [];
    for (const r of recent)
      if (
        (
          await eligibleTicketIds(
            tx,
            { from: r.from_date, to: r.to_date },
            mode,
            from,
            1,
          )
        ).length
      )
        late.push(r.period_key);
    return {
      settings,
      facts,
      mode,
      from,
      today,
      keys: [...new Set([...due.map((r) => r.period_key as string), ...late])],
    };
  });
  if (!plan) {
    // Paused (or not activated): the chain ends, unless a CSD upload is still open. Its sweep
    // (step 0) must run once the upload's job is gone, so the next hour's tick looks again
    // (CFDI-INT-7); the chain ends with the last open upload.
    await ctx.tenant(async (tx) => {
      const [open] = await tx`
        select 1 as one from cfdi_csd_uploads
        where tenant_id = ${tenantId} and status in ('queued','processing') limit 1`;
      if (!open) return;
      await armNextTick(tx, tenantId, nextHour(now), ctx.job.id);
    });
    return { status: "done" };
  }

  // 4-5. Due periods and late sweeps (oldest first), plus a forced period ("Emitir ahora").
  const keys = [...plan.keys];
  if (p.force && p.periodKey && !keys.includes(p.periodKey))
    keys.push(p.periodKey);
  for (const key of keys) {
    await buildPeriod(rt, ctx, key, plan, {
      force: !!p.force && p.periodKey === key,
    });
    await ctx.extendLease(300).catch(() => undefined);
  }

  // 5c. Recovery sweep (CFDI-R2): documents whose job is gone, at most once a day each.
  await ctx.tenant(async (tx) => {
    const tag = "s" + plan.today.replaceAll("-", "");
    for (const id of await recoveryCandidates(tx)) {
      const doc = await loadDocument(tx, id);
      const action = doc ? await recoveryAction(tx, doc) : null;
      if (!doc || !action) continue;
      if (
        await enqueueRecovery(tx, tenantId, doc, action, {
          tag,
          unlessLive: true,
          worker: true,
        })
      )
        await event(tx, ctx, doc.id, "recovery_queued", {
          action: action.kind,
          by: "sweep",
        });
    }
  });

  // 5b-8. Refund sweep, alerts and the next tick. A refund whose credit note failed is not
  // re-created every day (CFDI-R7): only Reintentar (force) issues a new one.
  const alerts = await ctx.tenant(async (tx) => {
    const refunds = await tx`
      select distinct a.refund_id from fiscal_adjustments a
      join fiscal_tickets t on t.tenant_id = a.tenant_id and t.order_id = a.order_id
      join cfdi_document_tickets c on c.tenant_id = t.tenant_id and c.ticket_id = t.id
        and c.mode = ${plan.mode} and c.state = 'active'
      join cfdi_documents d on d.tenant_id = c.tenant_id and d.id = c.document_id and d.status = 'valid'
      where a.business_date >= (${plan.today}::date - 62)
        and not (a.refund_id = any(d.netted_refund_ids))
        and not exists (select 1 from cfdi_documents e where e.tenant_id = a.tenant_id and e.kind = 'egreso'
          and e.refund_id = a.refund_id and e.mode = ${plan.mode} and e.status <> 'canceled')
      limit 200`;
    for (const r of refunds)
      await cfdiEnqueue(tx, tenantId, {
        kind: "cfdi_refund",
        dedupeKey: dedupe.refundSweep(r.refund_id, plan.today),
        payload: { refundId: r.refund_id },
      });
    const overdue = await tx`
      update cfdi_global_periods g set alerted_at = now()
      where g.mode = ${plan.mode} and g.alerted_at is null and g.due_at < now()
        and ((g.status = 'open' and exists (select 1 from fiscal_tickets t
               where t.business_date between g.date_from and g.date_to and t.business_date >= ${plan.from}::date
                 and not exists (select 1 from cfdi_document_tickets c where c.tenant_id = t.tenant_id
                   and c.ticket_id = t.id and c.mode = g.mode and c.state <> 'released')))
          or exists (select 1 from cfdi_documents d where d.tenant_id = g.tenant_id and d.mode = g.mode
            and d.kind = 'global' and d.period_key = g.period_key
            and d.status in ('failed','queued','stamping','pending'))
          -- A built period with a ticket in no CFDI (CFDI-MONEY-2, SAT-1).
          or (g.status in ('built','empty') and ${unclaimedTickets(tx, tx`${plan.from}::date`)}))
      returning g.period_key`;
    const org = await loadOrganization(tx);
    const [next] = await tx`
      select min(closes_at) as at from cfdi_global_periods
      where mode = ${plan.mode} and status = 'open' and closes_at > ${new Date(now.getTime() - grace)}`;
    const closeAt = next?.at
      ? new Date(new Date(next.at).getTime() + grace)
      : null;
    const fallback = nextSixHours(now);
    let runAt = closeAt && closeAt < fallback ? closeAt : fallback;
    if (runAt.getTime() < now.getTime() + MINUTE)
      runAt = new Date(now.getTime() + MINUTE);
    await armNextTick(tx, tenantId, runAt, ctx.job.id);
    return {
      overdue: overdue.map((r) => r.period_key as string),
      csdSoon:
        org?.csdStatus === "valid" &&
        !!org.csdValidUntil &&
        Date.parse(org.csdValidUntil) < Date.now() + 30 * 24 * HOUR,
    };
  });
  for (const key of alerts.overdue)
    raise(rt, {
      key: `cfdi_global_overdue:${tenantTag(tenantId)}:${plan.mode}:${key}`,
      severity: "warning",
      title: "CFDI global overdue",
      body: `tenant ${tenantTag(tenantId)} period ${key}`,
    });
  if (alerts.csdSoon)
    raise(rt, {
      key: `cfdi_csd_expiring:${tenantTag(tenantId)}`,
      severity: "info",
      title: "CFDI certificate expires soon",
      body: `tenant ${tenantTag(tenantId)} days<30`,
    });
  return { status: "done" };
}
