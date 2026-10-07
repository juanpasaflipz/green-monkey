/**
 * CFDI 4.0 (cfdi 030): pure rules and wire shapes shared by the web, the worker and the client
 * (spec §4.2). No I/O.
 *
 * - The c_UsoCFDI catalog (USE_LABELS, USE_REGIMES, usoCfdiAllowed) lives in shared/sat.ts
 *   (Wave 2.0 (j), LD-14 OQ-4) and is re-exported here.
 * - Receptor input and its issues (the server throws the first non-warning issue as a
 *   DomainError(code, 400); the client shows them inline before submitting).
 * - Global-invoice periods (SAT "Guía de llenado del CFDI global": Periodicidad, Meses, Año) by the
 *   ticket's fiscal business date (decision D5): day, week (Monday–Sunday cut at the month end so
 *   Meses is unambiguous), fortnight (1–15 / 16–end) and month.
 * - The SAT forma de pago per tender (largest amount wins; credit/debit asked at invoicing, D3).
 * - RESICO ISR withholding (LISR 113-J, LD-16 L9): a persona física in régimen 626 invoicing a
 *   persona moral shows a 1.25 % ISR retention per concept.
 * - Request inputs and the JSON views of the routes.
 */
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { boundaries, id } from "./domain.js";
import { groupSelfInvoiceCode, normalizeSelfInvoiceCode } from "./fiscal.js";
import {
  GENERIC_RFCS,
  REGIMEN_FISCAL,
  RFC_PATTERN,
  regimeAllowedFor,
  rfcCheckDigitValid,
  rfcKind,
  USE_LABELS,
  USE_REGIMES,
  usoCfdiAllowed,
  type SatUse,
} from "./sat.js";

export { USE_LABELS, USE_REGIMES, usoCfdiAllowed, type SatUse };

// ---------------------------------------------------------------------------------------------
// Uses, payment forms, receptor
// ---------------------------------------------------------------------------------------------

/** Uses offered to receptors (staff dialog and portal). */
export const CFDI_USES = [
  "G03",
  "G01",
  "S01",
] as const satisfies readonly SatUse[];
export type CfdiUse = (typeof CFDI_USES)[number];

export const PAYMENT_FORMS = {
  "01": "Efectivo",
  "04": "Tarjeta de crédito",
  "28": "Tarjeta de débito",
} as const;
export const CARD_PAYMENT_FORMS = ["04", "28"] as const;
export type CardForm = (typeof CARD_PAYMENT_FORMS)[number];

/**
 * SAT FormaPago: the form with which the largest amount was paid (Anexo 20 guide; SAT global
 * guide for the ticket of greatest amount). Cash tenders (and offline recovery cash) are "01"; an
 * external terminal is the card form given (credit 04 / debit 28). Ties take the form of the
 * earliest tender (array order = created_at). Tips are not part of `amount`. No payment at all
 * reads as cash.
 */
export function paymentFormFor(
  payments: readonly { method: string; amount: number }[],
  card: CardForm,
): "01" | CardForm {
  const sums = new Map<"01" | CardForm, number>();
  for (const p of payments) {
    const form = p.method === "external" ? card : "01";
    sums.set(
      form,
      (sums.get(form) ?? 0) + (Number.isFinite(p.amount) ? p.amount : 0),
    );
  }
  let best: "01" | CardForm = "01";
  let bestAmount = -Infinity;
  // Map iteration is insertion order: the first tender's form wins a tie.
  for (const [form, amount] of sums)
    if (amount > bestAmount) {
      best = form;
      bestAmount = amount;
    }
  return best;
}

/** True when the forma de pago depends on a card answer (credit or debit). */
export function needsCardForm(
  payments: readonly { method: string; amount: number }[],
): boolean {
  return paymentFormFor(payments, "04") !== "01";
}

/**
 * A nominative receptor as typed by staff or a customer. Formats are checked by receptorIssues
 * (stable cfdi_* codes for every field), so the schema only bounds sizes and normalizes text.
 */
export const receptorInput = z
  .object({
    rfc: z.string().trim().toUpperCase().max(13),
    legalName: z
      .string()
      .trim()
      .max(300)
      .transform((s) => s.replace(/\s+/g, " ")),
    regime: z.string().trim().max(3),
    postalCode: z.string().trim().max(5),
    use: z.enum(CFDI_USES),
    email: z.string().trim().toLowerCase().max(254).nullable(),
  })
  .strict();
export type Receptor = z.infer<typeof receptorInput>;
export type ReceptorField =
  "rfc" | "legalName" | "regime" | "postalCode" | "use" | "email";
export type ReceptorIssue = {
  field: ReceptorField;
  code: string;
  warning?: true;
};

const emailFormat = z.email();
// SAT asks for the name without the company type ("régimen societario"): S.A., S.A. de C.V.,
// S. de R.L., S.C., A.C. at the end of the name.
const COMPANY_SUFFIX =
  /\b(S\.?\s?A\.?\s?(DE\s?C\.?\s?V\.?)?|S\.?\s?DE\s?R\.?\s?L\.?(\s?DE\s?C\.?\s?V\.?)?|S\.?\s?C\.?|A\.?\s?C\.?)\s*$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Every issue in field order; the server throws the first non-warning code as DomainError(code, 400). */
