import { useEffect, useState } from "react";
import {
  currencyExponent,
  type Locale,
  type Session,
} from "../../shared/domain";
import {
  normalizePaymentAttempt,
  recoveryBackup,
  evidenceKey,
  type PaymentAttempt,
} from "../../shared/offline-recovery";
import {
  clearPaymentAttempt,
  db,
  scope,
  syncPending,
  type Pending,
} from "../offline";
import { api } from "../api";
import { Button, Field } from "../components/ui";
import { translateError } from "../i18n";
export function RecoveryQueue({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const es = locale === "es",
    manager = ["owner", "manager"].includes(session.role);
  const [rows, setRows] = useState<Pending[]>([]),
    [attempts, setAttempts] = useState<
      { key: string; attempt: PaymentAttempt }[]
    >([]),
    [attemptStatus, setAttemptStatus] = useState<
      Record<string, { state: string; retryAllowed?: boolean }>
    >({}),
    [recoveries, setRecoveries] = useState<any[]>([]),
    [taskReview, setTaskReview] = useState<any | null>(null),
    [taskOutcome, setTaskOutcome] = useState<
      "already_completed" | "not_completed"
    >("already_completed"),
    [taskReason, setTaskReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<{ row: Pending; detail: any } | null>(null),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const format = (minor: number, currency = session.restaurant.currency) =>
    new Intl.NumberFormat(es ? "es-MX" : "en-US", {
      style: "currency",
      currency,
    }).format(minor / 10 ** currencyExponent(currency));
  async function load() {
    setRows(
      await db.pending
        .filter((p) =>
          manager
            ? p.scope.startsWith(session.tenantId + ":")
            : p.scope === scope(session),
        )
        .toArray(),
    );
    const cached = await db.cache
      .filter((row) => row.id.endsWith(":payment"))
      .toArray();
    setAttempts(
      cached
        .map((row) => ({
          key: row.id,
          attempt: normalizePaymentAttempt(row.value, row.id),
        }))
        .filter(
          (row): row is { key: string; attempt: PaymentAttempt } =>
            row.attempt !== null &&
            row.attempt.tenantId === session.tenantId &&
            (manager ||
              (row.attempt.employeeId === session.employeeId &&
                row.attempt.deviceId === session.deviceId)),
        ),
    );
    if (manager) setRecoveries(await api("/sync/recoveries"));
  }
  useEffect(() => {
    const refresh = () =>
      void load().catch((e: Error) =>
        setError(translateError(e.message, locale)),
      );
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [session.id]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    const paymentAttempts = (
      await db.cache.filter((row) => row.id.endsWith(":payment")).toArray()
    )
      .map((row) => normalizePaymentAttempt(row.value, row.id))
      .filter((attempt) => attempt !== null)
      .filter(
        (attempt) =>
          attempt.tenantId === session.tenantId &&
          (manager ||
            (attempt.employeeId === session.employeeId &&
              attempt.deviceId === session.deviceId)),
      );
    const payload = {
      format: "green-monkey-recovery-v2",
      tenantId: session.tenantId,
      exportedAt: new Date().toISOString(),
      sales: rows
        .filter((r) => r.status !== "synced")
        .map(({ id, scope, body, receipt }) => ({ id, scope, body, receipt })),
      paymentAttempts,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "green-monkey-offline-" + session.tenantId + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section>
      <p className="warning-panel">
        {es
          ? "Las ventas pendientes viven en este navegador. No borres sus datos. Descarga una copia antes de cambiar de dispositivo. Un gerente de esta sucursal puede conciliar ventas de sesiones o dispositivos anteriores."
          : "Pending sales live in this browser. Do not clear its data. Download a copy before replacing the device. A manager at this location can reconcile sales from previous sessions or devices."}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="row">
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await syncPending(session, true);
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
              void run(async () => {
                if (file.size > 20_000_000) throw Error("invalid_backup");
                let parsed;
                try {
                  parsed = recoveryBackup.parse(JSON.parse(await file.text()));
                } catch {
                  throw Error("invalid_backup");
                }
                if (
                  parsed.tenantId !== session.tenantId ||
                  parsed.sales.some(
                    (r) =>
                      !r.scope.startsWith(session.tenantId + ":") ||
                      r.id !== r.body.operationId ||
                      ("formatVersion" in r.body &&
                        (r.body.tenantId !== session.tenantId ||
                          r.scope !==
                            `${r.body.tenantId}:${r.body.deviceId}:${r.body.employeeId}`)),
                  )
                )
                  throw Error("invalid_backup");
                const paymentAttempts =
                  "paymentAttempts" in parsed ? parsed.paymentAttempts : [];
                if (
                  paymentAttempts.some(
                    (attempt) => attempt.tenantId !== session.tenantId,
                  )
                )
                  throw Error("invalid_backup");
                await db.transaction("rw", db.pending, db.cache, async () => {
                  for (const row of parsed.sales) {
                    const old = await db.pending.get(row.id);
                    if (old && evidenceKey(old.body) !== evidenceKey(row.body))
                      throw Error("operation_conflict");
                    if (!old)
                      await db.pending.put({
                        ...row,
                        receipt: row.receipt as Pending["receipt"],
                        status: "conflict",
                        attempts: 0,
                        nextAt: 0,
                        error: "offline_conflict",
                      });
                  }
                  for (const attempt of paymentAttempts) {
                    const key = `${attempt.tenantId}:${attempt.deviceId}:${attempt.employeeId}:payment`;
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
              });
              e.target.value = "";
            }}
          />
        </Field>
      )}
      {rows.map((row) => (
        <article className="panel" key={row.id}>
          <h3>
            {row.id.slice(0, 8)} ·{" "}
            {format(
              row.body.expectedTotal,
              "currency" in row.body
                ? row.body.currency
                : row.receipt?.restaurant.currency,
            )}
          </h3>
          <p>
            {row.status === "synced"
              ? es
                ? "Registrado en el servidor"
                : "Recorded on server"
              : es
                ? "Efectivo registrado localmente; pendiente en el servidor"
                : "Cash recorded locally; pending on server"}
          </p>
          <p>
            {new Date(row.body.recordedAt).toLocaleString(
              es ? "es-MX" : "en-US",
            )}{" "}
            · {es ? "Intentos" : "Attempts"}: {row.attempts}
          </p>
          {row.error && <p>{translateError(row.error, locale)}</p>}
          {row.result?.recovery && (
            <p>
              {es
                ? "Conciliado. Revisa cocina e inventario manualmente."
                : "Reconciled. Review kitchen and inventory manually."}
            </p>
          )}
          {manager && row.status !== "synced" && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const detail = await api("/sync/review", row.body);
                  setReview({ row, detail });
                  setReason("");
                  setConfirmed(false);
                })
              }
            >
              {es ? "Revisar efectivo" : "Review cash"}
            </Button>
          )}
        </article>
      ))}
      {recoveries.map((recovery) => (
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
      {attempts.map(({ key, attempt }) => {
        const statusKey = evidenceKey(attempt);
        const status = attemptStatus[statusKey];
        return (
          <article className="panel" key={key}>
            <h3>
              {es ? "Pago por confirmar" : "Payment needs confirmation"} ·{" "}
              {attempt.payload.operationId.slice(0, 8)}
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
                    await api("/payments/recovery/retry", attempt);
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
                      const result = await api("/sync/reconcile", {
                        sale: review.row.body,
                        reason,
                        confirmed,
                      });
                      await db.pending.update(review.row.id, {
                        status: "synced",
                        result,
                        error: undefined,
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
          <p>
            {review.detail.originalEmployee} · {format(review.detail.collected)}{" "}
            + {format(review.detail.tip)} {es ? "propina" : "tip"}
          </p>
          <p>
            {es ? "Precio actual" : "Current price"}:{" "}
            {review.detail.currentTotal === null
              ? es
                ? "No disponible"
                : "Unavailable"
              : format(review.detail.currentTotal)}
          </p>
          <p>
            {es ? "Caja original" : "Original drawer"}:{" "}
            {review.detail.originalDrawerId.slice(0, 8)} ·{" "}
            {review.detail.drawerClosed
              ? es
                ? "cerrada; se mostrará un ajuste posterior"
                : "closed; a late adjustment will be shown"
              : es
                ? "abierta"
                : "open"}
          </p>
          <p>
            {es
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
            {es
              ? "Verifiqué el efectivo original y revisaré cocina e inventario."
              : "I verified the original cash and will review kitchen and inventory."}
          </label>
          <Button
            type="submit"
            disabled={busy || !confirmed || reason.trim().length < 10}
          >
            {es ? "Registrar efectivo verificado" : "Record verified cash"}
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
