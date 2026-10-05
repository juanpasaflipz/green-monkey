import { useState } from "react";
import { convert, type Locale } from "../../../shared/domain";
import {
  MENU_LIMITS,
  type MenuStockOption,
  type RecipeLine,
} from "../../../shared/menu";
import { Button, Field } from "../../components/ui";
import {
  decimalInput,
  translator,
  trimDecimal,
  type Translate,
} from "./format";

type Row = {
  key: string;
  stockId: string;
  quantity: string;
  entryUnit: string;
};

const sameDimension: Record<string, string[]> = {
  g: ["g", "kg"],
  kg: ["kg", "g"],
  ml: ["ml", "l"],
  l: ["l", "ml"],
  piece: ["piece"],
};
export function unitLabel(unit: string, t: Translate) {
  return unit === "piece" ? t("menuUnitPiece") : unit;
}

/** Converts one row to a recipe line in the stock item's unit, or null. */
function toLine(row: Row, items: MenuStockOption[]): RecipeLine | null {
  const item = items.find((i) => i.id === row.stockId);
  const text = decimalInput(row.quantity);
  if (!item || text === null || !/^\d{1,9}(\.\d{1,6})?$/.test(text))
    return null;
  try {
    const quantity = trimDecimal(convert(text, row.entryUnit, item.unit));
    return /^\d{1,9}(\.\d{1,6})?$/.test(quantity) && Number(quantity) > 0
      ? { stockId: item.id, quantity }
      : null;
  } catch {
    return null;
  }
}

/**
 * Recipe lines with g↔kg and ml↔l entry. Emits lines in each stock item's own
 * unit (6 decimals at most, trailing zeros removed) plus whether every row is
 * complete. Remount it (key) to reset from a new value.
 */
export function RecipeEditor({
  value,
  stockItems,
  locale,
  disabled = false,
  onChange,
}: {
  value: RecipeLine[];
  stockItems: MenuStockOption[];
  locale: Locale;
  disabled?: boolean;
  onChange: (lines: RecipeLine[], valid: boolean) => void;
}) {
  const t = translator(locale);
  const [rows, setRows] = useState<Row[]>(() =>
    value.map((line) => ({
      key: crypto.randomUUID(),
      stockId: line.stockId,
      quantity: trimDecimal(line.quantity),
      entryUnit: stockItems.find((i) => i.id === line.stockId)?.unit ?? "piece",
    })),
  );
  function update(next: Row[]) {
    setRows(next);
    const lines = next.map((r) => toLine(r, stockItems));
    onChange(
      lines.filter((l): l is RecipeLine => l !== null),
      lines.every((l) => l !== null),
    );
  }
  const active = stockItems.filter((i) => !i.archived);
  return (
    <div className="recipe-editor">
      {!active.length && <p className="muted tiny">{t("menuNoStockItems")}</p>}
      {rows.map((row, index) => {
        const n = index + 1;
        const item = stockItems.find((i) => i.id === row.stockId);
        const line = toLine(row, stockItems);
        const units = item
          ? (sameDimension[item.unit] ?? [item.unit])
          : ["piece"];
        return (
          <div className="recipe-row" key={row.key}>
            <Field label={t("menuIngredient", { n })}>
              <select
                value={row.stockId}
                disabled={disabled}
                required
                onChange={(e) => {
                  const next = stockItems.find((i) => i.id === e.target.value);
                  update(
                    rows.map((r) =>
                      r.key === row.key
                        ? {
                            ...r,
                            stockId: e.target.value,
                            entryUnit: next?.unit ?? r.entryUnit,
                          }
                        : r,
                    ),
                  );
                }}
              >
                <option value="">{t("menuChoose")}</option>
                {stockItems
                  .filter((i) => !i.archived || i.id === row.stockId)
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({unitLabel(i.unit, t)})
                      {i.archived ? ` · ${t("menuArchivedBadge")}` : ""}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t("menuQuantity", { n })}>
              <input
                inputMode="decimal"
                autoComplete="off"
                value={row.quantity}
                disabled={disabled}
                aria-invalid={row.stockId && !line ? true : undefined}
                onChange={(e) =>
                  update(
                    rows.map((r) =>
                      r.key === row.key
                        ? { ...r, quantity: e.target.value }
                        : r,
                    ),
                  )
                }
              />
            </Field>
            <Field label={t("menuEntryUnit", { n })}>
              <select
                value={row.entryUnit}
                disabled={disabled || units.length < 2}
                onChange={(e) =>
                  update(
                    rows.map((r) =>
                      r.key === row.key
                        ? { ...r, entryUnit: e.target.value }
                        : r,
                    ),
                  )
                }
              >
                {units.map((u) => (
                  <option key={u} value={u}>
                    {unitLabel(u, t)}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              variant="ghost"
              className="recipe-remove"
              disabled={disabled}
              aria-label={t("menuRemoveIngredient", { n })}
              onClick={() => update(rows.filter((r) => r.key !== row.key))}
            >
              ×
            </Button>
            {item && line && (
              <p className="tiny muted recipe-converted">
                {t("menuConverted", {
                  qty: line.quantity,
                  unit: unitLabel(item.unit, t),
                })}
              </p>
            )}
          </div>
        );
      })}
      <Button
        disabled={
          disabled || rows.length >= MENU_LIMITS.recipeLines || !active.length
        }
        onClick={() =>
          update([
            ...rows,
            {
              key: crypto.randomUUID(),
              stockId: "",
              quantity: "1",
              entryUnit: "piece",
            },
          ])
        }
      >
        {t("menuAddIngredient")}
      </Button>
    </div>
  );
}
