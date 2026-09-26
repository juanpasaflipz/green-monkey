import type { Ingredient } from "./fixtures.ts";

// Deterministic shortlist. TypeSafe can only choose among what this returns, so coverage is measured separately.

const STOPWORDS = new Set(["de", "del", "la", "el", "con", "en", "sin", "y", "a", "al", "kg", "g", "ml", "cm", "pza", "cja", "pq"]);

// Common supplier abbreviations. Known rules belong in code, not in the model.
const ABBREVIATIONS: Record<string, string> = {
  qso: "queso",
  oax: "oaxaca",
  fco: "fresco",
  pech: "pechuga",
  tort: "tortilla",
  hna: "harina",
  evap: "evaporada",
  sem: "semilla",
  desc: "descuento",
};

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function expandAbbreviations(text: string): string {
  return normalize(text)
    .split(" ")
    .map((t) => ABBREVIATIONS[t] ?? t)
    .join(" ");
}

function tokens(text: string): Set<string> {
  return new Set(text.split(" ").filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/\d/.test(t)));
}

function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return (2 * shared) / (a.size + b.size);
}

export interface Candidate {
  ingredient: Ingredient;
  similarity: number;
}

export function shortlist(lineText: string, catalog: Ingredient[], k: number): Candidate[] {
  const expanded = expandAbbreviations(lineText);
  const lineTokens = tokens(expanded);
  const lineGrams = trigrams([...lineTokens].join(" "));

  return catalog
    .map((ingredient) => {
      const name = normalize(ingredient.name);
      const nameTokens = tokens(name);
      const similarity = 0.6 * dice(lineGrams, trigrams([...nameTokens].join(" "))) + 0.4 * dice(lineTokens, nameTokens);
      return { ingredient, similarity };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}
