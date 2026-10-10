import { useEffect, useRef, useState } from "react";
import type { Locale, Order, Session } from "../../../shared/domain";
import type {
  InboxHold,
  InboxResponse,
  RejectReason,
} from "../../../shared/public-ordering";
import type { PaymentValues } from "../../../shared/service";
import {
  errorNotice,
  errorSentence,
  strings,
  translateError,
  type Key,
} from "../../i18n";
import { api, ApiError } from "../../api";
import { usePoll } from "../../serviceHooks";
import { Button } from "../../components/ui";
import { PaymentDialog } from "../PaymentDialog";
import { usePaymentOptions } from "../payments/options";
import { ReceiptModal, checkStateOf, moneyFormatter } from "../Receipt";
import { KitchenTicketDocument, ticketsFromOrderRound } from "../KitchenTicket";
import { currentBusinessDate, orderNumberText } from "../../labels";
import { printDocument, readPrintSettings } from "../../print";
import { fill } from "../menu/format";
import { HoldCard, type AcceptBody, type KioskCharge } from "./HoldCard";
import { RejectDialog } from "./RejectDialog";
import {
  refreshPublicInbox,
  setPublicInboxPending,
  setPublicInboxUnavailable,
  usePublicInboxSnapshot,
} from "./usePublicInbox";
import "./public.css";

const TARGET_GONE = new Set([
  "public_hold_target_invalid",
  "fiscal_ticket_issued",
  "check_closed",
]);
const REFRESH = new Set([
  "public_order_not_pending",
  "public_order_expired",
  "stale_order",
  "operation_conflict",
  "unavailable",
  "invalid_modifier",
  "required_modifier",
  "public_hold_price_changed",
  "public_payment_must_cover_total",
  "public_hold_link_abuse",
  "insufficient_stock",
]);
/** Codes after which the hold leaves the inbox: the outcome stays in the notice. */
const GONE = new Set(["public_order_not_pending", "public_order_expired"]);

type AcceptResult = { hold: { label: string }; order: Order; round: number };
/**
 * The last inbox this tab read, per session: Órdenes remounts on every view
 * change, and offline the inbox still shows (actions disabled) what it knew.
 */
let lastRead: { scope: string; data: InboxResponse } | null = null;

/**
 * "Pedidos en línea por confirmar" at the top of Órdenes: polls every 10 s
 * while visible and online, only while a link is active or orders wait.
 * Accepting runs the normal order path as this staff member; paying first
 * goes through service's PaymentDialog and ends on the receipt.
 */
