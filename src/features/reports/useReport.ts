import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "../../../shared/domain";
import { translateError } from "../../i18n";

export type ReportState<T> = {
  data: T | null;
  loading: boolean;
  error: { code: string; text: string } | null;
  reload: () => void;
};

/**
 * One report fetch per tab: the latest request wins (an older answer never replaces a newer
 * one), the last good data stays visible while a refresh fails, and nothing is fetched offline.
 */
export function useReport<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
  { online, locale }: { online: boolean; locale: Locale },
): ReportState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ReportState<T>["error"]>(null);
  const latest = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const run = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetcherRef.current();
      if (request === latest.current) setData(next);
    } catch (e) {
      const code = (e as Error).message;
      if (request === latest.current)
        setError({ code, text: translateError(code, locale) });
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [locale]);
  useEffect(() => {
    if (online) void run();
    // The caller's deps select what to fetch.
  }, [online, run, ...deps]);
  return { data, loading, error, reload: () => void run() };
}
