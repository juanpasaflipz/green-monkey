import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { deliveryProvider, type DeliveryStore } from "../../shared/delivery.js";
import { queueDelivery } from "../delivery/queue.js";
import { DeliveryError, parseUberReport } from "../delivery/parse.js";
import type { Tx } from "../db.js";
import type { JobHandler, JobDeadHook } from "../jobs.js";
import { BrowserbaseDriver } from "./browserbase.js";
import { UBER_REPORTS, uberExport, uberStores } from "./uber.js";
import { entitlement } from "../entitlements.js";

const payload = z.object({
  provider: deliveryProvider,
  generation: z.number().int(),
  action: z.enum([
    "connect",
    "verify",
    "sync",
    "disconnect",
    "expire",
    "maintain",
  ]),
});
export let deliveryDriver: BrowserbaseDriver | null = null;
export function setDeliveryDriver(driver: BrowserbaseDriver | null) {
  deliveryDriver = driver;
}
export async function deliveryBoot(
  sql: postgres.Sql | null,
  env: NodeJS.ProcessEnv,
) {
  if (!sql) return;
  if (env.DELIVERY_BROWSER_ENABLED === "1") {
    if (!env.BROWSERBASE_API_KEY || !env.BROWSERBASE_PROJECT_ID)
      throw new Error("delivery_browser_configuration_missing");
    setDeliveryDriver(
      new BrowserbaseDriver(
        env.BROWSERBASE_API_KEY,
        env.BROWSERBASE_PROJECT_ID,
      ),
    );
  } else setDeliveryDriver(null);
  const publish = async () => {
    await sql`update delivery_platform set available=${deliveryDriver ? ["uber_eats"] : []}::text[],updated_at=now() where id=1`;
  };
  try {
    await publish();
  } catch (e) {
    if ((e as { code?: string }).code === "42P01" && !deliveryDriver) return;
    throw e;
  }
  const timer = setInterval(() => {
    void publish().catch(() => {});
  }, 30000);
  timer.unref();
}

export const deliveryDead: JobDeadHook = async ({ tx, job, code }) => {
  const p = payload.safeParse(job.payload);
  if (!p.success) return;
  if (p.data.action === "maintain") {
    await queueDelivery(
      tx,
      job.tenantId,
      p.data.provider,
      p.data.generation,
      "maintain",
      new Date(Date.now() + 86400000),
    );
    return;
  }
  if (p.data.action === "sync" && code !== "cancelled") {
    const [r] = await tx`select c.store_id,b.report_day::text as day,
      (((now() at time zone r.timezone)::date+1)+(r.cutoff+30)*interval '1 minute') at time zone r.timezone as next_run
      from delivery_connections c join delivery_browser_contexts b using(tenant_id,provider)
      join restaurants r on r.id=c.tenant_id
      where c.provider=${p.data.provider} and c.generation=${p.data.generation}
        and c.state in ('connected','syncing') for update of c,b`;
    if (r?.store_id) {
      if (r.day)
        await tx`insert into delivery_day_attempts(tenant_id,provider,store_id,day,error_code)
        values(${job.tenantId},${p.data.provider},${p.data.generation + ":" + r.store_id},${r.day},'delivery_retry_exhausted')
        on conflict(tenant_id,provider,store_id,day) do update set error_code=excluded.error_code,
          attempts=delivery_day_attempts.attempts+1,next_attempt_at=now()+interval '1 day',updated_at=now()`;
      await tx`update delivery_browser_contexts set report_day=null,download_session_id=null,
        download_started_at=null,request_started_at=null where provider=${p.data.provider}`;
      await tx`update delivery_connections set state='connected',error_code=null,updated_at=now()
        where provider=${p.data.provider} and generation=${p.data.generation}`;
      await queueDelivery(
        tx,
        job.tenantId,
        p.data.provider,
        p.data.generation,
        "sync",
        r.next_run,
      );
      return;
    }
  }
  await tx`update delivery_connections set state=case when state='disconnecting' then state else 'attention' end,
    error_code='delivery_retry_exhausted',login_url=null,login_expires_at=null,updated_at=now()
    where provider=${p.data.provider} and generation=${p.data.generation}
    and (${p.data.action}<>'expire' or state='awaiting_login')`;
};

