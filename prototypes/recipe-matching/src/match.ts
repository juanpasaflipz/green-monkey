import { choice, type TypeSafeClient } from "@typesafe-ai/sdk";
import type { Candidate } from "./candidates.ts";
import type { LegacyRecipe } from "./fixtures.ts";

// Starting point from the TypeSafe confidence guide; not yet evaluated on real restaurant data.
export const PREFILL_CONFIDENCE = 0.9;

export const NO_MATCH = "none";

export type Route =
  | "prefill" // Pre-selected on the review screen; an operator still confirms the link.
  | "suggest_no_match" // Shown as "no menu item" by default; an operator still confirms.
  | "review"; // Nothing pre-selected.

export interface MatchResult {
  recipeId: string;
  candidates: Candidate[];
  label: string; // "candidate_N" or NO_MATCH
  menuItemId: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  route: Route;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  requestId: string | undefined;
}

const INSTRUCTIONS = {
  task: "Which menu item is the sold dish that `recipe` prepares, so its ingredients are consumed when that item is sold?",
  rules: [
    "The recipe comes from a restaurant's older system and is linked only by `recipe.dish_name`, which may be abbreviated, misspelled, singular/plural, a regional synonym, or in English instead of Spanish.",
    "Use `recipe.ingredients` and their quantities to tell apart similar items, sizes, and variants.",
    "Match the item the recipe produces one sold portion of, not an item that only uses this recipe as a component.",
    "Answer none when the recipe is a prep component used inside other dishes (such as a sauce, marinade, base, or fried chips), or when it is a dish that is not among the options.",
  ],
};

const NO_MATCH_DESCRIPTION =
  "None of the listed menu items: the recipe is a prep component used inside other dishes, or it prepares a dish that is not listed";

export function buildRequest(recipe: LegacyRecipe, candidates: Candidate[]) {
  const criteria: Record<string, { name: string; category: string; description: string; price_mxn: string }> = {};
  candidates.forEach((c, i) => {
    criteria[`candidate_${i + 1}`] = {
      name: c.item.name,
      category: c.item.category,
      description: c.item.description,
      price_mxn: (c.item.priceMinor / 100).toFixed(2),
    };
  });

  return {
    state: {
      recipe: {
        dish_name: recipe.dishName,
        ingredients: recipe.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
      },
    },
    questions: {
      menu_item: choice(INSTRUCTIONS, { ...criteria, [NO_MATCH]: NO_MATCH_DESCRIPTION }),
    },
  };
}

export function route(label: string, confidence: number): Route {
  if (confidence < PREFILL_CONFIDENCE) return "review";
  return label === NO_MATCH ? "suggest_no_match" : "prefill";
}

export async function matchRecipe(
  client: TypeSafeClient,
  recipe: LegacyRecipe,
  candidates: Candidate[],
): Promise<MatchResult> {
  const started = performance.now();
  const { data, requestId } = await client.systemOne(buildRequest(recipe, candidates)).withResponse();
  const latencyMs = performance.now() - started;

  const answer = data.answers.menu_item;
  const label: string = answer.choice;
  const index = label === NO_MATCH ? -1 : Number(label.replace("candidate_", "")) - 1;

  return {
    recipeId: recipe.id,
    candidates,
    label,
    menuItemId: index >= 0 ? candidates[index].item.id : null,
    confidence: answer.confidence,
    probabilities: { ...answer.probabilities },
    route: route(label, answer.confidence),
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
    latencyMs,
    requestId,
  };
}
