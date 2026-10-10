import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { Locale, Order, Session } from "../../shared/domain";
import {
  kitchenStatus,
  paymentStatus,
  type OrderListResponse,
  type OrderSummary,
} from "../../shared/service";
import { api } from "../api";
import { strings, errorNotice, translateError, type Key } from "../i18n";
import { channelLabel, orderModeKey, orderNumberLabel } from "../labels";
import { Badge, Button, Empty, Field } from "../components/ui";
import {
  requestSellingContext,
  usePoll,
  useStoredState,
} from "../serviceHooks";
import { VoidDialog } from "./VoidDialog";
import { ServiceAssignment } from "./ServiceAssignment";
import { RefundDialog } from "./RefundDialog";
import { SettlementDialog } from "./SettlementDialog";
import { OrderDetail } from "./OrderDetail";
import { moneyFormatter } from "./Receipt";
import { useOnlineChargeBlocks } from "./offline/useOnlineChargeBlocks";
import { DiscountDialog } from "./discounts/DiscountDialog";
import { fill } from "./discounts/format";
import { PublicOrderInbox } from "./public/PublicOrderInbox";

type Tab = "current" | "open" | "closed";
const isTab = (v: unknown): v is Tab =>
  v === "current" || v === "open" || v === "closed";
const PAGE = 50;