export const deliveryHandler: JobHandler = async (ctx) => {
  const parsed = payload.safeParse(ctx.job.payload);
  if (!parsed.success)
    return { status: "dead", code: "delivery_payload_invalid" };
  const p = parsed.data,
    driver = deliveryDriver,
    token = randomUUID();
  if (!driver)
    return { status: "retry", code: "delivery_unavailable", afterMs: 300000 };
  if (p.provider !== "uber_eats")
    return { status: "dead", code: "delivery_unavailable" };
  // Queue leases fence DB writes; a separate connection lease serializes different
  // jobs (including disconnect). No transaction remains open during browser work.
  const fenced = async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    ctx.tenant(async (tx) => {
      const [job] =
        await tx`select 1 from jobs where id=${ctx.job.id} and state='running'
      and lease_until=${ctx.job.lease}::text::timestamptz and lease_until>clock_timestamp() for update`;
      if (!job || ctx.signal.aborted)
        throw new DeliveryError("delivery_lease_lost");
      return fn(tx);
    });
  const row = await fenced(async (tx) => {
    const [r] =
      await tx`select * from delivery_connections where provider=${p.provider} for update`;
    if (!r || r.generation !== p.generation) return null;
    if (p.action === "maintain" && r.state === "disconnected") return null;
    if (p.action === "expire" && r.state !== "awaiting_login") return null;
    if (
      p.action === "sync" &&
      (!r.store_id || !["syncing", "connected"].includes(r.state))
    )
      return null;
    if (
      p.action === "connect" &&
      !["preparing", "awaiting_login"].includes(r.state)
    )
      return null;
    if (p.action === "verify" && r.state !== "verifying") return null;
    await tx`insert into delivery_browser_contexts(tenant_id,provider) values(${ctx.job.tenantId},${p.provider}) on conflict do nothing`;
    const [secret] =
      await tx`update delivery_browser_contexts set operation_token=${token},operation_until=now()+interval '180 seconds'
      where provider=${p.provider} and (operation_until is null or operation_until<now()) returning *,report_day::text as pinned_day`;
    if (!secret) return "busy" as const;
    return { ...r, ...secret };
  });
  if (row === null) return;
  if (row === "busy")
    return { status: "retry", code: "delivery_busy", afterMs: 15000 };
  const work = async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    fenced(async (tx) => {
      const [lock] =
        await tx`select 1 from delivery_browser_contexts where provider=${p.provider}
      and operation_token=${token} and operation_until>clock_timestamp() for update`;
      if (!lock) throw new DeliveryError("delivery_lease_lost");
      return fn(tx);
    });
  const attemptKey = `${p.generation}:${row.store_id}`;
  let syncDay: string | null = null;
  let syncNext: Date | null = null;
  let syncYesterday: string | null = null;
  const releaseStored = async () => {
    if (!row.session_id) return;
    await driver.release(
      row.session_id,
      AbortSignal.any([ctx.signal, AbortSignal.timeout(45000)]),
    );
    await work(async (tx) => {
      await tx`update delivery_browser_contexts set session_id=null where provider=${p.provider}`;
    });
    row.session_id = null;
  };
  const finishVerify = async (stores: DeliveryStore[]) => {
    await releaseStored();
    await work(async (tx) => {
      await tx`update delivery_browser_contexts set verified_stores=null,report_day=null where provider=${p.provider}`;
      await tx`update delivery_connections set state='choose_store',stores=${tx.json(stores)},login_url=null,
        login_expires_at=null,error_code=null,updated_at=now() where provider=${p.provider} and generation=${p.generation}`;
    });
  };
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(120000)]);
  const update = async (
    state: string,
    extra: {
      stores?: DeliveryStore[];
      url?: string;
      expires?: Date;
      error?: string;
    } = {},
  ) =>
    work(async (tx) => {
      await tx`update delivery_connections set state=${state},stores=coalesce(${extra.stores ? tx.json(extra.stores) : null}::jsonb,stores),
      login_url=${extra.url ?? null},login_expires_at=${extra.expires ?? null},error_code=${extra.error ?? null},updated_at=now()
      where provider=${p.provider} and generation=${p.generation}`;
    });
  try {
    if (p.action === "expire") {
      await releaseStored();
      if (row.context_id) await driver.deleteContext(row.context_id, signal);
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set session_id=null,context_id=null,identity_verified=false where provider=${p.provider}`;
      });
      await update("attention", { error: "delivery_reconnect" });
      return;
    }
    if (p.action === "disconnect") {
      await releaseStored();
      if (row.context_id) await driver.deleteContext(row.context_id, signal);
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set identity_verified=false,download_scope_verified=false,context_id=null,session_id=null,report_day=null,download_session_id=null,download_started_at=null,request_started_at=null,verified_stores=null where provider=${p.provider}`;
        await tx`update delivery_connections set state='disconnected',stores='[]',store_id=null,store_name=null,store_uuid=null,
          login_url=null,login_expires_at=null,error_code=null,updated_at=now() where provider=${p.provider} and generation=${p.generation}`;
      });
      return;
    }
    if (!(await work(async (tx) => (await entitlement(tx)).plan === "pro"))) {
      await releaseStored();
      if (row.context_id) await driver.deleteContext(row.context_id, signal);
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set identity_verified=false,download_scope_verified=false,context_id=null,download_session_id=null,download_started_at=null,request_started_at=null,verified_stores=null where provider=${p.provider}`;
      });
      await update("attention", { error: "pro_required" });
      return;
    }
    if (p.action === "maintain") {
      await work((tx) =>
        queueDelivery(
          tx,
          ctx.job.tenantId,
          p.provider,
          p.generation,
          "maintain",
          new Date(Date.now() + 86400000),
        ),
      );
      return;
    }
    if (p.action === "verify" && row.verified_stores) {
      await finishVerify(row.verified_stores as DeliveryStore[]);
      return;
    }
    // A reconnect must start with a clean browser: never expose the previous owner's session.
    let contextId = row.context_id as string | null;
    if (p.action === "connect" && row.state === "preparing" && contextId) {
      await releaseStored();
      await driver.deleteContext(contextId, signal);
      contextId = null;
      row.session_id = null;
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set identity_verified=false,download_scope_verified=false,context_id=null,session_id=null,report_day=null,download_session_id=null,download_started_at=null,request_started_at=null,verified_stores=null where provider=${p.provider}`;
      });
    }
    if (!contextId) {
      contextId = await driver.createContext(signal);
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set context_id=${contextId} where provider=${p.provider}`;
      });
    }
    if (p.action === "sync" && !row.pinned_day && row.session_id)
      await releaseStored();
    let clock:
      { yesterday: string; day: string | null; next_run: Date } | undefined;
    if (p.action === "sync") {
      [clock] = await work(
        (tx) => tx<
          { yesterday: string; day: string | null; next_run: Date }[]
        >`with calendar as (
        select ((now() at time zone timezone)::date-1) as yesterday,
        ((now() at time zone timezone)::date)::timestamp at time zone timezone as today_start,
        (((now() at time zone timezone)::date+1)+(cutoff+30)*interval '1 minute') at time zone timezone as next_run
        from restaurants where id=${ctx.job.tenantId}
      ), progress as (
        select max(day) as last_day from (
          select day from delivery_daily_reports where provider=${p.provider} and store_id=${row.store_uuid}
          union all select day from delivery_day_attempts where provider=${p.provider} and store_id=${attemptKey}
        ) days
      ) select yesterday::text, next_run,
        (case when last_day is null or ${row.store_uuid}::text is null then yesterday
          when last_day<yesterday then greatest(last_day+1,yesterday-29)
          else coalesce((select day from delivery_day_attempts where provider=${p.provider} and store_id=${attemptKey}
            and error_code is not null and attempts<3 and next_attempt_at<=now() and day>=yesterday-29
            and not exists(select 1 from delivery_daily_reports d where d.provider=delivery_day_attempts.provider and d.store_id=${row.store_uuid} and d.day=delivery_day_attempts.day)
            order by updated_at limit 1),
            (select d.day from delivery_daily_reports d where d.provider=${p.provider} and d.store_id=${row.store_uuid}
              and d.day>=yesterday-6 and d.updated_at<today_start
              and not exists(select 1 from delivery_day_attempts a where a.provider=d.provider and a.store_id=${attemptKey}
                and a.day=d.day and a.error_code is not null and (a.next_attempt_at>now() or a.attempts>=3))
              order by d.day desc limit 1)) end)::text as day
        from calendar,progress`,
      );
      if (!clock) throw new DeliveryError("delivery_report_scope");
      if (!row.pinned_day && !clock.day) {
        await work((tx) =>
          queueDelivery(
            tx,
            ctx.job.tenantId,
            p.provider,
            p.generation,
            "sync",
            clock!.next_run,
          ),
        );
        return;
      }
      syncDay = (row.pinned_day ?? clock.day) as string;
      syncNext = clock.next_run;
      syncYesterday = clock.yesterday;
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set report_day=${syncDay}::date where provider=${p.provider}`;
      });
    }
    const finishReport = async (bytes: Uint8Array) => {
      if (!syncDay || !clock) throw new DeliveryError("delivery_report_scope");
      const report = parseUberReport(
        bytes,
        syncDay,
        row.store_name,
        row.store_uuid,
        Boolean(row.download_session_id && row.download_scope_verified),
        Boolean(row.identity_verified),
      );
      await work(async (tx) => {
        const [current] =
          await tx`select generation,state from delivery_connections where provider=${p.provider} for update`;
        if (
          current?.generation !== p.generation ||
          current.state === "disconnecting"
        )
          return;
        if (
          report.orderCount === 0 &&
          report.adjusted === 0 &&
          report.gross === 0
        ) {
          const [previous] =
            await tx`select 1 from delivery_daily_reports where provider=${p.provider}
            and store_id=${report.storeUuid} and day=${syncDay}::date and (order_count<>0 or adjusted<>0 or gross<>0)`;
          if (previous) throw new DeliveryError("delivery_empty_report");
        }
        await tx`insert into delivery_daily_reports(tenant_id,provider,store_id,day,order_count,currency,gross,adjusted,payout,source_hash)
          values(${ctx.job.tenantId},${p.provider},${report.storeUuid},${syncDay},${report.orderCount},${report.currency},${report.gross},${report.adjusted},${report.payout},${report.hash})
          on conflict(tenant_id,provider,store_id,day) do update set order_count=excluded.order_count,gross=excluded.gross,
          adjusted=excluded.adjusted,payout=excluded.payout,source_hash=excluded.source_hash,updated_at=now()`;
        await tx`update delivery_day_attempts set error_code=null,updated_at=now() where provider=${p.provider} and store_id=${attemptKey} and day=${syncDay}::date`;
        await tx`update delivery_browser_contexts set identity_verified=true,download_scope_verified=false,report_day=null,download_session_id=null,download_started_at=null,request_started_at=null where provider=${p.provider}`;
        await tx`update delivery_connections set store_uuid=${report.storeUuid},state='connected',last_synced_at=now(),error_code=null,updated_at=now() where provider=${p.provider}`;
        await queueDelivery(
          tx,
          ctx.job.tenantId,
          p.provider,
          p.generation,
          "sync",
          new Date(Date.now() + 10000),
        );
      });
      // Cleanup must not discard a valid import. A retained session is released
      // before the next job opens a browser; the provider also bounds its lifetime.
      await releaseStored().catch(() => {});
    };
    if (
      p.action === "sync" &&
      row.request_started_at &&
      !row.download_session_id &&
      new Date(row.request_started_at).getTime() < Date.now() - 60 * 60000
    )
      throw new DeliveryError("delivery_download_timeout");
    // Poll an existing download without opening a browser or clicking it again.
    // The marker is committed before the click, covering crashes after dispatch.
    if (p.action === "sync" && row.download_session_id) {
      const bytes = await driver.download(row.download_session_id, signal);
      if (bytes) {
        await finishReport(bytes);
        return;
      }
      if (new Date(row.download_started_at).getTime() < Date.now() - 30 * 60000)
        throw new DeliveryError("delivery_download_timeout");
      return {
        status: "retry",
        code: "delivery_report_pending",
        afterMs: 15000,
      };
    }
    let remote;
    if (row.session_id) {
      try {
        remote = await driver.session(row.session_id, signal);
        if (
          new Date(remote.expiresAt) <= new Date() ||
          (remote.status && remote.status !== "RUNNING")
        )
          remote = undefined;
      } catch (e) {
        if (!(
          e instanceof DeliveryError && e.code === "delivery_session_expired"
        ))
          throw e;
      }
    }
    if (p.action === "verify" && !remote)
      throw new DeliveryError("delivery_reconnect");
    if (!remote) {
      remote = await driver.createSession(contextId, signal);
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set session_id=${remote!.id} where provider=${p.provider}`;
      });
      row.session_id = remote.id;
    }
    const attached = await driver.page(remote, signal);
    try {
      if (p.action === "connect") {
        await attached.page.goto(UBER_REPORTS, {
          waitUntil: "domcontentloaded",
        });
        await update("awaiting_login", {
          url: await driver.live(remote.id, signal),
          expires: new Date(remote.expiresAt),
        });
        await work((tx) =>
          queueDelivery(
            tx,
            ctx.job.tenantId,
            p.provider,
            p.generation,
            "expire",
            new Date(remote!.expiresAt),
          ),
        );
        return;
      }
      if (p.action === "verify") {
        const stores = await uberStores(attached.page);
        // Persist successful discovery before asynchronous release. A retry can
        // finish confirmation without forcing the owner through another login.
        await work(async (tx) => {
          await tx`update delivery_browser_contexts set verified_stores=${tx.json(stores)} where provider=${p.provider}`;
        });
        await finishVerify(stores);
        return;
      }
      const previous = await driver.download(remote.id, signal);
      if (previous) {
        await finishReport(previous);
        return;
      }
      await update("syncing");
      const exported = await uberExport(
        attached.page,
        (row.stores as DeliveryStore[]).find(
          (store) => store.id === row.store_id,
        ) ?? { id: row.store_id, name: row.store_name },
        syncDay!,
        {
          alreadyRequested: Boolean(row.request_started_at),
          forceFresh: true,
          excludedRows: row.request_started_at ? row.request_excluded_rows : [],
          beforeRequest: (excludedRows) =>
            work(async (tx) => {
              await tx`update delivery_browser_contexts set request_started_at=now(),request_excluded_rows=${tx.json(excludedRows)} where provider=${p.provider}`;
            }),
          beforeDownload: (singleStore) =>
            work(async (tx) => {
              await tx`update delivery_browser_contexts set download_session_id=${remote!.id},download_started_at=now(),download_scope_verified=${singleStore} where provider=${p.provider}`;
            }),
        },
      );
      if (exported !== "downloaded") await releaseStored();
      return {
        status: "retry",
        code: "delivery_report_pending",
        afterMs: exported === "downloaded" ? 15000 : 300000,
      };
    } finally {
      await attached.detach().catch(() => {});
    }
  } catch (e) {
    const code =
      e instanceof DeliveryError
        ? e.code
        : p.action === "sync" && e instanceof Error && e.name === "TimeoutError"
          ? "delivery_portal_changed"
          : "delivery_browser_unavailable";
    if (code === "delivery_lease_lost" || ctx.signal.aborted)
      throw new DeliveryError("delivery_lease_lost");
    if (
      p.action === "verify" &&
      code === "delivery_reconnect" &&
      row.login_expires_at > new Date()
    ) {
      await update("awaiting_login", {
        url: row.login_url,
        expires: row.login_expires_at,
      });
      return;
    }
    const dayError = [
      "delivery_empty_report",
      "delivery_report_schema",
      "delivery_report_scope",
      "delivery_report_invalid",
      "delivery_duplicate_order",
      "delivery_report_expired",
      "delivery_report_ambiguous",
      "delivery_download_timeout",
      "delivery_report_too_large",
      "delivery_portal_changed",
      "delivery_store_invalid",
      "delivery_session_expired",
    ].includes(code);
    if (p.action === "sync" && syncDay && syncNext && dayError) {
      await work(async (tx) => {
        const [current] =
          await tx`select generation,state from delivery_connections where provider=${p.provider} for update`;
        if (
          current?.generation !== p.generation ||
          current.state === "disconnecting"
        )
          return;
        await tx`insert into delivery_day_attempts(tenant_id,provider,store_id,day,error_code)
          values(${ctx.job.tenantId},${p.provider},${attemptKey},${syncDay},${code})
          on conflict(tenant_id,provider,store_id,day) do update set error_code=excluded.error_code,
            attempts=delivery_day_attempts.attempts+1,next_attempt_at=now()+interval '1 day',updated_at=now()`;
        await tx`update delivery_browser_contexts set report_day=null,download_session_id=null,download_started_at=null,request_started_at=null where provider=${p.provider}`;
        await tx`update delivery_connections set state='connected',error_code=null,updated_at=now()
          where provider=${p.provider} and generation=${p.generation}`;
        await queueDelivery(
          tx,
          ctx.job.tenantId,
          p.provider,
          p.generation,
          "sync",
          syncYesterday && syncDay! < syncYesterday
            ? new Date(Date.now() + 10000)
            : syncNext!,
        );
      });
      await releaseStored().catch(() => {});
      return;
    }
    const retry =
      ["delivery_browser_unavailable", "delivery_interrupted"].includes(code) ||
      p.action === "disconnect";
    if (p.action === "sync" && !retry) await releaseStored().catch(() => {});
    // Transient retries retain the action's state, so a retry can resume it.
    await update(retry ? row.state : "attention", { error: code });
    if (!retry) return;
    return { status: "retry", code, afterMs: 300000 };
  } finally {
    await fenced(async (tx) => {
      await tx`update delivery_browser_contexts set operation_token=null,operation_until=null
      where provider=${p.provider} and operation_token=${token}`;
    }).catch(() => {});
  }
};
