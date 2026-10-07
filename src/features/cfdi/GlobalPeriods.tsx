/**
 * "Facturas globales" (spec §2.10): the periods of the current mode with their status, tickets,
 * totals, parts and late tickets, and **Emitir ahora** on due, overdue or failed periods (and on
 * any closed period while automatic emission is off). The server decides `canRun`. Tickets and
 * totals include the period's tickets in no CFDI yet, shown as "N por emitir" (LD-51 F11): an open
 * period counts what its global will take.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import type { GlobalPeriodView } from "../../../shared/cfdi";
import { api } from "../../api";
import { strings, errorNotice, type Key } from "../../i18n";
import { Badge, Button, Empty } from "../../components/ui";
import { DocumentDetail } from "./CfdiDocuments";
import {
  dateTimeLabel,
  moneyLabel,
  periodLabel,
  shiftDate,
  t as tr,
  todayFor,
} from "./format";

const TONES: Record<GlobalPeriodView["status"], string> = {
  open: "neutral",
  due: "amber",
  built: "green",
  empty: "neutral",
  overdue: "red",
  failed: "red",
};
const STATUS_KEYS: Record<GlobalPeriodView["status"], Key> = {
  open: "cfdiPeriodOpen",
  due: "cfdiPeriodDue",
  built: "cfdiPeriodBuilt",
  empty: "cfdiPeriodEmpty",
  overdue: "cfdiPeriodOverdue",
  failed: "cfdiPeriodFailed",
};

export function periodStatusLabel(
  p: GlobalPeriodView,
  timezone: string,
  locale: Locale,
): string {
  if (p.status === "open")
    return tr(locale, "cfdiPeriodOpen", {
      date: dateTimeLabel(p.closesAt, timezone, locale),
    });
  if (p.status === "built")
    return tr(locale, "cfdiPeriodBuilt", {
      n: p.documents.filter((d) => d.status === "valid").length,
    });
  return tr(locale, STATUS_KEYS[p.status]);
}

export function GlobalPeriods({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = strings[locale];
  const tz = session.restaurant.timezone;
  const [periods, setPeriods] = useState<GlobalPeriodView[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const operations = useRef(new Map<string, string>());
  const manager = ["owner", "manager"].includes(session.role);

  const cutoff = session.restaurant.cutoff;
  const load = useCallback(async () => {
    const to = todayFor({ timezone: tz, cutoff });
    const from = shiftDate(to.slice(0, 8) + "01", -62).slice(0, 8) + "01";
    try {
      const rows = await api<GlobalPeriodView[]>(
        `/cfdi/globals?${new URLSearchParams({ from, to })}`,
      );
      setPeriods([...rows].sort((a, b) => b.from.localeCompare(a.from)));
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }, [tz, cutoff, locale]);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(periodKey: string) {
    let operationId = operations.current.get(periodKey);
    if (!operationId) {
      operationId = crypto.randomUUID();
      operations.current.set(periodKey, operationId);
    }
    setBusy(periodKey);
    setError("");
    setNotice("");
    try {
      await api("/cfdi/globals/run", { operationId, periodKey });
      operations.current.delete(periodKey);
      setNotice(t.cfdiRunQueued);
      await load();
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="cfdi-globals" aria-label={t.cfdiGlobalsTitle}>
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {periods && periods.length === 0 && <Empty title={t.cfdiEmptyGlobals} />}
      {periods && periods.length > 0 && (
        <div className="cfdi-table-wrap">
          <table className="cfdi-table">
            <thead>
              <tr>
                <th scope="col">{t.cfdiPeriod}</th>
                <th scope="col">{t.cfdiColStatus}</th>
                <th scope="col" className="numeric">
                  {t.cfdiColTickets}
                </th>
                <th scope="col" className="numeric">
                  {t.cfdiColTotal}
                </th>
                <th scope="col" className="numeric">
                  {t.cfdiTax}
                </th>
                <th scope="col">{t.cfdiDetails}</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={`${p.mode}-${p.periodKey}`}>
                  <td>
                    {periodLabel(p, locale)}
                    {p.mode === "test" && (
                      <Badge tone="amber">{t.cfdiTestBadge}</Badge>
                    )}
                  </td>
                  <td>
                    <Badge tone={TONES[p.status]}>
                      {periodStatusLabel(p, tz, locale)}
                    </Badge>
                  </td>
                  <td className="numeric">{p.ticketCount}</td>
                  <td className="numeric">{moneyLabel(p.total, locale)}</td>
                  <td className="numeric">{moneyLabel(p.tax, locale)}</td>
                  <td>
                    <div className="row wrap">
                      {p.documents.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          className="link"
                          onClick={() => setSelected(d.id)}
                        >
                          {tr(locale, "cfdiPeriodPart", { n: d.part })}
                          {d.late ? ` · ${t.cfdiPeriodLate}` : ""}
                        </button>
                      ))}
                      {p.unclaimedTickets > 0 && (
                        <span className="muted tiny">
                          {tr(locale, "cfdiPeriodUnclaimed", {
                            n: p.unclaimedTickets,
                          })}
                        </span>
                      )}
                      {p.lateTickets > 0 && (
                        <span className="muted tiny">
                          {tr(locale, "cfdiLateTickets", { n: p.lateTickets })}
                        </span>
                      )}
                      {manager && p.canRun && (
                        <Button
                          disabled={busy !== null}
                          onClick={() => void run(p.periodKey)}
                        >
                          {t.cfdiRunNow}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <DocumentDetail
          documentId={selected}
          session={session}
          locale={locale}
          close={() => setSelected(null)}
          open={setSelected}
          changed={() => void load()}
        />
      )}
    </section>
  );
}
