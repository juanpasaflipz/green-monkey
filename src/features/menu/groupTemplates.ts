// Client-side starting points for a new modifier group. Nothing is saved until
// the manager presses Guardar; every option gets a fresh id.
import type { Key } from "../../i18n";

export type GroupDraftOption = {
  id: string;
  es: string;
  en: string;
  price: string;
  cost: string;
  recipe: { stockId: string; quantity: string }[];
  available: boolean;
  saved: boolean;
};
export type GroupDraft = {
  es: string;
  en: string;
  min: number;
  max: number;
  repeat: boolean;
  options: GroupDraftOption[];
};

export function draftOption(es = "", en = "", price = "0"): GroupDraftOption {
  return {
    id: crypto.randomUUID(),
    es,
    en,
    price,
    cost: "",
    recipe: [],
    available: true,
    saved: false,
  };
}

type Template = {
  key: string;
  label: Key;
  build: () => GroupDraft;
};

const group = (
  es: string,
  en: string,
  min: number,
  max: number,
  options: [string, string, string?][],
): GroupDraft => ({
  es,
  en,
  min,
  max,
  repeat: false,
  options: options.map(([oes, oen, price]) => draftOption(oes, oen, price)),
});

export const groupTemplates: Template[] = [
  {
    key: "tortilla",
    label: "menuTemplateTortilla",
    build: () =>
      group("Tortilla", "Tortilla", 1, 1, [
        ["Maíz", "Corn"],
        ["Harina", "Flour"],
      ]),
  },
  {
    key: "salsa",
    label: "menuTemplateSalsa",
    build: () =>
      group("Salsa", "Salsa", 1, 1, [
        ["Verde", "Green"],
        ["Roja", "Red"],
        ["Sin salsa", "No salsa"],
      ]),
  },
  {
    key: "doneness",
    label: "menuTemplateDoneness",
    build: () =>
      group("Término", "Doneness", 1, 1, [
        ["Medio", "Medium"],
        ["Tres cuartos", "Medium-well"],
        ["Bien cocido", "Well done"],
      ]),
  },
  {
    key: "extras",
    label: "menuTemplateExtras",
    build: () =>
      group("Extras", "Extras", 0, 2, [
        ["Queso", "Cheese", "15"],
        ["Aguacate", "Avocado", "20"],
      ]),
  },
  {
    key: "prep",
    label: "menuTemplatePrep",
    build: () =>
      group("Preparación", "Preparation", 0, 3, [
        ["Con todo", "Everything"],
        ["Sin cebolla", "No onion"],
        ["Sin cilantro", "No cilantro"],
      ]),
  },
];
