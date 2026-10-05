import { liveQuery } from "dexie";
import { useCallback, useEffect, useState } from "react";
import {
  currencyExponent,
  type Locale,
  type Session,
} from "../../shared/domain";
import {
  evidenceKey,
  normalizePaymentAttempt,
  recordAmounts,
  recordKind,
  recoveryBackup,
  type PaymentAttempt,
} from "../../shared/offline-recovery";
import {
  clearPaymentAttempt,
  db,
  isAttemptKey,
  scope,
  type Pending,
} from "../offline";
import { dependencyOf, isResolved, syncPending } from "../offline-queue";
import { backupFileName, buildBackups, downloadJson } from "../offline-backup";
import { CLOCK_WARNING_MS, FISCAL_LATE_MS } from "../offline-policy";
import { setWorkOffline, serverNow, useConnectivity } from "../connectivity";
import { persistenceStatus } from "../storage-persistence";
import { serviceWorkerSupported } from "../service-worker";
import { api } from "../api";
import { Button, Field } from "../components/ui";
import { translateError } from "../i18n";
import { ArchiveRecordForm } from "./offline/ArchiveRecordForm";
import { OfflineTableServiceSetting } from "./offline/OfflineTableServiceSetting";
import { reconciledResult } from "../offline-records";
import { clockTime, translator } from "./offline/format";
import "./offline/offline.css";

const PRINT_KEY = "gm-offline-print";
type Page<T> = { items: T[]; nextCursor: string | null };
type Review = {
  authentic: boolean;
  problems: string[];
  kind: string;
  collected: number;
  tip: number;
  method: string | null;
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
};
type AttemptRow = { key: string; attempt: PaymentAttempt; parked: boolean };

function readPrintSetting(): string {
  try {
    return localStorage.getItem(PRINT_KEY) ?? "ask";
  } catch {
    return "ask";
  }
}

