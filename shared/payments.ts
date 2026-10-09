/**
 * ===========================================================================================
 * STUB — track/loyalty only (Wave 4 critic, specs/wave4-cross-track.md §2 and R15/R18).
 * Payments P1 (track/payments, migration 037) owns shared/payments.ts. When P1 merges, ITS file
 * replaces this one whole; nothing else in this file is loyalty's. Loyalty codes against these two
 * P1 symbols only:
 *   - TENDER_METHODS (R15): the tender method values; loyalty's stamp base excludes "platform".
 *   - OnPaymentSettled (R18): the type of Selling's single "payment settled" exit, which P1
 *     introduces; until then Selling takes a no-op `onPaymentSettled` prop (paymentSettledNoop).
 * ===========================================================================================
 */
import type { Order } from "./domain.js";

export const TENDER_METHODS = ["cash", "external", "platform"] as const;
export type TenderMethod = (typeof TENDER_METHODS)[number];

/** R18: called once a payment on Vender settled online, for every method. */
export type OnPaymentSettled = (order: Order) => void;
export const paymentSettledNoop: OnPaymentSettled = () => {};
