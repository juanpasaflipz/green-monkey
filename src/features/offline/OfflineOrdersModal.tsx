import { useEffect, useState } from "react";
import {
  currencyExponent,
  type Locale,
  type Session,
} from "../../../shared/domain";
import {
  cachedServerOpenOrders,
  localOpenOrders,
  type LocalOrderView,
} from "../../offline-records";
import { Button, Empty, Modal } from "../../components/ui";
import { currentBusinessDate } from "../../labels";
import { clockTime, moneyFormatter, orderLabel, translator } from "./format";

/**
 * One check in the offline pick list, named as the cart heading names it (orderLabel):
 * "B-07", "B-07 → #142", "#10", and dated when it is from another business day
 * ("#10 · 5 oct", LD-48), so yesterday's open #10 is never picked for today's.
 */
export function OfflineOrderRow({
  order,
  today,
  locale,
  due,
  onPick,
}: {
  order: LocalOrderView;
  today: string;
  locale: Locale;
  due: string;
  onPick: (order: LocalOrderView) => void;
}) {
  return (
    <Button className="full" onClick={() => onPick(order)}>
      <span>
        {orderLabel(order, today, locale)}
        {order.tableName ? ` · ${order.tableName}` : ""}
        {order.name ? ` · ${order.name}` : ""}
      </span>
      <strong>{due}</strong>
    </Button>
  );
}

/** Open orders this device can keep serving while offline (§2.3). */
export function OfflineOrdersModal({
  session,
  locale,
  onPick,
  close,
}: {
  session: Session;
  locale: Locale;
  onPick: (order: LocalOrderView) => void;
  close: () => void;
}) {
  const t = translator(locale);
  const money = moneyFormatter(
    locale,
    session.restaurant.currency,
    currencyExponent(session.restaurant.currency),
  );
  const [state, setState] = useState<{
    refreshedAt: string | null;
    server: LocalOrderView[];
    local: LocalOrderView[];
  } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([
      cachedServerOpenOrders(session),
      localOpenOrders(session),
    ]).then(([cached, local]) => {
      if (live)
        setState({
          refreshedAt: cached.refreshedAt,
          server: cached.orders.filter((order) => order.total > order.paid),
          local,
        });
    });
    return () => {
      live = false;
    };
  }, [session.id]);
  const today = currentBusinessDate(session.restaurant);
  const row = (order: LocalOrderView) => (
    <OfflineOrderRow
      key={order.id}
      order={order}
      today={today}
      locale={locale}
      due={money(order.total - order.paid)}
      onPick={onPick}
    />
  );
  return (
    <Modal title={t("offlineOpenOrders")} close={close} closeLabel={t("close")}>
      {state === null ? (
        <p role="status">{t("loading")}</p>
      ) : !state.server.length && !state.local.length ? (
        <Empty title={t("offlineOpenOrdersEmpty")} />
      ) : (
        <>
          {state.server.length > 0 && (
            <section>
              <h3>
                {t("offlineOpenOrdersCached", {
                  time: state.refreshedAt
                    ? clockTime(
                        state.refreshedAt,
                        session.restaurant.timezone,
                        locale,
                      )
                    : "—",
                })}
              </h3>
              {state.server.map(row)}
            </section>
          )}
          {state.local.length > 0 && (
            <section>
              <h3>{t("offlineOpenOrdersLocal")}</h3>
              {state.local.map(row)}
            </section>
          )}
        </>
      )}
    </Modal>
  );
}
