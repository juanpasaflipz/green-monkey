import type { Label, Locale, Order, PricedLine } from "../../shared/domain";
import { ALLERGY_PATTERN, type KitchenRound } from "../../shared/service";
import { strings, type Key } from "../i18n";
import { channelLabel, orderNumberLabel } from "../labels";

/**
 * The business day a printed kitchen paper names its order against (LD-29,
 * LD-44): an order from another business day prints "#10 · 5 oct", as the
 * screens read it, so yesterday's open #10 and today's #10 never print alike.
 * `today` is the restaurant's current business date (currentBusinessDate, or
 * the kitchen feed's currentBusinessDate); `locale` the device's print language.
 */
export type PrintDay = { today: string | null | undefined; locale: Locale };

/** Everything a printed kitchen ticket (comanda) shows; shared with offline. */
export type KitchenTicketModel = {
  /** e.g. offline "COMANDA · SIN CONEXIÓN" */
  banner?: string;
  /** "#142", "#142 · 5 oct" (another business day), "B-07", "#142 · Ronda 2" */
  label: string;
  /** "kitchen" | "bar" */
  station: string;
  round: number;
  /** raw code; the component translates it */
  mode: string;
  channel?: string;
  tableName: string | null;
  callName: string;
  waiterName?: string;
  /** ISO instant; rendered HH:mm in the restaurant timezone */
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
  /** e.g. offline "Número provisional…" */
  footer?: string;
};

/** A live KDS round as a printable ticket, dated as its screen header is. */
export function ticketFromKitchenRound(
  r: KitchenRound,
  day: PrintDay,
): KitchenTicketModel {
  return {
    label: orderNumberLabel(
      { number: r.orderNumber, businessDate: r.businessDate },
      day.today,
      day.locale,
    ),
    station: r.station,
    round: r.roundNumber,
    mode: r.mode,
    channel: r.channel,
    tableName: r.tableName,
    callName: r.callName,
    waiterName: r.waiterName,
    time: r.createdAt,
    orderNote: r.orderNote,
    roundNote: r.roundNote,
    lines: r.lines,
  };
}

/** Tickets for unsent or local lines, one per station. */
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
  /** An offline round's own note (LD-1). */
  roundNote?: string;
  lines: PricedLine[];
}): KitchenTicketModel[] {
  const stations = [...new Set(i.lines.map((l) => l.station))];
  return stations.map((station) => ({
    banner: i.banner,
    footer: i.footer,
    label: i.label,
    station,
    round: i.round,
    mode: i.mode,
    tableName: i.tableName,
    callName: i.callName,
    time: i.time,
    orderNote: i.orderNote,
    ...(i.roundNote ? { roundNote: i.roundNote } : {}),
    lines: i.lines
      .filter((l) => l.station === station)
      .map((l) => ({
        quantity: l.quantity,
        voidedQuantity: l.voidedUnits?.length ?? 0,
        name: l.name,
        optionNames: l.optionNames,
        note: l.note ?? "",
      })),
  }));
}

/** One ticket per station for a round of a server order (used after a send). */
export function ticketsFromOrderRound(
  order: Order,
  round: number,
  day: PrintDay,
): KitchenTicketModel[] {
  const rounds = (order.rounds ?? []).filter((r: any) => r.number === round);
  return ticketsFromLines({
    label: orderNumberLabel(order, day.today, day.locale),
    round,
    mode: order.mode,
    tableName: order.tableName ?? null,
    callName: order.name,
    time: rounds[0]?.created_at
      ? new Date(rounds[0].created_at).toISOString()
      : order.createdAt,
    orderNote: order.note,
    lines: order.lines.filter((l) => l.round === round),
  }).map((ticket) => {
    const r = rounds.find((x: any) => x.station === ticket.station);
    return {
      ...ticket,
      channel: order.channel ?? "pos",
      waiterName: order.waiterName,
      roundNote: r?.note ?? "",
    };
  });
}

/**
 * The tickets still on the kitchen screen (every station round not yet
 * served), for reprinting comandas after the order note changed.
 */
export function ticketsForOpenRounds(
  order: Order,
  day: PrintDay,
): KitchenTicketModel[] {
  const open = (order.rounds ?? []).filter(
    (r: any) => r.state !== "completed" && r.state !== "offline_review",
  );
  const numbers = [...new Set(open.map((r: any) => r.number as number))].sort(
    (a, b) => a - b,
  );
  return numbers.flatMap((n) =>
    ticketsFromOrderRound(order, n, day).filter((ticket) =>
      open.some((r: any) => r.number === n && r.station === ticket.station),
    ),
  );
}

/** A boxed note on a printed document; allergy notes are labelled "Alergia". */
export function DocNote({
  label,
  text,
  locale,
}: {
  label: string;
  text: string;
  locale: Locale;
}) {
  const allergy = ALLERGY_PATTERN.test(text);
  return (
    <div className={allergy ? "doc-note allergy" : "doc-note"}>
      <strong>{allergy ? strings[locale].serviceKdsAllergy : label}: </strong>
      {text}
    </div>
  );
}

/** Thermal print layout: large quantities, every modifier, boxed notes. */
export function KitchenTicketDocument({
  ticket,
  locale,
  timezone,
}: {
  ticket: KitchenTicketModel;
  locale: Locale;
  timezone: string;
}) {
  const t = strings[locale];
  const roundNote =
    ticket.roundNote && ticket.roundNote !== ticket.orderNote
      ? ticket.roundNote
      : "";
  return (
    <div className="kitchen-doc">
      {ticket.banner && <p className="doc-flag">{ticket.banner}</p>}
      <h2 className="doc-title">
        {ticket.label} {ticket.callName}
      </h2>
      <p>
        {t.round} {ticket.round} · {t[ticket.mode as Key] ?? ticket.mode} ·{" "}
        {ticket.station === "bar" ? t.bar : t.kitchen}
        {ticket.channel && ticket.channel !== "pos" && (
          <> · {channelLabel(ticket.channel, locale)}</>
        )}
        <br />
        {new Date(ticket.time).toLocaleTimeString(locale, {
          timeZone: timezone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })}{" "}
        · {ticket.tableName ?? t.noTable}
        {ticket.waiterName ? ` · ${ticket.waiterName}` : ""}
      </p>
      {ticket.orderNote && (
        <DocNote
          label={t.serviceKdsOrderNote}
          text={ticket.orderNote}
          locale={locale}
        />
      )}
      {roundNote && (
        <DocNote
          label={t.serviceKdsRoundNote}
          text={roundNote}
          locale={locale}
        />
      )}
      {ticket.lines.map((l, index) => {
        const voided = l.voidedQuantity ?? 0;
        const left = l.quantity - voided;
        return (
          <div className="doc-kitchen-line" key={index}>
            <div>
              <span className="doc-kitchen-qty">{left} ×</span>{" "}
              <strong className={left === 0 ? "doc-voided" : ""}>
                {l.name[locale]}
              </strong>
              {voided > 0 && (
                <>
                  {" "}
                  <s>({l.quantity})</s>
                  {left === 0 && <strong> {t.serviceKdsVoided}</strong>}
                </>
              )}
            </div>
            {l.optionNames.map((o, i) => (
              <div key={i}>+ {o[locale]}</div>
            ))}
            {l.note && (
              <DocNote
                label={t.serviceLineNote}
                text={l.note}
                locale={locale}
              />
            )}
          </div>
        );
      })}
      {ticket.footer && <p className="doc-footer">{ticket.footer}</p>}
    </div>
  );
}
