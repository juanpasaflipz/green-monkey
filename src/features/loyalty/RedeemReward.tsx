/**
 * "Canjear premio" (038 §2.6): next to Descuento in Vender's check block and in Detalle de orden,
 * when the order's member has a reward. With unsent lines it first asks to send them (only sent,
 * unpaid units take a reward, as for any discount). The preview is discounts' pure planDiscount
 * with the reward's request; the server replans under the order lock and refuses a different
 * result (discount_changed). No PIN: the member's ledger proves the reward.
 */
import { useId, useMemo, useState } from "react";
import { Gift } from "lucide-react";
import type { Locale, Order } from "../../../shared/domain";
import {
  balanceDue,
  discountExpectation,
  discountIsFinal,
  planDiscount,
} from "../../../shared/discounts";
import {
  rewardDiscountRequest,
  type LoyaltyClubView,
  type MemberSummary,
  type OrderLoyaltyView,
} from "../../../shared/loyalty";
import { api } from "../../api";
import { errorNotice, strings } from "../../i18n";
import { Button, Field, Modal } from "../../components/ui";
import { loyaltyApi } from "./loyaltyApi";
import { fill, tr } from "./format";
import "./loyalty.css";

/**
 * The unit the reward goes to by default: the one worth most to the customer, its due capped at
 * the reward's maximum (the burrito, not the agua, LOYALTY-UX-11); ties keep the ticket's order.
 */
export function rewardLineFor(order: Order, cap: number | null): string | null {
  let best: { lineId: string; value: number } | null = null;
  for (const u of order.paymentUnits ?? []) {
    if (!(u.due > 0) || u.lineDiscounted) continue;
    const value = cap === null ? u.due : Math.min(u.due, cap);
    if (!best || value > best.value) best = { lineId: u.lineId, value };
  }
  return best?.lineId ?? null;
}

export function RedeemRewardButton({
  order,
  hasDraftLines,
  send,
  member,
  club,
  locale,
  online,
  money,
  onApplied,
}: {
  order: Order | null;
  hasDraftLines: boolean;
  send: () => Promise<Order | null>;
  member: MemberSummary | null;
  club: LoyaltyClubView | null;
  locale: Locale;
  online: boolean;
  money: (n: number) => string;
  /** The redeemed order and its club view (the member's rewards left, LOYALTY-UX-11). */
  onApplied: (o: Order, loyalty: OrderLoyaltyView) => void;
}) {
  const t = tr(locale);
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hintId = useId();
  if (!club || !member || member.rewards < 1 || member.deleted) return null;
  const enabled = online && (hasDraftLines || (!!order && balanceDue(order) > 0));
  async function open(o: Order | null) {
    if (!o) return;
    setBusy(true);
    setError("");
    try {
      setTarget(await api<Order>("/orders/" + o.id));
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className="discounts-entry">
        <button
          type="button"
          className="text-button"
          disabled={!enabled || busy}
          aria-describedby={online ? undefined : hintId}
          onClick={() => (hasDraftLines ? setConfirming(true) : void open(order))}
        >
          <Gift size={14} />
          {t("loyaltyRedeem")}
        </button>
        {!online && (
          <small id={hintId} className="tiny muted">
            {t("loyaltyOfflineHint")}
          </small>
        )}
      </span>
      {error && (
        <p className="error tiny" role="alert">
          {error}
        </p>
      )}
      {confirming && (
        <Modal
          title={strings[locale].discountsSendFirstTitle}
          close={() => setConfirming(false)}
          closeLabel={t("loyaltyClose")}
        >
          <p>{strings[locale].discountsSendFirst}</p>
          <div className="row wrap">
            <Button onClick={() => setConfirming(false)}>{t("loyaltyCancel")}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const sent = await send();
                  setConfirming(false);
                  setBusy(false);
                  await open(sent);
                } catch (e) {
                  setError(errorNotice(e, locale));
                  setBusy(false);
                }
              }}
            >
              {strings[locale].discountsSendAndContinue}
            </Button>
          </div>
        </Modal>
      )}
      {target && (
        <RedeemRewardDialog
          order={target}
          member={member}
          club={club}
          locale={locale}
          money={money}
          onClose={() => setTarget(null)}
          onDone={(o, loyalty) => {
            setTarget(null);
            onApplied(o, loyalty);
          }}
        />
      )}
    </>
  );
}

