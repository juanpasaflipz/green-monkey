import { useRef, type KeyboardEvent } from "react";
import { ReportRefresh } from "./useReport";
import type { Locale, Session } from "../../../shared/domain";
import {
  addDays,
  currentBusinessDate,
  LIMITS,
  parseRange,
  quickRange,
  type DateRange,
} from "../../../shared/reports";
import { strings, translateError, type Key } from "../../i18n";
import { useStoredState } from "../../serviceHooks";
import { RangePicker } from "./RangePicker";
import { AuditTab } from "./tabs/AuditTab";
import { CortesTab } from "./tabs/CortesTab";
import { ExceptionsTab } from "./tabs/ExceptionsTab";
import { HoursTab } from "./tabs/HoursTab";
import { PaymentsTab } from "./tabs/PaymentsTab";
import { ProductsTab } from "./tabs/ProductsTab";
import { StaffTab } from "./tabs/StaffTab";
import { SummaryTab } from "./tabs/SummaryTab";
import "./reports.css";

export const REPORT_TABS = [
  "summary",
  "products",
  "staff",
  "hours",
  "payments",
  "cortes",
  "exceptions",
  "audit",
] as const;
export type ReportTab = (typeof REPORT_TABS)[number];
const TAB_KEYS: Record<ReportTab, Key> = {
  summary: "reportsTabSummary",
  products: "reportsTabProducts",
  staff: "reportsTabStaff",
  hours: "reportsTabHours",
  payments: "reportsTabPayments",
  cortes: "reportsTabCortes",
  exceptions: "reportsTabExceptions",
  audit: "reportsTabAudit",
};
/** Row lists read at most 31 days; summaries, breakdowns and cortes 92 (D9). */
const LIST_TABS: readonly ReportTab[] = ["payments", "exceptions", "audit"];
export const REPORTS_TAB_KEY = "gm-reports-tab";
export const REPORTS_RANGE_KEY = "gm-reports-range";

const isTab = (v: unknown): v is ReportTab =>
  typeof v === "string" && (REPORT_TABS as readonly string[]).includes(v);
function isRange(v: unknown): v is DateRange {
  try {
    parseRange(v as DateRange, LIMITS.aggregateDays);
    return true;
  } catch {
    return false;
  }
}

/** Opens Finanzas on `tab` (and optionally `range`) from another view, e.g. Hoy or Auditoría. */
export function openReports(tab: ReportTab, range?: DateRange) {
  try {
    localStorage.setItem(REPORTS_TAB_KEY, tab);
    if (range) localStorage.setItem(REPORTS_RANGE_KEY, JSON.stringify(range));
  } catch {
    /* Storage blocked: Finanzas opens on its default tab. */
  }
}

/**
 * Finanzas (spec §2.5): a business-date range picker and eight tabs (ARIA tabs pattern). The tab
 * and range persist per device. Offline, every tab shows "Los reportes requieren conexión." and
 * fetches nothing.
 */
export function ReportsView({
  session,
  locale,
  navigate,
  online = true,
  refreshKey = 0,
}: {
  session: Session;
  locale: Locale;
  navigate: (view: string) => void;
  online?: boolean;
  /** Operations' header Actualizar: every tab's reports fetch again (REPORTS-UI-10). */
  refreshKey?: number;
}) {
  const t = strings[locale];
  const settings = session.restaurant;
  const today = currentBusinessDate(settings);
  const [tab, setTab] = useStoredState<ReportTab>(
    REPORTS_TAB_KEY,
    "summary",
    isTab,
  );
  const [stored, setRange] = useStoredState<DateRange>(
    REPORTS_RANGE_KEY,
    quickRange("today", today),
    isRange,
  );
  // A stored range older than 92 days, or one ending after today, starts over at today.
  const range =
    stored.to > today ||
    stored.from < addDays(today, -(LIMITS.aggregateDays - 1))
      ? quickRange("today", today)
      : stored;
  const maxDays = LIST_TABS.includes(tab)
    ? LIMITS.listDays
    : LIMITS.aggregateDays;
  let rangeError = false;
  try {
    parseRange(range, maxDays);
  } catch {
    rangeError = true;
  }
  const tabRefs = useRef<Partial<Record<ReportTab, HTMLButtonElement | null>>>(
    {},
  );
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const index = REPORT_TABS.indexOf(tab);
    const target =
      e.key === "ArrowRight"
        ? REPORT_TABS[(index + 1) % REPORT_TABS.length]
        : e.key === "ArrowLeft"
          ? REPORT_TABS[(index - 1 + REPORT_TABS.length) % REPORT_TABS.length]
          : e.key === "Home"
            ? REPORT_TABS[0]
            : e.key === "End"
              ? REPORT_TABS[REPORT_TABS.length - 1]
              : null;
    if (!target) return;
    e.preventDefault();
    setTab(target);
    tabRefs.current[target]?.focus();
  }
  const props = { session, locale, range, online };
  return (
    <div className="reports-view">
      <RangePicker
        value={range}
        onChange={setRange}
        maxDays={maxDays}
        settings={settings}
        locale={locale}
      />
      <div
        className="report-tablist"
        role="tablist"
        aria-label={t.reportsTabsLabel}
      >
        {REPORT_TABS.map((key) => (
          <button
            key={key}
            ref={(el) => {
              tabRefs.current[key] = el;
            }}
            id={"reports-tab-" + key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            aria-controls="reports-panel"
            tabIndex={tab === key ? 0 : -1}
            className={tab === key ? "selected" : ""}
            onClick={() => setTab(key)}
            onKeyDown={onTabKey}
          >
            {t[TAB_KEYS[key]]}
          </button>
        ))}
      </div>
      <ReportRefresh.Provider value={refreshKey}>
        <div
          className="report-panel"
          role="tabpanel"
          id="reports-panel"
          tabIndex={0}
          aria-labelledby={"reports-tab-" + tab}
        >
          {rangeError ? (
            // The stored range exceeds this tab's limit (31 days for row lists).
            <p className="error" role="alert">
              {translateError("reports_range_invalid", locale)}
            </p>
          ) : tab === "summary" ? (
            <SummaryTab
              {...props}
              navigate={navigate}
              setRange={setRange}
              openTab={(next) => setTab(next)}
            />
          ) : tab === "products" ? (
            <ProductsTab {...props} />
          ) : tab === "staff" ? (
            <StaffTab {...props} />
          ) : tab === "hours" ? (
            <HoursTab {...props} />
          ) : tab === "payments" ? (
            <PaymentsTab {...props} navigate={navigate} />
          ) : tab === "cortes" ? (
            <CortesTab {...props} />
          ) : tab === "exceptions" ? (
            <ExceptionsTab {...props} navigate={navigate} />
          ) : (
            <AuditTab {...props} />
          )}
        </div>
      </ReportRefresh.Provider>
    </div>
  );
}
