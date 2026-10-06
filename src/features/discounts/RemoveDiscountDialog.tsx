import { useState } from "react";
import type { Locale, Order, Session } from "../../../shared/domain";
import type { OrderDiscount } from "../../../shared/discounts";
import { api } from "../../api";
import { Button, Field, Modal } from "../../components/ui";
import {
  ManagerApproval,
  type ApprovalValue,
} from "../../components/ManagerApproval";
import { strings, translateError, type Key } from "../../i18n";
import { fill, removableAfterReload } from "./format";
import "./discounts.css";

/**
 * "Quitar descuento": the discount's single reversal. Staff need a manager's
 * PIN; a manager or owner confirms with their own step-up when asked. Only
 * while the check is open (or a paid table check), none of its units is paid
 * and no later discount covers them; the server answers
 * discount_not_reversible otherwise.
 *
 * A check with a fiscal ticket keeps its discounts (FISCAL-2): the server
 * answers fiscal_ticket_issued and the dialog says so and reloads.
 *
 * On stale_order (another device changed the check) the dialog reloads the
 * order, keeps the reason and the operation id, hands the fresh order to the
 * parent through `refreshed` (so the screen behind it re-evaluates its version
 * and removability) and asks to confirm again (spec §5.3, DSC-R2).
 */
export function RemoveDiscountDialog({
  order: initial,
  discount: chosen,
  session,
  locale,
  money,
  close,
  removed,
  refreshed,
}: {
  order: Order;
  discount: OrderDiscount;
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  close: () => void;
  removed: (o: Order) => void | Promise<void>;
  refreshed?: (o: Order) => void | Promise<void>;
}) {
  const t = (k: Key) => strings[locale][k];
  const staff = !["owner", "manager"].includes(session.role);
  const [operationId] = useState(() => crypto.randomUUID());
  const [order, setOrder] = useState(initial);
  // Set by reload(): from then on the fresh order decides (DSC-R10).
  const [reloaded, setReloaded] = useState(false);
  const [note, setNote] = useState("");
  const [approval, setApproval] = useState<ApprovalValue>({
    employeeId: "",
    secret: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = removableAfterReload(order, chosen, reloaded);
  const discount =
    live ?? (order.discounts ?? []).find((d) => d.id === chosen.id) ?? chosen;
  const amount = money(discount.activeAmount);

  /** Reloads the order; tells the user when the discount cannot go any more. */
  async function reload() {
    try {
      const fresh = await api<Order>("/orders/" + order.id);
      setOrder(fresh);
      setReloaded(true);
      if (!removableAfterReload(fresh, chosen, true))
        setError(translateError("discount_not_reversible", locale));
      await refreshed?.(fresh);
    } catch {
      /* the message already shown says what to do */
    }
  }

  return (
    <Modal title={t("discountsRemove")} close={close} closeLabel={t("close")}>
      <form
        className="discounts-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!live) return;
          setBusy(true);
          setError("");
          try {
            const o = await api<Order>(
              `/orders/${order.id}/discounts/${discount.id}/reverse`,
              {
                operationId,
                expectedVersion: order.version,
                note: note.trim(),
                ...(staff
                  ? {
                      approval: {
                        employeeId: approval.employeeId,
                        secret: approval.secret,
                      },
                    }
                  : {}),
              },
            );
            await removed(o);
            close();
          } catch (err) {
            const code = (err as Error).message;
            const message =
              code === "stale_order"
                ? t("discountsStaleOrder")
                : code === "fiscal_ticket_issued"
                  ? t("discountsTicketIssued")
                  : code === "operation_conflict"
                    ? t("discountsOperationRecorded")
                    : translateError(code, locale);
            setError(message);
            if (
              [
                "stale_order",
                "discount_not_reversible",
                // FISCAL-2: the check got its ticket meanwhile; its discounts are final.
                "fiscal_ticket_issued",
                // CONCURRENCY-4: an earlier attempt of this dialog was recorded.
                "operation_conflict",
              ].includes(code)
            ) {
              await reload();
              if (code !== "stale_order") setError(message);
            }
            setApproval((a) => ({ ...a, secret: "" }));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>{fill(t("discountsRemoveHint"), { amount })}</p>
        <Field label={t("discountsRemoveReason")}>
          <textarea
            required
            minLength={3}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {staff && (
          <ManagerApproval
            session={session}
            locale={locale}
            value={approval}
            onChange={setApproval}
          />
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row wrap">
          <Button onClick={close}>{t("discountsCancel")}</Button>
          <Button variant="primary" type="submit" disabled={busy || !live}>
            {fill(t("discountsRemoveConfirm"), { amount })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
