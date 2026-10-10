// Payments (037): the payment dialog's options (terminals, platforms, this
// device's default terminal), cached per tenant and device for offline use
// (spec §6: never secrets, and fees only when a manager fetched them).
import { useEffect, useState } from "react";
import type { Session } from "../../../shared/domain";
import type { PaymentOptions } from "../../../shared/payments";
import { api } from "../../api";
import { db } from "../../offline";

export const EMPTY_PAYMENT_OPTIONS: PaymentOptions = {
  terminals: [],
  platforms: [],
  defaultTerminalId: null,
  integratedAvailable: false,
};
const key = (s: Pick<Session, "tenantId" | "deviceId">) =>
  `payments-options:${s.tenantId}:${s.deviceId}`;

/**
 * GET /payments/options is for operators (server permit, P1 §6). A kitchen display mounts Vender
 * hidden, so it never asks: a 403 there is a console error on every KDS sign-in (restaurant-day G4).
 */
export const readsPaymentOptions = (role: string) => role !== "kitchen";
/**
 * The terminal-charge reads are for operators too (server permit, P2 §5.1: GET
 * /payments/terminal/active, /payments/terminal/charges/:id and its sync). Vender's «Cobros en
 * terminal en curso» and a resumed charge never ask on a kitchen display, for the same reason.
 */
export const readsTerminalCharges = (role: string) => role !== "kitchen";
/**
 * Whether «Cobros en terminal en curso» keeps polling GET /payments/terminal/active every 10 s
 * (P2V-GATE-8): an operator online, after a first look on every mount, only while this restaurant
 * can charge through a provider or this device knows of a charge (listed, remembered from an
 * earlier list, or its own live one). With integrated charging off (PAYMENTS_PROVIDERS unset) no
 * new charge can start, so idle Vender and Órdenes screens stop asking.
 */
export function pollsActiveCharges(o: {
  role: string;
  online: boolean;
  /** The first answer since this list mounted arrived. */
  checked: boolean;
  integratedAvailable: boolean;
  /** Charges shown now, remembered from the last list, and this device's own live one. */
  shown: number;
  remembered: number;
  ownLive: boolean;
}): boolean {
  if (!o.online || !readsTerminalCharges(o.role)) return false;
  return (
    !o.checked ||
    o.integratedAvailable ||
    o.shown > 0 ||
    o.remembered > 0 ||
    o.ownLive
  );
}

/** The last good GET /payments/options; empty until the first answer. */
export function usePaymentOptions(
  session: Pick<Session, "tenantId" | "deviceId" | "role">,
  online: boolean,
  refresh = 0,
): PaymentOptions {
  const [options, setOptions] = useState<PaymentOptions>(EMPTY_PAYMENT_OPTIONS);
  useEffect(() => {
    let live = true;
    void db.cache
      .get(key(session))
      .then((row) => {
        if (live && row?.value) setOptions(row.value as PaymentOptions);
      })
      .catch(() => {});
    if (online && readsPaymentOptions(session.role))
      void api<PaymentOptions>("/payments/options")
        .then(async (fresh) => {
          if (!live) return;
          setOptions(fresh);
          // Staff never cache fees: the server strips them for non-managers.
          await db.cache
            .put({ id: key(session), value: fresh })
            .catch(() => {});
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [session.tenantId, session.deviceId, session.role, online, refresh]);
  return options;
}
