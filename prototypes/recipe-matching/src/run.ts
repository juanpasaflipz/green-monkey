import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { shortlist } from "./candidates.ts";
import { MENU, RECIPES } from "./fixtures.ts";
import { matchRecipe, PREFILL_CONFIDENCE, type MatchResult } from "./match.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SHORTLIST_SIZE = 6;
const CONCURRENCY = 4;

const dryRun = process.argv.includes("--dry-run");
const menuById = new Map(MENU.map((m) => [m.id, m]));
const nameOf = (id: string | null) => (id ? (menuById.get(id)?.name ?? id) : "— none —");

const shortlists = RECIPES.map((recipe) => ({ recipe, candidates: shortlist(recipe, MENU, SHORTLIST_SIZE) }));

if (dryRun) {
  for (const { recipe, candidates } of shortlists) {
    const covered = recipe.expected === null || candidates.some((c) => c.item.id === recipe.expected);
    console.log(`\n${recipe.id} ${recipe.dishName}  (expected: ${nameOf(recipe.expected)}${covered ? "" : " — NOT SHORTLISTED"})`);
    for (const c of candidates) console.log(`   ${c.similarity.toFixed(3)}  ${c.item.name}`);
  }
  process.exit(0);
}

try {
  process.loadEnvFile(resolve(here, "../../../.env"));
} catch {
  // Fall back to the existing environment.
}
const client = new TypeSafeClient();

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

const results: MatchResult[] = await pool(shortlists, CONCURRENCY, ({ recipe, candidates }) =>
  matchRecipe(client, recipe, candidates),
);

const rows = results.map((r, i) => {
  const recipe = shortlists[i].recipe;
  const covered = recipe.expected === null || r.candidates.some((c) => c.item.id === recipe.expected);
  const correct = r.menuItemId === recipe.expected;
  return { recipe, result: r, covered, correct };
});

console.log(`\nModel: TypeSafe System One (default model), shortlist ${SHORTLIST_SIZE}, prefill ≥ ${PREFILL_CONFIDENCE}\n`);
for (const { recipe, result, covered, correct } of rows) {
  const mark = correct ? "✓" : "✗";
  console.log(
    `${mark} ${recipe.id} ${recipe.dishName.padEnd(36)} → ${nameOf(result.menuItemId).padEnd(32)} ` +
      `conf ${result.confidence.toFixed(2)}  ${result.route.padEnd(16)}` +
      (correct ? "" : ` expected: ${nameOf(recipe.expected)}`) +
      (covered ? "" : " [not shortlisted]"),
  );
}

const byRoute = (route: MatchResult["route"]) => rows.filter((r) => r.result.route === route);
const summarize = (label: string, subset: typeof rows) =>
  console.log(`  ${label.padEnd(18)} ${subset.length.toString().padStart(2)} recipes, ${subset.filter((r) => r.correct).length} correct`);

console.log("\nSummary");
summarize("all", rows);
summarize("prefill", byRoute("prefill"));
summarize("suggest_no_match", byRoute("suggest_no_match"));
summarize("review", byRoute("review"));
console.log(`  shortlist coverage ${rows.filter((r) => r.covered).length}/${rows.length}`);

const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const tokensIn = results.reduce((s, r) => s + r.inputTokens, 0);
const tokensOut = results.reduce((s, r) => s + r.outputTokens, 0);
console.log(`  tokens in/out     ${tokensIn}/${tokensOut}`);
console.log(`  latency ms        median ${latencies[Math.floor(latencies.length / 2)].toFixed(0)}, max ${latencies.at(-1)!.toFixed(0)}`);

const outDir = resolve(here, "../out");
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, "results.json");
writeFileSync(
  outFile,
  JSON.stringify(
    rows.map(({ recipe, result, covered, correct }) => ({
      recipe: { id: recipe.id, dishName: recipe.dishName, expected: recipe.expected, note: recipe.note },
      shortlist: result.candidates.map((c) => ({ id: c.item.id, name: c.item.name, similarity: c.similarity })),
      answer: { label: result.label, menuItemId: result.menuItemId, confidence: result.confidence, probabilities: result.probabilities },
      route: result.route,
      covered,
      correct,
      usage: { input: result.inputTokens, output: result.outputTokens },
      latencyMs: Math.round(result.latencyMs),
      requestId: result.requestId,
    })),
    null,
    2,
  ),
);
console.log(`\nWrote ${outFile}`);
