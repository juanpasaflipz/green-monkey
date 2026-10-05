import type postgres from "postgres";
import { log as rootLog } from "../log.js";
import type { Alert } from "./alerts.js";

export interface WatchdogOptions {
  /** APP_URL of the web service; web_down probing is skipped without it. */
  appUrl: string | null;
  billingEnabled: boolean;
  alert: (a: Alert) => Promise<void>;
  /** Last retention outcome, supplied by the worker. */
  retention: () => { failedAt: number | null; okAt: number | null };
  fetch?: typeof fetch;
  probeTimeoutMs?: number;
  /** Consecutive failed probes (one per check) before web_down. */
  downAfter?: number;
}

export interface Watchdog {
  check(): Promise<void>;
  state(): { webFailures: number; webDown: boolean };
}

/**
 * Probes and database checks that turn into alerts (OPS-4). Each check is
 * isolated: one failing check never hides the others. Alert bodies carry
 * codes and counts only.
 */
export function createWatchdog(
  sql: postgres.Sql,
  o: WatchdogOptions,
): Watchdog {
  const log = rootLog.child({ loop: "watchdog" });
  const doFetch = o.fetch ?? fetch;
  const downAfter = o.downAfter ?? 3;
  let webFailures = 0;
  let webDown = false;
  let deadSince: Date | null = null;
  let reviewCount: number | null = null;
  let lastRetentionFailureAlerted: number | null = null;

  async function probeWeb() {
    if (!o.appUrl) return;
    let ok: boolean;
    try {
      const response = await doFetch(`${o.appUrl}/api/health`, {
        signal: AbortSignal.timeout(o.probeTimeoutMs ?? 5000),
      });
      ok = response.ok;
    } catch {
      ok = false;
    }
    if (ok) {
      if (webDown)
        await o.alert({
          key: "web_recovered",
          severity: "info",
          title: "web recovered",
          body: `web_recovered after ${webFailures} failed checks`,
        });
      webFailures = 0;
      webDown = false;
      return;
    }
    webFailures++;
    if (webFailures >= downAfter) {
      webDown = true;
      await o.alert({
        key: "web_down",
        severity: "critical",
        title: "web down",
        body: `web_down: /api/health failed ${webFailures} consecutive checks`,
      });
    }
  }

  async function deadJobs() {
    const [clock] = await sql`select now() as now`;
    // Only the worker marks jobs dead, so after a restart look back a few
    // minutes (the previous instance's last checks) instead of re-alerting
    // all history on every deploy.
    const since =
      deadSince ?? new Date(new Date(clock.now).getTime() - 5 * 60_000);
    const rows = await sql<{ kind: string; count: number }[]>`
      select kind, count(*)::int as count from jobs
      where state='dead' and updated_at > ${since}
      group by kind order by kind`;
    deadSince = clock.now;
    if (!rows.length) return;
    await o.alert({
      key: "jobs_dead",
      severity: "warning",
      title: "dead jobs",
      body:
        "jobs_dead " + rows.map((r) => `${r.kind}=${r.count}`).join(" "),
    });
  }

  async function billing() {
    if (!o.billingEnabled) return;
    const [r] = await sql`
      select
        (select count(*)::int from billing_operations where state='review') as review,
        (select count(*)::int from billing_operations where state='pending' and attempts >= 10) as retrying,
        (select count(*)::int from billing_requests where state='queued' and created_at < now() - interval '10 minutes') as stuck`;
    if (r.review > 0 && (reviewCount === null || r.review > reviewCount))
      await o.alert({
        key: "billing_review",
        severity: "warning",
        title: "billing operations need review",
        body: `billing_review count=${r.review}`,
      });
    reviewCount = r.review;
    if (r.retrying > 0)
      await o.alert({
        key: "billing_retrying",
        severity: "warning",
        title: "billing operations retrying",
        body: `billing_retrying count=${r.retrying}`,
      });
    if (r.stuck > 0)
      await o.alert({
        key: "billing_inbox_stuck",
        severity: "warning",
        title: "billing requests stuck",
        body: `billing_inbox_stuck count=${r.stuck}`,
      });
  }

  async function retention() {
    const { failedAt, okAt } = o.retention();
    if (failedAt === null || (okAt !== null && okAt > failedAt)) return;
    if (lastRetentionFailureAlerted === failedAt) return;
    lastRetentionFailureAlerted = failedAt;
    await o.alert({
      key: "retention_failed",
      severity: "warning",
      title: "retention failed",
      body: "retention_failed: see worker logs (retention_table_failed)",
    });
  }

  return {
    async check() {
      for (const [name, fn] of [
        ["web", probeWeb],
        ["jobs_dead", deadJobs],
        ["billing", billing],
        ["retention", retention],
      ] as const) {
        try {
          await fn();
        } catch (error) {
          log.warn("watchdog_check_failed", { check: name }, error);
        }
      }
    },
    state: () => ({ webFailures, webDown }),
  };
}
