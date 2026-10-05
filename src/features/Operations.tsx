import { CashHistory } from "./CashHistory";
import { DeviceManagement } from "./DeviceManagement";
import { StaffManagement } from "./StaffManagement";
import { RecoveryQueue } from "./RecoveryQueue";
import { FreeSelection } from "./FreeSelection";
import { PlanSettings } from "./PlanSettings";
import { Orders } from "./Orders";
import { Tables } from "./Tables";
import { Kitchen } from "./Kitchen";
import { RestaurantSettings } from "./RestaurantSettings";
import { currencyExponent } from "../../shared/domain";
import { ManagementTools } from "./ManagementTools";
import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { minor, type Session, type Locale } from "../../shared/domain";
import { strings, translateError, type Key } from "../i18n";
import { integrationLabel, operationLabel, stockCauseLabel } from "../labels";
import { api } from "../api";
import { db, isResolved } from "../offline";
import { ArchivedDrawerNote } from "./offline/ArchivedDrawerNote";
import { OfflineKitchenReview } from "./offline/OfflineKitchenReview";
import { Button, Field, Empty, Modal, Badge } from "../components/ui";
export function Operations({
  view,
  session,
  locale,
  navigate,
}: {
  view: string;
  session: Session;
  locale: Locale;
  navigate: (s: string) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const exponent = currencyExponent(session.restaurant.currency);
  const scale = 10 ** exponent;
  const parseAmount = (s: string) => minor(s, exponent);
  const m = (n: number) =>
    new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
      style: "currency",
      currency: session.restaurant.currency,
    }).format(n / scale);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // One operation id per opened dialog, kept across retries (MON-3).
  const [modal, setModalState] = useState<{
    kind: string;
    item?: any;
    operationId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<any[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  /** Opening a dialog creates its operation id; closing it discards the id. */
  const setModal = (next: { kind: string; item?: any } | null) =>
    setModalState(next && { ...next, operationId: crypto.randomUUID() });
  async function load() {
    try {
      // These views load and poll by themselves.
      if (["orders", "tables", "kitchen", "sync"].includes(view)) {
        setData(null);
        return;
      }
      if (view === "settings") setData(await api("/capabilities"));
      else {
        const endpoint =
          ({ today: "report", finance: "report" } as Record<string, string>)[
            view
          ] ?? view;
        setData(await api("/" + endpoint));
      }
      setError("");
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    setLoading(true);
    setData(null);
    setDetail(null);
    void load();
  }, [view]);
  async function action(path: string, body: unknown) {
    if (path === "/cash/close") {
      const pending = await db.pending
        .filter(
          (p) =>
            p.scope.startsWith(
              session.tenantId + ":" + session.deviceId + ":",
            ) && !isResolved(p),
        )
        .count();
      if (pending) {
        setError(t("syncBeforeClose"));
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      await api(path, body);
      setModal(null);
      await load();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  const manager = ["owner", "manager"].includes(session.role);
  return (
    <>
      <div className="section-title">
        <div>
          <span className="eyebrow">{session.restaurant.name}</span>
          <h1>{t(view as Key)}</h1>
        </div>
        <Button
          aria-label={t("reload")}
          onClick={() => {
            setRefreshKey((n) => n + 1);
            void load();
          }}
        >
          <RefreshCw size={18} />
          {t("reload")}
        </Button>
      </div>
      {manager && (
        <ManagementTools
          view={view}
          session={session}
          locale={locale}
          refresh={load}
        />
      )}{" "}
      {view === "settings" && (
        <>
          <RestaurantSettings session={session} locale={locale} />
          {session.role === "owner" && <FreeSelection locale={locale} />}
          {manager && <DeviceManagement session={session} locale={locale} />}
          <PlanSettings
            tenantId={session.tenantId}
            locale={locale}
            timezone={session.restaurant.timezone}
          />
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p>{t("loading")}</p>
      ) : (
        <>
          {view === "orders" && (
            <Orders
              session={session}
              locale={locale}
              navigate={navigate}
              refreshKey={refreshKey}
            />
          )}
          {view === "tables" && (
            <Tables
              session={session}
              locale={locale}
              navigate={navigate}
              refreshKey={refreshKey}
              onEditTables={manager ? () => navigate("floor") : undefined}
            />
          )}
          {view === "kitchen" && (
            <Kitchen
              session={session}
              locale={locale}
              refreshKey={refreshKey}
              beforeTickets={(station) => (
                <OfflineKitchenReview
                  session={session}
                  locale={locale}
                  station={station}
                  onDecided={() => setRefreshKey((n) => n + 1)}
                />
              )}
            />
          )}
          {view === "cash" && manager && (
            <CashHistory
              locale={locale}
              currency={session.restaurant.currency}
            />
          )}
          {view === "cash" && (
            <>
              {!data || data.closed_at ? (
                <div className="panel narrow">
                  <Badge>{t("drawerClosed")}</Badge>
                  <h2>{t("openDrawer")}</h2>
                  <p>{t("noDrawer")}</p>
                  <Button
                    variant="primary"
                    onClick={() => setModal({ kind: "open" })}
                  >
                    {t("openDrawer")}
                  </Button>
                  {data && (
                    <p>
                      {t("difference")}: {m(data.discrepancy)}
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <div className="metric-grid">
                    <div className="metric">
                      <span>{t("opening")}</span>
                      <strong>{m(data.opening)}</strong>
                    </div>
                    <div className="metric">
                      <span>{t("expected")}</span>
                      <strong>{m(data.expected)}</strong>
                    </div>
                    <div className="metric">
                      <span>{t("tip")}</span>
                      <strong>
                        {m(
                          data.tenders.reduce(
                            (a: number, t: any) => a + t.tip,
                            0,
                          ),
                        )}
                      </strong>
                    </div>
                  </div>
                  <div className="row">
                    <Badge tone="green">{t("drawerOpen")}</Badge>
                    {manager && (
                      <>
                        <Button onClick={() => setModal({ kind: "paidout" })}>
                          {t("paidOut")}
                        </Button>
                        <Button
                          variant="primary"
                          onClick={() => setModal({ kind: "close" })}
                        >
                          {t("closeDrawer")}
                        </Button>
                      </>
                    )}
                  </div>
                  <h2>{t("movements")}</h2>
                  <div className="data-table">
                    <table>
                      <thead>
                        <tr>
                          <th>{t("date")}</th>
                          <th>{t("method")}</th>
                          <th>{t("amount")}</th>
                          <th>{t("tip")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.tenders.map((r: any) => (
                          <tr key={r.id}>
                            <td>
                              {new Date(r.created_at).toLocaleTimeString(
                                locale,
                              )}
                            </td>
                            <td>
                              {t(
                                r.method === "cash" ? "cashMethod" : "external",
                              )}
                            </td>
                            <td>{m(r.amount)}</td>
                            <td>{m(r.tip)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
          {view === "inventory" && (
            <>
              <div className="row between">
                <p className="muted">{t("inventoryHint")}</p>
                <Button onClick={() => setModal({ kind: "prep" })}>
                  {t("prep")}
                </Button>
              </div>
              <div className="stock-grid">
                {data?.map((r: any) => (
                  <article className="panel" key={r.id}>
                    <div className="row between">
                      <h2>{r.name}</h2>
                      <Badge
                        tone={
                          Number(r.quantity) < 0
                            ? "red"
                            : Number(r.quantity) <= Number(r.threshold)
                              ? "amber"
                              : "green"
                        }
                      >
                        {Number(r.quantity) < 0
                          ? `${t("menuStockNegative")} · ${r.unit}`
                          : r.unit}
                      </Badge>
                    </div>
                    <div className="large-money">
                      {new Intl.NumberFormat(locale).format(Number(r.quantity))}
                    </div>
                    <p className="muted">
                      {t("version")} {r.version}
                    </p>
                    <div className="row wrap">
                      <Button
                        onClick={() => setModal({ kind: "receipt", item: r })}
                      >
                        {t("receive")}
                      </Button>
                      <Button
                        onClick={() =>
                          setModal({ kind: "count_adjust", item: r })
                        }
                      >
                        {t("count")}
                      </Button>
                      <Button
                        onClick={() => setModal({ kind: "waste", item: r })}
                      >
                        {t("waste")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          setDetail(await api("/inventory/" + r.id));
                          setModal({ kind: "history" });
                        }}
                      >
                        {t("history")}
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
          {(view === "today" || view === "finance") && data && (
            <>
              <p className="summary-copy">{t("reportHint")}</p>
              <div className="metric-grid">
                {[
                  ["gross", data.gross],
                  ["collected", data.collected],
                  ["cogs", data.cogs],
                  ["refunds", data.refundTotal],
                ].map(([key, value]) => (
                  <button
                    className="metric"
                    key={key}
                    onClick={() => navigate("orders")}
                  >
                    <span>
                      {t(key as Key)}
                      <ArrowUpRight size={17} />
                    </span>
                    <strong>{m(value as number)}</strong>
                    <small>{t("viewRecords")}</small>
                  </button>
                ))}
              </div>
              <div className="insight-grid">
                <section className="panel">
                  <div className="row between">
                    <h2>{t("orders")}</h2>
                    <Badge>{data.orders.length}</Badge>
                  </div>
                  {data.orders.length ? (
                    data.orders.slice(0, 6).map((o: any) => (
                      <button
                        className="report-row"
                        key={o.id}
                        onClick={() => {
                          localStorage.setItem("gm-resume", o.id);
                          navigate("sell");
                        }}
                      >
                        <span>
                          #{o.number} · {o.name || t("order")}
                        </span>
                        <strong>{m(o.total)}</strong>
                        <ArrowUpRight size={16} />
                      </button>
                    ))
                  ) : (
                    <Empty title={t("noOrders")} />
                  )}
                </section>
                <section className="panel">
                  <span className="eyebrow">{t("coverage")}</span>
                  <h2>{Math.round(data.costCoverage * 100)}%</h2>
                  {data.unallocatedRecoveryCount > 0 && (
                    <p className="warning-panel">
                      {locale === "es"
                        ? `${data.unallocatedRecoveryCount} ventas recuperadas (${m(data.unallocatedRecoveryTotal)}) sin costo histórico por producto. El costo mostrado está incompleto.`
                        : `${data.unallocatedRecoveryCount} recovered sales (${m(data.unallocatedRecoveryTotal)}) have no historical item costs. Displayed costs are incomplete.`}
                    </p>
                  )}
                  <p>{t("forecastEmpty")}</p>
                  <hr />
                  <p>
                    {t("tip")}: {m(data.tips)}
                  </p>
                  {data.cash.map((c: any) => (
                    <Button
                      key={c.id}
                      className="full"
                      onClick={() => navigate("cash")}
                    >
                      {t("difference")}: {m(c.counted - c.expected)}
                    </Button>
                  ))}
                </section>
              </div>
              <p className="tiny muted">
                {t("source")}: {data.source} · {data.date} ·{" "}
                {session.restaurant.timezone}
                <br />
                {t("refresh")}:{" "}
                {new Date(data.refreshedAt).toLocaleString(locale, {
                  timeZone: session.restaurant.timezone,
                })}
              </p>
            </>
          )}
          {view === "team" && (
            <StaffManagement session={session} locale={locale} />
          )}
          {view === "settings" && (
            <>
              <div className="panel">
                <h2>{t("restaurant")}</h2>
                <p>
                  {session.restaurant.name} · {session.restaurant.currency} ·{" "}
                  {session.restaurant.timezone}
                </p>
                <Badge tone="green">{t("device")}</Badge>
              </div>
              <h2>{t("integrations")}</h2>
              <div className="stock-grid">
                {Object.entries(data ?? {}).map(([key, v]) => (
                  <div className="panel" key={key}>
                    <div className="row between">
                      <h3>{integrationLabel(key, locale)}</h3>
                      <Badge tone={(v as any).enabled ? "green" : "amber"}>
                        {t((v as any).enabled ? "available" : "disabled")}
                      </Badge>
                    </div>
                    {!(v as any).enabled && <p>{t("blockedHint")}</p>}
                  </div>
                ))}
              </div>
              <Button
                onClick={async () => {
                  setDetail(await api("/audit"));
                  setModal({ kind: "audit" });
                }}
              >
                {t("audit")}
              </Button>
            </>
          )}
          {view === "sync" && (
            <RecoveryQueue session={session} locale={locale} />
          )}
        </>
      )}
      {modal && (
        <Modal
          title={t(
            (
              {
                open: "openDrawer",
                close: "closeDrawer",
                paidout: "paidOut",
                receipt: "receive",
                count_adjust: "count",
                history: "movements",
              } as Record<string, Key>
            )[modal.kind] ?? (modal.kind as Key),
          )}
          close={() => setModal(null)}
          closeLabel={t("close")}
        >
          {["history", "audit"].includes(modal.kind) ? (
            <div className="history">
              {detail?.map((r: any) => (
                <div className="report-row" key={r.id}>
                  <span>
                    {r.cause !== undefined
                      ? stockCauseLabel(r.cause, locale)
                      : operationLabel(r.operation, locale)}
                    {r.reason && <small>{r.reason}</small>}
                  </span>
                  <strong>{r.quantity ?? ""}</strong>
                  <time>
                    {new Date(r.created_at).toLocaleString(locale, {
                      timeZone: session.restaurant.timezone,
                    })}
                  </time>
                </div>
              ))}
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const operationId = modal.operationId;
                try {
                  if (modal.kind === "open")
                    await action("/cash/open", {
                      operationId,
                      opening: parseAmount(String(f.get("amount"))),
                    });
                  else if (modal.kind === "close")
                    await action("/cash/close", {
                      operationId,
                      counted: parseAmount(String(f.get("amount"))),
                      reason: f.get("reason"),
                    });
                  else if (modal.kind === "paidout")
                    await action("/cash/paid-out", {
                      operationId,
                      amount: parseAmount(String(f.get("amount"))),
                      reason: f.get("reason"),
                    });
                  else if (modal.kind === "prep")
                    await action("/inventory/prep", {
                      operationId,
                      inputId: f.get("inputId"),
                      inputQuantity: f.get("inputQuantity"),
                      outputId: f.get("outputId"),
                      outputQuantity: f.get("outputQuantity"),
                      reason: f.get("reason"),
                    });
                  else
                    await action("/inventory/movement", {
                      operationId,
                      stockId: modal.item.id,
                      quantity: f.get("amount"),
                      kind: modal.kind,
                      reason: f.get("reason"),
                      expectedVersion: modal.item.version,
                    });
                } catch (e) {
                  setError(translateError((e as Error).message, locale));
                }
              }}
            >
              {modal.kind === "close" && (
                <>
                  <p>
                    {t("expected")}: <strong>{m(data.expected)}</strong>
                  </p>
                  <ArchivedDrawerNote
                    session={session}
                    drawerId={data.id}
                    locale={locale}
                    money={m}
                  />
                </>
              )}
              {modal.kind === "prep" ? (
                <>
                  {["input", "output"].map((k) => (
                    <div key={k}>
                      <Field label={t(k as Key)}>
                        <select name={k + "Id"}>
                          {data.map((i: any) => (
                            <option value={i.id} key={i.id}>
                              {i.name} ({i.unit})
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={t("quantity")}>
                        <input
                          name={k + "Quantity"}
                          inputMode="decimal"
                          required
                          pattern="[0-9]+(\.[0-9]{1,6})?"
                        />
                      </Field>
                    </div>
                  ))}
                </>
              ) : (
                <Field
                  label={t(
                    modal.kind === "close"
                      ? "counted"
                      : modal.item
                        ? "quantity"
                        : "amount",
                  )}
                >
                  <input
                    name="amount"
                    inputMode="decimal"
                    required
                    pattern="[0-9]+(\.[0-9]{1,6})?"
                    defaultValue={modal.kind === "open" ? "500.00" : ""}
                  />
                </Field>
              )}
              {modal.kind !== "open" && (
                <Field label={t("reason")}>
                  <textarea
                    name="reason"
                    required={modal.kind !== "close"}
                    minLength={3}
                  />
                </Field>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <Button
                variant="primary"
                className="full"
                type="submit"
                disabled={busy}
              >
                {t("save")}
              </Button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