export function receptorIssues(
  r: Receptor,
  o: { requireEmail: boolean },
): ReceptorIssue[] {
  const issues: ReceptorIssue[] = [];
  const rfc = r.rfc.trim().toUpperCase();
  if ((GENERIC_RFCS as readonly string[]).includes(rfc))
    issues.push({ field: "rfc", code: "cfdi_generic_rfc" });
  else if (!RFC_PATTERN.test(rfc))
    issues.push({ field: "rfc", code: "cfdi_invalid_rfc" });
  else if (!rfcCheckDigitValid(rfc))
    issues.push({ field: "rfc", code: "cfdiRfcCheckDigit", warning: true });
  const name = r.legalName.trim();
  if (!name || name.length > 254 || CONTROL.test(name))
    issues.push({ field: "legalName", code: "cfdi_invalid_legal_name" });
  else if (COMPANY_SUFFIX.test(name))
    issues.push({
      field: "legalName",
      code: "cfdiLegalNameSuffix",
      warning: true,
    });
  const kind = RFC_PATTERN.test(rfc) ? rfcKind(rfc) : null;
  if (!Object.hasOwn(REGIMEN_FISCAL, r.regime))
    issues.push({ field: "regime", code: "cfdi_invalid_regime" });
  else if (kind && !regimeAllowedFor(r.regime, kind))
    issues.push({ field: "regime", code: "cfdi_regime_mismatch" });
  if (!/^\d{5}$/.test(r.postalCode))
    issues.push({ field: "postalCode", code: "cfdi_invalid_postal_code" });
  if (
    !(CFDI_USES as readonly string[]).includes(r.use) ||
    (Object.hasOwn(REGIMEN_FISCAL, r.regime) &&
      !usoCfdiAllowed(r.regime, r.use))
  )
    issues.push({ field: "use", code: "cfdi_use_not_allowed" });
  if (r.email) {
    if (!emailFormat.safeParse(r.email).success)
      issues.push({ field: "email", code: "cfdi_invalid_email" });
  } else if (o.requireEmail)
    issues.push({ field: "email", code: "cfdi_email_required" });
  return issues;
}

/** The first blocking issue, or null. */
export function firstReceptorError(
  r: Receptor,
  o: { requireEmail: boolean },
): ReceptorIssue | null {
  return receptorIssues(r, o).find((i) => !i.warning) ?? null;
}

/** Uses allowed for a régimen, in the order offered (G03, G01, S01). */
export function usesFor(regime: string): CfdiUse[] {
  return CFDI_USES.filter((u) => usoCfdiAllowed(regime, u));
}

/** Régimen codes a receptor RFC of this kind may declare (all when the RFC is not typed yet). */
export function regimesFor(rfc: string): string[] {
  const value = rfc.trim().toUpperCase();
  const kind = RFC_PATTERN.test(value) ? rfcKind(value) : null;
  return Object.keys(REGIMEN_FISCAL).filter(
    (code) => !kind || regimeAllowedFor(code, kind),
  );
}

// ---------------------------------------------------------------------------------------------
// RESICO ISR withholding (LISR art. 113-J; LD-16 L9)
// ---------------------------------------------------------------------------------------------

export const RESICO_REGIME = "626";
/** 1.25 % of the concept base. */
export const RESICO_ISR_RATE_BPS = 125;

/**
 * A persona física taxed under RESICO (626) that invoices a persona moral (12-character RFC) must
 * show the 1.25 % ISR retention the company withholds. Only nominative invoices (and their credit
 * notes): globals go to PUBLICO EN GENERAL. The accountant confirms the behaviour before the pilot
 * (user hand-off list).
 */
export function resicoWithholds(
  issuer: { regime: string | null; rfc: string | null },
  receptorRfc: string,
): boolean {
  const rfc = receptorRfc.trim().toUpperCase();
  return (
    issuer.regime === RESICO_REGIME &&
    !!issuer.rfc &&
    rfcKind(issuer.rfc) === "fisica" &&
    RFC_PATTERN.test(rfc) &&
    !(GENERIC_RFCS as readonly string[]).includes(rfc) &&
    rfcKind(rfc) === "moral"
  );
}

// ---------------------------------------------------------------------------------------------
// Global periods (business dates, decision D5)
// ---------------------------------------------------------------------------------------------

