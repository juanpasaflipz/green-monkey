// The ticket register's CSV for the accountant (LD-16 L13): shared/csv.ts's writer (BOM, CRLF,
// formula-injection guard) with fixed snake_case Spanish headers, whatever the UI language, and
// the file name tickets_{from}_{to}.csv.
import { moneyCsv, toCsv, type CsvColumn } from "../../../shared/csv";
import {
  parseFolio,
  type TaxCategory,
  type TicketRow,
} from "../../../shared/fiscal";
import { tenderMethodLabel } from "../../labels";

const group = (row: TicketRow, category: TaxCategory) =>
  row.groups.find((g) => g.category === category);

export const TICKET_CSV_COLUMNS: readonly CsvColumn<TicketRow>[] = [
  { header: "folio", type: "t", value: (r) => r.folio },
  { header: "serie", type: "t", value: (r) => parseFolio(r.folio)?.series },
  { header: "numero", type: "i", value: (r) => parseFolio(r.folio)?.number },
  { header: "fecha_expedicion", type: "dt", value: (r) => r.issuedAt },
  { header: "dia_negocio", type: "d", value: (r) => r.businessDate },
  { header: "orden", type: "i", value: (r) => r.orderNumber },
  { header: "total", type: "m", value: (r) => r.gross },
  {
    header: "base_iva16",
    type: "m",
    value: (r) => group(r, "iva16")?.base ?? 0,
  },
  { header: "iva16", type: "m", value: (r) => group(r, "iva16")?.tax ?? 0 },
  { header: "base_iva8", type: "m", value: (r) => group(r, "iva8")?.base ?? 0 },
  { header: "iva8", type: "m", value: (r) => group(r, "iva8")?.tax ?? 0 },
  {
    header: "venta_tasa0",
    type: "m",
    value: (r) => group(r, "iva0")?.gross ?? 0,
  },
  {
    header: "venta_exenta",
    type: "m",
    value: (r) => group(r, "exempt")?.gross ?? 0,
  },
  { header: "descuentos", type: "m", value: (r) => r.discount },
  { header: "propinas", type: "m", value: (r) => r.tip },
  { header: "reembolsos", type: "m", value: (r) => r.refundGross },
  { header: "iva_reembolsado", type: "m", value: (r) => r.refundTax },
  {
    header: "formas_pago",
    type: "t",
    value: (r) => {
      const totals = new Map<string, number>();
      for (const p of r.payments)
        totals.set(p.method, (totals.get(p.method) ?? 0) + p.amount);
      return [...totals]
        .map(
          ([method, amount]) =>
            `${tenderMethodLabel(method, undefined, "es")} ${moneyCsv(amount, "MXN")}`,
        )
        .join("; ");
    },
  },
  { header: "codigo_facturacion", type: "t", value: (r) => r.selfInvoiceCode },
];

/** The whole file (UTF-8 with BOM, comma separated, dot decimals, CRLF). */
export function ticketsCsv(rows: readonly TicketRow[], timezone: string) {
  return toCsv(TICKET_CSV_COLUMNS, rows, {
    locale: "es",
    currency: "MXN",
    timezone,
  });
}

/** tickets_{from}_{to}.csv, even for a single day (acceptance A15.5). */
export const ticketsCsvName = (from: string, to: string) =>
  `tickets_${from}_${to}.csv`;

/** Saves text as a file through a temporary object URL. */
export function downloadCsv(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
