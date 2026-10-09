/**
 * "Cliente del club" on Detalle de orden and the Mesas check (038 §2.5). Its data comes from
 * GET /api/loyalty/orders/:id, never from getOrders (C-14). Staff add or change the member while
 * the check is open; once settled, owners and managers change it with step-up (the server says
 * forbidden or step_up_required otherwise). Online only.
 */
import { useEffect, useState } from "react";
import type { Locale, Order, Session } from "../../../shared/domain";
import type {
  LoyaltyClubView,
  MemberSummary,
  OrderLoyaltyView,
} from "../../../shared/loyalty";
import { errorNotice } from "../../i18n";
import { Button } from "../../components/ui";
import { forgetLoyaltyReceipt, loyaltyApi, prefetchLoyaltyReceipt } from "./loyaltyApi";
import { LoyaltyLookupDialog } from "./LoyaltyLookupDialog";
import { RedeemRewardButton } from "./RedeemReward";
import { dateOnly, fill, rewardsText, stampsText, tr } from "./format";
import "./loyalty.css";

export function OrderLoyaltyPanel({
  session,
  order,
  locale,
  online,
  club,
  money,
  onOrderChanged,
}: {
  session: Session;
  order: Order;
  locale: Locale;
  online: boolean;
  club: LoyaltyClubView | null;
  money: (n: number) => string;
  onOrderChanged?: (o: Order) => void;
}) {
  const t = tr(locale);
  const [view, setView] = useState<OrderLoyaltyView | null>(null);
  const [picking, setPicking] = useState<"add" | "change" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const local = !!(order as { offline?: unknown }).offline && !order.version;
  useEffect(() => {
    if (!club || !online || local) return;
    let live = true;
    loyaltyApi
      .order(order.id)
      .then((v) => {
        if (!live) return;
        setView(v);
        // A payment or a change since the last read changes the counts the receipt prints
        // (LOYALTY-OPS-7): read the block again, never the cached one.
        forgetLoyaltyReceipt(order.id);
        void prefetchLoyaltyReceipt(order.id);
      })
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [order.id, order.version, order.paid, club?.enabled, online]);
  if (!club) return null;
  const managers = ["owner", "manager"].includes(session.role);
  const canChange = view && (!view.settled || managers);
  async function apply(m: MemberSummary | null, mode = picking) {
    setBusy(true);
    setError("");
    try {
      const next =
        mode === "add" && m
          ? await loyaltyApi.link(order.id, m.id)
          : await loyaltyApi.change(order.id, m?.id ?? null, view?.member?.id ?? null);
      setView(next);
      forgetLoyaltyReceipt(order.id);
      void prefetchLoyaltyReceipt(order.id);
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
      setPicking(null);
    }
  }
  const member = view?.member ?? null;
  return (
    <section className="panel loyalty-order" aria-label={t("loyaltyOrderMember")}>
      <h3>{t("loyaltyOrderMember")}</h3>
      {!online && <p className="muted">{t("loyaltyOfflineHint")}</p>}
      {online && view && (
        <>
          {member ? (
            <p>
              <strong>{member.deleted ? t("loyaltyDeleted") : member.firstName}</strong>{" "}
              <span className="muted">
                {member.maskedPhone} · {stampsText(member, locale)}
                {member.rewards > 0 ? ` · ${rewardsText(member.rewards, locale)}` : ""}
              </span>
            </p>
          ) : (
            <p className="muted">{t("loyaltyOrderNone")}</p>
          )}
          {member && view.settled && (
            <p>
              {view.earned === 1
                ? t("loyaltyOrderEarnedOne")
                : fill(t("loyaltyOrderEarned"), { n: view.earned })}
            </p>
          )}
          {view.pending && <p className="muted">{t("loyaltyOrderPending")}</p>}
          {view.redemptions.map((r) => (
            <p key={r.discountId}>
              {r.restored
                ? t("loyaltyOrderRestored")
                : fill(t("loyaltyOrderRedemption"), { amount: money(r.amount) })}
            </p>
          ))}
          {!view.linkable && view.settled && !member && (
            <p className="muted">
              {fill(t("loyaltyOrderWindowClosed"), {
                // The window's real end (UX-9), not the days since it closed.
                date: view.windowEndsAt
                  ? dateOnly(view.windowEndsAt, session.restaurant.timezone, locale)
                  : "—",
              })}
            </p>
          )}
          <div className="row wrap">
            {!member && view.linkable && (
              <Button disabled={busy} onClick={() => setPicking("add")}>
                {t("loyaltyOrderAdd")}
              </Button>
            )}
            {member && view.linkable && canChange && (
              <>
                <Button disabled={busy} onClick={() => setPicking("change")}>
                  {t("loyaltyOrderChange")}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  // Removal is busy on the panel, not the member lookup over the page (UX-13).
                  onClick={() => void apply(null, "change")}
                >
                  {t("loyaltyRemove")}
                </Button>
              </>
            )}
            {member && order.checkState !== "closed" && (
              <RedeemRewardButton
                order={order}
                hasDraftLines={false}
                send={async () => order}
                member={member}
                club={club}
                locale={locale}
                online={online}
                money={money}
                onApplied={(o, loyalty) => {
                  onOrderChanged?.(o);
                  setView(loyalty);
                }}
              />
            )}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {picking && (
        <LoyaltyLookupDialog
          locale={locale}
          club={club}
          online={online}
          onUse={(m) => void apply(m)}
          onClose={() => setPicking(null)}
        />
      )}
    </section>
  );
}
