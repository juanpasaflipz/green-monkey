import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import {
  currencyExponent,
  minor,
  quote,
  type Group,
  type Locale,
  type Product,
} from "../../shared/domain";
import {
  expandSelection,
  selectionCounts,
  selectionIssue,
} from "../../shared/menu";
import { translateError } from "../i18n";
import {
  amountText,
  groupRuleText,
  moneyFormatter,
  translator,
} from "../features/menu/format";
import { Button, Field, Modal } from "./ui";
import "./modifier-picker.css";

export type PickerSelection = { options: string[]; openAmount?: number };

// quote() validates line ids as uuids; the preview line never leaves the picker.
const PREVIEW_LINE = "00000000-0000-4000-8000-000000000000";

/**
 * Choice picker for POS and QR/kiosk. Opens for any product with groups or an
 * open price, so optional groups are always offered (FIT-4). The price shown
 * is computed by the same quote() the server uses.
 */
export function ModifierPicker(props: {
  product: Product;
  locale: Locale;
  currency: string;
  canOpen: boolean;
  initial?: PickerSelection;
  onConfirm: (selection: PickerSelection) => void;
  onClose: () => void;
}) {
  const { product, locale, currency, canOpen } = props;
  const t = translator(locale);
  const money = moneyFormatter(locale, currency);
  const [counts, setCounts] = useState<Map<string, number>>(() =>
    selectionCounts(props.initial?.options ?? []),
  );
  const [amount, setAmount] = useState(() =>
    amountText(props.initial?.openAmount, currency),
  );

  let openAmount: number | undefined;
  let amountInvalid = false;
  if (product.openAmount && amount.trim()) {
    try {
      openAmount = minor(amount.trim(), currencyExponent(currency));
    } catch {
      amountInvalid = true;
    }
  }
  const options = expandSelection(product, counts);
  const issue = amountInvalid
    ? "invalid_amount"
    : selectionIssue(product, options, openAmount, canOpen);
  const chosenTotal = (g: Group) =>
    g.options.reduce((a, o) => a + (counts.get(o.id) ?? 0), 0);
  let price: number;
  try {
    price = quote(
      [
        {
          id: PREVIEW_LINE,
          productId: product.id,
          quantity: 1,
          options,
          note: "",
          ...(openAmount !== undefined ? { openAmount } : {}),
        },
      ],
      [product],
      canOpen,
    )[0].unitPrice;
  } catch {
    price =
      (openAmount ?? product.price) +
      product.groups
        .flatMap((g) => g.options)
        .reduce((a, o) => a + o.price * (counts.get(o.id) ?? 0), 0);
  }
  const missing = product.groups
    .filter((g) => chosenTotal(g) < g.min)
    .map((g) => g.name[locale]);
  const message =
    issue === "required_modifier"
      ? missing.length
        ? t("menuPickerMissing", { groups: missing.join(", ") })
        : translateError("required_modifier", locale)
      : issue === "open_amount_exceeds"
        ? t("menuPickerExceeds")
        : issue === "invalid_amount"
          ? amount.trim()
            ? t("menuPickerAmountInvalid")
            : ""
          : issue
            ? translateError(issue, locale)
            : "";

  function set(g: Group, optionId: string, next: number, exclusive = false) {
    setCounts((old) => {
      const copy = new Map(old);
      if (exclusive) for (const o of g.options) copy.delete(o.id);
      if (next > 0) copy.set(optionId, next);
      else copy.delete(optionId);
      return copy;
    });
  }

  return (
    <Modal
      title={product.name[locale]}
      close={props.onClose}
      closeLabel={t("close")}
      footer={
        <div className="picker-footer">
          {message && (
            <p role="alert" className="picker-issue">
              {message}
            </p>
          )}
          <Button
            variant="primary"
            className="full"
            disabled={issue !== null}
            onClick={() =>
              props.onConfirm({
                options,
                ...(openAmount !== undefined ? { openAmount } : {}),
              })
            }
          >
            {t("menuPickerAdd")}
          </Button>
        </div>
      }
    >
      <p className="large-money picker-price" aria-live="polite">
        {money(price)}
      </p>
      {product.openAmount && (
        <div className="picker-amount">
          <Field label={t("menuPickerAmount")}>
            <input
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              aria-invalid={
                amountInvalid || issue === "open_amount_exceeds"
                  ? true
                  : undefined
              }
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          {product.openMax != null && (
            <p className="muted tiny">
              {t("menuPickerMax", { amount: money(product.openMax) })}
            </p>
          )}
        </div>
      )}
      {product.groups.map((g) => {
        const total = chosenTotal(g);
        const full = total >= g.max;
        const radio = !g.repeat && g.min === 1 && g.max === 1;
        const exclusive = !g.repeat && g.max === 1 && g.min === 0;
        return (
          <fieldset key={g.id} className="picker-group">
            <legend>
              {g.name[locale]} · {groupRuleText(g, t)}
            </legend>
            <output className="picker-progress tiny muted" aria-live="polite">
              {t("menuPickerProgress", { count: total, max: g.max })}
            </output>
            {g.options.map((o) => {
              const count = counts.get(o.id) ?? 0;
              const tag = !o.available
                ? t("menuSoldOut")
                : o.price
                  ? "+" + money(o.price)
                  : t("menuPickerIncluded");
              if (g.repeat)
                return (
                  <div
                    className={`option picker-stepper${count ? " chosen" : ""}`}
                    key={o.id}
                  >
                    <span className="picker-option-name">
                      {o.name[locale]}
                      <small>{tag}</small>
                    </span>
                    <Button
                      variant="ghost"
                      className="picker-step"
                      aria-label={t("menuPickerDecrease", {
                        name: o.name[locale],
                      })}
                      disabled={count === 0}
                      onClick={() => set(g, o.id, count - 1)}
                    >
                      <Minus size={18} />
                    </Button>
                    <output className="picker-count">{count}</output>
                    <Button
                      variant="ghost"
                      className="picker-step"
                      aria-label={t("menuPickerIncrease", {
                        name: o.name[locale],
                      })}
                      disabled={full || !o.available}
                      onClick={() => set(g, o.id, count + 1)}
                    >
                      <Plus size={18} />
                    </Button>
                  </div>
                );
              const checked = count > 0;
              return (
                <label
                  className={`option${o.available ? "" : " unavailable"}`}
                  key={o.id}
                >
                  <input
                    type={radio ? "radio" : "checkbox"}
                    name={g.id}
                    checked={checked}
                    disabled={
                      !checked &&
                      (!o.available || (!radio && !exclusive && full))
                    }
                    onChange={(e) =>
                      set(g, o.id, e.target.checked ? 1 : 0, radio || exclusive)
                    }
                  />
                  <span>{o.name[locale]}</span>
                  <strong>{tag}</strong>
                </label>
              );
            })}
          </fieldset>
        );
      })}
    </Modal>
  );
}
