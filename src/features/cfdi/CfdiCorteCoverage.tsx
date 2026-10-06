/**
 * The CFDI coverage of a day's corte (spec §6.1): pure render of `CfdiCoverage` for reports'
 * DayCorteDocument (`doc.extra.cfdi`). Tickets invoiced to customers, tickets in a global
 * invoice and tickets not covered yet; test-mode documents never count as coverage in live mode.
 */
import type { Locale } from "../../../shared/domain";
import type { CfdiCoverage } from "../../../shared/cfdi";
import { moneyLabel, t } from "./format";

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
    <section className="cfdi-corte">
      <h3>
        {t(locale, "cfdiCorteTitle")}
        {test}
      </h3>
      <p>
        {t(locale, "cfdiCorteInvoiced", {
          n: coverage.invoiced,
          total: moneyLabel(coverage.invoicedTotal, locale),
        })}
      </p>
      <p>
        {t(locale, "cfdiCorteGlobal", {
          n: coverage.globalized,
          total: moneyLabel(coverage.globalTotal, locale),
        })}
      </p>
      <p>{t(locale, "cfdiCorteUncovered", { n: coverage.uncovered })}</p>
    </section>
  );
}
