import { useState, type ReactNode } from "react";
import {
  currencyExponent,
  type Locale,
  type Product,
  type Session,
} from "../../../shared/domain";
import {
  MENU_LIMITS,
  type MenuCategory,
  type MenuEditorPayload,
  type MenuGroup,
  type RecipeLine,
} from "../../../shared/menu";
import { productInput } from "../../../shared/menu-schema";
import { api } from "../../api";
import { strings, translateError } from "../../i18n";
import { Button, Field, Modal } from "../../components/ui";
import { CategoryDialog } from "./CategoryDialog";
import { ConfirmDialog, useDiscardGuard } from "./ConfirmDialog";
import { GroupEditor } from "./GroupEditor";
import { RecipeEditor } from "./RecipeEditor";
import {
  amountText,
  groupRuleText,
  moneyFormatter,
  moneyInput,
  translator,
} from "./format";
import { SavesAsAmount } from "./SavesAs";
import { fiscalDraft } from "../fiscal/ProductFiscalFields";

const NEW = "__new";

/**
 * Starting values for a new product: the category of the section it was
 * added from, or the category, groups, station and type of the product just
 * saved with "Guardar y agregar otro" (OWNER-13).
 */
export type ProductPreset = {
  categoryId?: string;
  groupIds?: string[];
  station?: "kitchen" | "bar";
  kind?: "item" | "combo";
};

/**
 * Wide product editor. One operationId per open dialog, reused for retries, so
 * a save whose response was lost replays instead of saving twice.
 */
