import { useRef, useState } from "react";
import type { Locale, Order, Session } from "../../../shared/domain";
import type { InboxHold, InboxResponse } from "../../../shared/public-ordering";
import type { PaymentValues } from "../../../shared/service";
import { strings, translateError, type Key } from "../../i18n";
import { api } from "../../api";
import { usePoll } from "../../serviceHooks";
import { Button } from "../../components/ui";
import { PaymentDialog } from "../PaymentDialog";
import { ReceiptModal, checkStateOf } from "../Receipt";
import { KitchenTicketDocument, ticketsFromOrderRound } from "../KitchenTicket";
import { printDocument, readPrintSettings } from "../../print";
import { fill } from "../menu/format";
import { HoldCard, type AcceptBody } from "./HoldCard";
import { RejectDialog } from "./RejectDialog";
import {
  refreshPublicInbox,
  setPublicInboxPending,
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
  "insufficient_stock",
]);

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
        if (code === "public_ordering_disabled" || code === "forbidden")
          return setDisabled(true);
        throw e;
      }
    },
    {
      intervalMs: busyInbox ? 10_000 : 60_000,
      enabled: online && !disabled,
    },
    [busyInbox],
  );
  const refresh = () => {
    poll.refresh();
    refreshPublicInbox();
  };
  if (!shown) return null;
  const manager = ["owner", "manager"].includes(session.role);

  function printKitchen(r: AcceptResult) {
    if (!readPrintSettings().kitchenOnSend) return;
    const tickets = ticketsFromOrderRound(r.order, r.round);
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
  function failed(hold: InboxHold, code: string) {
    if (code === "step_up_cancelled") return;
    if (code === "operation_conflict") keys.current.delete(hold.id);
    if (TARGET_GONE.has(code)) {
      setForceNew((f) => ({ ...f, [hold.id]: true }));
      code = "public_hold_target_invalid";
    }
    setErrors((e) => ({ ...e, [hold.id]: translateError(code, locale) }));
    if (REFRESH.has(code) || TARGET_GONE.has(code)) refresh();
  }
  function accepted(hold: InboxHold, r: AcceptResult) {
    keys.current.delete(hold.id);
    setErrors((e) => ({ ...e, [hold.id]: "" }));
    setNotice(t("publicAcceptedNotice", { label: r.hold.label }));
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
      failed(hold, (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function startPay(hold: InboxHold, body: AcceptBody, due: number) {
    // This device's drawer (id and closed_at stay visible to every role).
    const drawerOpen = await api<{
      id?: string;
      closed_at?: string | null;
    } | null>("/cash")
      .then((d) => !!d?.id && !d.closed_at)
      .catch(() => false);
    setPaying({ hold, body, due, drawerOpen, error: "" });
  }
  async function pay(values: PaymentValues | null) {
    if (!paying || !values) return;
    const { hold, body } = paying;
    setBusy(hold.id);
    try {
      const r = await api<AcceptResult>(`/ordering/holds/${hold.id}/accept`, {
        operationId: keyFor(hold.id),
        ...body,
        // No payment key: the accept's own key covers the payment.
        payment: {
          amount: values.amount,
          tip: values.tip,
          received: values.received,
          method: values.method,
          externalConfirmed: values.confirmed,
          reference: values.reference,
        },
      });
      setPaying(null);
      accepted(hold, r);
      setReceipt(r.order);
    } catch (e) {
      const code = (e as Error).message;
      if (code === "step_up_cancelled") return;
      if (code === "operation_conflict") keys.current.delete(hold.id);
      setPaying((p) => p && { ...p, error: translateError(code, locale) });
      if (REFRESH.has(code)) refresh();
    } finally {
      setBusy(null);
    }
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
      setNotice(translateError((e as Error).message, locale));
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
      <p className="public-notice" aria-live="polite">
        {notice}
      </p>
      {data && data.recentlyExpired > 0 && (
        <p className="muted">
          {t("publicInboxExpired", { n: data.recentlyExpired })}
        </p>
      )}
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
