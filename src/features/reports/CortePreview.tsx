import { useCallback, useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import type {
  CorteDocument,
  DayCorteDocument as DayCorte,
} from "../../../shared/reports";
import { strings, translateError } from "../../i18n";
import { printDocument, usePrintSettings } from "../../print";
import { Button, Modal } from "../../components/ui";
import {
  fetchDayCorte,
  fetchDrawerCorte,
  printDayCorte,
  printDrawerCorte,
} from "./api";
import { DayCorteDocument, DrawerCorteDocument } from "./documents";
import { printSheet } from "./ReportSheet";
import { dateLabel, fill } from "./format";

export type CorteTarget =
  { kind: "drawer"; drawerId: string } | { kind: "day"; date: string };

/**
 * "Vista previa" of a corte X/Z or a corte del día: the server's preview, a paper selector bound
 * to this device's print settings, and Imprimir, which first records the print (POST, which
 * returns the authoritative document with its print number) and then prints that document. If
 * the POST fails nothing prints. One operation id per print, kept across retries (including the
 * step-up retry) and replaced only after a success (MON-3).
 */
export function CortePreview({
  session,
  locale,
  target,
  close,
  online = true,
}: {
  session: Session;
  locale: Locale;
  target: CorteTarget;
  close: () => void;
  online?: boolean;
}) {
  const t = strings[locale];
  const [settings, saveSettings] = usePrintSettings();
  const [doc, setDoc] = useState<CorteDocument | DayCorte | null>(null);
  const [error, setError] = useState<{
    code: string;
    text: string;
    /** The step that failed: Reintentar repeats it (UI-15), a print with its operation id. */
    step: "load" | "print";
    sheet?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  // Callers pass a fresh target object on every render; the fetch follows its identity.
  const targetKey =
    target.kind === "drawer"
      ? "drawer:" + target.drawerId
      : "day:" + target.date;
  const load = useCallback(async () => {
    setError(null);
    try {
      setDoc(
        target.kind === "drawer"
          ? await fetchDrawerCorte(target.drawerId)
          : await fetchDayCorte(target.date),
      );
    } catch (e) {
      const code = (e as Error).message;
      setError({ code, text: translateError(code, locale), step: "load" });
    }
  }, [targetKey, locale]);
  useEffect(() => {
    if (online) void load();
  }, [load, online]);

  async function record(): Promise<CorteDocument | DayCorte> {
    const printed =
      target.kind === "drawer"
        ? await printDrawerCorte(target.drawerId, {
            operationId,
            kind: (doc as CorteDocument).kind,
          })
        : await printDayCorte(target.date, { operationId });
    setOperationId(crypto.randomUUID());
    setDoc(printed);
    return printed;
  }
  async function print(sheet: boolean) {
    if (!doc) return;
    setBusy(true);
    setError(null);
    try {
      const printed = await record();
      const node =
        target.kind === "drawer" ? (
          <DrawerCorteDocument doc={printed as CorteDocument} locale={locale} />
        ) : (
          <DayCorteDocument doc={printed as DayCorte} locale={locale} />
        );
      if (sheet && target.kind === "day")
        await printSheet(
          fill(t.reportsDocDay, { date: dateLabel(target.date, locale) }),
          session.restaurant.name,
          node,
        );
      else await printDocument(node, settings.paper);
    } catch (e) {
      const code = (e as Error).message;
      setError({
        code,
        text: translateError(code, locale),
        step: "print",
        sheet,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t.reportsPreview}
      close={close}
      closeLabel={t.close}
      wide
      footer={
        <div className="row wrap report-preview-actions">
          {target.kind === "day" && (
            <Button
              disabled={busy || !doc || !online}
              onClick={() => void print(true)}
            >
              {t.reportsPrintSheet}
            </Button>
          )}
          <Button
            variant="primary"
            disabled={busy || !doc || !online}
            onClick={() => void print(false)}
          >
            {busy ? t.reportsPrinting : t.reportsPrint}
          </Button>
        </div>
      }
    >
      {!online && <p role="status">{t.reportsOffline}</p>}
      {error && (
        <div className="error" role="alert">
          <span>{error.text}</span>
          {error.code === "reports_timeout" && (
            <Button
              variant="ghost"
              disabled={busy || !online}
              onClick={() =>
                void (error.step === "print"
                  ? print(error.sheet ?? false)
                  : load())
              }
            >
              {t.reportsRetry}
            </Button>
          )}
        </div>
      )}
      <fieldset className="field report-paper">
        <legend>{t.reportsPaper}</legend>
        {(["80", "58"] as const).map((paper) => (
          <label className="option" key={paper}>
            <input
              type="radio"
              name="report-paper"
              checked={settings.paper === paper}
              onChange={() => saveSettings({ paper })}
            />
            <span>{paper === "80" ? t.reportsPaper80 : t.reportsPaper58}</span>
          </label>
        ))}
      </fieldset>
      <div
        className={"report-preview paper-" + settings.paper}
        aria-busy={!doc && !error}
      >
        {!doc && !error && <p>{t.reportsLoading}</p>}
        {doc && target.kind === "drawer" && (
          <DrawerCorteDocument doc={doc as CorteDocument} locale={locale} />
        )}
        {doc && target.kind === "day" && (
          <DayCorteDocument doc={doc as DayCorte} locale={locale} />
        )}
      </div>
    </Modal>
  );
}
