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
import { fill } from "./format";
import "./discounts.css";

/**
 * "Quitar descuento": the discount's single reversal. Staff need a manager's
 * PIN; a manager or owner confirms with their own step-up when asked. Only
 * while the check is open (or a paid table check), none of its units is paid
 * and no later discount covers them; the server answers
 * discount_not_reversible otherwise.
 */
export function RemoveDiscountDialog({
  order,
  discount,
  session,
  locale,
  money,
  close,
  removed,
}: {
  order: Order;
  discount: OrderDiscount;
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  close: () => void;
  removed: (o: Order) => void | Promise<void>;
}) {
  const t = (k: Key) => strings[locale][k];
  const staff = !["owner", "manager"].includes(session.role);
  const [operationId] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState("");
  const [approval, setApproval] = useState<ApprovalValue>({
    employeeId: "",
    secret: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const amount = money(discount.activeAmount);
  return (
    <Modal title={t("discountsRemove")} close={close} closeLabel={t("close")}>
      <form
        className="discounts-form"
        onSubmit={async (e) => {
          e.preventDefault();
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
          <Button variant="primary" type="submit" disabled={busy}>
            {fill(t("discountsRemoveConfirm"), { amount })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
