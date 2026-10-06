import type { ReactNode } from "react";
import { printDocument, readPrintSettings } from "../../print";
import { DocFooter } from "../printing/layout";
import "../printing/printing.css";

/**
 * A report printed on a letter/A4 page ("Imprimir o guardar PDF"): inside service's `.print-doc`
 * the sheet widens the container, sets 12 mm padding and 11 pt type and lets tables paginate
 * (printing.css), so the browser dialog's "Guardar como PDF" gives a page, not a 72 mm strip.
 */
export function ReportSheet({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  /** "Documento interno; no es comprobante fiscal." (spec §2.6, review UI-13). */
  footer?: string;
  children: ReactNode;
}) {
  return (
    <div className="report-sheet">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {children}
      {footer && <DocFooter>{footer}</DocFooter>}
    </div>
  );
}

/** Prints `node` as a report sheet through the one print path (src/print.tsx). */
export function printSheet(
  title: string,
  subtitle: string,
  node: ReactNode,
  footer?: string,
): Promise<void> {
  return printDocument(
    <ReportSheet title={title} subtitle={subtitle} footer={footer}>
      {node}
    </ReportSheet>,
    readPrintSettings().paper,
  );
}