export function RecoveryQueue({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const es = locale === "es",
    t = translator(locale),
    manager = ["owner", "manager"].includes(session.role);
  const net = useConnectivity();
  const [rows, setRows] = useState<Pending[]>([]),
    [persistent, setPersistent] = useState<boolean | null>(null),
    [autoPersist, setAutoPersist] = useState<boolean | null>(null),
    [attempts, setAttempts] = useState<AttemptRow[]>([]),
    [attemptStatus, setAttemptStatus] = useState<
      Record<string, { state: string; retryAllowed?: boolean }>
    >({}),
    [recoveries, setRecoveries] = useState<Page<any>>({
      items: [],
      nextCursor: null,
    }),
    [archives, setArchives] = useState<Page<any>>({
      items: [],
      nextCursor: null,
    }),
    [taskReview, setTaskReview] = useState<any | null>(null),
    [taskOutcome, setTaskOutcome] = useState<
      "already_completed" | "not_completed"
    >("already_completed"),
    [taskReason, setTaskReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<{ row: Pending; detail: Review } | null>(
      null,
    ),
    [archiving, setArchiving] = useState<Pending | null>(null),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [printSetting, setPrintSetting] = useState(readPrintSetting),
    [, setTick] = useState(0);
  const format = (minor: number, currency = session.restaurant.currency) =>
    new Intl.NumberFormat(es ? "es-MX" : "en-US", {
      style: "currency",
      currency,
    }).format(minor / 10 ** currencyExponent(currency));
  const visible = useCallback(
    (row: Pending) =>
      manager
        ? row.scope.startsWith(session.tenantId + ":")
        : row.scope === scope(session),
    [manager, session.tenantId, session.deviceId, session.employeeId],
  );
  // Local rows and attempts update through liveQuery: no storage polling (OFF-12).
  useEffect(() => {
    const subscription = liveQuery(async () => ({
      rows: await db.pending.filter(visible).toArray(),
      attempts: (await db.cache.filter((row) => isAttemptKey(row.id)).toArray())
        .map((row) => ({
          key: row.id,
          attempt: normalizePaymentAttempt(row.value, row.id),
          parked: !row.id.endsWith(":payment"),
        }))
        .filter(
          (row): row is AttemptRow =>
            row.attempt !== null &&
            row.attempt.tenantId === session.tenantId &&
            (manager ||
              (row.attempt.employeeId === session.employeeId &&
                row.attempt.deviceId === session.deviceId)),
        ),
    })).subscribe({
      next: (value) => {
        setRows(
          value.rows.sort(
            (a, b) =>
              Date.parse(b.body.recordedAt) - Date.parse(a.body.recordedAt),
          ),
        );
        setAttempts(value.attempts);
      },
      error: (e: Error) => setError(translateError(e.message, locale)),
    });
    return () => subscription.unsubscribe();
  }, [visible]);
  const loadServer = useCallback(async () => {
    if (!manager) return;
    const [r, a] = await Promise.all([
      api<Page<any>>("/offline/recoveries?limit=50"),
      api<Page<any>>("/offline/archives?limit=50"),
    ]);
    setRecoveries(r);
    setArchives(a);
  }, [manager]);
  // Server lists: on mount, after actions and every 30 s while visible.
  useEffect(() => {
    if (!manager || !net.canUseServer) return;
    const refresh = () =>
      void loadServer().catch((e: Error) =>
        setError(translateError(e.message, locale)),
      );
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [manager, net.canUseServer, loadServer]);
  useEffect(() => {
    void navigator.storage
      ?.persisted?.()
      .then(setPersistent)
      .catch(() => {});
    void persistenceStatus().then((status) =>
      setAutoPersist(status ? status.granted : null),
    );
    // Re-render "next attempt in" countdowns; this reads no storage.
    const timer = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(timer);
  }, []);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      if (net.canUseServer) await loadServer().catch(() => {});
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  async function more(kind: "recoveries" | "archives") {
    const page = kind === "recoveries" ? recoveries : archives;
    if (!page.nextCursor) return;
    const next = await api<Page<any>>(
      `/offline/${kind}?limit=50&cursor=${encodeURIComponent(page.nextCursor)}`,
    );
    const merged = {
      items: [...page.items, ...next.items],
      nextCursor: next.nextCursor,
    };
    if (kind === "recoveries") setRecoveries(merged);
    else setArchives(merged);
  }
  async function download() {
    const [backup] = await buildBackups({
      tenantId: session.tenantId,
      include: visible,
      attempt: (attempt) =>
        manager ||
        (attempt.employeeId === session.employeeId &&
          attempt.deviceId === session.deviceId),
    });
    downloadJson(
      backupFileName(session.tenantId),
      backup ?? {
        format: "green-monkey-recovery-v3",
        tenantId: session.tenantId,
        exportedAt: new Date().toISOString(),
        records: [],
        paymentAttempts: [],
      },
    );
  }
  async function openReview(row: Pending) {
    try {
      const detail = await api<Review>("/offline/review", row.body);
      setReview({ row, detail });
      setReason("");
      setConfirmed(false);
    } catch (e) {
      // An unparseable record can only be archived.
      if ((e as Error).message === "invalid_input") setArchiving(row);
      else throw e;
    }
  }
  const counts = rows.reduce(
    (acc, row) => {
      if (row.status === "synced") acc.synced++;
      else if (row.status === "archived") acc.archived++;
      else if (row.status === "conflict") acc.conflict++;
      else acc.pending++;
      return acc;
    },
    { pending: 0, conflict: 0, synced: 0, archived: 0 },
  );
  const oldest = rows
    .filter((row) => !isResolved(row))
    .reduce(
      (min, row) => Math.min(min, Date.parse(row.body.recordedAt)),
      Infinity,
    );
  const skew =
    net.offsetMs !== null && Math.abs(net.offsetMs) > CLOCK_WARNING_MS
      ? Math.round(Math.abs(net.offsetMs) / 60_000)
      : null;
  const kindLabel = (row: Pending) =>
    t(
      (
        {
          sale: "offlineKindSale",
          order: "offlineKindOrder",
          round: "offlineKindRound",
          payment: "offlineKindPayment",
        } as const
      )[recordKind(row.body)],
    );
  const statusLabel = (row: Pending) =>
    row.waitReason === "auth" && row.status === "pending"
      ? t("offlineRowWaitingAuth")
      : row.waitReason === "dependency" && row.status === "pending"
        ? t("offlineRowWaitingDependency")
        : t(
            (
              {
                pending: "offlineRowPending",
                syncing: "offlineRowSyncing",
                conflict: "offlineRowConflict",
                synced: "offlineRowSynced",
                archived: "offlineRowArchived",
              } as const
            )[row.status],
          );
  const currencyOf = (row: Pending) =>
    "currency" in row.body
      ? row.body.currency
      : row.receipt?.restaurant.currency;
  const amountOf = (row: Pending) => {
    const kind = recordKind(row.body);
    if (kind === "order" || kind === "round")
      return (row.body as { expectedTotal: number }).expectedTotal;
    return recordAmounts(row.body).amount;
  };
  const provisional = (row: Pending) =>
    "provisionalNumber" in row.body ? row.body.provisionalNumber : null;
  const serverNumber = (row: Pending) =>
    (row.result as { orderNumber?: number } | undefined)?.orderNumber ??
    (row.result as { number?: number } | undefined)?.number ??
    null;
  /**
   * A round or payment whose original local order is still queued: it waits
   * for that order (I5). Its money is never reconciled first, or the order
   * would later sync unpaid and the guest could be charged twice.
   */
  const waitingForOriginal = (row: Pending) => {
    const parent = dependencyOf(row.body);
    if (!parent) return false;
    const local = rows.find((other) => other.id === parent);
    return (
      (row.waitReason === "dependency" && !isResolved(row)) ||
      (!!local && !isResolved(local))
    );
  };
  const reconciled = (row: Pending) =>
    !!(
      (row.result as { recovery?: unknown } | undefined)?.recovery ??
      (row.result as { order?: { recovery?: unknown } } | undefined)?.order
        ?.recovery
    );
  return (
    <section>
      <div className="offline-sync-header">
        <p role="status">
          <strong>
            {net.manual
              ? t("offlineStatusManual")
              : !net.serverReachable
                ? t("offlineStatusOffline")
                : net.slow
                  ? t("offlineStatusSlow")
                  : t("offlineStatusOnline")}
          </strong>{" "}
          ·{" "}
          {net.lastContactAt
            ? t("offlineLastContact", {
                time: clockTime(
                  net.lastContactAt,
                  session.restaurant.timezone,
                  locale,
                ),
              })
            : t("offlineNeverContacted")}
        </p>
        {skew !== null && skew > 0 && (
          <p className="warning-panel">
            {t("offlineClockSkew", { min: skew })}
          </p>
        )}
        {serverNow() - oldest > FISCAL_LATE_MS && (
          <p className="warning-panel">{t("offlineFiscalLate")}</p>
        )}
        <label className="row">
          <input
            type="checkbox"
            role="switch"
            checked={net.manual}
            onChange={(e) => setWorkOffline(e.target.checked)}
          />
          {t("offlineWorkOffline")}
        </label>
        <p className="muted tiny">{t("offlineWorkOfflineHint")}</p>
        <Field label={t("offlinePrintSetting")}>
          <select
            value={printSetting}
            onChange={(e) => {
              setPrintSetting(e.target.value);
              try {
                localStorage.setItem(PRINT_KEY, e.target.value);
              } catch {
                /* The setting then applies to this tab only. */
              }
            }}
          >
            <option value="ask">{t("offlinePrintAsk")}</option>
            <option value="kitchen">{t("offlinePrintAutoKitchen")}</option>
            <option value="kitchen_receipt">{t("offlinePrintAutoBoth")}</option>
          </select>
        </Field>
        <OfflineTableServiceSetting session={session} locale={locale} />
        {!serviceWorkerSupported() && (
          <p className="warning-panel">{t("offlineNoServiceWorker")}</p>
        )}
        <p className="muted">{t("offlineInstallHint")}</p>
      </div>
      <p className="warning-panel">
        {es
          ? "Las ventas pendientes viven en este navegador. No borres sus datos. Descarga una copia antes de cambiar de dispositivo. Un gerente de esta sucursal puede conciliar ventas de sesiones o dispositivos anteriores."
          : "Pending sales live in this browser. Do not clear its data. Download a copy before replacing the device. A manager at this location can reconcile sales from previous sessions or devices."}
      </p>
      <p>
        {es
          ? "Si se borran los datos del navegador sin una copia, las ventas no sincronizadas no se pueden recuperar."
          : "If browser data is erased without a backup, unsynchronized sales cannot be recovered."}
      </p>
      <p role="status">
        {persistent === true
          ? es
            ? "Conservación local concedida; no sustituye una copia y los datos aún pueden borrarse manualmente."
            : "Local persistence granted; it does not replace a backup and data can still be cleared manually."
          : autoPersist === false
            ? t("offlinePersistDenied")
            : es
              ? "La conservación de datos locales no está garantizada. Descarga una copia."
              : "Local data retention is not guaranteed. Download a backup."}
      </p>
      {navigator.storage?.persist && persistent !== true && (
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setPersistent(await navigator.storage.persist()),
            )
          }
        >
          {es ? "Solicitar conservación local" : "Request local persistence"}
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        {t("offlineSyncCounts", {
          pending: counts.pending,
          conflict: counts.conflict,
          synced: counts.synced,
          archived: counts.archived,
        })}
      </p>
      <div className="row">
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await syncPending(session, { force: true, reason: "manual" });
            })
          }
        >
          {es ? "Reintentar sincronización" : "Retry sync"}
        </Button>
        <Button onClick={() => void run(download)} disabled={busy}>
          {es ? "Descargar pendientes" : "Download pending sales"}
        </Button>
      </div>
      {manager && (
        <Field
          label={
            es
              ? "Restaurar copia de pendientes"
              : "Restore pending sales backup"
          }
        >
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void run(() => restore(file, session));
              e.target.value = "";
            }}
          />
        </Field>
      )}
      {rows.map((row) => {
        const kind = recordKind(row.body);
        const cashLike = kind === "sale" || kind === "payment";
        const number = provisional(row);
        const mapped = serverNumber(row);
        return (
          <article className="panel" key={row.id}>
            <h3>
              {kindLabel(row)} · {number ?? row.id.slice(0, 8)} ·{" "}
              {format(amountOf(row), currencyOf(row))}
            </h3>
            <p className="tiny muted">{row.id.slice(0, 8)}</p>
            <p>
              <span className="offline-row-status">{statusLabel(row)}</span>
              {row.status === "synced" && number && mapped
                ? ` · ${t("offlineMapped", { provisional: number, number: mapped })}`
                : ""}
            </p>
            <p>
              {row.status === "synced"
                ? es
                  ? "Registrado en el servidor"
                  : "Recorded on server"
                : row.status === "archived"
                  ? t("offlineRowArchived")
                  : cashLike
                    ? es
                      ? "Efectivo registrado localmente; pendiente en el servidor"
                      : "Cash recorded locally; pending on server"
                    : es
                      ? "Guardado localmente; pendiente en el servidor"
                      : "Saved locally; pending on server"}
            </p>
            <p>
              {t("offlineRecordedAt", {
                time: new Date(row.body.recordedAt).toLocaleString(
                  es ? "es-MX" : "en-US",
                  { timeZone: session.restaurant.timezone },
                ),
              })}{" "}
              · {es ? "Intentos" : "Attempts"}: {row.attempts}
              {row.status === "pending" && row.nextAt > Date.now()
                ? ` · ${t("offlineNextAttempt", {
                    s: Math.ceil((row.nextAt - Date.now()) / 1000),
                  })}`
                : ""}
            </p>
            {row.error && <p>{translateError(row.error, locale)}</p>}
            {reconciled(row) && (
              <p>
                {es
                  ? "Conciliado. Revisa cocina e inventario manualmente."
                  : "Reconciled. Review kitchen and inventory manually."}
              </p>
            )}
            {manager && !isResolved(row) && (
              <div className="row">
                <Button
                  disabled={busy || !net.canUseServer}
                  onClick={() => void run(() => openReview(row))}
                >
                  {cashLike ? t("offlineReviewCash") : t("offlineReview")}
                </Button>
                <Button
                  disabled={busy || !net.canUseServer}
                  onClick={() => setArchiving(row)}
                >
                  {t("offlineArchive")}
                </Button>
              </div>
            )}
          </article>
        );
      })}
      {recoveries.items.map((recovery) => (
        <article className="panel" key={recovery.id}>
          <h3>
            {es ? "Conciliación" : "Recovery"} · {recovery.id.slice(0, 8)}
          </h3>
          <p>{recovery.reason}</p>
          <p>
            {new Date(recovery.original_sold_at).toLocaleString(
              es ? "es-MX" : "en-US",
            )}
          </p>
          {recovery.tasks.map((task: any) => (
            <div className="row between" key={task.id}>
              <span>
                {task.kind === "kitchen"
                  ? es
                    ? "Cocina"
                    : "Kitchen"
                  : es
                    ? "Inventario"
                    : "Inventory"}{" "}
                ·{" "}
                {task.state === "pending"
                  ? es
                    ? "pendiente"
                    : "pending"
                  : es
                    ? "revisado"
                    : "reviewed"}
              </span>
              {task.state === "pending" && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setTaskReview({ recovery, task });
                    setTaskReason("");
                    setTaskOutcome("already_completed");
                  }}
                >
                  {es ? "Registrar revisión" : "Record review"}
                </Button>
              )}
            </div>
          ))}
        </article>
      ))}
      {recoveries.nextCursor && (
        <Button
          disabled={busy}
          onClick={() => void run(() => more("recoveries"))}
        >
          {t("offlineLoadMore")}
        </Button>
      )}
      {archives.items.length > 0 && <h3>{t("offlineArchivedList")}</h3>}
      {archives.items.map((archive) => (
        <article className="panel" key={archive.id}>
          <h3>
            {t("offlineRowArchived")} · {archive.operationId.slice(0, 8)} ·{" "}
            {format(
              archive.amount,
              archive.currency ?? session.restaurant.currency,
            )}
          </h3>
          <p>{archive.reason}</p>
          <p className="muted">
            {t("offlineArchivedBy", { name: archive.actorName })} ·{" "}
            {new Date(archive.createdAt).toLocaleString(es ? "es-MX" : "en-US")}
          </p>
        </article>
      ))}
      {archives.nextCursor && (
        <Button
          disabled={busy}
          onClick={() => void run(() => more("archives"))}
        >
          {t("offlineLoadMore")}
        </Button>
      )}
      {attempts.map(({ key, attempt, parked }) => {
        const statusKey = evidenceKey(attempt);
        const status = attemptStatus[statusKey];
        return (
          <article className="panel" key={key}>
            <h3>
              {es ? "Pago por confirmar" : "Payment needs confirmation"} ·{" "}
              {attempt.payload.operationId.slice(0, 8)}
              {parked ? ` · ${t("offlineAttemptInReview")}` : ""}
            </h3>
            <p>
              {format(attempt.payload.amount)} · {attempt.payload.method}
            </p>
            <p>
              {status?.state === "committed"
                ? es
                  ? "El servidor ya registró este mismo pago."
                  : "The server already recorded this exact payment."
                : status?.state === "missing"
                  ? status.retryAllowed
                    ? es
                      ? "No se registró; puedes reenviar el mismo comando."
                      : "Not recorded; the same command can be retried."
                    : es
                      ? "No se encontró un resultado seguro. Requiere revisión; no cobres otra vez."
                      : "No safe result was found. Review is required; do not charge again."
                  : es
                    ? "Consulta primero el resultado canónico; no inicies otro cobro."
                    : "Check canonical status first; do not start another charge."}
            </p>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await api<{
                    state: string;
                    retryAllowed?: boolean;
                  }>("/payments/recovery/status", attempt);
                  setAttemptStatus((old) => ({ ...old, [statusKey]: result }));
                })
              }
            >
              {es ? "Consultar estado" : "Check status"}
            </Button>
            {status?.state === "committed" && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await clearPaymentAttempt(key, attempt);
                  })
                }
              >
                {es ? "Cerrar pago confirmado" : "Dismiss confirmed payment"}
              </Button>
            )}
            {status?.state === "missing" && status.retryAllowed && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api("/payments/recovery/retry", attempt, {
                      idempotent: true,
                    });
                    await clearPaymentAttempt(key, attempt);
                    setAttemptStatus((old) => ({
                      ...old,
                      [statusKey]: { state: "committed" },
                    }));
                  })
                }
              >
                {es ? "Reintentar el mismo pago" : "Retry same payment"}
              </Button>
            )}
          </article>
        );
      })}
      {!rows.length && !attempts.length && (
        <p>
          {es
            ? "No hay ventas pendientes guardadas para este acceso."
            : "No saved pending sales for this access."}
        </p>
      )}
      {archiving && (
        <ArchiveRecordForm
          row={archiving}
          session={session}
          locale={locale}
          done={() => {
            setArchiving(null);
            setReview(null);
            if (net.canUseServer) void loadServer().catch(() => {});
          }}
        />
      )}
      {review && (
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
                    "green-monkey-sync:" + review.row.scope,
                    async () => {
                      const order = await api(
                        "/offline/reconcile",
                        { record: review.row.body, reason, confirmed },
                        { idempotent: true },
                      );
                      // OFF-R18: store the tender the reconcile made, so
                      // offline balances never count this payment twice.
                      await db.pending.update(review.row.id, {
                        status: "synced",
                        result: reconciledResult(review.row.id, order),
                        syncedAt: Date.now(),
                        error: undefined,
                        waitReason: undefined,
                      });
                    },
                  ),
              );
              setReview(null);
            });
          }}
        >
          <h3>
            {es
              ? "Conciliar efectivo ya recibido"
              : "Reconcile cash already received"}
          </h3>
          <dl className="offline-evidence">
            <dt>{es ? "Registro" : "Record"}</dt>
            <dd>
              {kindLabel(review.row)}
              {review.detail.provisionalNumber
                ? ` · ${review.detail.provisionalNumber}`
                : ""}
            </dd>
            <dt>{es ? "Verificación" : "Verification"}</dt>
            <dd>
              {review.detail.authentic
                ? es
                  ? "Evidencia verificada"
                  : "Evidence verified"
                : translateError("offline_evidence_invalid", locale)}
            </dd>
            {review.detail.problems.length > 0 && (
              <>
                <dt>{es ? "Motivo" : "Reason"}</dt>
                <dd>
                  {review.detail.problems
                    .map((code) => translateError(code, locale))
                    .join(" ")}
                </dd>
              </>
            )}
            <dt>{es ? "Empleado" : "Employee"}</dt>
            <dd>{review.detail.originalEmployee ?? "—"}</dd>
            <dt>{es ? "Cobrado" : "Collected"}</dt>
            <dd>
              {format(review.detail.collected)} + {format(review.detail.tip)}{" "}
              {es ? "propina" : "tip"}
              {review.detail.method ? ` · ${review.detail.method}` : ""}
              {review.detail.reference ? ` · ${review.detail.reference}` : ""}
            </dd>
            <dt>{es ? "Precio actual" : "Current price"}</dt>
            <dd>
              {review.detail.currentTotal === null
                ? es
                  ? "No disponible"
                  : "Unavailable"
                : format(review.detail.currentTotal)}
            </dd>
            <dt>{es ? "Hora de venta" : "Sale time"}</dt>
            <dd>
              {new Date(
                review.detail.soldAt ?? review.detail.recordedAt,
              ).toLocaleString(es ? "es-MX" : "en-US", {
                timeZone: session.restaurant.timezone,
              })}
            </dd>
            <dt>{es ? "Caja original" : "Original drawer"}</dt>
            <dd>
              {review.detail.originalDrawerId?.slice(0, 8) ?? "—"} ·{" "}
              {review.detail.drawerClosed
                ? es
                  ? "cerrada; se mostrará un ajuste posterior"
                  : "closed; a late adjustment will be shown"
                : es
                  ? "abierta"
                  : "open"}
            </dd>
            {review.detail.target && (
              <>
                <dt>{es ? "Orden" : "Order"}</dt>
                <dd>
                  #{review.detail.target.number} ·{" "}
                  {format(review.detail.target.due)}
                </dd>
              </>
            )}
          </dl>
          {waitingForOriginal(review.row) && (
            <p className="warning-panel" role="status">
              {translateError("offline_dependency_pending", locale)}
            </p>
          )}
          {/* OFF-R27: a sale or order whose create already committed online
              names that order; money that does not fit it is never
              reconciled beside it. */}
          {!review.detail.reconcilable &&
            review.detail.target &&
            (review.detail.kind === "sale" ||
              review.detail.kind === "order") && (
              <p className="warning-panel" role="status">
                {review.detail.kind === "order"
                  ? t("offlineExistingOrderSent", {
                      n: review.detail.target.number,
                    })
                  : review.detail.target.due > 0
                    ? t("offlineExistingOrderCharge", {
                        n: review.detail.target.number,
                        due: format(review.detail.target.due),
                      })
                    : t("offlineExistingOrderPaid", {
                        n: review.detail.target.number,
                      })}
              </p>
            )}
          {review.detail.reconcilable && !waitingForOriginal(review.row) && (
            <>
              <p>
                {review.detail.target
                  ? t("offlineReconcileIntoOrder", {
                      n: review.detail.target.number,
                    })
                  : es
                    ? "Conservaremos el importe original en la caja original. No se cobra al cliente otra vez. No se reconstruyen precios por producto ni se envía a cocina o descuenta inventario; revisa esas tareas por separado."
                    : "We will preserve the original amount in the original drawer. The customer is not charged again. Item prices are not reconstructed, kitchen tickets are not sent and inventory is not deducted; review those tasks separately."}
              </p>
              <Field
                label={es ? "Motivo de conciliación" : "Reconciliation reason"}
              >
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
                {review.detail.target
                  ? t("offlineReconcileIntoOrderConfirm", {
                      n: review.detail.target.number,
                    })
                  : es
                    ? "Verifiqué el efectivo original y revisaré cocina e inventario."
                    : "I verified the original cash and will review kitchen and inventory."}
              </label>
              <Button
                type="submit"
                disabled={busy || !confirmed || reason.trim().length < 10}
              >
                {es ? "Registrar efectivo verificado" : "Record verified cash"}
              </Button>
            </>
          )}
          <Button onClick={() => setArchiving(review.row)}>
            {t("offlineArchive")}
          </Button>
          <Button onClick={() => setReview(null)}>
            {es ? "Cancelar" : "Cancel"}
          </Button>
        </form>
      )}
      {taskReview && (
        <form
          className="panel"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api("/sync/recoveries/resolve", {
                operationId: crypto.randomUUID(),
                taskId: taskReview.task.id,
                outcome: taskOutcome,
                reason: taskReason,
              });
              setTaskReview(null);
            });
          }}
        >
          <h3>
            {taskReview.task.kind === "kitchen"
              ? es
                ? "Revisar cocina"
                : "Review kitchen"
              : es
                ? "Revisar inventario"
                : "Review inventory"}
          </h3>
          <Field label={es ? "Resultado verificado" : "Verified outcome"}>
            <select
              value={taskOutcome}
              onChange={(event) =>
                setTaskOutcome(
                  event.target.value as "already_completed" | "not_completed",
                )
              }
            >
              <option value="already_completed">
                {es ? "Ya ocurrió" : "Already occurred"}
              </option>
              <option value="not_completed">
                {es ? "No ocurrió" : "Did not occur"}
              </option>
            </select>
          </Field>
          <Field label={es ? "Evidencia y motivo" : "Evidence and reason"}>
            <textarea
              required
              minLength={10}
              maxLength={500}
              value={taskReason}
              onChange={(event) => setTaskReason(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            disabled={busy || taskReason.trim().length < 10}
          >
            {es ? "Guardar revisión" : "Save review"}
          </Button>
          <Button onClick={() => setTaskReview(null)}>
            {es ? "Cancelar" : "Cancel"}
          </Button>
        </form>
      )}
    </section>
  );
}

