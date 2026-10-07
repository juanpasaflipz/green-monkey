import { useState } from "react";
import { api } from "../api";
import { Button, Field, Modal } from "../components/ui";
import { strings, errorNotice, translateError, type Key } from "../i18n";
import type { Locale, Order, Session } from "../../shared/domain";
import { stepUpExempt } from "../../shared/access";
import { voidCandidates } from "../../shared/discounts";
import {
  ManagerApproval,
  type ApprovalValue,
} from "../components/ManagerApproval";
import { readPrintSettings } from "../print";
import { currentBusinessDate, orderNumberLabel } from "../labels";
import {
  cancellationsFromVoid,
  type KitchenCancellationModel,
} from "./printing/cancellations";
import { printCancellations } from "./printing/KitchenCancellationDocument";

/**
 * Voids unpaid units of an order. Paid units are excluded (they need a refund).
 * Cashiers and servers need a manager's PIN, checked by the server for this
 * single request; nothing about the approval is stored on the device. Managers
 * on a shared terminal confirm with their own PIN instead of self-approving.
 */
export function VoidDialog({
  order,
  session,
  locale,
  money,
  close,
  saved,
  today,
}: {
  order: Order;
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  close: () => void;
  saved: () => Promise<void>;
  /** The current business date (Órdenes: the list's); else the session's (LD-29). */
  today?: string | null;
}) {
  const t = (key: Key) => strings[locale][key];
  const manager = ["owner", "manager"].includes(session.role);
  // Only a Google-entered session on a personal device self-approves (A4).
  const needsApproval = !manager || !stepUpExempt(session.access);
  const [approval, setApproval] = useState<ApprovalValue>({
    employeeId: "",
    secret: "",
  });
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [returnStock, setReturnStock] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One id per dialog: a retried submit after a lost response replays safely.
  const [operationId] = useState(() => crypto.randomUUID());
  // reports (029): the void is saved but its cancellation chit did not print. The dialog then
  // offers only a print retry or Cerrar, never a second void with this operation id.
  const [unprinted, setUnprinted] = useState<KitchenCancellationModel[] | null>(
    null,
  );
  const print = (chits: KitchenCancellationModel[]) =>
    printCancellations(chits, locale, session.restaurant.timezone);

  const units = order.paymentUnits ?? [];
  const lines = order.lines.map((line) => {
    const lineUnits = units.filter((u) => u.lineId === line.id);
    // discounts (028): the order the server voids them in, undiscounted
    // first; the balance drops by each unit's net (gross minus its discount).
    const candidates = voidCandidates(order, line.id);
    return {
      line,
      candidates,
      voidable: candidates.length,
      paid: lineUnits.length - candidates.length,
      unitPrice: candidates[0]
        ? candidates[0].total - candidates[0].discount
        : line.unitPrice,
    };
  });
  const selected = Object.entries(quantities).filter(([, q]) => q > 0);
  const count = selected.reduce((a, [, q]) => a + q, 0);
  const amount = lines.reduce(
    (a, l) =>
      a +
      l.candidates
        .slice(0, quantities[l.line.id] ?? 0)
        .reduce((n, u) => n + u.total - u.discount, 0),
    0,
  );
  // Stock can return only while every affected ticket is still unseen.
  const returnAllowed = selected.every(([lineId]) => {
    const line = order.lines.find((l) => l.id === lineId)!;
    const round = order.rounds.find(
      (r) => r.number === line.round && r.station === line.station,
    );
    return round && round.state === "active" && !round.seen_at;
  });

  return (
    <Modal title={t("voidItems")} close={close} closeLabel={t("close")} wide>
      <p>
        {orderNumberLabel(
          order,
          today || currentBusinessDate(session.restaurant),
          locale,
        )}{" "}
        · {order.name || t("order")}
      </p>
      {unprinted ? (
        <>
          <p role="status">{t("reportsKitchenCancelVoidDone")}</p>
          <p className="error" role="alert">
            {t("reportsKitchenCancelPrintFailed")}
          </p>
          <div className="row">
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const printed = await print(unprinted);
                setBusy(false);
                if (printed) close();
              }}
            >
              {t("reportsKitchenCancelRetry")}
            </Button>
            <Button onClick={close}>{t("close")}</Button>
          </div>
        </>
      ) : !order.itemSplitAvailable ? (
        <p className="error" role="alert">
          {translateError("unallocated_history", locale)}
        </p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!count) {
              setError(t("voidNothing"));
              return;
            }
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              const reason = String(f.get("reason") ?? "");
              const after = await api<Order>(`/orders/${order.id}/voids`, {
                operationId,
                expectedVersion: order.version,
                lines: selected.map(([lineId, quantity]) => ({
                  lineId,
                  quantity,
                })),
                reason,
                stockDisposition:
                  returnStock && returnAllowed ? "return" : "no_return",
                ...(needsApproval
                  ? {
                      approval: {
                        employeeId: approval.employeeId,
                        secret: approval.secret,
                      },
                    }
                  : {}),
              });
              // reports (029): with "Imprimir comanda al enviar" the kitchen gets a
              // cancellation chit; printing never fails the void.
              const chits = readPrintSettings().kitchenOnSend
                ? cancellationsFromVoid(order, after, reason, {
                    today: today || currentBusinessDate(session.restaurant),
                    locale,
                  })
                : [];
              const printed = await print(chits);
              await saved();
              if (!printed) {
                setUnprinted(chits);
                return;
              }
              close();
            } catch (err) {
              setError(errorNotice(err, locale));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="void-lines">
            {lines.map(({ line, voidable, paid, unitPrice }) => (
              <Field
                key={line.id}
                label={`${line.name[locale]} · ${money(unitPrice)}`}
              >
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={voidable}
                  value={quantities[line.id] ?? 0}
                  disabled={!voidable}
                  aria-describedby={paid ? `paid-${line.id}` : undefined}
                  onChange={(e) =>
                    setQuantities((q) => ({
                      ...q,
                      [line.id]: Math.max(
                        0,
                        Math.min(voidable, Number(e.target.value) || 0),
                      ),
                    }))
                  }
                />
                {paid > 0 && (
                  <small id={`paid-${line.id}`} className="muted">
                    {t("voidPaidUnits").replace("{n}", String(paid))}
                  </small>
                )}
              </Field>
            ))}
          </div>
          <Field label={t("voidReason")}>
            <input name="reason" required minLength={3} maxLength={300} />
          </Field>
          <fieldset className="field">
            <legend>{t("voidStock")}</legend>
            <label className="choice">
              <input
                type="radio"
                name="stock"
                checked={!returnStock || !returnAllowed}
                onChange={() => setReturnStock(false)}
              />
              {t("voidNoReturn")}
            </label>
            <label className="choice">
              <input
                type="radio"
                name="stock"
                disabled={!returnAllowed || !count}
                checked={returnStock && returnAllowed}
                onChange={() => setReturnStock(true)}
              />
              {t("voidReturnStock")}
            </label>
            {count > 0 && !returnAllowed && (
              <p className="muted">{t("voidReturnUnavailable")}</p>
            )}
          </fieldset>
          {needsApproval && (
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
          <Button
            variant="primary"
            className="full"
            type="submit"
            disabled={busy || !count}
          >
            {t("voidConfirm").replace("{n}", String(count))} · −{money(amount)}
          </Button>
        </form>
      )}
    </Modal>
  );
}
