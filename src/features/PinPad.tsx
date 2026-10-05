import { useEffect, useId, useRef, useState } from "react";
import { Delete } from "lucide-react";
import type { Locale } from "../../shared/domain";
import { strings } from "../i18n";
import { Button } from "../components/ui";
import "../access/access.css";

export function lockTime(iso: string, locale: Locale) {
  return new Date(iso).toLocaleTimeString(locale === "es" ? "es-MX" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Masked PIN entry with an on-screen keypad (a physical keyboard also works).
 * "Usar contraseña" switches to a text password for legacy owner passwords.
 */
export function PinPad({
  employee,
  locale,
  busy = false,
  error = "",
  lockedUntil = null,
  hardLocked = false,
  submitLabel,
  allowPassword = true,
  onSubmit,
}: {
  employee: { name: string };
  locale: Locale;
  busy?: boolean;
  error?: string;
  lockedUntil?: string | null;
  hardLocked?: boolean;
  submitLabel?: string;
  allowPassword?: boolean;
  onSubmit: (secret: string) => Promise<void> | void;
}) {
  const t = strings[locale];
  const [value, setValue] = useState("");
  const [password, setPassword] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const locked =
    hardLocked ||
    (lockedUntil !== null && new Date(lockedUntil).getTime() > Date.now());
  const disabled = busy || locked;
  // A rejected PIN is never left in the field.
  useEffect(() => {
    if (error) setValue("");
  }, [error]);
  useEffect(() => {
    if (!disabled) input.current?.focus();
  }, [disabled, password]);
  const press = (digit: string) => {
    setValue((v) => (v.length < 8 ? v + digit : v));
    input.current?.focus();
  };
  return (
    <form
      className="pin-pad"
      onSubmit={async (e) => {
        e.preventDefault();
        if (disabled || value.length < 4) return;
        const secret = value;
        setValue("");
        await onSubmit(secret);
      }}
    >
      <label className="field">
        <span>
          {password ? t.secret : t.accessPinFor.replace("{name}", employee.name)}
        </span>
        <input
          ref={input}
          name="secret"
          type="password"
          inputMode={password ? "text" : "numeric"}
          autoComplete="off"
          maxLength={password ? 200 : 8}
          value={value}
          disabled={disabled}
          aria-describedby={locked || error ? hintId : undefined}
          onChange={(e) =>
            setValue(
              password ? e.target.value : e.target.value.replace(/\D/g, ""),
            )
          }
        />
      </label>
      {(locked || error) && (
        <p id={hintId} role="alert" className="error">
          {hardLocked
            ? t.accessHardLocked
            : locked
              ? t.accessLockedUntil.replace(
                  "{time}",
                  lockTime(lockedUntil!, locale),
                )
              : error}
        </p>
      )}
      {!password && (
        <div className="keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <Button key={d} disabled={disabled} onClick={() => press(d)}>
              {d}
            </Button>
          ))}
          <Button
            aria-label={t.accessDeleteDigit}
            disabled={disabled}
            onClick={() => {
              setValue((v) => v.slice(0, -1));
              input.current?.focus();
            }}
          >
            <Delete size={20} aria-hidden="true" />
          </Button>
          <Button disabled={disabled} onClick={() => press("0")}>
            0
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={disabled || value.length < 4}
          >
            {submitLabel ?? t.accessSignIn}
          </Button>
        </div>
      )}
      {password && (
        <Button
          type="submit"
          variant="primary"
          className="full"
          disabled={disabled || value.length < 4}
        >
          {submitLabel ?? t.accessSignIn}
        </Button>
      )}
      {allowPassword && (
        <Button
          variant="ghost"
          className="pin-mode"
          onClick={() => {
            setPassword((p) => !p);
            setValue("");
          }}
        >
          {password ? t.accessUsePin : t.accessUsePassword}
        </Button>
      )}
    </form>
  );
}
