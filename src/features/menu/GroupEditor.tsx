import { useState } from "react";
import { currencyExponent, type Locale } from "../../../shared/domain";
import type { MenuEditorPayload, MenuGroup } from "../../../shared/menu";
import { groupInput } from "../../../shared/menu-schema";
import { api } from "../../api";
import { translateError } from "../../i18n";
import { Button, Field, Modal } from "../../components/ui";
import {
  amountText,
  groupRuleText,
  moneyFormatter,
  moneyInput,
  translator,
} from "./format";
import { SavesAsAmount } from "./SavesAs";
import {
  draftOption,
  groupTemplates,
  type GroupDraft,
  type GroupDraftOption,
} from "./groupTemplates";
import { RecipeEditor } from "./RecipeEditor";

type Saved = { group: MenuGroup; recompiled: number };

function fromGroup(g: MenuGroup, currency: string): GroupDraft {
  return {
    es: g.name.es,
    en: g.name.en === g.name.es ? "" : g.name.en,
    min: g.min,
    max: g.max,
    repeat: !!g.repeat,
    options: g.options.map((o): GroupDraftOption => ({
      id: o.id,
      es: o.name.es,
      en: o.name.en === o.name.es ? "" : o.name.en,
      price: amountText(o.price, currency),
      cost: amountText(o.cost ?? null, currency),
      recipe: o.recipe ?? [],
      available: o.available,
      saved: true,
    })),
  };
}