/**
 * Restores a v1/v2/v3 backup atomically: every record and attempt must belong
 * to this tenant and match its scope, and existing evidence must be identical.
 */
async function restore(file: File, session: Session) {
  if (file.size > 20_000_000) throw Error("invalid_backup");
  let parsed;
  try {
    parsed = recoveryBackup.parse(JSON.parse(await file.text()));
  } catch {
    throw Error("invalid_backup");
  }
  const records = "records" in parsed ? parsed.records : parsed.sales;
  const attempts: { key: string; attempt: PaymentAttempt }[] =
    parsed.format === "green-monkey-recovery-v3"
      ? parsed.paymentAttempts
      : parsed.format === "green-monkey-recovery-v2"
        ? parsed.paymentAttempts.map((attempt) => ({
            key: `${attempt.tenantId}:${attempt.deviceId}:${attempt.employeeId}:payment`,
            attempt,
          }))
        : [];
  if (
    parsed.tenantId !== session.tenantId ||
    records.some(
      (r) =>
        !r.scope.startsWith(session.tenantId + ":") ||
        r.id !== r.body.operationId ||
        ("formatVersion" in r.body &&
          (r.body.tenantId !== session.tenantId ||
            r.scope !==
              `${r.body.tenantId}:${r.body.deviceId}:${r.body.employeeId}`)),
    ) ||
    attempts.some(
      ({ key, attempt }) =>
        attempt.tenantId !== session.tenantId ||
        !isAttemptKey(key) ||
        !key.startsWith(
          `${attempt.tenantId}:${attempt.deviceId}:${attempt.employeeId}:payment`,
        ),
    )
  )
    throw Error("invalid_backup");
  await db.transaction("rw", db.pending, db.cache, async () => {
    for (const row of records) {
      const old = await db.pending.get(row.id);
      if (old && evidenceKey(old.body) !== evidenceKey(row.body))
        throw Error("operation_conflict");
      if (!old)
        await db.pending.put({
          ...row,
          kind: recordKind(row.body),
          receipt: row.receipt as Pending["receipt"],
          status: "conflict",
          attempts: 0,
          nextAt: 0,
          error: "offline_conflict",
        });
    }
    for (const { key, attempt } of attempts) {
      const old = await db.cache.get(key);
      if (
        old &&
        evidenceKey(normalizePaymentAttempt(old.value, key)) !==
          evidenceKey(attempt)
      )
        throw Error("operation_conflict");
      if (!old) await db.cache.put({ id: key, value: attempt });
    }
  });
}
