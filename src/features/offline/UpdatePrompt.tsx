import { useEffect, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { db, liveRead } from "../../offline";
import { isResolved } from "../../offline-queue";
import { applyUpdate, onUpdateReady } from "../../service-worker";
import { Button } from "../../components/ui";
import { translator } from "./format";
import "./offline.css";

/**
 * True when this device holds unresolved records or a payment in flight (an
 * active attempt) for the tenant (spec §2.9). A parked attempt waits for a
 * manager on the Sync screen and survives the update unchanged, so it never
 * blocks it (OFFLINE-RECOVERY-05).
 */
export async function hasUnsyncedWork(session: Session) {
  const prefix = `${session.tenantId}:${session.deviceId}:`;
  const rows = await db.pending
    .filter((row) => row.scope.startsWith(prefix) && !isResolved(row))
    .count();
  const attempts = await db.cache
    .filter((row) => row.id.startsWith(prefix) && /:payment$/.test(row.id))
    .count();
  return rows + attempts > 0;
}

/** "A new version is ready" bar (OFF-10). Applies only with nothing unsynced. */
export function UpdatePrompt({
  locale,
  session,
}: {
  locale: Locale;
  session: Session;
}) {
  const t = translator(locale);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => onUpdateReady(setReady), []);
  useEffect(() => {
    if (!ready) return;
    // Two unindexed scans: liveRead's catch-up read covers a record saved or
    // synced while the first one runs, which liveQuery alone would miss.
    return liveRead(
      () => hasUnsyncedWork(session),
      setBlocked,
      () => setBlocked(true),
    );
  }, [ready, session.tenantId, session.deviceId]);
  if (!ready) return null;
  return (
    <div className="update-bar" role="status">
      <p>
        {t("offlineUpdateReady")}
        {blocked ? ` ${t("offlineUpdateBlocked")}` : ""}
      </p>
      <Button
        variant="primary"
        disabled={blocked || busy}
        onClick={() => {
          setBusy(true);
          void applyUpdate(async () => !(await hasUnsyncedWork(session))).then(
            (outcome) => {
              if (outcome === "blocked") setBlocked(true);
              setBusy(false);
            },
          );
        }}
      >
        {t("offlineUpdateApply")}
      </Button>
    </div>
  );
}