/** Wide modal for a reusable modifier group (templates, rules, choices). */
export function GroupEditor({
  payload,
  group,
  locale,
  currency,
  online,
  onSaved,
  onClose,
  onReload,
}: {
  payload: MenuEditorPayload;
  group?: MenuGroup;
  locale: Locale;
  currency: string;
  online: boolean;
  onSaved: (result: Saved) => void;
  onClose: () => void;
  onReload: () => void;
}) {
  const t = translator(locale);
  const exponent = currencyExponent(currency);
  const format = moneyFormatter(locale, currency);
  const pro = payload.plan === "pro";
  const [operationId] = useState(() => crypto.randomUUID());
  const [groupId] = useState(() => group?.id ?? crypto.randomUUID());
  const [draft, setDraft] = useState<GroupDraft>(() =>
    group
      ? fromGroup(group, currency)
      : {
          es: "",
          en: "",
          min: 1,
          max: 1,
          repeat: false,
          options: [draftOption()],
        },
  );
  const [minText, setMinText] = useState(String(draft.min));
  const [maxText, setMaxText] = useState(String(draft.max));
  const [recipeValid, setRecipeValid] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [templateKey, setTemplateKey] = useState("");

  const setOption = (id: string, patch: Partial<GroupDraftOption>) =>
    setDraft((d) => ({
      ...d,
      options: d.options.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    }));
  const move = (index: number, delta: number) =>
    setDraft((d) => {
      const options = [...d.options];
      const [o] = options.splice(index, 1);
      options.splice(index + delta, 0, o);
      return { ...d, options };
    });
  const min = Number.parseInt(minText, 10);
  const max = Number.parseInt(maxText, 10);
  const rule =
    Number.isInteger(min) && Number.isInteger(max) && min <= max && max >= 1
      ? groupRuleText({ min, max, repeat: draft.repeat }, t)
      : "";

  async function save() {
    const invalid = new Set<string>();
    const money = (text: string, key: string, optional = false) => {
      if (optional && !text.trim()) return null;
      try {
        return moneyInput(text.trim() || "0", exponent);
      } catch {
        invalid.add(key);
        return 0;
      }
    };
    const body = {
      operationId,
      id: groupId,
      expectedVersion: group?.version ?? 0,
      name: { es: draft.es, en: draft.en },
      min,
      max,
      repeat: draft.repeat,
      options: draft.options.map((o) => ({
        id: o.id,
        name: { es: o.es, en: o.en },
        price: money(o.price, `price:${o.id}`) ?? 0,
        cost: money(o.cost, `cost:${o.id}`, true),
        recipe: o.recipe,
      })),
    };
    for (const o of draft.options)
      if (recipeValid[o.id] === false) invalid.add(`recipe:${o.id}`);
    const parsed = groupInput.safeParse(body);
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        const [head, index, field] = issue.path as (string | number)[];
        if (head === "options" && typeof index === "number")
          invalid.add(
            `${field === "price" ? "price" : field === "cost" ? "cost" : field === "recipe" ? "recipe" : "name"}:${draft.options[index]?.id}`,
          );
        else invalid.add(String(head === "name" ? "name" : head));
      }
    setErrors(invalid);
    if (invalid.size) return;
    setBusy(true);
    setError("");
    try {
      onSaved(await api<Saved>("/menu/groups/save", body));
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

  async function toggleOption(o: GroupDraftOption, available: boolean) {
    setError("");
    try {
      await api("/menu/groups/option-availability", {
        operationId: crypto.randomUUID(),
        groupId,
        optionId: o.id,
        available,
      });
      setOption(o.id, { available });
    } catch (e) {
      setError(translateError((e as Error).message, locale));
    }
  }

  const bad = (key: string) => (errors.has(key) ? true : undefined);
  return (
    <Modal
      wide
      title={t(group ? "menuEditGroup" : "menuNewGroup")}
      close={onClose}
      closeLabel={t("close")}
      footer={
        <div className="menu-editor-footer">
          {error && (
            <div role="alert" className="error menu-alert">
              <span>{error}</span>
              {stale && <Button onClick={onReload}>{t("menuReload")}</Button>}
            </div>
          )}
          {group && group.usedBy.length > 0 && (
            <p className="tiny muted">
              {t("menuGroupRecompile", { n: group.usedBy.length })}
            </p>
          )}
          {!online && <p className="tiny muted">{t("menuOfflineHint")}</p>}
          <Button
            variant="primary"
            disabled={busy || !online}
            onClick={() => void save()}
          >
            {t("menuSave")}
          </Button>
        </div>
      }
    >
      <form
        className="menu-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {!group && (
          <Field label={t("menuTemplates")}>
            <select
              value={templateKey}
              onChange={(e) => {
                setTemplateKey(e.target.value);
                const template = groupTemplates.find(
                  (x) => x.key === e.target.value,
                );
                if (!template) return;
                const next = template.build();
                setDraft(next);
                setMinText(String(next.min));
                setMaxText(String(next.max));
                setErrors(new Set());
              }}
            >
              <option value="">{t("menuTemplateNone")}</option>
              {groupTemplates.map((x) => (
                <option key={x.key} value={x.key}>
                  {t(x.label)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="form-grid">
          <Field label={t("menuGroupName")}>
            <input
              value={draft.es}
              maxLength={80}
              required
              aria-invalid={bad("name")}
              onChange={(e) => setDraft({ ...draft, es: e.target.value })}
            />
          </Field>
          <Field label={t("menuGroupNameEn")}>
            <input
              value={draft.en}
              maxLength={80}
              onChange={(e) => setDraft({ ...draft, en: e.target.value })}
            />
          </Field>
          <Field label={t("menuGroupMin")}>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={30}
              value={minText}
              aria-invalid={bad("min")}
              onChange={(e) => setMinText(e.target.value)}
            />
          </Field>
          <Field label={t("menuGroupMax")}>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              value={maxText}
              aria-invalid={bad("max")}
              onChange={(e) => setMaxText(e.target.value)}
            />
          </Field>
        </div>
        <label className="option">
          <input
            type="checkbox"
            checked={draft.repeat}
            onChange={(e) => setDraft({ ...draft, repeat: e.target.checked })}
          />
          <span>{t("menuGroupRepeat")}</span>
        </label>
        <p className="muted" aria-live="polite">
          {rule ? t("menuRule", { rule }) : ""}
        </p>
        {(errors.has("min") || errors.has("max")) && (
          <p role="alert" className="error">
            {translateError("invalid_group", locale)}
          </p>
        )}
        <fieldset className="menu-options">
          <legend>{t("menuOptions")}</legend>
          {draft.options.map((o, index) => {
            const n = index + 1;
            const optionInvalid = ["name", "price", "cost", "recipe"].some(
              (k) => errors.has(`${k}:${o.id}`),
            );
            return (
              <div className="menu-option-row" key={o.id}>
                <div className="form-grid">
                  <Field label={t("menuOptionName", { n })}>
                    <input
                      value={o.es}
                      maxLength={80}
                      required
                      aria-invalid={bad(`name:${o.id}`)}
                      onChange={(e) => setOption(o.id, { es: e.target.value })}
                    />
                  </Field>
                  <Field label={t("menuOptionNameEn", { n })}>
                    <input
                      value={o.en}
                      maxLength={80}
                      onChange={(e) => setOption(o.id, { en: e.target.value })}
                    />
                  </Field>
                  <Field label={t("menuOptionPrice", { n })}>
                    <input
                      inputMode="decimal"
                      value={o.price}
                      aria-invalid={bad(`price:${o.id}`)}
                      onChange={(e) =>
                        setOption(o.id, { price: e.target.value })
                      }
                    />
                  </Field>
                  {pro && (
                    <Field label={t("menuOptionCost", { n })}>
                      <input
                        inputMode="decimal"
                        value={o.cost}
                        aria-invalid={bad(`cost:${o.id}`)}
                        onChange={(e) =>
                          setOption(o.id, { cost: e.target.value })
                        }
                      />
                    </Field>
                  )}
                </div>
                <SavesAsAmount
                  text={o.price}
                  exponent={exponent}
                  format={format}
                  t={t}
                  onlyGrouped
                />
                {pro && (
                  <SavesAsAmount
                    text={o.cost}
                    exponent={exponent}
                    format={format}
                    t={t}
                    onlyGrouped
                  />
                )}
                {pro ? (
                  <details className="menu-option-recipe">
                    <summary>
                      {t("menuOptionRecipe")}
                      {o.recipe.length ? ` · ${o.recipe.length}` : ""}
                    </summary>
                    <RecipeEditor
                      value={o.recipe}
                      stockItems={payload.stockItems}
                      locale={locale}
                      onChange={(recipe, valid) => {
                        setOption(o.id, { recipe });
                        setRecipeValid((v) => ({ ...v, [o.id]: valid }));
                      }}
                    />
                  </details>
                ) : (
                  <p className="tiny muted">
                    {t("menuOptionRecipe")} · {t("menuProRequired")}
                  </p>
                )}
                {optionInvalid && (
                  <p role="alert" className="error">
                    {translateError(
                      errors.has(`recipe:${o.id}`)
                        ? "invalid_recipe"
                        : "invalid_group",
                      locale,
                    )}
                  </p>
                )}
                <div className="row wrap menu-row-actions">
                  {o.saved && group && (
                    <label className="menu-switch">
                      <input
                        type="checkbox"
                        role="switch"
                        checked={o.available}
                        disabled={!online}
                        aria-label={t("menuAvailableSwitch", { name: o.es })}
                        onChange={(e) => void toggleOption(o, e.target.checked)}
                      />
                      <span aria-hidden="true">{t("menuAvailable")}</span>
                    </label>
                  )}
                  <Button
                    variant="ghost"
                    disabled={index === 0}
                    aria-label={t("menuMoveOptionUp", { n })}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={index === draft.options.length - 1}
                    aria-label={t("menuMoveOptionDown", { n })}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={draft.options.length <= 1}
                    aria-label={t("menuRemoveOption", { n })}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        options: draft.options.filter((x) => x.id !== o.id),
                      })
                    }
                  >
                    ×
                  </Button>
                </div>
              </div>
            );
          })}
          <Button
            disabled={draft.options.length >= 50}
            onClick={() =>
              setDraft({ ...draft, options: [...draft.options, draftOption()] })
            }
          >
            {t("menuAddOption")}
          </Button>
        </fieldset>
      </form>
    </Modal>
  );
}
