// "Sugerir con este producto" (039, §2.8): up to 4 products the kiosk offers as "Combínalo con…"
// on this product's sheet. Its own save (the set is replaced by UPDATE, versioned).
import { useEffect, useState } from "react";
import type { Locale, Product } from "../../../shared/domain";
import { KIOSK_LIMITS } from "../../../shared/kiosk";
import { strings, translateError } from "../../i18n";
import { api } from "../../api";
import { Button } from "../../components/ui";

type Sets = {
  byProduct: Record<string, { productIds: string[]; version: number }>;
};

export function ProductSuggestionsField({
  productId,
  products,
  locale,
  disabled,
}: {
  productId: string;
  products: Product[];
  locale: Locale;
  disabled: boolean;
}) {
  const t = strings[locale];
  const [ids, setIds] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    api<Sets>("/kiosk/suggestions")
      .then((r) => {
        const own = r.byProduct[productId];
        setIds(own?.productIds ?? []);
        setVersion(own?.version ?? 0);
      })
      .catch(() => {});
  }, [productId]);
  const options = products.filter(
    (p) => p.id !== productId && !p.archived && !p.openAmount,
  );
  async function save() {
    setBusy(true);
    setMessage("");
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
      setMessage(t.kioskSaved);
    } catch (e) {
      setMessage(translateError((e as Error).message, locale));
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
