import { lineRemaining } from "../../shared/settlement";
import { currencyExponent } from "../../shared/domain";
import { normalizePaymentAttempt } from "../../shared/offline-recovery";
import { useEffect, useRef, useState } from "react";
import {
  Search,
  Plus,
  ArrowUpRight,
  ShoppingBag,
  Send,
  Pause,
  Printer,
  SlidersHorizontal,
} from "lucide-react";
import {
  type Session,
  type Product,
  type Locale,
  type OrderInput,
  type Order,
  type Label,
} from "../../shared/domain";
import {
  mergeLine,
  priceCart,
  reconcileLostSend,
  type PaymentValues,
} from "../../shared/service";
import { strings, translateError, type Key } from "../i18n";
import { api, ApiError } from "../api";
import { clearPaymentAttempt, db, scope, type Draft } from "../offline";
import { Button, Field, Empty, Modal, Badge } from "../components/ui";
import { useMediaQuery } from "../serviceHooks";
import {
  PrintSettingsDialog,
  printDocument,
  readPrintSettings,
} from "../print";
import { CartLine } from "./CartLine";
import { PaymentDialog } from "./PaymentDialog";
import { ReceiptModal, checkStateOf } from "./Receipt";
import { NoteDialog } from "./OrderDetail";
import {
  KitchenTicketDocument,
  ticketsForOpenRounds,
  ticketsFromOrderRound,
  type KitchenTicketModel,
} from "./KitchenTicket";
const fresh = (): OrderInput => ({
  operationId: crypto.randomUUID(),
  lines: [],
  mode: "takeaway",
  tableId: null,
  name: "",
  note: "",
  channel: "pos",
});
/** Codes after which the catalog is refetched (menu owns the listener, D2). */
const CATALOG_CODES = [
  "unavailable",
  "invalid_modifier",
  "required_modifier",
  "open_amount_exceeds",
];
/**
 * An error whose message Selling already showed in its own words. `offerNew`
 * marks the cases where the cart offers "Enviar como orden nueva".
 */
