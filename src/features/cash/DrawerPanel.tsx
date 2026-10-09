import { useState, type ReactNode } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { Badge, Button } from "../../components/ui";
import { strings, type Key } from "../../i18n";
import { tenderLabel } from "../../labels";
import { PLATFORM_KEYS } from "../payments/PlatformFields";
import type { PlatformCode } from "../../../shared/payments";
import { countText, fill } from "../discounts/format";
import { DrawerCloseDialog, type DrawerView } from "./DrawerCloseDialog";
import type { DrawerFact } from "./drawer-cache";
import "./cash.css";

/**
 * Caja (§2.7): this device's drawer with cash and external-terminal money
 * apart. Roles that may not see expected cash get the blind-count notice
 * instead of the cash card (the server sends no cash figures to them). The
 * terminal card is for every operator: it is compared with the terminal's own
 * batch report and is never in the drawer. `actions` is reports' slot (Corte
 * X, reports 029), rendered after "Cerrar caja"; `closedActions` is the same
 * slot on a closed drawer (reprint of its corte Z or count slip) and
 * `closeResultActions` the close dialog's result step (wave2-cross-track C10).
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
  closedActions,
  closeResultActions,
  online = true,
  cached = false,
  fact = null,
}: {
  /** offline (026): closing and paid-outs need the server. */
  online?: boolean;
  /**
   * offline (026, ACC-PR-1): `data` is the copy this device cached while
   * online, shown during an outage. Its figures are not live and never include
   * offline sales, so only the drawer's state is shown (open or closed, who
   * opened it and when, the opening float) with a note that the figures come
   * back with the connection.
   */
  cached?: boolean;
  /**
   * offline (ACC-PR-3): with no copy of their own (`data` null), the device's
   * drawer fact: open or closed, when and by whom, never a figure.
   */
  fact?: DrawerFact | null;
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
  closedActions?: ReactNode;
  closeResultActions?: (result: DrawerView) => ReactNode;
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
      hourCycle: "h23",
    });
  const offlineNote = !online && (
    <p className="muted tiny" id="drawer-offline">
      {t("discountsDrawerOffline")}
    </p>
  );
  const cachedNote = cached && (
    <p className="muted" role="note">
      {t("discountsDrawerCachedNote")}
    </p>
  );
  if (!data && fact?.open)
    return (
      <div className="drawer-panel">
        <div className="drawer-head">
          <div>
            <Badge tone="green">{t("drawerOpen")}</Badge>
            <p className="muted">
              {fill(t("discountsDrawerOpenedBy"), {
                name: fact.openedByName,
                time: time(fact.openedAt),
              })}
            </p>
          </div>
          {offlineNote}
          {cachedNote}
        </div>
      </div>
    );
  if (!data || data.closed_at)
    return (
      <div className="panel narrow">
        <Badge>{t("drawerClosed")}</Badge>
        <h2>{t("openDrawer")}</h2>
        <p>{t("noDrawer")}</p>
        {/* ACC-PR-3: opening a drawer needs the server. */}
        <Button
          variant="primary"
          disabled={!online}
          aria-describedby={online ? undefined : "drawer-open-offline"}
          onClick={onOpenDrawer}
        >
          {t("openDrawer")}
        </Button>
        {!online && (
          <p className="muted tiny" id="drawer-open-offline">
            {t("discountsDrawerOpenOffline")}
          </p>
        )}
        {data &&
          !cached &&
          data.discrepancy !== null &&
          data.discrepancy !== undefined && (
            <p>
              {t("difference")}: {money(data.discrepancy)}
            </p>
          )}
        {data && closedActions}
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
            label: `${t("discountsDrawerMovementSale")} · ${tenderLabel(x, locale)}`,
            amount: x.amount + x.tip,
          })),
        // payments (037): only cash refunds leave the drawer's cash.
        ...data.refunds
          .filter((x) => x.method === "cash")
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
            {fill(t("discountsDrawerOpening"), { amount: money(data.opening) })}
            {!cached && (
              <>
                {" "}
                ·{" "}
                {countText(
                  t,
                  "discountsDrawerPayments",
                  "discountsDrawerPaymentsOne",
                  data.paymentCount,
                )}
              </>
            )}
          </p>
        </div>
        <div className="row wrap">
          {manager && (
            <Button
              disabled={!online}
              aria-describedby={online ? undefined : "drawer-offline"}
              onClick={onPaidOut}
            >
              {t("paidOut")}
            </Button>
          )}
          {data.canClose && (
            <Button
              variant="primary"
              disabled={!online}
              aria-describedby={online ? undefined : "drawer-offline"}
              onClick={() => setClosing(true)}
            >
              {t("closeDrawer")}
            </Button>
          )}
          {actions}
        </div>
        {offlineNote}
        {cachedNote}
      </div>
      {!cached && (
        <>
          <div className="drawer-cards">
            {cash ? (
              <section className="panel drawer-card">
                <h2>{t("discountsDrawerCash")}</h2>
                <dl className="cash-figures">
                  {/* UI-10: the float is part of the bold total, so it is a row too. */}
                  <dt>{t("discountsDrawerOpeningRow")}</dt>
                  <dd>{money(data.opening)}</dd>
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
              {(data.byTerminal ?? []).some((r) => r.terminalId) && (
                <div
                  className="data-table"
                  role="region"
                  aria-label={t("cashCardByTerminal")}
                  tabIndex={0}
                >
                  <table aria-label={t("cashCardByTerminal")}>
                    <caption>{t("cashCardByTerminal")}</caption>
                    <thead>
                      <tr>
                        <th>{t("payTerminal")}</th>
                        <th>{t("discountsDrawerCardSales")}</th>
                        <th>{t("discountsDrawerCardTips")}</th>
                        <th>{t("discountsDrawerCardNet")}</th>
                        {manager && <th>{t("cashTerminalFees")}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(data.byTerminal ?? []).map((r) => (
                        <tr key={r.terminalId ?? "other"}>
                          <td>{r.label ?? t("payOtherTerminal")}</td>
                          <td>{money(r.amount)}</td>
                          <td>{money(r.tips)}</td>
                          <td>{money(r.net)}</td>
                          {manager && (
                            <td>
                              {r.fees
                                ? money(r.fees.provider + r.fees.estimated)
                                : "—"}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {!!data.platform?.count && (
              <section className="panel drawer-card">
                <h2>{t("cashPlatforms")}</h2>
                <dl className="cash-figures">
                  {(data.platforms ?? []).map((p) => (
                    <div key={p.platform} className="contents">
                      <dt>{t(PLATFORM_KEYS[p.platform as PlatformCode])}</dt>
                      <dd>
                        {money(p.net)}
                        {manager &&
                        p.commission !== undefined &&
                        p.commission > 0
                          ? ` · ${t("cashPlatformCommissions")}: ${money(p.commission)}`
                          : ""}
                      </dd>
                    </div>
                  ))}
                  <dt>
                    <strong>{t("discountsDrawerCardNet")}</strong>
                  </dt>
                  <dd>
                    <strong>{money(data.platform.net)}</strong>
                  </dd>
                </dl>
              </section>
            )}
          </div>
          {!!data.unresolvedAttempts?.length && (
            <div className="warning-panel" role="status">
              <p>{t("cashUnresolvedAttempts")}</p>
              <ul>
                {data.unresolvedAttempts.map((a) => (
                  <li key={a.id}>
                    {a.holdLabel
                      ? t("payAttemptKiosk").replace("{label}", a.holdLabel)
                      : t("payAttemptOrder").replace(
                          "{number}",
                          String(a.orderNumber ?? ""),
                        )}{" "}
                    · {a.terminal} · {money(a.amount)}
                  </li>
                ))}
              </ul>
            </div>
          )}
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
          resultActions={closeResultActions}
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
