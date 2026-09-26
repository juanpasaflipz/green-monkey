import { useState } from "react";
import { api } from "../api";
import { Button, Field, Modal } from "../components/ui";
import { strings, translateError, type Key } from "../i18n";
import type { Locale, Order, Session } from "../../shared/domain";

/**
 * Voids unpaid units of an order. Paid units are excluded (they need a refund).
 * Cashiers and servers need a manager's login and PIN, checked by the server for
 * this single request; nothing about the approval is stored on the device.
 */
export function VoidDialog({
  order,
  session,
  locale,
  money,
  close,
  saved,
}: {
  order: Order;
  session: Session;
  locale: Locale;
  money: (n: number) => string;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const t = (key: Key) => strings[locale][key];
  const manager = ["owner", "manager"].includes(session.role);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [returnStock, setReturnStock] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One id per dialog: a retried submit after a lost response replays safely.
  const [operationId] = useState(() => crypto.randomUUID());

  const units = order.paymentUnits ?? [];
  const lines = order.lines.map((line) => {
    const lineUnits = units.filter((u) => u.lineId === line.id);
    const unpaid = lineUnits.filter((u) => u.paid === 0);
    return {
      line,
      voidable: unpaid.length,
      paid: lineUnits.length - unpaid.length,
      unitPrice: unpaid[0]?.total ?? line.unitPrice,
    };
  });
  const selected = Object.entries(quantities).filter(([, q]) => q > 0);
  const count = selected.reduce((a, [, q]) => a + q, 0);
  const amount = lines.reduce(
    (a, l) => a + (quantities[l.line.id] ?? 0) * l.unitPrice,
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
        #{order.number} · {order.name || t("order")}
      </p>
      {!order.itemSplitAvailable ? (
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
              await api(`/orders/${order.id}/voids`, {
                operationId,
                expectedVersion: order.version,
                lines: selected.map(([lineId, quantity]) => ({
                  lineId,
                  quantity,
                })),
                reason: String(f.get("reason") ?? ""),
                stockDisposition:
                  returnStock && returnAllowed ? "return" : "no_return",
                ...(manager
                  ? {}
                  : {
                      approval: {
                        login: String(f.get("managerLogin") ?? ""),
                        secret: String(f.get("managerPin") ?? ""),
                      },
                    }),
              });
              await saved();
              close();
            } catch (err) {
              setError(translateError((err as Error).message, locale));
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
          {!manager && (
            <fieldset className="field">
              <legend>{t("voidApproval")}</legend>
              <p className="muted">{t("voidApprovalHint")}</p>
              <Field label={t("managerLogin")}>
                <input
                  name="managerLogin"
                  required
                  autoComplete="off"
                  autoCapitalize="none"
                />
              </Field>
              <Field label={t("managerPin")}>
                <input
                  name="managerPin"
                  type="password"
                  inputMode="numeric"
                  required
                  minLength={4}
                  autoComplete="off"
                />
              </Field>
            </fieldset>
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
