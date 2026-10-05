import { decimalInput, savedAmount, type Translate } from "./format";

/**
 * "Se guardará: $1,250.00" under a money field, so the person sees how a
 * typed value was read ("1,250" is one thousand two hundred fifty) before
 * saving. Hidden while the field is blank or invalid (the field error shows
 * then). `onlyGrouped` limits it to text with a thousands comma, for long
 * lists of small amounts such as choice prices.
 */
export function SavesAsAmount({
  text,
  exponent,
  format,
  t,
  onlyGrouped = false,
}: {
  text: string;
  exponent: number;
  format: (minor: number) => string;
  t: Translate;
  onlyGrouped?: boolean;
}) {
  if (onlyGrouped && !text.includes(",")) return null;
  const value = savedAmount(text, exponent, format);
  return value ? (
    <p className="tiny muted menu-saves-as">{t("menuSavesAs", { value })}</p>
  ) : null;
}

/** Same for a quantity typed with a thousands comma ("5,000" g → 5000 g). */
export function SavesAsQuantity({
  text,
  unit,
  t,
}: {
  text: string;
  unit: string;
  t: Translate;
}) {
  if (!text.includes(",")) return null;
  const value = decimalInput(text);
  return value ? (
    <p className="tiny muted menu-saves-as">
      {t("menuSavesAs", { value: `${value} ${unit}` })}
    </p>
  ) : null;
}
