import type { Label, Locale } from "../../../shared/domain";
import {
  csvFileName,
  toCsv,
  type CsvColumn,
  type CsvContext,
} from "../../../shared/csv";
import type {
  AuditRow,
  CategoryRow,
  ChannelRow,
  DateRange,
  DayRow,
  DrawerRow,
  EmployeeRow,
  ExceptionRow,
  HourRow,
  MethodTotals,
  OrderReportRow,
  ProductRow,
  SalesSummary,
  TenderReportRow,
} from "../../../shared/reports";
import { strings, type Key } from "../../i18n";
import { channelLabel, operationLabel, tenderMethodLabel } from "../../labels";
import { platformLabel } from "../../../shared/payments";
import { differenceLabel, exceptionKindLabel, hourLabel } from "./format";
import { summarySections } from "./summary-rows";
import {
  auditReason,
  exceptionApprover,
  exceptionEmployee,
} from "./exception-text";

/**
 * CSV exports (spec §2.9, §5.6). The writer (BOM, CRLF, quoting, OWASP formula guard, money
 * with the currency exponent) is shared/csv.ts; this module adds the browser download and the
 * column list of every dataset, with headers in the UI language.
 */
export { toCsv, csvFileName };

/** A header from an i18n key, in both languages (toCsv picks the context's locale). */
const h = (key: Key): Label => ({ es: strings.es[key], en: strings.en[key] });

