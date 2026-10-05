import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, Field, Modal } from "../components/ui";
import { strings, translateError, type Key } from "../i18n";
import type { Locale, Order } from "../../shared/domain";
export function ServiceAssignment({
  order,
  locale,
  close,
  saved,
}: {
  order: Order;
  locale: Locale;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const t = (key: Key) => strings[locale][key];
  const [options, setOptions] = useState<{
    tables: { id: string; name: string }[];
    employees: { id: string; name: string }[];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(order.mode);
  // One id per dialog: a retried submit after a lost response replays safely.
  const [operationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    void api("/service/options")
      .then(setOptions)
      .catch((e) => setError(translateError(e.message, locale)));
  }, []);
  return (
    <Modal title={t("assignService")} close={close} closeLabel={t("close")}>
      <p>
        #{order.number} · {order.name}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!options ? (
        <p>{t("loading")}</p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const f = new FormData(e.currentTarget);
            try {
              await api(`/orders/${order.id}/service`, {
                operationId,
                expectedVersion: order.serviceVersion ?? 0,
                tableId: mode === "dine_in" ? f.get("tableId") || null : null,
                employeeId: f.get("employeeId"),
                mode,
                reason: f.get("reason"),
              });
              await saved();
              close();
            } catch (e) {
              setError(translateError((e as Error).message, locale));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={t("serviceMode")}>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              {["dine_in", "takeaway", "delivery"].map((mode) => (
                <option key={mode} value={mode}>
                  {t(mode as Key)}
                </option>
              ))}
            </select>
          </Field>
          {mode === "dine_in" && (
            <Field label={t("selectTable")}>
              <select name="tableId" defaultValue={order.tableId ?? ""}>
                <option value="">{t("noTable")}</option>
                {options.tables.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={t("waiter")}>
            <select
              name="employeeId"
              required
              defaultValue={order.assignedEmployeeId}
            >
              {options.employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("reason")}>
            <input name="reason" required minLength={3} maxLength={300} />
          </Field>
          <p className="muted">{t("serviceAssignmentHint")}</p>
          <Button variant="primary" type="submit" disabled={busy}>
            {t("save")}
          </Button>
        </form>
      )}
    </Modal>
  );
}
