import { useEffect, useRef } from "react";
import type { Label, Locale, Product } from "../../../shared/domain";
import { translateError } from "../../i18n";
import { Button } from "../../components/ui";
import type { CartLine } from "./cart";
import { translator } from "./format";
import "./cart-lines.css";

/**
 * Cart lines that no longer price after a catalog refresh (an 86'd or
 * archived product, a choice that changed), each with "Quitar", so the
 * person sees exactly which line blocks sending. Used by the POS cart until
 * service's CartLine replaces it at merge, and by QR/kiosk ordering.
 */
export function UnavailableLines({
  lines,
  catalog,
  locale,
  onRemove,
}: {
  lines: CartLine[];
  catalog: Product[];
  locale: Locale;
  onRemove: (lineId: string) => void;
}) {
  const t = translator(locale);
  // An archived product leaves the catalog; keep the name it was added with.
  const names = useRef(new Map<string, Label>());
  useEffect(() => {
    for (const l of lines)
      if (l.priced) names.current.set(l.input.id, l.priced.name);
  });
  return (
    <>
      {lines
        .filter((l) => l.error)
        .map((l) => {
          const label = catalog.find((p) => p.id === l.input.productId)?.name ??
            names.current.get(l.input.id) ?? { es: "—", en: "—" };
          const name = label[locale];
          const message =
            l.error === "unavailable"
              ? t("menuLineUnavailable")
              : l.error === "invalid_modifier" ||
                  l.error === "required_modifier"
                ? t("menuLineChoicesChanged")
                : translateError(l.error!, locale);
          return (
            <div
              className="order-line line-unavailable"
              key={l.input.id}
              data-line-id={l.input.id}
            >
              <div>
                <strong>{name}</strong>
                <p className="error" role="alert">
                  {message}
                </p>
              </div>
              <Button
                aria-label={`${t("remove")} ${name}`}
                onClick={() => onRemove(l.input.id)}
              >
                {t("remove")}
              </Button>
            </div>
          );
        })}
    </>
  );
}
