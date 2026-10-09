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
  idSequence,
  type PaymentValues,
} from "../../shared/service";
import {
  strings,
  errorNotice,
  errorSentence,
  translateError,
  type Key,
} from "../i18n";
import { api, ApiError, isSessionRejection } from "../api";
import {
  attemptsForOrder,
  clearPaymentAttempt,
  db,
  parkPaymentAttempt,
  scope,
  syncPending,
  type Draft,
} from "../offline";
import { drawerKey, rememberDrawer } from "./cash/drawer-cache";
import type { DrawerView } from "./cash/DrawerCloseDialog";
import { useOfflineSelling } from "./offline/useOfflineSelling";
import { useOfflineCurrent } from "./offline/useOfflineCurrent";
import { OfflineOrdersModal } from "./offline/OfflineOrdersModal";
import { fmt, orderLabel, parkedOrderLabel } from "./offline/format";
import { DraftGoneEntry, draftEntryText } from "./DraftEntry";
import { currentBusinessDate, orderNumberText } from "../labels";
import {
  isServerOrder,
  parkedOrderRef,
  parkedOrderValue,
  pinnedParkedOrder,
  resolveParkedOrder,
  resolveParkedOrderToResume,
  type LocalOrderView,
  type ParkedOrderRef,
  type ParkedOrderTarget,
} from "../offline-records";
import { DiscountButton } from "./discounts/DiscountButton";
import { CheckDiscountSummary } from "./discounts/OrderAdjustments";
import { Button, Field, Empty, Modal, Badge } from "../components/ui";
import { useMediaQuery } from "../serviceHooks";
import {
  PrintSettingsDialog,
  printDocument,
  readPrintSettings,
} from "../print";
import { CartLine } from "./CartLine";
import { PaymentDialog } from "./PaymentDialog";
import { ReceiptModal, checkStateOf, noteEditableOf } from "./Receipt";
import { NoteDialog } from "./OrderDetail";
import {
  KitchenTicketDocument,
  ticketsForOpenRounds,
  ticketsFromOrderRound,
  type KitchenTicketModel,
} from "./KitchenTicket";
import { ModifierPicker } from "../components/ModifierPicker";
import { pickerNeeded, orderable } from "../../shared/menu";
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
  order: ParkedOrderRef | null;
  /** How the list names the order: "#12", "B-07" or "B-07 → #12" (LD-13 addendum). */
  label: string | null;
  /** The order no longer exists on this device or on the server: only discard. */
  gone: boolean;
};
export function Selling({
  session,
  catalog,
  locale,
  online,
  active,
  navigate,
  onPaymentSettled: onPaymentSettledProp,
}: {
  session: Session;
  catalog: Product[];
  locale: Locale;
  online: boolean;
  active: boolean;
  navigate: (s: string) => void;
  /**
   * payments (037, critic R18): the one exit for "a payment settled on the
   * server", whatever the method (cash, manual terminal, platform; P2's
   * integrated charges). Loyalty's post-payment link hangs only on this.
   */
  onPaymentSettled?: (order: Order) => void;
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
  const [picker, setPicker] = useState<Product | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [payment, setPayment] = useState(false);
  const [receipt, setReceipt] = useState<Order | null>(null);
  const [current, setCurrent] = useState<Order | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingPayment, setPendingPayment] = useState(false);
  const [parked, setParked] = useState<ParkedDraft[] | null>(null);
  /** A Borradores resume in progress (restoreDraft). */
  const restoring = useRef(false);
  /** The draft whose entry just turned "gone": its discard button takes focus. */
  const [goneFocus, setGoneFocus] = useState<string | null>(null);
  /**
   * After a discard (LD-48, POLISH-UX-5): the Borradores dialog and the entry that takes
   * the focus the removed button had (the next one, else the previous one), or null for
   * the dialog's heading when the list is empty, so focus never falls to <body>.
   */
  const [discardFocus, setDiscardFocus] = useState<{
    dialog: HTMLElement | null;
    id: string | null;
  } | null>(null);
  const [tables, setTables] = useState<any[]>([]);
  const [cashSession, setCashSession] = useState<any>(null);
  const [notice, setNotice] = useState("");
  /**
   * Offers "Enviar como orden nueva", and remembers which refusal offered it:
   * "server" for a check the server closed or a send whose outcome is unknown
   * (online only: the lines may already be on a check), "offline" for a paid
   * check that refused an offline round (offline §2.3, offline_check_paid),
   * whose lines were never saved, so the new order may be local.
   */
  const [closedCheck, setClosedCheck] = useState<false | "server" | "offline">(
    false,
  );
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** The order whose note "Editar nota" is editing (cart or receipt). */
  const [noteFor, setNoteFor] = useState<Order | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  /** The order whose open comandas can be reprinted after a note edit. */
  const [noteReprint, setNoteReprint] = useState<Order | null>(null);
  /** SVC-R2: one payment request at a time, from the tap until it settles. */
  const [paying, setPaying] = useState(false);
  /**
   * SVC-R7: ids of the cart lines in a send that has not answered yet. They
   * cannot be edited and a product tap never merges into them (the ref is
   * read synchronously by add()).
   */
  const [sending, setSending] = useState<ReadonlySet<string> | null>(null);
  const sendingRef = useRef<ReadonlySet<string> | null>(null);
  const payingRef = useRef(false);
  /**
   * SVC-R10: bumped whenever the cart moves to another order (resume, a new
   * table check, Nueva orden, restore, send as new). A send or payment that
   * answers after a move never writes its order into the new cart.
   */
  const contextEpoch = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  /** SVC-R10: a switch from Mesas or Órdenes is waiting for a request. */
  const switchDeferred = useRef(false);
  /**
   * SVC-REV-1: a send or payment failed where the waiter may not have read
   * its error (a switch was waiting for it, or Vender was not on screen). The
   * next switch request is dropped once, so the error and its actions stay.
   */
  const unseenFailure = useRef(false);
  const nameCache = useRef(new Map<string, Label>());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const currentRef = useRef(current);
  currentRef.current = current;
  /** ACC-PR-2: the payment dialog and the receipt, as a late answer sees them. */
  const paymentOpenRef = useRef(payment);
  paymentOpenRef.current = payment;
  const receiptRef = useRef(receipt);
  receiptRef.current = receipt;
  const releaseKey = useRef(crypto.randomUUID());
  // The short-tablet query of styles.css (ACC-PR-8).
  const compact = useMediaQuery(
    "(max-height: 820px) and (min-width: 801px) and (max-width: 1499px)",
  );
  const paymentKey = useRef(crypto.randomUUID());
  const search = useRef<HTMLInputElement>(null);
  const activeId = scope(session) + ":active";
  const contextId = scope(session) + ":order";
  const attemptId = scope(session) + ":payment";
  /** Service-owned record of the check a parked round belongs to. */
  const parkedOrderId = (operationId: string) =>
    scope(session) + ":parked-order:" + operationId;
  // LD-29: an open order from another business day names its date.
  const today = currentBusinessDate(session.restaurant);
  /**
   * An order as a notice names it: "10", or "10 · 5 oct" for an order of another
   * business day, so yesterday's #10 never reads as today's (LD-29, POL-R2-2).
   */
  const numberText = (o: { number: number; businessDate?: string | null }) =>
    orderNumberText(o, currentBusinessDate(session.restaurant), locale);
  const offline = useOfflineSelling({
    session,
    catalog,
    locale,
    cashSession,
    active,
  });
  const [openOrders, setOpenOrders] = useState(false);
  /** Records behind the local receipt on screen, for "Imprimir comanda" (§2.5). */
  const [receiptOps, setReceiptOps] = useState<string[]>([]);
  /** The record just sent to the kitchen offline, while printing is "Preguntar". */
  const [sentOffline, setSentOffline] = useState<string[]>([]);
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
        // LD-29: the business date names an order of another day in Borradores;
        // a local order's provisional number names it once it is gone (LD-48).
        value: parkedOrderValue(order),
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
  /**
   * SVC-R10: the one place that moves the cart to another order (or to a new
   * one). It bumps the context epoch in the same synchronous block that
   * replaces the order and the lines, so a request started on the previous
   * cart can tell that it no longer owns the screen.
   */
  function replaceContext(order: Order | null, next: OrderInput) {
    contextEpoch.current++;
    unseenFailure.current = false;
    switchDeferred.current = false;
    currentRef.current = order;
    draftRef.current = next;
    setCurrent(order);
    setDraft(next);
    setError("");
    setClosedCheck(false);
    setNoteReprint(null);
    return order
      ? db.cache.put({ id: contextId, value: order.id })
      : db.cache.delete(contextId);
  }
  /**
   * SVC-REV-1: called when a send or payment of the cart on screen fails. If
   * a switch was waiting for it, or Vender was not on screen, the waiter has
   * not read the error yet, so the next switch request keeps this cart (and
   * its error and actions) instead of replacing it.
   */
  function requestFailed() {
    unseenFailure.current = switchDeferred.current || !activeRef.current;
  }
  /**
   * SVC-REV-1: a send that fails after the cart moved to another order. Its
   * cart is in Borradores under the same operation id; the waiter is told it
   * did not reach the kitchen, since the cart on screen is another check now.
   */
  function failedAfterSwitch(target: Order | null, error: unknown) {
    const code = (error as Error).message;
    // With the "Referencia de soporte" when the send failed on the server,
    // closed by a full stop before the next sentence (POL-R2-4).
    const reason = errorSentence(error, locale);
    setError(
      target
        ? t("serviceRoundFailedAfterSwitch")
            .replace("{n}", numberText(target))
            .replace("{reason}", reason)
        : t("serviceSendFailedAfterSwitch").replace("{reason}", reason),
    );
    return new HandledError(code);
  }
  /**
   * SVC-R10: the cart a send came from was parked under the same operation id
   * when the screen moved to another order. The lines that landed in `order`
   * leave that copy: it is removed when nothing is left, otherwise the rest
   * stays parked, as a round of `parkAs` (or as a new order when null).
   * Returns whether lines stay parked. Used online and offline (LD-12 R6).
   */
  async function trimParkedCopy(
    sent: OrderInput,
    order: Order,
    parkAs: Order | null,
  ) {
    const copy = await db.drafts.get(sent.operationId);
    if (!copy || copy.scope !== scope(session)) return false;
    const ids = idSequence();
    const next = reconcileLostSend(
      copy.order,
      order,
      crypto.randomUUID(),
      ids(),
    );
    await db.drafts.delete(copy.id);
    await db.cache.delete(parkedOrderId(copy.id));
    if (!next.draft.lines.length) return false;
    await parkDraft(next.draft, parkAs);
    return true;
  }
  /**
   * SVC-R10: a send that answers after the cart moved to another order. The
   * lines that landed leave the parked copy of its cart (the rest stays as a
   * round of the order they reached) and the cart on screen is left alone.
   */
  async function settleParkedCopy(sent: OrderInput, order: Order) {
    const remaining = await trimParkedCopy(sent, order, order);
    // The same check may be on screen again (resumed meanwhile).
    const shown = currentRef.current;
    if (shown && shown.id === order.id && order.version > shown.version)
      setCurrent(order);
    setNotice(
      [
        t("serviceSentAfterSwitch").replace("{n}", numberText(order)),
        ...(remaining ? [t("serviceDraftParked")] : []),
      ].join(" "),
    );
  }
  async function openDrafts() {
    const drafts = (
      await db.drafts.where("scope").equals(scope(session)).toArray()
    ).filter((d) => d.id !== activeId);
    setParked(
      await Promise.all(
        drafts.map(async (draft): Promise<ParkedDraft> => {
          const key = parkedOrderId(draft.id);
          const stored = parkedOrderRef((await db.cache.get(key))?.value);
          // LD-13 addendum: a local order is named by this device's records.
          const where = stored
            ? await resolveParkedOrder(session, stored.id).catch(() => null)
            : null;
          // POL-R2-3: a local id that resolved to its server order is stored
          // as that server order before its synced record is pruned.
          const pinned = stored && where && pinnedParkedOrder(stored, where);
          if (pinned)
            await db.cache.put({ id: key, value: pinned }).catch(() => {});
          return {
            draft,
            order: pinned || stored,
            label: parkedOrderLabel(where, stored, today, locale),
            gone: where?.kind === "gone",
          };
        }),
      ),
    );
  }
  /** A draft whose order no longer exists anywhere (LD-13 addendum). */
  function markGone(id: string) {
    // Its button is replaced by the gone panel: focus moves to its discard action.
    setGoneFocus(id);
    setParked(
      (list) =>
        list?.map((p) => (p.draft.id === id ? { ...p, gone: true } : p)) ??
        null,
    );
  }
  async function discardDraft(
    { draft: d }: ParkedDraft,
    dialog: HTMLElement | null,
  ) {
    await db.drafts.delete(d.id);
    await db.cache.delete(parkedOrderId(d.id));
    const list = parked ?? [];
    const at = list.findIndex((p) => p.draft.id === d.id);
    const next = at < 0 ? null : (list[at + 1] ?? list[at - 1] ?? null);
    setDiscardFocus({ dialog, id: next?.draft.id ?? null });
    setParked((list) => list?.filter((p) => p.draft.id !== d.id) ?? null);
  }
  useEffect(() => {
    if (!discardFocus) return;
    const { dialog, id } = discardFocus;
    setDiscardFocus(null);
    const entry = id
      ? dialog?.querySelector<HTMLElement>(`[data-draft-entry="${id}"]`)
      : null;
    const target = entry
      ? entry.matches("button")
        ? entry
        : entry.querySelector<HTMLElement>("button")
      : dialog?.querySelector<HTMLElement>("h2");
    target?.focus();
  }, [parked, discardFocus]);
  /**
   * SVC-R5: a parked round goes back onto its check while it is not closed.
   * LD-13 addendum: the check may be a local order (created on this device,
   * not synced yet: its projection), a local order that synced since (the
   * server order its sync recorded), or a server order (read online; offline,
   * this device's cached copy). One that no longer exists anywhere is shown
   * as such, with only a discard action. One resume at a time: online it may
   * wait for a sync pass first, and a second tap meanwhile does nothing.
   */
  async function restoreDraft(entry: ParkedDraft) {
    if (restoring.current) return;
    restoring.current = true;
    try {
      await resumeDraft(entry);
    } finally {
      restoring.current = false;
    }
  }
  async function resumeDraft({ draft: d, order: parkedOrder }: ParkedDraft) {
    let target: Order | null = null;
    if (parkedOrder) {
      let where: ParkedOrderTarget;
      try {
        // POLISH-OFFLINE-3: online, a local order's record is synced first, so
        // one that already became a server order (its answer lost) is read
        // from the server before the round is placed on it.
        where = await resolveParkedOrderToResume(session, parkedOrder.id, {
          online,
          sync: () => syncPending(session, { force: true, reason: "manual" }),
        });
      } catch (e) {
        // This device's store could not be read: the round stays parked.
        setParked(null);
        setError(errorNotice(e, locale));
        return;
      }
      if (where.kind === "gone") {
        markGone(d.id);
        return;
      }
      if (where.kind === "local") target = where.order;
      else if (online)
        try {
          target = await api<Order>("/orders/" + where.orderId);
        } catch (e) {
          if (e instanceof ApiError && e.message === "not_found") {
            markGone(d.id);
            return;
          }
          // Without the check the round cannot be placed; it stays parked.
          setParked(null);
          setError(errorNotice(e, locale));
          return;
        }
      else if (where.cached) target = where.cached;
      else {
        // Offline, a check this device does not keep cannot take the round
        // (LD-7); it stays parked until the connection is back.
        setParked(null);
        setError(
          offline.tableService
            ? translateError("offline_order_not_cached", locale)
            : t("offlineAvailableOnReconnect"),
        );
        return;
      }
    }
    const parkedCart = await parkCurrentCart();
    await db.drafts.delete(d.id);
    await db.cache.delete(parkedOrderId(d.id));
    setParked(null);
    setNotice(parkedCart ? t("serviceDraftParked") : "");
    if (target && checkStateOf(target) !== "closed") {
      await replaceContext(target, d.order);
      return;
    }
    await replaceContext(null, d.order);
    if (target) {
      // A check paid on this device (local or cached) never had these lines,
      // so "Enviar como orden nueva" may save them locally (offline §2.3).
      setClosedCheck(isServerOrder(target) ? "server" : "offline");
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
      // SVC-REV-2: a table or order chosen while these load owns the cart.
      const epoch = contextEpoch.current;
      const moved = () => epoch !== contextEpoch.current;
      void (async () => {
        const a = await db.cache.get(attemptId);
        if (!live) return;
        setPendingPayment(!!a);
        try {
          if (a) {
            const o = await recoverPayment(a.value);
            await clearPaymentAttempt(attemptId, a.value);
            if (live) {
              setPendingPayment(false);
              if (moved())
                setNotice(
                  t("servicePaidAfterSwitch").replace("{n}", numberText(o)),
                );
              else {
                setCurrent(o);
                setReceipt(o);
              }
            }
          } else {
            const c = await db.cache.get(contextId);
            if (c && !moved()) {
              const o = await api<Order>("/orders/" + c.value);
              // A cached context that points at a closed check is dropped.
              if (!live || moved()) return;
              if (checkStateOf(o) === "closed") void db.cache.delete(contextId);
              else setCurrent(o);
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
          } else if (live) setError(errorNotice(e, locale));
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
    if (online)
      void api<DrawerView | null>("/cash")
        .then(async (d) => {
          setCashSession(d);
          // Caja reads it during an outage (and the device's drawer fact,
          // for an employee with no copy of their own; ACC-PR-3).
          await rememberDrawer(session, d);
        })
        .catch(() => {});
    else
      void db.cache
        .get(drawerKey(session))
        .then((d) => setCashSession(d?.value ?? null));
  }, [active, online]);
  const showingReceipt = !!receipt;
  const wasActive = useRef(active);
  useEffect(() => {
    const cameBack = active && !wasActive.current;
    wasActive.current = active;
    if (!active) return;
    const resume = localStorage.getItem("gm-resume");
    const table = localStorage.getItem("gm-table");
    if (!resume && !table) {
      // Vender is on screen with nothing to switch to: its error is visible.
      unseenFailure.current = false;
      // A check closed elsewhere while Vender was hidden (voided or settled
      // from Órdenes) never stays the cart on screen with its old balance:
      // when Vender comes back, re-read it, and start a new order when it is
      // closed (FIT-1). Only then: a send, payment or receipt on this screen
      // already returns the order it changed.
      const shown = currentRef.current;
      if (
        cameBack &&
        online &&
        shown &&
        isServerOrder(shown) &&
        !draftRef.current.lines.length &&
        !busy &&
        !paying &&
        !showingReceipt
      ) {
        const epoch = contextEpoch.current;
        void api<Order>("/orders/" + shown.id)
          .then((o) => {
            // ACC-PR-2: the answer is dropped unless the cart still shows the
            // very order it re-read (a send or payment meanwhile replaced it
            // with a newer copy) and nothing started on it since: unsent
            // lines, a payment in flight, the payment dialog or a receipt.
            if (
              contextEpoch.current !== epoch ||
              currentRef.current !== shown ||
              draftRef.current.lines.length ||
              payingRef.current ||
              paymentOpenRef.current ||
              receiptRef.current
            )
              return;
            if (checkStateOf(o) === "closed") {
              void replaceContext(null, fresh());
              setNotice(t("serviceResumeClosed").replace("{n}", numberText(o)));
            } else setCurrent(o);
          })
          .catch(() => {});
      }
      return;
    }
    // SVC-R10: a send or payment in flight (and the receipt it shows) finishes
    // on its own cart first. The request stays in localStorage and this effect
    // runs again once busy, paying and the receipt clear, so a late response
    // can never land on the order the waiter switched to.
    if (busy || paying || showingReceipt) {
      switchDeferred.current = true;
      setNotice(t("serviceSwitchWaits"));
      return;
    }
    switchDeferred.current = false;
    if (unseenFailure.current) {
      // SVC-REV-1: the request this switch waited for failed (or failed while
      // Vender was hidden). Replacing the cart would erase that error and its
      // actions, and the food would never reach the kitchen unnoticed, so the
      // switch is dropped once; choosing the check again switches.
      unseenFailure.current = false;
      localStorage.removeItem("gm-resume");
      localStorage.removeItem("gm-table");
      const waits = t("serviceSwitchWaits");
      setNotice((n) =>
        [n === waits ? "" : n, t("serviceSwitchCancelled")]
          .filter(Boolean)
          .join(" "),
      );
      return;
    }
    if (resume) {
      localStorage.removeItem("gm-resume");
      void api<Order>("/orders/" + resume)
        .then(async (o) => {
          const parkedCart = await parkCurrentCart();
          const notes = parkedCart ? [t("serviceDraftParked")] : [];
          if (checkStateOf(o) === "closed") {
            // A closed check cannot take rounds: start a new order instead.
            void replaceContext(null, fresh());
            setNotice(
              [
                ...notes,
                t("serviceResumeClosed").replace("{n}", numberText(o)),
              ].join(" "),
            );
            return;
          }
          void replaceContext(o, {
            ...fresh(),
            mode: o.mode as OrderInput["mode"],
            tableId: o.tableId,
            name: o.name,
          });
          setNotice(notes.join(" "));
        })
        .catch((e) => setError(errorNotice(e, locale)));
    }
    if (table) {
      // A new check for a table never adds rounds to the order on screen.
      localStorage.removeItem("gm-table");
      void parkCurrentCart().then((parkedCart) => {
        void replaceContext(null, {
          ...fresh(),
          mode: "dine_in",
          tableId: table,
        });
        setNotice(parkedCart ? t("serviceDraftParked") : "");
      });
    }
  }, [active, busy, paying, showingReceipt]);
  useEffect(() => {
    if (!active) return;
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
    selection: { options: string[]; openAmount?: number } = { options: [] },
  ) {
    // SVC-R7: the lines come from React's latest state inside the updater, so
    // a tap that lands right after a send emptied the cart can never bring the
    // sent lines back, and lines still in flight are never merge targets. The
    // ref only previews the result (same new id) to highlight the line; it
    // stays current so two quick taps before a render highlight the same line.
    const opts = {
      newId: crypto.randomUUID(),
      locked: sendingRef.current ?? undefined,
    };
    const preview = mergeLine(draftRef.current.lines, p, selection, opts);
    draftRef.current = { ...draftRef.current, lines: preview.lines };
    setDraft((d) => ({
      ...d,
      lines: mergeLine(d.lines, p, selection, opts).lines,
    }));
    setLastAddedId(preview.lineId);
  }
  function reset() {
    void replaceContext(null, fresh());
    setPayment(false);
    setReceipt(null);
    setCartOpen(false);
    setNotice("");
    setSentOffline([]);
  }
  function printNewRound(o: Order) {
    printRounds(o, [Math.max(0, ...o.lines.map((l) => l.round ?? 0))]);
  }
  /** The business day printed comandas name their order against (LD-44). */
  const printDay = () => ({
    today: currentBusinessDate(session.restaurant),
    locale,
  });
  function printRounds(o: Order, rounds: number[]) {
    printTickets(
      rounds.flatMap((round) => ticketsFromOrderRound(o, round, printDay())),
    );
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
    unseenFailure.current = false;
    const inFlight = new Set(d.lines.map((l) => l.id));
    sendingRef.current = inFlight;
    setSending(inFlight);
    // SVC-R10: the cart this send belongs to; see replaceContext.
    const epoch = contextEpoch.current;
    const moved = () => epoch !== contextEpoch.current;
    // SVC-REV-1: false until every line of this send is known to have landed.
    let landed = false;
    setSentOffline([]);
    try {
      // I13: a local order only ever changes through offline records. A line
      // priceCart flags has no price in `priced`, so the builder refuses the
      // send with the cart's own message (OFF-INT-4).
      if (!online || offline.isLocalOrder(target)) {
        const { operationId, view } = await offline.sendOffline(target, d, {
          priced,
          total: draftTotal,
        });
        landed = true;
        offline.afterSave([operationId]);
        if (moved()) {
          // SVC-R10: a record saved for a cart the screen left is never
          // written into the cart now on screen. LD-12 R6: as online, what the
          // record holds leaves the parked copy of that cart, so restoring it
          // never saves those lines twice. The rest stays parked as a round of
          // the order it reached, a cached server order or a local order
          // (Borradores resumes both, LD-13 addendum).
          const remaining = await trimParkedCopy(d, view, view);
          setNotice(
            [
              t("offlineSentToDevice"),
              ...(remaining ? [t("serviceDraftParked")] : []),
            ].join(" "),
          );
          throw new HandledError("context_changed");
        }
        // SVC-R7 (OFF-INT-5): as online, lines tapped while the record was
        // being saved stay in the cart under a new operation id; only what the
        // record holds leaves, and a note it delivered (the order note, or this
        // round's note) leaves the note field. The order and the cart change
        // in one render, before any await (SVC-R8).
        const nextId = crypto.randomUUID();
        const ids = idSequence();
        const next = reconcileLostSend(draftRef.current, view, nextId, ids());
        draftRef.current = next.draft;
        sendingRef.current = null;
        setSending(null);
        setCurrent(view);
        setDraft((x) => reconcileLostSend(x, view, nextId, ids()).draft);
        if (next.changed) setNotice(t("serviceSendChanged"));
        if (offline.printSetting === "ask") setSentOffline([operationId]);
        return view as Order;
      }
      const o = await api<Order>(
        target ? `/orders/${target.id}/rounds` : "/orders",
        target ? { ...d, expectedVersion: target.version } : d,
        { idempotent: true },
      );
      landed = true;
      if (moved()) {
        // The cart moved to another order while this send was in flight: the
        // order it reached is never written into the cart on screen.
        await settleParkedCopy(d, o);
        if (readPrintSettings().kitchenOnSend) printNewRound(o);
        throw new HandledError("context_changed");
      }
      // SVC-R7: the cart may have changed while the request was in flight.
      // Compare the latest cart with the order instead of emptying it: lines
      // that landed leave, anything added meanwhile (another product, another
      // unit, a note) stays under a new operation id. The order and the cart
      // change in one render, before any await, so the balance is never
      // counted twice (SVC-R8).
      const operationId = crypto.randomUUID();
      const ids = idSequence();
      const next = reconcileLostSend(draftRef.current, o, operationId, ids());
      draftRef.current = next.draft;
      sendingRef.current = null;
      setSending(null);
      setCurrent(o);
      setDraft((x) => reconcileLostSend(x, o, operationId, ids()).draft);
      if (next.changed) setNotice(t("serviceSendChanged"));
      await db.cache.put({ id: contextId, value: o.id });
      if (readPrintSettings().kitchenOnSend) printNewRound(o);
      return o;
    } catch (e) {
      if (e instanceof HandledError) throw e;
      const code = (e as Error).message;
      // SVC-R10: the cart this send came from is in Borradores under the same
      // operation id, so sending it from there replays or recovers it (FOH-11);
      // the cart on screen belongs to another order and stays as it is, and
      // the waiter is told the send did not land (SVC-REV-1).
      if (moved()) throw failedAfterSwitch(target, e);
      if (code === "stale_order" && target) {
        // Refresh in place; the unsent lines and their operation id stay.
        try {
          const latest = await api<Order>("/orders/" + target.id);
          if (moved()) throw failedAfterSwitch(target, e);
          setCurrent(latest);
          if (checkStateOf(latest) === "closed") {
            setClosedCheck("server");
            setError(t("serviceCheckClosedKeep"));
            throw new HandledError(code, true);
          }
          setNotice(t("serviceStaleRefreshed"));
        } catch (refresh) {
          if (refresh instanceof HandledError) throw refresh;
          setError(errorNotice(refresh, locale));
        }
        throw new HandledError(code);
      }
      // fiscal (027, LD-15 fiscal Q2): a ticketed check takes no more rounds;
      // like a closed one, the cart keeps its items and is offered "Enviar
      // como orden nueva" for the same table.
      if (code === "check_closed" || code === "fiscal_ticket_issued") {
        setClosedCheck("server");
        setError(
          code === "fiscal_ticket_issued"
            ? errorNotice(e, locale)
            : t("serviceCheckClosedKeep"),
        );
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
        // SVC-R10: the parked copy recovers the same way when it is sent.
        if (moved()) throw failedAfterSwitch(target, e);
        if (latest) {
          const operationId = crypto.randomUUID();
          const ids = idSequence();
          const next = reconcileLostSend(d, latest, operationId, ids());
          setCurrent(latest);
          setDraft(
            (x) => reconcileLostSend(x, latest, operationId, ids()).draft,
          );
          await db.cache.put({ id: contextId, value: latest.id });
          if (readPrintSettings().kitchenOnSend)
            printRounds(latest, next.rounds);
          if (next.sent) {
            landed = true;
            return latest;
          }
          if (checkStateOf(latest) === "closed") {
            setClosedCheck("server");
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
          setClosedCheck("server");
          setError(t("serviceSendUnconfirmed"));
          throw new HandledError(code, true);
        }
      }
      // offline §2.3: a paid check takes no offline round; offer a new order.
      if (code === "offline_check_paid") setClosedCheck("offline");
      if (CATALOG_CODES.includes(code))
        window.dispatchEvent(new Event("gm-menu-refresh"));
      setError(errorNotice(e, locale));
      throw new HandledError(code);
    } finally {
      if (!landed) requestFailed();
      sendingRef.current = null;
      setSending(null);
      if (!opts.keepBusy) setBusy(false);
    }
  }
  const send = () => sendWith(current, draft);
  async function sendAsNew() {
    const d = { ...draft, operationId: crypto.randomUUID() };
    await replaceContext(null, d);
    return sendWith(null, d);
  }
  function openPay() {
    // One key per opened dialog (MON-3): a duplicate submit replays the stored
    // result instead of recording a second tender.
    paymentKey.current = crypto.randomUUID();
    orderOperationKey.current = crypto.randomUUID();
    if (online)
      void api("/cash")
        .then(setCashSession)
        .catch(() => {});
    setPayment(true);
    setError("");
    setNotice("");
  }
  /** payments (037, critic R18): every server-settled payment ends here once. */
  function onPaymentSettled(order: Order) {
    try {
      onPaymentSettledProp?.(order);
    } catch {
      // A consumer's failure never hides the receipt of money already taken.
    }
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
      .catch((e) => setError(errorNotice(e, locale)))
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
  /**
   * OFF-2: settles the single active attempt before any new charge. It blocks
   * only its own order: a resolved attempt for another order is cleared, an
   * unconfirmable one is parked, and nothing is ever overwritten (I9).
   * Returns true when the attempt was for `targetOrderId` and its receipt is shown.
   */
  async function settleActiveAttempt(
    targetOrderId: string | null,
    finish: (result: Order, owned: boolean) => void,
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
          // SVC-REV-2: the receipt replaces the cart only if the cart still
          // shows that check (or is an empty new order); otherwise announced.
          const shown = currentRef.current;
          finish(
            result,
            shown ? shown.id === result.id : !draftRef.current.lines.length,
          );
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
              await settleActiveAttempt(orderId ?? null, (result, owned) => {
                setPayment(false);
                onPaymentSettled(result);
                if (owned) {
                  setCurrent(result);
                  setReceipt(result);
                } else
                  setNotice(
                    t("servicePaidAfterSwitch").replace(
                      "{n}",
                      numberText(result),
                    ),
                  );
              });
            } catch (e) {
              setError(errorNotice(e, locale));
            } finally {
              setPendingPayment(!!(await db.cache.get(attemptId)));
              setBusy(false);
            }
          },
        ),
    );
  }
  async function collectLocked(values: PaymentValues | null, items?: string[]) {
    let submittedAttempt: unknown;
    setBusy(true);
    setError("");
    // SVC-R10: a payment that settles after the cart moved to another order
    // is announced instead of replacing that cart with its receipt.
    const epoch = contextEpoch.current;
    const settled = (result: Order, owned = true) => {
      setPendingPayment(false);
      setPayment(false);
      onPaymentSettled(result);
      if (!owned || epoch !== contextEpoch.current) {
        setNotice(
          t("servicePaidAfterSwitch").replace("{n}", numberText(result)),
        );
        return;
      }
      setCurrent(result);
      setReceipt(result);
    };
    try {
      const hadAttempt = !!(await db.cache.get(attemptId));
      // OFF-2: settle the single active attempt first; it blocks only its own
      // order and finishes through settled() (SVC-R10).
      if (await settleActiveAttempt(current?.id ?? null, settled)) return;
      if (!values) {
        if (hadAttempt) return;
        throw new Error("invalid_input");
      }
      // I13: a local order only ever changes through offline records. A cart
      // priceCart flags (a menu refresh while this dialog was open) is refused
      // by the builders with the cart's own message (OFF-INT-4): `priced`
      // leaves the flagged line out, and no record holds a line it cannot price.
      if (!online || offline.isLocalOrder(current)) {
        const saved = await offline.collectOffline(
          {
            amount: values.amount,
            tip: values.tip,
            received: values.received,
            method: values.method,
            reference: values.reference,
            confirmed: values.confirmed,
          },
          {
            draft,
            priced,
            total: draftTotal,
            current,
            operationId: paymentKey.current,
            orderOperationId: orderOperationKey.current,
          },
          items,
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
      // MON-8: nothing reaches the kitchen unless this device has an open drawer.
      if (!drawerOpen) throw new Error("drawer_required");
      await offline.guardOnlinePayment(current);
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
      const result = await api<Order>(`/orders/${o.id}/payments`, payload, {
        idempotent: true,
      });
      await clearPaymentAttempt(attemptId, submittedAttempt);
      settled(result);
    } catch (e) {
      if (
        submittedAttempt &&
        e instanceof ApiError &&
        (([400, 404, 409].includes(e.status) &&
          e.message !== "operation_conflict") ||
          // A session 401 is answered before the payment runs (ACC-FLOOR-1).
          isSessionRejection(e))
      )
        await clearPaymentAttempt(attemptId, submittedAttempt);
      setPendingPayment(!!(await db.cache.get(attemptId)));
      // OFF-R26: the order on screen lacks a round this device synced: read
      // it again (the dialog's prefilled amount follows the new balance).
      if ((e as Error).message === "offline_order_outdated" && current) {
        const fresh = await api<Order>("/orders/" + current.id).catch(
          () => null,
        );
        if (fresh) setCurrent(fresh);
      }
      // SVC-REV-1: a switch waiting for this payment keeps its error on screen.
      if (epoch === contextEpoch.current) requestFailed();
      if (!(e instanceof HandledError)) setError(errorNotice(e, locale));
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
        // SVC-R7: the note travels with the send in flight.
        readOnly={!!sending}
        onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
      />
    </Field>
  );
  const cartPanel = (
    <>
      <div className="cart-heading">
        <div>
          <span className="eyebrow">
            {current ? orderLabel(current, today, locale) : t("newOrder")}
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
              {orderLabel(current, today, locale)} · {t("sent")}
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
            <CheckDiscountSummary
              order={current}
              session={session}
              locale={locale}
              money={money}
              online={online && isServerOrder(current)}
              changed={(o) => {
                if (currentRef.current?.id === o.id) setCurrent(o);
              }}
            />
            {current.note && (
              <p className="line-note">
                {t("serviceOrderNoteLabel").replace("{note}", current.note)}
              </p>
            )}
            {noteEditableOf(current) && (
              <Button
                variant="ghost"
                className="small"
                onClick={() => setNoteFor(current)}
              >
                {t("serviceDetailEditNote")}
              </Button>
            )}
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
          cart.lines.map((line) => (
            <CartLine
              key={line.input.id}
              line={line}
              product={catalog.find((p) => p.id === line.input.productId)}
              fallbackName={nameCache.current.get(line.input.id)}
              locale={locale}
              money={money}
              justAdded={lastAddedId === line.input.id}
              locked={!!sending?.has(line.input.id)}
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
            onClick={() =>
              printTickets(ticketsForOpenRounds(noteReprint, printDay()))
            }
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
                disabled={
                  busy ||
                  cart.blocked ||
                  (closedCheck === "offline"
                    ? // A new order without the server is a local open order.
                      !online && !!offline.sendBlockReason
                    : !online)
                }
                onClick={() => void sendAsNew().catch(() => {})}
              >
                {t("serviceSendAsNew")}
              </Button>
            )}
          </div>
        )}
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
              cart.blocked ||
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
              paying ||
              cart.blocked ||
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
            disabled={!draft.lines.length || busy}
            onClick={async () => {
              await parkDraft(draft, current);
              reset();
            }}
          >
            <Pause size={14} />
            {t("park")}
          </button>
          <DiscountButton
            order={current && isServerOrder(current) ? current : null}
            hasDraftLines={
              draft.lines.length > 0 && (!current || isServerOrder(current))
            }
            send={async () => {
              try {
                const o = await send();
                return isServerOrder(o) ? o : null;
              } catch (e) {
                // Selling already showed what happened (SVC-R10).
                if (!(e instanceof HandledError)) throw e;
                return null;
              }
            }}
            session={session}
            locale={locale}
            online={online}
            blocked={cart.blocked}
            money={money}
            onApplied={(o) => {
              // SVC-R10: only the order still on screen is replaced. A check
              // the discount closed (takeaway or tableless) is final: its
              // receipt opens, as after a payment (LD-15 discounts Q7).
              if (currentRef.current?.id !== o.id) return;
              setCurrent(o);
              if (o.checkState === "closed") setReceipt(o);
            }}
          />
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
                  onClick={() => void recoverPending()}
                >
                  {t("retryPayment")}
                </Button>
              </div>
            )}
          </div>
          <Button
            disabled={busy}
            onClick={async () => {
              if (draft.lines.length) await parkDraft(draft, current);
              reset();
            }}
          >
            {t("newOrder")}
          </Button>
          <Button disabled={busy} onClick={() => void openDrafts()}>
            {t("drafts")}
          </Button>
          {!online && offline.tableService && (
            // SVC-R10: a control that replaces the cart waits for a send or
            // payment in flight (SERVICE.md "Nueva orden").
            <Button
              disabled={busy || paying}
              onClick={() => setOpenOrders(true)}
            >
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
              disabled={!orderable(p)}
              key={p.id}
              onClick={() => (pickerNeeded(p) ? setPicker(p) : add(p))}
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
              <span className="product-price">
                {p.openAmount ? t("menuOpenPriceBadge") : money(p.price)}
              </span>
              {p.kind === "combo" && (
                <span className="product-tag">{t("menuKindCombo")}</span>
              )}
              {!orderable(p) && <span>{t("menuSoldOut")}</span>}
              {(inCart.get(p.id) ?? 0) > 0 && (
                <span className="in-cart">
                  ·{" "}
                  {t("serviceInCart").replace("{n}", String(inCart.get(p.id)))}
                </span>
              )}
            </button>
          ))}
        </div>
        {!filtered.length && (
          <Empty
            title={t("noResults")}
            detail={catalog.length ? undefined : t("menuPosEmptyHint")}
          />
        )}
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
      {picker && (
        <ModifierPicker
          product={picker}
          locale={locale}
          currency={session.restaurant.currency}
          canOpen
          onConfirm={(selection) => {
            add(picker, selection);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
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
          offline={{
            ...offline.paymentSlot,
            // §8.1.3: paying a cached server order offline warns first.
            hint: (method) => (
              <>
                {offline.paymentSlot.hint(method)}
                {!!(current as LocalOrderView | null)?.offline?.cachedAt && (
                  <span className="block" role="status">
                    {t("offlinePayCachedWarning")}
                  </span>
                )}
              </>
            ),
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
          label={offline.receiptProps(receipt)?.label}
          labelHint={offline.receiptProps(receipt)?.labelHint}
          printLabel={offline.receiptProps(receipt)?.printLabel}
          printLabelHint={offline.receiptProps(receipt)?.printLabelHint}
          extraActions={
            receipt.state === "local" &&
            receiptOps.length > 0 && (
              <Button onClick={() => void offline.printKitchen(receiptOps)}>
                {t("offlinePrintKitchen")}
              </Button>
            )
          }
          onRelease={
            receipt.state !== "local" && checkStateOf(receipt) === "paid"
              ? () => release(receipt)
              : undefined
          }
          noteActions={
            // SVC-K3: a check that closed at payment still reaches the
            // kitchen's open tickets with a corrected note.
            noteEditableOf(receipt) && (
              <>
                <Button onClick={() => setNoteFor(receipt)}>
                  {t("serviceDetailEditNote")}
                </Button>
                {noteReprint?.id === receipt.id && (
                  <Button
                    onClick={() =>
                      printTickets(
                        ticketsForOpenRounds(noteReprint, printDay()),
                      )
                    }
                  >
                    <Printer size={16} />
                    {t("serviceReprintKitchen")}
                  </Button>
                )}
              </>
            )
          }
        />
      )}
      {openOrders && (
        <OfflineOrdersModal
          session={session}
          locale={locale}
          close={() => setOpenOrders(false)}
          onPick={(order) => {
            setOpenOrders(false);
            // Unsent lines go to Borradores first, as for every other order
            // that replaces the cart.
            void parkCurrentCart().then((parkedCart) => {
              void replaceContext(order, {
                ...fresh(),
                mode: order.mode as OrderInput["mode"],
                tableId: order.tableId,
                name: order.name,
              });
              setNotice(parkedCart ? t("serviceDraftParked") : "");
            });
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
            parked.map((p) => {
              const text = draftEntryText(
                {
                  label: p.label,
                  name: p.draft.order.name,
                  lines: p.draft.order.lines.length,
                },
                locale,
              );
              return p.gone ? (
                <DraftGoneEntry
                  key={p.draft.id}
                  draftId={p.draft.id}
                  text={text}
                  locale={locale}
                  autoFocus={goneFocus === p.draft.id}
                  onDiscard={(dialog) => void discardDraft(p, dialog)}
                />
              ) : (
                <Button
                  className="full"
                  key={p.draft.id}
                  data-draft-entry={p.draft.id}
                  onClick={() => void restoreDraft(p)}
                >
                  {text}
                </Button>
              );
            })
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
      {noteFor && (
        <NoteDialog
          order={noteFor}
          locale={locale}
          close={() => setNoteFor(null)}
          saved={(o) => {
            if (currentRef.current?.id === o.id) setCurrent(o);
            setReceipt((r) => (r && r.id === o.id ? o : r));
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
