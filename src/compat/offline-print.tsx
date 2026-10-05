/**
 * In-wave fallback for service's (024) print API (wave contracts §3.7, §6).
 * Same signatures as src/print.tsx and src/features/KitchenTicket.tsx. It
 * injects its own <style> at runtime and never touches styles.css. At
 * offline's merge the integrator imports from ../print and
 * ../features/KitchenTicket and deletes this file.
 */
import type { JSX, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Label, Locale, PricedLine } from "../../shared/domain";
import { strings, type Key } from "../i18n";

export type PaperWidth = "80" | "58";
export type PrintSettings = {
  paper: PaperWidth;
  kitchenOnSend: boolean;
  kdsAutoPrint: boolean;
};
const DEFAULTS: PrintSettings = {
  paper: "80",
  kitchenOnSend: false,
  kdsAutoPrint: false,
};

export function readPrintSettings(): PrintSettings {
  try {
    const value = JSON.parse(localStorage.getItem("gm-print-settings") ?? "{}");
    return {
      paper: value.paper === "58" ? "58" : "80",
      kitchenOnSend: value.kitchenOnSend === true,
      kdsAutoPrint: value.kdsAutoPrint === true,
    };
  } catch {
    return DEFAULTS;
  }
}

const STYLE_ID = "gm-offline-print-style";
const ROOT_ID = "gm-offline-print-root";
const CSS = `
#${ROOT_ID}{display:none}
@media print{
  html.gm-offline-printing body>*:not(#${ROOT_ID}){display:none!important}
  html.gm-offline-printing #${ROOT_ID},html.gm-offline-printing #${ROOT_ID} *{visibility:visible!important}
  html.gm-offline-printing #${ROOT_ID}{display:block;width:var(--gm-print-width,72mm);color:#000;font:12px/1.3 ui-monospace,Menlo,Consolas,monospace}
  html.gm-offline-printing .print-section{break-after:page}
  html.gm-offline-printing .print-section:last-child{break-after:auto}
  html.gm-offline-printing .print-ticket p{margin:0 0 2px}
  html.gm-offline-printing .print-ticket-label{font-size:22px;font-weight:700}
  html.gm-offline-printing .print-ticket-banner{font-weight:700}
  html.gm-offline-printing .print-ticket ul{list-style:none;padding:0;margin:6px 0}
  @page{margin:0}
}`;

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** An array prints one <section class="print-section"> per element. */
export async function printDocument(
  content: ReactNode | ReactNode[],
  paper: PaperWidth = readPrintSettings().paper,
): Promise<void> {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const host = document.createElement("div");
  host.id = ROOT_ID;
  document.body.appendChild(host);
  const root = createRoot(host);
  const sections = Array.isArray(content) ? content : [content];
  flushSync(() =>
    root.render(
      <>
        {sections.map((section, index) => (
          <section className="print-section" key={index}>
            {section}
          </section>
        ))}
      </>,
    ),
  );
  const html = document.documentElement;
  html.classList.add("gm-offline-printing");
  html.style.setProperty("--gm-print-width", paper === "58" ? "48mm" : "72mm");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    html.classList.remove("gm-offline-printing");
    html.style.removeProperty("--gm-print-width");
    root.unmount();
    host.remove();
  };
  window.addEventListener("afterprint", cleanup, { once: true });
  await frame();
  await frame();
  try {
    window.print();
  } finally {
    cleanup();
  }
}

export type KitchenTicketModel = {
  banner?: string;
  label: string;
  station: string;
  round: number;
  mode: string;
  channel?: string;
  tableName: string | null;
  callName: string;
  waiterName?: string;
  time: string;
  orderNote: string;
  roundNote?: string;
  lines: {
    quantity: number;
    voidedQuantity?: number;
    name: Label;
    optionNames: Label[];
    note: string;
  }[];
  footer?: string;
};

export function KitchenTicketDocument({
  ticket,
  locale,
  timezone,
}: {
  ticket: KitchenTicketModel;
  locale: Locale;
  timezone: string;
}): JSX.Element {
  const t = (key: string) => strings[locale][key as Key] ?? key;
  const time = new Date(ticket.time).toLocaleTimeString(
    locale === "es" ? "es-MX" : "en-US",
    { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone },
  );
  return (
    <div className="print-ticket">
      {ticket.banner && <p className="print-ticket-banner">{ticket.banner}</p>}
      <p>{t(ticket.station)}</p>
      <p className="print-ticket-label">{ticket.label}</p>
      <p>
        {[t(ticket.mode), ticket.tableName, ticket.callName, ticket.waiterName]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <p>{time}</p>
      <ul>
        {ticket.lines.map((line, index) => (
          <li key={index}>
            <strong>
              {Math.max(0, line.quantity - (line.voidedQuantity ?? 0))} ×{" "}
              {line.name[locale]}
            </strong>
            {line.optionNames.length > 0 && (
              <div>{line.optionNames.map((o) => o[locale]).join(" · ")}</div>
            )}
            {line.note && <div>{line.note}</div>}
          </li>
        ))}
      </ul>
      {ticket.roundNote && <p>{ticket.roundNote}</p>}
      {ticket.orderNote && <p>{ticket.orderNote}</p>}
      {ticket.footer && <p>{ticket.footer}</p>}
    </div>
  );
}

/** One ticket per station, made of these lines only. */
export function ticketsFromLines(i: {
  label: string;
  banner?: string;
  footer?: string;
  round: number;
  mode: string;
  tableName: string | null;
  callName: string;
  time: string;
  orderNote: string;
  lines: PricedLine[];
}): KitchenTicketModel[] {
  return [...new Set(i.lines.map((line) => line.station))].map((station) => ({
    banner: i.banner,
    label: i.label,
    station,
    round: i.round,
    mode: i.mode,
    tableName: i.tableName,
    callName: i.callName,
    time: i.time,
    orderNote: i.orderNote,
    footer: i.footer,
    lines: i.lines
      .filter((line) => line.station === station)
      .map((line) => ({
        quantity: line.quantity,
        name: line.name,
        optionNames: line.optionNames ?? [],
        note: line.note ?? "",
      })),
  }));
}
