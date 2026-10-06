import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../../shared/domain";
import {
  EXCEPTION_KINDS,
  type DateRange,
  type ExceptionKind,
  type ExceptionRow,
  type ExceptionSummary,
} from "../../../../shared/reports";
import { strings, translateError } from "../../../i18n";
import { Button, Field } from "../../../components/ui";
import { OrderDetail } from "../../OrderDetail";
import { fetchAllPages, fetchExceptions, fetchFilters } from "../api";
import { exceptionColumns, exportCsv } from "../csv";
import { DataTable, type Column } from "../DataTable";
import { exceptionDetail, exceptionReason } from "../exception-text";
import { dateTimeLabel, exceptionKindLabel, fill, money } from "../format";
import { ReportStatus, ReportToolbar, Tiles } from "../parts";
import { printSheet } from "../ReportSheet";
import { useReport } from "../useReport";

/** Finanzas → Excepciones: the loss-prevention list (GAP-3, spec §2.7). */
export function ExceptionsTab({
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
  const [kinds, setKinds] = useState<ExceptionKind[]>([]);
  const [employee, setEmployee] = useState("");
  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [summary, setSummary] = useState<ExceptionSummary | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<string | null>(null);
  const filters = {
    ...range,
    kinds: kinds.length ? kinds.join(",") : undefined,
    employee: employee || undefined,
  };
  const people = useReport(() => fetchFilters(), [], { online, locale });
  const list = useReport(
    () => fetchExceptions(filters),
    [range.from, range.to, kinds.join(","), employee],
    { online, locale },
  );
  useEffect(() => {
    if (list.data) {
      setRows(list.data.rows);
      setNext(list.data.next);
      setSummary(list.data.summary);
    }
  }, [list.data]);
  const ctx = { locale, currency: session.restaurant.currency, timezone: zone };
  const detailText = (r: ExceptionRow) => exceptionDetail(r, locale, m);
  const reasonText = (r: ExceptionRow) => exceptionReason(r, locale);
  async function loadMore() {
    if (!next) return;
    setMore(true);
    try {
      const page = await fetchExceptions({ ...filters, cursor: next });
      setRows((r) => [...r, ...page.rows]);
      setNext(page.next);
    } catch (e) {
      setNotice(translateError((e as Error).message, locale));
    } finally {
      setMore(false);
    }
  }
  async function all() {
    return fetchAllPages((cursor, limit) =>
      fetchExceptions({ ...filters, cursor, limit }),
    );
  }
  async function csv() {
    setCsvBusy(true);
    setNotice("");
    try {
      const result = await all();
      exportCsv(
        "reportsCsvExceptions",
        range,
        exceptionColumns(locale, detailText, reasonText),
        result.rows,
        ctx,
      );
      if (result.truncated) setNotice(t.reportsCsvTruncated);
    } catch (e) {
      setNotice(translateError((e as Error).message, locale));
    } finally {
      setCsvBusy(false);
    }
  }
  const toggle = (kind: ExceptionKind) =>
    setKinds((k) =>
      k.includes(kind) ? k.filter((x) => x !== kind) : [...k, kind],
    );
  const columns: Column<ExceptionRow>[] = [
    {
      key: "at",
      header: t.reportsColWhen,
      render: (r: ExceptionRow) => dateTimeLabel(r.at, zone, locale),
    },
    {
      key: "kind",
      header: t.reportsColKind,
      render: (r: ExceptionRow) => exceptionKindLabel(r.kind, locale),
    },
    {
      key: "employee",
      header: t.reportsColEmployee,
      render: (r: ExceptionRow) =>
        r.actorName ??
        (r.accountName
          ? fill(t.reportsExAccountOf, { name: r.accountName })
          : ""),
    },
    {
      key: "approver",
      header: t.reportsColApprover,
      render: (r: ExceptionRow) =>
        r.approverName ?? (r.kind === "discount" ? t.reportsExWithinLimit : ""),
    },
    {
      key: "amount",
      header: t.reportsColAmount,
      numeric: true,
      render: (r: ExceptionRow) => m(r.amount),
    },
    {
      key: "order",
      header: t.reportsColOrder,
      render: (r: ExceptionRow) =>
        r.orderId && r.orderNumber !== null ? (
          <button
            type="button"
            className="link-button"
            onClick={() => setDetail(r.orderId)}
          >
            #{r.orderNumber}
          </button>
        ) : (
          ""
        ),
    },
    {
      key: "detail",
      header: t.reportsColDetail,
      render: (r: ExceptionRow) =>
        [detailText(r), reasonText(r)].filter(Boolean).join(" · "),
    },
    {
      key: "device",
      header: t.reportsColDevice,
      render: (r: ExceptionRow) => r.deviceName ?? "",
    },
  ];
  return (
    <div className="report-tab" aria-busy={list.loading}>
      <p className="muted">{t.reportsExceptionsHint}</p>
      <ReportToolbar
        locale={locale}
        online={online}
        busy={list.loading}
        csvBusy={csvBusy}
        onRefresh={list.reload}
        onCsv={() => void csv()}
        onPrint={() =>
          void all().then((result) =>
            printSheet(
              t.reportsTabExceptions,
              session.restaurant.name,
              <table>
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c.key} className={c.numeric ? "num" : undefined}>
                        {c.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.kind + r.id}>
                      <td>{dateTimeLabel(r.at, zone, locale)}</td>
                      <td>{exceptionKindLabel(r.kind, locale)}</td>
                      <td>{r.actorName ?? r.accountName ?? ""}</td>
                      <td>{r.approverName ?? ""}</td>
                      <td className="num">{m(r.amount)}</td>
                      <td>
                        {r.orderNumber !== null ? "#" + r.orderNumber : ""}
                      </td>
                      <td>
                        {[detailText(r), reasonText(r)]
                          .filter(Boolean)
                          .join(" · ")}
                      </td>
                      <td>{r.deviceName ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>,
            ),
          )
        }
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
      </ReportToolbar>
      <div
        className="report-chips"
        role="group"
        aria-label={t.reportsKindFilter}
      >
        <button
          type="button"
          className={"report-chip" + (kinds.length === 0 ? " selected" : "")}
          aria-pressed={kinds.length === 0}
          onClick={() => setKinds([])}
        >
          {t.reportsAllKinds}
        </button>
        {EXCEPTION_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className={
              "report-chip" + (kinds.includes(kind) ? " selected" : "")
            }
            aria-pressed={kinds.includes(kind)}
            onClick={() => toggle(kind)}
          >
            {exceptionKindLabel(kind, locale)}
          </button>
        ))}
      </div>
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      <ReportStatus state={list} online={online} locale={locale} />
      {summary && (
        <>
          <Tiles
            items={summary.byKind.map((k) => ({
              label: exceptionKindLabel(k.kind, locale),
              value: `${k.count} · ${m(k.amount)}`,
              note:
                k.shortages !== undefined
                  ? `${t.reportsShort} ${m(k.shortages)} · ${t.reportsOver} ${m(k.overages ?? 0)}`
                  : undefined,
            }))}
          />
          {summary.byEmployee.length > 0 && (
            <section className="panel" aria-labelledby="report-by-employee">
              <h2 id="report-by-employee">{t.reportsByEmployee}</h2>
              <DataTable
                caption={t.reportsByEmployee}
                locale={locale}
                rows={summary.byEmployee}
                rowKey={(e) => e.employeeId}
                columns={[
                  {
                    key: "name",
                    header: t.reportsColEmployee,
                    render: (e) => e.name,
                  },
                  ...(
                    [
                      ["void", t.reportsExKindVoid],
                      ["discount", t.reportsExKindDiscount],
                      ["refund", t.reportsExKindRefund],
                      ["paid_out", t.reportsExKindPaidOut],
                      ["reprint", t.reportsExKindReprint],
                    ] as const
                  ).map(([kind, header]) => ({
                    key: kind,
                    header,
                    numeric: true,
                    render: (e: ExceptionSummary["byEmployee"][number]) => {
                      const a = e.acted[kind];
                      return a ? `${a.count} · ${m(a.amount)}` : "";
                    },
                  })),
                  {
                    key: "shortages",
                    header: t.reportsShortages,
                    numeric: true,
                    render: (e) => m(e.shortages),
                  },
                  {
                    key: "overages",
                    header: t.reportsOverages,
                    numeric: true,
                    render: (e) => m(e.overages),
                  },
                  {
                    key: "approved",
                    header: t.reportsApprovals,
                    numeric: true,
                    render: (e) =>
                      e.approved.count
                        ? `${e.approved.count} · ${m(e.approved.amount)}`
                        : "",
                  },
                ]}
              />
            </section>
          )}
        </>
      )}
      <DataTable<ExceptionRow>
        caption={t.reportsTabExceptions}
        locale={locale}
        rows={rows}
        rowKey={(r) => r.kind + ":" + r.id}
        empty={list.loading ? undefined : t.reportsExNone}
        columns={columns}
      />
      {next && (
        <Button onClick={() => void loadMore()} disabled={more || !online}>
          {t.reportsLoadMore}
        </Button>
      )}
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
