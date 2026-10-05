import {
  createElement,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  Locale,
  Order,
  OrderInput,
  PricedLine,
  Product,
  Session,
} from "../../../shared/domain";
import { api } from "../../api";
import { useConnectivity } from "../../connectivity";
import { db } from "../../offline";
import {
  OfflineSaveError,
  offlineBlockReason,
  saveOfflineSale,
  tablesKey,
  type LocalReceipt,
  type SaveContext,
} from "../../offline-records";
import { translateError } from "../../i18n";
import {
  KitchenTicketDocument,
  printDocument,
  readPrintSettings,
} from "../../compat/offline-print";
import { recentTickets } from "./LocalKitchenTickets";
import { LocalReceiptDocument } from "./LocalReceiptDocument";
import { translator } from "./format";

export type PrintSetting = "ask" | "kitchen" | "kitchen_receipt";
export const PRINT_SETTING_KEY = "gm-offline-print";

export function readPrintSetting(): PrintSetting {
  try {
    const value = localStorage.getItem(PRINT_SETTING_KEY);
    return value === "kitchen" || value === "kitchen_receipt" ? value : "ask";
  } catch {
    return "ask";
  }
}

/** Payment values with the same names as service's PaymentValues (§4.8). */
export type OfflinePaymentValues = {
  amount: number;
  tip: number;
  received: number;
  method: "cash" | "external";
  reference: string;
  confirmed: boolean;
};

export const isLocalReceipt = (order: Order | null): order is LocalReceipt =>
  order?.state === "local";

/**
 * Offline selling for Selling.tsx: the payment-dialog slot, the record
 * builders bound to this session and kitchen-ticket printing (OFF-5, §3.8).
 */
export function useOfflineSelling({
  session,
  catalog,
  locale,
  cashSession,
  active,
}: {
  session: Session;
  catalog: Product[];
  locale: Locale;
  cashSession: { id: string; closed_at: string | null } | null;
  active: boolean;
}) {
  const net = useConnectivity();
  const t = translator(locale);
  const [printSetting, setPrintSetting] =
    useState<PrintSetting>(readPrintSetting);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === PRINT_SETTING_KEY) setPrintSetting(readPrintSetting());
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  // Table names for offline kitchen tickets, refreshed while online.
  useEffect(() => {
    if (!net.canUseServer || !active || session.role === "kitchen") return;
    void api<{ id: string; name: string }[]>("/tables")
      .then((tables) =>
        db.cache.put({
          id: tablesKey(session),
          value: tables.map(({ id, name }) => ({ id, name })),
        }),
      )
      .catch(() => {});
  }, [net.canUseServer, active, session.id]);
  const ctx: SaveContext = useMemo(
    () => ({ session, catalog, cashSession }),
    [session, catalog, cashSession],
  );
  const blockReason = offlineBlockReason(session, cashSession, false);
  const paymentBlockReason = offlineBlockReason(session, cashSession, true);
  const autoPrint = printSetting !== "ask";
  /** Prints this sale's kitchen tickets, and its receipt when asked. */
  async function print(receipt: LocalReceipt, withReceipt: boolean) {
    const tickets = (await recentTickets(session, locale)).filter(
      (item) => item.operationId === receipt.id,
    );
    const sections: ReactNode[] = tickets.map((item) =>
      createElement(KitchenTicketDocument, {
        ticket: item.ticket,
        locale,
        timezone: session.restaurant.timezone,
      }),
    );
    if (withReceipt)
      sections.push(createElement(LocalReceiptDocument, { receipt, locale }));
    if (sections.length)
      await printDocument(sections, readPrintSettings().paper);
  }
  return {
    canUseServer: net.canUseServer,
    blockReason,
    paymentBlockReason,
    printSetting,
    autoPrint,
    /** Service's PaymentDialog `offline` slot (§3.8). */
    paymentSlot: {
      allowExternal: true,
      confirmLabel: (method: "cash" | "external") =>
        method === "external" ? t("offlineSaveExternal") : t("saveOffline"),
      hint: (method: "cash" | "external") =>
        method === "external" ? t("offlineHintExternal") : t("offlineHintCash"),
      blockReason: paymentBlockReason
        ? translateError(paymentBlockReason, locale)
        : null,
    },
    /**
     * Saves an offline checkout. Only a new order paid in full is a sale; the
     * offline-tables series adds open orders, rounds and partial payments.
     */
    async collectOffline(
      values: OfflinePaymentValues,
      cart: {
        draft: OrderInput;
        priced: PricedLine[];
        total: number;
        current: Order | null;
        operationId: string;
      },
      items?: string[],
    ): Promise<LocalReceipt> {
      if (items) throw new OfflineSaveError("offline_split_unavailable");
      if (cart.current || values.amount !== cart.total)
        throw new OfflineSaveError("offline_conflict");
      return saveOfflineSale(ctx, {
        draft: cart.draft,
        priced: cart.priced,
        total: cart.total,
        operationId: cart.operationId,
        autoPrint,
        payment: {
          method: values.method,
          amount: values.amount,
          tip: values.tip,
          received:
            values.method === "external"
              ? values.amount + values.tip
              : values.received,
          reference: values.method === "external" ? values.reference.trim() : "",
          externalConfirmed: values.method === "external" && values.confirmed,
        },
      });
    },
    /** Receipt props for service's ReceiptModal (§3.8). */
    receiptProps(order: Order) {
      return isLocalReceipt(order)
        ? {
            label: order.offline.provisionalNumber ?? undefined,
            labelHint: t("offlineProvisionalHint"),
            kind: "local" as const,
          }
        : null;
    },
    printKitchen: (receipt: LocalReceipt) => print(receipt, false),
    /** Auto-print right after a save, inside the click's user activation. */
    afterSave(receipt: LocalReceipt) {
      if (printSetting !== "ask")
        void print(receipt, printSetting === "kitchen_receipt");
    },
  };
}
