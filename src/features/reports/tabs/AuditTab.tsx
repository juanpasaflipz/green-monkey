import { useState } from "react";
import type { Locale, Session } from "../../../../shared/domain";
import {
  AUDIT_GROUP_KEYS,
  type AuditGroup,
  type AuditRow,
  type DateRange,
} from "../../../../shared/reports";
import { strings, translateError } from "../../../i18n";
import { operationLabel } from "../../../labels";
import { Button, Field } from "../../../components/ui";
import { fetchAllPages, fetchAudit, fetchFilters } from "../api";
import { auditColumns, exportCsv } from "../csv";
import { auditReference } from "../exception-text";
import { auditGroupLabel, dateTimeLabel, fill, money } from "../format";
import { ReportStatus, ReportToolbar } from "../parts";
import { usePagedReport, useReport } from "../useReport";

/** A detail value: nested objects JSON-stringified. */
const detailValue = (v: unknown) =>
  v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);

/** Finanzas → Bitácora: the activity log with keyset paging and filters (spec §2.8). */
export function AuditTab({
  session,
  locale,
  range,
  online,
}: {
  session: Session;
  locale: Locale;
  range: DateRange;
  online: boolean;
}) {
  const t = strings[locale];
  const m = money(session.restaurant.currency, locale);
  const zone = session.restaurant.timezone;
  const [employee, setEmployee] = useState("");
  const [group, setGroup] = useState<"" | AuditGroup>("");
  const [orderText, setOrderText] = useState("");
  const [order, setOrder] = useState("");
  const [csvBusy, setCsvBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const filters = {
    ...range,
    employee: employee || undefined,
    group: group || undefined,
    order: order || undefined,
  };
  const people = useReport(() => fetchFilters(), [], { online, locale });
  // A filter or range change shows only the new list (REPORTS-UI-7).
  const list = usePagedReport<Awaited<ReturnType<typeof fetchAudit>>, AuditRow>(
    (cursor) => fetchAudit({ ...filters, cursor }),
    [range.from, range.to, employee, group, order],
    { online, locale },
  );
  const { rows, next, more } = list;
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
      const result = await fetchAllPages((cursor, limit) =>
        fetchAudit({ ...filters, cursor, limit }),
      );
      exportCsv(
        "reportsCsvAudit",
        range,
        auditColumns(locale, auditReference),
        result.rows,
        {
          locale,
          currency: session.restaurant.currency,
          timezone: zone,
        },
      );
      if (result.truncated) setNotice(t.reportsCsvTruncated);
    } catch (e) {
      setNotice(translateError((e as Error).message, locale));
    } finally {
      setCsvBusy(false);
    }
  }
  return (
    <div className="report-tab" aria-busy={list.loading}>
      <ReportToolbar
        locale={locale}
        online={online}
        busy={list.loading}
        csvBusy={csvBusy}
        onRefresh={list.reload}
        onCsv={() => void csv()}
      >
        <Field label={t.reportsEmployeeFilter}>
          <select
            value={employee}
            onChange={(e) => setEmployee(e.target.value)}
          >
            <option value="">{t.reportsAllEmployees}</option>
            {(people.data?.employees ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t.reportsActivityFilter}>
          <select
            value={group}
            onChange={(e) => setGroup(e.target.value as "" | AuditGroup)}
          >
            <option value="">{t.reportsAuditGroupAll}</option>
            {AUDIT_GROUP_KEYS.map((g) => (
              <option key={g} value={g}>
                {auditGroupLabel(g, locale)}
              </option>
            ))}
          </select>
        </Field>
        <form
          className="report-order-filter"
          onSubmit={(e) => {
            e.preventDefault();
            setOrder(
              /^\d{1,6}$/.test(orderText.trim()) ? orderText.trim() : "",
            );
          }}
        >
          <Field label={t.reportsAuditOrderNumber}>
            <input
              inputMode="numeric"
              value={orderText}
              onChange={(e) => setOrderText(e.target.value)}
              onBlur={() =>
                setOrder(
                  /^\d{1,6}$/.test(orderText.trim()) ? orderText.trim() : "",
                )
              }
            />
          </Field>
        </form>
      </ReportToolbar>
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      <ReportStatus state={list} online={online} locale={locale} />
      <div className="report-table-wrap">
        <table className="report-table">
          <caption className="sr-only">{t.reportsTabAudit}</caption>
          <thead>
            <tr>
              <th scope="col">{t.reportsColWhen}</th>
              <th scope="col">{t.reportsColActivity}</th>
              <th scope="col">{t.reportsColEmployee}</th>
              <th scope="col">{t.reportsColReference}</th>
              <th scope="col">{t.reportsColDetail}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && list.data && (
              <tr>
                <td colSpan={5} className="muted">
                  {t.reportsAuditEmpty}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{dateTimeLabel(r.at, zone, locale)}</td>
                <td>{operationLabel(r.operation, locale)}</td>
                <td>{r.actorName ?? ""}</td>
                <td>{auditReference(r)}</td>
                <td className="wrap">
                  {[
                    r.summary.amount !== null
                      ? fill(t.reportsAuditAmount, {
                          amount: m(r.summary.amount),
                        })
                      : "",
                    r.summary.reason ?? "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {r.detail !== null &&
                    typeof r.detail === "object" &&
                    Object.keys(r.detail as object).length > 0 && (
                      <details>
                        <summary>{t.reportsAuditShowDetail}</summary>
                        <dl className="report-detail">
                          {Object.entries(
                            r.detail as Record<string, unknown>,
                          ).map(([key, value]) => (
                            <div key={key}>
                              <dt>{key}</dt>
                              <dd>{detailValue(value)}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next && (
        <Button
          onClick={() => void loadMore()}
          disabled={more || list.loading || !online}
        >
          {t.reportsLoadMore}
        </Button>
      )}
    </div>
  );
}
