import type { Locale } from "../../../shared/domain";
import type { TerminalOption } from "../../../shared/payments";
import { strings, type Key } from "../../i18n";

/**
 * Payments (037): the named terminal of a card record. Every active terminal
 * is listed (an integrated one taken manually is the documented fallback,
 * "solo manual" until phase P2), then "Otra terminal" (no terminal named).
 */
export function TerminalPicker({
  terminals,
  value,
  onChange,
  useAsDefault,
  onUseAsDefault,
  canSetDefault,
  locale,
  disabled,
}: {
  terminals: TerminalOption[];
  /** null = "Otra terminal". */
  value: string | null;
  onChange: (terminalId: string | null) => void;
  useAsDefault: boolean;
  onUseAsDefault: (on: boolean) => void;
  canSetDefault: boolean;
  locale: Locale;
  disabled?: boolean;
}) {
  const t = (k: Key) => strings[locale][k];
  if (!terminals.length) return null;
  const chip = (id: string | null, label: string, hint?: string) => (
    <button
      key={id ?? "other"}
      type="button"
      disabled={disabled}
      aria-pressed={value === id}
      className={value === id ? "selected" : ""}
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
      >
        {terminals.map((terminal) =>
          chip(
            terminal.id,
            terminal.name,
            terminal.kind !== "manual" && !terminal.integrated
              ? t("payTerminalManualOnly")
              : undefined,
          ),
        )}
        {chip(null, t("payOtherTerminal"))}
      </div>
      {canSetDefault && value && (
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
