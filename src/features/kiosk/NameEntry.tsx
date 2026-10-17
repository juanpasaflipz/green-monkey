import { useRef, useState } from "react";
import type { Locale } from "../../../shared/domain";
import { kioskText } from "./text";
export function NameEntry({
  value,
  onChange,
  locale,
}: {
  value: string;
  onChange: (value: string) => void;
  locale: Locale;
}) {
  const t = kioskText[locale],
    ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  function type(text: string, erase = false) {
    const input = ref.current;
    if (!input) return;
    const start = input.selectionStart ?? value.length,
      end = input.selectionEnd ?? start;
    const from = erase && start === end ? Math.max(0, start - 1) : start;
    const next = value.slice(0, from) + text + value.slice(end);
    if (next.length > 40) return;
    onChange(next);
    requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.setSelectionRange(from + text.length, from + text.length);
    });
  }
  return (
    <section className="pickup-name">
      <label htmlFor="kiosk-name">
        {t.nameLabel}
        <span>{t.optional}</span>
      </label>
      <input
        id="kiosk-name"
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={40}
        autoComplete="off"
        inputMode="none"
        placeholder={t.namePlaceholder}
        aria-describedby="kiosk-name-hint"
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
            ref.current?.blur();
          }
        }}
      />
      <p id="kiosk-name-hint">{t.nameHint}</p>
      {open && (
        <div
          role="group"
          aria-label={t.keyboard}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) e.preventDefault();
          }}
        >
          <div className="name-keys">
            {Array.from("QWERTYUIOPASDFGHJKLÑZXCVBNMÁÉÍÓÚÜ").map((letter) => (
              <button
                key={letter}
                type="button"
                onClick={() => {
                  const start = ref.current?.selectionStart ?? value.length;
                  type(
                    start === 0 || value[start - 1] === " "
                      ? letter
                      : letter.toLocaleLowerCase(locale),
                  );
                }}
              >
                {letter}
              </button>
            ))}
          </div>
          <div className="keyboard-actions">
            <button type="button" onClick={() => type(" ")}>
              {t.space}
            </button>
            <button type="button" onClick={() => type("", true)}>
              {t.erase}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                ref.current?.blur();
              }}
            >
              {t.done} ✓
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
