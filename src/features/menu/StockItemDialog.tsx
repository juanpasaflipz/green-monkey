import { useState } from "react";
import type { Locale } from "../../../shared/domain";
import type { StockItem } from "../../../shared/menu";
import { stockItemInput, stockUnits } from "../../../shared/menu-schema";
import { api } from "../../api";
import { translateError } from "../../i18n";
import { Button, Field, Modal } from "../../components/ui";
import { decimalInput, translator, trimDecimal } from "./format";
import { unitLabel } from "./RecipeEditor";
import { SavesAsQuantity } from "./SavesAs";
import { useDiscardGuard } from "./ConfirmDialog";

const unitKeys = {
  g: "menuUnitG",
  kg: "menuUnitKg",
  ml: "menuUnitMl",
  l: "menuUnitL",
  piece: "menuUnitPiece",
} as const;

/** Create or edit one stock item (Pro). The unit locks once it is in use. */
export function StockItemDialog({
  item,
  locale,
  online,
  onSaved,
  onClose,
  onReload,
}: {
  item?: StockItem;
  locale: Locale;
  online: boolean;
  onSaved: (item: StockItem) => void;
  onClose: () => void;
  onReload: () => void;
}) {
  const t = translator(locale);
  const [operationId] = useState(() => crypto.randomUUID());
  const [itemId] = useState(() => item?.id ?? crypto.randomUUID());
  const [name, setName] = useState(item?.name ?? "");
  const [unit, setUnit] = useState(item?.unit ?? "kg");
  const [kind, setKind] = useState(item?.kind ?? "raw");
  const [threshold, setThreshold] = useState(
    item ? trimDecimal(item.threshold) : "0",
  );
  const [parLevel, setParLevel] = useState(
    item?.parLevel ? trimDecimal(item.parLevel) : "",
  );
  const [opening, setOpening] = useState("");
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  // Unsaved edits: the form differs from how it opened.
  const snapshot = JSON.stringify([
    name,
    unit,
    kind,
    threshold,
    parLevel,
    opening,
  ]);
  const [opened] = useState(snapshot);
  const discard = useDiscardGuard(snapshot !== opened, t);
  const unitLocked =
    !!item &&
    (item.hasMovements ||
      item.usedBy.products.length > 0 ||
      item.usedBy.options.length > 0);
  // A malformed value (e.g. "1,5") stays as typed so the schema flags the field.
  const decimal = (text: string) => decimalInput(text) ?? text.trim();

  async function save() {
    const body = {
      operationId,
      id: itemId,
      expectedVersion: item?.settingsVersion ?? 0,
      name,
      unit,
      kind,
      threshold: decimal(threshold) || "0",
      parLevel: decimal(parLevel) || null,
      openingQuantity: item ? null : decimal(opening) || null,
    };
    const parsed = stockItemInput.safeParse(body);
    const invalid = new Set<string>();
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        invalid.add(String(issue.path[0]));
    setErrors(invalid);
    if (invalid.size) return;
    setBusy(true);
    setError("");
    try {
      onSaved(await api<StockItem>("/stock-items/save", body));
    } catch (e) {
      const code = (e as Error).message;
      setStale(code === "menu_changed" || code === "operation_conflict");
      setError(
        translateError(
          code === "operation_conflict" ? "menu_changed" : code,
          locale,
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  const bad = (key: string) => (errors.has(key) ? true : undefined);
  const hint = (key: string) =>
    errors.has(key) ? (
      <p role="alert" className="error tiny">
        {key === "name"
          ? t("menuNameInvalid")
          : translateError("invalid_quantity", locale)}
      </p>
    ) : null;
  return (
    <>
      <Modal
        title={t(item ? "menuStockEdit" : "menuStockNew")}
        close={() => discard.guard(onClose)}
        closeLabel={t("close")}
      >
        <form
          className="menu-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {discard.anchor}
          <Field label={`${t("menuStockName")} *`}>
            <input
              value={name}
              maxLength={80}
              required
              aria-invalid={bad("name")}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {hint("name")}
          <Field label={t("menuStockUnit")}>
            <select
              value={unit}
              disabled={unitLocked}
              aria-describedby={unitLocked ? "stock-unit-locked" : undefined}
              onChange={(e) => setUnit(e.target.value)}
            >
              {stockUnits.map((u) => (
                <option key={u} value={u}>
                  {t(unitKeys[u])}
                </option>
              ))}
            </select>
          </Field>
          {unitLocked && (
            <p id="stock-unit-locked" className="tiny muted">
              {t("menuStockUnitLockedHint")}
            </p>
          )}
          <Field label={t("menuStockKind")}>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="raw">{t("menuStockRaw")}</option>
              <option value="prepared">{t("menuStockPrepared")}</option>
            </select>
          </Field>
          <div className="form-grid">
            <Field label={t("menuStockReorder")}>
              <input
                inputMode="decimal"
                value={threshold}
                aria-invalid={bad("threshold")}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </Field>
            <Field label={t("menuStockPar")}>
              <input
                inputMode="decimal"
                value={parLevel}
                aria-invalid={bad("parLevel")}
                onChange={(e) => setParLevel(e.target.value)}
              />
            </Field>
          </div>
          <SavesAsQuantity text={threshold} unit={unitLabel(unit, t)} t={t} />
          <SavesAsQuantity text={parLevel} unit={unitLabel(unit, t)} t={t} />
          {hint("threshold") ?? hint("parLevel")}
          {!item && (
            <>
              <Field label={t("menuStockOpening")}>
                <input
                  inputMode="decimal"
                  value={opening}
                  aria-invalid={bad("openingQuantity")}
                  onChange={(e) => setOpening(e.target.value)}
                />
              </Field>
              <SavesAsQuantity text={opening} unit={unitLabel(unit, t)} t={t} />
              {hint("openingQuantity")}
            </>
          )}
          {error && (
            <div role="alert" className="error menu-alert">
              <span>{error}</span>
              {stale && <Button onClick={onReload}>{t("menuReload")}</Button>}
            </div>
          )}
          {!online && <p className="muted">{t("menuOfflineHint")}</p>}
          <Button
            type="submit"
            variant="primary"
            className="full"
            disabled={busy || !online}
          >
            {t("menuSave")}
          </Button>
        </form>
      </Modal>
      {discard.dialog}
    </>
  );
}