export const PERIODICITIES = ["day", "week", "fortnight", "month"] as const;
export type Periodicity = (typeof PERIODICITIES)[number];
export type GlobalPeriod = {
  key: string;
  periodicity: Periodicity;
  /** First and last business date (inclusive), both in one calendar month. */
  from: string;
  to: string;
  /** InformacionGlobal Meses ("01".."12") and Año. */
  months: string;
  year: number;
};
export const PERIOD_KEY =
  /^(D[0-9]{4}-[0-9]{2}-[0-9]{2}|W[0-9]{4}-[0-9]{2}-[0-9]{2}|F[0-9]{4}-[0-9]{2}-[12]|M[0-9]{4}-[0-9]{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function plainDate(date: string): Temporal.PlainDate {
  if (!DATE.test(date)) throw new RangeError("invalid_date");
  return Temporal.PlainDate.from(date);
}

/** The period that contains a business date. Week: Monday–Sunday clipped to the date's month. */
export function globalPeriodFor(date: string, p: Periodicity): GlobalPeriod {
  const d = plainDate(date);
  const monthStart = d.with({ day: 1 });
  const monthEnd = d.with({ day: d.daysInMonth });
  const months = String(d.month).padStart(2, "0");
  const ym = `${d.year}-${months}`;
  let from = d;
  let to = d;
  let key: string;
  if (p === "day") key = `D${d.toString()}`;
  else if (p === "week") {
    const monday = d.subtract({ days: d.dayOfWeek - 1 });
    const sunday = monday.add({ days: 6 });
    from =
      Temporal.PlainDate.compare(monday, monthStart) < 0 ? monthStart : monday;
    to = Temporal.PlainDate.compare(sunday, monthEnd) > 0 ? monthEnd : sunday;
    key = `W${from.toString()}`;
  } else if (p === "fortnight") {
    const first = d.day <= 15;
    from = first ? monthStart : d.with({ day: 16 });
    to = first ? d.with({ day: 15 }) : monthEnd;
    key = `F${ym}-${first ? 1 : 2}`;
  } else if (p === "month") {
    from = monthStart;
    to = monthEnd;
    key = `M${ym}`;
  } else throw new RangeError("invalid_periodicity");
  return {
    key,
    periodicity: p,
    from: from.toString(),
    to: to.toString(),
    months,
    year: d.year,
  };
}

/** The first period starting after `period.to`. */
export function nextPeriod(period: GlobalPeriod, p: Periodicity): GlobalPeriod {
  return globalPeriodFor(plainDate(period.to).add({ days: 1 }).toString(), p);
}

/**
 * Periodicity in force on a business date: a pending change applies from `nextPeriodicityFrom`
 * (always the first day of a month, so a period never mixes periodicities).
 */
export function periodicityOn(
  date: string,
  s: {
    globalPeriodicity: Periodicity;
    nextPeriodicity: Periodicity | null;
    nextPeriodicityFrom: string | null;
  },
): Periodicity {
  return s.nextPeriodicity &&
    s.nextPeriodicityFrom &&
    date >= s.nextPeriodicityFrom
    ? s.nextPeriodicity
    : s.globalPeriodicity;
}

/** The period of a date under the periodicity in force on that date. */
export function periodOn(
  date: string,
  s: Parameters<typeof periodicityOn>[1],
): GlobalPeriod {
  return globalPeriodFor(date, periodicityOn(date, s));
}

/** Instant at which the period closes: the end of the business day of `to` (cutoff, timezone). */
export function periodClosesAt(
  period: Pick<GlobalPeriod, "to">,
  timezone: string,
  cutoff: number,
): string {
  return boundaries(period.to, timezone, cutoff).end;
}

/** First day of the month after a date ("2026-10-17" → "2026-11-01"). */
export function firstOfNextMonth(date: string): string {
  return plainDate(date).with({ day: 1 }).add({ months: 1 }).toString();
}

/**
 * Last instant a customer may self-invoice a ticket under the restaurant's policy alone: the last
 * calendar day of the purchase month (policy "month") or `days` days after the business date
 * (policy "days"), at 23:59:59.999 in the restaurant timezone. The deadline a customer actually
 * has is effectiveSelfInvoiceDeadline's.
 */
export function selfInvoiceDeadline(
  businessDate: string,
  policy: "month" | "days",
  days: number,
  timezone: string,
): string {
  const d = plainDate(businessDate);
  const last =
    policy === "month" ? d.with({ day: d.daysInMonth }) : d.add({ days });
  return last
    .toZonedDateTime({
      timeZone: timezone,
      plainTime: Temporal.PlainTime.from("23:59:59.999"),
    })
    .toInstant()
    .toString();
}

/**
 * What bounds self-invoicing besides the policy (LD-51 F1): with portal_reissue_global off, the
 * portal never cancels a global, so a ticket can be self-invoiced only until its global takes it,
 * which the worker builds at the period's close + CFDI_GLOBAL_GRACE_MINUTES. The cached status
 * carries it so a receipt printed offline shows the same date the portal enforces.
 */
export type SelfInvoiceGlobalBound = {
  globalPeriodicity: Periodicity;
  nextPeriodicity: Periodicity | null;
  nextPeriodicityFrom: string | null;
  /** The restaurant's business-day cutoff (minutes after midnight): a period closes at its end. */
  cutoff: number;
  /** The worker's CFDI_GLOBAL_GRACE_MINUTES (published in cfdi_platform; default 60). */
  graceMinutes: number;
};

/** Default of CFDI_GLOBAL_GRACE_MINUTES (server/cfdi/config.ts), for a worker that published none. */
export const DEFAULT_GLOBAL_GRACE_MINUTES = 60;

/** The instant the global of a ticket's period is built: its close (end of the business day) + grace. */
export function globalBuildAt(
  businessDate: string,
  bound: SelfInvoiceGlobalBound,
  timezone: string,
): string {
  const closesAt = periodClosesAt(
    periodOn(businessDate, bound),
    timezone,
    bound.cutoff,
  );
  return plusMinutes(closesAt, bound.graceMinutes);
}

function plusMinutes(instant: string, minutes: number): string {
  return Temporal.Instant.from(instant).add({ minutes }).toString();
}

/** The global bound of one set of self-invoicing terms: none (reissue on), or the global's build. */
type GlobalArg =
  { closesAt: string; graceMinutes: number } | { globalAt: string } | null;

function termsDeadline(
  businessDate: string,
  w: {
    policy: "month" | "days";
    days: number;
    timezone: string;
    global?: GlobalArg;
  },
): { deadline: string; bound: "policy" | "global" } {
  const policy = selfInvoiceDeadline(
    businessDate,
    w.policy,
    w.days,
    w.timezone,
  );
  if (!w.global) return { deadline: policy, bound: "policy" };
  const globalAt =
    "globalAt" in w.global
      ? w.global.globalAt
      : plusMinutes(w.global.closesAt, w.global.graceMinutes);
  return Date.parse(globalAt) < Date.parse(policy)
    ? { deadline: Temporal.Instant.from(globalAt).toString(), bound: "global" }
    : { deadline: policy, bound: "policy" };
}

/**
 * The self-invoicing deadline a customer has (LD-51 F1): the policy deadline, or, when the global
 * bound applies, the earlier of it and the moment the ticket's global is built (`globalAt`, or the
 * period's close `closesAt` + `graceMinutes` when the caller read the period row). `bound` says
 * which one ended it.
 *
 * `pending` is a self-invoicing change that would bring forward a deadline a receipt already
 * printed, so it waits (CFDIFIX-FISCAL-5 / UX-4, guarded like a periodicity change): the terms in
 * force apply until `fromAt` (the start of the business day it applies from, chosen after every
 * such printed deadline), the new ones after it. A customer may self-invoice while either allows
 * it, so the deadline is the later of the new terms' and the current terms' cut at `fromAt`; a
 * receipt printed while the change waits prints exactly that, and nothing printed before the save
 * ends earlier than it said.
 */
export function effectiveSelfInvoiceDeadline(
  businessDate: string,
  w: {
    policy: "month" | "days";
    days: number;
    timezone: string;
    /** Null or absent: no global bound (reissue on, or a status cached before cfdifix). */
    global?: GlobalArg;
    pending?: {
      policy: "month" | "days";
      days: number;
      global?: GlobalArg;
      /** The instant the pending terms apply from. */
      fromAt: string;
    } | null;
  },
): { deadline: string; bound: "policy" | "global" } {
  const current = termsDeadline(businessDate, w);
  if (!w.pending) return current;
  const cut =
    Date.parse(current.deadline) <= Date.parse(w.pending.fromAt)
      ? current
      : {
          deadline: Temporal.Instant.from(w.pending.fromAt).toString(),
          bound: "policy" as const,
        };
  const next = termsDeadline(businessDate, {
    policy: w.pending.policy,
    days: w.pending.days,
    timezone: w.timezone,
    global: w.pending.global,
  });
  return Date.parse(next.deadline) >= Date.parse(cut.deadline) ? next : cut;
}

/**
 * The receipt, the portal and the staff view print the deadline's time too whenever it is not the
 * policy's end of day (23:59:59.999 local): a global-bound deadline (the period's close + the
 * worker's grace, early in the morning after the period's last business date, LD-55
 * CFDIFIX-FISCAL-1 / UX-1) or a pending change's start; and on the purchase's business date or the
 * next calendar day (LD-51 F1). A date alone reads as the whole day.
 */
export function deadlineShowsTime(
  deadline: string,
  businessDate: string,
  timezone: string,
): boolean {
  const local = Temporal.Instant.from(deadline).toZonedDateTimeISO(timezone);
  const endOfDay =
    local.hour === 23 &&
    local.minute === 59 &&
    local.second === 59 &&
    local.millisecond === 999;
  if (!endOfDay) return true;
  return (
    Temporal.PlainDate.compare(
      local.toPlainDate(),
      plainDate(businessDate).add({ days: 1 }),
    ) <= 0
  );
}

/**
 * How long a signed-in terminal may print from its cached CFDI status (src/features/cfdi/status.ts
 * refreshes it this often while online). A periodicity change that applied at once and brings a
 * deadline forward is rebuilt only after this plus a margin, so the tick's re-check sees every
 * ticket a terminal printed with the old status (CFDIFIX-CONCURRENCY-2).
 */
export const STATUS_REFRESH_MS = 5 * 60_000;
export const PERIODICITY_REBUILD_WAIT_MS = STATUS_REFRESH_MS + 2 * 60_000;

/**
 * Self-invoicing terms (policy, its days, whether the portal reissues globals), and a change that
 * waits for `from` (a business date) because it would bring forward a printed deadline
 * (CFDIFIX-FISCAL-5 / UX-4).
 */
export type SelfInvoiceTerms = {
  policy: "month" | "days";
  days: number;
  reissue: boolean;
};
export type PendingSelfInvoice = SelfInvoiceTerms & { from: string };

/**
 * The business date a pending self-invoicing change may apply from: the first business day that
 * starts at or after `deadline`, the latest deadline it would otherwise bring forward.
 */
export function selfInvoiceChangeFrom(
  deadline: string,
  timezone: string,
  cutoff: number,
): string {
  const before = Temporal.Instant.from(deadline)
    .subtract({ milliseconds: 1 })
    .toZonedDateTimeISO(timezone);
  const minutes = before.hour * 60 + before.minute;
  const day =
    minutes < cutoff
      ? before.toPlainDate().subtract({ days: 1 })
      : before.toPlainDate();
  return day.add({ days: 1 }).toString();
}

/** The instant a business date starts (its cutoff, in the restaurant timezone). */
export function businessDayStart(
  date: string,
  timezone: string,
  cutoff: number,
): string {
  return boundaries(date, timezone, cutoff).start;
}

/**
 * Why a periodicity change must wait for the first of next month (LD-51 F2), or null when it may
 * apply at once:
 *   "globals"   the month has a global document of one of its periods (stamped, claiming or
 *               failed: the register and the sweeps read documents by period key);
 *   "overdue"   an unclaimed ticket of the month would sit in a period, old or new, whose 24-hour
 *               deadline (RMF 2.7.1.21) already passed: re-partitioning the month never turns an
 *               on-time global into a late one nor hides one that is late;
 *   "deadline"  the change would give an unclaimed ticket of the month an earlier
 *               self-invoicing deadline than it has (CFDIFIX-1): its receipt already printed the
 *               deadline under the old periodicity (effectiveSelfInvoiceDeadline: the earlier of
 *               the policy and the global's build), and the portal must never refuse a customer
 *               before that date. A change that keeps or lengthens every deadline applies at once.
 *               The check does not depend on the self-invoicing or reissue switches: a receipt
 *               printed while they were on keeps its date when they are turned back on.
 * `dates` are the business dates of the month's unclaimed eligible tickets on or after the mode's
 * start; `selfInvoice` the policy in force after the change and the worker's grace.
 */
export type PeriodicityChangeBlock = "globals" | "overdue" | "deadline";
export function periodicityChangeBlock(i: {
  hasGlobals: boolean;
  dates: readonly string[];
  from: Periodicity;
  to: Periodicity;
  timezone: string;
  cutoff: number;
  selfInvoice: {
    policy: "month" | "days";
    days: number;
    graceMinutes: number;
  };
  now: Date;
}): PeriodicityChangeBlock | null {
  if (i.hasGlobals) return "globals";
  const closesAt = (date: string, p: Periodicity) =>
    periodClosesAt(globalPeriodFor(date, p), i.timezone, i.cutoff);
  const overdue = i.dates.some((date) =>
    [i.from, i.to].some(
      (p) =>
        Date.parse(plusMinutes(closesAt(date, p), 24 * 60)) <= i.now.getTime(),
    ),
  );
  if (overdue) return "overdue";
  const deadline = (date: string, p: Periodicity) =>
    Date.parse(
      effectiveSelfInvoiceDeadline(date, {
        policy: i.selfInvoice.policy,
        days: i.selfInvoice.days,
        timezone: i.timezone,
        global: {
          closesAt: closesAt(date, p),
          graceMinutes: i.selfInvoice.graceMinutes,
        },
      }).deadline,
    );
  if (i.dates.some((date) => deadline(date, i.to) < deadline(date, i.from)))
    return "deadline";
  return null;
}

/** Whether a periodicity change may apply at once (periodicityChangeBlock answers null). */
export function periodicityChangeNow(
  i: Parameters<typeof periodicityChangeBlock>[0],
): boolean {
  return periodicityChangeBlock(i) === null;
}

/**
 * CFF art. 29-A (CFDI-SAT-3): a CFDI can be canceled only until the month in which the annual
 * return of the year it was issued is due: March for a persona moral (12-character RFC), April for
 * a persona física (13 characters), of the next year. Returns the first instant AFTER that month
 * in the restaurant's timezone (local midnight of April 1 or May 1); an unknown issuer RFC takes
 * the earlier, March deadline.
 */
export function cancellationDeadline(
  stampedAt: string,
  issuerRfc: string | null,
  timezone: string,
): string {
  const year =
    Temporal.Instant.from(stampedAt).toZonedDateTimeISO(timezone).year;
  const month = issuerRfc?.trim().length === 13 ? 5 : 4;
  return Temporal.PlainDate.from({ year: year + 1, month, day: 1 })
    .toZonedDateTime({ timeZone: timezone })
    .toInstant()
    .toString();
}
/** Whether a CFDI stamped at `stampedAt` may still be canceled at `now` (CFF art. 29-A). */
export function cancellationAllowed(
  stampedAt: string | null,
  issuerRfc: string | null,
  timezone: string,
  now: Date = new Date(),
): boolean {
  return (
    !stampedAt ||
    now.getTime() <
      Date.parse(cancellationDeadline(stampedAt, issuerRfc, timezone))
  );
}

/**
 * Failures the customer (or a cashier) fixes by correcting the receptor data (CFDI-UX-2): the
 * receptor checks and SAT's receptor refusals, or a provider error on a customer field. Every other
 * failure is the restaurant's (certificate, organization, provider) and the portal says so.
 */
export const RECEPTOR_FIXABLE_PREFIXES = ["cfdi_receptor_", "cfdi_invalid_"];
export const RECEPTOR_FIXABLE_CODES = [
  "cfdi_regime_mismatch",
  "cfdi_use_not_allowed",
  "cfdi_generic_rfc",
  "cfdi_email_required",
];
export function receptorFixable(
  error: { code: string; path?: string | null } | null,
): boolean {
  if (!error) return false;
  return (
    RECEPTOR_FIXABLE_PREFIXES.some((p) => error.code.startsWith(p)) ||
    RECEPTOR_FIXABLE_CODES.includes(error.code) ||
    !!error.path?.startsWith("customer.") ||
    error.path === "use"
  );
}

/** Aliases of fiscal's self-invoice code helpers (12 Crockford characters, printed 4-4-4). */
export const normalizeTicketCode = normalizeSelfInvoiceCode;
export const formatTicketCode = groupSelfInvoiceCode;

/** Masks for the public portal: first 3 and last 3 RFC characters; first letter and domain of an email. */
export function maskRfc(rfc: string): string {
  return rfc.length <= 6
    ? "*".repeat(rfc.length)
    : rfc.slice(0, 3) + "*".repeat(rfc.length - 6) + rfc.slice(-3);
}
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return email[0] + "***" + email.slice(at);
}

// ---------------------------------------------------------------------------------------------
// Inputs (strict)
// ---------------------------------------------------------------------------------------------

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const isoDate = z.string().regex(DATE);

export const cfdiSettingsInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(1),
    enabled: z.boolean(),
    globalPeriodicity: z.enum(PERIODICITIES),
    globalAuto: z.boolean(),
    conceptMode: z.enum(["grouped", "itemized"]),
    conceptDescription: z.string().trim().min(1).max(200),
    cardPaymentForm: z.enum(CARD_PAYMENT_FORMS),
    defaultUse: z.enum(CFDI_USES),
    selfInvoiceEnabled: z.boolean(),
    selfInvoicePolicy: z.enum(["month", "days"]),
    selfInvoiceDays: z.number().int().min(1).max(90),
    portalReissueGlobal: z.boolean(),
    supportEmail: email.nullable(),
  })
  .strict();
