/**
 * cfdi display helpers (spec §5.1): status, kind and period labels, payment forms, masked UUIDs and
 * the Today alert text for reports. Pure functions over the i18n strings.
 */
import { Temporal } from "@js-temporal/polyfill";
import {
  businessDate,
  type Locale,
  type Session,
} from "../../../shared/domain";
import {
  deadlineShowsTime,
  docLabel,
  globalPeriodFor,
  PAYMENT_FORMS,
  type CfdiDocumentKind,
  type CfdiDocumentSummary,
  type GlobalPeriodView,
  type ReceptorField,
  type ReceptorIssue,
} from "../../../shared/cfdi";
import type { ReportAlert } from "../../../shared/reports";
import { strings, type Key } from "../../i18n";

export { docLabel };

/** Replaces {name} placeholders (the base pattern of SettlementDialog's .replace("{n}", …)). */
export function fill(
  text: string,
  values: Record<string, string | number>,
): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

export function t(
  locale: Locale,
  key: Key,
  values?: Record<string, string | number>,
) {
  const text = strings[locale][key];
  return values ? fill(text, values) : text;
}

const STATUS: Record<string, Key> = {
  waiting: "cfdiStatusWaiting",
  queued: "cfdiStatusOpen",
  stamping: "cfdiStatusOpen",
  pending: "cfdiStatusOpen",
  valid: "cfdiStatusValid",
  failed: "cfdiStatusFailed",
  canceling: "cfdiStatusCanceling",
  canceled: "cfdiStatusCanceled",
};
export function cfdiStatusLabel(
  status: string,
  locale: Locale,
  stuck = false,
): string {
  return t(
    locale,
    stuck ? "cfdiStatusStuck" : (STATUS[status] ?? "cfdiStatusOpen"),
  );
}
export function statusTone(status: string, stuck = false): string {
  if (stuck || status === "failed") return "red";
  if (status === "valid") return "green";
  if (status === "canceled") return "neutral";
  return "amber";
}
const KIND: Record<CfdiDocumentKind, Key> = {
  invoice: "cfdiKindInvoice",
  global: "cfdiKindGlobal",
  egreso: "cfdiKindEgreso",
};
export function kindLabel(kind: CfdiDocumentKind, locale: Locale): string {
  return t(locale, KIND[kind]);
}

const intl = (locale: Locale) => (locale === "es" ? "es-MX" : "en-US");

