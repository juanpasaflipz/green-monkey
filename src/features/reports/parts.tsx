import type { ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  Printer,
  RefreshCw,
} from "lucide-react";
import type { Locale } from "../../../shared/domain";
import type { ReconciliationCheck } from "../../../shared/reports";
import { strings } from "../../i18n";
import { Button } from "../../components/ui";
import { fill } from "./format";
import type { ReportState } from "./useReport";

/** A report's loading, offline and error states; `reports_timeout` offers Reintentar. */
export function ReportStatus({
  state,
  online,
  locale,
}: {
  state: Pick<ReportState<unknown>, "loading" | "error" | "reload">;
  online: boolean;
  locale: Locale;
}) {
  const t = strings[locale];
  if (!online)
    return (
      <p className="report-offline" role="status">
        {t.reportsOffline}
      </p>
    );
  return (
    <>
      {state.loading && <p className="muted">{t.reportsLoading}</p>}
      {state.error && (
        <div className="error report-error" role="alert">
          <span>{state.error.text}</span>
          {state.error.code === "reports_timeout" && (
            <Button variant="ghost" onClick={state.reload}>
              {t.reportsRetry}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

/** Actualizar, Descargar CSV and (optionally) Imprimir o guardar PDF for one tab. */
export function ReportToolbar({
  locale,
  online,
  busy,
  csvBusy = false,
  onRefresh,
  onCsv,
  onPrint,
  children,
}: {
  locale: Locale;
  online: boolean;
  busy: boolean;
  csvBusy?: boolean;
  onRefresh: () => void;
  onCsv?: () => void;
  onPrint?: () => void;
  children?: ReactNode;
}) {
  const t = strings[locale];
  return (
    <div className="row wrap report-toolbar">
      {children}
      <Button onClick={onRefresh} disabled={!online || busy}>
        <RefreshCw size={16} aria-hidden="true" />
        {t.reportsRefresh}
      </Button>
      {onCsv && (
        <Button onClick={onCsv} disabled={!online || busy || csvBusy}>
          <Download size={16} aria-hidden="true" />
          {csvBusy ? t.reportsPreparingCsv : t.reportsDownloadCsv}
        </Button>
      )}
      {onPrint && (
        <Button onClick={onPrint} disabled={!online || busy}>
          <Printer size={16} aria-hidden="true" />
          {t.reportsPrintSheet}
        </Button>
      )}
    </div>
  );
}

/** "Todos los totales cuadran." or the failing codes with the support request id. */
export function ChecksBadge({
  checks,
  requestId,
  locale,
}: {
  checks: readonly ReconciliationCheck[];
  requestId: string;
  locale: Locale;
}) {
  const t = strings[locale];
  const failed = checks.filter((c) => !c.ok).map((c) => c.code);
  return failed.length === 0 ? (
    <p className="report-check ok" role="status">
      <Check size={18} aria-hidden="true" />
      {t.reportsChecksOk}
    </p>
  ) : (
    <p className="report-check failed" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      {fill(t.reportsChecksFailed, { codes: failed.join(", "), id: requestId })}
    </p>
  );
}

/** A stat tile: label above one number; no chart and no color coding. */
export function Tiles({
  items,
}: {
  items: { label: string; value: string; note?: string }[];
}) {
  return (
    <dl className="report-tiles">
      {items.map((item) => (
        <div className="report-tile" key={item.label}>
          <dt>{item.label}</dt>
          <dd>
            {item.value}
            {item.note && <small>{item.note}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
