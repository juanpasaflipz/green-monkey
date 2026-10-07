import { useEffect, useState } from "react";
import type { Locale } from "../../../shared/domain";
import {
  currentBusinessDate,
  parseRange,
  quickRange,
  QUICK_RANGES,
  type BusinessDaySettings,
  type DateRange,
  type QuickRange,
} from "../../../shared/reports";
import { strings, errorNotice, type Key } from "../../i18n";
import { Button, Field } from "../../components/ui";
import { cutoffLabel, fill } from "./format";

const QUICK_KEYS: Record<QuickRange, Key> = {
  today: "reportsRangeToday",
  yesterday: "reportsRangeYesterday",
  this_week: "reportsRangeThisWeek",
  last_week: "reportsRangeLastWeek",
  this_month: "reportsRangeThisMonth",
  last_month: "reportsRangeLastMonth",
};

/**
 * The business-date range of Finanzas: quick chips relative to the current business date (weeks
 * start Monday) in a labelled group, so the "Hoy" chip never collides with the rail's "Hoy", and
 * Desde/Hasta with Mostrar, validated with the same parseRange the server uses.
 */
export function RangePicker({
  value,
  onChange,
  maxDays,
  settings,
  locale,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  maxDays: number;
  settings: BusinessDaySettings;
  locale: Locale;
}) {
  const t = strings[locale];
  const today = currentBusinessDate(settings);
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const [error, setError] = useState("");
  useEffect(() => {
    setFrom(value.from);
    setTo(value.to);
  }, [value.from, value.to]);
  return (
    <div className="report-range">
      <div
        className="report-chips"
        role="group"
        aria-label={t.reportsRangeGroup}
      >
        {QUICK_RANGES.map((kind) => {
          const range = quickRange(kind, today);
          const pressed = range.from === value.from && range.to === value.to;
          return (
            <button
              key={kind}
              type="button"
              className={"report-chip" + (pressed ? " selected" : "")}
              aria-pressed={pressed}
              onClick={() => {
                setError("");
                onChange(range);
              }}
            >
              {t[QUICK_KEYS[kind]]}
            </button>
          );
        })}
      </div>
      <form
        className="report-range-custom"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const range = parseRange({ from, to }, maxDays);
            setError("");
            onChange(range);
          } catch (err) {
            setError(errorNotice(err, locale));
          }
        }}
      >
        <Field label={t.reportsFrom}>
          <input
            type="date"
            value={from}
            max={today}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label={t.reportsTo}>
          <input
            type="date"
            value={to}
            max={today}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <Button type="submit">{t.reportsShow}</Button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="muted tiny">
        {fill(t.reportsBusinessDayHint, {
          time: cutoffLabel(settings.cutoff),
          zone: settings.timezone,
        })}
      </p>
    </div>
  );
}
