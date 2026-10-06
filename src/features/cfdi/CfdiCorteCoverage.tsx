/**
 * The CFDI coverage of a day's corte (spec §6.1): pure render of `CfdiCoverage` for reports'
 * DayCorteDocument (`doc.extra.cfdi`), in the corte's own print layout (DocSection lines).
 * Tickets invoiced to customers, tickets in a global invoice and tickets not covered yet;
 * test-mode documents never count as coverage in live mode.
 */
import type { Locale } from "../../../shared/domain";
import type { CfdiCoverage } from "../../../shared/cfdi";
import { DocSection } from "../printing/layout";
import { moneyLabel, t } from "./format";

/** `doc.extra.cfdi` when cfdi's dayCorte hook filled it (null/absent while CFDI is off). */
export function corteCoverageOf(
  extra: Record<string, unknown> | undefined,
): CfdiCoverage | null {
  const c = extra?.cfdi as CfdiCoverage | null | undefined;
  return c && typeof c.tickets === "number" ? c : null;
}

export function CfdiCorteCoverage({
  coverage,
  locale,
}: {
  coverage: CfdiCoverage;
  locale: Locale;
}) {
  const test =
    coverage.mode === "test" ? ` ${t(locale, "cfdiReceiptTestMode")}` : "";
  return (
    <DocSection title={t(locale, "cfdiCorteTitle") + test}>
      <p className="doc-meta">
        {t(locale, "cfdiCorteInvoiced", {
          n: coverage.invoiced,
          total: moneyLabel(coverage.invoicedTotal, locale),
        })}
      </p>
      <p className="doc-meta">
        {t(locale, "cfdiCorteGlobal", {
          n: coverage.globalized,
          total: moneyLabel(coverage.globalTotal, locale),
        })}
      </p>
      <p className="doc-meta">
        {t(locale, "cfdiCorteUncovered", { n: coverage.uncovered })}
      </p>
    </DocSection>
  );
}
