import { RefreshCw, Wifi, WifiOff } from "lucide-react";
import type { Locale } from "../../../shared/domain";
import { useConnectivity } from "../../connectivity";
import { translator } from "./format";
import "./offline.css";

/**
 * Connection state as icon + text at every width (FOH-15: never colour
 * alone). The status dot is decorative.
 */
export function ConnectionPill({
  locale,
  queued,
  syncing = false,
  onOpen,
}: {
  locale: Locale;
  queued: number;
  syncing?: boolean;
  onOpen: () => void;
}) {
  const net = useConnectivity();
  const t = translator(locale);
  const label = net.manual
    ? t("offlineStatusManual")
    : !net.serverReachable
      ? t("offlineStatusOffline")
      : net.slow
        ? t("offlineStatusSlow")
        : t("offlineStatusOnline");
  const count = queued > 0 ? t("offlineQueuedCount", { n: queued }) : "";
  const warning = !net.canUseServer || net.slow;
  const Icon =
    syncing && net.serverReachable
      ? RefreshCw
      : warning && !net.slow
        ? WifiOff
        : Wifi;
  return (
    <button
      className={`connection ${warning ? "warning" : ""}`}
      aria-label={count ? `${label} · ${count}` : label}
      onClick={onOpen}
    >
      <span className="status-dot" aria-hidden="true" />
      <Icon size={16} aria-hidden="true" />
      <span className="connection-label">{label}</span>
      {queued > 0 && (
        <span className="connection-count">
          <span className="connection-count-separator"> · </span>
          {queued}
          <span className="connection-count-unit">
            {" "}
            {t("offlineQueuedCount", { n: "" }).trim()}
          </span>
        </span>
      )}
    </button>
  );
}
