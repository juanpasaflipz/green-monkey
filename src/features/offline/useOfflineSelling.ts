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
  cachedServerOpenOrders,
  isLocalOrder,
  localOpenOrders,
  offlineBlockReason,
  refreshOpenOrders,
  saveOfflineOrder,
  saveOfflinePartial,
  saveOfflinePayment,
  saveOfflineRound,
  saveOfflineSale,
  tablesKey,
  targetOf,
  type LocalOrderView,
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

/** The order view to keep selling against after a partial offline payment. */
function openView(receipt: LocalReceipt, state: string): LocalOrderView | null {
  if (receipt.paid >= receipt.total) return null;
  return {
    ...receipt,
    state,
    offline: {
      provisionalNumber: receipt.offline.provisionalNumber,
      soldAt: receipt.offline.soldAt,
      localOperationId: receipt.offline.localOperationId ?? null,
      cachedAt: receipt.offline.cachedAt ?? null,
      serverOrderId: receipt.offline.serverOrderId ?? null,
    },
  };
}

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
  // Open orders cached for an outage: on mount and every 120 s while visible.
  useEffect(() => {
    if (!net.canUseServer || !active || session.role === "kitchen") return;
    const refresh = () => {
      if (document.visibilityState === "visible")
        void refreshOpenOrders(session).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 120_000);
    return () => clearInterval(timer);
  }, [net.canUseServer, active, session.id]);
  const ctx: SaveContext = useMemo(
    () => ({ session, catalog, cashSession }),
    [session, catalog, cashSession],
  );
  const blockReason = offlineBlockReason(session, cashSession, false);
  const paymentBlockReason = offlineBlockReason(session, cashSession, true);
  const autoPrint = printSetting !== "ask";
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
    if (receipt)
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
      if (items) throw new OfflineSaveError("offline_split_unavailable");
      const payment = {
        method: values.method,
        amount: values.amount,
        tip: values.tip,
        received:
          values.method === "external"
            ? values.amount + values.tip
            : values.received,
        reference: values.method === "external" ? values.reference.trim() : "",
        externalConfirmed: values.method === "external" && values.confirmed,
      };
      if (cart.current) {
        const roundId = crypto.randomUUID();
        const receipt = await saveOfflinePayment(ctx, {
          target: targetOf(cart.current as LocalOrderView),
          payment,
          operationId: cart.operationId,
          round: cart.draft.lines.length
            ? {
                lines: cart.draft.lines,
                priced: cart.priced,
                total: cart.total,
                operationId: roundId,
                autoPrint,
              }
            : undefined,
        });
        return {
          receipt,
          operationIds: cart.draft.lines.length ? [roundId] : [],
          view: openView(receipt, cart.current.state),
        };
      }
      if (values.amount > cart.total)
        throw new OfflineSaveError("offline_amount_exceeds_due");
      if (values.amount < cart.total) {
        const receipt = await saveOfflinePartial(ctx, {
          draft: cart.draft,
          priced: cart.priced,
          total: cart.total,
          payment,
          orderOperationId: cart.orderOperationId,
          paymentOperationId: cart.operationId,
          autoPrint,
        });
        return {
          receipt,
          operationIds: [cart.orderOperationId],
          view: openView(receipt, "local_open"),
        };
      }
      const receipt = await saveOfflineSale(ctx, {
        draft: cart.draft,
        priced: cart.priced,
        total: cart.total,
        operationId: cart.operationId,
        autoPrint,
        payment,
      });
      return { receipt, operationIds: [receipt.id], view: null };
    },
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
      return isLocalReceipt(order)
        ? {
            label: order.offline.provisionalNumber ?? undefined,
            labelHint: t("offlineProvisionalHint"),
            kind: "local" as const,
          }
        : null;
    },
    printKitchen: (operationIds: string[]) => print(operationIds, null),
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
