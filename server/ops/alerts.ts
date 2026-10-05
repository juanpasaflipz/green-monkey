import type { AlertKind } from "../config-rules.js";
import { log } from "../log.js";

export type Severity = "critical" | "warning" | "info";
export interface Alert {
  key: string;
  severity: Severity;
  title: string;
  /** Codes and counts only; never personal or tenant data. */
  body: string;
}
export interface AlertTarget {
  url: string;
  kind: AlertKind;
}

const DEDUPE_MS: Record<Severity, number> = {
  critical: 15 * 60_000,
  warning: 30 * 60_000,
  info: 30 * 60_000,
};
const ntfy: Record<Severity, { priority: string; tags: string }> = {
  critical: { priority: "urgent", tags: "rotating_light" },
  warning: { priority: "high", tags: "warning" },
  info: { priority: "default", tags: "white_check_mark" },
};

/** Builds the HTTP request for one alert channel (pure; tested). */
export function alertRequest(
  target: AlertTarget,
  appEnv: string,
  alert: Alert,
  at: Date,
): { url: string; init: RequestInit } {
  const title = `Green Monkey ${appEnv}: ${alert.title}`;
  if (target.kind === "ntfy")
    return {
      url: target.url,
      init: {
        method: "POST",
        headers: {
          Title: title.replace(/[^\x20-\x7e]/g, "?"),
          Priority: ntfy[alert.severity].priority,
          Tags: ntfy[alert.severity].tags,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: alert.body,
      },
    };
  const json = (payload: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (target.kind === "slack")
    return { url: target.url, init: json({ text: `*${title}*\n${alert.body}` }) };
  if (target.kind === "discord")
    return {
      url: target.url,
      init: json({ content: `**${title}**\n${alert.body}` }),
    };
  return {
    url: target.url,
    init: json({
      env: appEnv,
      key: alert.key,
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      at: at.toISOString(),
    }),
  };
}

export interface Alerter {
  send(alert: Alert): Promise<void>;
}

/**
 * Sends alerts to one webhook with in-memory dedupe: the same key is
 * suppressed for 30 minutes (15 for critical). Failures are logged and never
 * thrown, so an alerting outage cannot stop the worker.
 */
export function createAlerter(
  target: AlertTarget | null,
  o: {
    appEnv: string;
    fetch?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
  },
): Alerter {
  const sent = new Map<string, number>();
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  return {
    async send(alert) {
      const last = sent.get(alert.key);
      if (last !== undefined && now() - last < DEDUPE_MS[alert.severity]) {
        log.debug("alert_suppressed", { key: alert.key });
        return;
      }
      sent.set(alert.key, now());
      log.warn("alert", {
        key: alert.key,
        severity: alert.severity,
        title: alert.title,
        delivered: Boolean(target),
      });
      if (!target) return;
      const request = alertRequest(target, o.appEnv, alert, new Date(now()));
      try {
        const response = await doFetch(request.url, {
          ...request.init,
          signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
        });
        if (!response.ok)
          log.warn("alert_delivery_failed", {
            key: alert.key,
            status: response.status,
          });
      } catch (error) {
        log.warn("alert_delivery_failed", { key: alert.key }, error);
      }
    },
  };
}

let current: Alerter = createAlerter(null, { appEnv: "development" });

/** Called once by the worker with its configured webhook. */
export function configureAlerts(target: AlertTarget | null, appEnv: string) {
  current = createAlerter(target, { appEnv });
}

export async function sendAlert(alert: Alert): Promise<void> {
  await current.send(alert);
}