export function RedeemRewardDialog({
  order,
  member,
  club,
  locale,
  money,
  onClose,
  onDone,
}: {
  order: Order;
  member: MemberSummary;
  club: LoyaltyClubView;
  locale: Locale;
  money: (n: number) => string;
  onClose: () => void;
  onDone: (o: Order, loyalty: OrderLoyaltyView) => void;
}) {
  const t = tr(locale);
  const lines = useMemo(
    () =>
      order.lines.filter((l) =>
        (order.paymentUnits ?? []).some(
          (u) => u.lineId === l.id && u.due > 0 && !u.lineDiscounted,
        ),
      ),
    [order],
  );
  const [lineId, setLineId] = useState(() => rewardLineFor(order, club.rewardMaxAmount) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const item = club.rewardKind === "item";
  let preview: { amount: number; due: number; capped: boolean; closes: boolean } | null = null;
  let planError = "";
  try {
    const request = rewardDiscountRequest(club, order, item ? lineId : undefined);
    const plan = planDiscount(order, request);
    preview = {
      amount: plan.amount,
      due: balanceDue(order) - plan.amount,
      capped: request.kind === "amount" && item,
      closes: discountIsFinal(order, plan),
    };
  } catch (e) {
    planError = errorNotice(e, locale);
  }
  async function redeem() {
    setBusy(true);
    setError("");
    try {
      const request = rewardDiscountRequest(club, order, item ? lineId : undefined);
      const plan = planDiscount(order, request);
      const r = await loyaltyApi.redeem(order.id, {
        operationId: crypto.randomUUID(),
        memberId: member.id,
        expectedVersion: order.version,
        ...(item ? { lineId } : {}),
        ...discountExpectation(order, plan),
      });
      onDone(r.order, r.loyalty);
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={fill(t("loyaltyRedeemTitle"), { reward: club.rewardDescription })}
      close={onClose}
      closeLabel={t("loyaltyClose")}
      footer={
        <div className="row wrap">
          <Button onClick={onClose}>{t("loyaltyCancel")}</Button>
          <Button
            variant="primary"
            disabled={busy || !preview || (item && !lineId)}
            onClick={() => void redeem()}
          >
            {t("loyaltyRedeemConfirm")}
          </Button>
        </div>
      }
    >
      {item &&
        (lines.length ? (
          <Field label={t("loyaltyRedeemPickLine")}>
            <select value={lineId} onChange={(e) => setLineId(e.target.value)}>
              {lines.map((l) => {
                const unit = (order.paymentUnits ?? []).find(
                  (u) => u.lineId === l.id && u.due > 0 && !u.lineDiscounted,
                )!;
                return (
                  <option key={l.id} value={l.id}>
                    {fill(t("loyaltyRedeemLineOption"), {
                      name: l.name[locale],
                      due: money(unit.due),
                    })}
                  </option>
                );
              })}
            </select>
          </Field>
        ) : (
          <p role="status">{t("loyaltyRedeemNothing")}</p>
        ))}
      {preview && (
        <p className="loyalty-preview" role="status">
          {fill(t("loyaltyRedeemPreview"), {
            amount: money(preview.amount),
            due: money(preview.due),
          })}
        </p>
      )}
      {preview?.capped && club.rewardMaxAmount !== null && (
        <p>{fill(t("loyaltyRedeemCapped"), { cap: money(club.rewardMaxAmount) })}</p>
      )}
      {preview?.closes && <p className="warning-panel">{t("loyaltyRedeemCloses")}</p>}
      {planError && !error && <p className="muted">{planError}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Modal>
  );
}
