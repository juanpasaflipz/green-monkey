import { CashHistory } from "./CashHistory";
import { DeviceManagement } from "./DeviceManagement";
import { StaffManagement } from "./StaffManagement";
import { RecoveryQueue } from "./RecoveryQueue";
import { FreeSelection } from "./FreeSelection";
import { PublicOrderingSettings } from "./public/PublicOrderingSettings";
import { PlanSettings } from "./PlanSettings";
import { Orders } from "./Orders";
import { Tables } from "./Tables";
import { Kitchen } from "./Kitchen";
import { RestaurantSettings } from "./RestaurantSettings";
import { FiscalSettings } from "./fiscal/FiscalSettings";
import { CfdiSettings } from "./cfdi/CfdiSettings";
import { AccountPrivacy } from "./AccountPrivacy";
import { currencyExponent } from "../../shared/domain";
import { ManagementTools } from "./ManagementTools";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { minor, type Session, type Locale } from "../../shared/domain";
import { strings, errorNotice, type Key } from "../i18n";
import { integrationLabel, operationLabel, stockCauseLabel } from "../labels";
import { api } from "../api";
import { db, isResolved } from "../offline";
import { ArchivedDrawerNote } from "./offline/ArchivedDrawerNote";
import { OfflineKitchenReview } from "./offline/OfflineKitchenReview";
import { Button, Field, Modal, Badge } from "../components/ui";
import { DrawerPanel } from "./cash/DrawerPanel";
import {
  cachedDrawer as readCachedDrawer,
  rememberDrawer,
  type DrawerFact,
} from "./cash/drawer-cache";
import type { DrawerView } from "./cash/DrawerCloseDialog";
import { DrawerReviewDialog } from "./cash/DrawerReviewDialog";
import { MoneyControlsSettings } from "./cash/MoneyControlsSettings";
import type { CashHistoryRow } from "./CashHistory";
import { TodayDashboard } from "./reports/TodayDashboard";
import { ReportsView, openReports } from "./reports/ReportsView";
import { CortePrintButton } from "./reports/CortePrintButton";
import { CORTE_BLIND_WINDOW_HOURS } from "../../shared/reports";
import { dateTime } from "../datetime";
export function Operations({
  view,
  session,
  locale,
  navigate,
  online = true,
}: {
  view: string;
  session: Session;
  locale: Locale;
  navigate: (s: string) => void;
  /** Connectivity from App (contract §0.8); discounts and refunds need it. */
  online?: boolean;
}) {
  const t = (k: Key) => strings[locale][k];
  const exponent = currencyExponent(session.restaurant.currency);
  const scale = 10 ** exponent;
  const parseAmount = (s: string) => minor(s, exponent);
  const m = (n: number) =>
    new Intl.NumberFormat(locale === "es" ? "es-MX" : "en-US", {
      style: "currency",
      currency: session.restaurant.currency,
    }).format(n / scale);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  /** offline (026, ACC-PR-1): Caja shows this device's cached drawer. */
  const [cachedDrawer, setCachedDrawer] = useState(false);
  /** offline (ACC-PR-3): the device's drawer fact, when this employee has no copy. */
  const [drawerFact, setDrawerFact] = useState<DrawerFact | null>(null);
  // One operation id per opened dialog, kept across retries (MON-3).
  const [modal, setModalState] = useState<{
    kind: string;
    item?: any;
    operationId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<any[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  /** Opening a dialog creates its operation id; closing it discards the id. */
  const setModal = (next: { kind: string; item?: any } | null) =>
    setModalState(next && { ...next, operationId: crypto.randomUUID() });
  async function load() {
    try {
      // These views load and poll by themselves (reports 029: Hoy and Finanzas follow the
      // connection and the header's Actualizar through `online` and `refreshKey`).
      if (
        ["orders", "tables", "kitchen", "sync", "today", "finance"].includes(
          view,
        )
      ) {
        setData(null);
        return;
      }
      if (view === "settings") setData(await api("/capabilities"));
      else if (view === "cash") {
        try {
          const drawer = await api<DrawerView | null>("/cash");
          setData(drawer);
          setCachedDrawer(false);
          setDrawerFact(null);
          void rememberDrawer(session, drawer);
        } catch (e) {
          // offline (026): during an outage Caja shows the drawer this device
          // last saw (Selling caches it), never "Caja cerrada" with "Abrir
          // caja"; the offline notice stays above it (restaurant-day A13.8).
          // Only its state: the cached figures are not live and never include
          // offline sales (ACC-PR-1); they load again with the connection. An
          // employee with no copy of their own sees the device's drawer fact
          // (open, when and by whom; ACC-PR-3).
          const cached = await readCachedDrawer(session);
          if (online || !cached) throw e;
          setData(cached.view ?? null);
          setDrawerFact(cached.fact ?? null);
          setCachedDrawer(true);
          setError(errorNotice(e, locale));
          return;
        }
      } else setData(await api("/" + view));
      setError("");
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    setLoading(true);
    setData(null);
    setDetail(null);
    setCachedDrawer(false);
    setDrawerFact(null);
    void load();
  }, [view]);
  useEffect(() => {
    // ACC-PR-1: the cached drawer's note promises the figures on reconnect.
    if (online && view === "cash" && cachedDrawer) void load();
  }, [online]);
  /**
   * offline (026): this device's local sales must sync before its drawer is
   * closed. Returns the translated reason, or null (discounts' close dialog
   * shows it in place).
   */
  async function pendingCloseCheck(): Promise<string | null> {
    const pending = await db.pending
      .filter(
        (p) =>
          p.scope.startsWith(session.tenantId + ":" + session.deviceId + ":") &&
          !isResolved(p),
      )
      .count();
    return pending ? t("syncBeforeClose") : null;
  }
  // discounts (028): "Revisar diferencia" from the drawer history.
  const [reviewing, setReviewing] = useState<CashHistoryRow | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  async function action(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(path, body);
      setModal(null);
      await load();
    } catch (e) {
      setError(errorNotice(e, locale));
    } finally {
      setBusy(false);
    }
  }
  const manager = ["owner", "manager"].includes(session.role);
  // Same stock quantity format as menu's Insumos history (up to 6 decimals).
  const stockQuantity = new Intl.NumberFormat(
    locale === "es" ? "es-MX" : "en-US",
    { maximumFractionDigits: 6 },
  );
  return (
    <>
      <div className="section-title">
        <div>
          <span className="eyebrow">{session.restaurant.name}</span>
          <h1>{t(view as Key)}</h1>
        </div>
        <Button
          aria-label={t("reload")}
          onClick={() => {
            setRefreshKey((n) => n + 1);
            void load();
          }}
        >
          <RefreshCw size={18} />
          {t("reload")}
        </Button>
      </div>
      {manager && (
        <ManagementTools
          view={view}
          session={session}
          locale={locale}
          refresh={load}
        />
      )}{" "}
      {view === "settings" && (
        <>
          <RestaurantSettings session={session} locale={locale} />
          {manager && <FiscalSettings session={session} locale={locale} />}
          {manager && <CfdiSettings session={session} locale={locale} />}
          {manager && (
            <MoneyControlsSettings session={session} locale={locale} />
          )}
          {["owner", "manager"].includes(session.role) && (
            <AccountPrivacy session={session} locale={locale} />
          )}
          <PublicOrderingSettings
            session={session}
            locale={locale}
            online={online}
            navigate={navigate}
          />
          {session.role === "owner" && <FreeSelection locale={locale} />}
          {manager && <DeviceManagement session={session} locale={locale} />}
          <PlanSettings
            tenantId={session.tenantId}
            locale={locale}
            timezone={session.restaurant.timezone}
          />
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p>{t("loading")}</p>
      ) : (
        <>
          {view === "orders" && (
            <Orders
              session={session}
              locale={locale}
              navigate={navigate}
              refreshKey={refreshKey}
              online={online}
            />
          )}
          {view === "tables" && (
            <Tables
              session={session}
              locale={locale}
              navigate={navigate}
              refreshKey={refreshKey}
              onEditTables={manager ? () => navigate("floor") : undefined}
            />
          )}
          {view === "kitchen" && (
            <Kitchen
              session={session}
              locale={locale}
              refreshKey={refreshKey}
              beforeTickets={(station) => (
                <OfflineKitchenReview
                  session={session}
                  locale={locale}
                  station={station}
                  onDecided={() => setRefreshKey((n) => n + 1)}
                />
              )}
            />
          )}
          {view === "cash" && manager && (
            <CashHistory
              key={historyKey}
              locale={locale}
              currency={session.restaurant.currency}
              timezone={session.restaurant.timezone}
              rowActions={(row) => (
                <>
                  {row.needs_review && (
                    <Button onClick={() => setReviewing(row)}>
                      {t("discountsReviewAction")}
                    </Button>
                  )}
                  {/* reports (029): the corte Z of a closed drawer (LD-16 L6). */}
                  <CortePrintButton
                    session={session}
                    locale={locale}
                    drawerId={row.id}
                    label={t("reportsPrintCorteZ")}
                    online={online}
                  />
                </>
              )}
            />
          )}
          {view === "cash" && (
            <DrawerPanel
              session={session}
              locale={locale}
              data={data}
              online={online}
              cached={cachedDrawer}
              fact={drawerFact}
              money={m}
              onOpenDrawer={() => setModal({ kind: "open" })}
              onPaidOut={() => setModal({ kind: "paidout" })}
              beforeClose={pendingCloseCheck}
              // reports (029): Corte X of the open drawer for a viewer who may see expected cash;
              // the closed drawer's corte Z or count slip (a cashier's own device, 12 h); and the
              // close dialog's result step (wave2-cross-track C10).
              actions={
                data && !data.closed_at && data.visibility === "full" ? (
                  <CortePrintButton
                    session={session}
                    locale={locale}
                    drawerId={data.id}
                    label={t("reportsCorteX")}
                    online={online}
                  />
                ) : undefined
              }
              closedActions={
                data?.closed_at &&
                (manager ||
                  Date.now() - Date.parse(data.closed_at) <
                    CORTE_BLIND_WINDOW_HOURS * 3_600_000) ? (
                  <CortePrintButton
                    session={session}
                    locale={locale}
                    drawerId={data.id}
                    label={t(
                      data.visibility === "full"
                        ? "reportsReprintCorteZ"
                        : "reportsPrintCountSlip",
                    )}
                    online={online}
                  />
                ) : undefined
              }
              closeResultActions={(result) => (
                <CortePrintButton
                  session={session}
                  locale={locale}
                  drawerId={result.id}
                  label={t(
                    result.visibility === "full"
                      ? "reportsPrintCorteZ"
                      : "reportsPrintCountSlip",
                  )}
                  online={online}
                />
              )}
              notice={
                data && (
                  <ArchivedDrawerNote
                    session={session}
                    drawerId={data.id}
                    locale={locale}
                    money={m}
                  />
                )
              }
              onChanged={async () => {
                setHistoryKey((n) => n + 1);
                await load();
              }}
            />
          )}
          {reviewing && (
            <DrawerReviewDialog
              drawerId={reviewing.id}
              session={session}
              locale={locale}
              money={m}
              figures={{
                expected: reviewing.expected,
                counted: reviewing.counted,
              }}
              close={() => setReviewing(null)}
              saved={() => {
                setReviewing(null);
                setHistoryKey((n) => n + 1);
              }}
            />
          )}
          {view === "inventory" && (
            <>
              <div className="row between">
                <p className="muted">{t("inventoryHint")}</p>
                <Button onClick={() => setModal({ kind: "prep" })}>
                  {t("prep")}
                </Button>
              </div>
              <div className="stock-grid">
                {data?.map((r: any) => (
                  <article className="panel" key={r.id}>
                    <div className="row between">
                      <h2>{r.name}</h2>
                      <Badge
                        tone={
                          Number(r.quantity) < 0
                            ? "red"
                            : Number(r.quantity) <= Number(r.threshold)
                              ? "amber"
                              : "green"
                        }
                      >
                        {Number(r.quantity) < 0
                          ? `${t("menuStockNegative")} · ${r.unit}`
                          : r.unit}
                      </Badge>
                    </div>
                    <div className="large-money">
                      {new Intl.NumberFormat(locale).format(Number(r.quantity))}
                    </div>
                    <p className="muted">
                      {t("version")} {r.version}
                    </p>
                    <div className="row wrap">
                      <Button
                        onClick={() => setModal({ kind: "receipt", item: r })}
                      >
                        {t("receive")}
                      </Button>
                      <Button
                        onClick={() =>
                          setModal({ kind: "count_adjust", item: r })
                        }
                      >
                        {t("count")}
                      </Button>
                      <Button
                        onClick={() => setModal({ kind: "waste", item: r })}
                      >
                        {t("waste")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          setDetail(await api("/inventory/" + r.id));
                          setModal({ kind: "history" });
                        }}
                      >
                        {t("history")}
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
          {view === "today" && (
            <TodayDashboard
              session={session}
              locale={locale}
              navigate={navigate}
              online={online}
              refreshKey={refreshKey}
            />
          )}
          {view === "finance" && (
            <ReportsView
              session={session}
              locale={locale}
              navigate={navigate}
              online={online}
              refreshKey={refreshKey}
            />
          )}
          {view === "team" && (
            <StaffManagement session={session} locale={locale} />
          )}
          {view === "settings" && (
            <>
              <div className="panel">
                <h2>{t("restaurant")}</h2>
                <p>
                  {session.restaurant.name} · {session.restaurant.currency} ·{" "}
                  {session.restaurant.timezone}
                </p>
                <Badge tone="green">{t("device")}</Badge>
              </div>
              <h2>{t("integrations")}</h2>
              <div className="stock-grid">
                {Object.entries(data ?? {}).map(([key, v]) => (
                  <div className="panel" key={key}>
                    <div className="row between">
                      <h3>{integrationLabel(key, locale)}</h3>
                      <Badge tone={(v as any).enabled ? "green" : "amber"}>
                        {t((v as any).enabled ? "available" : "disabled")}
                      </Badge>
                    </div>
                    {!(v as any).enabled && <p>{t("blockedHint")}</p>}
                  </div>
                ))}
              </div>
              {/* reports (029): the paged Bitácora replaces the newest-100 list. */}
              <Button
                onClick={() => {
                  openReports("audit");
                  navigate("finance");
                }}
              >
                {t("audit")}
              </Button>
            </>
          )}
          {view === "sync" && (
            <RecoveryQueue session={session} locale={locale} />
          )}
        </>
      )}
      {modal && (
        <Modal
          title={t(
            (
              {
                open: "openDrawer",
                paidout: "paidOut",
                receipt: "receive",
                count_adjust: "count",
                history: "movements",
              } as Record<string, Key>
            )[modal.kind] ?? (modal.kind as Key),
          )}
          close={() => setModal(null)}
          closeLabel={t("close")}
        >
          {["history", "audit"].includes(modal.kind) ? (
            <div className="history">
              {detail?.map((r: any) => (
                <div className="report-row" key={r.id}>
                  <span>
                    {r.cause !== undefined
                      ? stockCauseLabel(r.cause, locale)
                      : operationLabel(r.operation, locale)}
                    {r.reason && <small>{r.reason}</small>}
                  </span>
                  <strong>
                    {r.quantity ?? ""}
                    {r.cause !== undefined && (
                      // menu (025) §2.10: the ledger trigger's balance after
                      // this movement; null for movements recorded before 025.
                      <small>
                        {t("menuStockBalance")}:{" "}
                        {r.balance_after == null
                          ? "—"
                          : stockQuantity.format(Number(r.balance_after))}
                      </small>
                    )}
                  </strong>
                  <time>
                    {dateTime(
                      r.created_at,
                      session.restaurant.timezone,
                      locale,
                    )}
                  </time>
                </div>
              ))}
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const operationId = modal.operationId;
                try {
                  if (modal.kind === "open")
                    await action("/cash/open", {
                      operationId,
                      opening: parseAmount(String(f.get("amount"))),
                    });
                  else if (modal.kind === "paidout")
                    await action("/cash/paid-out", {
                      operationId,
                      amount: parseAmount(String(f.get("amount"))),
                      reason: f.get("reason"),
                    });
                  else if (modal.kind === "prep")
                    await action("/inventory/prep", {
                      operationId,
                      inputId: f.get("inputId"),
                      inputQuantity: f.get("inputQuantity"),
                      outputId: f.get("outputId"),
                      outputQuantity: f.get("outputQuantity"),
                      reason: f.get("reason"),
                    });
                  else
                    await action("/inventory/movement", {
                      operationId,
                      stockId: modal.item.id,
                      quantity: f.get("amount"),
                      kind: modal.kind,
                      reason: f.get("reason"),
                      expectedVersion: modal.item.version,
                    });
                } catch (e) {
                  setError(errorNotice(e, locale));
                }
              }}
            >
              {modal.kind === "prep" ? (
                <>
                  {["input", "output"].map((k) => (
                    <div key={k}>
                      <Field label={t(k as Key)}>
                        <select name={k + "Id"}>
                          {data.map((i: any) => (
                            <option value={i.id} key={i.id}>
                              {i.name} ({i.unit})
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={t("quantity")}>
                        <input
                          name={k + "Quantity"}
                          inputMode="decimal"
                          required
                          pattern="[0-9]+(\.[0-9]{1,6})?"
                        />
                      </Field>
                    </div>
                  ))}
                </>
              ) : (
                <Field
                  label={t(
                    modal.kind === "open"
                      ? "opening"
                      : modal.item
                        ? "quantity"
                        : "amount",
                  )}
                >
                  <input
                    name="amount"
                    inputMode="decimal"
                    required
                    pattern="[0-9]+(\.[0-9]{1,6})?"
                    defaultValue={modal.kind === "open" ? "500.00" : ""}
                  />
                </Field>
              )}
              {modal.kind !== "open" && (
                <Field label={t("reason")}>
                  <textarea name="reason" required minLength={3} />
                </Field>
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
                disabled={busy}
              >
                {t("save")}
              </Button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
