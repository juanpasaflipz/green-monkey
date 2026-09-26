import { choice, type TypeSafeClient } from "@typesafe-ai/sdk";
import { expandAbbreviations, type Candidate } from "./candidates.ts";
import type { ReceiptLine, Supplier } from "./fixtures.ts";

// Starting point from the TypeSafe confidence guide; not yet evaluated on real receipts.
export const PREFILL_CONFIDENCE = 0.9;

export const NEW_INGREDIENT = "new_ingredient";
export const NOT_INVENTORY = "not_inventory";

export type Route =
  | "prefill" // Ingredient pre-selected on the receiving screen; an operator still confirms.
  | "suggest_new" // "Create ingredient" pre-selected; an operator names and confirms it.
  | "suggest_not_inventory" // "Not a stock item" pre-selected (fee, deposit, supply); may go to expenses.
  | "review"; // Nothing pre-selected.

export interface MatchResult {
  lineId: string;
  candidates: Candidate[];
  label: string;
  ingredientId: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  route: Route;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  requestId: string | undefined;
}

const INSTRUCTIONS = {
  task: "Which of the restaurant's inventory ingredients did it buy in `line`?",
  rules: [
    "`line.text` is a supplier receipt line, often uppercase and abbreviated (QSO = queso, S/H = sin hueso, C/24 = case of 24), and it may use a brand name instead of the product name.",
    "Use `supplier` to interpret ambiguous words; the same word can mean different products from different suppliers.",
    "Match only the same product. A different form (fresh vs canned, flour vs tortillas) or variety (brown vs standard sugar) is a different ingredient.",
    "Ignore pack size, quantity, and quality grade (1RA, 2DA) for this question.",
  ],
};

const NEW_INGREDIENT_DESCRIPTION =
  "A food or drink the restaurant would stock, but none of the listed ingredients is the same product";
const NOT_INVENTORY_DESCRIPTION =
  "Not a food or drink stock item: a fee, tax, discount, container deposit, or a non-food supply such as cleaning products";

export function buildRequest(line: ReceiptLine, supplier: Supplier, candidates: Candidate[]) {
  const criteria: Record<string, { name: string; stocked_in: string }> = {};
  candidates.forEach((c, i) => {
    criteria[`ingredient_${i + 1}`] = { name: c.ingredient.name, stocked_in: c.ingredient.stockUnit };
  });

  return {
    state: {
      supplier: { name: supplier.name, sells: supplier.kind },
      line: {
        text: line.text,
        text_with_abbreviations_expanded: expandAbbreviations(line.text),
        quantity: line.quantity,
        unit: line.unit,
      },
    },
    questions: {
      ingredient: choice(INSTRUCTIONS, {
        ...criteria,
        [NEW_INGREDIENT]: NEW_INGREDIENT_DESCRIPTION,
        [NOT_INVENTORY]: NOT_INVENTORY_DESCRIPTION,
      }),
    },
  };
}

export function route(label: string, confidence: number): Route {
  if (confidence < PREFILL_CONFIDENCE) return "review";
  if (label === NEW_INGREDIENT) return "suggest_new";
  if (label === NOT_INVENTORY) return "suggest_not_inventory";
  return "prefill";
}

export async function matchLine(
  client: TypeSafeClient,
  line: ReceiptLine,
  supplier: Supplier,
  candidates: Candidate[],
): Promise<MatchResult> {
  const started = performance.now();
  const { data, requestId } = await client.systemOne(buildRequest(line, supplier, candidates)).withResponse();
  const latencyMs = performance.now() - started;

  const answer = data.answers.ingredient;
  const label: string = answer.choice;
  const index = label.startsWith("ingredient_") ? Number(label.replace("ingredient_", "")) - 1 : -1;

  return {
    lineId: line.id,
    candidates,
    label,
    ingredientId: index >= 0 ? candidates[index].ingredient.id : null,
    confidence: answer.confidence,
    probabilities: { ...answer.probabilities },
    route: route(label, answer.confidence),
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
    latencyMs,
    requestId,
  };
}
