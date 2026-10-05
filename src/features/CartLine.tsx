import { useEffect, useId, useRef, useState } from "react";
import { Minus, Plus, MessageSquareText } from "lucide-react";
import type { Label, Locale, Product } from "../../shared/domain";
import type { CartLine as PricedCartLine } from "../../shared/service";
import { strings, translateError, type Key } from "../i18n";
import { Button } from "../components/ui";

const PRESETS: Key[] = [
  "serviceNoteNoOnion",
  "serviceNoteNoChili",
  "serviceNoteNoCilantro",
  "serviceNoteSauceSide",
  "serviceNoteAllergy",
];
const NOTE_MAX = 300;

/** Appends a preset to a note, separated by ", ", within the length limit. */
export function appendPreset(note: string, preset: string) {
  const base = note.trim().replace(/,\s*$/, "");
  return (base ? `${base}, ${preset}` : preset).slice(0, NOTE_MAX);
}

/**
 * One draft line: modifiers, kitchen note editor, quantity, or an inline error.
 * A `locked` line belongs to a send that has not answered yet (SVC-R7): it
 * shows "Enviando a cocina…" and cannot be edited until the send settles.
 */
export function CartLine({
  line,
  product,
  fallbackName,
  locale,
  money,
  justAdded,
  locked = false,
  onQuantity,
  onRemove,
  onNote,
}: {
  line: PricedCartLine;
  product?: Product;
  fallbackName?: Label;
  locale: Locale;
  money: (n: number) => string;
  justAdded: boolean;
  locked?: boolean;
  onQuantity: (delta: 1 | -1) => void;
  onRemove: () => void;
  onNote: (note: string) => void;
}) {
  const t = (k: Key) => strings[locale][k];
  const ref = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const noteId = useId();
  const label = line.priced?.name ??
    product?.name ??
    fallbackName ?? { es: "—", en: "—" };
  const name = label[locale];
  useEffect(() => {
    if (justAdded) ref.current?.scrollIntoView({ block: "nearest" });
  }, [justAdded]);
  if (line.error)
    return (
      <div
        className="order-line line-error"
        ref={ref}
        data-line-id={line.input.id}
      >
        <div>
          <strong>{name}</strong>
          <p className="error" role="alert">
            {line.error === "invalid_modifier" ||
            line.error === "required_modifier"
              ? translateError(line.error, locale)
              : t("serviceLineUnavailable")}
          </p>
        </div>
        <Button disabled={locked} onClick={onRemove}>
          {t("remove")}
        </Button>
      </div>
    );
  const priced = line.priced!;
  const note = line.input.note ?? "";
  return (
    <div
      className={
        "order-line" +
        (justAdded ? " just-added" : "") +
        (locked ? " sending" : "")
      }
      ref={ref}
      data-line-id={line.input.id}
      aria-busy={locked || undefined}
    >
      <div className="order-line-main">
        <strong>{name}</strong>
        {priced.optionNames.map((o, i) => (
          <p className="line-option" key={i}>
            + {o[locale]}
          </p>
        ))}
        {note && (!editing || locked) && <p className="line-note">{note}</p>}
        {locked && (
          <p className="line-sending muted tiny">{t("serviceLineSending")}</p>
        )}
        <div className="line-controls">
          <div className="quantity">
            <button
              type="button"
              aria-label={`${t("quantity")} − ${name}`}
              disabled={locked}
              onClick={() => onQuantity(-1)}
            >
              <Minus size={14} />
            </button>
            <span>{priced.quantity}</span>
            <button
              type="button"
              aria-label={`${t("quantity")} + ${name}`}
              disabled={locked}
              onClick={() => onQuantity(1)}
            >
              <Plus size={14} />
            </button>
          </div>
          <button
            type="button"
            className={"line-note-toggle" + (note ? " has-note" : "")}
            aria-label={t("serviceLineNoteAdd").replace("{item}", name)}
            aria-expanded={editing && !locked}
            aria-controls={noteId}
            disabled={locked}
            onClick={() => setEditing((v) => !v)}
          >
            <MessageSquareText size={18} />
          </button>
        </div>
        {editing && !locked && (
          <div className="line-note-editor" id={noteId}>
            <label className="field">
              <span>{t("serviceLineNote")}</span>
              <textarea
                ref={noteRef}
                value={note}
                maxLength={NOTE_MAX}
                rows={2}
                onChange={(e) => onNote(e.target.value)}
              />
            </label>
            <div className="note-chips">
              {PRESETS.map((key) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => {
                    const preset =
                      key === "serviceNoteAllergy" ? t(key) + " " : t(key);
                    const next = appendPreset(note, preset);
                    onNote(next);
                    if (key === "serviceNoteAllergy")
                      requestAnimationFrame(() => {
                        const el = noteRef.current;
                        if (!el) return;
                        el.focus();
                        el.setSelectionRange(next.length, next.length);
                      });
                  }}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            <Button onClick={() => setEditing(false)}>
              {t("serviceLineNoteDone")}
            </Button>
          </div>
        )}
      </div>
      <strong>{money(priced.total)}</strong>
    </div>
  );
}
