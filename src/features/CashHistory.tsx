import { useEffect, useState } from "react";
import type { Locale } from "../../shared/domain";
import { currencyExponent } from "../../shared/domain";
import { api } from "../api";
import { translateError } from "../i18n";
import { Button } from "../components/ui";

export function CashHistory({ locale }: { locale: Locale }) {
  const es = locale === "es";
  const [rows, setRows] = useState<any[]>([]),
    [offset, setOffset] = useState(0),
    [detail, setDetail] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void api(`/cash/history?offset=${offset}`)
      .then((data) => {
        if (live) setRows(data);
      })
      .catch((e: Error) => {
        if (live) setError(translateError(e.message, locale));
      });
    return () => {
      live = false;
    };
  }, [offset, locale]);
  const format = (value: number, row: any) =>
    row.currencies?.length === 1 && row.currencies[0]
      ? new Intl.NumberFormat(es ? "es-MX" : "en-US", {
          style: "currency",
          currency: row.currencies[0],
        }).format(value / 10 ** currencyExponent(row.currencies[0]))
      : `${value} ${es ? "unidades menores; moneda sin evidencia" : "minor units; currency evidence unavailable"}`;
  return (
    <details className="panel">
      <summary>{es ? "Historial de cajas" : "Drawer history"}</summary>
      {error && <p role="alert">{error}</p>}
      {rows.map((row) => (
        <article className="panel" key={row.id}>
          <h3>
            {row.device_name} · {new Date(row.closed_at).toLocaleString(locale)}
          </h3>
          <p>
            {es ? "Esperado al cerrar" : "Expected at close"}:{" "}
            {format(row.expected, row)}
          </p>
          <p>
            {es ? "Conteo original" : "Original count"}:{" "}
            {format(row.counted, row)}
          </p>
          <p>
            {es ? "Diferencia original" : "Original discrepancy"}:{" "}
            {format(row.counted - row.expected, row)}
          </p>
          <p>
            {es ? "Recuperaciones posteriores" : "Late recoveries"}:{" "}
            {format(row.late_recovery, row)}
          </p>
          <p>
            {es ? "Esperado ajustado" : "Adjusted expected"}:{" "}
            {format(row.expected + row.late_recovery, row)}
          </p>
          {row.reason && <p>{row.reason}</p>}
          <Button
            onClick={() =>
              void api(`/cash/history/${row.id}`)
                .then(setDetail)
                .catch((e: Error) =>
                  setError(translateError(e.message, locale)),
                )
            }
          >
            {es ? "Ver movimientos" : "View movements"}
          </Button>
          {detail?.id === row.id && (
            <ul>
              {detail.tenders.map((t: any) => (
                <li key={t.id}>
                  {t.source === "offline_recovery"
                    ? es
                      ? "Efectivo recuperado"
                      : "Recovered cash"
                    : t.method}{" "}
                  · {format(t.amount + t.tip, row)} · {t.source_id ?? t.id}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
      <div className="row">
        <Button
          disabled={offset === 0}
          onClick={() => setOffset((n) => Math.max(0, n - 50))}
        >
          {es ? "Anterior" : "Previous"}
        </Button>
        <Button
          disabled={rows.length < 50}
          onClick={() => setOffset((n) => n + 50)}
        >
          {es ? "Siguiente" : "Next"}
        </Button>
      </div>
    </details>
  );
}
