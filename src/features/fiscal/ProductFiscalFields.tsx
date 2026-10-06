// The "Impuestos" section of menu's product editor (ProductEditor.renderFiscal slot): the
// product's tax category and optional SAT keys. Fully controlled; the server validates the
// same strict schema (productFiscalInput) and refuses IVA 8% outside a border region.
import { useEffect, useId } from "react";
import type { Locale } from "../../../shared/domain";
import {
  allowedCategories,
  defaultProductFiscal,
  productFiscalInput,
  SAT_DEFAULT_PRODUCT_KEY,
  SAT_DEFAULT_UNIT_KEY,
  TAX_CATEGORIES,
  type ProductFiscal,
} from "../../../shared/tax";
import { strings, translateError } from "../../i18n";
import { ensureFiscalContext, useFiscalContext } from "./context";
import { categoryLabel, fill } from "./format";

/** A stored product's fiscal value, or the default ("Predeterminado del restaurante"). */
export function toProductFiscal(value: unknown): ProductFiscal {
  const parsed = productFiscalInput.safeParse(value ?? {});
  return parsed.success ? parsed.data : defaultProductFiscal();
}

/**
 * The editor's working copy: like toProductFiscal, but text the user typed into a SAT key is
 * kept even while it is invalid, so the field never resets under the cursor.
 */
export function fiscalDraft(value: unknown): ProductFiscal {
  const parsed = productFiscalInput.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const raw = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  const category = raw.taxCategory;
  return {
    taxCategory:
      category === "default" ||
      (TAX_CATEGORIES as readonly unknown[]).includes(category)
        ? (category as ProductFiscal["taxCategory"])
        : "default",
    satProductKey: text(raw.satProductKey),
    satUnitKey: text(raw.satUnitKey),
  };
}

export function ProductFiscalFields({
  value,
  onChange,
  locale,
  disabled = false,
}: {
  value: ProductFiscal;
  onChange: (v: ProductFiscal) => void;
  locale: Locale;
  disabled?: boolean;
}) {
  const t = strings[locale];
  const context = useFiscalContext();
  const id = useId();
  useEffect(() => ensureFiscalContext(), []);
  const region = context?.taxRegion ?? "general";
  const iva8Allowed = allowedCategories(region).includes("iva8");
  const defaultCategory = context?.defaultTaxCategory ?? "iva16";
  const invalid = !productFiscalInput.safeParse(value).success;
  return (
    <div className="fiscal-product-fields">
      <label className="field">
        <span>{t.fiscalProductTax}</span>
        <select
          value={value.taxCategory}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(e) =>
            onChange({
              ...value,
              taxCategory: e.target.value as ProductFiscal["taxCategory"],
            })
          }
        >
          <option value="default">
            {fill(t.fiscalCategoryDefault, {
              category: categoryLabel(defaultCategory, locale),
            })}
          </option>
          {TAX_CATEGORIES.map((category) => (
            <option
              key={category}
              value={category}
              disabled={category === "iva8" && !iva8Allowed}
            >
              {categoryLabel(category, locale)}
            </option>
          ))}
        </select>
      </label>
      <p className="muted tiny fiscal-field-hint" id={`${id}-hint`}>
        {t.fiscalProductTaxHint}
        {!iva8Allowed && <> {t.fiscalProductIva8Disabled}</>}
      </p>
      <details>
        <summary>{t.fiscalProductSatKeys}</summary>
        <label className="field">
          <span>{t.fiscalProductKey}</span>
          <input
            inputMode="numeric"
            pattern="\d{8}"
            maxLength={8}
            placeholder={SAT_DEFAULT_PRODUCT_KEY}
            value={value.satProductKey ?? ""}
            disabled={disabled}
            aria-describedby={`${id}-product`}
            aria-invalid={invalid || undefined}
            onChange={(e) =>
              onChange({
                ...value,
                satProductKey: e.target.value.trim() || null,
              })
            }
          />
        </label>
        <p className="muted tiny fiscal-field-hint" id={`${id}-product`}>
          {fill(t.fiscalProductKeyHint, { key: SAT_DEFAULT_PRODUCT_KEY })}
        </p>
        <label className="field">
          <span>{t.fiscalUnitKey}</span>
          <input
            pattern="[A-Z0-9]{1,3}"
            maxLength={3}
            autoCapitalize="characters"
            placeholder={SAT_DEFAULT_UNIT_KEY}
            value={value.satUnitKey ?? ""}
            disabled={disabled}
            aria-describedby={`${id}-unit`}
            aria-invalid={invalid || undefined}
            onChange={(e) =>
              onChange({
                ...value,
                satUnitKey: e.target.value.trim().toUpperCase() || null,
              })
            }
          />
        </label>
        <p className="muted tiny fiscal-field-hint" id={`${id}-unit`}>
          {fill(t.fiscalUnitKeyHint, { key: SAT_DEFAULT_UNIT_KEY })}
        </p>
      </details>
      {invalid && (
        <p className="error tiny" role="alert">
          {translateError("fiscal_invalid_sat_key", locale)}
        </p>
      )}
    </div>
  );
}
