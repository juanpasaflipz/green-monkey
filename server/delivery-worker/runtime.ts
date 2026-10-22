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
  action: z.enum(["connect", "verify", "sync", "disconnect", "expire"]),
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

export const deliveryDead: JobDeadHook = async ({ tx, job }) => {
  const p = payload.safeParse(job.payload);
  if (!p.success) return;
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
  if (!driver) return { status: "blocked", code: "delivery_unavailable" };
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
      if (row.session_id) await driver.release(row.session_id, signal);
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set session_id=null where provider=${p.provider}`;
      });
      await update("attention", { error: "delivery_reconnect" });
      return;
    }
    if (p.action === "disconnect") {
      if (row.session_id) await driver.release(row.session_id, signal);
      if (row.context_id) await driver.deleteContext(row.context_id, signal);
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set context_id=null,session_id=null,report_day=null where provider=${p.provider}`;
        await tx`update delivery_connections set state='disconnected',stores='[]',store_id=null,store_name=null,
          login_url=null,login_expires_at=null,error_code=null,updated_at=now() where provider=${p.provider} and generation=${p.generation}`;
      });
      return;
    }
    if (!(await work(async (tx) => (await entitlement(tx)).plan === "pro"))) {
      if (row.session_id) await driver.release(row.session_id, signal);
      await update("attention", { error: "pro_required" });
      return;
    }
    // A reconnect must start with a clean browser: never expose the previous owner's session.
    let contextId = row.context_id as string | null;
    if (p.action === "connect" && row.state === "preparing" && contextId) {
      if (row.session_id) await driver.release(row.session_id, signal);
      await driver.deleteContext(contextId, signal);
      contextId = null;
      row.session_id = null;
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set context_id=null,session_id=null,report_day=null where provider=${p.provider}`;
      });
    }
    if (!contextId) {
      contextId = await driver.createContext(signal);
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set context_id=${contextId} where provider=${p.provider}`;
      });
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
        await driver.release(remote.id, signal);
        await work(async (tx) => {
          await tx`update delivery_browser_contexts set session_id=null,report_day=null where provider=${p.provider}`;
          await tx`update delivery_connections set state='choose_store',stores=${tx.json(stores)},login_url=null,
            login_expires_at=null,error_code=null,updated_at=now() where provider=${p.provider} and generation=${p.generation}`;
        });
        return;
      }
      // Pin a report date across retries and midnight. Catch up one missing day per
      // job after outages. Platform calendar dates remain separate from POS dates.
      const [clock] = await work(
        (
          tx,
        ) => tx`select ((now() at time zone timezone)::date-1)::text as yesterday,
        least(coalesce((select max(day)+1 from delivery_daily_reports where provider=${p.provider} and store_id=${row.store_id}),
          (now() at time zone timezone)::date-1),(now() at time zone timezone)::date-1)::text as day,
        (((now() at time zone timezone)::date+1)+(cutoff+30)*interval '1 minute') at time zone timezone as next_run
        from restaurants where id=${ctx.job.tenantId}`,
      );
      if (!clock) throw new DeliveryError("delivery_report_scope");
      const day = (row.pinned_day ?? clock.day) as string;
      await work(async (tx) => {
        await tx`update delivery_browser_contexts set report_day=${day}::date where provider=${p.provider}`;
      });
      const previous = await driver.download(remote.id, signal);
      if (!previous) {
        await update("syncing");
        await uberExport(
          attached.page,
          { id: row.store_id, name: row.store_name },
          day,
        );
        return {
          status: "retry",
          code: "delivery_report_pending",
          afterMs: 300000,
        };
      }
      const report = parseUberReport(previous, day, row.store_name);
      await driver.release(remote.id, signal);
      await work(async (tx) => {
        const [current] =
          await tx`select generation,state from delivery_connections where provider=${p.provider} for update`;
        if (
          current?.generation !== p.generation ||
          current.state === "disconnecting"
        )
          return;
        await tx`insert into delivery_daily_reports(tenant_id,provider,store_id,day,order_count,currency,gross,adjusted,payout,source_hash)
          values(${ctx.job.tenantId},${p.provider},${row.store_id},${day},${report.orderCount},${report.currency},${report.gross},${report.adjusted},${report.payout},${report.hash})
          on conflict(tenant_id,provider,store_id,day) do update set order_count=excluded.order_count,gross=excluded.gross,
          adjusted=excluded.adjusted,payout=excluded.payout,source_hash=excluded.source_hash,updated_at=now()`;
        await tx`update delivery_browser_contexts set session_id=null,report_day=null where provider=${p.provider}`;
        await tx`update delivery_connections set state='connected',last_synced_at=now(),error_code=null,updated_at=now() where provider=${p.provider}`;
        await queueDelivery(
          tx,
          ctx.job.tenantId,
          p.provider,
          p.generation,
          "sync",
          day < clock.yesterday ? new Date(Date.now() + 10000) : clock.next_run,
        );
      });
    } finally {
      await attached.detach().catch(() => {});
    }
  } catch (e) {
    const code =
      e instanceof DeliveryError ? e.code : "delivery_browser_unavailable";
    if (code === "delivery_lease_lost" || ctx.signal.aborted)
      throw new DeliveryError("delivery_lease_lost");
    const retry =
      ["delivery_browser_unavailable", "delivery_interrupted"].includes(code) ||
      p.action === "disconnect";
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
