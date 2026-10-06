import type { Locale } from "../../../shared/domain";
import { strings } from "../../i18n";
import { printDocument, readPrintSettings, type PaperWidth } from "../../print";
import { fill } from "../reports/format";
import type { KitchenCancellationModel } from "./cancellations";
import "./printing.css";

/**
 * A kitchen cancellation chit on 80/58 mm paper, in the device's UI language (an internal
 * document, spec §2.10 / D17), in the kitchen ticket's quantity style.
 */
export function KitchenCancellationDocument({
  ticket,
  locale,
  timezone,
}: {
  ticket: KitchenCancellationModel;
  locale: Locale;
  timezone: string;
}) {
  const t = strings[locale];
  return (
    <div className="kitchen-doc cancel-doc">
      <h2 className="doc-title">
        {ticket.kind === "refund"
          ? t.reportsKitchenRefundTitle
          : t.reportsKitchenCancelTitle}
      </h2>
      <h2 className="doc-title">
        {ticket.label} {ticket.callName}
      </h2>
      <p className="doc-meta">
        {t.round} {ticket.round} ·{" "}
        {ticket.station === "bar" ? t.bar : t.kitchen} ·{" "}
        {new Date(ticket.time).toLocaleTimeString(locale, {
          timeZone: timezone,
          hour: "2-digit",
          minute: "2-digit",
        })}{" "}
        · {ticket.tableName ?? t.noTable}
      </p>
      {ticket.lines.map((line, i) => (
        <div className="doc-kitchen-line" key={i}>
          <div>
            <span className="doc-kitchen-qty cancel-line">
              − {line.quantity} ×
            </span>{" "}
            <strong>{line.name[locale]}</strong>
          </div>
          {line.optionNames.map((o, j) => (
            <div key={j}>+ {o[locale]}</div>
          ))}
        </div>
      ))}
      {ticket.reason && (
        <div className="doc-note">
          <strong>
            {fill(t.reportsKitchenCancelReason, { reason: ticket.reason })}
          </strong>
        </div>
      )}
    </div>
  );
}

/**
 * Prints every chit as a section of one print job. Returns true when there was nothing to print
 * or the job ran, false when printing failed: a print error never fails the void or refund.
 */
export async function printCancellations(
  tickets: readonly KitchenCancellationModel[],
  locale: Locale,
  timezone: string,
  paper: PaperWidth = readPrintSettings().paper,
): Promise<boolean> {
  if (!tickets.length) return true;
  try {
    await printDocument(
      tickets.map((ticket, i) => (
        <KitchenCancellationDocument
          key={i}
          ticket={ticket}
          locale={locale}
          timezone={timezone}
        />
      )),
      paper,
    );
    return true;
  } catch {
    return false;
  }
}
