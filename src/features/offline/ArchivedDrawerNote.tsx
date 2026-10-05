import { liveQuery } from "dexie";
import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { db } from "../../offline";
import { archivedDrawerAmounts, translator } from "./format";

/**
 * Shown in drawer close when this device archived local sales of that drawer
 * (§2.8): the cash that may show up as an overage, and apart, terminal
 * payments, which never affect the cash count.
 */
export function ArchivedDrawerNote({
  session,
  drawerId,
  locale,
  money,
}: {
  session: Session;
  drawerId: string | null | undefined;
  locale: Locale;
  money: (minor: number) => string;
}) {
  const t = translator(locale);
  const [amounts, setAmounts] = useState({ cash: 0, terminal: 0 });
  useEffect(() => {
    if (!drawerId) return;
    const prefix = `${session.tenantId}:${session.deviceId}:`;
    const subscription = liveQuery(async () =>
      archivedDrawerAmounts(
        await db.pending.where("status").equals("archived").toArray(),
        prefix,
        drawerId,
      ),
    ).subscribe({ next: setAmounts, error: () => {} });
    return () => subscription.unsubscribe();
  }, [drawerId, session.tenantId, session.deviceId]);
  if (!amounts.cash && !amounts.terminal) return null;
  return (
    <p className="warning-panel" role="status">
      {amounts.cash > 0 &&
        t("offlineArchivedDrawerNote", { amount: money(amounts.cash) })}
      {amounts.cash > 0 && amounts.terminal > 0 ? " " : ""}
      {amounts.terminal > 0 &&
        t("offlineArchivedDrawerTerminal", { amount: money(amounts.terminal) })}
    </p>
  );
}
