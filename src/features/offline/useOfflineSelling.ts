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
import type { TenderMethod } from "../../../shared/payments";
import { useConnectivity } from "../../connectivity";
import { db } from "../../offline";
import {
  cachedServerOpenOrders,
  isLocalOrder,
  localOpenOrders,
  offlineBlockReason,
  orderTicketIds,
  refreshOpenOrders,
  saveOfflineCheckout,
  saveOfflineOrder,
  saveOfflineRound,
  tablesKey,
  targetOf,
  type LocalOrderView,
  type LocalReceipt,
  type OfflinePaymentValues,
  type SaveContext,
} from "../../offline-records";
import {
  refreshOfflineSettings,
  useOfflineTableService,
} from "../../offline-settings";
import { guardOnlineCharge } from "../../offline-queue";
import { translateError } from "../../i18n";
import { KitchenTicketDocument } from "../KitchenTicket";
import { printDocument, readPrintSettings } from "../../print";
import { recentTickets } from "./LocalKitchenTickets";
import { ReceiptDocument } from "../Receipt";
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

export type { OfflinePaymentValues } from "../../offline-records";

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
  // "storage" never fires in the tab that wrote it: the Sync screen sets
  // "Al guardar sin conexión" in this same tab, so re-read it whenever Vender
  // comes back on screen (restaurant-day A13).
  useEffect(() => {
    if (active) setPrintSetting(readPrintSetting());
  }, [active]);
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
  // LD-7: the restaurant's offline table service setting, read when selling
  // opens and when the connection returns (never polled), kept for outages.
  const tableService = useOfflineTableService(session);
  useEffect(() => {
    if (!net.canUseServer || !active || session.role === "kitchen") return;
    void refreshOfflineSettings(session).catch(() => {});
  }, [net.canUseServer, active, session.id]);
  // Open orders cached for an outage: on mount and every 120 s while visible,
  // only while offline table service is on (GAP-4, LD-7).
  useEffect(() => {
    if (
      !net.canUseServer ||
      !active ||
      session.role === "kitchen" ||
      !tableService
    )
      return;
    const refresh = () => {
      if (document.visibilityState === "visible")
        void refreshOpenOrders(session).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 120_000);
    return () => clearInterval(timer);
  }, [net.canUseServer, active, session.id, tableService]);
  const ctx: SaveContext = useMemo(
    () => ({ session, catalog, cashSession }),
    [session, catalog, cashSession],
  );
  const blockReason = offlineBlockReason(session, cashSession, false);
  const paymentBlockReason = offlineBlockReason(session, cashSession, true);
  /** Enviar without the server needs table service (it opens a local check). */
  const sendBlockReason =
    blockReason ?? (tableService ? null : "offline_table_service_off");
  const autoPrint = printSetting !== "ask";
  /**
   * A local receipt's label and hint for service's receipt (§3.8): the label
   * replaces "#number" and reads "Número provisional B-07" (OFFLINE_RECOVERY
   * "Provisional numbers"), so the bare prefix is never taken for a folio.
   */
  const localLabel = (receipt: LocalReceipt, tr = t) => ({
    label: receipt.offline.provisionalNumber
      ? tr("offlineProvisional", { n: receipt.offline.provisionalNumber })
      : undefined,
    labelHint: tr("offlineProvisionalHint"),
  });
  /** fiscal (027): the printed receipt is a comprobante, in Spanish (D10). */
  const printedLabel = (receipt: LocalReceipt) =>
    localLabel(receipt, translator("es"));
  /** Prints the kitchen tickets of these records, and a receipt when given. */
  async function print(operationIds: string[], receipt: LocalReceipt | null) {
    const tickets = (await recentTickets(session, locale)).filter((item) =>
      operationIds.includes(item.operationId),
    );
    const sections: ReactNode[] = tickets.map((item) =>
      createElement(KitchenTicketDocument, {
        ticket: item.ticket,
        locale,
        timezone: session.restaurant.timezone,
      }),
    );
    // Service's receipt, kind "local" (§3.8, LD-10 B4): order and round notes
    // (LD-1), options, payment method, external reference and change.
    if (receipt)
      sections.push(
        createElement(ReceiptDocument, {
          order: receipt,
          session,
          locale: "es",
          kind: "local",
          ...printedLabel(receipt),
        }),
      );
    if (sections.length)
      await printDocument(sections, readPrintSettings().paper);
  }
  return {
    canUseServer: net.canUseServer,
    blockReason,
    paymentBlockReason,
    sendBlockReason,
    /** LD-7: open checks, rounds and partial payments offline (Beta, off by default). */
    tableService,
    printSetting,
    autoPrint,
    /** Service's PaymentDialog `offline` slot (§3.8). */
    paymentSlot: {
      allowExternal: true,
      // payments (037): a platform tender is recorded offline like a terminal one.
      allowPlatform: true,
      confirmLabel: (method: TenderMethod) =>
        method === "external"
          ? t("offlineSaveExternal")
          : method === "platform"
            ? t("payOfflineSavePlatform")
            : t("saveOffline"),
      hint: (method: TenderMethod) =>
        method === "external"
          ? t("offlineHintExternal")
          : method === "platform"
            ? t("payOfflineHintPlatform")
            : t("offlineHintCash"),
      blockReason: paymentBlockReason
        ? translateError(paymentBlockReason, locale)
        : null,
    },
    /**
     * "Enviar" without the server: a new local open order, or a round for the
     * current local or cached order. Returns the record id and the new view.
     */
    async sendOffline(
      current: Order | null,
      draft: OrderInput,
      cart: { priced: PricedLine[]; total: number },
    ): Promise<{ operationId: string; view: LocalOrderView }> {
      // One record id per click; never the draft's order id (that one is the
      // server's create_order key).
      const operationId = crypto.randomUUID();
      const view = current
        ? await saveOfflineRound(ctx, {
            target: targetOf(current as LocalOrderView),
            lines: draft.lines,
            priced: cart.priced,
            total: cart.total,
            // The cart's round note, as an online round keeps it (LD-1).
            note: draft.note,
            operationId,
            autoPrint,
          })
        : await saveOfflineOrder(ctx, {
            draft,
            priced: cart.priced,
            total: cart.total,
            operationId,
            autoPrint,
          });
      return { operationId, view };
    },
    /**
     * Saves an offline checkout: a new order paid in full (sale) or in part
     * (order + payment), or a payment of the current local or cached order,
     * with the draft's items as a round in the same transaction.
     */
    async collectOffline(
      values: OfflinePaymentValues,
      cart: {
        draft: OrderInput;
        priced: PricedLine[];
        total: number;
        current: Order | null;
        operationId: string;
        orderOperationId: string;
      },
      items?: string[],
    ): Promise<{
      receipt: LocalReceipt;
      operationIds: string[];
      /** The order to keep selling against when a balance remains. */
      view: LocalOrderView | null;
    }> {
      return saveOfflineCheckout(ctx, values, { ...cart, autoPrint }, items);
    },
    /**
     * Before an online charge: refuses while this device has an unresolved
     * offline payment (OFF-R5) or round (OFF-R26) for the same order, so the
     * guest is never charged twice and never leaves without paying the items
     * saved offline. The refusal syncs those records now, without waiting
     * for the retry backoff.
     */
    guardOnlinePayment: (order: Order | null) =>
      guardOnlineCharge(session, order),
    /** Cached server orders and orders created on this device. */
    async openOrders(): Promise<{
      refreshedAt: string | null;
      server: LocalOrderView[];
      local: LocalOrderView[];
    }> {
      const [cached, local] = await Promise.all([
        cachedServerOpenOrders(session),
        localOpenOrders(session),
      ]);
      return {
        refreshedAt: cached.refreshedAt,
        server: cached.orders.filter((order) => order.total > order.paid),
        local,
      };
    },
    isLocalOrder,
    /** Receipt props for service's ReceiptModal (§3.8). */
    receiptProps(order: Order) {
      if (!isLocalReceipt(order)) return null;
      const printed = printedLabel(order);
      return {
        ...localLabel(order),
        printLabel: printed.label,
        printLabelHint: printed.labelHint,
        kind: "local" as const,
      };
    },
    printKitchen: (operationIds: string[]) => print(operationIds, null),
    /** Every kitchen ticket this device saved for the order on screen. */
    async printOrder(order: Order) {
      await print(await orderTicketIds(session, order), null);
    },
    /** Auto-print right after a save, inside the click's user activation. */
    afterSave(operationIds: string[], receipt: LocalReceipt | null = null) {
      if (printSetting !== "ask")
        void print(
          operationIds,
          printSetting === "kitchen_receipt" ? receipt : null,
        );
    },
  };
}