/** Órdenes: open checks of any age plus today's closed checks, with filters. */
export function Orders({
  session,
  locale,
  navigate,
  refreshKey,
  online = true,
}: {
  session: Session;
  locale: Locale;
  navigate: (view: string) => void;
  refreshKey: number;
  /** Connectivity from App (contract §0.8): discounts and refunds need it. */
  online?: boolean;
}) {
  const t = (k: Key) => strings[locale][k];
  const money = moneyFormatter(session.restaurant.currency, locale);
  const [tab, setTab] = useStoredState<Tab>("gm-orders-tab", "current", isTab);
  const [date, setDate] = useState("");
  const [today, setToday] = useState("");
  const [table, setTable] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<OrderSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [tables, setTables] = useState<{ id: string; name: string }[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    kind: "void" | "service" | "refund" | "discount";
    order: Order;
  } | null>(null);
  const [settling, setSettling] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // One key per check release, kept across retries until it succeeds.
  const closeKeys = useRef(new Map<string, string>());
  const extra = useRef(0);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    void api<{ id: string; name: string }[]>("/tables")
      .then(setTables)
      .catch(() => {});
  }, []);
  const params = (cursor?: string | null, limit = PAGE) => {
    const p = new URLSearchParams({ status: tab, limit: String(limit) });
    if (tab === "closed" && date) p.set("date", date);
    if (table) p.set("table", table);
    if (query) p.set("q", query);
    if (cursor) p.set("cursor", cursor);
    return "/service/orders?" + p.toString();
  };
  const filterKey = [tab, date, table, query, refreshKey].join("|");
  const lastFilter = useRef(filterKey);
  // Responses for a filter the screen no longer shows are dropped.
  const currentFilter = useRef(filterKey);
  currentFilter.current = filterKey;
  async function loadFirst() {
    const key = filterKey;
    const reset = lastFilter.current !== key;
    lastFilter.current = key;
    if (reset) extra.current = 0;
    // Pages loaded with "Cargar más" are refreshed together, up to the page limit.
    const limit = Math.min(100, PAGE + extra.current);
    try {
      const r = await api<OrderListResponse>(params(null, limit));
      if (key !== currentFilter.current) return;
      setToday(r.businessDate);
      setItems((old) => {
        const head = r.items;
        if (limit < PAGE + extra.current) {
          // Beyond the refreshable top rows, keep only loaded rows that sort
          // after the new head (keyset order), so rows pushed down by new
          // orders stay and rows that left the filter disappear.
          const last = head.at(-1);
          const ids = new Set(head.map((o) => o.id));
          const after = (o: OrderSummary) =>
            !last ||
            o.createdAt < last.createdAt ||
            (o.createdAt === last.createdAt && o.id < last.id);
          return [...head, ...old.filter((o) => !ids.has(o.id) && after(o))];
        }
        return head;
      });
      if (limit >= PAGE + extra.current) setNextCursor(r.nextCursor);
      setSelected((ids) =>
        ids.filter((id) =>
          r.items.some(
            (o) => o.id === id && o.checkState !== "closed" && o.balance > 0,
          ),
        ),
      );
      setError("");
    } catch (e) {
      setError(errorNotice(e, locale));
      throw e;
    } finally {
      setLoaded(true);
    }
  }
  const poll = usePoll(
    loadFirst,
    { intervalMs: 15000, enabled: tab !== "closed" },
    [filterKey],
  );
  useEffect(() => {
    if (tab === "closed") void loadFirst().catch(() => {});
  }, [filterKey]);
  const refresh = () =>
    tab === "closed" ? void loadFirst().catch(() => {}) : poll.refresh();
  // OFF-R29 (offline 026): a check with this device's unsynced offline rounds
  // or payments cannot be selected for Cobrar juntas, and says why. List rows
  // carry no lines, so a row is never judged "outdated" here: the list is read
  // again whenever a block clears (that record just synced), and
  // SettlementDialog re-checks the full orders right before charging.
  const chargeViews = useMemo(
    () =>
      items
        .filter((o) => o.checkState !== "closed" && o.balance > 0)
        .map((o) => ({ id: o.id, number: o.number }) as unknown as Order),
    [items],
  );
  const chargeBlocks = useOnlineChargeBlocks(
    session,
    chargeViews.length ? chargeViews : null,
    refresh,
  );
  const blockedIds = Object.keys(chargeBlocks).sort().join();
  const lastBlocked = useRef(blockedIds);
  useEffect(() => {
    const cleared = lastBlocked.current
      .split(",")
      .some((id) => id && !chargeBlocks[id]);
    lastBlocked.current = blockedIds;
    setSelected((ids) => ids.filter((id) => !chargeBlocks[id]));
    if (cleared) refresh();
  }, [blockedIds]);
  async function loadMore() {
    if (!nextCursor) return;
    const key = filterKey;
    try {
      const r = await api<OrderListResponse>(params(nextCursor));
      if (key !== currentFilter.current) return;
      extra.current += r.items.length;
      setItems((old) => {
        const ids = new Set(old.map((o) => o.id));
        return [...old, ...r.items.filter((o) => !ids.has(o.id))];
      });
      setNextCursor(r.nextCursor);
    } catch (e) {
      setError(errorNotice(e, locale));
    }
  }
  async function openDialog(
    kind: "void" | "service" | "refund" | "discount",
    id: string,
  ) {
    setBusyId(id);
    try {
      setDialog({ kind, order: await api<Order>("/orders/" + id) });
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusyId(null);
    }
  }
  async function closeCheck(o: OrderSummary) {
    const key = closeKeys.current.get(o.id) ?? crypto.randomUUID();
    closeKeys.current.set(o.id, key);
    setBusyId(o.id);
    try {
      await api(`/service/orders/${o.id}/close`, { operationId: key });
      closeKeys.current.delete(o.id);
      refresh();
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusyId(null);
    }
  }
  const saved = async () => refresh();
  const chosen = items.filter((o) => selected.includes(o.id));
  return (
    <div className="orders-view">
      <PublicOrderInbox
        session={session}
        locale={locale}
        online={online}
        navigate={navigate}
        onChanged={refresh}
      />
      <div
        className="orders-toolbar"
        role="search"
        aria-label={t("serviceOrdersFilters")}
      >
        <div className="service-tabs" role="group">
          {(["current", "open", "closed"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              className={tab === key ? "selected" : ""}
              onClick={() => {
                setTab(key);
                setSelected([]);
              }}
            >
              {t(
                key === "current"
                  ? "serviceOrdersTabCurrent"
                  : key === "open"
                    ? "serviceOrdersTabOpen"
                    : "serviceOrdersTabClosed",
              )}
            </button>
          ))}
        </div>
        <div className="orders-filters">
          <Field label={t("serviceOrdersSearch")}>
            <input
              type="search"
              value={search}
              maxLength={80}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <Field label={t("serviceOrdersTable")}>
            <select value={table} onChange={(e) => setTable(e.target.value)}>
              <option value="">{t("serviceOrdersAllTables")}</option>
              {tables.map((tb) => (
                <option key={tb.id} value={tb.id}>
                  {tb.name}
                </option>
              ))}
            </select>
          </Field>
          {tab === "closed" && (
            <Field label={t("serviceOrdersDate")}>
              <input
                type="date"
                value={date || today}
                max={today || undefined}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          )}
        </div>
      </div>
      <Button disabled={selected.length < 2} onClick={() => setSettling(true)}>
        {t("settleOrders")} ({selected.length})
      </Button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!loaded ? (
        <p>{t("loading")}</p>
      ) : items.length ? (
        <div className="order-list">
          {items.map((o) => {
            const closed = o.checkState === "closed";
            const pay = paymentStatus(o);
            const kitchen = kitchenStatus(o);
            const holds = o.mode === "dine_in" && !!o.tableId;
            return (
              <article className="order-summary" key={o.id}>
                <label className="selection-check">
                  <input
                    type="checkbox"
                    aria-label={
                      t("selectOrder") +
                      " " +
                      orderNumberLabel(o, today, locale)
                    }
                    disabled={closed || o.balance <= 0 || !!chargeBlocks[o.id]}
                    checked={selected.includes(o.id)}
                    onChange={() =>
                      setSelected((ids) =>
                        ids.includes(o.id)
                          ? ids.filter((id) => id !== o.id)
                          : [...ids, o.id],
                      )
                    }
                  />
                </label>
                <div>
                  {/* LD-29: the number names an order of another business day
                      ("#10 · 5 oct"); the card shows that date once (LD-48). */}
                  <span className="eyebrow">
                    {orderNumberLabel(o, today, locale)} ·{" "}
                    {t(orderModeKey(o.mode, !!o.tableName))} ·{" "}
                    {channelLabel(o.channel, locale)}
                  </span>
                  <h3>{o.name || t("order")}</h3>
                  <p>
                    {o.tableName ?? t("noTable")} · {o.waiterName}
                  </p>
                  <p>
                    {o.preview
                      .map((l) => `${l.quantity} ${l.name[locale]}`)
                      .join(" · ")}
                    {o.previewMore > 0 &&
                      " " +
                        t("serviceOrdersMore").replace(
                          "{n}",
                          String(o.previewMore),
                        )}
                  </p>
                  {o.note && (
                    <p className="line-note">
                      {t("serviceOrdersNotePrefix").replace(
                        "{note}",
                        o.note.length > 80 ? o.note.slice(0, 79) + "…" : o.note,
                      )}
                    </p>
                  )}
                  {chargeBlocks[o.id] && !closed && o.balance > 0 && (
                    <p className="tiny warning-panel" role="status">
                      {translateError(chargeBlocks[o.id]!, locale)}
                    </p>
                  )}
                  <div className="badges">
                    <Badge
                      tone={
                        pay === "paid"
                          ? "green"
                          : pay === "refunded"
                            ? "neutral"
                            : "amber"
                      }
                    >
                      {t(pay)}
                    </Badge>
                    <Badge
                      tone={
                        closed
                          ? "neutral"
                          : o.checkState === "paid"
                            ? "green"
                            : "amber"
                      }
                    >
                      {t(
                        o.closeReason === "voided"
                          ? "serviceCheckVoided"
                          : closed
                            ? "serviceCheckClosed"
                            : o.checkState === "paid"
                              ? "serviceCheckPaid"
                              : "serviceCheckOpen",
                      )}
                    </Badge>
                    {o.closeReason !== "voided" && !o.recovery && (
                      <Badge tone={kitchen === "ready" ? "green" : "neutral"}>
                        {t(
                          kitchen === "ready"
                            ? "serviceKitchenReady"
                            : kitchen === "served"
                              ? "serviceKitchenServed"
                              : "serviceKitchenPreparing",
                        )}
                      </Badge>
                    )}
                    {o.voidAckPending && (
                      <Badge tone="amber">{t("serviceVoidAckPending")}</Badge>
                    )}
                    {o.discount > 0 && (
                      <Badge>
                        {fill(t("discountsBadge"), {
                          amount: money(o.discount),
                        })}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="order-summary-actions">
                  <strong>{money(o.balance)}</strong>
                  {!closed && !o.recovery && (
                    <Button
                      onClick={() => {
                        requestSellingContext({ resume: o.id });
                        navigate("sell");
                      }}
                    >
                      {t("resume")}
                      <ArrowUpRight size={16} />
                    </Button>
                  )}
                  <Button onClick={() => setDetailId(o.id)}>
                    {t("serviceOrdersDetail")}
                  </Button>
                  {!closed && !o.recovery && (
                    <Button
                      disabled={busyId === o.id}
                      onClick={() => void openDialog("service", o.id)}
                    >
                      {t("assignService")}
                    </Button>
                  )}
                  {!closed && !o.recovery && o.balance > 0 && (
                    <Button
                      variant="ghost"
                      disabled={busyId === o.id}
                      onClick={() => void openDialog("void", o.id)}
                    >
                      {t("voidAction")}
                    </Button>
                  )}
                  {!closed && !o.recovery && o.balance > 0 && (
                    <Button
                      variant="ghost"
                      disabled={busyId === o.id || !online}
                      aria-describedby={
                        online ? undefined : `discount-offline-${o.id}`
                      }
                      onClick={() => void openDialog("discount", o.id)}
                    >
                      {t("discountsAction")}
                    </Button>
                  )}
                  {!online && !closed && !o.recovery && o.balance > 0 && (
                    <small
                      id={`discount-offline-${o.id}`}
                      className="tiny muted discounts-offline-hint"
                    >
                      {t("discountsOffline")}
                    </small>
                  )}
                  {o.refundable > 0 && (
                    <Button
                      variant="ghost"
                      disabled={busyId === o.id || !online}
                      aria-describedby={
                        online ? undefined : `refund-offline-${o.id}`
                      }
                      onClick={() => void openDialog("refund", o.id)}
                    >
                      {t("refund")}
                    </Button>
                  )}
                  {!online && o.refundable > 0 && (
                    <small
                      id={`refund-offline-${o.id}`}
                      className="tiny muted discounts-offline-hint"
                    >
                      {t("discountsRefundOffline")}
                    </small>
                  )}
                  {!closed && o.balance <= 0 && (
                    <Button
                      disabled={busyId === o.id}
                      onClick={() => void closeCheck(o)}
                    >
                      {t(holds ? "serviceReleaseTable" : "serviceCloseCheck")}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty
          title={t(
            tab === "closed"
              ? "serviceOrdersEmptyDay"
              : "serviceOrdersEmptyOpen",
          )}
        />
      )}
      {nextCursor && (
        <Button className="full" onClick={() => void loadMore()}>
          {t("serviceOrdersLoadMore")}
        </Button>
      )}
      {settling && (
        <SettlementDialog
          orders={chosen}
          session={session}
          locale={locale}
          money={money}
          today={today}
          close={() => setSettling(false)}
          saved={async () => {
            setSelected([]);
            refresh();
          }}
        />
      )}
      {dialog?.kind === "void" && (
        <VoidDialog
          order={dialog.order}
          session={session}
          locale={locale}
          money={money}
          today={today}
          close={() => setDialog(null)}
          saved={saved}
        />
      )}
      {dialog?.kind === "service" && (
        <ServiceAssignment
          order={dialog.order}
          locale={locale}
          today={today}
          close={() => setDialog(null)}
          saved={saved}
        />
      )}
      {dialog?.kind === "refund" && (
        <RefundDialog
          order={dialog.order}
          session={session}
          locale={locale}
          money={money}
          today={today}
          close={() => setDialog(null)}
          saved={saved}
          online={online}
        />
      )}
      {dialog?.kind === "discount" && (
        <DiscountDialog
          order={dialog.order}
          session={session}
          locale={locale}
          money={money}
          online={online}
          close={() => setDialog(null)}
          applied={saved}
        />
      )}
      {detailId && (
        <OrderDetail
          orderId={detailId}
          session={session}
          locale={locale}
          money={money}
          navigate={navigate}
          close={() => setDetailId(null)}
          changed={refresh}
          online={online}
        />
      )}
    </div>
  );
}
