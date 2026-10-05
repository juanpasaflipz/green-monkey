import type postgres from "postgres";
import { log as rootLog } from "../logging.js";
import type { Alert } from "./alerts.js";

export interface WatchdogOptions {
  /** APP_URL of the web service; web_down probing is skipped without it. */
  appUrl: string | null;
  /** Billing capability pool (BILLING_DATABASE_URL); billing checks are skipped without it. */
  billingSql: postgres.Sql | null;
  alert: (a: Alert) => Promise<void>;
  fetch?: typeof fetch;
  probeTimeoutMs?: number;
  /** Consecutive failed probes (one per check, every 60 s) before web_down. */
  downAfter?: number;
}

export interface Watchdog {
  check(): Promise<void>;
  state(): { webFailures: number; webDown: boolean };
}

/**
 * Worker-side probes that turn into alerts (OPS-4). Each check is isolated:
 * one failing check never hides the others. Alert bodies carry codes and
 * counts only. Dead jobs alert from the web's jobs runner, which is the only
 * process that can see them (per-tenant RLS).
 */
export function createWatchdog(o: WatchdogOptions): Watchdog {
  const log = rootLog.child({ loop: "watchdog" });
  const doFetch = o.fetch ?? fetch;
  const downAfter = o.downAfter ?? 3;
  let webFailures = 0;
  let webDown = false;
  let reviewCount: number | null = null;

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

  async function billing() {
    if (!o.billingSql) return;
    const [r] = await o.billingSql`
      select
        (select count(*)::int from billing_operations where state='review') as review,
        (select count(*)::int from billing_operations where state='pending' and attempts >= 10) as retrying`;
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
  }

  return {
    async check() {
      for (const [name, fn] of [
        ["web", probeWeb],
        ["billing", billing],
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
