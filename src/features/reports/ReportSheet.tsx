import type { ReactNode } from "react";
import { printDocument, readPrintSettings } from "../../print";
import "../printing/printing.css";

/**
 * A report printed on a letter/A4 page ("Imprimir o guardar PDF"): inside service's `.print-doc`
 * the sheet widens the container, sets 12 mm padding and 11 pt type and lets tables paginate
 * (printing.css), so the browser dialog's "Guardar como PDF" gives a page, not a 72 mm strip.
 */
export function ReportSheet({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="report-sheet">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {children}
    </div>
  );
}

/** Prints `node` as a report sheet through the one print path (src/print.tsx). */
export function printSheet(
  title: string,
  subtitle: string,
  node: ReactNode,
): Promise<void> {
  return printDocument(
    <ReportSheet title={title} subtitle={subtitle}>
      {node}
    </ReportSheet>,
    readPrintSettings().paper,
  );
}
