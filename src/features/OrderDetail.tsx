import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Printer } from "lucide-react";
import { lineRemaining } from "../../shared/settlement";
import { changeDue, roundNotes } from "../../shared/service";
import type { Locale, Order, Session } from "../../shared/domain";
import { api } from "../api";
import { strings, translateError, type Key } from "../i18n";
import { channelLabel, tenderMethodLabel } from "../labels";
import { Badge, Button, Field, Modal } from "../components/ui";
import { printDocument, usePrintSettings } from "../print";
import { requestSellingContext } from "../serviceHooks";
import { VoidDialog } from "./VoidDialog";
import { ServiceAssignment } from "./ServiceAssignment";
import { RefundDialog } from "./RefundDialog";
import {
  ReceiptDocument,
  auditPrint,
  checkStateOf,
  noteEditableOf,
} from "./Receipt";
import { KitchenTicketDocument, ticketsForOpenRounds } from "./KitchenTicket";

const reasonKey: Record<string, Key> = {
  settled: "serviceCloseReasonSettled",
  released: "serviceCloseReasonReleased",
  voided: "serviceCloseReasonVoided",
  recovery: "serviceCloseReasonRecovery",
};

/** Full order history: items, voids, notes, kitchen rounds, payments and actions. */
export function OrderDetail({
  orderId,
  session,
  locale,
  money,
  navigate,
  close,
  changed,
}: {
  orderId: string;
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  navigate: (view: string) => void;
  close: () => void;
  changed: () => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** After a note edit, comandas printed at send time still show the old note. */
  const [offerReprint, setOfferReprint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<
    "void" | "service" | "refund" | "note" | null
  >(null);
  const [settings] = usePrintSettings();
  const closeKey = useRef(crypto.randomUUID());
  const zone =
    order?.restaurantSnapshot?.timezone ?? session.restaurant.timezone;
  const time = (v: string | Date | null | undefined) =>
    v
      ? new Date(v).toLocaleTimeString(locale, {
          timeZone: zone,
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
  async function load() {
    try {
      setOrder(await api<Order>("/orders/" + orderId));
      setError("");
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    }
  }
  useEffect(() => {
    void load();
  }, [orderId]);
  const saved = async () => {
    await load();
    changed();
  };
  const manager = ["owner", "manager"].includes(session.role);
  const state = order ? checkStateOf(order) : "open";
  const closed = state === "closed";
  const balance = order ? order.total - order.paid : 0;
  const refundable = order
    ? order.tenders.some(
        (x: any) => x.method === "cash" && x.amount > x.refunded,
      )
    : false;
  const voidable = order?.paymentUnits?.some((u) => u.paid === 0) ?? false;
  const holdsTable = order?.mode === "dine_in" && !!order?.tableId;
  const notes = order ? roundNotes(order) : [];
  return (
    <Modal
      wide
      title={t("serviceDetailTitle").replace(
        "{n}",
        String(order?.number ?? ""),
      )}
      close={close}
      closeLabel={t("close")}
    >
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {offerReprint && order && ticketsForOpenRounds(order).length > 0 && (
        <Button
          onClick={() =>
            void printDocument(
              ticketsForOpenRounds(order).map((ticket, i) => (
                <KitchenTicketDocument
                  key={i}
                  ticket={ticket}
                  locale={locale}
                  timezone={zone}
                />
              )),
              settings.paper,
            )
          }
        >
          <Printer size={16} />
          {t("serviceReprintKitchen")}
        </Button>
      )}
      {!order ? (
        !error && <p>{t("loading")}</p>
      ) : (
        <div className="order-detail">
          <p className="muted">
            {new Date(order.createdAt).toLocaleString(locale, {
              timeZone: zone,
            })}{" "}
            · {channelLabel(order.channel ?? "pos", locale)} ·{" "}
            {t(order.mode as Key)} · {order.tableName ?? t("noTable")} ·{" "}
            {order.waiterName}
            <br />
            {t("serviceDetailOpenedBy")
              .replace("{name}", order.openedBy ?? order.waiterName ?? "")
              .replace("{time}", time(order.createdAt))}
            {closed && order.closedAt && (
              <>
                <br />
                {t("serviceDetailClosedAt")
                  .replace("{time}", time(order.closedAt))
                  .replace(
                    "{reason}",
                    t(
                      reasonKey[order.closeReason ?? "settled"] ??
                        "serviceCloseReasonSettled",
                    ),
                  )}
              </>
            )}
          </p>
          <div className="row wrap">
            <Badge
              tone={closed ? "neutral" : state === "paid" ? "green" : "amber"}
            >
              {order.closeReason === "voided"
                ? t("serviceCheckVoided")
                : t(
                    closed
                      ? "serviceCheckClosed"
                      : state === "paid"
                        ? "serviceCheckPaid"
                        : "serviceCheckOpen",
                  )}
            </Badge>
          </div>
          <section>
            <h3>{t("serviceDetailItems")}</h3>
            {order.lines.map((l) => {
              const left = lineRemaining(l);
              return (
                <div className="detail-line" key={l.id}>
                  <div className="row between">
                    <span>
                      {left.quantity} × {l.name[locale]}
                      {left.quantity < l.quantity && (
                        <>
                          {" "}
                          <s className="muted">({l.quantity})</s>
                        </>
                      )}
                      <small className="muted">
                        {" "}
                        · {t("round")} {l.round}
                      </small>
                    </span>
                    <strong>{money(left.total)}</strong>
                  </div>
                  {l.optionNames.map((o, i) => (
                    <div className="line-option" key={i}>
                      + {o[locale]}
                    </div>
                  ))}
                  {l.note && <p className="line-note">{l.note}</p>}
                </div>
              );
            })}
            {!!order.voids?.length && (
              <div className="void-history">
                <h4>
                  {t("voidHistory")} ({order.voids.length})
                </h4>
                <ul>
                  {order.voids.map((v) => (
                    <li key={v.id}>
                      <s>
                        {v.quantity} ×{" "}
                        {order.lines.find((l) => l.id === v.lineId)?.name[
                          locale
                        ] ?? ""}
                      </s>{" "}
                      · −{money(v.amount)} · {v.reason}
                      <br />
                      <small className="muted">
                        {t("voidBy")
                          .replace("{actor}", v.actorName)
                          .replace("{approver}", v.approverName)}
                        {v.kitchenPending && " · " + t("voidKitchenPending")}
                      </small>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
          <section>
            <h3>{t("serviceDetailOrderNote")}</h3>
            <p className={order.note ? "line-note" : "muted"}>
              {order.note || t("serviceDetailNoNote")}
            </p>
            {noteEditableOf(order) && (
              <Button onClick={() => setDialog("note")}>
                {t("serviceDetailEditNote")}
              </Button>
            )}
            {notes.map(({ round, note }) => (
              <div key={round}>
                <h4>
                  {t("serviceDetailRoundNote").replace("{n}", String(round))}
                </h4>
                <p className="line-note">{note}</p>
              </div>
            ))}
          </section>
          <section>
            <h3>{t("serviceDetailRounds")}</h3>
            <ul className="plain-list">
              {order.rounds.map((r: any) => (
                <li key={r.id}>
                  {t("serviceRoundState")
                    .replace("{n}", String(r.number))
                    .replace(
                      "{station}",
                      r.station === "bar" ? t("bar") : t("kitchen"),
                    )
                    .replace(
                      "{state}",
                      t(
                        r.state === "completed"
                          ? "serviceDetailRoundServed"
                          : r.state === "ready"
                            ? "serviceDetailRoundReady"
                            : r.seen_at
                              ? "serviceDetailRoundSeen"
                              : "serviceDetailRoundSent",
                      ),
                    )}{" "}
                  <small className="muted">
                    {[r.created_at, r.seen_at, r.ready_at, r.completed_at]
                      .filter(Boolean)
                      .map(time)
                      .join(" → ")}
                  </small>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>{t("serviceDetailPayments")}</h3>
            {!order.tenders.length && (
              <p className="muted">{t("serviceDetailNoPayments")}</p>
            )}
            {order.tenders.map((x: any) => (
              <div className="detail-line" key={x.id}>
                <div className="row between">
                  <span>
                    {tenderMethodLabel(x.method, x.source, locale)} ·{" "}
                    {time(x.created_at)}
                  </span>
                  <strong>{money(x.amount)}</strong>
                </div>
                <small className="muted">
                  {x.tip > 0 && `${t("tip")}: ${money(x.tip)} · `}
                  {x.method === "cash"
                    ? `${t("serviceReceiptReceived")}: ${money(x.received)} · ${t("change")}: ${money(changeDue(x.received, x.amount, x.tip))}`
                    : x.external_reference
                      ? t("serviceReceiptReference").replace(
                          "{ref}",
                          x.external_reference,
                        )
                      : ""}
                  {x.refunded > 0 &&
                    ` · ${t("serviceReceiptRefund")} −${money(x.refunded)}`}
                </small>
              </div>
            ))}
            <div className="row between">
              <span>{t("total")}</span>
              <strong>{money(order.total)}</strong>
            </div>
            <div className="row between">
              <span>{t("paid")}</span>
              <strong>{money(order.paid)}</strong>
            </div>
            {order.refunded > 0 && (
              <div className="row between">
                <span>{t("serviceDetailRefunded")}</span>
                <strong>−{money(order.refunded)}</strong>
              </div>
            )}
            <div className="row between">
              <span>{t("serviceDetailBalance")}</span>
              <strong>{money(balance)}</strong>
            </div>
          </section>
          <div className="row wrap">
            {!closed && !order.recovery && (
              <Button
                onClick={() => {
                  requestSellingContext({ resume: order.id });
                  close();
                  navigate("sell");
                }}
              >
                {t("resume")}
                <ArrowUpRight size={16} />
              </Button>
            )}
            {!closed && !order.recovery && (
              <Button onClick={() => setDialog("service")}>
                {t("assignService")}
              </Button>
            )}
            {!closed && !order.recovery && balance > 0 && voidable && (
              <Button variant="ghost" onClick={() => setDialog("void")}>
                {t("voidAction")}
              </Button>
            )}
            {manager && refundable && (
              <Button variant="ghost" onClick={() => setDialog("refund")}>
                {t("refund")}
              </Button>
            )}
            {!closed && balance <= 0 && (
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await api(`/service/orders/${order.id}/close`, {
                      operationId: closeKey.current,
                    });
                    closeKey.current = crypto.randomUUID();
                    await saved();
                  } catch (e) {
                    setError(translateError((e as Error).message, locale));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t(holdsTable ? "serviceReleaseTable" : "serviceCloseCheck")}
              </Button>
            )}
            {balance > 0 && !order.recovery && (
              <Button
                onClick={() => {
                  void auditPrint(order.id, "check", false);
                  void printDocument(
                    <ReceiptDocument
                      order={order}
                      session={session}
                      locale={locale}
                      kind="check"
                    />,
                    settings.paper,
                  );
                }}
              >
                <Printer size={16} />
                {t("servicePrintCheck")}
              </Button>
            )}
            {order.paid > 0 && (
              <Button
                onClick={() => {
                  void auditPrint(order.id, "receipt", true);
                  void printDocument(
                    <ReceiptDocument
                      order={order}
                      session={session}
                      locale={locale}
                      kind="receipt"
                      reprint
                    />,
                    settings.paper,
                  );
                }}
              >
                <Printer size={16} />
                {t("serviceReprintReceipt")}
              </Button>
            )}
          </div>
          <p className="muted tiny">{t("servicePrintUnconfirmed")}</p>
        </div>
      )}
      {order && dialog === "void" && (
        <VoidDialog
          order={order}
          session={session}
          locale={locale}
          money={money}
          close={() => setDialog(null)}
          saved={saved}
        />
      )}
      {order && dialog === "service" && (
        <ServiceAssignment
          order={order}
          locale={locale}
          close={() => setDialog(null)}
          saved={saved}
        />
      )}
      {order && dialog === "refund" && (
        <RefundDialog
          order={order}
          session={session}
          locale={locale}
          money={money}
          close={() => setDialog(null)}
          saved={saved}
        />
      )}
      {order && dialog === "note" && (
        <NoteDialog
          order={order}
          locale={locale}
          close={() => setDialog(null)}
          saved={async () => {
            await saved();
            setNotice(t("serviceDetailNoteSaved"));
            setOfferReprint(settings.kitchenOnSend);
          }}
        />
      )}
    </Modal>
  );
}

/** Edits the order note after sending; open kitchen tickets show the change. */
export function NoteDialog({
  order,
  locale,
  close,
  saved,
}: {
  order: Order;
  locale: Locale;
  close: () => void;
  saved: (o: Order) => Promise<void> | void;
}) {
  const t = (k: Key) => strings[locale][k];
  const [operationId] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState(order.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={t("serviceDetailEditNote")}
      close={close}
      closeLabel={t("close")}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const o = await api<Order>(`/service/orders/${order.id}/note`, {
              operationId,
              note,
            });
            await saved(o);
            close();
          } catch (err) {
            setError(translateError((err as Error).message, locale));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t("serviceDetailOrderNote")}>
          <textarea
            value={note}
            maxLength={500}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <p className="muted">{t("serviceDetailNoteHint")}</p>
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
    </Modal>
  );
}
