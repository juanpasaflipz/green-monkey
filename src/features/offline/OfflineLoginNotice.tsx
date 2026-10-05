import { liveQuery } from "dexie";
import { useEffect, useState } from "react";
import type { Locale } from "../../../shared/domain";
import { setWorkOffline, useConnectivity } from "../../connectivity";
import { db } from "../../offline";
import { isResolved } from "../../offline-queue";
import {
  backupFileName,
  buildBackups,
  downloadJson,
} from "../../offline-backup";
import { Button } from "../../components/ui";
import { translator } from "./format";

/**
 * Login-screen notice (§2.2): signing in needs the server, and unsynced records
 * on this device can be downloaded without a session. A device left in manual
 * offline mode says so and can leave it here (OFF-R16): signing in works in
 * that mode, but nobody should have to look for the switch to sell online.
 */
export function OfflineLoginNotice({ locale }: { locale: Locale }) {
  const t = translator(locale);
  const net = useConnectivity();
  const [unsynced, setUnsynced] = useState(0);
  useEffect(() => {
    const subscription = liveQuery(() =>
      db.pending.filter((row) => !isResolved(row)).count(),
    ).subscribe({ next: setUnsynced, error: () => {} });
    return () => subscription.unsubscribe();
  }, []);
  if (net.canUseServer && !unsynced) return null;
  return (
    <div className="warning-panel" role="status">
      {!net.serverReachable && <p>{t("offlineLoginNoServer")}</p>}
      {net.manual && (
        <>
          <p>{t("offlineLoginManual")}</p>
          <Button onClick={() => setWorkOffline(false)}>
            {t("offlineGoOnline")}
          </Button>
        </>
      )}
      {unsynced > 0 && (
        <>
          <p>{t("offlineLoginPending", { n: unsynced })}</p>
          <Button
            onClick={() =>
              void buildBackups().then((backups) => {
                for (const backup of backups)
                  downloadJson(backupFileName(backup.tenantId), backup);
              })
            }
          >
            {t("offlineLoginDownload")}
          </Button>
        </>
      )}
    </div>
  );
}
