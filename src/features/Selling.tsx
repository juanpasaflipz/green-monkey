import { currencyExponent } from "../../shared/domain";
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
import { db, scope, type Draft } from "../offline";
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
            const o = await api<Order>(
              "/orders/" + a.value.orderId + "/payments",
              a.value.payload,
            );
            await db.cache.delete(attemptId);
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
          if (live) setError(translateError((e as Error).message, locale));
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
  }
  async function send() {
    setBusy(true);
    setError("");
    try {
      const o = await api<Order>(
        current ? `/orders/${current.id}/rounds` : "/orders",
        current ? { ...draft, expectedVersion: current.version } : draft,
      );
      setCurrent(o);
      await db.cache.put({ id: contextId, value: o.id });
      setDraft((d) => ({ ...d, operationId: crypto.randomUUID(), lines: [] }));
      return o;
    } catch (e) {
      setError(translateError((e as Error).message, locale));
      throw e;
    } finally {
      setBusy(false);
    }
  }
  function openPay() {
    setSplitItems(false);
    setSelectedItems([]);
    setAmount((due / scale).toFixed(exponent));
    setReceived((due / scale).toFixed(exponent));
    setTip("0");
    paymentKey.current = crypto.randomUUID();
    setPayment(true);
    setError("");
  }
  async function collect() {
    setBusy(true);
    setError("");
    try {
      const previous = await db.cache.get(attemptId);
      if (previous) {
        const result = await api<Order>(
          `/orders/${previous.value.orderId}/payments`,
          previous.value.payload,
        );
        await db.cache.delete(attemptId);
        setCurrent(result);
        setPendingPayment(false);
        setPayment(false);
        setReceipt(result);
        paymentKey.current = crypto.randomUUID();
        return;
      }
      const n = parseAmount(amount),
        cash = parseAmount(received),
        tips = parseAmount(tip);
      if (!online) {
        if (
          current ||
          !cashSession ||
          cashSession.closed_at ||
          method !== "cash" ||
          new Date(session.offlineUntil) < new Date() ||
          n !== draftTotal ||
          cash < n + tips
        )
          throw new Error("offline_conflict");
        const operationId = paymentKey.current;
        await db.pending.put({
          id: operationId,
          scope: scope(session),
          body: {
            operationId,
            order: draft,
            expectedTotal: draftTotal,
            received: cash,
            tip: tips,
            recordedAt: new Date().toISOString(),
            sessionId: session.id,
            cashSessionId: cashSession.id,
          },
          status: "pending",
          attempts: 0,
          nextAt: 0,
        });
        await db.drafts.delete(activeId);
        setReceipt({
          id: operationId,
          number: 0,
          version: 1,
          lines: priced,
          total: draftTotal,
          paid: 0,
          refunded: 0,
          state: "local",
          mode: draft.mode,
          tableId: draft.tableId,
          name: draft.name,
          note: draft.note,
          createdAt: new Date().toISOString(),
          rounds: [],
          tenders: [],
        });
        setPayment(false);
        setDraft(fresh());
        return;
      }
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
      await db.cache.put({ id: attemptId, value: { orderId: o.id, payload } });
      setPendingPayment(true);
      const result = await api<Order>(`/orders/${o.id}/payments`, payload);
      await db.cache.delete(attemptId);
      setCurrent(result);
      setPendingPayment(false);
      setPayment(false);
      setReceipt(result);
      paymentKey.current = crypto.randomUUID();
    } catch (e) {
      if (
        e instanceof ApiError &&
        [400, 404, 409].includes(e.status) &&
        e.message !== "operation_conflict"
      )
        await db.cache.delete(attemptId);
      setPendingPayment(!!(await db.cache.get(attemptId)));
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
            {current ? "#" + current.number : t("newOrder")}
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
              #{current.number} · {t("sent")}
            </strong>
            <p>
              {current.lines
                .map((l) => `${l.quantity} × ${l.name[locale]}`)
                .join(", ")}
            </p>
            <span>
              {money(current.total)} · {t("paid")}: {money(current.paid)}
            </span>
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
        <div className="row">
          <Button
            disabled={!draft.lines.length || busy || !online}
            onClick={() => void send().catch(() => {})}
          >
            <Send size={16} />
            {t("send")}
          </Button>
          <Button
            variant="primary"
            disabled={due <= 0 || busy}
            onClick={openPay}
          >
            {t("pay")}
            <ArrowUpRight size={18} />
          </Button>
        </div>
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
                  onClick={() => void collect()}
                >
                  {t("retryPayment")}
                </Button>
              </div>
            )}
          </div>
          <Button
            disabled={pendingPayment}
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
                disabled={busy || (splitItems && !selectedItems.length)}
                onClick={() => void collect()}
              >
                {busy ? t("loading") : t(online ? "confirmPay" : "saveOffline")}
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
          {!online && <p className="warning-panel">{t("offlineHint")}</p>}
          <div className="service-tabs">
            <button
              className={method === "cash" ? "selected" : ""}
              onClick={() => setMethod("cash")}
            >
              {t("cashMethod")}
            </button>
            <button
              disabled={!online}
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
            <p>
              #{receipt.number || receipt.id.slice(0, 8)} ·{" "}
              {new Date(receipt.createdAt).toLocaleString(locale, {
                timeZone:
                  receipt.restaurantSnapshot?.timezone ??
                  session.restaurant.timezone,
              })}
            </p>
            {receipt.lines.map((l) => (
              <div className="row between" key={l.id}>
                <span>
                  {l.quantity} × {l.name[locale]}
                </span>
                <strong>{money(l.total)}</strong>
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
            <Button
              variant="primary"
              onClick={() =>
                receipt.paid >= receipt.total || receipt.state === "local"
                  ? reset()
                  : setReceipt(null)
              }
            >
              {t(
                receipt.paid >= receipt.total || receipt.state === "local"
                  ? "nextSale"
                  : "back",
              )}
            </Button>
          </div>
        </Modal>
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
