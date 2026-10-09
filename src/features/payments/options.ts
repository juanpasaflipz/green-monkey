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
    if (online)
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