class HandledError extends Error {
  constructor(
    code: string,
    public offerNew = false,
  ) {
    super(code);
  }
}
/** A parked cart, and the check it was a round for (null for a new order). */
type ParkedDraft = {
  draft: Draft;
  order: { id: string; number: number } | null;
};
export function Selling({
  session,
  catalog,
  locale,
  online,
  active,
  navigate,
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
  const [parked, setParked] = useState<ParkedDraft[] | null>(null);
  const [tables, setTables] = useState<any[]>([]);
  const [cashSession, setCashSession] = useState<any>(null);
  const [notice, setNotice] = useState("");
  /** Offers "Enviar como orden nueva" (closed check or unconfirmed send). */
  const [closedCheck, setClosedCheck] = useState(false);
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  /** The order whose open comandas can be reprinted after a note edit. */
  const [noteReprint, setNoteReprint] = useState<Order | null>(null);
  /** SVC-R2: one payment request at a time, from the tap until it settles. */
  const [paying, setPaying] = useState(false);
  const payingRef = useRef(false);
  const nameCache = useRef(new Map<string, Label>());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const currentRef = useRef(current);
  currentRef.current = current;
  const releaseKey = useRef(crypto.randomUUID());
  const compact = useMediaQuery("(max-height: 820px) and (min-width: 801px)");
  const paymentKey = useRef(crypto.randomUUID());
  const search = useRef<HTMLInputElement>(null);
  const activeId = scope(session) + ":active";
  const contextId = scope(session) + ":order";
  const attemptId = scope(session) + ":payment";
  /** Service-owned record of the check a parked round belongs to. */
  const parkedOrderId = (operationId: string) =>
    scope(session) + ":parked-order:" + operationId;
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
    return api<Order>("/payments/recovery/retry", attempt);
  }
  /**
   * Stores a cart in Borradores. A cart of rounds for an existing check keeps
   * that check, so restoring it sends a round instead of a new order.
   */
  async function parkDraft(d: OrderInput, order: Order | null) {
    await db.drafts.put({
      id: d.operationId,
      scope: scope(session),
      order: d,
      updatedAt: Date.now(),
    });
    if (order)
      await db.cache.put({
        id: parkedOrderId(d.operationId),
        value: { id: order.id, number: order.number },
      });
    else await db.cache.delete(parkedOrderId(d.operationId));
  }
  /** Keeps unsent lines in Borradores before another order replaces the cart. */
  async function parkCurrentCart() {
    const d = draftRef.current;
    if (!d.lines.length) return false;
    await parkDraft(d, currentRef.current);
    return true;
  }
  async function openDrafts() {
    const drafts = (
      await db.drafts.where("scope").equals(scope(session)).toArray()
    ).filter((d) => d.id !== activeId);
    setParked(
      await Promise.all(
        drafts.map(async (draft) => {
          const value = (await db.cache.get(parkedOrderId(draft.id)))?.value;
          return {
            draft,
            order:
              value && typeof value.id === "string"
                ? { id: value.id as string, number: Number(value.number) }
                : null,
          };
        }),
      ),
    );
  }
  /** SVC-R5: a parked round goes back onto its check while it is not closed. */
  async function restoreDraft({ draft: d, order: parkedOrder }: ParkedDraft) {
    let target: Order | null = null;
    if (parkedOrder) {
      try {
        target = await api<Order>("/orders/" + parkedOrder.id);
      } catch (e) {
        // Without the check the round cannot be placed; it stays parked.
        setParked(null);
        setError(translateError((e as Error).message, locale));
        return;
      }
    }
    const parkedCart = await parkCurrentCart();
    setDraft(d.order);
    await db.drafts.delete(d.id);
    await db.cache.delete(parkedOrderId(d.id));
    setParked(null);
    setError("");
    setClosedCheck(false);
    setNoteReprint(null);
    setNotice(parkedCart ? t("serviceDraftParked") : "");
    if (target && checkStateOf(target) !== "closed") {
      setCurrent(target);
      await db.cache.put({ id: contextId, value: target.id });
      return;
    }
    setCurrent(null);
    await db.cache.delete(contextId);
    if (target) {
      setClosedCheck(true);
      setError(t("serviceCheckClosedKeep"));
    }
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
              // A cached context that points at a closed check is dropped.
              if (live && checkStateOf(o) === "closed")
                void db.cache.delete(contextId);
              else if (live) setCurrent(o);
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
      void api<Order>("/orders/" + resume)
        .then(async (o) => {
          const parkedCart = await parkCurrentCart();
          const notes = parkedCart ? [t("serviceDraftParked")] : [];
          if (checkStateOf(o) === "closed") {
            // A closed check cannot take rounds: start a new order instead.
            setNotice(
              [
                ...notes,
                t("serviceResumeClosed").replace("{n}", String(o.number)),
              ].join(" "),
            );
            setCurrent(null);
            void db.cache.delete(contextId);
            setDraft(fresh());
            return;
          }
          setNotice(notes.join(" "));
          setCurrent(o);
          void db.cache.put({ id: contextId, value: o.id });
          setDraft({
            ...fresh(),
            mode: o.mode as OrderInput["mode"],
            tableId: o.tableId,
            name: o.name,
          });
        })
        .catch((e) => setError(translateError((e as Error).message, locale)));
    }
    const table = localStorage.getItem("gm-table");
    if (table) {
      // A new check for a table never adds rounds to the order on screen.
      localStorage.removeItem("gm-table");
      void parkCurrentCart().then((parkedCart) => {
        setNotice(parkedCart ? t("serviceDraftParked") : "");
        setCurrent(null);
        void db.cache.delete(contextId);
        setDraft({ ...fresh(), mode: "dine_in", tableId: table });
      });
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
  useEffect(() => {
    // One key per opened receipt, kept across retries of "Liberar mesa".
    releaseKey.current = crypto.randomUUID();
  }, [receipt?.id]);
  useEffect(() => {
    if (!lastAddedId) return;
    const timer = setTimeout(() => setLastAddedId(null), 600);
    return () => clearTimeout(timer);
  }, [lastAddedId]);
  const cart = priceCart(draft.lines, catalog, true);
  const priced = cart.lines.flatMap((l) => (l.priced ? [l.priced] : []));
  const draftTotal = cart.total;
  for (const l of priced) nameCache.current.set(l.id, l.name);
  const due = (current ? current.total - current.paid : 0) + draftTotal;
  const drawerOpen = !!cashSession && !cashSession.closed_at;
  const categories = [...new Set(catalog.map((p) => p.category[locale]))];
  const filtered = catalog.filter(
    (p) =>
      (!category || p.category[locale] === category) &&
      p.name[locale].toLowerCase().includes(query.toLowerCase()),
  );
  const inCart = new Map<string, number>();
  for (const l of draft.lines)
    inCart.set(l.productId, (inCart.get(l.productId) ?? 0) + l.quantity);
  function add(
    p: Product,
    selection: string[] | { options: string[]; openAmount?: number } = {
      options: [],
    },
  ) {
    const choice = Array.isArray(selection)
      ? { options: selection }
      : selection;
    const r = mergeLine(draftRef.current.lines, p, choice);
    // Keep the ref current so two quick taps before a render both count.
    draftRef.current = { ...draftRef.current, lines: r.lines };
    setDraft((d) => ({ ...d, lines: r.lines }));
    setLastAddedId(r.lineId);
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
    setNotice("");
    setClosedCheck(false);
    setNoteReprint(null);
  }
  function printNewRound(o: Order) {
    printRounds(o, [Math.max(0, ...o.lines.map((l) => l.round ?? 0))]);
  }
  function printRounds(o: Order, rounds: number[]) {
    printTickets(rounds.flatMap((round) => ticketsFromOrderRound(o, round)));
  }
  function printTickets(tickets: KitchenTicketModel[]) {
    if (!tickets.length) return;
    void printDocument(
      tickets.map((ticket, i) => (
        <KitchenTicketDocument
          key={i}
          ticket={ticket}
          locale={locale}
          timezone={session.restaurant.timezone}
        />
      )),
    );
  }
  async function sendWith(
    target: Order | null,
    d: OrderInput,
    /** Set by Cobrar, which keeps the screen busy until the payment settles. */
    opts: { keepBusy?: boolean } = {},
  ): Promise<Order> {
    setBusy(true);
    setError("");
    setNotice("");
    setClosedCheck(false);
    setNoteReprint(null);
    try {
      const o = await api<Order>(
        target ? `/orders/${target.id}/rounds` : "/orders",
        target ? { ...d, expectedVersion: target.version } : d,
      );
      setCurrent(o);
      await db.cache.put({ id: contextId, value: o.id });
      setDraft((x) => ({
        ...x,
        operationId: crypto.randomUUID(),
        lines: [],
        note: "",
      }));
      if (readPrintSettings().kitchenOnSend) printNewRound(o);
      return o;
    } catch (e) {
      const code = (e as Error).message;
      if (code === "stale_order" && target) {
        // Refresh in place; the unsent lines and their operation id stay.
        try {
          const latest = await api<Order>("/orders/" + target.id);
          setCurrent(latest);
          if (checkStateOf(latest) === "closed") {
            setClosedCheck(true);
            setError(t("serviceCheckClosedKeep"));
            throw new HandledError(code, true);
          }
          setNotice(t("serviceStaleRefreshed"));
        } catch (refresh) {
          if (refresh instanceof HandledError) throw refresh;
          setError(translateError((refresh as Error).message, locale));
        }
        throw new HandledError(code);
      }
      if (code === "check_closed") {
        setClosedCheck(true);
        setError(t("serviceCheckClosedKeep"));
        throw new HandledError(code, true);
      }
      if (code === "operation_conflict") {
        // FOH-11: an earlier send with this operation id committed but its
        // response was lost, and the cart changed since. Load the order it
        // produced, drop the lines it already holds and give the rest a new
        // operation id (the old one is consumed), so nothing is sent twice.
        const latest = await api<Order>(
          `/service/operations/${d.operationId}/order`,
        ).catch(() =>
          target ? api<Order>("/orders/" + target.id).catch(() => null) : null,
        );
        if (latest) {
          const operationId = crypto.randomUUID();
          const next = reconcileLostSend(d, latest, operationId);
          setCurrent(latest);
          await db.cache.put({ id: contextId, value: latest.id });
          setDraft((x) => reconcileLostSend(x, latest, operationId).draft);
          if (readPrintSettings().kitchenOnSend)
            printRounds(latest, next.rounds);
          if (next.sent) return latest;
          if (checkStateOf(latest) === "closed") {
            setClosedCheck(true);
            setError(t("serviceCheckClosedKeep"));
            throw new HandledError(code, true);
          }
          // SVC-R3: a landed line edited afterwards is never dropped silently.
          setNotice(
            t(next.changed ? "serviceSendChanged" : "serviceSendRecovered"),
          );
          throw new HandledError(code);
        }
        if (!target) {
          // The outcome is unknown: the cashier checks Órdenes first, and only
          // "Enviar como orden nueva" gives the cart a new operation id.
          setClosedCheck(true);
          setError(t("serviceSendUnconfirmed"));
          throw new HandledError(code, true);
        }
      }
      if (CATALOG_CODES.includes(code))
        window.dispatchEvent(new Event("gm-menu-refresh"));
      setError(translateError(code, locale));
      throw new HandledError(code);
    } finally {
      if (!opts.keepBusy) setBusy(false);
    }
  }
  const send = () => sendWith(current, draft);
  async function sendAsNew() {
    const d = { ...draft, operationId: crypto.randomUUID() };
    await db.cache.delete(contextId);
    setCurrent(null);
    setDraft(d);
    return sendWith(null, d);
  }
  function openPay() {
    // One key per opened dialog (MON-3): a duplicate submit replays the stored
    // result instead of recording a second tender.
    paymentKey.current = crypto.randomUUID();
    if (online)
      void api("/cash")
        .then(setCashSession)
        .catch(() => {});
    setPayment(true);
    setError("");
    setNotice("");
  }
  /**
   * SVC-R2: the in-flight flag is set synchronously on the tap and cleared
   * only when the whole collect (send, payment, recovery) settles, so a second
   * tap can never queue another payment behind the lock.
   */
  function startCollect(values: PaymentValues | null, items?: string[]) {
    if (payingRef.current) return;
    payingRef.current = true;
    setPaying(true);
    void collect(values, items)
      .catch((e) => setError(translateError((e as Error).message, locale)))
      .finally(() => {
        payingRef.current = false;
        setPaying(false);
      });
  }
  async function collect(
    values: PaymentValues | null = null,
    items?: string[],
  ) {
    return navigator.locks.request(
      "green-monkey-session-transition",
      { mode: "shared" },
      () =>
        navigator.locks.request("green-monkey-payment:" + scope(session), () =>
          collectLocked(values, items),
        ),
    );
  }
  async function collectLocked(values: PaymentValues | null, items?: string[]) {
    let submittedAttempt: unknown;
    setBusy(true);
    setError("");
    try {
      const previous = await db.cache.get(attemptId);
      if (previous) {
        const result = await recoverPayment(previous.value);
        await clearPaymentAttempt(attemptId, previous.value);
        setCurrent(result);
        setPendingPayment(false);
        setPayment(false);
        setReceipt(result);
        return;
      }
      if (!values) throw new Error("invalid_input");
      const n = values.amount,
        cash = values.received,
        tips = values.tip;
      if (!online) {
        if (
          current ||
          !cashSession ||
          cashSession.closed_at ||
          values.method !== "cash" ||
          session.sellingAllowed === false ||
          new Date(session.offlineUntil) < new Date() ||
          n !== draftTotal ||
          cash < n + tips
        )
          throw new Error("offline_conflict");
        const operationId = paymentKey.current;
        const receiptSnapshot = {
          lines: priced,
          restaurant: session.restaurant,
        };
        await db.pending.put({
          id: operationId,
          scope: scope(session),
          receipt: receiptSnapshot,
          body: {
            formatVersion: 2,
            operationId,
            order: draft,
            expectedTotal: draftTotal,
            received: cash,
            tip: tips,
            recordedAt: new Date().toISOString(),
            sessionId: session.id,
            cashSessionId: cashSession.id,
            tenantId: session.tenantId,
            employeeId: session.employeeId,
            deviceId: session.deviceId,
            leaseVersion: session.offlineLeaseVersion ?? 0,
            currency: session.restaurant.currency,
            currencyExponent: exponent,
            configurationVersion: session.restaurant.configVersion ?? null,
            receiptSnapshot,
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
      // MON-8: nothing reaches the kitchen unless this device has an open drawer.
      if (!drawerOpen) throw new Error("drawer_required");
      let o = current;
      if (draft.lines.length)
        o = await sendWith(current, draft, { keepBusy: true });
      if (!o) throw new Error("invalid_input");
      const payload = {
        operationId: paymentKey.current,
        amount: values.amount,
        tip: values.tip,
        received: values.received,
        method: values.method,
        // Always present: the stored attempt (paymentAttemptV1) requires both,
        // and cash sends the server defaults, so the fingerprint is unchanged.
        externalConfirmed: values.method === "external" && values.confirmed,
        reference: values.method === "external" ? values.reference.trim() : "",
        ...(items ? { items } : {}),
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
      const result = await api<Order>(`/orders/${o.id}/payments`, payload);
      await clearPaymentAttempt(attemptId, submittedAttempt);
      setCurrent(result);
      setPendingPayment(false);
      setPayment(false);
      setReceipt(result);
    } catch (e) {
      if (
        submittedAttempt &&
        e instanceof ApiError &&
        [400, 404, 409].includes(e.status) &&
        e.message !== "operation_conflict"
      )
        await clearPaymentAttempt(attemptId, submittedAttempt);
      setPendingPayment(!!(await db.cache.get(attemptId)));
      if (!(e instanceof HandledError))
        setError(translateError((e as Error).message, locale));
      // "Enviar como orden nueva" lives in the cart: close the dialog for it.
      else if (e.offerNew) setPayment(false);
    } finally {
      setBusy(false);
    }
  }
  async function release(order: Order) {
    await api(`/service/orders/${order.id}/close`, {
      operationId: releaseKey.current,
    });
    reset();
  }
  const checkState = current ? checkStateOf(current) : null;
  const tableName = tables.find((tb) => tb.id === draft.tableId)?.name;
  const nameField = (
    <Field label={t("name")}>
      <input
        value={draft.name}
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        placeholder={t("name")}
      />
    </Field>
  );
  const tableField = draft.mode === "dine_in" && (
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
  );
  const noteField = (
    <Field label={t(current ? "serviceRoundNote" : "serviceOrderNoteField")}>
      <input
        value={draft.note}
        maxLength={500}
        placeholder={t(current ? "serviceRoundNote" : "serviceOrderNoteField")}
        onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
      />
    </Field>
  );
  const cartPanel = (
    <>
      <div className="cart-heading">
        <div>
          <span className="eyebrow">
            {current ? "#" + current.number : t("newOrder")}
          </span>
          <h2>{t("order")}</h2>
        </div>
        <div className="row cart-badges">
          {checkState && (
            <Badge
              tone={
                checkState === "closed"
                  ? "neutral"
                  : checkState === "paid"
                    ? "green"
                    : "amber"
              }
            >
              <span className="check-badge">
                {t(
                  checkState === "closed"
                    ? "serviceCheckClosed"
                    : checkState === "paid"
                      ? "serviceCheckPaid"
                      : "serviceCheckOpen",
                )}
              </span>
            </Badge>
          )}
          <Badge tone={online ? "green" : "amber"}>
            {online
              ? current
                ? t("sent")
                : saved
                  ? t("saved")
                  : t("loading")
              : t("offline")}
          </Badge>
          <Button
            variant="ghost"
            className="round"
            aria-label={t("servicePrintSettings")}
            onClick={() => setPrintOpen(true)}
          >
            <Printer size={18} />
          </Button>
        </div>
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
      {compact ? (
        <button
          type="button"
          className="cart-details-summary"
          onClick={() => setDetailsOpen(true)}
        >
          <SlidersHorizontal size={16} />
          <strong>{t("serviceDetailsButton")}</strong>
          <span>
            {[
              t(draft.mode),
              draft.name || t("serviceUnnamed"),
              ...(draft.mode === "dine_in" ? [tableName ?? t("noTable")] : []),
              ...(draft.note ? [draft.note] : []),
            ].join(" · ")}
          </span>
        </button>
      ) : (
        <div className="cart-fields">
          {nameField}
          {tableField}
        </div>
      )}
      <div className="cart-lines">
        {current && (
          <div className="existing">
            <strong>
              #{current.number} · {t("sent")}
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
            {current.note && (
              <p className="line-note">
                {t("serviceOrderNoteLabel").replace("{note}", current.note)}
              </p>
            )}
            {checkState !== "closed" && (
              <Button
                variant="ghost"
                className="small"
                onClick={() => setNoteDialogOpen(true)}
              >
                {t("serviceDetailEditNote")}
              </Button>
            )}
          </div>
        )}
        {!draft.lines.length && !current ? (
          <Empty title={t("emptyCart")} detail={t("emptyHint")} />
        ) : (
          cart.lines.map((line) => (
            <CartLine
              key={line.input.id}
              line={line}
              product={catalog.find((p) => p.id === line.input.productId)}
              fallbackName={nameCache.current.get(line.input.id)}
              locale={locale}
              money={money}
              justAdded={lastAddedId === line.input.id}
              onQuantity={(delta) =>
                setDraft((d) => ({
                  ...d,
                  lines: d.lines.flatMap((l) =>
                    l.id === line.input.id
                      ? l.quantity + delta < 1
                        ? []
                        : [
                            {
                              ...l,
                              quantity: Math.min(99, l.quantity + delta),
                            },
                          ]
                      : [l],
                  ),
                }))
              }
              onRemove={() =>
                setDraft((d) => ({
                  ...d,
                  lines: d.lines.filter((l) => l.id !== line.input.id),
                }))
              }
              onNote={(note) =>
                setDraft((d) => ({
                  ...d,
                  lines: d.lines.map((l) =>
                    l.id === line.input.id ? { ...l, note } : l,
                  ),
                }))
              }
            />
          ))
        )}
      </div>
      <div className="cart-bottom">
        {!compact && (
          <>
            {noteField}
            {!current && (
              <p className="muted tiny note-hint">
                {t("serviceOrderNoteHint")}
              </p>
            )}
          </>
        )}
        <div className="total">
          <span>{t("amountDue")}</span>
          <strong>{money(due)}</strong>
        </div>
        {cart.blocked && (
          <p className="warning-panel" role="status">
            {t("serviceCartBlocked")}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {noteReprint && (
          <Button
            className="small"
            onClick={() => printTickets(ticketsForOpenRounds(noteReprint))}
          >
            <Printer size={16} />
            {t("serviceReprintKitchen")}
          </Button>
        )}
        {error && (
          <div className="error" role="alert">
            <p>{error}</p>
            {closedCheck && (
              <Button
                disabled={busy || !online}
                onClick={() => void sendAsNew().catch(() => {})}
              >
                {t("serviceSendAsNew")}
              </Button>
            )}
          </div>
        )}
        <div className="row">
          <Button
            disabled={!draft.lines.length || busy || !online || cart.blocked}
            onClick={() => void send().catch(() => {})}
          >
            <Send size={16} />
            {t("send")}
          </Button>
          <Button
            variant="primary"
            disabled={due <= 0 || busy || paying || cart.blocked}
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
              await parkDraft(draft, current);
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
                  disabled={!online || busy || paying}
                  onClick={() => startCollect(null)}
                >
                  {t("retryPayment")}
                </Button>
              </div>
            )}
          </div>
          <Button
            disabled={pendingPayment}
            onClick={async () => {
              if (draft.lines.length) await parkDraft(draft, current);
              reset();
            }}
          >
            {t("newOrder")}
          </Button>
          <Button onClick={() => void openDrafts()}>{t("drafts")}</Button>
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
              {(inCart.get(p.id) ?? 0) > 0 && (
                <span className="in-cart">
                  ·{" "}
                  {t("serviceInCart").replace("{n}", String(inCart.get(p.id)))}
                </span>
              )}
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
      <aside className="cart">{cartPanel}</aside>
      {cartOpen && (
        <Modal
          title={t("order")}
          close={() => setCartOpen(false)}
          closeLabel={t("close")}
        >
          {cartPanel}
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
        <PaymentDialog
          due={due}
          current={current}
          hasDraftLines={draft.lines.length > 0}
          session={session}
          locale={locale}
          online={online}
          busy={busy || paying}
          pendingPayment={pendingPayment}
          drawerOpen={drawerOpen}
          error={error}
          notice={notice}
          onConfirm={(values, items) => startCollect(values, items)}
          onSplitItems={async () => {
            if (!draft.lines.length && !current) return null;
            // SVC-R8: nothing reaches the kitchen without an open drawer.
            if (online && !drawerOpen) throw new Error("drawer_required");
            try {
              const order = draft.lines.length
                ? await send()
                : await api<Order>("/orders/" + current!.id);
              setCurrent(order);
              return order;
            } catch (e) {
              if (!(e instanceof HandledError)) throw e;
              // Selling's notice or error already says what happened.
              if (e.offerNew) setPayment(false);
              return null;
            }
          }}
          onClose={() => setPayment(false)}
          onGoToCash={() => {
            setPayment(false);
            navigate("cash");
          }}
        />
      )}
      {receipt && (
        <ReceiptModal
          order={receipt}
          session={session}
          locale={locale}
          onNext={reset}
          onBack={() => setReceipt(null)}
          onRelease={
            receipt.state !== "local" && checkStateOf(receipt) === "paid"
              ? () => release(receipt)
              : undefined
          }
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
            parked.map((p) => (
              <Button
                className="full"
                key={p.draft.id}
                onClick={() => void restoreDraft(p)}
              >
                {p.order &&
                  t("serviceDraftRound").replace(
                    "{n}",
                    String(p.order.number),
                  ) + " · "}
                {p.draft.order.name || t("order")} ·{" "}
                {p.draft.order.lines.length} {t("items")}
              </Button>
            ))
          )}
        </Modal>
      )}
      {detailsOpen && (
        <Modal
          title={t("serviceDetailsTitle")}
          close={() => setDetailsOpen(false)}
          closeLabel={t("close")}
        >
          {nameField}
          {tableField}
          {noteField}
          {!current && (
            <p className="muted tiny">{t("serviceOrderNoteHint")}</p>
          )}
          <Button
            variant="primary"
            className="full"
            onClick={() => setDetailsOpen(false)}
          >
            {t("serviceLineNoteDone")}
          </Button>
        </Modal>
      )}
      {noteDialogOpen && current && (
        <NoteDialog
          order={current}
          locale={locale}
          close={() => setNoteDialogOpen(false)}
          saved={(o) => {
            setCurrent(o);
            setNotice(t("serviceDetailNoteSaved"));
            // Paper comandas printed at send time keep the old note.
            if (readPrintSettings().kitchenOnSend) setNoteReprint(o);
          }}
        />
      )}
      {printOpen && (
        <PrintSettingsDialog
          locale={locale}
          scope="selling"
          close={() => setPrintOpen(false)}
        />
      )}
    </div>
  );
}
