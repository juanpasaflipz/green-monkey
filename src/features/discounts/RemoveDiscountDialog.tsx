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
import { discountRemovable, fill } from "./format";
import "./discounts.css";

/** The discount as `order` shows it, when it can still be removed there. */
function removableIn(order: Order, discountId: string) {
  const d = (order.discounts ?? []).find((x) => x.id === discountId);
  return d && discountRemovable(order, d) ? d : null;
}

/**
 * "Quitar descuento": the discount's single reversal. Staff need a manager's
 * PIN; a manager or owner confirms with their own step-up when asked. Only
 * while the check is open (or a paid table check), none of its units is paid
 * and no later discount covers them; the server answers
 * discount_not_reversible otherwise.
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
  const [note, setNote] = useState("");
  const [approval, setApproval] = useState<ApprovalValue>({
    employeeId: "",
    secret: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = order === initial ? chosen : removableIn(order, chosen.id);
  const discount =
    live ?? (order.discounts ?? []).find((d) => d.id === chosen.id) ?? chosen;
  const amount = money(discount.activeAmount);

  /** Reloads the order; tells the user when the discount cannot go any more. */
  async function reload() {
    try {
      const fresh = await api<Order>("/orders/" + order.id);
      setOrder(fresh);
      if (!removableIn(fresh, chosen.id))
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
            setError(
              code === "stale_order"
                ? t("discountsStaleOrder")
                : translateError(code, locale),
            );
            if (code === "stale_order" || code === "discount_not_reversible")
              await reload();
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
