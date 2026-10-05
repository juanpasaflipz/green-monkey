import { lineRemaining } from "../../shared/settlement";
import { currencyExponent } from "../../shared/domain";
import { normalizePaymentAttempt } from "../../shared/offline-recovery";
import { useEffect, useRef, useState } from "react";
import {
  Search,
  Plus,
  Minus,
  ArrowUpRight,
  ShoppingBag,
  Check,
  Send,
  Pause,
} from "lucide-react";
import {
  quote,
  minor,
  type Session,
  type Product,
  type Locale,
  type OrderInput,
  type Order,
  type LineInput,
} from "../../shared/domain";
import { strings, translateError, type Key } from "../i18n";
import { api, ApiError } from "../api";
import {
  attemptsForOrder,
  clearPaymentAttempt,
  db,
  parkPaymentAttempt,
  scope,
  type Draft,
} from "../offline";
import { useOfflineSelling } from "./offline/useOfflineSelling";
import { useOfflineCurrent } from "./offline/useOfflineCurrent";
import { OfflineOrdersModal } from "./offline/OfflineOrdersModal";
import { fmt, orderLabel, provisionalOnly } from "./offline/format";
import { isServerOrder, type LocalOrderView } from "../offline-records";
import { Button, Field, Empty, Modal, Badge } from "../components/ui";
const fresh = (): OrderInput => ({
  operationId: crypto.randomUUID(),
  lines: [],
  mode: "takeaway",
  tableId: null,
  name: "",
  note: "",
  channel: "pos",
});
export function Selling({
  session,
  catalog,
  locale,
  online,
  active,
  navigate: _navigate,
}: {
  session: Session;
  catalog: Product[];
  locale: Locale;
  online: boolean;
  active: boolean;
  navigate: (s: string) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const exponent = currencyExponent(session.restaurant.currency);
  const scale = 10 ** exponent;
  const parseAmount = (s: string) => minor(s, exponent);
  const money = (n: number) =>
    new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
      style: "currency",
      currency: session.restaurant.currency,
    }).format(n / scale);
  const [draft, setDraft] = useState<OrderInput>(fresh);
  const [hydrated, setHydrated] = useState(false);
  const [saved, setSaved] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [modifier, setModifier] = useState<Product | null>(null);
  const [options, setOptions] = useState<string[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [payment, setPayment] = useState(false);
  const [receipt, setReceipt] = useState<Order | null>(null);
  const [current, setCurrent] = useState<Order | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingPayment, setPendingPayment] = useState(false);
  const [parked, setParked] = useState<Draft[] | null>(null);
  const [tables, setTables] = useState<any[]>([]);
  const [cashSession, setCashSession] = useState<any>(null);
  const [amount, setAmount] = useState("");
  const [splitItems, setSplitItems] = useState(false);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [received, setReceived] = useState("");
  const [tip, setTip] = useState("0");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const paymentKey = useRef(crypto.randomUUID());
  const search = useRef<HTMLInputElement>(null);
  const activeId = scope(session) + ":active";
  const contextId = scope(session) + ":order";
  const attemptId = scope(session) + ":payment";
  const offline = useOfflineSelling({
    session,
    catalog,
    locale,
    cashSession,
    active,
  });
  const [notice, setNotice] = useState("");
  const [openOrders, setOpenOrders] = useState(false);
  /** Records behind the local receipt on screen, for "Imprimir comanda" (§2.5). */
  const [receiptOps, setReceiptOps] = useState<string[]>([]);
  /** The record just sent to the kitchen offline, while printing is "Preguntar". */
  const [sentOffline, setSentOffline] = useState<string[]>([]);
  /** offline_check_paid: the items can go on a new order for the same table. */
  const [closedCheck, setClosedCheck] = useState(false);
  /** Order record id for a new order paid in part offline, one per dialog. */
  const orderOperationKey = useRef(crypto.randomUUID());
  // I13, OFF-R2, OFF-R5: the order on screen follows this device's records.
  useOfflineCurrent({ session, online, current, setCurrent, contextId });
  /** OFF-2: an attempt the server cannot confirm is parked, not retried forever. */
  const shouldPark = (e: unknown) =>
    (e as Error).message === "payment_review_required" ||
    (e instanceof ApiError &&
      e.kind === "domain" &&
      e.status >= 400 &&
      e.status < 500 &&
      e.message !== "operation_conflict");
  async function recoverPayment(value: unknown): Promise<Order> {
    const attempt = normalizePaymentAttempt(value, attemptId);
    if (!attempt) throw Error("payment_review_required");
    const status = await api<{
      state: string;
      result?: Order;
      retryAllowed?: boolean;
    }>("/payments/recovery/status", attempt);
    if (status.state === "committed" && status.result) return status.result;
    if (!status.retryAllowed) throw Error("payment_review_required");
    return api<Order>("/payments/recovery/retry", attempt, {
      idempotent: true,
    });
  }
  useEffect(() => {
    let live = true;
    void db.drafts.get(activeId).then((d) => {
      if (live) {
        if (d) setDraft(d.order);
        setHydrated(true);
      }
    });
    if (online) {
      void api("/tables")
        .then(setTables)
        .catch(() => {});
      void (async () => {
        const a = await db.cache.get(attemptId);
        if (!live) return;
        setPendingPayment(!!a);
        try {
          if (a) {
            const o = await recoverPayment(a.value);
            await clearPaymentAttempt(attemptId, a.value);
            if (live) {
              setCurrent(o);
              setReceipt(o);
              setPendingPayment(false);
            }
          } else {
            const c = await db.cache.get(contextId);
            if (c) {
              const o = await api<Order>("/orders/" + c.value);
              if (live) setCurrent(o);
            }
          }
        } catch (e) {
          // OFF-2: park an attempt that needs review so it blocks only its order.
          if (a && shouldPark(e)) {
            await parkPaymentAttempt(attemptId, a.value);
            if (live) {
              setPendingPayment(false);
              setError(t("offlineAttemptParked"));
            }
          } else if (live)
            setError(translateError((e as Error).message, locale));
        }
      })();
    }
    return () => {
      live = false;
    };
  }, [activeId]);
  useEffect(() => {
    if (!hydrated) return;
    setSaved(false);
    void db.drafts
      .put({
        id: activeId,
        scope: scope(session),
        order: draft,
        updatedAt: Date.now(),
      })
      .then(() => setSaved(true));
  }, [draft, hydrated, activeId]);
  useEffect(() => {
    if (!active) return;
    const key = scope(session) + ":drawer";
    if (online)
      void api("/cash")
        .then(async (d) => {
          setCashSession(d);
          await db.cache.put({ id: key, value: d });
        })
        .catch(() => {});
    else void db.cache.get(key).then((d) => setCashSession(d?.value ?? null));
  }, [active, online]);
  useEffect(() => {
    if (!active) return;
    const resume = localStorage.getItem("gm-resume");
    if (resume) {
      localStorage.removeItem("gm-resume");
      void api<Order>("/orders/" + resume).then((o) => {
        setCurrent(o);
        void db.cache.put({ id: contextId, value: o.id });
        setDraft({
          ...fresh(),
          mode: o.mode as OrderInput["mode"],
          tableId: o.tableId,
          name: o.name,
        });
      });
    }
    const table = localStorage.getItem("gm-table");
    if (table) {
      localStorage.removeItem("gm-table");
      setDraft((d) => ({ ...d, mode: "dine_in", tableId: table }));
    }
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active]);
  let priced: ReturnType<typeof quote> = [];
  try {
    priced = quote(
      draft.lines,
      catalog,
      ["owner", "manager"].includes(session.role),
    );
  } catch {
    /* Catalog conflicts are surfaced when sending. */
  }
  const draftTotal = priced.reduce((a, l) => a + l.total, 0);
  const due = (current ? current.total - current.paid : 0) + draftTotal;
  // OFF-R26: the order on screen can be read again while the payment dialog
  // is open (one of this device's offline rounds or payments synced). An
  // amount still at the old balance follows the new one.
  const shownDue = useRef(due);
  useEffect(() => {
    const before = (shownDue.current / scale).toFixed(exponent),
      after = (due / scale).toFixed(exponent);
    shownDue.current = due;
    if (!payment || splitItems || before === after) return;
    setAmount((value) => (value === before ? after : value));
    setReceived((value) => (value === before ? after : value));
  }, [due]);
  const categories = [...new Set(catalog.map((p) => p.category[locale]))];
  const filtered = catalog.filter(
    (p) =>
      (!category || p.category[locale] === category) &&
      p.name[locale].toLowerCase().includes(query.toLowerCase()),
  );
  function add(p: Product, opts: string[] = []) {
    const line: LineInput = {
      id: crypto.randomUUID(),
      productId: p.id,
      quantity: 1,
      options: opts,
      note: "",
    };
    setDraft((d) => ({ ...d, lines: [...d.lines, line] }));
    setModifier(null);
  }
  function reset() {
    void db.cache.delete(contextId);
    setDraft(fresh());
    setCurrent(null);
    setPayment(false);
    setReceipt(null);
    setCartOpen(false);
    setError("");
    setSentOffline([]);
    setClosedCheck(false);
  }
  async function send(target: Order | null = current) {
    setBusy(true);
    setError("");
    setClosedCheck(false);
    setSentOffline([]);
    try {
      // I13: a local order only ever changes through offline records.
      if (!online || offline.isLocalOrder(target)) {
        const { operationId, view } = await offline.sendOffline(
          target,
          draft,
          { priced, total: draftTotal },
        );
        setCurrent(view);
        setDraft((d) => ({
          ...d,
          operationId: crypto.randomUUID(),
          lines: [],
        }));
        offline.afterSave([operationId]);
        if (offline.printSetting === "ask") setSentOffline([operationId]);
        return view as Order;
      }
      const o = await api<Order>(
        current ? `/orders/${current.id}/rounds` : "/orders",
        current ? { ...draft, expectedVersion: current.version } : draft,
        { idempotent: true },
      );
      setCurrent(o);
      await db.cache.put({ id: contextId, value: o.id });
      setDraft((d) => ({ ...d, operationId: crypto.randomUUID(), lines: [] }));
      return o;
    } catch (e) {
      // §2.3: a paid check takes no offline round; offer a new order instead.
      if ((e as Error).message === "offline_check_paid") setClosedCheck(true);
      setError(translateError((e as Error).message, locale));
      throw e;
    } finally {
      setBusy(false);
    }
  }
  /** "Enviar como orden nueva": the same items, table and name on a new order. */
  function sendAsNew() {
    void db.cache.delete(contextId);
    setCurrent(null);
    void send(null).catch(() => {});
  }
  function openPay() {
    setSplitItems(false);
    setSelectedItems([]);
    setAmount((due / scale).toFixed(exponent));
    setReceived((due / scale).toFixed(exponent));
    setTip("0");
    paymentKey.current = crypto.randomUUID();
    orderOperationKey.current = crypto.randomUUID();
    setPayment(true);
    setError("");
  }
  async function collect() {
    return navigator.locks.request(
      "green-monkey-session-transition",
      { mode: "shared" },
      () =>
        navigator.locks.request(
          "green-monkey-payment:" + scope(session),
          collectLocked,
        ),
    );
  }
  /**
   * OFF-2: settles the single active attempt before any new charge. It blocks
   * only its own order: a resolved attempt for another order is cleared, an
   * unconfirmable one is parked, and nothing is ever overwritten (I9).
   * Returns true when the attempt was for `targetOrderId` and its receipt is shown.
   */
  async function settleActiveAttempt(
    targetOrderId: string | null,
  ): Promise<boolean> {
    const previous = await db.cache.get(attemptId);
    const attempt = previous
      ? normalizePaymentAttempt(previous.value, attemptId)
      : null;
    const same = !!targetOrderId && attempt?.orderId === targetOrderId;
    if (previous && !online) {
      if (same) throw new Error("offline_payment_pending_for_order");
    } else if (previous) {
      try {
        const result = await recoverPayment(previous.value);
        await clearPaymentAttempt(attemptId, previous.value);
        setPendingPayment(false);
        if (same) {
          setCurrent(result);
          setPayment(false);
          setReceipt(result);
          paymentKey.current = crypto.randomUUID();
          return true;
        }
        setNotice(fmt(t("offlineAttemptResolvedOther"), { n: result.number }));
      } catch (e) {
        if (!shouldPark(e)) throw e;
        await parkPaymentAttempt(attemptId, previous.value);
        setPendingPayment(false);
        if (same) throw new Error("payment_review_required", { cause: e });
      }
    }
    if (
      targetOrderId &&
      (await attemptsForOrder(session, targetOrderId)).some(
        (row) => row.key !== attemptId,
      )
    )
      throw new Error(
        online
          ? "payment_review_required"
          : "offline_payment_pending_for_order",
      );
    return false;
  }
  /** "Recuperar pago": resolves the pending attempt without starting a charge. */
  async function recoverPending() {
    return navigator.locks.request(
      "green-monkey-session-transition",
      { mode: "shared" },
      () =>
        navigator.locks.request(
          "green-monkey-payment:" + scope(session),
          async () => {
            setBusy(true);
            setError("");
            try {
              const previous = await db.cache.get(attemptId);
              const orderId = previous
                ? normalizePaymentAttempt(previous.value, attemptId)?.orderId
                : null;
              await settleActiveAttempt(orderId ?? null);
            } catch (e) {
              setError(translateError((e as Error).message, locale));
            } finally {
              setPendingPayment(!!(await db.cache.get(attemptId)));
              setBusy(false);
            }
          },
        ),
    );
  }
  async function collectLocked() {
    let submittedAttempt: unknown;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (await settleActiveAttempt(current?.id ?? null)) return;
      const n = parseAmount(amount),
        cash = parseAmount(received),
        tips = parseAmount(tip);
      if (!online || offline.isLocalOrder(current)) {
        const saved = await offline.collectOffline(
          {
            amount: n,
            tip: tips,
            received: cash,
            method: method as "cash" | "external",
            reference,
            confirmed,
          },
          {
            draft,
            priced,
            total: draftTotal,
            current,
            operationId: paymentKey.current,
            orderOperationId: orderOperationKey.current,
          },
          splitItems ? selectedItems : undefined,
        );
        setReceipt(saved.receipt);
        setReceiptOps(saved.operationIds);
        setCurrent(saved.view);
        setPayment(false);
        setDraft(fresh());
        paymentKey.current = crypto.randomUUID();
        orderOperationKey.current = crypto.randomUUID();
        offline.afterSave(saved.operationIds, saved.receipt);
        return;
      }
      await offline.guardOnlinePayment(current);
      let o = current;
      if (draft.lines.length) o = await send();
      if (!o) throw new Error("invalid_input");
      const payload = {
        operationId: paymentKey.current,
        amount: n,
        tip: tips,
        received: cash,
        method,
        externalConfirmed: confirmed,
        reference,
        ...(splitItems ? { items: selectedItems } : {}),
      };
      submittedAttempt = {
        formatVersion: 1,
        tenantId: session.tenantId,
        employeeId: session.employeeId,
        deviceId: session.deviceId,
        sessionId: session.id,
        cashSessionId: cashSession.id,
        orderId: o.id,
        createdAt: new Date().toISOString(),
        payload,
      };
      await db.cache.put({ id: attemptId, value: submittedAttempt });
      setPendingPayment(true);
      const result = await api<Order>(`/orders/${o.id}/payments`, payload, {
        idempotent: true,
      });
      await clearPaymentAttempt(attemptId, submittedAttempt);
      setCurrent(result);
      setPendingPayment(false);
      setPayment(false);
      setReceipt(result);
      paymentKey.current = crypto.randomUUID();
    } catch (e) {
      if (
        submittedAttempt &&
        e instanceof ApiError &&
        [400, 404, 409].includes(e.status) &&
        e.message !== "operation_conflict"
      )
        await clearPaymentAttempt(attemptId, submittedAttempt);
      setPendingPayment(!!(await db.cache.get(attemptId)));
      // OFF-R26: the order on screen lacks a round this device synced: read
      // it again (an amount still at the old balance follows the new one).
      if ((e as Error).message === "offline_order_outdated" && current) {
        const fresh = await api<Order>("/orders/" + current.id).catch(
          () => null,
        );
        if (fresh) setCurrent(fresh);
      }
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  const cart = (
    <>
      <div className="cart-heading">
        <div>
          <span className="eyebrow">
            {current ? orderLabel(current) : t("newOrder")}
          </span>
          <h2>{t("order")}</h2>
        </div>
        <Badge tone={online ? "green" : "amber"}>
          {online
            ? current
              ? t("sent")
              : saved
                ? t("saved")
                : t("loading")
            : t("offline")}
        </Badge>
      </div>
      <div className="service-tabs">
        {(["takeaway", "dine_in", "delivery"] as const).map((mode) => (
          <button
            key={mode}
            className={draft.mode === mode ? "selected" : ""}
            onClick={() => setDraft((d) => ({ ...d, mode }))}
          >
            {t(mode)}
          </button>
        ))}
      </div>
      <div className="cart-fields">
        <Field label={t("name")}>
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder={t("name")}
          />
        </Field>
        {draft.mode === "dine_in" && (
          <Field label={t("selectTable")}>
            <select
              value={draft.tableId ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, tableId: e.target.value || null }))
              }
            >
              <option value="">—</option>
              {tables.map((tb) => (
                <option key={tb.id} value={tb.id}>
                  {tb.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <div className="cart-lines">
        {current && (
          <div className="existing">
            <strong>
              {orderLabel(current)} · {t("sent")}
            </strong>
            <p>
              {current.lines
                .filter((l) => lineRemaining(l).quantity > 0)
                .map((l) => `${lineRemaining(l).quantity} × ${l.name[locale]}`)
                .join(", ")}
            </p>
            <span>
              {money(current.total)} · {t("paid")}: {money(current.paid)}
            </span>
            {!isServerOrder(current) && (
              <Button
                variant="ghost"
                onClick={() => void offline.printOrder(current)}
              >
                {t("offlinePrintKitchen")}
              </Button>
            )}
            {(!online || offline.isLocalOrder(current)) &&
              !offline.tableService && (
                <p className="warning-panel" role="status">
                  {t("offlineAvailableOnReconnect")}
                </p>
              )}
          </div>
        )}
        {!draft.lines.length && !current ? (
          <Empty title={t("emptyCart")} detail={t("emptyHint")} />
        ) : (
          priced.map((line) => (
            <div className="order-line" key={line.id}>
              <div>
                <strong>{line.name[locale]}</strong>
                <p>{line.optionNames.map((o) => o[locale]).join(" · ")}</p>
                <div className="quantity">
                  <button
                    aria-label={`${t("quantity")} − ${line.name[locale]}`}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        lines: d.lines.flatMap((l) =>
                          l.id === line.id
                            ? l.quantity === 1
                              ? []
                              : [{ ...l, quantity: l.quantity - 1 }]
                            : [l],
                        ),
                      }))
                    }
                  >
                    <Minus size={14} />
                  </button>
                  <span>{line.quantity}</span>
                  <button
                    aria-label={`${t("quantity")} + ${line.name[locale]}`}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        lines: d.lines.map((l) =>
                          l.id === line.id
                            ? { ...l, quantity: Math.min(99, l.quantity + 1) }
                            : l,
                        ),
                      }))
                    }
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
              <strong>{money(line.total)}</strong>
            </div>
          ))
        )}
      </div>
      <div className="cart-bottom">
        <Field label={t("note")}>
          <input
            value={draft.note}
            placeholder={t("note")}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          />
        </Field>
        <div className="total">
          <span>{t("amountDue")}</span>
          <strong>{money(due)}</strong>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {closedCheck && (
          <Button disabled={busy} onClick={sendAsNew}>
            {t("offlineSendAsNew")}
          </Button>
        )}
        {notice && <p role="status">{notice}</p>}
        {sentOffline.length > 0 && (
          <div className="warning-panel" role="status">
            <p>{t("offlineSentToDevice")}</p>
            <Button onClick={() => void offline.printKitchen(sentOffline)}>
              {t("offlinePrintKitchen")}
            </Button>
          </div>
        )}
        <div className="row">
          <Button
            disabled={
              !draft.lines.length ||
              busy ||
              ((!online || offline.isLocalOrder(current)) &&
                !!offline.sendBlockReason)
            }
            onClick={() => void send().catch(() => {})}
          >
            <Send size={16} />
            {t(online ? "send" : "offlineSendLocal")}
          </Button>
          <Button
            variant="primary"
            disabled={
              due <= 0 ||
              busy ||
              // LD-7: an existing check is paid offline only with table service.
              ((!online || offline.isLocalOrder(current)) &&
                !!current &&
                !offline.tableService)
            }
            onClick={openPay}
          >
            {t("pay")}
            <ArrowUpRight size={18} />
          </Button>
        </div>
        {!online && !current && !offline.tableService && (
          <p className="muted tiny">{t("offlineTableServiceOffHint")}</p>
        )}
        <div className="row between">
          <button
            className="text-button"
            disabled={!draft.lines.length}
            onClick={async () => {
              await db.drafts.put({
                id: draft.operationId,
                scope: scope(session),
                order: draft,
                updatedAt: Date.now(),
              });
              reset();
            }}
          >
            <Pause size={14} />
            {t("park")}
          </button>
          <span className="tiny muted" aria-live="polite">
            {saved ? t("saved") : ""}
          </span>
        </div>
      </div>
    </>
  );
  return (
    <div className="sell-layout">
      <section className="catalog">
        <div className="section-title">
          <div>
            <span className="eyebrow">GREEN MONKEY / POS</span>
            <h1>{t("sell")}</h1>
            {pendingPayment && (
              <div className="warning-panel" role="status">
                <p>{t("pendingPaymentRecovery")}</p>
                <Button
                  disabled={!online || busy}
                  onClick={() => void recoverPending()}
                >
                  {t("retryPayment")}
                </Button>
              </div>
            )}
          </div>
          <Button
            onClick={async () => {
              if (draft.lines.length)
                await db.drafts.put({
                  id: draft.operationId,
                  scope: scope(session),
                  order: draft,
                  updatedAt: Date.now(),
                });
              reset();
            }}
          >
            {t("newOrder")}
          </Button>
          <Button
            onClick={async () =>
              setParked(
                (
                  await db.drafts
                    .where("scope")
                    .equals(scope(session))
                    .toArray()
                ).filter((d) => d.id !== activeId),
              )
            }
          >
            {t("drafts")}
          </Button>
          {!online && offline.tableService && (
            <Button onClick={() => setOpenOrders(true)}>
              {t("offlineOpenOrders")}
            </Button>
          )}
        </div>
        <div className="search">
          <Search size={20} />
          <input
            ref={search}
            aria-label={t("search")}
            placeholder={t("search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>/</kbd>
        </div>
        <div className="categories">
          <button
            className={!category ? "selected" : ""}
            onClick={() => setCategory("")}
          >
            {t("all")}
          </button>
          {categories.map((c) => (
            <button
              className={category === c ? "selected" : ""}
              onClick={() => setCategory(c)}
              key={c}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="catalog-label">
          <span>{category || t("all")}</span>
          <span>
            {filtered.length} {t("items")}
          </span>
        </div>
        <div className="product-grid">
          {filtered.map((p, i) => (
            <button
              className="product"
              disabled={!p.available}
              key={p.id}
              onClick={() => {
                if (p.groups.some((g) => g.min > 0)) {
                  setOptions([]);
                  setModifier(p);
                } else add(p);
              }}
            >
              <div className={`product-art art-${i % 4}`} aria-hidden="true">
                <div className="dish-mark">
                  {p.name[locale]
                    .split(" ")
                    .map((w) => w[0])
                    .slice(0, 2)
                    .join("")}
                </div>
                <span className="add-mark">
                  <Plus size={18} />
                </span>
              </div>
              <span className="product-category">{p.category[locale]}</span>
              <strong>{p.name[locale]}</strong>
              <span className="product-price">{money(p.price)}</span>
              {!p.available && <span>{t("soldOut")}</span>}
            </button>
          ))}
        </div>
        {!filtered.length && <Empty title={t("noResults")} />}
        <button className="mobile-order" onClick={() => setCartOpen(true)}>
          <ShoppingBag size={20} />
          <span>
            {t("viewOrder")} · {draft.lines.reduce((a, l) => a + l.quantity, 0)}
          </span>
          <strong>{money(due)}</strong>
        </button>
      </section>
      <aside className="cart">{cart}</aside>
      {cartOpen && (
        <Modal
          title={t("order")}
          close={() => setCartOpen(false)}
          closeLabel={t("close")}
        >
          {cart}
        </Modal>
      )}
      {modifier && (
        <Modal
          title={modifier.name[locale]}
          close={() => setModifier(null)}
          closeLabel={t("close")}
        >
          <p className="large-money">
            {money(
              modifier.price +
                modifier.groups
                  .flatMap((g) => g.options)
                  .filter((o) => options.includes(o.id))
                  .reduce((a, o) => a + o.price, 0),
            )}
          </p>
          {modifier.groups.map((g) => (
            <fieldset key={g.id}>
              <legend>
                {g.name[locale]} · {t("choose")} {g.min}–{g.max}
              </legend>
              {g.options.map((o) => (
                <label className="option" key={o.id}>
                  <input
                    type={g.max === 1 ? "radio" : "checkbox"}
                    name={g.id}
                    disabled={!o.available}
                    checked={options.includes(o.id)}
                    onChange={() =>
                      setOptions((old) =>
                        g.max === 1
                          ? [
                              ...old.filter(
                                (id) => !g.options.some((o) => o.id === id),
                              ),
                              o.id,
                            ]
                          : old.includes(o.id)
                            ? old.filter((id) => id !== o.id)
                            : [...old, o.id],
                      )
                    }
                  />
                  <span>{o.name[locale]}</span>
                  <strong>
                    {o.price ? "+" + money(o.price) : t("available")}
                  </strong>
                </label>
              ))}
            </fieldset>
          ))}
          <Button
            variant="primary"
            className="full"
            disabled={modifier.groups.some((g) => {
              const n = g.options.filter((o) => options.includes(o.id)).length;
              return n < g.min || n > g.max;
            })}
            onClick={() => add(modifier, options)}
          >
            {t("add")}
          </Button>
        </Modal>
      )}
      {payment && (
        <Modal
          title={t("pay")}
          close={() => !busy && setPayment(false)}
          closeLabel={t("close")}
          footer={
            <>
              <div className="row between">
                <span>{t("thisPayment")}</span>
                <strong>
                  {(() => {
                    try {
                      return money(parseAmount(amount));
                    } catch {
                      return "—";
                    }
                  })()}
                </strong>
              </div>{" "}
              <Button
                variant="primary"
                className="full"
                disabled={
                  busy ||
                  (splitItems && !selectedItems.length) ||
                  (!online && !!offline.paymentSlot.blockReason)
                }
                onClick={() => void collect()}
              >
                {busy
                  ? t("loading")
                  : online
                    ? t("confirmPay")
                    : offline.paymentSlot.confirmLabel(
                        method as "cash" | "external",
                      )}
                <Check size={20} />
              </Button>
            </>
          }
        >
          <span className="muted">{t("remaining")}</span>
          <div className="large-money">{money(due)}</div>
          <p>{t("paymentHint")}</p>
          {pendingPayment && (
            <p className="warning-panel" role="status">
              {t("pendingPaymentRecovery")}
            </p>
          )}
          {!online && (
            <p className="warning-panel">
              {offline.paymentSlot.hint(method as "cash" | "external")}
            </p>
          )}
          {!online &&
            !!(current as LocalOrderView | null)?.offline?.cachedAt && (
              <p className="warning-panel" role="status">
                {t("offlinePayCachedWarning")}
              </p>
            )}
          {!online && offline.paymentSlot.blockReason && (
            <p className="error" role="alert">
              {offline.paymentSlot.blockReason}
            </p>
          )}
          <div className="service-tabs">
            <button
              className={method === "cash" ? "selected" : ""}
              onClick={() => setMethod("cash")}
            >
              {t("cashMethod")}
            </button>
            <button
              className={method === "external" ? "selected" : ""}
              onClick={() => setMethod("external")}
            >
              {t("external")}
            </button>
          </div>
          <div className="row wrap">
            <Button
              disabled={busy}
              onClick={() => {
                setSplitItems(false);
                setSelectedItems([]);
                setAmount((due / scale).toFixed(exponent));
                setReceived((due / scale).toFixed(exponent));
              }}
            >
              {t("splitAmount")}
            </Button>
            <Button
              disabled={busy || !online || pendingPayment}
              onClick={async () => {
                try {
                  const order = draft.lines.length
                    ? await send()
                    : await api<Order>("/orders/" + current!.id);
                  setCurrent(order);
                  if (!order.itemSplitAvailable) {
                    setError(t("unallocatedHistory"));
                    return;
                  }
                  setSplitItems(true);
                  setSelectedItems([]);
                  setAmount("0");
                  setReceived("0");
                } catch (e) {
                  setError(translateError((e as Error).message, locale));
                }
              }}
            >
              {t(draft.lines.length ? "sendAndSplit" : "splitItems")}
            </Button>
          </div>
          {splitItems && (
            <fieldset>
              <legend>{t("selectItems")}</legend>
              <p className="muted">{t("itemSplitHint")}</p>
              {current?.paymentUnits?.map((unit) => (
                <label className="option" key={unit.key}>
                  <input
                    type="checkbox"
                    disabled={busy || unit.due === 0}
                    checked={selectedItems.includes(unit.key)}
                    onChange={() => {
                      const selection = selectedItems.includes(unit.key)
                        ? selectedItems.filter((key) => key !== unit.key)
                        : [...selectedItems, unit.key];
                      setSelectedItems(selection);
                      const total = current
                        .paymentUnits!.filter((u) => selection.includes(u.key))
                        .reduce((n, u) => n + u.due, 0);
                      setAmount((total / scale).toFixed(exponent));
                      setReceived((total / scale).toFixed(exponent));
                    }}
                  />
                  <span>
                    {unit.name[locale]} · {unit.unit + 1}
                    <small>
                      {unit.paid ? `${t("paid")}: ${money(unit.paid)}` : ""}
                    </small>
                  </span>
                  <strong>{unit.due ? money(unit.due) : t("paid")}</strong>
                </label>
              ))}
            </fieldset>
          )}
          <Field label={t("amount")}>
            <input
              inputMode="decimal"
              value={amount}
              readOnly={splitItems}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label={t("tip")}>
            <input
              inputMode="decimal"
              value={tip}
              onChange={(e) => setTip(e.target.value)}
            />
          </Field>
          <Field label={t("received")}>
            <input
              inputMode="decimal"
              value={received}
              onChange={(e) => setReceived(e.target.value)}
            />
          </Field>
          {method === "external" && (
            <>
              <p className="warning-panel">{t("externalHint")}</p>
              <Field label={t("reference")}>
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </Field>
              <label className="option">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t("confirmExternal")}
              </label>
            </>
          )}
          <div className="row between">
            <span>{t("change")}</span>
            <strong>
              {money(
                Math.max(
                  0,
                  Math.round(
                    (Number(received) - Number(amount) - Number(tip)) * scale,
                  ) || 0,
                ),
              )}
            </strong>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
      {receipt && (
        <Modal
          title={receipt.state === "local" ? t("localReceipt") : t("receipt")}
          close={() => setReceipt(null)}
          closeLabel={t("close")}
        >
          <div className="receipt">
            <h2>Green Monkey</h2>
            <p>{receipt.restaurantSnapshot?.name ?? session.restaurant.name}</p>
            <Badge tone="green">
              {receipt.state === "local"
                ? t("pending")
                : receipt.paid >= receipt.total
                  ? t("paid")
                  : t("partial")}
            </Badge>
            {provisionalOnly(receipt) && (
              <p>
                <strong>
                  {fmt(t("offlineProvisional"), {
                    n: receipt.offline!.provisionalNumber!,
                  })}
                </strong>
                <br />
                <span className="tiny muted">
                  {t("offlineProvisionalHint")}
                </span>
              </p>
            )}
            <p>
              {orderLabel(receipt)} ·{" "}
              {new Date(receipt.createdAt).toLocaleString(locale, {
                timeZone:
                  receipt.restaurantSnapshot?.timezone ??
                  session.restaurant.timezone,
              })}
            </p>
            {receipt.recovery && (
              <p>
                {locale === "es"
                  ? "Efectivo conciliado. Cocina e inventario requieren revisión manual."
                  : "Cash reconciled. Kitchen and inventory require manual review."}
                <br />
                {receipt.recovery.reason}
              </p>
            )}
            {receipt.lines
              .filter((l) => lineRemaining(l).quantity > 0)
              .map((l) => (
                <div className="row between" key={l.id}>
                  <span>
                    {lineRemaining(l).quantity} × {l.name[locale]}
                  </span>
                  <strong>{money(lineRemaining(l).total)}</strong>
                </div>
              ))}
            <hr />
            <div className="row between">
              <span>{t("total")}</span>
              <strong>{money(receipt.total)}</strong>
            </div>
            <div className="row between">
              <span>{t("paid")}</span>
              <strong>{money(receipt.paid)}</strong>
            </div>
            <div className="row between">
              <span>{t("remaining")}</span>
              <strong>{money(receipt.total - receipt.paid)}</strong>
            </div>
          </div>
          <p className="muted tiny">{t("receiptPrintHint")}</p>
          <div className="row">
            <Button onClick={() => window.print()}>{t("print")}</Button>
            {receipt.state === "local" && receiptOps.length > 0 && (
              <Button onClick={() => void offline.printKitchen(receiptOps)}>
                {t("offlinePrintKitchen")}
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() =>
                receipt.paid >= receipt.total ? reset() : setReceipt(null)
              }
            >
              {t(receipt.paid >= receipt.total ? "nextSale" : "back")}
            </Button>
          </div>
        </Modal>
      )}
      {openOrders && (
        <OfflineOrdersModal
          session={session}
          locale={locale}
          close={() => setOpenOrders(false)}
          onPick={(order) => {
            setCurrent(order);
            setDraft({
              ...fresh(),
              mode: order.mode as OrderInput["mode"],
              tableId: order.tableId,
              name: order.name,
            });
            setOpenOrders(false);
          }}
        />
      )}
      {parked && (
        <Modal
          title={t("drafts")}
          close={() => setParked(null)}
          closeLabel={t("close")}
        >
          {!parked.length ? (
            <Empty title={t("noData")} />
          ) : (
            parked.map((d) => (
              <Button
                className="full"
                key={d.id}
                onClick={async () => {
                  setDraft(d.order);
                  setCurrent(null);
                  await db.drafts.delete(d.id);
                  setParked(null);
                }}
              >
                {d.order.name || t("order")} · {d.order.lines.length}{" "}
                {t("items")}
              </Button>
            ))
          )}
        </Modal>
      )}
    </div>
  );
}