export function PublicOrderInbox({
  session,
  locale,
  online,
  navigate,
  onChanged,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
  navigate: (view: string) => void;
  onChanged: () => void;
}) {
  const t = (k: Key, values?: Record<string, string | number>) =>
    values ? fill(strings[locale][k], values) : strings[locale][k];
  const summary = usePublicInboxSnapshot();
  const scope = session.tenantId + ":" + session.id;
  const [data, setData] = useState<InboxResponse | null>(() =>
    lastRead?.scope === scope ? lastRead.data : null,
  );
  const [disabled, setDisabled] = useState(false);
  const paymentOptions = usePaymentOptions(session, online);
  const busyInbox =
    !!data?.active ||
    (data?.holds.length ?? 0) > 0 ||
    summary.active ||
    summary.pending > 0;
  const shown = data
    ? data.available && (data.active || data.holds.length > 0)
    : summary.available && (summary.active || summary.pending > 0);
  const [skewMs, setSkewMs] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [forceNew, setForceNew] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const [rejecting, setRejecting] = useState<InboxHold | null>(null);
  const [paying, setPaying] = useState<{
    hold: InboxHold;
    body: AcceptBody;
    due: number;
    drawerOpen: boolean;
    error: string;
    /** Kiosk (critic R13): the rest of an accept with the kiosk's charge. */
    charge?: KioskCharge;
  } | null>(null);
  const [receipt, setReceipt] = useState<Order | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  // One accept key per hold, kept across retries until it succeeds.
  const keys = useRef(new Map<string, string>());
  const keyFor = (id: string) => {
    let k = keys.current.get(id);
    if (!k) keys.current.set(id, (k = crypto.randomUUID()));
    return k;
  };
  // Every 10 s while a link is active or orders wait, otherwise a slow check
  // (GAP-4: an idle inbox read is 3 short statements and no catalog).
  const poll = usePoll(
    async () => {
      try {
        const r = await api<InboxResponse>("/ordering/inbox");
        lastRead = { scope, data: r };
        setData(r);
        setSkewMs(Date.parse(r.serverTime) - Date.now());
        setPublicInboxPending(r.holds.length, r.active);
      } catch (e) {
        const code = (e as Error).message;
        if (code === "public_ordering_disabled" || code === "forbidden") {
          // The cards go at once (Aceptar could only fail) and a remount does
          // not bring them back from lastRead (PUBLIC-OPS-1).
          lastRead = null;
          setData(null);
          if (code === "public_ordering_disabled") setPublicInboxUnavailable();
          return setDisabled(true);
        }
        throw e;
      }
    },
    {
      intervalMs: busyInbox ? 10_000 : 60_000,
      enabled: online && !disabled,
    },
    [busyInbox],
  );
  // The shell's summary poll keeps running while ordering is off: once it
  // reads "available" again, this inbox reads again too (PUBLIC-OPS-1).
  useEffect(() => {
    if (summary.available) setDisabled(false);
  }, [summary.available]);
  const refresh = () => {
    poll.refresh();
    refreshPublicInbox();
  };
  // Handling the last hold while no code is active empties the next read:
  // the section stays while it still owns an outcome (the notice, UX-7 and
  // MONEY-2), a pay-first receipt or an open dialog (PUB-HR-1).
  const owned = !!notice || !!receipt || !!paying || !!rejecting;
  if (!shown && !owned) return null;
  const manager = ["owner", "manager"].includes(session.role);

  function printKitchen(r: AcceptResult) {
    if (!readPrintSettings().kitchenOnSend) return;
    // An accepted round on yesterday's open check prints its date (LD-44).
    const tickets = ticketsFromOrderRound(r.order, r.round, {
      today: currentBusinessDate(session.restaurant),
      locale,
    });
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
  function failed(hold: InboxHold, error: unknown) {
    let code = (error as Error).message;
    if (code === "step_up_cancelled") return;
    if (code === "operation_conflict") keys.current.delete(hold.id);
    // A server error carries its "Referencia de soporte" (POL-R2-6).
    let text = errorNotice(error, locale);
    if (TARGET_GONE.has(code)) {
      setForceNew((f) => ({ ...f, [hold.id]: true }));
      code = "public_hold_target_invalid";
      text = translateError(code, locale);
    }
    setErrors((e) => ({ ...e, [hold.id]: text }));
    // The card disappears with the next read; its outcome must not (UX-7).
    if (GONE.has(code)) setNotice(`${hold.label}: ${text}`);
    if (REFRESH.has(code) || TARGET_GONE.has(code)) refresh();
  }
  function accepted(hold: InboxHold, r: AcceptResult) {
    keys.current.delete(hold.id);
    setErrors((e) => ({ ...e, [hold.id]: "" }));
    setNotice(
      t("publicAcceptedNotice", {
        label: r.hold.label,
        // A round on yesterday's open check names its date (POL-R2-2).
        number: orderNumberText(
          r.order,
          currentBusinessDate(session.restaurant),
          locale,
        ),
      }),
    );
    printKitchen(r);
    refresh();
    onChanged();
  }
  async function accept(hold: InboxHold, body: AcceptBody) {
    setBusy(hold.id);
    setNotice("");
    try {
      const r = await api<AcceptResult>(`/ordering/holds/${hold.id}/accept`, {
        operationId: keyFor(hold.id),
        ...body,
      });
      accepted(hold, r);
    } catch (e) {
      failed(hold, e);
    } finally {
      setBusy(null);
    }
  }
  async function startPay(
    hold: InboxHold,
    body: AcceptBody,
    due: number,
    charge?: KioskCharge,
  ) {
    // This device's drawer (id and closed_at stay visible to every role).
    const drawerOpen = await api<{
      id?: string;
      closed_at?: string | null;
    } | null>("/cash")
      .then((d) => !!d?.id && !d.closed_at)
      .catch(() => false);
    setPaying({ hold, body, due, drawerOpen, error: "", charge });
  }
  async function pay(values: PaymentValues | null) {
    if (!paying || !values) return;
    const { hold, body, charge } = paying;
    setBusy(hold.id);
    const counter = {
      amount: values.amount,
      tip: values.tip,
      received: values.received,
      method: values.method,
      externalConfirmed: values.confirmed,
      reference: values.reference,
      // payments (037): the named terminal of a manual card record (holds take no platform).
      ...(values.method === "external" && values.terminalId
        ? { terminalId: values.terminalId }
        : {}),
    };
    try {
      const r = await api<AcceptResult>(`/ordering/holds/${hold.id}/accept`, {
        operationId: keyFor(hold.id),
        ...body,
        // No payment key: the accept's own key covers the payment. With the kiosk's charge the
        // counter payment is the rest of the total (critic R13).
        payment: charge
          ? { method: "attempt", ...charge, rest: counter }
          : counter,
      });
      setPaying(null);
      accepted(hold, r);
      setReceipt(r.order);
    } catch (e) {
      const code = (e as Error).message;
      if (code === "step_up_cancelled") return;
      if (code === "operation_conflict") keys.current.delete(hold.id);
      // The cashier already charged the terminal: a refusal recorded
      // nothing, so say what to do with the charge (LD-41, PUBLIC-MONEY-2).
      // A transient failure is not a refusal: the same key retries it.
      const charged =
        values.method === "external" &&
        values.confirmed &&
        !(e instanceof ApiError && e.transient);
      // With the "Referencia de soporte" of a server error, closed by a full
      // stop before the charge sentence (POL-R2-6, POL-R2-4).
      const message = charged
        ? errorSentence(e, locale) +
          " " +
          t("publicExternalChargeRefused", {
            label: hold.label,
            amount: moneyFormatter(
              session.restaurant.currency,
              locale,
            )(values.amount + values.tip),
          })
        : errorNotice(e, locale);
      setPaying((p) => p && { ...p, error: message });
      if (GONE.has(code)) {
        setPaying(null);
        setNotice(`${hold.label}: ${message}`);
      }
      if (REFRESH.has(code)) refresh();
    } finally {
      setBusy(null);
    }
  }
  /**
   * «Aceptar con el pago del kiosco» (critic R13): with nothing left to collect the accept runs
   * now (an error stays in the resolve dialog); otherwise the payment dialog collects the rest.
   */
  async function kioskAccept(
    hold: InboxHold,
    body: AcceptBody,
    charge: KioskCharge,
    rest: number,
  ) {
    if (rest > 0) return startPay(hold, body, rest, charge);
    setBusy(hold.id);
    try {
      const r = await api<AcceptResult>(`/ordering/holds/${hold.id}/accept`, {
        operationId: keyFor(hold.id),
        ...body,
        payment: { method: "attempt", ...charge, rest: null },
      });
      accepted(hold, r);
      setReceipt(r.order);
    } catch (e) {
      if ((e as Error).message === "operation_conflict")
        keys.current.delete(hold.id);
      if (REFRESH.has((e as Error).message)) refresh();
      throw e;
    } finally {
      setBusy(null);
    }
  }
  /** «Rechazar y reembolsar» (critic R13): the reject records the provider refund. */
  async function kioskReject(
    hold: InboxHold,
    charge: KioskCharge,
    reason: RejectReason,
  ) {
    await api(`/ordering/holds/${hold.id}/reject`, {
      operationId: crypto.randomUUID(),
      reason,
      refund: { ...charge, confirmed: true },
    });
    setNotice(t("publicRejectedNotice", { label: hold.label }));
    refresh();
  }
  async function setPaused(paused: boolean) {
    setPauseBusy(true);
    try {
      await api("/ordering/pause", {
        operationId: crypto.randomUUID(),
        paused,
      });
      refresh();
    } catch (e) {
      setNotice(errorNotice(e, locale));
    } finally {
      setPauseBusy(false);
    }
  }
  async function release(order: Order) {
    await api(`/service/orders/${order.id}/close`, {
      operationId: crypto.randomUUID(),
    });
    setReceipt(null);
    onChanged();
  }

  const holds = data?.holds ?? [];
  const status = !data
    ? ""
    : data.reason === "paused"
      ? t("publicStatusPaused")
      : data.reason === "no_staff"
        ? t("publicStatusNoStaff")
        : t("publicStatusOpen");
  return (
    <section className="public-inbox" aria-labelledby="public-inbox-title">
      <header className="public-inbox-head">
        <h2 id="public-inbox-title">
          {t("publicInboxTitle")} ({holds.length})
        </h2>
        {/* Live regions stay mounted so their first text is announced. */}
        <span aria-live="polite">
          {data && (
            <span
              className={"public-pill" + (data.acceptingNow ? " open" : "")}
            >
              {status}
            </span>
          )}
        </span>
        {data && online && (
          <Button
            disabled={pauseBusy}
            onClick={() => void setPaused(!data.paused)}
          >
            {data.paused ? t("publicResumeShort") : t("publicPauseShort")}
          </Button>
        )}
      </header>
      {!online && <p className="warning-panel">{t("publicInboxOffline")}</p>}
      <div className="public-notice-row">
        <p className="public-notice" aria-live="polite">
          {notice}
        </p>
        {notice && (
          <Button variant="ghost" onClick={() => setNotice("")}>
            {t("publicNoticeDismiss")}
          </Button>
        )}
      </div>
      {data && data.recentlyExpired > 0 && (
        <p className="muted">
          {data.recentlyExpired === 1
            ? t("publicInboxExpiredOne")
            : t("publicInboxExpired", { n: data.recentlyExpired })}
        </p>
      )}
      {data?.churning?.map((c) => (
        <p key={c.kind + c.name} className="public-churn">
          {t("publicInboxChurn", {
            name:
              c.kind === "kiosk"
                ? t("publicKioskNamed", { name: c.name })
                : c.name,
          })}
        </p>
      ))}
      {data && !holds.length && (
        <p className="muted">{t("publicInboxEmpty")}</p>
      )}
      <div className="hold-list">
        {holds.map((hold) => (
          <HoldCard
            key={hold.id}
            hold={hold}
            session={session}
            locale={locale}
            online={online}
            busy={busy === hold.id}
            error={errors[hold.id] ?? ""}
            nowMs={Date.now() + skewMs}
            forceNew={!!forceNew[hold.id]}
            onAccept={(body) => void accept(hold, body)}
            onPay={(body, due) => void startPay(hold, body, due)}
            onReject={() => setRejecting(hold)}
            onKioskChanged={refresh}
            onKioskAccept={
              manager
                ? (body, charge, rest) => kioskAccept(hold, body, charge, rest)
                : undefined
            }
            onKioskReject={
              manager
                ? (charge, reason) => kioskReject(hold, charge, reason)
                : undefined
            }
          />
        ))}
      </div>
      {rejecting && (
        <RejectDialog
          hold={rejecting}
          locale={locale}
          manager={manager}
          onClose={() => setRejecting(null)}
          onDone={(code) => {
            const label = rejecting.label;
            setRejecting(null);
            setNotice(
              code
                ? translateError(code, locale)
                : t("publicRejectedNotice", { label }),
            );
            refresh();
          }}
        />
      )}
      {paying && (
        <PaymentDialog
          due={paying.due}
          current={null}
          hasDraftLines
          session={session}
          locale={locale}
          online={online}
          busy={busy === paying.hold.id}
          pendingPayment={false}
          drawerOpen={paying.drawerOpen}
          error={paying.error}
          onConfirm={(values) => void pay(values)}
          // payments (037): terminals for the card record; a hold is never paid by a platform.
          paymentOptions={{ ...paymentOptions, platforms: [] }}
          onSplitItems={async () => null}
          onClose={() => setPaying(null)}
          onGoToCash={() => {
            setPaying(null);
            navigate("cash");
          }}
        />
      )}
      {receipt && (
        <ReceiptModal
          order={receipt}
          session={session}
          locale={locale}
          onNext={() => setReceipt(null)}
          onBack={() => setReceipt(null)}
          onRelease={
            checkStateOf(receipt) === "paid"
              ? () => release(receipt)
              : undefined
          }
        />
      )}
    </section>
  );
}
