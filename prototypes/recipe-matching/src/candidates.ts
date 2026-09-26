import type { LegacyRecipe, MenuItem } from "./fixtures.ts";

// Deterministic shortlist. TypeSafe can only choose among what this returns, so coverage is measured separately.

const STOPWORDS = new Set([
  "de", "del", "la", "el", "los", "las", "con", "en", "y", "a", "al", "orden", "pz", "ml", "g", "kg",
  "w", "with", "the", "of", "and",
]);

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
  );
}

function trigrams(text: string): Set<string> {
  const padded = `  ${normalize(text)} `;
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

function coverage(needles: Set<string>, haystack: Set<string>): number {
  if (needles.size === 0) return 0;
  let hits = 0;
  for (const x of needles) if (haystack.has(x)) hits++;
  return hits / needles.size;
}

export interface Candidate {
  item: MenuItem;
  similarity: number;
}

export function shortlist(recipe: LegacyRecipe, menu: MenuItem[], k: number): Candidate[] {
  const recipeNameGrams = trigrams(recipe.dishName);
  const recipeNameTokens = tokens(recipe.dishName);
  const ingredientTokens = tokens(recipe.ingredients.map((i) => i.name).join(" "));

  return menu
    .map((item) => {
      const itemTokens = tokens(`${item.name} ${item.description}`);
      const similarity =
        0.5 * dice(recipeNameGrams, trigrams(item.name)) +
        0.3 * coverage(recipeNameTokens, itemTokens) +
        0.2 * coverage(ingredientTokens, itemTokens);
      return { item, similarity };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}