export type CfdiSettingsInput = z.infer<typeof cfdiSettingsInput>;
/**
 * Activation asks for the global periodicity (LD-51 F2), so a restaurant never starts on a default
 * it then cannot change for the month; RESICO (626) is coerced to monthly as every save is (D4,
 * SAT-4). Optional for older clients: monthly (D4).
 */
export const activateInput = z
  .object({
    operationId: id,
    expectedVersion: z.literal(0),
    globalPeriodicity: z.enum(PERIODICITIES).default("month"),
  })
  .strict();
export const operationInput = z.object({ operationId: id }).strict();
export const invoiceRequestInput = z
  .object({
    operationId: id,
    ticketId: id,
    receptor: receptorInput,
    cardForm: z.enum(CARD_PAYMENT_FORMS).nullable().default(null),
    confirmPreStart: z.boolean().default(false),
    reissueGlobal: z.boolean().default(false),
  })
  .strict();
export const portalInvoiceInput = z
  .object({
    operationId: id,
    receptor: receptorInput,
    cardForm: z.enum(["04", "28", "unknown"]).nullable().default(null),
    privacyAccepted: z.literal(true),
    locale: z.enum(["es", "en"]).default("es"),
  })
  .strict();
export const portalAccessInput = z
  .object({ rfc: z.string().trim().toUpperCase().max(13) })
  .strict();
