import type { Locale } from "../../../shared/domain";
import type { TerminalOption, TerminalStatus } from "../../../shared/payments";
import { strings, type Key } from "../../i18n";

const STATUS_KEYS: Record<TerminalStatus, Key> = {
  online: "payTerminalOnline",
  offline: "payTerminalOffline",
  no_data: "payTerminalNoData",
};

/**
 * Payments (037): the terminal of a card payment. Integrated terminals first, with their
 * connectivity ("Conectada", "Sin conexión", "Sin datos" from the provider's last device report;
 * "solo manual" when integrated charging is off or the device is offline), then manual ones,
 * then "Otra terminal" (no terminal named).
 */
export function TerminalPicker({
  terminals,
  value,
  chosen = true,
  defaultTerminalId = null,
  onChange,
  useAsDefault,
  onUseAsDefault,
  canSetDefault,
  locale,
  disabled,
  describedBy,
  online = true,
}: {
  terminals: TerminalOption[];
  /** null = "Otra terminal". */
  value: string | null;
  /** False while nothing is chosen (PAYMENTS-UX-4): no chip is pressed. */
  chosen?: boolean;
  /** This device's default terminal: its checkbox reads checked (PAYMENTS-UX-14). */
  defaultTerminalId?: string | null;
  /** The id of the "Elige la terminal" problem, when shown. */
  describedBy?: string;
  onChange: (terminalId: string | null) => void;
  useAsDefault: boolean;
  onUseAsDefault: (on: boolean) => void;
  canSetDefault: boolean;
  locale: Locale;
  disabled?: boolean;
  /** Offline, an integrated terminal can only be recorded manually. */
  online?: boolean;
}) {
  const t = (k: Key) => strings[locale][k];
  if (!terminals.length) return null;
  const chip = (id: string | null, label: string, hint?: string) => (
    <button
      key={id ?? "other"}
      type="button"
      disabled={disabled}
      aria-pressed={chosen && value === id}
      className={chosen && value === id ? "selected" : ""}
      onClick={() => onChange(id)}
    >
      {label}
      {hint ? <small> · {hint}</small> : null}
    </button>
  );
  return (
    <fieldset className="pay-terminals">
      <legend>{t("payTerminal")}</legend>
      <div
        className="service-tabs wrap"
        role="group"
        aria-label={t("payTerminal")}
        aria-describedby={describedBy}
      >
        {[...terminals]
          .sort(
            (a, b) =>
              Number(b.integrated && online) - Number(a.integrated && online),
          )
          .map((terminal) =>
            chip(
              terminal.id,
              terminal.name,
              terminal.kind === "manual"
                ? undefined
                : !terminal.integrated || !online
                  ? t("payTerminalManualOnly")
                  : t(STATUS_KEYS[terminal.status ?? "no_data"]),
            ),
          )}
        {chip(null, t("payOtherTerminal"))}
      </div>
      {canSetDefault && value && value === defaultTerminalId && (
        <p className="muted tiny">{t("payDefaultTerminalIs")}</p>
      )}
      {canSetDefault && value && value !== defaultTerminalId && (
        <label className="option">
          <input
            type="checkbox"
            disabled={disabled}
            checked={useAsDefault}
            onChange={(e) => onUseAsDefault(e.target.checked)}
          />
          {t("payUseAsDefault")}
        </label>
      )}
    </fieldset>
  );
}
