import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../../shared/domain";
import type {
  DateRange,
  DrawerRow,
  MethodTotals,
  TenderReportRow,
} from "../../../../shared/reports";
import { strings, translateError } from "../../../i18n";
import { tenderMethodLabel } from "../../../labels";
import { Badge, Button, Field } from "../../../components/ui";
import { OrderDetail } from "../../OrderDetail";
import {
  fetchAllPages,
  fetchBreakdown,
  fetchDrawers,
  fetchTenders,
} from "../api";
import { exportCsv, methodColumns, tenderColumns } from "../csv";
import { DataTable } from "../DataTable";
import { dateLabel, dateTimeLabel, money } from "../format";
import { ReportStatus, ReportToolbar } from "../parts";
import { usePagedReport, useReport } from "../useReport";

/** Finanzas → Pagos: collections by method and the recorded payments, paged (spec §2.5). */
export function PaymentsTab({
  session,
  locale,
  range,
  online,
  navigate,
}: {
  session: Session;
  locale: Locale;
  range: DateRange;
  online: boolean;
  navigate: (view: string) => void;
}) {
  const t = strings[locale];
  const m = money(session.restaurant.currency, locale);
  const zone = session.restaurant.timezone;
  const [method, setMethod] = useState<"" | "cash" | "external">("");
  const [drawer, setDrawer] = useState("");
  // REPORTS-UI-8: the Caja filter belongs to the range it was chosen in. A range change (or a
  // drawer the new range does not list) clears it, so the select and the request agree.
  const rangeKey = range.from + ":" + range.to;
  const [drawerRange, setDrawerRange] = useState(rangeKey);
  if (drawerRange !== rangeKey) {
    setDrawerRange(rangeKey);
    if (drawer) setDrawer("");
  }
  const [csvBusy, setCsvBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<string | null>(null);
  const filters = {
    ...range,
    method: method || undefined,
    drawer: drawer || undefined,
  };
  const methods = useReport(
    () => fetchBreakdown(range, "method"),
    [range.from, range.to],
    { online, locale },
  );
  const drawers = useReport<DrawerRow[]>(
    () => fetchDrawers(range),
    [range.from, range.to],
    { online, locale },
  );
  // A filter or range change shows only the new list (REPORTS-UI-7).
  const list = usePagedReport<
    Awaited<ReturnType<typeof fetchTenders>>,
    TenderReportRow
  >(
    (cursor) => fetchTenders({ ...filters, cursor }),
    [range.from, range.to, method, drawer],
    { online, locale },
  );
  const { rows, next, more } = list;
  useEffect(() => {
    if (drawer && drawers.data && !drawers.data.some((d) => d.id === drawer))
      setDrawer("");
  }, [drawers.data, drawer]);
  const ctx = { locale, currency: session.restaurant.currency, timezone: zone };
  async function loadMore() {
    try {
      await list.loadMore();
    } catch (e) {
      setNotice(translateError((e as Error).message, locale));
    }
  }
  async function csv() {
    setCsvBusy(true);
    setNotice("");
    try {
      const all = await fetchAllPages((cursor, limit) =>
        fetchTenders({ ...filters, cursor, limit }),
      );
      exportCsv(
        "reportsCsvTenders",
        range,
        tenderColumns(locale),
        all.rows,
        ctx,
      );
      if (all.truncated) setNotice(t.reportsCsvTruncated);
    } catch (e) {
      setNotice(translateError((e as Error).message, locale));
    } finally {
      setCsvBusy(false);
    }
  }
  return (
    <div className="report-tab" aria-busy={list.loading}>
      <section className="panel" aria-labelledby="report-pay-methods">
        <div className="row between wrap">
          <h2 id="report-pay-methods">{t.reportsCollectionsTitle}</h2>
          {methods.data && (
            <Button
              onClick={() =>
                exportCsv(
                  "reportsCsvMethods",
                  range,
                  methodColumns(locale),
                  methods.data!.rows,
                  ctx,
                )
              }
            >
              {t.reportsDownloadCsv}
            </Button>
          )}
        </div>
        <ReportStatus state={methods} online={online} locale={locale} />
        {methods.data && (
          <DataTable<MethodTotals>
            caption={t.reportsCollectionsTitle}
            locale={locale}
            rows={methods.data.rows}
            rowKey={(r) => r.method}
            columns={[
              {
                key: "method",
                header: t.reportsColMethod,
                render: (r) => tenderMethodLabel(r.method, undefined, locale),
              },
              {
                key: "count",
                header: t.reportsColCount,
                numeric: true,
                render: (r) => r.count,
              },
              {
                key: "amount",
                header: t.reportsColAmount,
                numeric: true,
                render: (r) => m(r.amount),
              },
              {
                key: "tips",
                header: t.reportsColTips,
                numeric: true,
                render: (r) => m(r.tips),
              },
              {
                key: "refunds",
                header: t.reportsColRefunds,
                numeric: true,
                render: (r) => m(r.refunds),
              },
              {
                key: "net",
                header: t.reportsColNet,
                numeric: true,
                render: (r) => m(r.net),
              },
            ]}
            totals={[
              t.reportsTotal,
              String(methods.data.rows.reduce((a, r) => a + r.count, 0)),
              m(methods.data.total),
              m(methods.data.rows.reduce((a, r) => a + r.tips, 0)),
              m(methods.data.rows.reduce((a, r) => a + r.refunds, 0)),
              m(methods.data.rows.reduce((a, r) => a + r.net, 0)),
            ]}
          />
        )}
        <p className="muted tiny">{t.reportsCollectionsHint}</p>
      </section>
      <section className="panel" aria-labelledby="report-tenders">
        <h2 id="report-tenders">{t.reportsTendersTitle}</h2>
        <ReportToolbar
          locale={locale}
          online={online}
          busy={list.loading}
          csvBusy={csvBusy}
          onRefresh={list.reload}
          onCsv={() => void csv()}
        >
          <Field label={t.reportsMethodFilter}>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
            >
              <option value="">{t.reportsAllMethods}</option>
              <option value="cash">
                {tenderMethodLabel("cash", undefined, locale)}
              </option>
              <option value="external">
                {tenderMethodLabel("external", undefined, locale)}
              </option>
            </select>
          </Field>
          <Field label={t.reportsDrawerFilter}>
            <select value={drawer} onChange={(e) => setDrawer(e.target.value)}>
              <option value="">{t.reportsAllDrawers}</option>
              {(drawers.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.deviceName} · {dateLabel(d.businessDate, locale)}
                </option>
              ))}
            </select>
          </Field>
        </ReportToolbar>
        {notice && (
          <p role="status" className="muted">
            {notice}
          </p>
        )}
        <ReportStatus state={list} online={online} locale={locale} />
        <DataTable<TenderReportRow>
          caption={t.reportsTendersTitle}
          locale={locale}
          rows={rows}
          rowKey={(r) => r.id}
          empty={list.data ? t.reportsNoPayments : undefined}
          columns={[
            {
              key: "at",
              header: t.reportsColWhen,
              render: (r) => dateTimeLabel(r.at, zone, locale),
            },
            {
              key: "day",
              header: t.reportsColCollectionDate,
              render: (r) => dateLabel(r.collectionDate, locale),
            },
            {
              key: "order",
              header: t.reportsColOrder,
              render: (r) => (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setDetail(r.orderId)}
                >
                  #{r.orderNumber}
                  {r.orderDate !== r.collectionDate
                    ? ` · ${dateLabel(r.orderDate, locale)}`
                    : ""}
                </button>
              ),
            },
            {
              key: "method",
              header: t.reportsColMethod,
              render: (r) => (
                <>
                  {tenderMethodLabel(r.method, r.source, locale)}{" "}
                  {r.offline && <Badge>{t.reportsOfflineBadge}</Badge>}
                </>
              ),
            },
            {
              key: "amount",
              header: t.reportsColAmount,
              numeric: true,
              render: (r) => m(r.amount),
            },
            {
              key: "tip",
              header: t.reportsColTip,
              numeric: true,
              render: (r) => m(r.tip),
            },
            {
              key: "reference",
              header: t.reportsColReference,
              render: (r) => r.reference ?? "",
            },
            {
              key: "drawer",
              header: t.reportsColDrawer,
              render: (r) => r.deviceName ?? "",
            },
            {
              key: "refunded",
              header: t.reportsColRefunded,
              numeric: true,
              render: (r) => m(r.refunded),
            },
          ]}
        />
        {next && (
          <Button
            onClick={() => void loadMore()}
            disabled={more || list.loading || !online}
          >
            {t.reportsLoadMore}
          </Button>
        )}
      </section>
      {detail && (
        <OrderDetail
          orderId={detail}
          session={session}
          locale={locale}
          money={m}
          navigate={navigate}
          close={() => setDetail(null)}
          changed={list.reload}
        />
      )}
    </div>
  );
}
