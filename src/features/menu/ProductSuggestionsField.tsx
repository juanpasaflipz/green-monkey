// "Sugerir con este producto" (039, §2.8): up to 4 products the kiosk offers as "Combínalo con…"
// on this product's sheet. Its own save (the set is replaced by UPDATE, versioned); unsaved ticks
// count as the product editor's unsaved edits, and the product's «Guardar» saves them first
// (KIOSK-UX-12).
import { useEffect, useState, type MutableRefObject } from "react";
import type { Locale, Product } from "../../../shared/domain";
import { KIOSK_LIMITS } from "../../../shared/kiosk";
import { strings, translateError } from "../../i18n";
import { api } from "../../api";
import { Button } from "../../components/ui";

type Sets = {
  byProduct: Record<string, { productIds: string[]; version: number }>;
};

/** Ticks differ from the saved set (order counts: the sheet shows them in this order). */
export function suggestionsDirty(ids: string[], saved: string[]): boolean {
  return ids.length !== saved.length || ids.some((id, i) => id !== saved[i]);
}

export function ProductSuggestionsField({
  productId,
  products,
  locale,
  disabled,
  onDirtyChange,
  saveRef,
}: {
  productId: string;
  products: Product[];
  locale: Locale;
  disabled: boolean;
  /** Called when the ticks start or stop differing from the saved set. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Set to this field's save, which resolves false when it failed (its message says why). */
  saveRef?: MutableRefObject<(() => Promise<boolean>) | null>;
}) {
  const t = strings[locale];
  const [ids, setIds] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    api<Sets>("/kiosk/suggestions")
      .then((r) => {
        const own = r.byProduct[productId];
        setIds(own?.productIds ?? []);
        setSaved(own?.productIds ?? []);
        setVersion(own?.version ?? 0);
      })
      .catch(() => {});
  }, [productId]);
  const options = products.filter(
    (p) => p.id !== productId && !p.archived && !p.openAmount,
  );
  const dirty = suggestionsDirty(ids, saved);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty]);
  useEffect(() => {
    if (saveRef) saveRef.current = save;
  });
  async function save(): Promise<boolean> {
    setBusy(true);
    setMessage("");
    const sent = ids;
    try {
      const r = await api<{ version: number }>(
        `/menu/products/${productId}/suggestions`,
        {
          operationId: crypto.randomUUID(),
          expectedVersion: version,
          productIds: ids,
        },
      );
      setVersion(r.version);
      setSaved(sent);
      setMessage(t.kioskSaved);
      return true;
    } catch (e) {
      setMessage(translateError((e as Error).message, locale));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="menu-suggestions">
      <legend>{t.menuSuggestWith}</legend>
      <p className="muted">{t.menuSuggestHint}</p>
      <div className="menu-suggestion-options">
        {options.map((p) => (
          <label className="option" key={p.id}>
            <input
              type="checkbox"
              checked={ids.includes(p.id)}
              disabled={
                disabled ||
                busy ||
                (!ids.includes(p.id) &&
                  ids.length >= KIOSK_LIMITS.productSuggestions)
              }
              onChange={(e) =>
                setIds(
                  e.target.checked
                    ? [...ids, p.id]
                    : ids.filter((x) => x !== p.id),
                )
              }
            />
            <span>{p.name[locale]}</span>
          </label>
        ))}
      </div>
      <Button disabled={disabled || busy} onClick={() => void save()}>
        {t.menuSuggestSave}
      </Button>
      {message && <p role="status">{message}</p>}
    </fieldset>
  );
}
