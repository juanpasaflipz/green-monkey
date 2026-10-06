import { useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import {
  recordKind,
  type OfflineRecordKind,
} from "../../../shared/offline-recovery";
import { api } from "../../api";
import { Button, Field } from "../../components/ui";
import { translateError } from "../../i18n";
import { db, type Pending } from "../../offline";
import { dependencyOf, settleAlreadySynced } from "../../offline-queue";
import { reconciledResult } from "../../offline-records";
import { carriesMoney, translator } from "./format";

/** POST /api/offline/review (§4.3.5 plus the review explanations). */
export type OfflineReviewDetail = {
  authentic: boolean;
  problems: string[];
  /** Each problem in words a manager can act on (OFFLINE-RECOVERY-03). */
  reasons?: string[];
  kind: OfflineRecordKind;
  collected: number;
  tip: number;
  method: "cash" | "external" | null;
  reference: string | null;
  recordedAt: string;
  recordedAtDevice: string | null;
  clockOffsetMs: number | null;
  soldAt: string | null;
  provisionalNumber: string | null;
  currentTotal: number | null;
  originalEmployee: string | null;
  originalDrawerId: string | null;
  drawerClosed: boolean | null;
  sessionRevoked: boolean | null;
  prior: { kind: string } | null;
  archived: boolean;
  target: { orderId: string; number: number; due: number } | null;
  reconcilable: boolean;
  reconcileAs?: "order" | "financial" | null;
  /** OFF-R30: sync takes the order an online create made for this draft. */
  reusesOnlineOrder?: boolean;
  /** OFFLINE-RECOVERY-04: who must sign in, and where, for it to sync. */
  autoSyncAs?: {
    employeeName: string | null;
    deviceName: string | null;
    self: boolean;
  } | null;
};

type Line = { quantity: number; name: { es: string; en: string } };

/**
 * Manager review of one local record: the evidence, why it has not synced,
 * what will happen to it, and the actions that fit (reconcile, mark as
 * recorded, archive).
 */
export function OfflineReviewPanel({
  row,
  detail,
  rows,
  locale,
  session,
  busy,
  waiting,
  kindLabel,
  format,
  run,
  onArchive,
  onClose,
}: {
  row: Pending;
  detail: OfflineReviewDetail;
  /** The rows the Sync screen lists, for this order's dependent records. */
  rows: Pending[];
  locale: Locale;
  session: Session;
  busy: boolean;
  /** The record waits for its original order (I5). */
  waiting: boolean;
  kindLabel: string;
  format: (minor: number) => string;
  run: (fn: () => Promise<void>) => void;
  onArchive: () => void;
  onClose: () => void;
}) {
  const es = locale === "es",
    t = translator(locale);
  const [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [anyway, setAnyway] = useState(false);
  const { kind, target } = detail;
  const money = carriesMoney(kind);
  const external = detail.method === "external";
  const recorded = detail.prior?.kind === "offline_sync";
  const into =
    (detail.reconcileAs ?? (target ? "order" : "financial")) === "order";
  const reasons = detail.reasons ?? detail.problems;
  const autoSync = !recorded && !detail.archived ? detail.autoSyncAs : null;
  const offerReconcile =
    detail.reconcilable && !waiting && (!autoSync || anyway);
  const name = (line: Line) => line.name[locale] ?? line.name.es;
  // OFF-R30: this device's rounds and payments of a local order.
  const dependents =
    kind === "order"
      ? rows.filter(
          (other) =>
            other.status !== "archived" && dependencyOf(other.body) === row.id,
        )
      : [];
  const sentOrder =
    kind === "order" && target
      ? detail.reusesOnlineOrder && autoSync
        ? "sync"
        : detail.problems.includes("offline_order_already_exists")
          ? "other"
          : "archive"
      : null;
  const soldOnline = kind === "sale" && target && !detail.reconcilable;
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await navigator.locks.request(
            "green-monkey-session-transition",
            { mode: "shared" },
            () =>
              navigator.locks.request(
                "green-monkey-sync:" + row.scope,
                async () => {
                  const order = await api(
                    "/offline/reconcile",
                    { record: row.body, reason, confirmed },
                    { idempotent: true },
                  );
                  // OFF-R18: store the tender the reconcile made, so offline
                  // balances never count this payment twice.
                  await db.pending.update(row.id, {
                    status: "synced",
                    result: reconciledResult(row.id, order),
                    syncedAt: Date.now(),
                    error: undefined,
                    waitReason: undefined,
                  });
                },
              ),
          );
          onClose();
        });
      }}
    >
      <h3>
        {money
          ? t(
              external
                ? "offlineReviewTitleExternal"
                : "offlineReviewTitleCash",
            )
          : t(
              kind === "round"
                ? "offlineReviewTitleRound"
                : "offlineReviewTitleOrder",
            )}
      </h3>
      <dl className="offline-evidence">
        <dt>{es ? "Registro" : "Record"}</dt>
        <dd>
          {kindLabel}
          {detail.provisionalNumber ? ` · ${detail.provisionalNumber}` : ""}
        </dd>
        <dt>{es ? "Verificación" : "Verification"}</dt>
        <dd>
          {detail.authentic
            ? es
              ? "Evidencia verificada"
              : "Evidence verified"
            : translateError("offline_evidence_invalid", locale)}
        </dd>
        {reasons.length > 0 && (
          <>
            <dt>{es ? "Motivo" : "Reason"}</dt>
            <dd>
              {reasons.map((code) => (
                <span className="offline-reason" key={code}>
                  {translateError(code, locale)}{" "}
                </span>
              ))}
            </dd>
          </>
        )}
        <dt>{es ? "Empleado" : "Employee"}</dt>
        <dd>{detail.originalEmployee ?? "—"}</dd>
        {detail.sessionRevoked !== null && (
          <>
            <dt>{t("offlineReviewSession")}</dt>
            <dd>
              {t(
                detail.sessionRevoked
                  ? "offlineReviewSessionRevoked"
                  : "offlineReviewSessionValid",
              )}
            </dd>
          </>
        )}
        {money && (
          <>
            <dt>{es ? "Cobrado" : "Collected"}</dt>
            <dd>
              {format(detail.collected)} + {format(detail.tip)}{" "}
              {es ? "propina" : "tip"}
              {detail.method
                ? ` · ${t(external ? "offlineMethodExternal" : "offlineMethodCash")}`
                : ""}
              {detail.reference ? ` · ${detail.reference}` : ""}
            </dd>
          </>
        )}
        {(kind !== "payment" || detail.currentTotal !== null) && (
          <>
            <dt>{es ? "Precio actual" : "Current price"}</dt>
            <dd>
              {detail.currentTotal === null
                ? es
                  ? "No disponible"
                  : "Unavailable"
                : format(detail.currentTotal)}
            </dd>
          </>
        )}
        <dt>{es ? "Hora de venta" : "Sale time"}</dt>
        <dd>
          {new Date(detail.soldAt ?? detail.recordedAt).toLocaleString(
            es ? "es-MX" : "en-US",
            { timeZone: session.restaurant.timezone },
          )}
        </dd>
        {(money || detail.originalDrawerId) && (
          <>
            <dt>{es ? "Caja original" : "Original drawer"}</dt>
            <dd>
              {detail.originalDrawerId?.slice(0, 8) ?? "—"} ·{" "}
              {detail.drawerClosed
                ? es
                  ? "cerrada; se mostrará un ajuste posterior"
                  : "closed; a late adjustment will be shown"
                : es
                  ? "abierta"
                  : "open"}
            </dd>
          </>
        )}
        {target && (
          <>
            <dt>{es ? "Orden" : "Order"}</dt>
            <dd>
              #{target.number} · {format(target.due)}
            </dd>
          </>
        )}
        <dt>{t("offlineReviewOnServer")}</dt>
        <dd>
          {t(
            recorded
              ? "offlineReviewRecorded"
              : detail.archived
                ? "offlineReviewArchived"
                : "offlineReviewNotYet",
          )}
        </dd>
      </dl>
      {waiting && (
        <p className="warning-panel" role="status">
          {translateError("offline_dependency_pending", locale)}
        </p>
      )}
      {recorded && (
        <p className="warning-panel" role="status">
          {t("offlineAlreadyRecorded")}
        </p>
      )}
      {detail.archived && !recorded && (
        <p className="warning-panel" role="status">
          {t("offlineAlreadyArchived")}
        </p>
      )}
      {autoSync && (
        <p className="warning-panel" role="status">
          {autoSync.self
            ? t("offlineAutoSyncSelf")
            : t("offlineAutoSyncOther", {
                name: autoSync.employeeName ?? "—",
                device: autoSync.deviceName ?? "—",
              })}
        </p>
      )}
      {/* OFF-R27/R30: a sale or order whose create already committed online
          names that order and says whether this record syncs into it. */}
      {sentOrder && target && (
        <div className="warning-panel" role="status">
          <p>
            {t(
              sentOrder === "sync"
                ? "offlineExistingOrderWillSync"
                : sentOrder === "other"
                  ? "offlineExistingOrderOtherDraft"
                  : "offlineExistingOrderSent",
              { n: target.number },
            )}
          </p>
          {sentOrder === "archive" &&
            dependents.some((other) => recordKind(other.body) === "round") && (
              <>
                <p>{t("offlineDependentsRounds", { n: target.number })}</p>
                <ul>
                  {dependents
                    .filter((other) => recordKind(other.body) === "round")
                    .map((other) => (
                      <li key={other.id}>
                        {t("offlineDependentRound", {
                          items: (
                            ((
                              other.body as {
                                receiptSnapshot?: { lines?: Line[] };
                              }
                            ).receiptSnapshot?.lines ?? []) as Line[]
                          )
                            .map((line) => `${line.quantity} × ${name(line)}`)
                            .join(", "),
                        })}
                      </li>
                    ))}
                </ul>
              </>
            )}
          {sentOrder === "archive" &&
            dependents.some(
              (other) => recordKind(other.body) === "payment",
            ) && (
              <ul>
                {dependents
                  .filter((other) => recordKind(other.body) === "payment")
                  .map((other) => (
                    <li key={other.id}>
                      {t("offlineDependentPayment", {
                        amount: format(
                          (other.body as { payment?: { amount: number } })
                            .payment?.amount ?? 0,
                        ),
                      })}
                    </li>
                  ))}
              </ul>
            )}
        </div>
      )}
      {soldOnline && target && (
        <p className="warning-panel" role="status">
          {target.due > 0
            ? t("offlineExistingOrderCharge", {
                n: target.number,
                due: format(target.due),
              })
            : t("offlineExistingOrderPaid", { n: target.number })}
        </p>
      )}
      {!money && !target && !recorded && !detail.archived && (
        <p className="muted">{t("offlineNoMoney")}</p>
      )}
      {money &&
        detail.authentic &&
        !detail.reconcilable &&
        !recorded &&
        !detail.archived &&
        !waiting &&
        !soldOnline && <p className="muted">{t("offlineNotReconcilable")}</p>}
      {detail.reconcilable && !waiting && autoSync && !anyway && (
        <Button onClick={() => setAnyway(true)}>
          {t("offlineReconcileAnyway")}
        </Button>
      )}
      {offerReconcile && (
        <>
          <p>
            {into && target
              ? t("offlineReconcileIntoOrder", { n: target.number })
              : t(
                  external
                    ? "offlineReconcileRecoveryExternal"
                    : "offlineReconcileRecovery",
                )}
          </p>
          <Field label={t("offlineReconcileReason")}>
            <textarea
              required
              minLength={10}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <label className="row">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {into && target
              ? t(
                  external
                    ? "offlineReconcileConfirmIntoOrderExternal"
                    : "offlineReconcileIntoOrderConfirm",
                  { n: target.number },
                )
              : t(
                  external
                    ? "offlineReconcileConfirmExternal"
                    : "offlineReconcileConfirmCash",
                )}
          </label>
          <Button
            type="submit"
            disabled={busy || !confirmed || reason.trim().length < 10}
          >
            {t(
              external
                ? "offlineReconcileSubmitExternal"
                : "offlineReconcileSubmitCash",
            )}
          </Button>
        </>
      )}
      {recorded && (
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await settleAlreadySynced(row);
              onClose();
            })
          }
        >
          {t("offlineMarkRecorded")}
        </Button>
      )}
      {!recorded && <Button onClick={onArchive}>{t("offlineArchive")}</Button>}
      <Button onClick={onClose}>{es ? "Cancelar" : "Cancel"}</Button>
    </form>
  );
}