/** "4 oct 2026" for a business date (YYYY-MM-DD, no timezone shift). */
export function dateLabel(date: string, locale: Locale): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(intl(locale), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
/** "31/10/2026" for an instant in the restaurant timezone. */
export function shortDate(
  iso: string,
  timezone: string,
  locale: Locale,
): string {
  return new Intl.DateTimeFormat(intl(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: timezone,
  }).format(new Date(iso));
}
/**
 * A self-invoicing deadline for the receipt, the portal and the staff dialog (LD-51 F1): "31/10/2026"
 * for the policy's end of day, or "12/10/2026 a las 05:00" whenever it is not (a global-bound
 * deadline: the period's close + grace, early in the morning, LD-55 CFDIFIX-FISCAL-1 / UX-1) and
 * on the purchase's business date or the next day, where the date alone would read as the whole
 * day (deadlineShowsTime).
 */
export function deadlineText(
  iso: string,
  businessDate: string,
  timezone: string,
  locale: Locale,
): string {
  const date = shortDate(iso, timezone, locale);
  if (!deadlineShowsTime(iso, businessDate, timezone)) return date;
  const time = new Intl.DateTimeFormat(intl(locale), {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
    ...(locale === "es" ? { hourCycle: "h23" as const } : {}),
  }).format(new Date(iso));
  return t(locale, "cfdiDateAtTime", { date, time });
}

export function dateTimeLabel(
  iso: string,
  timezone: string,
  locale: Locale,
): string {
  return new Intl.DateTimeFormat(intl(locale), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(iso));
}

/** "Octubre 2026", "Semana 5–11 oct 2026", "1ª quincena oct 2026", "4 oct 2026". */
export function periodLabel(
  p: Pick<GlobalPeriodView, "periodicity" | "from" | "to">,
  locale: Locale,
): string {
  const [y, m, d] = p.from.split("-").map(Number);
  const to = Number(p.to.slice(8, 10));
  const month = (style: "long" | "short") =>
    new Intl.DateTimeFormat(intl(locale), {
      month: style,
      timeZone: "UTC",
    }).format(new Date(Date.UTC(y, m - 1, 1)));
  if (p.periodicity === "day") return dateLabel(p.from, locale);
  if (p.periodicity === "month") {
    const name = month("long");
    return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
  }
  if (p.periodicity === "fortnight")
    return locale === "es"
      ? `${d === 1 ? "1ª" : "2ª"} quincena ${month("short")} ${y}`
      : `${d === 1 ? "1st" : "2nd"} half ${month("short")} ${y}`;
  return locale === "es"
    ? `Semana ${d}–${to} ${month("short")} ${y}`
    : `Week ${d}–${to} ${month("short")} ${y}`;
}
/**
 * What the amount check measured (CFDI-MONEY-3): the stamped total BEFORE the RESICO retention
 * against the expected total, else the stamped IVA against the expected IVA. Null when both match.
 */
export function amountDifference(d: {
  total: number | null;
  withheld: number | null;
  expectedTotal: number | null;
  tax: number | null;
  expectedTax: number | null;
}): { kind: "total" | "tax"; amount: number } | null {
  const total = Math.abs(
    (d.total ?? 0) + (d.withheld ?? 0) - (d.expectedTotal ?? 0),
  );
  if (d.total !== null && d.expectedTotal !== null && total > 0)
    return { kind: "total", amount: total };
  const tax = Math.abs((d.tax ?? 0) - (d.expectedTax ?? 0));
  if (d.tax !== null && d.expectedTax !== null && tax > 0)
    return { kind: "tax", amount: tax };
  return null;
}
/** The period of a period key ("D2026-10-04", "M2026-10", …) for chips. */
export function periodKeyLabel(key: string | null, locale: Locale): string {
  if (!key) return "";
  const kind = key[0];
  const body = key.slice(1);
  if (kind === "D")
    return periodLabel({ periodicity: "day", from: body, to: body }, locale);
  if (kind === "M")
    return periodLabel(
      { periodicity: "month", from: body + "-01", to: body + "-28" },
      locale,
    );
  if (kind === "F") {
    const half = body.endsWith("-1") ? "01" : "16";
    const month = body.slice(0, 7);
    return periodLabel(
      {
        periodicity: "fortnight",
        from: `${month}-${half}`,
        to: `${month}-${half}`,
      },
      locale,
    );
  }
  // The week's real (month-clipped) range from its start date (CFDI-UX-8).
  const week = globalPeriodFor(body, "week");
  return periodLabel(
    { periodicity: "week", from: week.from, to: week.to },
    locale,
  );
}

export function paymentFormLabel(form: string | null): string {
  if (!form) return "";
  const name = (PAYMENT_FORMS as Record<string, string>)[form];
  return name ? `${form} — ${name}` : form;
}
/** "3F2A…9B1C": enough to compare with the PDF without printing the whole folio fiscal. */
export function maskedUuid(uuid: string | null): string {
  if (!uuid) return "";
  const u = uuid.toUpperCase();
  return `${u.slice(0, 4)}…${u.slice(-4)}`;
}
export function documentLabel(
  d: Pick<CfdiDocumentSummary, "series" | "folioNumber" | "id">,
): string {
  return docLabel(d.series, d.folioNumber) ?? d.id.slice(0, 8);
}

/** Facturapi's error `path` → the receptor field to highlight (spec §2.5 "Result: failed"). */
const PATH_FIELDS: Record<string, ReceptorField> = {
  "customer.tax_id": "rfc",
  "customer.legal_name": "legalName",
  "customer.address.zip": "postalCode",
  "customer.tax_system": "regime",
  "customer.email": "email",
  use: "use",
};
export function issueOfError(
  error: { code: string; path: string | null } | null,
): ReceptorIssue | null {
  const field = error?.path ? PATH_FIELDS[error.path] : undefined;
  return error && field ? { field, code: error.code } : null;
}
/** Client issues first; a server issue is added for a field the client found nothing on. */
export function withServerIssue(
  issues: ReceptorIssue[],
  server: ReceptorIssue | null,
): ReceptorIssue[] {
  if (!server || issues.some((i) => i.field === server.field && !i.warning))
    return issues;
  return [server, ...issues.filter((i) => i.field !== server.field)];
}

const EVENTS: Record<string, Key> = {
  requested: "cfdiEventRequested",
  frozen: "cfdiEventFrozen",
  stamp_sent: "cfdiEventSent",
  stamped: "cfdiEventStamped",
  pending: "cfdiEventPending",
  failed: "cfdiEventFailed",
  stamp_unknown: "cfdiEventUnknown",
  cancel_unknown: "cfdiEventUnknown",
  stamp_retry: "cfdiEventRetry",
  attempts_exhausted: "cfdiEventExhausted",
  emailed: "cfdiEventEmailed",
  email_failed: "cfdiEventEmailFailed",
  email_requested: "cfdiEventEmailRequested",
  cancel_queued: "cfdiEventCancelQueued",
  cancel_requested: "cfdiEventCancelRequested",
  canceled: "cfdiEventCanceled",
  cancel_rejected: "cfdiEventCancelRejected",
  cancel_failed: "cfdiEventCancelFailed",
  amount_check: "cfdiEventAmountCheck",
  late_global: "cfdiEventLateGlobal",
  substitution_requested: "cfdiEventSubstitution",
  substitution_completed: "cfdiEventSubstitution",
  reissue_completed: "cfdiEventReissue",
  retry_requested: "cfdiEventRetryRequested",
  recovery_queued: "cfdiEventRecovered",
  acuse_mismatch: "cfdiEventAcuseMismatch",
  acuse_mismatch_live: "cfdiEventAcuseMismatchLive",
  acuse_mismatch_final: "cfdiEventAcuseMismatchFinal",
};
const CANCELLATION: Record<string, Key> = {
  queued: "cfdiStatusCanceling",
  requested: "cfdiEventCancelRequested",
  accepted: "cfdiStatusCanceled",
  rejected: "cfdiEventCancelRejected",
  expired: "cfdiEventCancelRejected",
  failed: "cfdiEventCancelFailed",
};
export function cancellationLabel(status: string, locale: Locale): string {
  return t(locale, CANCELLATION[status] ?? "cfdiStatusCanceling");
}
export function eventLabel(kind: string, locale: Locale): string {
  return t(locale, EVENTS[kind] ?? "cfdiEventOther");
}

/** Text for reports' four cfdi_* Today alert codes (spec §6.1); null for other codes. */
export function cfdiReportAlertText(
  alert: ReportAlert,
  locale: Locale,
): string | null {
  const n = alert.count;
  switch (alert.code) {
    case "cfdi_global_overdue":
      return t(locale, "cfdiReportAlertGlobalOverdue", { n });
    case "cfdi_documents_attention":
      return t(locale, "cfdiReportAlertDocuments", { n });
    case "cfdi_substitution_rejected":
      return t(locale, "cfdiReportAlertSubstitution", { n });
    case "cfdi_csd_expiring":
      return t(locale, "cfdiReportAlertCsd");
    default:
      return null;
  }
}

/** Today's business date for a restaurant (its timezone and day cutoff). */
export function todayFor(
  r: Pick<Session["restaurant"], "timezone" | "cutoff">,
): string {
  return businessDate(new Date().toISOString(), r.timezone, r.cutoff);
}
/** `date` plus `days` calendar days. */
export function shiftDate(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

export function moneyLabel(centavos: number, locale: Locale): string {
  return new Intl.NumberFormat(intl(locale), {
    style: "currency",
    currency: "MXN",
  }).format(centavos / 100);
}
