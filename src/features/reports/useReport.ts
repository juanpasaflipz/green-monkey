import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Locale } from "../../../shared/domain";
import type { Page } from "../../../shared/reports";
import { errorNotice } from "../../i18n";

export type ReportState<T> = {
  data: T | null;
  loading: boolean;
  error: { code: string; text: string } | null;
  reload: () => void;
};

/**
 * The page header's Actualizar (Operations' refreshKey): every report under the provider fetches
 * again when it changes, keeping its figures on screen meanwhile (review REPORTS-UI-10).
 */
export const ReportRefresh = createContext(0);

/** The fetch key of a report's deps: data belongs to the deps it was fetched for. */
export const reportKey = (deps: readonly unknown[]) => JSON.stringify(deps);

/**
 * Data is shown only for the deps it was fetched for (review REPORTS-UI-1): after a range or
 * filter change the previous figures disappear while the new ones load, after a failed load and
 * offline, so a CSV, a sheet or a tile can never pair the new range with the old figures.
 */
export function dataFor<T>(
  stored: { key: string; data: T } | null,
  key: string,
): T | null {
  return stored && stored.key === key ? stored.data : null;
}

/**
 * One report fetch per tab: the latest request wins (an older answer never replaces a newer
 * one), a refresh of the same deps keeps the last good data visible while it loads or if it
 * fails, data fetched for other deps is never returned, and nothing is fetched offline.
 */
export function useReport<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
  { online, locale }: { online: boolean; locale: Locale },
): ReportState<T> {
  const refreshKey = useContext(ReportRefresh);
  const key = reportKey(deps);
  const [stored, setStored] = useState<{ key: string; data: T } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ReportState<T>["error"]>(null);
  const latest = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(key);
  keyRef.current = key;
  const run = useCallback(async () => {
    const request = ++latest.current;
    const requestKey = keyRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetcherRef.current();
      if (request === latest.current)
        setStored({ key: requestKey, data: next });
    } catch (e) {
      const code = (e as Error).message;
      if (request === latest.current)
        setError({ code, text: errorNotice(e, locale) });
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [locale]);
  useEffect(() => {
    if (online) void run();
    // The caller's deps select what to fetch; the refresh key fetches the same again.
  }, [online, run, key, refreshKey]);
  return {
    data: dataFor(stored, key),
    loading,
    error,
    reload: () => void run(),
  };
}

/**
 * A paged list (Pagos, Excepciones, Bitácora): the first page through useReport and the pages
 * that "Cargar más" appended to that same first page. A filter or range change (new deps), a
 * refresh or a failed first load resets the list to the new first page only, and a page still
 * in flight when that happens is dropped (review REPORTS-UI-7).
 */
export function usePagedReport<P extends Page<R>, R>(
  fetchPage: (cursor?: string) => Promise<P>,
  deps: readonly unknown[],
  opts: { online: boolean; locale: Locale },
) {
  const first = useReport(() => fetchPage(), deps, opts);
  const [extra, setExtra] = useState<{
    base: P;
    rows: R[];
    next: string | null;
  } | null>(null);
  const [more, setMore] = useState(false);
  const firstRef = useRef(first.data);
  firstRef.current = first.data;
  const own = extra && first.data && extra.base === first.data ? extra : null;
  const rows: R[] = first.data
    ? [...first.data.rows, ...(own?.rows ?? [])]
    : [];
  const next = own ? own.next : (first.data?.next ?? null);
  /** Appends the next page; throws its error for the caller's notice. */
  async function loadMore() {
    const base = first.data;
    if (!base || !next) return;
    setMore(true);
    try {
      const page = await fetchPage(next);
      // The list moved on (new filters, a refresh) while this page loaded: drop it.
      if (firstRef.current !== base) return;
      setExtra((e) => ({
        base,
        rows: [...(e && e.base === base ? e.rows : []), ...page.rows],
        next: page.next,
      }));
    } finally {
      setMore(false);
    }
  }
  return { ...first, rows, next, more, loadMore };
}
