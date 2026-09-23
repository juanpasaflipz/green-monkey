import { useEffect, useState } from "react";
import type { Locale } from "../../shared/domain";
import { api } from "../api";
import { Button, Field } from "../components/ui";
import { translateError } from "../i18n";
type Selection = {
  currentDeviceId: string;
  devices: { id: string; name: string; free_slot: number | null }[];
  employees: {
    id: string;
    name: string;
    role: string;
    free_slot: number | null;
  }[];
};
export function FreeSelection({ locale }: { locale: Locale }) {
  const es = locale === "es";
  const [data, setData] = useState<Selection | null>(null),
    [device, setDevice] = useState(""),
    [employees, setEmployees] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  function apply(s: Selection) {
    setData(s);
    setDevice(s.devices.find((d) => d.free_slot)?.id ?? s.currentDeviceId);
    setEmployees(s.employees.filter((e) => e.free_slot).map((e) => e.id));
  }
  useEffect(() => {
    void api<Selection>("/plan/selection")
      .then(apply)
      .catch((e) => setError(translateError(e.message, locale)));
  }, []);
  return (
    <section className="panel">
      <h3>{es ? "Registro y equipo Free" : "Free register and team"}</h3>
      <p>
        {es
          ? "Free incluye una sucursal, un dispositivo de venta y el propietario más dos empleados. Elige la sucursal en tu cuenta. Estas selecciones se aplican al terminar Pro; conservamos los registros, cobros, reembolsos y ventas pendientes de sincronizar."
          : "Free includes one location, one selling device and the owner plus two employees. Choose the location in your account. These selections apply when Pro ends; records, payments, refunds and queued sales are preserved."}
      </p>
      <p>
        {es
          ? "Otros dispositivos permiten consultar y terminar trabajo pendiente. Las autorizaciones sin conexión ya emitidas duran hasta cuatro horas."
          : "Other devices can view records and finish outstanding work. Offline authorizations already issued last up to four hours."}
      </p>
      {error && <p role="alert">{error}</p>}
      {saved && (
        <p role="status">{es ? "Selección guardada." : "Selection saved."}</p>
      )}
      {data && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setSaved(false);
            try {
              apply(
                await api("/plan/selection", {
                  deviceId: device,
                  employeeIds: employees,
                }),
              );
              setSaved(true);
              window.dispatchEvent(new Event("gm-session-refresh"));
            } catch (e) {
              setError(translateError((e as Error).message, locale));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={es ? "Dispositivo de venta" : "Selling device"}>
            <select
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              disabled={busy}
            >
              {data.devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.id.slice(0, 8)}
                  {d.id === data.currentDeviceId
                    ? es
                      ? " (este dispositivo)"
                      : " (this device)"
                    : ""}
                </option>
              ))}
            </select>
          </Field>
          <fieldset disabled={busy}>
            <legend>
              {es ? "Hasta dos empleados" : "Up to two employees"}
            </legend>
            {data.employees.map((e) => (
              <label className="row" key={e.id}>
                <input
                  type="checkbox"
                  checked={employees.includes(e.id)}
                  disabled={!employees.includes(e.id) && employees.length >= 2}
                  onChange={(event) =>
                    setEmployees(
                      event.target.checked
                        ? [...employees, e.id]
                        : employees.filter((id) => id !== e.id),
                    )
                  }
                />
                {e.name}
              </label>
            ))}
          </fieldset>
          <Button type="submit" disabled={busy}>
            {es ? "Guardar selección Free" : "Save Free selection"}
          </Button>
        </form>
      )}
    </section>
  );
}
