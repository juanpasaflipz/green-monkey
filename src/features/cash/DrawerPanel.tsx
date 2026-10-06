import { useState, type ReactNode } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { Badge, Button } from "../../components/ui";
import { strings, type Key } from "../../i18n";
import { tenderMethodLabel } from "../../labels";
import { countText, fill } from "../discounts/format";
import { DrawerCloseDialog, type DrawerView } from "./DrawerCloseDialog";
import "./cash.css";

/**
 * Caja (§2.7): this device's drawer with cash and external-terminal money
 * apart. Roles that may not see expected cash get the blind-count notice
 * instead of the cash card (the server sends no cash figures to them). The
 * terminal card is for every operator: it is compared with the terminal's own
 * batch report and is never in the drawer. `actions` is reports' slot (Corte
 * X, reports 029), rendered after "Cerrar caja".
 */
export function DrawerPanel({
  session,
  locale,
  data,
  money,
  onOpenDrawer,
  onPaidOut,
  beforeClose,
  notice,
  onChanged,
  actions,
}: {
  session: Session;
  locale: Locale;
  data: DrawerView | null;
  money: (n: number) => string;
  onOpenDrawer: () => void;
  onPaidOut: () => void;
  beforeClose?: () => Promise<string | null>;
  notice?: ReactNode;
  onChanged: () => void | Promise<void>;
  actions?: ReactNode;
}) {
  const t = (k: Key) => strings[locale][k];
  const manager = ["owner", "manager"].includes(session.role);
  const [closing, setClosing] = useState(false);
  const zone = session.restaurant.timezone;
  const time = (v: string) =>
    new Date(v).toLocaleTimeString(locale, {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
    });
  if (!data || data.closed_at)
    return (
      <div className="panel narrow">
        <Badge>{t("drawerClosed")}</Badge>
        <h2>{t("openDrawer")}</h2>
        <p>{t("noDrawer")}</p>
        <Button variant="primary" onClick={onOpenDrawer}>
          {t("openDrawer")}
        </Button>
        {data &&
          data.discrepancy !== null &&
          data.discrepancy !== undefined && (
            <p>
              {t("difference")}: {money(data.discrepancy)}
            </p>
          )}
      </div>
    );
  const cash = data.cash;
  const cashRows = cash
    ? [
        ...data.tenders
          .filter((x) => x.method === "cash")
          .map((x) => ({
            id: x.id,
            at: x.created_at,
            label: `${t("discountsDrawerMovementSale")} · ${tenderMethodLabel(x.method, x.source, locale)}`,
            amount: x.amount + x.tip,
          })),
        ...data.refunds
          .filter((x) => x.method !== "external")
          .map((x) => ({
            id: x.id,
            at: x.created_at,
            label: t("discountsDrawerMovementRefund"),
            amount: -x.amount,
          })),
        ...data.movements.map((x) => ({
          id: x.id,
          at: x.created_at,
          label: `${t("discountsDrawerMovementPaidOut")}${x.reason ? " · " + x.reason : ""}`,
          amount: x.amount,
        })),
      ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    : [];
  return (
    <div className="drawer-panel">
      <div className="drawer-head">
        <div>
          <Badge tone="green">{t("drawerOpen")}</Badge>
          <p className="muted">
            {fill(t("discountsDrawerOpenedBy"), {
              name: data.openedByName,
              time: time(data.opened_at),
            })}{" "}
            ·{" "}
            {fill(t("discountsDrawerOpening"), { amount: money(data.opening) })}{" "}
            ·{" "}
            {countText(
              t,
              "discountsDrawerPayments",
              "discountsDrawerPaymentsOne",
              data.paymentCount,
            )}
          </p>
        </div>
        <div className="row wrap">
          {manager && <Button onClick={onPaidOut}>{t("paidOut")}</Button>}
          {data.canClose && (
            <Button variant="primary" onClick={() => setClosing(true)}>
              {t("closeDrawer")}
            </Button>
          )}
          {actions}
        </div>
      </div>
      <div className="drawer-cards">
        {cash ? (
          <section className="panel drawer-card">
            <h2>{t("discountsDrawerCash")}</h2>
            <dl className="cash-figures">
              <dt>{t("discountsDrawerCashSales")}</dt>
              <dd>{money(cash.sales)}</dd>
              <dt>{t("discountsDrawerCashTips")}</dt>
              <dd>{money(cash.tips)}</dd>
              <dt>{t("discountsDrawerCashRefunds")}</dt>
              <dd>−{money(cash.refunds)}</dd>
              <dt>{t("discountsDrawerPaidOuts")}</dt>
              <dd>−{money(-cash.movements)}</dd>
              <dt>
                <strong>{t("discountsDrawerExpected")}</strong>
              </dt>
              <dd>
                <strong>{money(cash.expected)}</strong>
              </dd>
            </dl>
          </section>
        ) : (
          <section className="panel drawer-card">
            <h2>{t("discountsDrawerCash")}</h2>
            <p className="muted" role="note">
              {t("discountsDrawerBlindNotice")}
            </p>
          </section>
        )}
        <section className="panel drawer-card">
          <h2>{t("discountsDrawerCard")}</h2>
          <dl className="cash-figures">
            <dt>{t("discountsDrawerCardSales")}</dt>
            <dd>{money(data.external.sales)}</dd>
            <dt>{t("discountsDrawerCardTips")}</dt>
            <dd>{money(data.external.tips)}</dd>
            <dt>{t("discountsDrawerCardRefunds")}</dt>
            <dd>−{money(data.external.refunds)}</dd>
            <dt>
              <strong>{t("discountsDrawerCardNet")}</strong>
            </dt>
            <dd>
              <strong>{money(data.external.net)}</strong>
            </dd>
          </dl>
          <p className="muted tiny">{t("discountsDrawerCardHint")}</p>
        </section>
      </div>
      {cash && (
        <>
          <h2>{t("discountsDrawerCashMovements")}</h2>
          {cashRows.length ? (
            <div className="data-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("date")}</th>
                    <th>{t("method")}</th>
                    <th>{t("amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {cashRows.map((r) => (
                    <tr key={r.id}>
                      <td>{time(r.at)}</td>
                      <td>{r.label}</td>
                      <td>{money(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">{t("discountsDrawerNoMovements")}</p>
          )}
        </>
      )}
      {data.tenders.some((x) => x.method === "external") && (
        <>
          <h2>{t("discountsDrawerTerminalMovements")}</h2>
          <div className="data-table">
            <table>
              <thead>
                <tr>
                  <th>{t("date")}</th>
                  <th>{t("amount")}</th>
                  <th>{t("tip")}</th>
                </tr>
              </thead>
              <tbody>
                {data.tenders
                  .filter((x) => x.method === "external")
                  .map((x) => (
                    <tr key={x.id}>
                      <td>{time(x.created_at)}</td>
                      <td>{money(x.amount)}</td>
                      <td>{money(x.tip)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {closing && (
        <DrawerCloseDialog
          session={session}
          locale={locale}
          money={money}
          drawer={data}
          notice={notice}
          beforeClose={beforeClose}
          close={() => setClosing(false)}
          closed={async () => {
            setClosing(false);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}
