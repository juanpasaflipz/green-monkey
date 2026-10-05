import { liveQuery } from "dexie";
import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { db, scope } from "../../offline";
import {
  localKitchenTickets,
  tablesKey,
  type LocalTicket,
} from "../../offline-records";
import { Button, Empty, Modal } from "../../components/ui";
import {
  KitchenTicketDocument,
  printDocument,
  readPrintSettings,
} from "../../compat/offline-print";
import { translator } from "./format";
import "./offline.css";

type TicketStatus = "pending" | "ready" | "delivered";

/** Ticket copy shared by the device list and automatic printing. */
export function ticketCopy(locale: Locale) {
  const t = translator(locale);
  return {
    banner: t("offlineTicketHeader"),
    footer: t("offlineTicketFooter"),
    round: (n: number) => t("offlineTicketRound", { n }),
  };
}

/** Prints the given device tickets through the shared print primitive. */
export function printTickets(
  tickets: LocalTicket[],
  locale: Locale,
  timezone: string,
) {
  if (!tickets.length) return Promise.resolve();
  return printDocument(
    tickets.map((item) => (
      <KitchenTicketDocument
        ticket={item.ticket}
        locale={locale}
        timezone={timezone}
      />
    )),
    readPrintSettings().paper,
  );
}

/** Tickets of records saved on this device in the last 24 h. */
export async function recentTickets(session: Session, locale: Locale) {
  const tables =
    ((await db.cache.get(tablesKey(session)))?.value as
      | { id: string; name: string }[]
      | undefined) ?? [];
  return localKitchenTickets(
    session,
    Date.now() - 86_400_000,
    ticketCopy(locale),
    tables,
  );
}

/** Device-local list of offline kitchen tickets (§2.5). Never synced. */
export function LocalKitchenTickets({
  session,
  locale,
  close,
}: {
  session: Session;
  locale: Locale;
  close: () => void;
}) {
  const t = translator(locale);
  const [tickets, setTickets] = useState<LocalTicket[] | null>(null);
  const [status, setStatus] = useState<Record<string, TicketStatus>>({});
  const key = scope(session);
  useEffect(() => {
    const subscription = liveQuery(async () => {
      const list = await recentTickets(session, locale);
      const chips = await db.cache.bulkGet(list.map((item) => item.key));
      return {
        list,
        chips: Object.fromEntries(
          list.map((item, i) => [
            item.key,
            ((chips[i]?.value as { status?: TicketStatus } | undefined)
              ?.status ?? "pending") as TicketStatus,
          ]),
        ),
      };
    }).subscribe({
      next: ({ list, chips }) => {
        setTickets(list);
        setStatus(chips);
      },
      error: () => setTickets([]),
    });
    return () => subscription.unsubscribe();
  }, [key, locale]);
  const setChip = (ticketKey: string, value: TicketStatus) =>
    void db.cache.put({
      id: ticketKey,
      value: { status: value, updatedAt: Date.now() },
    });
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale === "es" ? "es-MX" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: session.restaurant.timezone,
    });
  return (
    <Modal
      title={t("offlineTicketsTitle")}
      close={close}
      closeLabel={t("close")}
      wide
    >
      <p className="muted">{t("offlineTicketsHint")}</p>
      {tickets === null ? (
        <p role="status">{t("loading")}</p>
      ) : !tickets.length ? (
        <Empty title={t("offlineTicketsEmpty")} />
      ) : (
        <div className="offline-ticket-list">
          {tickets.map((item) => (
            <article className="offline-ticket" key={item.key}>
              <h3>{item.ticket.label}</h3>
              <p>
                {t(item.ticket.station === "bar" ? "bar" : "kitchen")} ·{" "}
                {time(item.ticket.time)}
                {item.ticket.tableName ? ` · ${item.ticket.tableName}` : ""}
                {item.ticket.callName ? ` · ${item.ticket.callName}` : ""}
              </p>
              <ul>
                {item.ticket.lines.map((line, index) => (
                  <li key={index}>
                    {line.quantity} × {line.name[locale]}
                    {line.optionNames.length
                      ? ` (${line.optionNames.map((o) => o[locale]).join(", ")})`
                      : ""}
                    {line.note ? ` — ${line.note}` : ""}
                  </li>
                ))}
              </ul>
              <div className="row between">
                <div
                  className="offline-chip-group"
                  role="group"
                  aria-label={item.ticket.label}
                >
                  {(["pending", "ready", "delivered"] as const).map((value) => (
                    <button
                      type="button"
                      key={value}
                      aria-pressed={status[item.key] === value}
                      onClick={() => setChip(item.key, value)}
                    >
                      {t(
                        value === "pending"
                          ? "offlineTicketPending"
                          : value === "ready"
                            ? "offlineTicketReady"
                            : "offlineTicketDelivered",
                      )}
                    </button>
                  ))}
                </div>
                <Button
                  onClick={() =>
                    void printTickets(
                      [item],
                      locale,
                      session.restaurant.timezone,
                    )
                  }
                >
                  {t("offlineReprint")}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </Modal>
  );
}
