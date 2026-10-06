import { useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import type { Locale, Session } from "../../../shared/domain";
import {
  averageTicket,
  bps,
  quickRange,
  type ReportAlert,
  type TodaySummary,
} from "../../../shared/reports";
import { strings, translateError } from "../../i18n";
import { usePoll } from "../../serviceHooks";
import { Button } from "../../components/ui";
import { fetchToday } from "./api";
import { CortePrintButton } from "./CortePrintButton";
import {
  cutoffLabel,
  dateLabel,
  exceptionKindLabel,
  fill,
  money,
  pctChange,
  timeLabel,
  weekdayLabel,
} from "./format";
import { Tiles } from "./parts";
import { openReports } from "./ReportsView";
import "./reports.css";

/**
 * Hoy (spec §2.4): the current business date, refreshed every 60 s while visible (usePoll:
 * single flight, paused while hidden, never offline). Operations renders the page heading "Hoy";
 * this view renders none of that name. There is no source text and no forecast (FOH-16).
 */
export function TodayDashboard({
  session,
  locale,
  navigate,
  online = true,
}: {
  session: Session;
  locale: Locale;
  navigate: (view: string) => void;
  online?: boolean;
}) {
  const t = strings[locale];
  const m = money(session.restaurant.currency, locale);
  const zone = session.restaurant.timezone;
  const [data, setData] = useState<TodaySummary | null>(null);
  const [error, setError] = useState("");
  const poll = usePoll(
    async () => {
      try {
        setData(await fetchToday());
        setError("");
      } catch (e) {
        setError(translateError((e as Error).message, locale));
        throw e;
      }
    },
    { intervalMs: 60_000, enabled: online },
    [locale],
  );
  if (!online && !data)
    return (
      <p className="report-offline" role="status">
        {t.reportsOffline}
      </p>
    );
  if (!data)
    return error ? (
      <p className="error" role="alert">
        {error}
      </p>
    ) : (
      <p className="muted">{t.reportsLoading}</p>
    );
  const s = data.summary;
  const cash = s.collections.byMethod.find((x) => x.method === "cash");
  const terminal = s.collections.byMethod.find((x) => x.method === "external");
  const change =
    data.lastWeek && data.lastWeek.salesTotalUntilNow > 0
      ? fill(t.reportsTodayVsLastWeek, {
          pct: pctChange(
            bps(
              s.sales.salesTotal - data.lastWeek.salesTotalUntilNow,
              data.lastWeek.salesTotalUntilNow,
            ),
            locale,
          ),
          weekday: weekdayLabel(data.lastWeek.date, locale),
        })
      : undefined;
  const updated = poll.lastSuccess
    ? fill(t.reportsUpdatedAt, {
        time: timeLabel(new Date(poll.lastSuccess).toISOString(), zone),
      })
    : "";
  return (
    <div className="today-view">
      <p className="today-meta">
        {fill(t.reportsTodayBusinessDay, {
          date: dateLabel(data.businessDate, locale),
          time: cutoffLabel(data.cutoff),
        })}
        {" · "}
        {poll.failing || !online
          ? fill(t.reportsStaleSince, {
              time: timeLabel(data.generatedAt, zone),
            })
          : updated}
      </p>
      {!online && (
        <p className="report-offline" role="status">
          {t.reportsOffline}
        </p>
      )}
      {error && online && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Tiles
        items={[
          {
            label: t.reportsSalesTotal,
            value: m(s.sales.salesTotal),
            note: change,
          },
          { label: t.reportsOrders, value: String(s.sales.orders) },
          {
            label: t.reportsAverageTicket,
            value: m(averageTicket(s.sales.salesTotal, s.sales.orders)),
          },
          { label: t.reportsTodayCash, value: m(cash?.amount ?? 0) },
          { label: t.reportsTodayTerminal, value: m(terminal?.amount ?? 0) },
          { label: t.reportsTips, value: m(s.collections.tips) },
        ]}
      />
      {data.alerts.length > 0 && (
        <ul className="today-alerts">
          {data.alerts.map((alert, i) => (
            <AlertLine
              key={alert.code + i}
              alert={alert}
              locale={locale}
              requestId={s.requestId}
              onOpenCortes={() => {
                openReports("cortes", quickRange("today", data.businessDate));
                navigate("finance");
              }}
            />
          ))}
        </ul>
      )}
      <div className="report-cards">
        <section className="panel report-card" aria-labelledby="today-checks">
          <h2 id="today-checks">{t.reportsTodayOpenChecks}</h2>
          <p>
            {fill(t.reportsTodayOpenChecksLine, {
              n: s.sales.openChecks,
              amount: m(s.sales.outstanding),
            })}
          </p>
          <Button onClick={() => navigate("orders")}>
            {t.reportsTodayViewOrders}
          </Button>
        </section>
        <section className="panel report-card" aria-labelledby="today-drawers">
          <h2 id="today-drawers">{t.reportsTodayOpenDrawers}</h2>
          {data.openDrawers.length === 0 && (
            <p className="muted">{t.reportsTodayNoOpenDrawers}</p>
          )}
          {data.openDrawers.map((d) => (
            <div className="today-drawer" key={d.id}>
              <p>
                {fill(t.reportsTodayDrawerLine, {
                  device: d.deviceName,
                  name: d.openedByName,
                  time: timeLabel(d.openedAt, zone),
                })}
              </p>
              <p className="muted">
                {fill(t.reportsTodayPayments, { n: d.payments })}
                {d.expected !== null &&
                  " · " +
                    fill(t.reportsTodayExpected, { amount: m(d.expected) })}
              </p>
              {d.expected !== null && (
                <CortePrintButton
                  session={session}
                  locale={locale}
                  drawerId={d.id}
                  label={t.reportsCorteX}
                  online={online}
                />
              )}
            </div>
          ))}
        </section>
        <section className="panel report-card" aria-labelledby="today-top">
          <h2 id="today-top">{t.reportsTodayTopProducts}</h2>
          {data.topProducts.length === 0 ? (
            <p className="muted">{t.reportsEmpty}</p>
          ) : (
            <ol className="today-top">
              {data.topProducts.map((p) => (
                <li key={p.productId}>
                  <span>{p.name[locale]}</span>
                  <span className="num">
                    {p.units} · {m(p.salesTotal)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section
          className="panel report-card"
          aria-labelledby="today-exceptions"
        >
          <h2 id="today-exceptions">{t.reportsTodayExceptions}</h2>
          {data.exceptions.length === 0 ? (
            <p className="muted">{t.reportsExNone}</p>
          ) : (
            <ul className="today-exceptions">
              {data.exceptions.map((e) => (
                <li key={e.kind}>
                  <span>{exceptionKindLabel(e.kind, locale)}</span>
                  <span className="num">
                    {e.count} · {m(e.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Button
            onClick={() => {
              openReports("exceptions", quickRange("today", data.businessDate));
              navigate("finance");
            }}
          >
            {t.reportsTodaySeeAll}
          </Button>
        </section>
      </div>
    </div>
  );
}

/** One alert line: a text badge with an icon (never color alone) and its message. */
function AlertLine({
  alert,
  locale,
  requestId,
  onOpenCortes,
}: {
  alert: ReportAlert;
  locale: Locale;
  requestId: string;
  onOpenCortes: () => void;
}) {
  const t = strings[locale];
  const date = alert.since ? dateLabel(alert.since, locale) : "";
  const text =
    alert.code === "checks_mismatch"
      ? `${t.reportsAlertChecksMismatch} ${requestId}`
      : alert.code === "drawer_revoked_device"
        ? fill(t.reportsAlertDrawerRevoked, { device: alert.deviceName ?? "" })
        : alert.code === "drawer_open_long"
          ? fill(t.reportsAlertDrawerOpenLong, {
              device: alert.deviceName ?? "",
              date,
            })
          : alert.code === "missing_tickets"
            ? fill(t.reportsAlertMissingTickets, { n: alert.count })
            : alert.code === "drawer_unreviewed"
              ? fill(t.reportsAlertUnreviewed, { n: alert.count })
              : alert.code === "offline_review_pending"
                ? fill(t.reportsAlertOfflineReview, { n: alert.count })
                : null;
  // cfdi (030) maps its own alerts; an alert this build cannot word is not shown as a raw code.
  if (text === null) return null;
  const urgent = alert.code === "checks_mismatch";
  return (
    <li
      className={"today-alert" + (urgent ? " urgent" : "")}
      role={urgent ? "alert" : "status"}
    >
      {urgent ? (
        <AlertTriangle size={18} aria-hidden="true" />
      ) : (
        <Info size={18} aria-hidden="true" />
      )}
      <span>{text}</span>
      {(alert.code === "drawer_revoked_device" ||
        alert.code === "drawer_open_long" ||
        alert.code === "drawer_unreviewed") && (
        <Button variant="ghost" onClick={onOpenCortes}>
          {t.reportsTabCortes}
        </Button>
      )}
    </li>
  );
}
