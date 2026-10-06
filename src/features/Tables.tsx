import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Locale, Session } from "../../shared/domain";
import type { TableCheck, TableOccupancy } from "../../shared/service";
import { api } from "../api";
import { strings, translateError, type Key } from "../i18n";
import { Badge, Button, Empty, Modal } from "../components/ui";
import { requestSellingContext, usePoll } from "../serviceHooks";
import { moneyFormatter } from "./Receipt";

/**
 * Mesas: occupancy comes from checks that are not closed. A paid dine-in check
 * keeps its table ("Pagada · por liberar") until staff release it.
 */
export function Tables({
  session,
  locale,
  navigate,
  refreshKey,
  onEditTables,
}: {
  session: Session;
  locale: Locale;
  navigate: (view: string) => void;
  refreshKey: number;
  /** Menu (025) passes the floor editor shortcut for managers. */
  onEditTables?: () => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const money = moneyFormatter(session.restaurant.currency, locale);
  const [tables, setTables] = useState<TableOccupancy[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<TableOccupancy | null>(null);
  const keys = useRef(new Map<string, string>());
  const poll = usePoll(
    async () => {
      try {
        setTables(await api<TableOccupancy[]>("/service/tables"));
        setError("");
      } catch (e) {
        setError(translateError((e as Error).message, locale));
        throw e;
      }
    },
    { intervalMs: 15000 },
    [refreshKey],
  );
  function resume(check: TableCheck) {
    requestSellingContext({ resume: check.id });
    navigate("sell");
  }
  function open(table: TableOccupancy) {
    requestSellingContext({ table: table.id });
    navigate("sell");
  }
  async function release(check: TableCheck) {
    const key = keys.current.get(check.id) ?? crypto.randomUUID();
    keys.current.set(check.id, key);
    await api(`/service/orders/${check.id}/close`, { operationId: key });
    keys.current.delete(check.id);
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
      poll.refresh();
    }
  }
  const minutes = (iso: string) =>
    Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (!tables)
    return error ? (
      <p className="error" role="alert">
        {error}
      </p>
    ) : (
      <p>{t("loading")}</p>
    );
  if (!tables.length)
    return (
      <>
        <Empty
          title={t("serviceTableNone")}
          detail={onEditTables ? t("serviceTableNoneHint") : undefined}
        />
        {onEditTables && (
          <Button onClick={onEditTables}>{t("serviceEditTables")}</Button>
        )}
      </>
    );
  return (
    <>
      {onEditTables && (
        <div className="row">
          <Button variant="ghost" onClick={onEditTables}>
            {t("serviceEditTables")}
          </Button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="table-grid">
        {tables.map((table) => {
          const occupied = table.checks.length > 0;
          const ready = table.checks.some((c) => c.readyRounds > 0);
          return (
            <article
              className={`table-card ${occupied ? "occupied" : ""}`}
              key={table.id}
              aria-label={table.name}
            >
              <div className="row between">
                <h2>{table.name}</h2>
                <Badge tone={occupied ? "amber" : "green"}>
                  {t(occupied ? "serviceTableOccupied" : "serviceTableFree")}
                </Badge>
              </div>
              {ready && (
                <Badge tone="green">{t("serviceTableFoodReady")}</Badge>
              )}
              {(table.pendingHolds ?? 0) > 0 && (
                <button
                  type="button"
                  className="badge-button"
                  onClick={() => navigate("orders")}
                >
                  <Badge tone="amber">{t("publicTablePending")}</Badge>
                </button>
              )}
              {table.checks.map((c) =>
                // A check settled by an older app revision during a deploy can
                // stay "open" at balance 0; it is released the same way.
                c.checkState === "paid" || c.balance <= 0 ? (
                  <div className="table-check paid" key={c.id}>
                    <span>
                      {t("serviceTablePaidLine").replace(
                        "{n}",
                        String(c.number),
                      )}
                    </span>
                    <div className="row wrap">
                      {/* A paid check still takes rounds ("la última ronda"),
                          which reopen it on the same bill (SVC-K10). */}
                      <Button
                        aria-label={`${t("resume")} #${c.number}`}
                        onClick={() => resume(c)}
                      >
                        {t("resume")}
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => void act(() => release(c))}
                      >
                        {t("serviceReleaseTable")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button className="full" key={c.id} onClick={() => resume(c)}>
                    {t("serviceTableCheckLine")
                      .replace("{n}", String(c.number))
                      .replace("{name}", c.name || t("serviceUnnamed"))
                      .replace("{balance}", money(c.balance))
                      .replace("{min}", String(minutes(c.createdAt)))}
                  </Button>
                ),
              )}
              <Button
                disabled={busy}
                onClick={() =>
                  table.checks.some(
                    (c) => c.checkState === "paid" || c.balance <= 0,
                  )
                    ? setPrompt(table)
                    : open(table)
                }
              >
                <Plus size={18} />
                {t("serviceTableNewCheck")}
              </Button>
            </article>
          );
        })}
      </div>
      {prompt && (
        <Modal
          title={prompt.name}
          close={() => setPrompt(null)}
          closeLabel={t("close")}
        >
          <p>
            {t("serviceTablePaidPrompt").replace(
              "{numbers}",
              prompt.checks
                .filter((c) => c.checkState === "paid" || c.balance <= 0)
                .map((c) => "#" + c.number)
                .join(", "),
            )}
          </p>
          <div className="row wrap">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  for (const c of prompt.checks.filter(
                    (c) => c.checkState === "paid" || c.balance <= 0,
                  ))
                    await release(c);
                  const table = prompt;
                  setPrompt(null);
                  open(table);
                })
              }
            >
              {t("serviceTableReleaseAndOpen")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const table = prompt;
                setPrompt(null);
                open(table);
              }}
            >
              {t("serviceTableOpenWithout")}
            </Button>
            <Button variant="ghost" onClick={() => setPrompt(null)}>
              {t("serviceCancel")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
