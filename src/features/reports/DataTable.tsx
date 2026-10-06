import type { ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { Locale } from "../../../shared/domain";
import { strings } from "../../i18n";
import { fill } from "./format";

export type Column<T> = {
  key: string;
  header: string;
  /** Right-aligned, never wrapped (amounts and counts). */
  numeric?: boolean;
  render: (row: T) => ReactNode;
  /** Present on sortable columns. */
  sortValue?: (row: T) => number | string;
};
export type SortState = { key: string; dir: "asc" | "desc" } | null;

/**
 * A report table: a caption for screen readers, sortable headers (`aria-sort`, a button each)
 * and right-aligned numbers. It scrolls horizontally inside .report-table-wrap, so the page never
 * scrolls sideways (UX-11).
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  totals,
  sort = null,
  onSort,
  empty,
  locale,
}: {
  caption: string;
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  totals?: ReactNode[];
  sort?: SortState;
  onSort?: (s: SortState) => void;
  empty?: string;
  locale: Locale;
}) {
  const t = strings[locale];
  const sorted = (() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return rows;
    const value = column.sortValue;
    return [...rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const order =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), locale);
      return sort.dir === "asc" ? order : -order;
    });
  })();
  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={c.numeric ? "num" : undefined}
                  aria-sort={
                    c.sortValue
                      ? active
                        ? sort!.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                      : undefined
                  }
                >
                  {c.sortValue && onSort ? (
                    <button
                      type="button"
                      className="report-sort"
                      aria-label={fill(t.reportsSortBy, { column: c.header })}
                      onClick={() =>
                        onSort({
                          key: c.key,
                          dir: active && sort!.dir === "desc" ? "asc" : "desc",
                        })
                      }
                    >
                      {c.header}
                      {active &&
                        (sort!.dir === "asc" ? (
                          <ArrowUp size={14} aria-hidden="true" />
                        ) : (
                          <ArrowDown size={14} aria-hidden="true" />
                        ))}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && empty ? (
            <tr>
              <td colSpan={columns.length} className="muted">
                {empty}
              </td>
            </tr>
          ) : (
            sorted.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.numeric ? "num" : undefined}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {totals && (
          <tfoot>
            <tr>
              {totals.map((cell, i) => (
                <th
                  key={i}
                  scope={i === 0 ? "row" : undefined}
                  className={columns[i]?.numeric ? "num" : undefined}
                >
                  {cell}
                </th>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