/** Saves `text` as a UTF-8 CSV file through a temporary link. */
export function downloadCsv(fileName: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `{dataset}_{from}_{to}.csv` with the dataset name in the UI language. */
export function datasetFileName(key: Key, range: DateRange, locale: Locale) {
  return csvFileName(strings[locale][key], range);
}

const labelOf = (label: Label | null, locale: Locale) =>
  label ? label[locale] : null;

export type SummaryCsvRow = {
  section: string;
  concept: string;
  amount: number | null;
  quantity: number | null;
};
/** The summary dataset: one row per Resumen row in screen order (section, concept, figure). */
export function summaryCsvRows(
  summary: SalesSummary,
  locale: Locale,
): SummaryCsvRow[] {
  return summarySections(summary, locale).flatMap((section) =>
    section.lines.map((line) => ({
      section: section.title,
      concept: line.label,
      amount: line.amount,
      quantity: line.amount === null ? line.quantity : null,
    })),
  );
}
export const summaryColumns: CsvColumn<SummaryCsvRow>[] = [
  { header: h("reportsColSection"), type: "t", value: (r) => r.section },
  { header: h("reportsColConcept"), type: "t", value: (r) => r.concept },
  { header: h("reportsColAmount"), type: "m", value: (r) => r.amount },
  { header: h("reportsColQuantity"), type: "i", value: (r) => r.quantity },
];

export const dayColumns: CsvColumn<DayRow>[] = [
  { header: h("reportsColDate"), type: "d", value: (r) => r.date },
  { header: h("reportsColOrders"), type: "i", value: (r) => r.orders },
  { header: h("reportsColGross"), type: "m", value: (r) => r.grossSales },
  { header: h("reportsColDiscounts"), type: "m", value: (r) => r.discounts },
  { header: h("reportsColSalesTotal"), type: "m", value: (r) => r.salesTotal },
  { header: h("reportsColRefunds"), type: "m", value: (r) => r.refunds },
  { header: h("reportsColCash"), type: "m", value: (r) => r.cash },
  { header: h("reportsColTerminal"), type: "m", value: (r) => r.external },
  { header: h("reportsColTips"), type: "m", value: (r) => r.tips },
  { header: h("reportsColPaidOuts"), type: "m", value: (r) => r.paidOuts },
];

export const productColumns = (locale: Locale): CsvColumn<ProductRow>[] => [
  { header: h("reportsColProduct"), type: "t", value: (r) => r.name[locale] },
  {
    header: h("reportsColCategory"),
    type: "t",
    value: (r) => labelOf(r.category, locale),
  },
  { header: h("reportsColUnits"), type: "i", value: (r) => r.units },
  { header: h("reportsColGross"), type: "m", value: (r) => r.grossSales },
  { header: h("reportsColDiscounts"), type: "m", value: (r) => r.discounts },
  { header: h("reportsColSalesTotal"), type: "m", value: (r) => r.salesTotal },
  { header: h("reportsColShare"), type: "p", value: (r) => r.shareBps },
  { header: h("reportsColCost"), type: "m", value: (r) => r.cost },
  { header: h("reportsColMargin"), type: "m", value: (r) => r.margin },
  {
    header: h("reportsColRefundedUnits"),
    type: "i",
    value: (r) => r.refundedUnits,
  },
  { header: h("reportsColRefunded"), type: "m", value: (r) => r.refunded },
];

export const categoryColumns = (locale: Locale): CsvColumn<CategoryRow>[] => [
  {
    header: h("reportsColCategory"),
    type: "t",
    value: (r) => labelOf(r.name, locale) ?? strings[locale].reportsNoCategory,
  },
  { header: h("reportsColUnits"), type: "i", value: (r) => r.units },
  { header: h("reportsColGross"), type: "m", value: (r) => r.grossSales },
  { header: h("reportsColDiscounts"), type: "m", value: (r) => r.discounts },
  { header: h("reportsColSalesTotal"), type: "m", value: (r) => r.salesTotal },
  { header: h("reportsColShare"), type: "p", value: (r) => r.shareBps },
  { header: h("reportsColCost"), type: "m", value: (r) => r.cost },
  { header: h("reportsColMargin"), type: "m", value: (r) => r.margin },
];

export const staffColumns = (locale: Locale): CsvColumn<EmployeeRow>[] => [
  {
    header: h("reportsColEmployee"),
    type: "t",
    value: (r) =>
      r.employeeId === null ? strings[locale].reportsQrKiosk : r.name,
  },
  {
    header: h("reportsColRole"),
    type: "t",
    value: (r) =>
      r.employeeId === null ? "" : (strings[locale][r.role as Key] ?? r.role),
  },
  { header: h("reportsColOrders"), type: "i", value: (r) => r.orders },
  { header: h("reportsColSalesTotal"), type: "m", value: (r) => r.salesTotal },
  {
    header: h("reportsColAverageTicket"),
    type: "m",
    value: (r) => r.averageTicket,
  },
  { header: h("reportsColTips"), type: "m", value: (r) => r.tips },
  { header: h("reportsColDiscounts"), type: "m", value: (r) => r.discounts },
];

export const hourColumns: CsvColumn<HourRow>[] = [
  { header: h("reportsColHour"), type: "t", value: (r) => hourLabel(r.hour) },
  { header: h("reportsColOrders"), type: "i", value: (r) => r.orders },
  { header: h("reportsColSalesTotal"), type: "m", value: (r) => r.salesTotal },
  {
    header: h("reportsColAverageTicket"),
    type: "m",
    value: (r) => r.averageTicket,
  },
];

/** Channel rows, then the service-type rows with reportsColMode in the first column. */
export type ChannelCsvRow = ChannelRow & { group: "channel" | "mode" };
export const channelColumns = (locale: Locale): CsvColumn<ChannelCsvRow>[] => [
  {
    header: h("reportsColChannel"),
    type: "t",
    value: (r) =>
      r.group === "channel"
        ? channelLabel(r.key, locale)
        : `${strings[locale].reportsColMode}: ${strings[locale][r.key as Key] ?? r.key}`,
  },
  { header: h("reportsColOrders"), type: "i", value: (r) => r.orders },
  { header: h("reportsColSalesTotal"), type: "m", value: (r) => r.salesTotal },
  { header: h("reportsColShare"), type: "p", value: (r) => r.shareBps },
];

export const methodColumns = (locale: Locale): CsvColumn<MethodTotals>[] => [
  {
    header: h("reportsColMethod"),
    type: "t",
    value: (r) => tenderMethodLabel(r.method, undefined, locale),
  },
  { header: h("reportsColCount"), type: "i", value: (r) => r.count },
  { header: h("reportsColAmount"), type: "m", value: (r) => r.amount },
  { header: h("reportsColTips"), type: "m", value: (r) => r.tips },
  { header: h("reportsColRefunds"), type: "m", value: (r) => r.refunds },
  { header: h("reportsColNet"), type: "m", value: (r) => r.net },
];

export const tenderColumns = (locale: Locale): CsvColumn<TenderReportRow>[] => [
  { header: h("reportsColWhen"), type: "dt", value: (r) => r.at },
  {
    header: h("reportsColCollectionDate"),
    type: "d",
    value: (r) => r.collectionDate,
  },
  { header: h("reportsColOrder"), type: "i", value: (r) => r.orderNumber },
  { header: h("reportsColOrderDate"), type: "d", value: (r) => r.orderDate },
  {
    header: h("reportsColMethod"),
    type: "t",
    value: (r) => tenderMethodLabel(r.method, r.source, locale),
  },
  { header: h("reportsColAmount"), type: "m", value: (r) => r.amount },
  { header: h("reportsColTip"), type: "m", value: (r) => r.tip },
  { header: h("reportsColReference"), type: "t", value: (r) => r.reference },
  { header: h("reportsColDrawer"), type: "t", value: (r) => r.deviceName },
  { header: h("reportsColRefunded"), type: "m", value: (r) => r.refunded },
  {
    header: h("reportsColOffline"),
    type: "t",
    value: (r) =>
      r.offline ? strings[locale].reportsYes : strings[locale].reportsNo,
  },
  // payments (037): terminal, provider, card and platform columns; fees (this export is the
  // managers' tender list).
  { header: h("payTerminal"), type: "t", value: (r) => r.terminal ?? null },
  { header: h("payCsvProvider"), type: "t", value: (r) => r.provider ?? null },
  {
    header: h("payCsvProviderReference"),
    type: "t",
    value: (r) => r.providerReference ?? null,
  },
  {
    header: h("payCsvCardBrand"),
    type: "t",
    value: (r) => r.cardBrand ?? null,
  },
  {
    header: h("payCsvCardLast4"),
    type: "t",
    value: (r) => r.cardLast4 ?? null,
  },
  {
    header: h("payPlatform"),
    type: "t",
    value: (r) =>
      r.platform ? platformLabel(r.platform, r.platformLabel, locale) : null,
  },
  { header: h("payReportsFees"), type: "m", value: (r) => r.fee ?? null },
  {
    header: h("payCsvFeeSource"),
    type: "t",
    value: (r) =>
      r.feeSource === "provider"
        ? strings[locale].payCsvFeeProvider
        : r.feeSource === "estimated"
          ? strings[locale].payReportsFeesEstimated
          : null,
  },
];

export const orderColumns = (locale: Locale): CsvColumn<OrderReportRow>[] => [
  { header: h("reportsColDate"), type: "d", value: (r) => r.businessDate },
  { header: h("reportsColOrder"), type: "i", value: (r) => r.number },
  { header: h("reportsColWhen"), type: "dt", value: (r) => r.createdAt },
  {
    header: h("reportsColChannel"),
    type: "t",
    value: (r) => channelLabel(r.channel, locale),
  },
  {
    header: h("reportsColMode"),
    type: "t",
    value: (r) => strings[locale][r.mode as Key] ?? r.mode,
  },
  { header: h("reportsColTable"), type: "t", value: (r) => r.tableName },
  { header: h("reportsColWaiter"), type: "t", value: (r) => r.waiterName },
  { header: h("reportsColGross"), type: "m", value: (r) => r.grossSales },
  { header: h("reportsColDiscounts"), type: "m", value: (r) => r.discount },
  { header: h("reportsColSalesTotal"), type: "m", value: (r) => r.total },
  { header: h("reportsColPaid"), type: "m", value: (r) => r.paid },
  {
    header: h("reportsColOutstanding"),
    type: "m",
    value: (r) => r.outstanding,
  },
  { header: h("reportsColTips"), type: "m", value: (r) => r.tips },
  { header: h("reportsColRefunded"), type: "m", value: (r) => r.refunded },
  { header: h("reportsColFolio"), type: "t", value: (r) => r.folio },
  { header: h("reportsColStatus"), type: "t", value: (r) => r.checkState },
];

export const exceptionColumns = (
  locale: Locale,
  detail: (r: ExceptionRow) => string,
  reason: (r: ExceptionRow) => string,
): CsvColumn<ExceptionRow>[] => [
  { header: h("reportsColWhen"), type: "dt", value: (r) => r.at },
  { header: h("reportsColDate"), type: "d", value: (r) => r.businessDate },
  {
    header: h("reportsColKind"),
    type: "t",
    value: (r) => exceptionKindLabel(r.kind, locale),
  },
  {
    header: h("reportsColEmployee"),
    type: "t",
    value: (r) => exceptionEmployee(r, locale),
  },
  {
    header: h("reportsColApprover"),
    type: "t",
    value: (r) => exceptionApprover(r, locale),
  },
  { header: h("reportsColAmount"), type: "m", value: (r) => r.amount },
  { header: h("reportsColOrder"), type: "i", value: (r) => r.orderNumber },
  { header: h("reportsColReason"), type: "t", value: reason },
  { header: h("reportsColDetail"), type: "t", value: detail },
  { header: h("reportsColDevice"), type: "t", value: (r) => r.deviceName },
];

export const auditColumns = (
  locale: Locale,
  reference: (r: AuditRow) => string,
): CsvColumn<AuditRow>[] => [
  { header: h("reportsColWhen"), type: "dt", value: (r) => r.at },
  { header: h("reportsColDate"), type: "d", value: (r) => r.businessDate },
  {
    header: h("reportsColActivity"),
    type: "t",
    value: (r) => operationLabel(r.operation, locale),
  },
  { header: h("reportsColActivityCode"), type: "t", value: (r) => r.operation },
  { header: h("reportsColEmployee"), type: "t", value: (r) => r.actorName },
  { header: h("reportsColReference"), type: "t", value: reference },
  { header: h("reportsColAmount"), type: "m", value: (r) => r.summary.amount },
  {
    header: h("reportsColReason"),
    type: "t",
    value: (r) => auditReason(r, locale),
  },
];

export const drawerColumns = (locale: Locale): CsvColumn<DrawerRow>[] => [
  { header: h("reportsColDate"), type: "d", value: (r) => r.businessDate },
  { header: h("reportsColZNumber"), type: "i", value: (r) => r.zNumber },
  { header: h("reportsColDrawer"), type: "t", value: (r) => r.deviceName },
  { header: h("reportsColOpenedBy"), type: "t", value: (r) => r.openedByName },
  { header: h("reportsColOpenedAt"), type: "dt", value: (r) => r.openedAt },
  { header: h("reportsColClosedBy"), type: "t", value: (r) => r.closedByName },
  { header: h("reportsColClosedAt"), type: "dt", value: (r) => r.closedAt },
  { header: h("reportsColOpening"), type: "m", value: (r) => r.opening },
  { header: h("reportsColCashSales"), type: "m", value: (r) => r.cashSales },
  { header: h("reportsColCashTips"), type: "m", value: (r) => r.cashTips },
  {
    header: h("reportsColCashRefunds"),
    type: "m",
    value: (r) => r.cashRefunds,
  },
  { header: h("reportsColPaidOuts"), type: "m", value: (r) => r.paidOuts },
  { header: h("reportsColExpected"), type: "m", value: (r) => r.expected },
  { header: h("reportsColCounted"), type: "m", value: (r) => r.counted },
  { header: h("reportsColDifference"), type: "m", value: (r) => r.difference },
  {
    header: h("reportsColCountMode"),
    type: "t",
    value: (r) =>
      r.countMode === null
        ? null
        : strings[locale][
            r.countMode === "blind"
              ? "reportsDocCountBlind"
              : "reportsDocCountVisible"
          ],
  },
  {
    header: h("reportsColTerminalNet"),
    type: "m",
    value: (r) => r.terminalNet,
  },
  {
    header: h("reportsColTerminalReported"),
    type: "m",
    value: (r) => r.terminalReported,
  },
  {
    header: h("reportsColTerminalDifference"),
    type: "m",
    value: (r) => r.terminalDifference,
  },
  {
    header: h("reportsColReview"),
    type: "t",
    value: (r) =>
      r.review
        ? `${r.review.reviewerName}: ${r.review.note}`
        : r.difference !== null && r.difference !== 0
          ? strings[locale].reportsToReview
          : r.difference === 0
            ? differenceLabel(0, locale)
            : null,
  },
];

/** Builds and downloads one dataset. */
export function exportCsv<T>(
  key: Key,
  range: DateRange,
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
  ctx: CsvContext,
) {
  downloadCsv(
    datasetFileName(key, range, ctx.locale),
    toCsv(columns, rows, ctx),
  );
}
