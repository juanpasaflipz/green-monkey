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
import { clockTime, moneyFormatter, translator } from "./format";

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
  const row = (order: LocalOrderView) => (
    <Button className="full" key={order.id} onClick={() => onPick(order)}>
      <span>
        {order.offline.provisionalNumber ?? `#${order.number}`}
        {order.offline.provisionalNumber && order.number
          ? ` → #${order.number}`
          : ""}
        {order.tableName ? ` · ${order.tableName}` : ""}
        {order.name ? ` · ${order.name}` : ""}
      </span>
      <strong>{money(order.total - order.paid)}</strong>
    </Button>
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
