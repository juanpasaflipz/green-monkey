import { useEffect, useRef, useState } from "react";
import type { Locale, Session } from "../../../shared/domain";
import { useConnectivity } from "../../connectivity";
import { Badge } from "../../components/ui";
import { translateError } from "../../i18n";
import {
  refreshOfflineSettings,
  saveOfflineSettings,
  useOfflineTableService,
} from "../../offline-settings";
import { translator } from "./format";

/**
 * LD-7: offline table service is a per-restaurant beta, off by default. Owners
 * and managers turn it on or off here (the server also requires a recent
 * authentication once access merges); everyone else sees nothing.
 */
export function OfflineTableServiceSetting({
  session,
  locale,
}: {
  session: Session;
  locale: Locale;
}) {
  const t = translator(locale);
  const net = useConnectivity();
  const on = useOfflineTableService(session);
  const [busy, setBusy] = useState(false);
  /** The value being saved, shown at once; the server's answer replaces it. */
  const [saving, setSaving] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  // One operationId per intended change; a retry of the same change reuses it.
  const pending = useRef<{ value: boolean; operationId: string } | null>(null);
  const manager = ["owner", "manager"].includes(session.role);
  useEffect(() => {
    if (manager && net.canUseServer)
      void refreshOfflineSettings(session).catch(() => {});
  }, [manager, net.canUseServer, session.id]);
  if (!manager) return null;
  async function change(value: boolean) {
    if (pending.current?.value !== value)
      pending.current = { value, operationId: crypto.randomUUID() };
    setBusy(true);
    setSaving(value);
    setError("");
    try {
      await saveOfflineSettings(session, value, pending.current.operationId);
      pending.current = null;
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    } finally {
      setSaving(null);
      setBusy(false);
    }
  }
  return (
    <fieldset className="offline-table-service">
      <legend>
        {t("offlineTableServiceTitle")}{" "}
        <Badge tone="amber">{t("offlineTableServiceBeta")}</Badge>
      </legend>
      <p className="muted tiny">{t("offlineTableServiceHint")}</p>
      <label className="row">
        <input
          type="checkbox"
          role="switch"
          checked={saving ?? on}
          disabled={busy || !net.canUseServer}
          onChange={(e) => void change(e.target.checked)}
        />
        {t("offlineTableServiceOn")}
      </label>
      {!net.canUseServer && (
        <p className="muted tiny">{t("offlineTableServiceUnknown")}</p>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