export function ProductEditor({
  payload,
  product,
  duplicateOf,
  preset,
  locale,
  session,
  online,
  onSaved,
  onSaveAndNew,
  onDuplicate,
  onClose,
  onReload,
  onAvailability,
  renderFiscal,
}: {
  payload: MenuEditorPayload;
  product?: Product;
  duplicateOf?: Product;
  preset?: ProductPreset;
  locale: Locale;
  session: Session;
  online: boolean;
  onSaved: (product: Product) => void;
  /** New products only: saved; open another one with the same setup. */
  onSaveAndNew?: (product: Product) => void;
  onDuplicate: (product: Product) => void;
  onClose: () => void;
  onReload: () => void;
  /** The live switch in the header was saved; the list must follow. */
  onAvailability?: (productId: string, available: boolean) => void;
  /**
   * Extension slot for fiscal (027): renders the "Impuestos" section. Without
   * it no section is shown and no `fiscal` is sent, so saves preserve whatever
   * the stored document holds; with it the edited value is sent.
   */
  renderFiscal?: (p: {
    value: unknown;
    onChange: (v: unknown) => void;
    disabled: boolean;
  }) => ReactNode;
}) {
  const t = translator(locale);
  const currency = session.restaurant.currency;
  const exponent = currencyExponent(currency);
  const format = moneyFormatter(locale, currency);
  const pro = payload.plan === "pro";
  const source = product ?? duplicateOf;
  const [operationId] = useState(() => crypto.randomUUID());
  const [productId] = useState(() => product?.id ?? crypto.randomUUID());
  const [categories, setCategories] = useState<MenuCategory[]>(
    payload.categories,
  );
  const [groups, setGroups] = useState<MenuGroup[]>(payload.groups);
  const activeCategories = categories.filter((c) => !c.archived);
  const [es, setEs] = useState(
    duplicateOf
      ? `${duplicateOf.name.es} ${strings.es.menuCopySuffix}`.slice(0, 80)
      : (product?.name.es ?? ""),
  );
  const [en, setEn] = useState(() => {
    if (!source || source.name.en === source.name.es) return "";
    return duplicateOf
      ? `${duplicateOf.name.en} ${strings.en.menuCopySuffix}`.slice(0, 80)
      : source.name.en;
  });
  const [categoryId, setCategoryId] = useState(
    () =>
      activeCategories.find(
        (c) => c.id === (source ? source.categoryId : preset?.categoryId),
      )?.id ?? (product ? "" : (activeCategories[0]?.id ?? "")),
  );
  const [kind, setKind] = useState<"item" | "combo">(
    source?.kind ?? preset?.kind ?? "item",
  );
  const [openAmount, setOpenAmount] = useState(!!source?.openAmount);
  const [price, setPrice] = useState(
    source && !source.openAmount ? amountText(source.price, currency) : "",
  );
  const [openMax, setOpenMax] = useState(amountText(source?.openMax, currency));
  const [station, setStation] = useState<"kitchen" | "bar">(
    source?.station ?? preset?.station ?? "kitchen",
  );
  const [available, setAvailable] = useState(product?.available ?? true);
  const [groupIds, setGroupIds] = useState<string[]>(
    (
      source?.groupIds ??
      source?.groups.map((g) => g.id) ??
      preset?.groupIds ??
      []
    ).filter((id) => groups.some((g) => g.id === id && !g.archived)),
  );
  const keepPro = pro || !duplicateOf;
  const [recipe, setRecipe] = useState<RecipeLine[]>(
    keepPro ? (source?.recipe ?? []) : [],
  );
  const [recipeValid, setRecipeValid] = useState(true);
  const [cost, setCost] = useState(
    keepPro ? amountText(source?.cost ?? null, currency) : "",
  );
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  // fiscal (027): the product's tax category and SAT keys (renderFiscal slot).
  const [fiscal, setFiscal] = useState<unknown>(source?.fiscal);
  const [dialog, setDialog] = useState<"category" | "group" | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  // Unsaved edits: the form differs from how it opened. Live availability of
  // an existing product is saved at once, so it never counts.
  const snapshot = JSON.stringify([
    es,
    en,
    categoryId,
    kind,
    openAmount,
    price,
    openMax,
    station,
    product ? null : available,
    groupIds,
    recipe,
    recipeValid,
    cost,
    renderFiscal ? fiscalDraft(fiscal) : null,
  ]);
  const [opened] = useState(snapshot);
  const dirty = snapshot !== opened;
  const discard = useDiscardGuard(dirty, t);

  const linked = groupIds
    .map((id) => groups.find((g) => g.id === id))
    .filter((g): g is MenuGroup => !!g);
  const choices = linked.reduce((a, g) => a + g.max, 0);
  const addable = groups.filter((g) => !g.archived && !groupIds.includes(g.id));
  const moveGroup = (index: number, delta: number) => {
    const next = [...groupIds];
    const [id] = next.splice(index, 1);
    next.splice(index + delta, 0, id);
    setGroupIds(next);
  };

  function body() {
    const invalid = new Set<string>();
    const money = (text: string, key: string) => {
      try {
        return moneyInput(text, exponent);
      } catch {
        invalid.add(key);
        return 0;
      }
    };
    const value = {
      operationId,
      id: productId,
      expectedVersion: product?.version ?? 0,
      name: { es, en },
      categoryId,
      kind,
      price: openAmount ? 0 : money(price, "price"),
      openAmount,
      openMax: openAmount ? money(openMax, "openMax") : null,
      station,
      available: product ? product.available : available,
      groupIds,
      recipe,
      cost: cost.trim() ? money(cost, "cost") : null,
      // fiscal (027): a bad SAT key fails productInput under `fiscal`.
      ...(renderFiscal ? { fiscal: fiscalDraft(fiscal) } : {}),
    };
    if (!recipeValid) invalid.add("recipe");
    if (choices > MENU_LIMITS.choicesPerLine) invalid.add("groupIds");
    if (kind === "combo" && !linked.some((g) => g.min >= 1))
      invalid.add("combo");
    const parsed = productInput.safeParse(value);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        invalid.add(String(issue.path[0] ?? "form"));
    setErrors(invalid);
    return invalid.size ? null : value;
  }

  async function save(): Promise<Product | null> {
    const value = body();
    if (!value) return null;
    setBusy(true);
    setError("");
    try {
      return await api<Product>("/menu/products/save", value);
    } catch (e) {
      const code = (e as Error).message;
      setStale(code === "menu_changed" || code === "operation_conflict");
      setError(
        translateError(
          code === "operation_conflict" ? "menu_changed" : code,
          locale,
        ),
      );
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function archive(archived: boolean) {
    if (!product) return;
    setError("");
    let current: Product | null = product;
    // Restoring into an archived category: save the newly chosen one first.
    if (!archived && categoryId !== product.categoryId) current = await save();
    if (!current) return;
    setBusy(true);
    try {
      onSaved(
        await api<Product>("/menu/products/archive", {
          operationId: crypto.randomUUID(),
          id: current.id,
          expectedVersion: current.version,
          archived,
        }),
      );
    } catch (e) {
      const code = (e as Error).message;
      setStale(code === "menu_changed");
      setError(translateError(code, locale));
    } finally {
      setBusy(false);
    }
  }

  /** Live "86": the switch moves at once and goes back if the save fails. */
  async function toggleAvailable(next: boolean) {
    if (!product) return;
    setError("");
    setAvailable(next);
    try {
      await api("/menu/products/availability", {
        operationId: crypto.randomUUID(),
        id: product.id,
        available: next,
      });
      onAvailability?.(product.id, next);
    } catch (e) {
      setAvailable(!next);
      setError(translateError((e as Error).message, locale));
    }
  }

  const bad = (key: string) => (errors.has(key) ? true : undefined);
  const fieldError = (key: string, code?: string) =>
    errors.has(key) ? (
      <p role="alert" className="error tiny">
        {code ? translateError(code, locale) : t("menuAmountInvalid")}
      </p>
    ) : null;
  const title = t(product ? "menuEditProduct" : "menuNewProduct");
  return (
    <>
      <Modal
        wide
        title={title}
        close={() => discard.guard(onClose)}
        closeLabel={t("close")}
        footer={
          <div className="menu-editor-footer">
            {error && (
              <div role="alert" className="error menu-alert">
                <span>{error}</span>
                {stale && <Button onClick={onReload}>{t("menuReload")}</Button>}
              </div>
            )}
            {!online && <p className="tiny muted">{t("menuOfflineHint")}</p>}
            <div className="row wrap menu-footer-actions">
              <Button
                variant="primary"
                disabled={busy || !online}
                onClick={async () => {
                  const saved = await save();
                  if (saved) onSaved(saved);
                }}
              >
                {t("menuSave")}
              </Button>
              {!product && onSaveAndNew && (
                <Button
                  disabled={busy || !online}
                  onClick={async () => {
                    const saved = await save();
                    if (saved) onSaveAndNew(saved);
                  }}
                >
                  {t("menuSaveAndNew")}
                </Button>
              )}
              {product && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    discard.guard(
                      () => onDuplicate(product),
                      t("menuDiscardBeforeDuplicate"),
                      t("menuDiscardAndDuplicate"),
                    )
                  }
                >
                  {t("menuDuplicate")}
                </Button>
              )}
              {product && (
                <Button
                  variant={product.archived ? "secondary" : "ghost"}
                  className="menu-footer-archive"
                  disabled={busy || !online}
                  onClick={() =>
                    product.archived
                      ? void archive(false)
                      : setConfirmArchive(true)
                  }
                >
                  {t(product.archived ? "menuRestore" : "menuArchive")}
                </Button>
              )}
            </div>
          </div>
        }
      >
        <form
          className="menu-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const saved = await save();
            if (saved) onSaved(saved);
          }}
        >
          {discard.anchor}
          {product && !product.archived && (
            <label className="menu-switch menu-header-switch">
              <input
                type="checkbox"
                role="switch"
                checked={available}
                disabled={!online}
                aria-label={t("menuAvailableSwitch", {
                  name: product.name[locale],
                })}
                onChange={(e) => void toggleAvailable(e.target.checked)}
              />
              <span aria-hidden="true">{t("menuAvailable")}</span>
            </label>
          )}
          {product?.archived && (
            <p className="warning-panel">{t("menuArchivedBadge")}</p>
          )}
          <div className="form-grid">
            <Field label={`${t("menuNameEs")} *`}>
              <input
                value={es}
                maxLength={80}
                required
                aria-invalid={bad("name")}
                onChange={(e) => setEs(e.target.value)}
              />
            </Field>
            {errors.has("name") && (
              <p role="alert" className="error tiny menu-grid-full">
                {t("menuNameInvalid")}
              </p>
            )}
            <Field label={t("menuNameEn")}>
              <input
                value={en}
                maxLength={80}
                onChange={(e) => setEn(e.target.value)}
              />
            </Field>
            <Field label={`${t("menuCategory")} *`}>
              <select
                value={categoryId}
                required
                aria-invalid={bad("categoryId")}
                onChange={(e) => {
                  if (e.target.value === NEW) setDialog("category");
                  else setCategoryId(e.target.value);
                }}
              >
                <option value="">{t("menuChoose")}</option>
                {activeCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name[locale]}
                  </option>
                ))}
                <option value={NEW}>{t("menuNewCategoryOption")}</option>
              </select>
            </Field>
            <Field label={t("menuStation")}>
              <select
                value={station}
                onChange={(e) =>
                  setStation(e.target.value as "kitchen" | "bar")
                }
              >
                <option value="kitchen">{t("kitchen")}</option>
                <option value="bar">{t("bar")}</option>
              </select>
            </Field>
          </div>
          {errors.has("categoryId") && (
            <p role="alert" className="error tiny">
              {translateError("invalid_category", locale)}
            </p>
          )}
          <fieldset className="menu-radios">
            <legend>{t("menuKind")}</legend>
            <label className="option">
              <input
                type="radio"
                name="menu-kind"
                checked={kind === "item"}
                onChange={() => setKind("item")}
              />
              <span>{t("menuKindItem")}</span>
            </label>
            <label className="option">
              <input
                type="radio"
                name="menu-kind"
                checked={kind === "combo"}
                onChange={() => setKind("combo")}
              />
              <span>{t("menuKindCombo")}</span>
            </label>
            {kind === "combo" && (
              <p className="tiny muted">{t("menuComboHint")}</p>
            )}
          </fieldset>
          {errors.has("combo") && (
            <p role="alert" className="error tiny">
              {translateError("combo_requires_choice", locale)}
            </p>
          )}
          {!openAmount && (
            <Field label={`${t("menuPrice")} *`}>
              <input
                inputMode="decimal"
                value={price}
                required
                aria-invalid={bad("price")}
                aria-describedby="menu-price-hint"
                onChange={(e) => setPrice(e.target.value)}
              />
            </Field>
          )}
          {!openAmount && (
            <p id="menu-price-hint" className="tiny muted menu-hint">
              {t("menuPriceHint")}
            </p>
          )}
          {!openAmount && (
            <SavesAsAmount
              text={price}
              exponent={exponent}
              format={format}
              t={t}
            />
          )}
          {fieldError("price")}
          <label className="option">
            <input
              type="checkbox"
              checked={openAmount}
              onChange={(e) => setOpenAmount(e.target.checked)}
            />
            <span>
              {t("menuOpenPrice")}
              <small>{t("menuOpenPriceHint")}</small>
            </span>
          </label>
          {openAmount && (
            <Field label={`${t("menuOpenMax")} *`}>
              <input
                inputMode="decimal"
                value={openMax}
                required
                aria-invalid={bad("openMax")}
                onChange={(e) => setOpenMax(e.target.value)}
              />
            </Field>
          )}
          {openAmount && (
            <SavesAsAmount
              text={openMax}
              exponent={exponent}
              format={format}
              t={t}
            />
          )}
          {fieldError("openMax")}
          {!product && (
            <label className="option">
              <input
                type="checkbox"
                checked={available}
                onChange={(e) => setAvailable(e.target.checked)}
              />
              <span>{t("menuAvailable")}</span>
            </label>
          )}
          <fieldset className="menu-section">
            <legend>{t("menuGroupsLinked")}</legend>
            {!linked.length && (
              <p className="muted tiny">{t("menuNoGroups")}</p>
            )}
            {linked.map((g, index) => (
              <div className="menu-linked-group" key={g.id}>
                <span>
                  <strong>{g.name[locale]}</strong>
                  <small>{groupRuleText(g, t)}</small>
                </span>
                <div className="row wrap menu-row-actions">
                  <Button
                    variant="ghost"
                    disabled={index === 0}
                    aria-label={t("menuMoveUp", { name: g.name[locale] })}
                    onClick={() => moveGroup(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={index === linked.length - 1}
                    aria-label={t("menuMoveDown", { name: g.name[locale] })}
                    onClick={() => moveGroup(index, 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={t("menuRemoveGroup", { name: g.name[locale] })}
                    onClick={() =>
                      setGroupIds(groupIds.filter((id) => id !== g.id))
                    }
                  >
                    ×
                  </Button>
                </div>
              </div>
            ))}
            <Field label={t("menuAddGroup")}>
              <select
                value=""
                disabled={groupIds.length >= MENU_LIMITS.groupsPerProduct}
                onChange={(e) => {
                  if (e.target.value === NEW) setDialog("group");
                  else if (e.target.value)
                    setGroupIds([...groupIds, e.target.value]);
                }}
              >
                <option value="">{t("menuChoose")}</option>
                {addable.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name[locale]} · {groupRuleText(g, t)}
                  </option>
                ))}
                <option value={NEW}>{t("menuNewGroupOption")}</option>
              </select>
            </Field>
            <p
              className={`tiny ${errors.has("groupIds") ? "error" : "muted"}`}
              role={errors.has("groupIds") ? "alert" : undefined}
            >
              {t("menuGroupsLimitHint")}
            </p>
          </fieldset>
          <fieldset className="menu-section">
            <legend>{t("menuRecipe")}</legend>
            {pro ? (
              <>
                <p className="tiny muted">{t("menuRecipeHint")}</p>
                <RecipeEditor
                  value={recipe}
                  stockItems={payload.stockItems}
                  locale={locale}
                  onChange={(lines, valid) => {
                    setRecipe(lines);
                    setRecipeValid(valid);
                  }}
                />
                {fieldError("recipe", "invalid_recipe")}
                <Field label={t("menuCost")}>
                  <input
                    inputMode="decimal"
                    value={cost}
                    aria-invalid={bad("cost")}
                    onChange={(e) => setCost(e.target.value)}
                  />
                </Field>
                <SavesAsAmount
                  text={cost}
                  exponent={exponent}
                  format={format}
                  t={t}
                />
                {fieldError("cost")}
              </>
            ) : (
              <p className="menu-locked">{t("menuProRequired")}</p>
            )}
          </fieldset>
          {renderFiscal && (
            <fieldset className="menu-section">
              <legend>{t("menuFiscal")}</legend>
              {renderFiscal({
                value: fiscal,
                onChange: setFiscal,
                disabled: !online || busy,
              })}
            </fieldset>
          )}
        </form>
      </Modal>
      {discard.dialog}
      {confirmArchive && product && (
        <ConfirmDialog
          title={t("menuArchiveTitle", { name: product.name[locale] })}
          message={
            t("menuProductArchiveConfirm") +
            (dirty ? ` ${t("menuArchiveDropsEdits")}` : "")
          }
          confirmLabel={t("menuArchive")}
          cancelLabel={t("menuCancel")}
          danger
          t={t}
          onCancel={() => setConfirmArchive(false)}
          onConfirm={() => {
            setConfirmArchive(false);
            void archive(true);
          }}
        />
      )}
      {dialog === "category" && (
        <CategoryDialog
          locale={locale}
          online={online}
          onClose={() => setDialog(null)}
          onSaved={(c) => {
            setCategories([...categories, c]);
            setCategoryId(c.id);
            setDialog(null);
          }}
        />
      )}
      {dialog === "group" && (
        <GroupEditor
          payload={payload}
          locale={locale}
          currency={currency}
          online={online}
          onClose={() => setDialog(null)}
          onReload={onReload}
          onSaved={({ group }) => {
            setGroups([...groups, group]);
            setGroupIds([...groupIds, group.id]);
            setDialog(null);
          }}
        />
      )}
    </>
  );
}
