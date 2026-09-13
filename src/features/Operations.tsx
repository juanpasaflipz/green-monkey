import { ServiceAssignment } from "./ServiceAssignment";
import { RestaurantSettings } from "./RestaurantSettings";
import { currencyExponent } from "../../shared/domain";
import { ManagementTools } from "./ManagementTools";
import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw, Clock, Check, Plus } from "lucide-react";
import {
  minor,
  type Session,
  type Locale,
  type Order,
} from "../../shared/domain";
import { strings, translateError, type Key } from "../i18n";
import { api } from "../api";
import { db, scope, syncPending } from "../offline";
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
  const [modal, setModal] = useState<{ kind: string; item?: any } | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);
  const [serviceOrder, setServiceOrder] = useState<Order | null>(null);
  const [selectedOrders, setSelectedOrders] = useState<string[]>([]);
  const [station, setStation] = useState("kitchen");
  const [detail, setDetail] = useState<any[] | null>(null);
  const [lastRefresh, setLastRefresh] = useState("");
  async function load() {
    try {
      if (view === "sync")
        setData(
          await db.pending.where("scope").equals(scope(session)).toArray(),
        );
      else if (view === "settings") {
        setData(await api("/capabilities"));
      } else {
        const endpoint =
          ({ today: "report", finance: "report" } as Record<string, string>)[
            view
          ] ?? view;
        setData(await api("/" + endpoint));
        if (view === "tables") setOrders(await api("/orders"));
      }
      setLastRefresh(new Date().toISOString());
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
    const timer = ["kitchen", "sync"].includes(view)
      ? setInterval(() => void load(), 1500)
      : null;
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [view]);
  async function action(path: string, body: unknown) {
    if (path === "/cash/close") {
      const pending = await db.pending
        .filter(
          (p) =>
            p.scope.startsWith(
              session.tenantId + ":" + session.deviceId + ":",
            ) && p.status !== "synced",
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
  function openOrder(o: Order) {
    localStorage.setItem("gm-resume", o.id);
    navigate("sell");
  }
  const manager = ["owner", "manager"].includes(session.role);
  return (
    <>
      {serviceOrder && (
        <ServiceAssignment
          order={serviceOrder}
          locale={locale}
          close={() => setServiceOrder(null)}
          saved={load}
        />
      )}
      <div className="section-title">
        <div>
          <span className="eyebrow">{session.restaurant.name}</span>
          <h1>{t(view as Key)}</h1>
        </div>
        <Button aria-label={t("reload")} onClick={() => void load()}>
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
        <RestaurantSettings session={session} locale={locale} />
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
            <>
              <Button
                disabled={selectedOrders.length < 2}
                onClick={() => setModal({ kind: "settlement" })}
              >
                {t("settleOrders")} ({selectedOrders.length})
              </Button>
              {data?.length ? (
                <div className="order-list">
                  {data.map((o: Order) => (
                    <article className="order-summary" key={o.id}>
                      <label className="selection-check">
                        <input
                          type="checkbox"
                          aria-label={t("selectOrder") + " #" + o.number}
                          disabled={o.paid >= o.total}
                          checked={selectedOrders.includes(o.id)}
                          onChange={() =>
                            setSelectedOrders((ids) =>
                              ids.includes(o.id)
                                ? ids.filter((id) => id !== o.id)
                                : [...ids, o.id],
                            )
                          }
                        />
                      </label>
                      <div>
                        <span className="eyebrow">
                          #{o.number} · {t(o.mode as Key)}
                        </span>
                        <h3>{o.name || t("order")}</h3>
                        <p>
                          {o.tableName ?? t("noTable")} · {o.waiterName}
                        </p>
                        <p>
                          {o.lines
                            .map((l) => `${l.quantity} ${l.name[locale]}`)
                            .join(" · ")}
                        </p>
                        <Badge tone={o.paid >= o.total ? "green" : "amber"}>
                          {t(
                            o.refunded
                              ? "refunded"
                              : o.paid >= o.total
                                ? "paid"
                                : o.paid
                                  ? "partial"
                                  : "unpaid",
                          )}
                        </Badge>{" "}
                        <Badge>{t(o.state as Key)}</Badge>
                      </div>
                      <div className="order-summary-actions">
                        <strong>{m(o.total - o.paid)}</strong>
                        <Button onClick={() => openOrder(o)}>
                          {t("resume")}
                          <ArrowUpRight size={16} />
                        </Button>
                        {o.state !== "completed" && (
                          <Button onClick={() => setServiceOrder(o)}>
                            {t("assignService")}
                          </Button>
                        )}
                        {manager &&
                          o.tenders.some(
                            (x) => x.method === "cash" && x.amount > x.refunded,
                          ) && (
                            <Button
                              variant="ghost"
                              onClick={() =>
                                setModal({ kind: "refund", item: o })
                              }
                            >
                              {t("refund")}
                            </Button>
                          )}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty title={t("noOrders")} detail={t("noOrdersHint")} />
              )}
            </>
          )}
          {view === "tables" && (
            <div className="table-grid">
              {data?.map((table: any) => {
                const active = orders.filter(
                  (o) => o.tableId === table.id && o.state !== "completed",
                );
                return (
                  <article
                    className={`table-card ${active.length ? "occupied" : ""}`}
                    key={table.id}
                  >
                    <div className="row between">
                      <h2>{table.name}</h2>
                      <Badge tone={active.length ? "amber" : "green"}>
                        {active.length ? t("active") : t("available")}
                      </Badge>
                    </div>
                    {active.map((o) => (
                      <Button
                        className="full"
                        key={o.id}
                        onClick={() => openOrder(o)}
                      >
                        #{o.number} · {o.name}{" "}
                        <strong>{m(o.total - o.paid)}</strong>
                      </Button>
                    ))}
                    <Button
                      onClick={() => {
                        localStorage.setItem("gm-table", table.id);
                        navigate("sell");
                      }}
                    >
                      <Plus size={18} />
                      {t("newOrder")}
                    </Button>
                  </article>
                );
              })}
            </div>
          )}
          {view === "kitchen" && (
            <>
              <div className="row">
                <Button
                  variant={station === "kitchen" ? "primary" : "secondary"}
                  onClick={() => setStation("kitchen")}
                >
                  {t("kitchen")}
                </Button>
                <Button
                  variant={station === "bar" ? "primary" : "secondary"}
                  onClick={() => setStation("bar")}
                >
                  {t("bar")}
                </Button>
                <span className="muted">
                  {t("refresh")}{" "}
                  {lastRefresh
                    ? new Date(lastRefresh).toLocaleTimeString(locale)
                    : ""}
                </span>
              </div>
              {error && <p className="warning-panel">{t("stale")}</p>}
              <div className="kitchen-grid">
                {data
                  ?.filter((r: any) => r.station === station)
                  .map((r: any) => (
                    <article className="kitchen-ticket" key={r.id}>
                      <header>
                        <div>
                          <h2>
                            #{r.order_number} <span>{r.name}</span>
                          </h2>
                          <span>
                            {t("round")} {r.number} · {t(r.mode as Key)}
                          </span>
                        </div>
                        <Badge tone={r.state === "ready" ? "green" : "amber"}>
                          <Clock size={14} />
                          {Math.max(
                            0,
                            Math.floor(
                              (Date.now() - new Date(r.created_at).getTime()) /
                                60000,
                            ),
                          )}{" "}
                          min
                        </Badge>
                      </header>
                      <p>
                        {r.table_name ?? t("noTable")} · {r.waiter_name}
                      </p>
                      {r.service_version > 0 && (
                        <Badge>{t("serviceUpdated")}</Badge>
                      )}
                      <div className="ticket-lines">
                        {r.lines?.map((l: any) => (
                          <div key={l.id}>
                            <strong>
                              {l.quantity} × {l.name[locale]}
                            </strong>
                            <p>
                              {l.optionNames
                                .map((o: any) => o[locale])
                                .join(" · ")}
                            </p>
                            {l.note && (
                              <p className="warning-panel">{l.note}</p>
                            )}
                          </div>
                        ))}
                      </div>
                      <p>{t(r.seen_at ? "seen" : "sent")}</p>
                      <Button
                        variant="primary"
                        className="full"
                        disabled={busy}
                        onClick={() =>
                          void action("/kitchen/" + r.id, {
                            operationId: crypto.randomUUID(),
                            state: !r.seen_at
                              ? "seen"
                              : r.state === "active"
                                ? "ready"
                                : "completed",
                          })
                        }
                      >
                        <Check size={20} />
                        {t(
                          !r.seen_at
                            ? "ack"
                            : r.state === "active"
                              ? "markReady"
                              : "serve",
                        )}
                      </Button>
                    </article>
                  ))}
              </div>
              {!data?.some((r: any) => r.station === station) && (
                <Empty title={t("noOrders")} />
              )}
            </>
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
                          Number(r.quantity) <= Number(r.threshold)
                            ? "amber"
                            : "green"
                        }
                      >
                        {r.unit}
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
            <div className="data-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("name")}</th>
                    <th>{t("user")}</th>
                    <th>{t("permission")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.map((e: any) => (
                    <tr key={e.id}>
                      <td>{e.name}</td>
                      <td>{e.login}</td>
                      <td>{t(e.role as Key)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                      <h3>{key}</h3>
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
            <>
              <p className="warning-panel">{t("syncHint")}</p>
              <Button
                variant="primary"
                onClick={async () => {
                  await syncPending(session, true);
                  await load();
                }}
              >
                {t("retry")}
              </Button>
              {data?.map((p: any) => (
                <div className="panel" key={p.id}>
                  <strong>
                    {p.id.slice(0, 8)} · {m(p.body.expectedTotal)}
                  </strong>
                  <p>{t(p.status === "synced" ? "paid" : "pending")}</p>
                  {p.error && (
                    <p className="error">{translateError(p.error, locale)}</p>
                  )}
                </div>
              ))}
              {!data?.length && <Empty title={t("noData")} />}
            </>
          )}
        </>
      )}
      {modal && (
        <Modal
          title={t(
            (
              {
                settlement: "settleOrders",
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
                    {r.cause ?? r.operation}
                    <small>{r.reason ?? r.entity_id}</small>
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
                const operationId = crypto.randomUUID();
                try {
                  if (modal.kind === "settlement") {
                    await action("/settlements", {
                      operationId,
                      orders: data
                        .filter((o: Order) => selectedOrders.includes(o.id))
                        .map((o: Order) => ({
                          id: o.id,
                          amount: o.total - o.paid,
                        })),
                      received: parseAmount(String(f.get("amount"))),
                    });
                    setSelectedOrders([]);
                  } else if (modal.kind === "open")
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
                  else if (modal.kind === "refund")
                    await action("/refunds", {
                      operationId,
                      tenderId: f.get("tenderId"),
                      amount: parseAmount(String(f.get("amount"))),
                      reason: f.get("reason"),
                      disposition: f.get("disposition"),
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
              {modal.kind === "settlement" && (
                <>
                  {data
                    .filter((o: Order) => selectedOrders.includes(o.id))
                    .map((o: Order) => (
                      <p key={o.id}>
                        #{o.number} · {m(o.total - o.paid)}
                      </p>
                    ))}
                  <p>
                    {t("cashMethod")} · {t("total")}:{" "}
                    {m(
                      data
                        .filter((o: Order) => selectedOrders.includes(o.id))
                        .reduce(
                          (a: number, o: Order) => a + o.total - o.paid,
                          0,
                        ),
                    )}
                  </p>
                </>
              )}
              {modal.kind === "close" && (
                <p>
                  {t("expected")}: <strong>{m(data.expected)}</strong>
                </p>
              )}
              {modal.kind === "refund" && (
                <>
                  <Field label={t("method")}>
                    <select name="tenderId">
                      {modal.item.tenders
                        .filter(
                          (t: any) =>
                            t.method === "cash" && t.amount > t.refunded,
                        )
                        .map((p: any) => (
                          <option key={p.id} value={p.id}>
                            {t("cashMethod")} · {m(p.amount - p.refunded)}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label={t("refundReason")}>
                    <select name="disposition">
                      <option value="discard">{t("discard")}</option>
                      <option value="no_stock_return">{t("noReturn")}</option>
                    </select>
                  </Field>
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
                      : modal.item && modal.kind !== "refund"
                        ? "quantity"
                        : "amount",
                  )}
                >
                  <input
                    name="amount"
                    inputMode="decimal"
                    required
                    pattern="[0-9]+(\.[0-9]{1,6})?"
                    defaultValue={
                      modal.kind === "settlement"
                        ? (
                            data
                              .filter((o: Order) =>
                                selectedOrders.includes(o.id),
                              )
                              .reduce(
                                (a: number, o: Order) => a + o.total - o.paid,
                                0,
                              ) / scale
                          ).toFixed(exponent)
                        : modal.kind === "open"
                          ? "500.00"
                          : ""
                    }
                  />
                </Field>
              )}
              {!["open", "settlement"].includes(modal.kind) && (
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