/**
 * Motive 01 is only the re-request of a substitution's cancellation: the document must have a
 * valid substitute still waiting for its ticket (CFDI-R3-1), which is sent as the substitution.
 */
export const cancelInput = z
  .object({
    operationId: id,
    motive: z.enum(["01", "02", "03"]),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
export const substituteInput = z
  .object({
    operationId: id,
    receptor: receptorInput,
    cardForm: z.enum(CARD_PAYMENT_FORMS).nullable().default(null),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
/**
 * Correcting a credit note (CFDI-SAT-2): a substitute credit note related 04 to it (and 01 to the
 * same parent) with the FormaPago the manager chooses; the old one is then canceled with 01.
 */
export const egresoSubstituteInput = z
  .object({
    operationId: id,
    paymentForm: z.enum(["01", ...CARD_PAYMENT_FORMS]),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
export const liveInput = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().min(1),
    liveFrom: isoDate,
  })
  .strict();
export const emailRequestInput = z
  .object({ operationId: id, email: email.nullable() })
  .strict();
export const csdUploadInput = z
  .object({
    operationId: id,
    cer: z
      .string()
      .min(4)
      .max(16384)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    key: z
      .string()
      .min(4)
      .max(16384)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    password: z.string().min(1).max(256),
  })
  .strict();
export const globalsRunInput = z
  .object({
    operationId: id,
    periodKey: z.string().regex(PERIOD_KEY).nullable(),
  })
  .strict();
export const DOCUMENT_STATUS_FILTERS = [
  "open",
  "valid",
  "failed",
  "canceled",
] as const;
export const documentsQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    kind: z.enum(["invoice", "global", "egreso"]).optional(),
    status: z.enum(DOCUMENT_STATUS_FILTERS).optional(),
    q: z.string().trim().max(60).optional(),
    /** Keyset cursor "<created_at ISO, microseconds>|<id>" from the previous page's `next`. */
    after: z
      .string()
      .max(120)
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export const globalsQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    mode: z.enum(["test", "live"]).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Views (JSON on the wire)
// ---------------------------------------------------------------------------------------------

export type CfdiMode = "test" | "live";
export type CfdiProvider = "disabled" | "sandbox_shared" | "organizations";
export type CfdiStatusView = {
  available: boolean;
  provider: CfdiProvider;
  enabled: boolean;
  mode: CfdiMode | null;
  ready: boolean;
  /** Role owner/manager/cashier, CFDI enabled and the organization ready. */
  canInvoice: boolean;
  selfInvoice: {
    enabled: boolean;
    policy: "month" | "days";
    days: number;
    /**
     * The global bound of the deadline (LD-51 F1); null when the portal reissues globals. Absent in
     * a status cached before cfdifix: the receipt then prints the policy date alone.
     */
    globalBound?: SelfInvoiceGlobalBound | null;
    /**
     * A self-invoicing change that waits because it would bring forward a printed deadline
     * (CFDIFIX-FISCAL-5 / UX-4): its terms and the instant they apply from. The receipt prints the
     * deadline effectiveSelfInvoiceDeadline gives with it. Absent in an older cached status.
     */
    pending?: {
      policy: "month" | "days";
      days: number;
      globalBound: SelfInvoiceGlobalBound | null;
      fromAt: string;
    } | null;
  } | null;
  timezone: string;
  version: number;
};
export type CfdiOrganizationView = {
  source: "own" | "shared_sandbox";
  status: "provisioning" | "ready" | "error";
  /** The organization exists at Facturapi (it has an id): a CSD can be uploaded to it. */
  provisioned: boolean;
  errorCode: string | null;
  /** The issuer RFC as Facturapi reports it; null ("pendiente") until it does (LD-51 F9). */
  taxId: string | null;
  /**
   * Shared sandbox (LD-51 F3): the platform's test organization, which stamps every test CFDI in
   * this mode, as Facturapi reports it; the restaurant's fiscal profile is not used to stamp.
   */
  sharedIssuer: {
    legalName: string | null;
    taxId: string | null;
    regime: string | null;
    postalCode: string | null;
    /**
     * Facturapi reported the RFC, régimen and postal code: stamping uses them as a whole. False:
     * stamping uses the restaurant's fiscal profile until it does (never a mix of two taxpayers,
     * CFDIFIX-FISCAL-6 / UX-6).
     */
    complete: boolean;
  } | null;
  legalSyncedVersion: number | null;
  fiscalProfileVersion: number;
  csd: {
    status: "missing" | "processing" | "valid" | "expired" | "error";
    serial: string | null;
    validUntil: string | null;
    lastUpload: {
      id: string;
      status: string;
      errorCode: string | null;
      createdAt: string;
    } | null;
  };
  productionReady: boolean;
  pendingSteps: { type: string; description: string }[];
  checkedAt: string | null;
  lastEvent: {
    kind: string;
    at: string;
    detail: Record<string, unknown>;
  } | null;
};
export type CfdiAttention = {
  overdueGlobals: number;
  failedDocuments: number;
  stuckDocuments: number;
  rejectedSubstitutions: number;
  csdExpiresSoon: boolean;
};
export type CfdiSettingsView = CfdiStatusView & {
  /** Owner. */
  canEdit: boolean;
  /** The worker's CFDI_GLOBAL_GRACE_MINUTES: the settings explain the self-invoicing bound. */
  globalGraceMinutes: number;
  /**
   * The restaurant's business date on the server (timezone and cutoff): which month a change
   * reshapes and which periodicity is in force (CFDIFIX-6).
   */
  businessDate: string;
  prerequisites: {
    platform: boolean;
    fiscalComplete: boolean;
    currency: boolean;
    legalNameLength: boolean;
    regime: string | null;
  };
  settings: null | {
    enabled: boolean;
    mode: CfdiMode;
    testFrom: string;
    liveFrom: string | null;
    liveRequested: { at: string; from: string } | null;
    globalPeriodicity: Periodicity;
    nextPeriodicity: Periodicity | null;
    nextPeriodicityFrom: string | null;
    globalAuto: boolean;
    conceptMode: "grouped" | "itemized";
    conceptDescription: string;
    cardPaymentForm: CardForm;
    defaultUse: CfdiUse;
    selfInvoiceEnabled: boolean;
    selfInvoicePolicy: "month" | "days";
    selfInvoiceDays: number;
    portalReissueGlobal: boolean;
    /**
     * A self-invoicing change (window or portal reissue) that waits until `from` because it would
     * bring forward the deadline of receipts already printed (CFDIFIX-FISCAL-5 / UX-4); the fields
     * above are the terms in force on the server's business date.
     */
    selfInvoicePending: PendingSelfInvoice | null;
    supportEmail: string | null;
    version: number;
    updatedAt: string;
    updatedByName: string | null;
    resicoMonthly: boolean;
    /**
     * Why the pending change did not apply at once (CFDIFIX-5), while it is still the pending one:
     * refused by the save, or deferred by the tick when the month got shaped before it rebuilt it.
     */
    periodicityDeferred: {
      at: string;
      from: Periodicity;
      to: Periodicity;
      nextFrom: string;
      reason: PeriodicityChangeBlock;
      source: "save" | "tick";
    } | null;
  };
  organization: CfdiOrganizationView | null;
  live: {
    platformEnabled: boolean;
    canRequest: boolean;
    defaultFrom: string;
    minFrom: string;
    maxFrom: string;
    failure: string | null;
  };
  attention: CfdiAttention;
};
export type CfdiDocumentKind = "invoice" | "global" | "egreso";
export type CfdiDocumentSummary = {
  id: string;
  kind: CfdiDocumentKind;
  source: string;
  mode: CfdiMode;
  status: string;
  createdAt: string;
  series: string | null;
  folioNumber: number | null;
  uuid: string | null;
  stampedAt: string | null;
  receptorName: string | null;
  receptorRfc: string | null;
  total: number | null;
  expectedTotal: number | null;
  ticketFolios: string[];
  ticketCount: number;
  periodKey: string | null;
  part: number | null;
  stuck: boolean;
  late: boolean;
};
export type CfdiDocumentFile = "xml" | "pdf" | "cancel_xml" | "cancel_pdf";
export type CfdiDocumentView = CfdiDocumentSummary & {
  receptor: Receptor | null;
  paymentForm: string | null;
  use: string | null;
  verificationUrl: string | null;
  global: {
    periodicity: Periodicity;
    months: string;
    year: number;
    from: string;
    to: string;
  } | null;
  expectedTax: number | null;
  tax: number | null;
  withheld: number | null;
  amountCheck: "exact" | "differs" | null;
  parentDocumentId: string | null;
  refundId: string | null;
  replacesDocumentId: string | null;
  replacedByDocumentId: string | null;
  /** Ids of egresos whose parent is this document. */
  creditNotes: string[];
  cancellation: {
    motive: string;
    status: string;
    reason: string;
    requestedAt: string;
    processedAt: string | null;
    substituteDocumentId: string | null;
    errorCode: string | null;
  } | null;
  error: { code: string; message: string | null; path: string | null } | null;
  emailedAt: string | null;
  emailError: string | null;
  files: CfdiDocumentFile[];
  events: { kind: string; at: string; detail: Record<string, unknown> }[];
  createdByName: string | null;
  /**
   * A valid substitute of this document still waiting for its ticket while no cancellation of
   * this document is open (rejected, expired or refused): two valid CFDIs for one sale.
   */
  waitingSubstituteId: string | null;
  canCancel: boolean;
  /** Not while a substitute is still unfinished (cfdi_substitution_pending). */
  canSubstitute: boolean;
  /** A ticket of this document predates CFDI's start in its mode: no global ever covers it. */
  preStart: boolean;
  /** CFF art. 29-A: the first instant it can no longer be canceled (null before it is stamped). */
  cancelDeadline: string | null;
  /**
   * Cancelar/Sustituir would otherwise be offered to this viewer, but a credit note relates to this
   * document: SAT refuses the cancellation and credit notes are never canceled on their own
   * (LD-33 MONEY-1), so the register says why the actions are missing (CFDI-INT-1).
   */
  creditNotesBlock: boolean;
  /** Request this document's cancellation again with motive 01 and the waiting substitute. */
  canRequestAgain: boolean;
  canRetry: boolean;
  canEmail: boolean;
};
export type TicketEligibility =
  | "available"
  | "invoiced"
  | "invoicing"
  | "in_global"
  | "global_in_progress"
  | "before_start"
  | "expired"
  | "fully_refunded"
  | "disabled"
  | "not_ready";
export type CfdiTicketView = {
  ticketId: string;
  orderId: string;
  folio: string;
  issuedAt: string;
  businessDate: string;
  currency: "MXN";
  originalTotal: number;
  refunded: number;
  total: number;
  tradeName: string;
  issuerLegalName: string | null;
  issuerRfc: string | null;
  mode: CfdiMode;
  eligibility: TicketEligibility;
  /** The self-invoicing deadline (null when self-invoicing is off). */
  deadline: string | null;
  /**
   * What ends it (LD-51 F1): the restaurant's policy, or the ticket's global (built at its period's
   * close + grace while the portal does not reissue globals). Null without a deadline.
   */
  deadlineBound: "policy" | "global" | null;
  needsCardForm: boolean;
  /** The restaurant's card payment form (settings): the card question's initial answer (§2.5). */
  cardPaymentForm: CardForm;
  defaultUse: CfdiUse;
  covering: {
    documentId: string;
    kind: "invoice" | "global";
    status: string;
    label: string;
    periodKey: string | null;
    /** The viewer may open and download it (managers; a cashier: own documents of the last 24 h). */
    canOpen: boolean;
  } | null;
  /** Staff: manager/owner; portal: settings.portalReissueGlobal. */
  reissueAllowed: boolean;
  /**
   * In a valid global: replace it (cancel 04), or credit it (Guía global Apéndice 2 III) when SAT
   * would refuse that cancellation (server globalRoute).
   */
  reissueRoute: "cancel" | "credit_note" | null;
  /**
   * Why the route is a credit note: the global's CFF 29-A deadline passed (SAT-3), or a credit
   * note relates to the global (CFDI-INT-1). Null for "cancel" or outside a global.
   */
  reissueReason: "deadline" | "credit_notes" | null;
  /** Staff view only (a cashier: own documents of the last 24 h, spec §2.13); [] in the portal. */
  documents: CfdiDocumentSummary[];
};
export type GlobalPeriodStatus =
  "open" | "due" | "built" | "empty" | "overdue" | "failed";
export type GlobalPeriodView = {
  mode: CfdiMode;
  periodKey: string;
  periodicity: Periodicity;
  from: string;
  to: string;
  closesAt: string;
  dueAt: string;
  status: GlobalPeriodStatus;
  /** Tickets in the period's documents plus its unclaimed ones (LD-51 F11). */
  ticketCount: number;
  total: number;
  tax: number;
  /** Eligible tickets of the period in no CFDI yet ("Por emitir"), counted in ticketCount. */
  unclaimedTickets: number;
  lateTickets: number;
  documents: {
    id: string;
    part: number;
    status: string;
    uuid: string | null;
    /** Created after dueAt. */
    late: boolean;
  }[];
  canRun: boolean;
};
export type PortalDocumentStatus = {
  status: "queued" | "stamping" | "pending" | "valid" | "failed" | "canceled";
  series: string | null;
  folioNumber: number | null;
  uuid: string | null;
  stampedAt: string | null;
  emailMasked: string | null;
  rfcMasked: string;
  error: { code: string; message: string | null; path: string | null } | null;
  /** Set when valid. */
  downloadToken: string | null;
  /** The PDF and XML are stored (cfdi_deliver ran): downloads work (CFDI-UX-4). */
  filesReady: boolean;
};
export type PortalTicketView = Omit<
  CfdiTicketView,
  "documents" | "covering" | "orderId"
> & {
  supportEmail: string | null;
  privacyUrl: string | null;
  allowedUses: CfdiUse[];
  sandbox: boolean;
  /** The restaurant's timezone, for the deadline date. */
  timezone: string;
  /** Only status, masked; full data requires RFC access. */
  latest: PortalDocumentStatus | null;
};
/** cfdiAlerts(tx) result: CfdiSettingsView["attention"] plus the mode. */
export type CfdiAlertsView = CfdiAttention & { mode: CfdiMode | null };
/** cfdiCoverage(tx, range) result; reports' DayCorteDocument.extra.cfdi. */
export type CfdiCoverage = {
  mode: CfdiMode;
  tickets: number;
  invoiced: number;
  globalized: number;
  uncovered: number;
  invoicedTotal: number;
  globalTotal: number;
};

/** "F-123" for a stamped document; null before Facturapi assigns a folio. */
export function docLabel(
  series: string | null,
  folio: number | null,
): string | null {
  return series && folio ? `${series}-${folio}` : null;
}
