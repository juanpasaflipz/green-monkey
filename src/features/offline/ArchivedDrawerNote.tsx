import { liveQuery } from "dexie";
import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { recordAmounts } from "../../../shared/offline-recovery";
import { db } from "../../offline";
import { translator } from "./format";

/** Shown in drawer close when this device archived local sales of that drawer (§2.8). */
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
  const [amount, setAmount] = useState(0);
  useEffect(() => {
    if (!drawerId) return;
    const prefix = `${session.tenantId}:${session.deviceId}:`;
    const subscription = liveQuery(async () =>
      (await db.pending.where("status").equals("archived").toArray())
        .filter(
          (row) =>
            row.scope.startsWith(prefix) &&
            (row.body as { cashSessionId?: string | null }).cashSessionId === drawerId,
        )
        .reduce((total, row) => {
          const { amount: collected, tip } = recordAmounts(row.body);
          return total + collected + tip;
        }, 0),
    ).subscribe({ next: setAmount, error: () => {} });
    return () => subscription.unsubscribe();
  }, [drawerId, session.tenantId, session.deviceId]);
  if (!amount) return null;
  return (
    <p className="warning-panel" role="status">
      {t("offlineArchivedDrawerNote", { amount: money(amount) })}
    </p>
  );
}
